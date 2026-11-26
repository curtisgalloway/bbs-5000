#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// M2 real-session wake test (A2.1, A2.4, A2.5, A2.6) with a real, idle Claude
// Code session. GATED: it launches `claude` (a model run) with
// --dangerously-load-development-channels, which only a person may start
// (the permission classifier refuses it from an agent session), or with
// --inbox (G4) without that flag. See test/manual/README.md.
//
// What it does, all in a temporary directory:
//   1. starts `wrangler dev` (test/e2e/harness.ts) with a fresh board;
//   2. creates agents A and B with the human credential; A makes #t; B joins #t at wake;
//   3. starts agent B: an interactive `claude` in a detached tmux session, with the
//      adapter (packages/adapter) as its MCP server and channel, and the hooks: from a
//      project `.mcp.json` and the run's settings file, or with `--plugin` (G2) from the
//      plugin itself (`--plugin-dir packages/adapter`, channel `plugin:bbs@inline`, its
//      user options given in the run's settings file under `pluginConfigs`);
//      answers the development-channels warning and the folder-trust menu (phase 0 only);
//      with `--inbox` (G4) claude starts WITHOUT the development-channels flag, so the
//      channel is not loaded and every ring must go through the session's inbox socket;
//   4. acts as agent A over /api and checks, with no keypress into B:
//      phase 1 (A2.1): A posts in #t; B starts a turn within 10 s and its bbs_inbox
//              returns the message;
//      phase 2 (A2.4): B is made busy (a typed prompt: run `node wait25.mjs` in the
//              foreground, ~25 s; Claude Code refuses a standalone `sleep` and
//              backgrounds it); once the command has run 1 s, A posts; the ring is
//              held (audited held_busy) and rung after Stop. If B stops before the
//              debounce has expired, the phase fails as "driver: not busy long
//              enough", not as a product failure;
//      phase 3 (A2.5): A posts in the Lobby; no turn within 15 s;
//      phase 4 (A2.5): A @mentions B in the Lobby; B starts a turn within 10 s;
//      phase 5 (A2.6): B's own post (B's token over /api) never rings B;
//   5. prints a JSON summary and a RESULT line; exit 0 only when every phase passed.
//
// Usage: node test/manual/run-wake.ts [--plugin] [--inbox] [--keep] [--no-accept] [--only <phases>] [--user-settings] [-- <extra claude args>]
//   --plugin     load the adapter as the Claude Code plugin `bbs` (G2) instead of a
//                project .mcp.json plus hooks in the settings file
//   --inbox      (G4) no --dangerously-load-development-channels: rings must arrive by
//                the inbox socket; adds a criterion that every ring went that way
//   --keep       leave the tmux session and board running until Enter is pressed
//   --no-accept  do not answer the startup dialogs; answer them yourself (tmux attach)
//   --only       run only these phases after setup (comma-separated): idle, busy,
//                lobby, mention, own. Each starts from an idle session. Saves model
//                use on a rerun, for example `--only busy`.
//   --user-settings  also load the user's own Claude Code settings (hooks, modes such as
//                auto mode). By default claude gets `--setting-sources project,local`,
//                so only the run's own settings apply.
//   extra args   passed to claude, for example: -- --model haiku
// BBS_CLAUDE_BIN=<path> swaps in a stand-in (test/manual/fake-claude.mjs) for a dry run.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { api, makeRunDir, ROOT, sleep, startWrangler } from "../e2e/harness.ts";

