// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Busy/idle from Claude Code hooks (I0; decided by orchestrator 2026-11-20):
 * `UserPromptSubmit` means busy, `Stop` and `StopFailure` mean idle. They fire
 * for channel-started turns too.
 *
 * Hooks are separate processes, so `bbs-adapter hook <event>` tells the
 * running adapter over a per-session local unix socket:
 *
 * - Directory: `$XDG_RUNTIME_DIR/bbs-5000`, else `<tmpdir>/bbs-5000-<uid>`,
 *   mode 0700, owned by the user (checked; a symlink or a directory owned by
 *   someone else is refused).
 * - Name: both the adapter (Claude Code's MCP server) and the hooks run
 *   under the same Claude Code session and both see its
 *   `CLAUDE_CODE_MESSAGING_SOCKET` (documented for hooks; seen in the MCP
 *   server's environment in I0). The socket is named by a hash of that value,
 *   never the value itself. When it is absent, the adapter also listens
 *   under its parent process id (Claude Code), and the hook walks up its own
 *   parents (at most four) to find it.
 * - Message: one JSON line `{"event":"Stop"}`. No secrets cross it; any
 *   process of the same user could already signal the adapter. A
 *   `UserPromptSubmit` line also says where the turn came from (B57):
 *   `"doorbells":["d_..."]` when the prompt is this adapter's channel event
 *   or inbox message (G4) for those doorbells, `"origin":"prompt"` when it is anything else (typed,
 *   a scheduled task, another session), and neither when the hook input
 *   could not be read. Never the prompt text itself.
 *
 * Two events also get an answer (issue #100): `SessionStart` (the paragraph the
 * model is told at the start) and `Stop` (the hand-back note instruction, when
 * the adapter decides to ask for one). For those the hook keeps its end of the
 * socket open after sending its line and reads one reply line,
 * `{"output":"<text>"}` or `{}`, which it prints. `PostToolBatch` sends
 * `{"event":"PostToolBatch","work":true|false}`, whether the batch used a tool
 * other than the board's own. See `hand-back.ts` and `session-start.ts`.
 *
 * Chosen over the alternatives: a hook cannot reach the adapter's stdio; a
 * hook calling the board directly would need the token in the hook's
 * environment or settings, which the brief forbids.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SessionState } from "./board-socket.ts";
import { inboxDoorbell } from "./inbox-socket.ts";
import type { StateSource } from "./ring.ts";

export const HOOK_EVENTS: Readonly<Record<string, SessionState>> = {
  UserPromptSubmit: "busy",
  Stop: "idle",
  StopFailure: "idle",
  // A `Notification` hook with matcher `idle_prompt` (Claude Code waiting for
  // input): a fallback for a turn the user interrupted, which fires no Stop
  // (hooks reference, read 2026-11-20).
  idle_prompt: "idle",
};

/**
 * Busy with no hook event for this long is reported idle (M2 independent
 * review M2): "Stop ... Does not run if the stoppage occurred due to a user
 * interrupt" (https://code.claude.com/docs/en/hooks, read 2026-11-20). The
 * board has its own, longer limit (`busyMaxMs`, 15 min).
 */
export const BUSY_MAX_MS = 10 * 60_000;

/** Where a `UserPromptSubmit` turn came from, from the hook's input (B57). */
export type PromptOrigin = { doorbells: string[] } | { origin: "prompt" };

/** At most this many doorbell ids are taken from one prompt. */
const MAX_PROMPT_DOORBELLS = 4;

/**
 * Read a `UserPromptSubmit` hook input (JSON on stdin) and say whether the
 * prompt is this adapter's channel event. The hooks reference
 * (https://code.claude.com/docs/en/hooks, read 2026-11-21) gives the input a
 * `prompt` field "containing the submitted text" and no field for its
 * source; a channel event arrives as `<channel source="..." ...>text</channel>`
 * (I0), with each `meta` entry as an attribute (channels reference, read
 * 2026-11-21). The adapter pushes `meta: { doorbell: <id> }`, so a prompt
 * holding a `<channel ...>` tag with `doorbell="<id>"` is that doorbell's
 * turn. A doorbell posted to the session's inbox socket (G4) arrives with
 * `prompt` exactly the message text, `BBS-5000: ... [bbs doorbell <id>]`
 * (`inboxDoorbell`), so a prompt that is, as a whole, such a line is that
 * doorbell's turn too. Returns undefined when the input has no readable prompt.
 */
export function promptOrigin(input: string): PromptOrigin | undefined {
  let prompt: unknown;
  try {
    prompt = (JSON.parse(input) as { prompt?: unknown }).prompt;
  } catch {
    return undefined;
  }
  if (typeof prompt !== "string") return undefined;
  const inbox = inboxDoorbell(prompt);
  if (inbox !== undefined) return { doorbells: [inbox] };
  const doorbells: string[] = [];
  // Bounded attribute runs keep the scan linear on a long typed prompt.
  for (const m of prompt.matchAll(/<channel\b[^>]{0,512}?\sdoorbell="(d_[A-Za-z0-9_-]{1,40})"[^>]{0,512}>/g)) {
    const id = m[1]!;
    if (!doorbells.includes(id)) doorbells.push(id);
    if (doorbells.length >= MAX_PROMPT_DOORBELLS) break;
  }
  return doorbells.length > 0 ? { doorbells } : { origin: "prompt" };
}

/** Events the hook command also sends that carry no busy/idle state. */
export const HOOK_EXTRA_EVENTS = ["SessionStart", "PostToolBatch"] as const;

/** What the adapter does for the events that need more than a state change (issue #100). */
export interface HookHandlers {
  /** A turn began (`UserPromptSubmit`). */
  turnStarted?(): void;
  /** A `PostToolBatch` that was work. */
  worked?(): void;
  /** `SessionStart` with its `source`: the text for the model, or undefined. */
  sessionStart?(source: unknown): Promise<string | undefined>;
  /** `Stop` with the input's `stop_hook_active`: the instruction that keeps the model going, or undefined to let it stop. */
  stop?(stopHookActive: boolean): Promise<string | undefined>;
}

/** The longest the adapter spends answering one hook, however its handler behaves. */
const ANSWER_MAX_MS = 8000;

export interface HookListenerOptions {
  handlers?: HookHandlers;
  busyMaxMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export function socketDir(env: NodeJS.ProcessEnv): string {
  if (env.BBS_ADAPTER_SOCKET_DIR) return env.BBS_ADAPTER_SOCKET_DIR;
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "bbs-5000");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(tmpdir(), `bbs-5000-${uid}`);
}

/** Create (or check) the socket directory: a real directory, ours, not readable by others. */
export function ensureSocketDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("hook socket directory is not a directory");
  const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
  if (st.uid !== uid) throw new Error("hook socket directory belongs to another user");
  if ((st.mode & 0o077) !== 0) throw new Error("hook socket directory is open to other users");
}

