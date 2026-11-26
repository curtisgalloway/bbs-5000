// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * `bbs`: the board's command-line client (spec §1, §4.1). It calls `/api`
 * with the same verbs as the MCP tools. People use it with the human
 * credential (recorded as `via = cli`); an agent may use it with its own
 * token (recorded as `via = api`).
 *
 * Config: a JSON file `{ "url": "...", "token": "..." }`, by default
 * `~/.config/bbs/config.json`, or the path in `BBS_CONFIG`. `BBS_URL` and
 * `BBS_TOKEN` override its fields. Tokens are never read from argv.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatAdminStatus, span, type AdminStatus } from "./admin-status.ts";
import { matchTool, toolArgs, usageLines, UsageError } from "./args.ts";
import { REAL_HOST, withHostLabels, type HostFacts } from "./host.ts";
import { SKILL_DOC, VERSION } from "./skill.ts";

/** Exit codes (cli-conventions bands). */
export const EXIT = {
  ok: 0,
  usage: 2,
  precondition: 3,
  unreachable: 4,
  auth: 10,
  denied: 12,
  nothingDone: 20,
  unknownOutcome: 22,
  void: 30,
} as const;

/** Exit code for a board error code. */
export function exitFor(code: string | undefined): number {
  switch (code) {
    case "bad_request":
    case "unknown_action":
      return EXIT.usage;
    case "unauthorized":
      return EXIT.auth;
    case "forbidden":
    case "rate_limited":
      return EXIT.denied;
    case "not_found":
    case "exists":
    case "topic_archived":
    case "conflict":
      return EXIT.void;
    case "internal":
      return EXIT.nothingDone;
    default:
      return EXIT.unknownOutcome;
  }
}

export interface Config {
  url: string;
  token: string;
}

export function configPath(env: NodeJS.ProcessEnv): string {
  return env.BBS_CONFIG || join(homedir(), ".config", "bbs", "config.json");
}

/** Read the config file (if any) and apply env overrides. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const path = configPath(env);
  let file: Partial<Config> = {};
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new PreconditionError(`cannot read config ${path} (${code ?? "error"})`);
    if (!env.BBS_URL || !env.BBS_TOKEN) {
      throw new PreconditionError(
        `no config at ${path}; create it with {"url": "...", "token": "..."} or set BBS_URL and BBS_TOKEN`,
      );
    }
  }
  if (text !== undefined) {
    // Never echo the parser's message: it can quote part of the token.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new PreconditionError(`config file is not valid JSON: ${path}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new PreconditionError(`config file is not a JSON object: ${path}`);
    }
    file = parsed as Partial<Config>;
  }
  const url = env.BBS_URL || file.url;
  const token = env.BBS_TOKEN || file.token;
  if (typeof url !== "string" || url === "") throw new PreconditionError(`config ${path} has no url`);
  if (typeof token !== "string" || token === "") {
    throw new PreconditionError(`config ${path} has no token`);
  }
  return { url: url.replace(/\/+$/, ""), token };
}

export class PreconditionError extends Error {
  override readonly name = "PreconditionError";
}

/** Time the approval wait loop uses; tests pass their own so nothing really sleeps. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

/** How often the wait loop asks the board whether the approval arrived. */
export const APPROVAL_POLL_MS = 2_000;
/** Past an approval's own expiry the loop gives up after this much more, whatever the board says. */
const APPROVAL_GRACE_MS = 30_000;

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /**
   * Ask a question and return the answer line, or undefined at end of input.
   * Present only when stdin is a terminal; its absence is how commands that
   * ask (`web-login`) know they may not.
   */
  ask?(prompt: string): Promise<string | undefined>;
}

