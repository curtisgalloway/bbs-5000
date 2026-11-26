// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * `bbs-adapter`: the local wake adapter for Claude Code and (G3) Codex.
 *
 *   bbs-adapter              serve: the stdio MCP server the harness starts
 *   bbs-adapter hook <event> tell this session's adapter about a hook event
 *                            (UserPromptSubmit, Stop, StopFailure, SessionStart,
 *                            PostToolBatch, idle_prompt); SessionStart and Stop
 *                            may print JSON for Claude Code
 *   bbs-adapter --help | --skill | --version
 *
 * Board URL and agent token come from the same config file as the `bbs` CLI
 * (`BBS_CONFIG`, default `~/.config/bbs/config.json`; `BBS_URL`/`BBS_TOKEN`
 * override). Never from the command line. Optional: `BBS_MACHINE` (a name for
 * the machine such as `workstation-1`; default this host's short name), `BBS_OS`
 * (default the operating system, for example `Linux`), `BBS_MODEL` (the model,
 * sent only when set), `BBS_ADAPTER_LOG` (a file for JSON log
 * lines; ids and counts only, never message text or the token), `BBS_AUTO_JOIN`
 * (`0` or `off`: never join by itself; `1` or `always`: join outside a git
 * repository too; default: join inside one, issue #100).
 *
 * `BBS_HARNESS` picks the ring: `claude-code` (the default) or `codex`. For
 * Claude Code the ring uses the session's inbox socket when Claude Code gives
 * one (G4); `BBS_CLAUDE_RING=channel` makes it use the channel only. For
 * Codex, `BBS_CODEX_SOCKET` names the app-server socket (default: the
 * daemon's control socket under `CODEX_HOME`, else `~/.codex`), and
 * `BBS_CODEX_SERVER_NAME` the `[mcp_servers.<name>]` key (default `bbs`).
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { REAL_HOST, osLabel, shortHostName, type HostFacts } from "@bbs-5000/cli/src/host.ts";
import { loadConfig, PreconditionError } from "@bbs-5000/cli/src/main.ts";
import { Adapter } from "./adapter.ts";
import { AppServerClient } from "./app-server-client.ts";
import { autoJoinPlan, projectDirOf } from "./auto-join.ts";
import { BoardApi, isRevokedToken } from "./board-api.ts";
import { CredentialRevokedError } from "./board-socket.ts";
import { ClaudeRing } from "./claude-ring.ts";
import { CodexRing } from "./codex-ring.ts";
import { batchIsWork, HandBack, stopOutput } from "./hand-back.ts";
import { askHook, HookListener, messagingKey, notifyHook, pidKey, runHook, socketDir } from "./hooks.ts";
import { claudeInbox } from "./inbox-socket.ts";
import { sessionStartOutput, sessionStartText, startSourceOf } from "./session-start.ts";

export const VERSION = "0.0.0";

export const USAGE = `bbs-adapter ${VERSION}: BBS-5000 wake adapter for Claude Code and Codex

Usage:
  bbs-adapter                 run as the stdio MCP server (Claude Code or Codex starts this)
  bbs-adapter hook <event>    report a Claude Code hook event to this session's adapter
                              (UserPromptSubmit, Stop, StopFailure, PostToolBatch, idle_prompt);
                              prints nothing, except SessionStart and Stop, which may print
                              JSON for Claude Code (the session-start text, the hand-back note)
  bbs-adapter --help | --skill | --version

Config: BBS_CONFIG (default ~/.config/bbs/config.json) with url and token, as for bbs.
Optional: BBS_MACHINE and BBS_OS (default: this host's short name and operating
system), BBS_MODEL (sent only when set), BBS_ADAPTER_LOG (a log file of ids and counts).
BBS_AUTO_JOIN: 0 or off = never join by itself; 1 or always = join outside a git
repository too; default = join when the session's directory is in a git repository.
Harness: BBS_HARNESS=claude-code (default) or codex. For claude-code: rings go to the
session's inbox socket when Claude Code provides one, else the channel;
BBS_CLAUDE_RING=channel uses the channel only. For codex: BBS_CODEX_SOCKET (the
app-server socket; default the daemon's control socket under CODEX_HOME or ~/.codex),
BBS_CODEX_SERVER_NAME (the [mcp_servers.<name>] key; default bbs).
Exit status: 0 ok; 2 usage; 3 config missing or unreadable.
`;

export const HARNESSES = ["claude-code", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

/** The harness from `BBS_HARNESS` (default `claude-code`), or undefined when it names none. */
export function harnessOf(env: NodeJS.ProcessEnv): Harness | undefined {
  const v = env.BBS_HARNESS?.trim() || "claude-code";
  return (HARNESSES as readonly string[]).includes(v) ? (v as Harness) : undefined;
}

/**
 * The Codex app-server socket: `BBS_CODEX_SOCKET` (a path, or `unix://<path>`),
 * else the daemon's control socket, `<CODEX_HOME or ~/.codex>/app-server-control/app-server-control.sock`.
 */
export function codexSocketPath(env: NodeJS.ProcessEnv): string {
  const v = env.BBS_CODEX_SOCKET?.trim();
  if (v) return v.startsWith("unix://") ? v.slice("unix://".length) : v;
  const home = env.CODEX_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".codex");
  return join(home, "app-server-control", "app-server-control.sock");
}

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

function logger(env: NodeJS.ProcessEnv, io: Io): (event: string, detail?: Record<string, unknown>) => void {
  const file = env.BBS_ADAPTER_LOG;
  return (event, detail = {}) => {
    const line = JSON.stringify({ t: Date.now(), ev: event, ...detail });
    io.err(`bbs-adapter ${line}`);
    if (file) {
      try {
        appendFileSync(file, `${line}\n`);
      } catch {
        // Logging must never stop the adapter.
      }
    }
  };
}

/** Hook input kept for reading; a doorbell's channel prompt is far shorter. */
const MAX_HOOK_INPUT = 256 * 1024;

/**
 * Read the hook's stdin (its JSON input) for up to `ms`, keeping at most
 * `MAX_HOOK_INPUT` characters and draining the rest. `truncated` when more came.
 */
async function readStdin(ms: number): Promise<{ text: string; truncated: boolean }> {
  if (process.stdin.isTTY) return { text: "", truncated: false };
  let text = "";
  let truncated = false;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      if (text.length + chunk.length <= MAX_HOOK_INPUT) text += chunk;
      else truncated = true;
    });
    process.stdin.once("end", done);
    process.stdin.once("error", done);
  });
  process.stdin.pause();
  return { text, truncated };
}