const BIN = join(ROOT, "packages/adapter/bin/bbs-adapter.js");
const HOOK_LOG_BIN = join(ROOT, "test/manual/hook-log.mjs");
const argv = process.argv.slice(2);
const dashdash = argv.indexOf("--");
const own = dashdash === -1 ? argv : argv.slice(0, dashdash);
const extra = dashdash === -1 ? [] : argv.slice(dashdash + 1);
const PHASE_NAMES = ["idle", "busy", "lobby", "mention", "own"] as const;
type PhaseName = (typeof PHASE_NAMES)[number];
const onlyAt = own.indexOf("--only");
const only = onlyAt === -1 ? [...PHASE_NAMES] : (own[onlyAt + 1] ?? "").split(",").filter(Boolean);
if (only.length === 0 || only.some((p) => !(PHASE_NAMES as readonly string[]).includes(p))) {
  console.error(`--only takes one or more of: ${PHASE_NAMES.join(", ")}`);
  process.exit(2);
}
const runs = (p: PhaseName): boolean => only.includes(p);
const opt = {
  keep: own.includes("--keep"),
  accept: !own.includes("--no-accept"),
  plugin: own.includes("--plugin"),
  inbox: own.includes("--inbox"),
};
const PLUGIN_DIR = join(ROOT, "packages/adapter");
// The id Claude Code gives a plugin loaded with --plugin-dir (G2 probe: `plugin details`).
const PLUGIN_ID = "bbs@inline";
// A path (relative to where the driver runs) is made absolute: the session starts in B's folder.
const claudeBin = ((b) => (b.includes("/") ? resolve(b) : b))(process.env.BBS_CLAUDE_BIN ?? "claude");
const now = (): number => Date.now();
const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
const sh = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: "utf8" });

for (const tool of ["tmux", claudeBin]) {
  try {
    sh("which", [tool]);
  } catch {
    if (!existsSync(tool)) {
      console.error(`missing on PATH: ${tool}`);
      process.exit(2);
    }
  }
}