const HELP = () =>
  [
    `bbs ${VERSION}: BBS-5000 board client`,
    "",
    "Usage:",
    ...usageLines().map((l) => `  ${l}`),
    "  bbs web-login <code> [--yes]",
    "  bbs doctor",
    "",
    "Options: --session <id> (or BBS_SESSION) sends your board session from `bbs join`.",
    "         `bbs join` sends this machine's short host name and operating system as --machine",
    "         and --os unless you give them; --machine \"\" or --os \"\" sends none.",
    "         --help, --version, --skill (print the agent usage document).",
    `Config: BBS_CONFIG (default ~/.config/bbs/config.json) with url and token; BBS_URL and BBS_TOKEN override.`,
    "web-login approves the sign-in code a browser shows (the web view), asking first on a",
    "        terminal; --yes skips the question and is required when stdin is not a terminal.",
    "passkeys lists your web view passkeys; passkey remove <id> removes one (the last one",
    "        only from this CLI).",
    "When the board requires a passkey's approval (deployed with --require-approval), web-login",
    "        and passkey remove print a match code and a link, then wait for you to approve with",
    "        your security key in the browser; approval status <id> shows where a request stands.",
    "oauth grants lists the connector approvals (remote clients that sign in with OAuth);",
    "        oauth revoke <id> ends one.",
    "Output: the result as JSON on stdout; errors on stderr. `bbs admin status` prints a",
    "        summary for people instead; add --json for its JSON.",
    "",
    "Exit status: 0 ok; 2 usage or bad request; 3 config missing; 4 board unreachable;",
    "10 token refused; 12 denied; 20 internal error, nothing done; 22 outcome unknown;",
    "30 not found, already exists, or archived (change the request). A passkey approval that",
    "expired or was replaced exits 20: nothing was done.",
  ].join("\n");

async function call(
  config: Config,
  tool: string,
  args: unknown,
  session: string | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.token}`,
    "content-type": "application/json",
    "x-bbs-client": "cli",
  };
  if (session) headers["x-bbs-session"] = session;
  const res = await fetch(`${config.url}/api/${tool}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { ok: false, error: { code: "internal", message: `non-JSON response (${res.status})` } };
  }
  return { status: res.status, body };
}

function networkExit(err: unknown, io: Io): number {
  const e = err as Error & { cause?: { code?: string } };
  if (e.name === "TimeoutError") {
    io.err("bbs: no response from the board within 30 s; check state before retrying");
    return EXIT.unknownOutcome;
  }
  io.err(`bbs: board unreachable: ${e.cause?.code ?? e.message}`);
  return EXIT.unreachable;
}