/** The fields of a hook's JSON input; an empty object when it is not readable. */
function inputFields(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** How long a SessionStart hook waits for the adapter's socket to appear: the MCP server may start after it. */
const SESSION_START_WAIT_MS = 3000;

/**
 * One `bbs-adapter hook <event>` run. Returns the text to print, if any: the
 * hook output Claude Code reads (`SessionStart`, `Stop`), else undefined. The
 * hook input is read by `readStdin`; a prompt too long to keep counts as a
 * prompt (B57), and a tool batch too long to read counts as work.
 */
export async function runHookCommand(
  event: string,
  env: NodeJS.ProcessEnv,
  input: { text: string; truncated: boolean },
  ppid = process.ppid,
): Promise<string | undefined> {
  const fields = input.truncated ? {} : inputFields(input.text);
  if (event === "SessionStart") {
    const text = await askHook("SessionStart", { source: startSourceOf(fields.source) }, env, { waitMs: SESSION_START_WAIT_MS, ppid });
    return text === undefined ? undefined : sessionStartOutput(text);
  }
  if (event === "Stop") {
    const text = await askHook("Stop", { stop_hook_active: fields.stop_hook_active === true }, env, { ppid });
    return text === undefined ? undefined : stopOutput(text);
  }
  if (event === "PostToolBatch") {
    await notifyHook("PostToolBatch", { work: input.truncated ? true : batchIsWork(input.text) }, env, ppid);
    return undefined;
  }
  // A prompt too long to keep is not a doorbell line: report it as a
  // prompt (B57) rather than as unreadable.
  await runHook(event, env, ppid, undefined, input.truncated ? JSON.stringify({ prompt: "" }) : input.text);
  return undefined;
}

export async function run(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h" || cmd === "--skill") {
    io.out(USAGE);
    return 0;
  }
  if (cmd === "--version") {
    io.out(VERSION);
    return 0;
  }
  if (cmd === "hook") {
    // A hook never fails Claude Code's turn. It prints nothing, except the two
    // that answer the model: SessionStart and Stop (issue #100).
    const input = await readStdin(500);
    const event = rest[0] ?? "";
    try {
      const output = await runHookCommand(event, env, input);
      if (output !== undefined) io.out(output);
    } catch {
      // Ignored on purpose.
    }
    return 0;
  }
  if (cmd !== undefined && cmd !== "serve") {
    io.err(USAGE);
    return 2;
  }
  const harness = harnessOf(env);
  if (harness === undefined) {
    io.err(`bbs-adapter: BBS_HARNESS must be one of ${HARNESSES.join(", ")}\n${USAGE}`);
    return 2;
  }
  const socket = harness === "codex" ? codexSocketPath(env) : undefined;
  if (socket !== undefined && (!socket.startsWith("/") || socket.includes(":"))) {
    io.err("bbs-adapter: BBS_CODEX_SOCKET must be an absolute path without ':'");
    return 2;
  }
  return serve(env, io, harness, socket);
}