/** The socket name for a Claude Code session, from its messaging socket path (hashed). */
export function messagingKey(env: NodeJS.ProcessEnv): string | undefined {
  const v = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (!v) return undefined;
  return `m-${createHash("sha256").update(v, "utf8").digest("hex").slice(0, 16)}`;
}

export function pidKey(pid: number): string {
  return `p-${pid}`;
}

/** The adapter side: listens for hook events and is the adapter's busy/idle source. */
export class HookListener implements StateSource {
  #state: SessionState = "idle";
  readonly #listeners: ((s: SessionState) => void)[] = [];
  readonly #servers: Server[] = [];
  /** The names this listener published and the socket each points to (never a successor's). */
  readonly #paths: { link: string; real: string }[] = [];
  readonly #busyMaxMs: number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (t: unknown) => void;
  #busyTimer: unknown;
  #lastEventAt = 0;
  /** When a busy signal last arrived (ms), for confirming that a ring started a turn. */
  lastBusyAt = 0;
  /** When a busy signal whose origin is unknown (hook input unreadable) last arrived. */
  lastUnknownBusyAt = 0;
  /** When each recent doorbell's own channel turn started (B57), newest last. */
  readonly #doorbellTurns = new Map<string, number>();
  /** Whether any hook event has arrived (hooks are configured). */
  seen = false;
  readonly #log: (event: string, detail?: Record<string, unknown>) => void;
  readonly #now: () => number;
  readonly #handlers: HookHandlers;