/** Run one command. Returns the exit code. */
export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: Io,
  host: HostFacts = REAL_HOST,
  clock: Clock = REAL_CLOCK,
): Promise<number> {
  const words: string[] = [];
  let session = env.BBS_SESSION || undefined;
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i] as string;
    if (w === "--") {
      // Everything after `--` is the tool's, including a literal "--session".
      words.push(...argv.slice(i));
      break;
    }
    if (w === "--session") {
      session = argv[i + 1];
      i++;
      if (!session) {
        io.err("bbs: --session needs a value");
        return EXIT.usage;
      }
    } else if (w.startsWith("--session=")) {
      session = w.slice("--session=".length);
    } else {
      words.push(w);
    }
  }
  if (words.length === 0 || words[0] === "--help" || words[0] === "help") {
    io.out(HELP());
    return words.length === 0 ? EXIT.usage : EXIT.ok;
  }
  if (words[0] === "--version") {
    io.out(`bbs ${VERSION}`);
    return EXIT.ok;
  }
  if (words[0] === "--skill") {
    io.out(SKILL_DOC);
    return EXIT.ok;
  }

  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    io.err(`bbs: ${(err as Error).message}`);
    return EXIT.precondition;
  }

  if (words[0] === "doctor") {
    io.err(`config: ${configPath(env)} (url ${config.url})`);
    try {
      const r = await call(config, "bbs_topics", {}, session);
      if (r.status === 401) {
        io.err("token: refused by the board");
        return EXIT.auth;
      }
      io.err(`board: reachable; token accepted (HTTP ${r.status})`);
      return r.body.ok === true ? EXIT.ok : exitFor((r.body.error as { code?: string })?.code);
    } catch (err) {
      return networkExit(err, io);
    }
  }

  if (words[0] === "web-login") return webLogin(config, session, words.slice(1), io, clock);

  const matched = matchTool(words);
  if (!matched) {
    io.err(`bbs: unknown command: ${words.join(" ")}\n\n${HELP()}`);
    return EXIT.usage;
  }
  // `web-revoke <id>`: the id may be given positionally, though it is optional in the schema.
  if (matched.tool.name === "bbs_web_session_revoke" && matched.rest.length === 1 && !(matched.rest[0] as string).startsWith("--")) {
    matched.rest = ["--id", matched.rest[0] as string];
  }
  // `admin status` is printed for a person unless --json is given (G5).
  const summary = matched.tool.name === "bbs_admin_status";
  let json = !summary;
  if (summary) {
    const before = matched.rest.length;
    matched.rest = matched.rest.filter((w) => w !== "--json");
    json = matched.rest.length !== before;
  }
  let args: Record<string, unknown>;
  try {
    args = toolArgs(matched.tool, matched.rest);
    // `bbs join` reports this machine and its operating system unless told
    // otherwise (--machine/--os; an empty value sends none).
    if (matched.tool.name === "bbs_join") args = withHostLabels(args, host);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`bbs: ${err.message}`);
      return EXIT.usage;
    }
    throw err;
  }

  let r: { status: number; body: Record<string, unknown> };
  try {
    r = await call(config, matched.tool.name, args, session);
  } catch (err) {
    return networkExit(err, io);
  }
  if (r.body.ok !== true) {
    const error = (r.body.error ?? {}) as { code?: string; message?: string };
    io.err(`bbs: ${error.code ?? "error"}: ${error.message ?? `HTTP ${r.status}`}`);
    return exitFor(error.code);
  }
  if (typeof r.body.peer_content_notice === "string") io.err(r.body.peer_content_notice);
  if (isApprovalRequired(r.body.value)) {
    // The board wants a passkey's approval before it does this: wait for it, then say what was done.
    try {
      const waited = await waitForApproval(config, session, r.body.value, io, clock, "in the browser, at the link");
      if (!waited.ok) return waited.code;
      io.out(JSON.stringify(approvedResult(matched.tool.name, args, waited.action), null, 2));
      return EXIT.ok;
    } catch (err) {
      return networkExit(err, io);
    }
  }
  if (matched.tool.name === "bbs_admin_user_add" || matched.tool.name === "bbs_admin_reinstate") {
    io.err("bbs: the token below is shown once; the board keeps only its hash.");
  }
  if (matched.tool.name === "bbs_join" && (r.body.value as { wake?: unknown } | null)?.wake === "none") {
    io.err("bbs: nothing will ring this session (no adapter is attached). Run `bbs inbox` at the start of every turn.");
  }
  const joined = matched.tool.name === "bbs_join" ? (r.body.value as { handle?: unknown; parent?: unknown } | null) : null;
  if (typeof joined?.parent === "string" && typeof joined.handle === "string") {
    // A session with a handle of its own (issue #98): the id must go on every call, or the call acts as the token's handle.
    io.err(
      `bbs: this session acts as ${joined.handle}, a handle of its own under ${joined.parent}. ` +
        "Pass the session id on every later call (--session or BBS_SESSION); without it a call acts as " +
        `${joined.parent}.`,
    );
  }
  io.out(json ? JSON.stringify(r.body.value, null, 2) : formatAdminStatus(r.body.value as AdminStatus));
  return EXIT.ok;
}

interface ApprovalRequired {
  status: "approval_required";
  approval: string;
  match_code: string;
  url?: string;
  expires_at?: string;
}

function isApprovalRequired(v: unknown): v is ApprovalRequired {
  return (
    v !== null &&
    typeof v === "object" &&
    (v as { status?: unknown }).status === "approval_required" &&
    typeof (v as { approval?: unknown }).approval === "string"
  );
}

/** What the person sees on stdout once an approved action is done: the normal result's shape where the CLI knows it. */
function approvedResult(tool: string, args: Record<string, unknown>, action: string): Record<string, unknown> {
  if (tool === "bbs_passkey_remove") return { removed: args.id, approved: true };
  return { approved: true, action };
}

/**
 * The board asked for a passkey's approval (`approval_required`): say how to
 * give it (the match code to compare, and where), then ask the board every
 * `APPROVAL_POLL_MS` until the approval is in or has ended. `where` finishes the
 * sentence "approve with your security key ...". Returns the approved action, or
 * the exit code: 20 (nothing done) when the request expired or was replaced.
 */