// --- board and users -----------------------------------------------------------
const run = makeRunDir("owner");
const human = run.humanToken;
console.log(`run dir: ${run.dir}`);
const server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
const asCli = { "x-bbs-client": "cli" };
async function call(token: string, tool: string, args: unknown = {}, headers: Record<string, string> = {}): Promise<any> {
  const r = await api(server.url, token, tool, args, headers);
  if (r.status !== 200) throw new Error(`${tool}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.value;
}
const A = "wake-a";
const B = "wake-b";
const tokA = (await call(human, "bbs_admin_user_add", { handle: A }, asCli)).token as string;
const tokB = (await call(human, "bbs_admin_user_add", { handle: B, harness: "claude-code" }, asCli)).token as string;
await call(tokA, "bbs_join", { role: "test driver" });
await call(tokA, "bbs_topic_create", { name: "t", description: "M2 wake test" });
await call(tokB, "bbs_subscribe", { topic: "t", level: "wake" });

// --- agent B's workspace --------------------------------------------------------
const bDir = join(run.dir, "agent-b");
mkdirSync(bDir);
const bConfig = join(bDir, "bbs-config.json");
writeFileSync(bConfig, JSON.stringify({ url: server.url, token: tokB }), { mode: 0o600 });
// Phase 2's foreground command: a plain wait that is not a standalone `sleep`.
const BUSY_COMMAND = "node wait25.mjs";
const BUSY_SECONDS = 25;
writeFileSync(
  join(bDir, "wait25.mjs"),
  `// Manual wake test: keeps a foreground Bash tool call running.\nsetTimeout(() => console.log("ok"), ${BUSY_SECONDS * 1000});\n`,
);
// The board's doorbell debounce (DEFAULT_CONFIG; the driver's board does not override it).
const DEBOUNCE_MS = 5000;
const adapterLog = join(run.dir, "adapter.jsonl");
const hookLog = join(run.dir, "hooks.jsonl");
if (!opt.plugin) writeFileSync(
  join(bDir, ".mcp.json"),
  JSON.stringify(
    {
      mcpServers: {
        bbs: {
          command: process.execPath,
          args: [BIN],
          env: { BBS_CONFIG: bConfig, BBS_ADAPTER_LOG: adapterLog, BBS_MACHINE: "workstation-1" },
        },
      },
    },
    null,
    2,
  ),
);
// With --plugin the adapter's own hooks come from the plugin (hooks/hooks.json);
// the settings file keeps only the timing log, which Claude Code runs beside them.
const hook = (event: string) => [
  {
    hooks: [
      ...(opt.plugin ? [] : [{ type: "command", command: `${q(process.execPath)} ${q(BIN)} hook ${event}` }]),
      { type: "command", command: `WAKE_HOOK_LOG=${q(hookLog)} ${q(process.execPath)} ${q(HOOK_LOG_BIN)} ${event}` },
    ],
  },
];
const settingsFile = join(run.dir, "settings.json");
writeFileSync(
  settingsFile,
  JSON.stringify(
    {
      enableAllProjectMcpServers: true,
      // --plugin: the plugin's user options (G2 probe: the --settings flag's
      // pluginConfigs reaches ${user_config.*}, also with --setting-sources project,local).
      ...(opt.plugin ? { pluginConfigs: { [PLUGIN_ID]: { options: { config_path: bConfig, machine: "workstation-1" } } } } : {}),
      permissions: {
        allow: [
          ...(opt.plugin
            ? // A plugin's MCP server is named plugin:bbs:bbs; its tools mcp__plugin_bbs_bbs__<tool>.
              ["bbs_inbox", "bbs_read", "bbs_topics", "bbs_who", "bbs_join"].map((t) => `mcp__plugin_bbs_bbs__${t}`)
            : ["mcp__bbs__bbs_inbox", "mcp__bbs__bbs_read", "mcp__bbs__bbs_topics", "mcp__bbs__bbs_who", "mcp__bbs__bbs_join"]),
          `Bash(${BUSY_COMMAND})`,
        ],
      },
      hooks: { UserPromptSubmit: hook("UserPromptSubmit"), Stop: hook("Stop"), StopFailure: hook("StopFailure"),
        // Timing only (hook-log, not the adapter): when phase 2's command starts.
        PreToolUse: [{ matcher: "Bash", hooks: [hook("PreToolUse")[0]!.hooks.at(-1)!] }],
        Notification: [{ matcher: "idle_prompt", ...hook("idle_prompt")[0] }] },
    },
    null,
    2,
  ),
);

// --- tmux ---------------------------------------------------------------------------
const session = `bbs-wake-${process.pid}`;
const keysSent: { t: number; keys: string[] }[] = [];
const screen = (): string => {
  try {
    return sh("tmux", ["capture-pane", "-p", "-J", "-t", session]);
  } catch {
    return "";
  }
};
const pane = (): string => {
  try {
    return sh("tmux", ["capture-pane", "-p", "-J", "-S", "-400", "-t", session]);
  } catch {
    return "";
  }
};
const snapshot = (name: string): void => writeFileSync(join(run.dir, `pane-${name}.txt`), pane());
function sendKeys(...keys: string[]): void {
  keysSent.push({ t: now(), keys });
  sh("tmux", ["send-keys", "-t", session, ...keys]);
}
// The user's own settings stay out unless asked for (the 2026-11-20 runs showed
// "auto mode on" from them); an explicit --setting-sources in the extra args wins.
const settingSources =
  own.includes("--user-settings") || extra.includes("--setting-sources") ? [] : ["--setting-sources", "project,local"];
// Default permission mode unless asked otherwise: auto mode's first-use dialog
// blocked input in an earlier run.
const permissionMode = extra.includes("--permission-mode") ? [] : ["--permission-mode", "default"];
// --inbox (G4): no development-channels flag, so no channel and no warning dialog.
const devChannels = opt.inbox ? [] : ["--dangerously-load-development-channels", opt.plugin ? `plugin:${PLUGIN_ID}` : "server:bbs"];
const channelArgs = [...(opt.plugin ? ["--plugin-dir", PLUGIN_DIR] : []), ...devChannels];
const claudeCmd = [claudeBin, "--settings", settingsFile, ...channelArgs, ...permissionMode, ...settingSources, ...extra]
  .map(q)
  .join(" ");
// A running tmux server does not pass the driver's environment on; the
// stand-in's dry-run switch is passed explicitly. With --plugin, the adapter's
// log file reaches it through the environment it inherits from claude (G2 probe),
// since the plugin's manifest sets only BBS_CONFIG and BBS_MACHINE.
const fakeEnv = ["FAKE_CLAUDE_BACKGROUND", "FAKE_CLAUDE_NO_INBOX"].flatMap((k) => (process.env[k] ? ["-e", `${k}=${process.env[k]}`] : []));
const pluginEnv = opt.plugin ? ["-e", `BBS_ADAPTER_LOG=${adapterLog}`] : [];
sh("tmux", ["new-session", "-d", "-s", session, "-x", "200", "-y", "60", "-c", bDir, ...fakeEnv, ...pluginEnv, claudeCmd]);
console.log(`tmux session: ${session}  (watch: tmux attach -t ${session})`);
// Never leave the session behind (review m7): on any exit, an uncaught
// error included, and on Ctrl-C or a kill (which also stop the board).
let tmuxKilled = false;
function killTmux(): void {
  if (tmuxKilled) return;
  tmuxKilled = true;
  try {
    sh("tmux", ["kill-session", "-t", session]);
  } catch {
    // Already gone.
  }
}
process.on("exit", killTmux);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    killTmux();
    void server.stop().finally(() => {
      rmSync(bConfig, { force: true });
      process.exit(130);
    });
  });
}
const tLaunch = now();