  constructor(log: (event: string, detail?: Record<string, unknown>) => void, o: HookListenerOptions = {}) {
    this.#log = log;
    this.#now = o.now ?? Date.now;
    this.#handlers = o.handlers ?? {};
    this.#busyMaxMs = o.busyMaxMs ?? BUSY_MAX_MS;
    this.#setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
    this.#clearTimer = o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  current(): SessionState {
    return this.#state;
  }

  onChange(cb: (s: SessionState) => void): void {
    this.#listeners.push(cb);
  }

  /** When the turn started by doorbell `id`'s channel event began, if seen. */
  doorbellTurnAt(id: string): number | undefined {
    return this.#doorbellTurns.get(id);
  }

  /** Apply one hook event (also used by tests); `origin` for a busy event, when known. */
  event(name: string, origin?: PromptOrigin): void {
    const s = HOOK_EVENTS[name];
    if (s === undefined) return;
    this.seen = true;
    this.#lastEventAt = this.#now();
    if (s === "busy") {
      this.lastBusyAt = this.#lastEventAt;
      if (origin === undefined) this.lastUnknownBusyAt = this.#lastEventAt;
      else if ("doorbells" in origin) {
        for (const id of origin.doorbells) {
          this.#doorbellTurns.delete(id);
          this.#doorbellTurns.set(id, this.#lastEventAt);
        }
        while (this.#doorbellTurns.size > 32) {
          this.#doorbellTurns.delete(this.#doorbellTurns.keys().next().value!);
        }
      }
      this.#armBusyTimer(this.#busyMaxMs);
    } else if (this.#busyTimer !== undefined) {
      this.#clearTimer(this.#busyTimer);
      this.#busyTimer = undefined;
    }
    this.#set(s);
  }

  #set(s: SessionState): void {
    if (s === this.#state) return;
    this.#state = s;
    for (const cb of this.#listeners) cb(s);
  }

  #armBusyTimer(ms: number): void {
    if (this.#busyTimer !== undefined) this.#clearTimer(this.#busyTimer);
    this.#busyTimer = this.#setTimer(() => {
      this.#busyTimer = undefined;
      if (this.#state !== "busy") return;
      const quiet = this.#now() - this.#lastEventAt;
      if (quiet < this.#busyMaxMs) {
        this.#armBusyTimer(this.#busyMaxMs - quiet);
        return;
      }
      this.#log("busy_expired", { quiet_ms: quiet });
      this.#set("idle");
    }, ms);
  }