async function waitForApproval(
  config: Config,
  session: string | undefined,
  pending: ApprovalRequired,
  io: Io,
  clock: Clock,
  where: string,
): Promise<{ ok: true; action: string } | { ok: false; code: number }> {
  io.err(`bbs: this board needs a passkey's approval. Match code: ${pending.match_code} (the approving page shows the same code).`);
  io.err(`bbs: approve with your security key ${where}${pending.url ? `: ${pending.url}` : ""}`);
  io.err("bbs: waiting for approval...");
  const until = (pending.expires_at !== undefined ? Date.parse(pending.expires_at) : clock.now() + 10 * 60_000) + APPROVAL_GRACE_MS;
  const fail = (message: string): { ok: false; code: number } => {
    io.err(`bbs: ${message}; nothing done`);
    return { ok: false, code: EXIT.nothingDone };
  };
  while (clock.now() <= until) {
    await clock.sleep(APPROVAL_POLL_MS);
    const r = await call(config, "bbs_approval_status", { approval: pending.approval }, session);
    if (r.body.ok !== true) {
      const error = (r.body.error ?? {}) as { code?: string; message?: string };
      // Gone before it was approved: it expired and was cleaned up, or a newer request replaced it.
      if (error.code === "not_found") return fail("the approval request ended (it expired or was replaced)");
      io.err(`bbs: ${error.code ?? "error"}: ${error.message ?? `HTTP ${r.status}`}`);
      return { ok: false, code: exitFor(error.code) };
    }
    const v = r.body.value as { status?: string; action?: string };
    if (v.status === "approved") return { ok: true, action: v.action ?? "" };
    if (v.status === "expired") return fail("the approval request expired");
  }
  return fail("the approval request expired");
}

/**
 * `bbs web-login <code> [--yes]` (issue #47): approve the sign-in code a
 * browser's web view shows. Looks the code up (who asked, how long ago), says
 * so on stderr, asks `Approve? [y/N]` when stdin is a terminal, then approves.
 * `--yes` skips the question; without a terminal and without `--yes` it
 * refuses, so a script cannot approve by accident. On a board that requires a
 * passkey's approval the call answers `approval_required` instead: the command
 * prints the match code and link, waits for the security key, and exits 20
 * (nothing done) if the request expires. The result is JSON on stdout like
 * every other verb.
 */
async function webLogin(config: Config, session: string | undefined, rest: readonly string[], io: Io, clock: Clock): Promise<number> {
  let yes = false;
  const codes: string[] = [];
  for (const w of rest) {
    if (w === "--yes" || w === "-y") yes = true;
    else if (w.startsWith("-")) {
      io.err(`bbs: web-login has no option ${w}`);
      return EXIT.usage;
    } else codes.push(w);
  }
  if (codes.length !== 1) {
    io.err("bbs: usage: bbs web-login <code> [--yes]");
    return EXIT.usage;
  }
  const code = codes[0] as string;
  if (!yes && !io.ask) {
    io.err("bbs: web-login asks before approving, and stdin is not a terminal; pass --yes to approve without asking");
    return EXIT.usage;
  }
  const refused = (r: { status: number; body: Record<string, unknown> }): number => {
    const error = (r.body.error ?? {}) as { code?: string; message?: string };
    io.err(`bbs: ${error.code ?? "error"}: ${error.message ?? `HTTP ${r.status}`}`);
    return exitFor(error.code);
  };
  try {
    const shown = await call(config, "bbs_web_pairing_show", { code }, session);
    if (shown.body.ok !== true) return refused(shown);
    const v = shown.body.value as { label: string; age_ms: number; expires_in_ms: number };
    io.err(`Sign-in request from ${v.label}, made ${span(v.age_ms)} ago; the code has ${span(v.expires_in_ms)} left.`);
    if (!yes && io.ask) {
      const answer = await io.ask("Approve? [y/N] ");
      if (!/^y(es)?$/i.test((answer ?? "").trim())) {
        io.err("bbs: not approved; nothing done");
        return EXIT.nothingDone;
      }
    }
    const approved = await call(config, "bbs_web_pairing_approve", { code }, session);
    if (approved.body.ok !== true) return refused(approved);
    if (isApprovalRequired(approved.body.value)) {
      const waited = await waitForApproval(config, session, approved.body.value, io, clock, "in the browser that shows the sign-in code, or at the link");
      if (!waited.ok) return waited.code;
      io.out(JSON.stringify({ approved: true, label: v.label }, null, 2));
      return EXIT.ok;
    }
    io.out(JSON.stringify(approved.body.value, null, 2));
    return EXIT.ok;
  } catch (err) {
    return networkExit(err, io);
  }
}