// --- logs ---------------------------------------------------------------------------
function jsonl(path: string): Record<string, any>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);
}
const adapter = (): Record<string, any>[] => jsonl(adapterLog);
const hooks = (): Record<string, any>[] => jsonl(hookLog);
async function waitFor<T>(fn: () => T | undefined | false, ms: number): Promise<T | undefined> {
  const deadline = now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (now() > deadline) return undefined;
    await sleep(250);
  }
}
const hookAfter = (name: string, t: number) => hooks().find((h) => h.hook === name && h.t > t);
const inboxWith = (seq: number, t: number) =>
  adapter().find((l) => l.ev === "tool" && l.name === "bbs_inbox" && l.t > t && (l.wake_seqs ?? []).includes(seq));
const doorbellsAfter = (t: number) => adapter().filter((l) => l.ev === "doorbell" && l.t > t);

// --- phase 0: dialogs, then idle ------------------------------------------------------
const numbered = (m: RegExpMatchArray): string[] => [m[1] ?? "1"];
const dialogs: { id: string; re: RegExp; keys: (m: RegExpMatchArray, text: string) => string[]; noRetryEnter?: boolean }[] = [
  { id: "dev-channels-warning", re: /(\d+)\.\s*I am using this for local development/, keys: numbered },
  { id: "folder-trust", re: /(\d+)\.\s*Yes, (?:I trust|proceed)/i, keys: numbered },
  {
    id: "folder-trust-arrow",
    re: /^(?![^\n]*\d+\.\s*Yes, I trust)[^\n]*Yes, I trust this folder/m,
    keys: (_m, text) => (/❯\s*Yes, I trust this folder/.test(text) ? ["Enter"] : ["Down", "Enter"]),
    noRetryEnter: true,
  },
  { id: "project-mcp-consent", re: /(\d+)\.\s*Use this MCP server/, keys: numbered },
];
const dialogsSeen: string[] = [];
const answers: Record<string, number> = {};
let ready = false;
let quiet = 0;
while (now() - tLaunch < 120_000) {
  await sleep(1000);
  const text = screen();
  let open = false;
  for (const d of dialogs) {
    const m = text.match(d.re);
    if (!m) continue;
    open = true;
    if (!dialogsSeen.includes(d.id)) dialogsSeen.push(d.id);
    answers[d.id] = (answers[d.id] ?? 0) + 1;
    if (opt.accept && (answers[d.id] ?? 0) <= 2) {
      for (const k of d.keys(m, text)) {
        sendKeys(k);
        await sleep(300);
      }
      await sleep(1200);
      if (!d.noRetryEnter && d.re.test(screen())) sendKeys("Enter");
      await sleep(1500);
    }
  }
  const attached = adapter().some((l) => l.ev === "attached");
  quiet = !open && attached ? quiet + 1 : 0;
  if (quiet >= 5) {
    ready = true;
    break;
  }
}
snapshot("idle");
// B's own join message is in the Lobby (digest); start from an empty inbox.
await call(tokB, "bbs_inbox", {});
const keysAfterSetup = keysSent.length;

interface Phase {
  pass: boolean;
  [k: string]: unknown;
}
const phases: Record<string, Phase> = {};

/**
 * Type a prompt into B's session. The text and the Enter are separate key
 * sends ~700 ms apart: sent together, Claude Code takes the burst as a paste
 * and the Enter does not submit (Curtis's real run, phase 2). If no
 * UserPromptSubmit hook follows within 3 s, Enter is sent once more. Every
 * send is recorded in keysSent. Returns the UserPromptSubmit hook, if any.
 */