  /** Handle the lines one hook connection sent; the reply to write back, if any. Never throws. */
  async #serve(buf: string): Promise<{ output: string } | undefined> {
    let reply: { output: string } | undefined;
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line) as {
          event?: unknown;
          doorbells?: unknown;
          origin?: unknown;
          work?: unknown;
          source?: unknown;
          stop_hook_active?: unknown;
        };
        if (typeof m.event !== "string") continue;
        const origin = originOf(m);
        this.#log("hook", {
          event: m.event.slice(0, 32),
          ...(origin ? { origin: "doorbells" in origin ? "doorbell" : "prompt" } : {}),
        });
        if (m.event === "UserPromptSubmit") this.#handlers.turnStarted?.();
        if (m.event === "PostToolBatch") {
          if (m.work === true) this.#handlers.worked?.();
        } else if (m.event === "SessionStart") {
          const text = await this.#answer(() => this.#handlers.sessionStart?.(m.source));
          if (text !== undefined) reply = { output: text };
        } else if (m.event === "Stop") {
          const text = await this.#answer(() => this.#handlers.stop?.(m.stop_hook_active === true));
          if (text === undefined) {
            this.event("Stop");
          } else {
            // The model goes on with the hand-back note: still busy, not idle.
            this.event("UserPromptSubmit", { origin: "prompt" });
            reply = { output: text };
          }
        } else {
          this.event(m.event, origin);
        }
      } catch {
        // Ignore a bad line.
      }
    }
    return reply;
  }

  /** A handler's answer, or undefined when it has none, fails or takes too long. */
  async #answer(f: () => Promise<string | undefined> | undefined): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const limit = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ANSWER_MAX_MS);
      });
      return await Promise.race([Promise.resolve(f()), limit]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Listen for each key. The socket itself gets a name of its own
   * (`<key>-<random>.s`), and `<key>.sock` is a symlink to it, replaced
   * atomically. So a successor adapter for the same session takes the name
   * over, and this one's `close()` removes only its own socket and the link
   * only while it still points here (review m6). (Closing a Node server
   * unlinks its socket path, so the name must not be the socket.)
   * Returns the published names.
   */
  async listen(dir: string, keys: readonly string[]): Promise<string[]> {
    ensureSocketDir(dir);
    for (const key of keys) {
      const link = join(dir, `${key}.sock`);
      const real = join(dir, `${key}-${randomBytes(3).toString("hex")}.s`);
      // Half-open: the hook sends its line and ends its side, and the reply is written after that.
      const server = createServer({ allowHalfOpen: true }, (sock) => {
        let buf = "";
        sock.setEncoding("utf8");
        sock.setTimeout(2000, () => sock.destroy());
        sock.on("data", (chunk: string) => {
          buf += chunk;
          if (buf.length > 1024) sock.destroy();
        });
        sock.on("end", () => {
          // The hook has sent everything; what happens next (a board call) has its own limits.
          sock.setTimeout(0);
          void this.#serve(buf).then((reply) => {
            if (!sock.destroyed) sock.end(reply === undefined ? "" : `${JSON.stringify(reply)}\n`);
          });
        });
        sock.on("error", () => sock.destroy());
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(real, () => resolve());
      });
      this.#servers.push(server);
      const tmp = `${link}.${randomBytes(3).toString("hex")}`;
      symlinkSync(basename(real), tmp);
      renameSync(tmp, link);
      this.#paths.push({ link, real });
    }
    return this.#paths.map((p) => p.link);
  }

  close(): void {
    if (this.#busyTimer !== undefined) this.#clearTimer(this.#busyTimer);
    this.#busyTimer = undefined;
    for (const s of this.#servers) s.close();
    for (const p of this.#paths) {
      try {
        if (readlinkSync(p.link) === basename(p.real)) unlinkSync(p.link);
      } catch {
        // Gone, or not a link we made.
      }
      try {
        unlinkSync(p.real);
      } catch {
        // Closing the server removed it already.
      }
    }
  }
}

/** The origin carried by a hook line, checked; undefined when absent or malformed. */
function originOf(m: { doorbells?: unknown; origin?: unknown }): PromptOrigin | undefined {
  if (Array.isArray(m.doorbells)) {
    const ids = m.doorbells
      .filter((d): d is string => typeof d === "string" && /^d_[A-Za-z0-9_-]{1,40}$/.test(d))
      .slice(0, MAX_PROMPT_DOORBELLS);
    if (ids.length > 0) return { doorbells: ids };
  }
  if (m.origin === "prompt") return { origin: "prompt" };
  return undefined;
}

/** Parent process id of `pid`, from `ps` (macOS and Linux), or undefined. */
function parentOf(pid: number): number | undefined {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
    const n = Number(out.trim());
    return Number.isInteger(n) && n > 1 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Candidate socket names for a hook process, nearest first. */
export function hookKeys(env: NodeJS.ProcessEnv, ppid: number, parent: (pid: number) => number | undefined = parentOf): string[] {
  const keys: string[] = [];
  const m = messagingKey(env);
  if (m) keys.push(m);
  let pid: number | undefined = ppid;
  for (let i = 0; i < 4 && pid !== undefined && pid > 1; i++) {
    keys.push(pidKey(pid));
    pid = parent(pid);
  }
  return keys;
}

/** Whether a name is there at all (a dangling link counts: a dead adapter of this session). */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Send `line` to the adapter at `path`; with `reply`, also read the one line it answers with. */
function sendTo(path: string, line: string, timeoutMs: number): Promise<boolean>;
function sendTo(path: string, line: string, timeoutMs: number, reply: true): Promise<string | undefined>;
function sendTo(path: string, line: string, timeoutMs: number, reply?: true): Promise<boolean | string | undefined> {
  return new Promise((resolve) => {
    const sock = connect(path);
    let answer = "";
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(reply ? undefined : false);
    }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.end(line);
    });
    sock.on("data", (chunk: string) => {
      if (answer.length < 64 * 1024) answer += chunk;
    });
    sock.on("close", (hadError) => {
      clearTimeout(timer);
      resolve(reply ? (hadError ? undefined : answer) : !hadError);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(reply ? undefined : false);
    });
  });
}

