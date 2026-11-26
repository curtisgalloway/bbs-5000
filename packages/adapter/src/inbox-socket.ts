// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The Claude ring's preferred path (G4, design D10): post the doorbell to the
 * session's own inbox socket, the one Claude Code's cross-session messaging
 * binds for every session (https://code.claude.com/docs/en/cross-session-messaging,
 * read 2026-11-21, "The session's inbox socket"). An idle session starts a
 * turn with the message; no development-channels flag is needed.
 *
 * Claude Code passes `CLAUDE_CODE_MESSAGING_SOCKET` (a unix socket path) and
 * `CLAUDE_CODE_MESSAGING_TOKEN` to the MCP servers it starts (G4 spike,
 * Claude Code 2.1.330). Protocol (that page): newline-delimited JSON, first
 * `{"type":"auth","token":"<token>"}` (optional on macOS and Linux, required on
 * native Windows; always sent), then
 * `{"type":"user","message":{"role":"user","content":"<text>"}}`. Claude Code
 * sends nothing back. Open the connection only when the line is ready (it
 * closes one with no complete line within 30 s).
 *
 * The page does not call the socket a stable public API; when it is missing
 * or refuses, the Claude ring falls back to the channel (`claude-ring.ts`).
 *
 * The doorbell id rides in the text as a trailing marker,
 * `[bbs doorbell d_<id>]` (or `[bbs doorbell d_<id> <n>]` for the n-th ring of
 * the same doorbell, so a repeat is never an identical message, which Claude
 * Code drops within a short window). The `UserPromptSubmit` hook's `prompt`
 * is exactly the message text, so the hook reads the id from the marker
 * (`inboxDoorbell`) to confirm the ring (B57).
 */

import { connect } from "node:net";

/** Where this session's inbox is, from the environment Claude Code gives its MCP servers. */
export interface InboxTarget {
  socketPath: string;
  token: string;
}

/** The inbox target when both variables are set (non-empty), else undefined. */
export function inboxTarget(env: NodeJS.ProcessEnv): InboxTarget | undefined {
  const socketPath = env.CLAUDE_CODE_MESSAGING_SOCKET?.trim();
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN?.trim();
  if (!socketPath || !token) return undefined;
  return { socketPath, token };
}

/**
 * The inbox target the Claude ring should use: `inboxTarget(env)`, unless
 * `BBS_CLAUDE_RING=channel` asks for the channel only (for a session whose
 * `crossSessionInbound` holds or refuses messages but has the channel loaded).
 */
export function claudeInbox(env: NodeJS.ProcessEnv): InboxTarget | undefined {
  return env.BBS_CLAUDE_RING?.trim() === "channel" ? undefined : inboxTarget(env);
}

/** The doorbell text the inbox gets: the board's line plus the id marker. */
export function inboxText(text: string, id: string, attempt = 1): string {
  return `${text} [bbs doorbell ${id}${attempt > 1 ? ` ${attempt}` : ""}]`;
}

/** An inbox doorbell is one line, starts like the board's doorbell and is short. */
const MAX_INBOX_PROMPT = 1024;
const MARKER = / \[bbs doorbell (d_[A-Za-z0-9_-]{1,40})(?: [0-9]{1,4})?\]$/;

/**
 * The doorbell id when `prompt` is, as a whole, an inbox doorbell: one line
 * starting `BBS-5000: ` and ending with the marker. Anything else (a typed
 * prompt that mentions a marker, a longer message quoting one) is not.
 */
export function inboxDoorbell(prompt: string): string | undefined {
  const p = prompt.trim();
  if (p.length > MAX_INBOX_PROMPT || !p.startsWith("BBS-5000: ") || /[\r\n]/.test(p)) return undefined;
  return MARKER.exec(p)?.[1];
}

export interface PostOptions {
  /** Give up on connect or write after this long (ms). */
  timeoutMs?: number;
  /** After the lines are written, wait this long for an error before closing (ms). */
  lingerMs?: number;
}

/**
 * Post one user message to the inbox: connect, write the auth line and the
 * user line, wait `lingerMs` (or until the other side closes), close.
 * Resolves once written; rejects on a connect or write error, a close by the
 * other side before the lines were flushed, or a timeout. Claude Code acknowledges
 * nothing, so "written" is all this can know; whether a turn started is
 * judged by the hooks, as for the channel.
 */
export function postToInbox(target: InboxTarget, text: string, o: PostOptions = {}): Promise<void> {
  const timeoutMs = o.timeoutMs ?? 3000;
  const lingerMs = o.lingerMs ?? 250;
  const data =
    `${JSON.stringify({ type: "auth", token: target.token })}\n` +
    `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let written = false;
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) {
        sock.destroy();
        reject(err);
      } else {
        sock.end();
        resolve();
      }
    };
    const timer = setTimeout(() => finish(new InboxError("timeout")), timeoutMs);
    const sock = connect(target.socketPath);
    sock.on("connect", () => {
      sock.write(data, (err) => {
        if (err) return finish(new InboxError("write"));
        written = true;
        setTimeout(() => finish(), lingerMs);
      });
    });
    // An error once the lines are flushed (the other side closed first) is
    // not a failure: the message was handed over, and falling back to the
    // channel then could deliver the doorbell twice.
    sock.on("error", (err: NodeJS.ErrnoException) => finish(written ? undefined : new InboxError(err.code ?? "error")));
    sock.on("close", () => {
      if (written) finish();
      else finish(new InboxError("closed"));
    });
    // Nothing is expected back; read and drop anything that comes.
    sock.on("data", () => undefined);
  });
}

/** An inbox post that failed; `code` is a short reason (an errno code, `timeout`, `closed`). Never the path or token. */
export class InboxError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`inbox post failed: ${code}`);
    this.name = "InboxError";
    this.code = code;
  }
}