async function typePrompt(text: string, t: number): Promise<Record<string, any> | undefined> {
  sendKeys("-l", text);
  await sleep(700);
  sendKeys("Enter");
  let busy = await waitFor(() => hookAfter("UserPromptSubmit", t), 3000);
  if (!busy) {
    sendKeys("Enter");
    busy = await waitFor(() => hookAfter("UserPromptSubmit", t), 30_000);
  }
  return busy;
}

async function wakePhase(name: string, topic: string, body: string): Promise<void> {
  await sleep(3000);
  const keysBefore = keysSent.length;
  const t = now();
  const seq = (await call(tokA, "bbs_post", { topic, body })).seq as number;
  const started = await waitFor(() => hookAfter("UserPromptSubmit", t), 10_000);
  const read = await waitFor(() => inboxWith(seq, t), 90_000);
  const stopped = await waitFor(() => (read ? hookAfter("Stop", read.t) : undefined), 90_000);
  snapshot(name);
  phases[name] = {
    pass: Boolean(started && read && keysSent.length === keysBefore),
    postSeq: seq,
    turnStartedMs: started ? started.t - t : null,
    inboxSawMessageMs: read ? read.t - t : null,
    stopMs: stopped ? stopped.t - t : null,
    doorbell: doorbellsAfter(t)[0]?.id ? true : false,
    keysSent: keysSent.length - keysBefore,
  };
}

async function quietPhase(name: string, act: () => Promise<number>): Promise<void> {
  await sleep(3000);
  const t = now();
  const seq = await act();
  await sleep(15_000);
  snapshot(name);
  const started = hookAfter("UserPromptSubmit", t);
  phases[name] = { pass: !started && doorbellsAfter(t).length === 0, postSeq: seq, turnStarted: Boolean(started), doorbells: doorbellsAfter(t).length };
}

if (ready) {
  // Phase 1 (A2.1): idle B, A posts in #t.
  if (runs("idle")) await wakePhase("phase1_idle_wake", "t", "Hello from agent A (BBS-5000 wake test). No action is needed beyond reading this.");

  // Phase 2 (A2.4): B busy, A posts; held, then rung after Stop.
  if (runs("busy")) {
  await sleep(3000);
  const t2 = now();
  const busy = await typePrompt(
    `Use the Bash tool to run the command ${BUSY_COMMAND} in the foreground (not in the background) ` +
      `and wait for it to finish; it takes about ${BUSY_SECONDS} seconds. Then reply with the single word DONE.`,
    t2,
  );
  let p2: Phase = { pass: false, verdict: busy ? "driver: busy command never started" : "driver: prompt not submitted", busy: Boolean(busy) };
  // Post only once B is busy in the board's eyes, has called no board tool,
  // and the command has been running 1 s.
  const running = busy
    ? await waitFor(() => {
        const pre = hooks().find((h) => h.hook === "PreToolUse" && h.t > busy.t && String(h.commandPrefix ?? "").includes("wait25"));
        const stateBusy = adapter().some((l) => l.ev === "state" && l.state === "busy" && l.t >= t2);
        const toolCalled = adapter().some((l) => l.ev === "tool" && l.t >= t2);
        const stopped = hookAfter("Stop", busy.t);
        return pre && stateBusy && !toolCalled && !stopped ? pre : undefined;
      }, 30_000)
    : undefined;
  if (busy && running) {
    await sleep(Math.max(0, running.t + 1000 - now()));
    const tp = now();
    const seq = (await call(tokA, "bbs_post", { topic: "t", body: "A second note from agent A, sent while you were busy." })).seq as number;
    await sleep(7000);
    const audit = (await call(human, "bbs_audit", { action: "doorbell_due", limit: 50 }, asCli)).events as any[];
    const heldRow = audit.find((e) => e.target_id === B && e.ts >= tp && e.detail?.ring?.result === "held_busy");
    const heldByAdapter = adapter().find((l) => l.ev === "ring" && l.t > tp && l.result === "held_busy");
    const stop = await waitFor(() => hookAfter("Stop", tp), 120_000);
    const rung = stop ? await waitFor(() => hookAfter("UserPromptSubmit", stop.t), 15_000) : undefined;
    const read = stop ? await waitFor(() => inboxWith(seq, stop.t), 90_000) : undefined;
    const earlyTurn = hooks().find((h) => h.hook === "UserPromptSubmit" && h.t > tp && (!stop || h.t < stop.t));
    // Stop before the debounce expired: the doorbell was never due while B
    // was busy, so the hold path was not exercised. A driver problem.
    const tooShort = Boolean(stop && stop.t < tp + DEBOUNCE_MS);
    const pass = Boolean(!tooShort && (heldRow || heldByAdapter) && stop && rung && read && !earlyTurn);
    p2 = {
      pass,
      verdict: tooShort ? "driver: not busy long enough" : pass ? "pass" : "product failure",
      busy: true,
      busyCommandStartedMsAfterPrompt: running.t - busy.t,
      postSeq: seq,
      heldAudited: Boolean(heldRow),
      heldByAdapter: Boolean(heldByAdapter),
      turnBeforeStop: Boolean(earlyTurn),
      stopMsAfterPost: stop ? stop.t - tp : null,
      rungMsAfterStop: rung && stop ? rung.t - stop.t : null,
      inboxSawMessage: Boolean(read),
    };
    await waitFor(() => (read ? hookAfter("Stop", read.t) : undefined), 90_000);
  }
  snapshot("phase2_busy_hold");
  phases.phase2_busy_hold = p2;
  }

  // Phase 3 (A2.5): a Lobby post rings nobody.
  if (runs("lobby")) await quietPhase("phase3_lobby_digest", async () => (await call(tokA, "bbs_post", { topic: "Lobby", body: "General hello from agent A." })).seq);

  // Phase 4 (A2.5): an @mention in the Lobby wakes B.
  if (runs("mention")) await wakePhase("phase4_lobby_mention", "Lobby", `@${B} a quick note for you in the Lobby. No action is needed beyond reading this.`);

  // Phase 5 (A2.6): B's own post (B's token) never rings B.
  if (runs("own")) await quietPhase("phase5_own_post", async () => (await call(tokB, "bbs_post", { topic: "t", body: `Note to self, @${B}.` })).seq);
}