/** The socket of this session's adapter: the nearest name that exists, never one past it (review m6). */
function findSocket(env: NodeJS.ProcessEnv, keys: readonly string[]): string | undefined {
  const dir = socketDir(env);
  for (const key of keys) {
    const path = join(dir, `${key}.sock`);
    if (present(path)) return path;
  }
  return undefined;
}

/**
 * The hook command: send `event` to this session's adapter. Never fails the
 * hook and never prints (a `UserPromptSubmit` hook's output would be added
 * to the model's context). `input` is the hook's stdin; for
 * `UserPromptSubmit` it says where the turn came from (`promptOrigin`, B57).
 * Returns whether an adapter took it.
 */
export async function runHook(
  event: string,
  env: NodeJS.ProcessEnv,
  ppid = process.ppid,
  parent: (pid: number) => number | undefined = parentOf,
  input?: string,
): Promise<boolean> {
  if (!(event in HOOK_EVENTS)) return false;
  const origin = event === "UserPromptSubmit" && input !== undefined ? promptOrigin(input) : undefined;
  const path = findSocket(env, hookKeys(env, ppid, parent));
  if (path === undefined) return false;
  return sendTo(path, `${JSON.stringify({ event, ...origin })}\n`, 1000);
}

/** Send a one-way line with these fields to this session's adapter (`PostToolBatch`); whether one took it. */
export async function notifyHook(
  event: string,
  fields: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  ppid = process.ppid,
  parent: (pid: number) => number | undefined = parentOf,
): Promise<boolean> {
  const path = findSocket(env, hookKeys(env, ppid, parent));
  if (path === undefined) return false;
  return sendTo(path, `${JSON.stringify({ event, ...fields })}\n`, 1000);
}

export interface AskOptions {
  /** How long to wait for the adapter's socket to appear (a `SessionStart` hook can run before the MCP server is listening). */
  waitMs?: number;
  /** How long to wait for the answer once connected. */
  answerMs?: number;
  ppid?: number;
  parent?: (pid: number) => number | undefined;
}

/**
 * The hooks that get an answer (`SessionStart`, `Stop`): send `event` with
 * `fields` and return the text the adapter wants printed, or undefined when
 * there is no adapter, it does not answer in time, or it has nothing to say.
 * Never throws.
 */
export async function askHook(
  event: string,
  fields: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  o: AskOptions = {},
): Promise<string | undefined> {
  try {
    const keys = hookKeys(env, o.ppid ?? process.ppid, o.parent ?? parentOf);
    const deadline = Date.now() + (o.waitMs ?? 0);
    let path = findSocket(env, keys);
    while (path === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      path = findSocket(env, keys);
    }
    if (path === undefined) return undefined;
    const raw = await sendTo(path, `${JSON.stringify({ event, ...fields })}\n`, o.answerMs ?? 10_000, true);
    if (raw === undefined) return undefined;
    const out = (JSON.parse(raw.split("\n")[0] ?? "") as { output?: unknown }).output;
    return typeof out === "string" && out !== "" ? out : undefined;
  } catch {
    return undefined;
  }
}