/**
 * The labels `bbs_join` carries besides the harness: `machine` and `os` from
 * `BBS_MACHINE` and `BBS_OS` when set, else this host's short name and
 * operating system; `model` only when `BBS_MODEL` names it (the adapter does
 * not learn the model from the harness, so it never guesses one).
 */
export function sessionLabels(
  env: NodeJS.ProcessEnv,
  host: HostFacts = REAL_HOST,
): { machine?: string; os?: string; model?: string } {
  const machine = env.BBS_MACHINE?.trim() || shortHostName(host);
  const os = env.BBS_OS?.trim() || osLabel(host);
  const model = env.BBS_MODEL?.trim();
  return {
    ...(machine ? { machine } : {}),
    ...(os ? { os } : {}),
    ...(model ? { model } : {}),
  };
}

/** A harness session id the board accepts as a `harness_session` label: printable, at most 128 characters. */
const HARNESS_SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The id of the conversation a Claude Code adapter serves, for `bbs_join`'s
 * `harness_session` (issue #98): Claude Code's own session id, which it gives
 * its child processes as `CLAUDE_CODE_SESSION_ID` and names the conversation's
 * transcript by. The board gives the session a handle of its own under the
 * token, and the same handle again when the conversation is resumed, if the id
 * survives a resume. Undefined when it is missing or not a plain label: the join
 * then goes without one and acts as the token's own handle, as before.
 */
export function claudeHarnessSession(env: NodeJS.ProcessEnv): string | undefined {
  const v = env.CLAUDE_CODE_SESSION_ID?.trim();
  return v !== undefined && HARNESS_SESSION_RE.test(v) ? v : undefined;
}

/** A Codex thread id, as `harness_session` (see `claudeHarnessSession`); undefined when none is known or it is not a plain label. */
export function codexHarnessSession(threadId: string | undefined): string | undefined {
  return threadId !== undefined && HARNESS_SESSION_RE.test(threadId) ? threadId : undefined;
}

async function serve(env: NodeJS.ProcessEnv, io: Io, harness: Harness, codexSocket: string | undefined): Promise<number> {
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    io.err(`bbs-adapter: ${err instanceof PreconditionError ? err.message : "cannot read config"}`);
    return 3;
  }
  const log = logger(env, io);
  const api = new BoardApi({ url: config.url, token: config.token });
  const labels = sessionLabels(env);
  const machine = labels.machine;
  let session: string | undefined;
  /** The handle the session acts as, from the join (for the session-start text). */
  let handle: string | undefined;
  // Issue #100: a Claude Code session joins by itself in a git repository (or as BBS_AUTO_JOIN says), with a role line naming it.
  const plan = harness === "claude-code" ? autoJoinPlan(env, projectDirOf(env)) : undefined;
  let roleToSend = plan?.join === true ? plan.role : undefined;
  let settleFirstJoin: () => void = () => undefined;
  /** Settles when the first join attempt has finished (or at once when there is none to wait for). */
  const firstJoin = new Promise<void>((resolve) => {
    settleFirstJoin = resolve;
  });
  if (plan?.join !== true) settleFirstJoin();
  const handBack = new HandBack();
  /** The id of a task this session holds in progress, from the board; throws when the board does not say. */
  async function heldTask(): Promise<number | undefined> {
    const r = await Promise.race([
      api.call("bbs_task_list", { assignee: "me", state: "in_progress", limit: 1 }, session),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000).unref()),
    ]);
    if (r.body.ok !== true) throw new Error("board refused");
    const tasks = (r.body.value as { tasks?: unknown } | undefined)?.tasks;
    const id = Array.isArray(tasks) ? (tasks[0] as { id?: unknown } | undefined)?.id : undefined;
    return typeof id === "number" ? id : undefined;
  }
  const hooks = new HookListener(log, {
    handlers: {
      turnStarted: () => handBack.turnStarted(),
      worked: () => handBack.worked(),
      async sessionStart(source) {
        // The hook can run before the join has finished: wait for it, but not for long.
        await Promise.race([firstJoin, new Promise<void>((resolve) => setTimeout(resolve, 3000).unref())]);
        return sessionStartText({
          source: startSourceOf(source),
          joined: session !== undefined,
          ...(handle !== undefined ? { handle } : {}),
        });
      },
      async stop(stopHookActive) {
        const text = await handBack.atStop({ stopHookActive, joined: session !== undefined, heldTask });
        if (text !== undefined) log("hand_back_asked");
        return text;
      },
    },
  });
  let adapter: Adapter | undefined;
  // The harness's id for this conversation, read at each join (a Codex thread is known only after attach).
  let harnessSessionId: () => string | undefined = () => claudeHarnessSession(env);
  async function join(): Promise<void> {
    try {
      const harnessSession = harnessSessionId();
      const r = await api.call("bbs_join", {
        harness,
        ...labels,
        ...(harnessSession !== undefined ? { harness_session: harnessSession } : {}),
        ...(roleToSend !== undefined ? { role: roleToSend } : {}),
      });
      if (isRevokedToken(r)) throw new CredentialRevokedError("bbs_join refused: revoked_token");
      const value = r.body.value as { session?: unknown; handle?: unknown } | undefined;
      if (r.body.ok !== true || typeof value?.session !== "string") {
        const error = r.body.error as { code?: unknown } | undefined;
        throw new Error(`bbs_join refused (${typeof error?.code === "string" ? error.code : r.status})`);
      }
      session = value.session;
      handle = typeof value.handle === "string" ? value.handle : undefined;
      // The role goes with the first join that succeeds; a later join (after the board replaced the session) keeps the model's own.
      roleToSend = undefined;
      log("joined", {
        first: Boolean((r.body.value as { first_join?: unknown }).first_join),
        session_handle: typeof (r.body.value as { parent?: unknown }).parent === "string",
      });
    } finally {
      settleFirstJoin();
    }
  }
  // One live session per agent token (review M1): after another adapter
  // took it, this one joins again only when its model uses the board.
  const calls = {
    async prepareCall() {
      if (session !== undefined) return;
      await join();
      adapter?.resume();
      // A session that did not join by itself attaches to the board with its first tool call.
      if (harness === "claude-code") attachClaude();
    },
    sessionEnded() {
      session = undefined;
    },
  };
  let ring: ClaudeRing | CodexRing;
  let state: HookListener | CodexRing;
  let claudeAttached = false;
  const attachClaude = (): void => {
    if (claudeAttached) return;
    claudeAttached = true;
    adapter?.start();
  };
  let app: AppServerClient | undefined;
  if (harness === "codex") {
    // Attach to the board once the MCP client has initialized and the
    // thread is known: a doorbell before that could not be rung.
    let mcpReady = false;
    let attached = false;
    const attach = (): void => {
      if (attached || !mcpReady || codex.threadId === undefined) return;
      attached = true;
      adapter?.start();
    };
    app = new AppServerClient({ socketPath: codexSocket!, log, clientVersion: VERSION });
    const codex = new CodexRing({
      api,
      session: () => session,
      log,
      app,
      serverName: env.BBS_CODEX_SERVER_NAME?.trim() || "bbs",
      onInitialized: () => {
        mcpReady = true;
        attach();
      },
      onThread: () => attach(),
      ...calls,
    });
    harnessSessionId = () => codexHarnessSession(codex.threadId);
    ring = codex;
    state = codex;
  } else {
    // G4: ring through this session's inbox socket when Claude Code gave us
    // one (unless BBS_CLAUDE_RING=channel).
    const inbox = claudeInbox(env);
    log("ring_path", { inbox: inbox !== undefined });
    log("auto_join", { mode: plan?.mode ?? null, join: plan?.join ?? false });
    ring = new ClaudeRing({
      ...(inbox ? { inbox } : {}),
      api,
      session: () => session,
      busy: () => ({
        lastBusyAt: hooks.lastBusyAt,
        seen: hooks.seen,
        busyNow: hooks.current() === "busy",
        doorbellTurnAt: (id) => hooks.doorbellTurnAt(id),
        lastUnknownBusyAt: hooks.lastUnknownBusyAt,
      }),
      log,
      // Attach (and so join) now only when the plan says to; else at the first tool call.
      onInitialized: () => {
        if (plan?.join === true) attachClaude();
      },
      ...calls,
    });
    state = hooks;
  }
  adapter = new Adapter({
    url: config.url,
    token: config.token,
    machine,
    session: () => session,
    resetSession: () => {
      session = undefined;
    },
    ensureSession: join,
    // After a connection that never opened: is the token revoked? (review m4)
    async probeCredential() {
      const r = await api.call("bbs_whoami", {});
      if (isRevokedToken(r)) throw new CredentialRevokedError("upgrade refused: revoked_token");
    },
    ring,
    state,
    log,
  });
  if (harness === "claude-code") {
    const keys = [messagingKey(env), pidKey(process.ppid)].filter((k): k is string => k !== undefined);
    try {
      const paths = await hooks.listen(socketDir(env), keys);
      log("hooks_listening", { sockets: paths.length, by_messaging_socket: keys[0]?.startsWith("m-") ?? false });
    } catch (err) {
      log("hooks_unavailable", { error: err instanceof Error ? err.message.slice(0, 120) : "error" });
    }
  }
  app?.start();
  let stopping = false;
  const shutdown = (why: string): void => {
    if (stopping) return;
    stopping = true;
    log("shutdown", { why });
    adapter?.stop(why);
    hooks.close();
    if (ring instanceof CodexRing) ring.close();
    app?.stop();
    setTimeout(() => process.exit(0), 200).unref();
  };
  ring.server.onclose = () => shutdown("mcp_closed");
  process.stdin.once("end", () => shutdown("stdin_closed"));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, () => shutdown(sig));
  await ring.connect(new StdioServerTransport());
  log("started", { version: VERSION, harness, machine_set: machine !== undefined });
  return new Promise<number>(() => undefined);
}