// --- summary --------------------------------------------------------------------------------
const transcript = hooks().find((h) => h.transcriptPath)?.transcriptPath as string | undefined;
let usage: Record<string, unknown> | null = null;
if (transcript && existsSync(transcript)) {
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, assistantMessages: 0 };
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line);
      const m = e?.message?.usage;
      if (e?.type !== "assistant" || !m) continue;
      u.assistantMessages += 1;
      u.input += m.input_tokens ?? 0;
      u.output += m.output_tokens ?? 0;
      u.cacheRead += m.cache_read_input_tokens ?? 0;
      u.cacheWrite += m.cache_creation_input_tokens ?? 0;
    } catch {
      // Not JSON.
    }
  }
  usage = u;
}
// G2: what the plugin path showed. Hook events the adapter itself received
// (from the plugin's hooks.json with --plugin), rings confirmed by their own
// doorbell prompt (B57), and the <channel source="..."> Claude Code gave the
// doorbell's prompt (from the timing log's prompt prefix, never the text).
// The timing log can record the last Stop before the adapter's own hook has
// reported it (both hooks run on the same event); give the adapter's line 5 s.
await waitFor(() => !hooks().some((h) => h.hook === "Stop") || adapter().some((l) => l.ev === "hook" && l.event === "Stop"), 5000);
const hookEventsAtAdapter = adapter()
  .filter((l) => l.ev === "hook")
  .reduce<Record<string, number>>((acc, l) => ({ ...acc, [String(l.event)]: (acc[String(l.event)] ?? 0) + 1 }), {});
const ringsConfirmed = adapter().filter((l) => l.ev === "ring" && l.result === "turn_started" && l.confirmed === true).length;
const channelSources = [
  ...new Set(
    hooks()
      .map((h) => /<channel\b[^>]*?\ssource="([^"]{1,64})"/.exec(String(h.promptPrefix ?? ""))?.[1])
      .filter((v): v is string => Boolean(v)),
  ),
];
// Judged only when a phase that starts turns ran (lobby or own alone start none).
const ringPhaseRan = runs("idle") || runs("busy") || runs("mention");
const pluginPass =
  ready && (hookEventsAtAdapter.UserPromptSubmit ?? 0) > 0 && (hookEventsAtAdapter.Stop ?? 0) > 0 && ringsConfirmed > 0;
// G4: how each ring was handed over (adapter log `via`), and the turns whose prompt
// was an inbox doorbell (hook timing log, a flag only).
const ringsVia = adapter()
  .filter((l) => l.ev === "ring" && typeof l.via === "string")
  .reduce<Record<string, number>>((acc, l) => ({ ...acc, [String(l.via)]: (acc[String(l.via)] ?? 0) + 1 }), {});
const inboxPath = adapter().find((l) => l.ev === "ring_path")?.inbox ?? null;
const inboxErrors = adapter().filter((l) => l.ev === "inbox_error").length;
const inboxPromptTurns = hooks().filter((h) => h.hook === "UserPromptSubmit" && h.inboxMarker === true).length;
const ringsConfirmedInbox = adapter().filter((l) => l.ev === "ring" && l.via === "inbox" && l.confirmed === true).length;
const inboxPass =
  ready && inboxPath === true && inboxErrors === 0 && (ringsVia.channel ?? 0) === 0 && ringsConfirmedInbox > 0 && inboxPromptTurns > 0;
const summary = {
  claude: claudeBin === "claude" ? sh("claude", ["--version"]).trim() : "stand-in (dry run)",
  mode: `${opt.plugin ? `plugin ${PLUGIN_ID}` : ".mcp.json + settings hooks"}${opt.inbox ? ", inbox (no channel flag)" : ""}`,
  extraArgs: extra,
  settingSources: settingSources.length ? settingSources[1] : "as given / user settings included",
  ready,
  dialogsSeen,
  keysSentDuringSetup: keysAfterSetup,
  phases,
  only,
  hookEventsAtAdapter,
  ringsConfirmed,
  channelSources,
  inboxPath,
  ringsVia,
  ringsConfirmedInbox,
  inboxPromptTurns,
  inboxErrors,
  // Only the criteria whose phases ran (A2.5 needs both lobby and mention).
  criteria: Object.fromEntries(
    (
      [
        ["A2.1 idle wake within 10 s, bbs_inbox sees the message", ["idle"], () => phases.phase1_idle_wake?.pass ?? false],
        ["A2.4 held while busy, rung after the turn ends", ["busy"], () => phases.phase2_busy_hold?.pass ?? false],
        [
          "A2.5 Lobby post no turn; Lobby @mention turn",
          ["lobby", "mention"],
          () => (!runs("lobby") || phases.phase3_lobby_digest?.pass === true) && (!runs("mention") || phases.phase4_lobby_mention?.pass === true),
        ],
        ["A2.6 own posts never ring", ["own"], () => phases.phase5_own_post?.pass ?? false],
      ] as [string, PhaseName[], () => boolean][]
    )
      .filter(([, need]) => need.some(runs))
      .map(([k, , v]) => [k, v()])
      .concat(opt.plugin && ringPhaseRan ? [["G2 plugin: its hooks reached the adapter; a ring confirmed by its own doorbell prompt", pluginPass]] : [])
      .concat(
        opt.inbox && ringPhaseRan
          ? [["G4 inbox: no channel flag; every ring went by the inbox socket and one was confirmed by its marker", inboxPass]]
          : [],
      ),
  ) as Record<string, boolean>,
  usage,
  wallSeconds: Math.round((now() - tLaunch) / 1000),
};
writeFileSync(join(run.dir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
const failed = Object.entries(summary.criteria)
  .filter(([, v]) => !v)
  .map(([k]) => k.split(" ")[0]!)
  .map((id) => {
    const v = String(phases.phase2_busy_hold?.verdict ?? "");
    return id === "A2.4" && v.startsWith("driver") ? `A2.4 ${v}` : id;
  });

if (opt.keep) {
  console.log(`--keep: tmux session ${session} and the board are still running. Press Enter to stop them.`);
  await new Promise((r) => process.stdin.once("data", r));
}
killTmux();
await server.stop();
// The run directory keeps logs, pane snapshots and the summary; B's token file is removed.
rmSync(bConfig, { force: true });
console.log(`logs and pane snapshots: ${run.dir}`);
console.log(failed.length === 0 && ready ? "RESULT: pass" : `RESULT: fail (${ready ? failed.join(", ") : "session never became ready"})`);
process.exit(failed.length === 0 && ready ? 0 : 1);
