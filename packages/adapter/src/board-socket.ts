// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared board connection every adapter uses (design §7, §16): a
 * WebSocket to the board's `/ws` speaking spec §4.3, with reconnect and
 * backoff. Harness-specific code (the ring function) sits on top of it.
 *
 * - On open it sends `hello` with the session from `bbs_join` and the current
 *   busy/idle state (`hello.state`, a recorded addition to the spec).
 * - Board `doorbell` frames go to `onDoorbell`; `kicked` to `onKicked`.
 * - A close with 4001 (the session ended: another adapter or a `bbs_join`
 *   without this session replaced it) forgets the session and waits: one live
 *   session per agent token, so the newer adapter keeps the board. `resume()`
 *   (called when this adapter's model uses a tool, after a fresh join)
 *   attaches again (M2 independent review M1). Two adapters on one token
 *   therefore never fight over it on their own; whichever was used last
 *   holds it. A `kicked` frame, or a close with 4004 (the credential was
 *   revoked: kicked, or the token revoked or replaced; M4b), stops for good
 *   and logs why: reconnecting with that token can only be refused. A 4003 (refused) forgets the
 *   session so the next attempt joins again. Anything else reconnects with
 *   exponential backoff and jitter, reset after a connection that lasted.
 * - The token goes in the `Authorization` header only; it is never logged.
 */

export type SessionState = "idle" | "busy";
export type RingResult = "turn_started" | "held_busy" | "failed";

export interface Doorbell {
  id: string;
  text: string;
}

/** The part of a WebSocket the client uses (Node's global WebSocket fits). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", cb: () => void): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", cb: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

/** Node's global WebSocket, which accepts `{ headers }` as its second argument. */
export const nodeSocket: SocketFactory = (url, headers) =>
  new WebSocket(url, { headers } as never) as unknown as SocketLike;

/** Close codes from the board (packages/worker/src/ws-protocol.ts). */
export const CLOSE_SESSION_ENDED = 4001;
export const CLOSE_REFUSED = 4003;
export const CLOSE_CREDENTIAL_REVOKED = 4004;

/**
 * Thrown by `ensureSession` or `probeCredential` when the board refuses the
 * token as revoked (401 `revoked_token`: kicked, or replaced). Terminal: the
 * socket stops and logs `credential_revoked` instead of retrying (M4b
 * review m4).
 */
export class CredentialRevokedError extends Error {
  constructor(message = "the board refused this token as revoked") {
    super(message);
    this.name = "CredentialRevokedError";
  }
}

const OPEN = 1;

export interface BoardSocketOptions {
  /** Board base URL, `http://...` or `https://...`. */
  url: string;
  token: string;
  /** The board session (from `bbs_join`), or undefined until there is one. */
  session(): string | undefined;
  /** Called before each connect when there is no session yet; should join. Throws `CredentialRevokedError` on a revoked token. */
  ensureSession(): Promise<void>;
  /**
   * Called when a connection closed before it opened (a refused upgrade looks
   * like any other failure to the socket): throws `CredentialRevokedError`
   * when the token is revoked, so the adapter stops instead of retrying.
   */
  probeCredential?(): Promise<void>;
  /** The board refused the session (close 4003, e.g. unknown after a board reset): forget it so the next connect joins again. */
  resetSession(): void;
  harness: string;
  machine?: string | undefined;
  /** The harness's state now, sent in `hello`. */
  state(): SessionState;
  onDoorbell(d: Doorbell): void;
  onAttached?(): void;
  onStopped?(why: string): void;
  log(event: string, detail?: Record<string, unknown>): void;
  connect?: SocketFactory;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** A connection that stayed up this long resets the backoff. */
  stableMs?: number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
}

export class BoardSocket {
  readonly #o: Required<
    Pick<BoardSocketOptions, "initialBackoffMs" | "maxBackoffMs" | "stableMs" | "random" | "setTimer" | "clearTimer" | "now" | "connect">
  > &
    BoardSocketOptions;
  #ws: SocketLike | undefined;
  #attempt = 0;
  #openedAt = 0;
  #timer: unknown;
  #stopped = false;
  #stopReason: string | undefined;
  /** Closed with 4001: waiting for `resume()`. */
  #replaced = false;

  constructor(o: BoardSocketOptions) {
    this.#o = {
      initialBackoffMs: 1_000,
      maxBackoffMs: 30_000,
      stableMs: 60_000,
      random: Math.random,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      now: Date.now,
      connect: nodeSocket,
      ...o,
    };
  }

  get stopped(): string | undefined {
    return this.#stopReason;
  }

  /** Whether the board closed this adapter's session for a newer one (4001) and it waits for `resume()`. */
  get replaced(): boolean {
    return this.#replaced;
  }

  /** After a 4001: attach again (the caller has joined, or the next connect joins). */
  resume(): void {
    if (this.#stopped || !this.#replaced) return;
    this.#replaced = false;
    this.#attempt = 0;
    this.#o.log("resumed");
    void this.#connect();
  }

  get connected(): boolean {
    return this.#ws?.readyState === OPEN;
  }

  start(): void {
    void this.#connect();
  }

  stop(reason = "stopped"): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#stopReason = reason;
    if (this.#timer !== undefined) this.#o.clearTimer(this.#timer);
    try {
      this.#ws?.close(1000, "adapter stopping");
    } catch {
      // Already closed.
    }
    this.#o.onStopped?.(reason);
  }

  /** Tell the board busy/idle; dropped while disconnected (`hello` carries it on reconnect). */
  sendState(state: SessionState): void {
    this.#send({ type: "state", state });
  }

  sendRingResult(id: string, result: RingResult, confirmed?: boolean): void {
    this.#send({ type: "ring_result", id, result, ...(confirmed !== undefined ? { confirmed } : {}) });
  }

  #send(msg: Record<string, unknown>): void {
    if (this.#ws?.readyState !== OPEN) return;
    try {
      this.#ws.send(JSON.stringify(msg));
    } catch (err) {
      this.#o.log("send_failed", { type: msg.type, error: err instanceof Error ? err.name : "error" });
    }
  }

  #schedule(): void {
    if (this.#stopped) return;
    const base = Math.min(this.#o.maxBackoffMs, this.#o.initialBackoffMs * 2 ** this.#attempt);
    const delay = Math.round(base * (0.5 + this.#o.random() / 2));
    this.#attempt += 1;
    this.#o.log("reconnect_scheduled", { delay_ms: delay, attempt: this.#attempt });
    this.#timer = this.#o.setTimer(() => {
      this.#timer = undefined;
      void this.#connect();
    }, delay);
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    try {
      if (this.#o.session() === undefined) await this.#o.ensureSession();
    } catch (err) {
      if (err instanceof CredentialRevokedError) {
        this.#revoked(err.message);
        return;
      }
      this.#o.log("join_failed", { error: err instanceof Error ? err.message.slice(0, 200) : "error" });
      this.#schedule();
      return;
    }
    const session = this.#o.session();
    if (session === undefined) {
      this.#schedule();
      return;
    }
    const wsUrl = `${this.#o.url.replace(/^http/, "ws").replace(/\/+$/, "")}/ws`;
    let ws: SocketLike;
    try {
      ws = this.#o.connect(wsUrl, { authorization: `Bearer ${this.#o.token}` });
    } catch (err) {
      this.#o.log("connect_failed", { error: err instanceof Error ? err.name : "error" });
      this.#schedule();
      return;
    }
    this.#ws = ws;
    let closed = false;
    let opened = false;
    ws.addEventListener("open", () => {
      opened = true;
      this.#openedAt = this.#o.now();
      ws.send(
        JSON.stringify({
          type: "hello",
          session,
          harness: this.#o.harness,
          ...(this.#o.machine ? { machine: this.#o.machine } : {}),
          state: this.#o.state(),
        }),
      );
      this.#o.log("attached", { session_set: true });
      this.#o.onAttached?.();
    });
    ws.addEventListener("message", (ev) => this.#onMessage(String(ev.data)));
    const onGone = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      if (this.#ws === ws) this.#ws = undefined;
      const lasted = this.#openedAt > 0 ? this.#o.now() - this.#openedAt : 0;
      this.#openedAt = 0;
      this.#o.log("closed", { code, reason: reason.slice(0, 120), lasted_ms: lasted });
      if (this.#stopped) return;
      if (code === CLOSE_CREDENTIAL_REVOKED) {
        // Not reconnecting: the board refuses this token from now on.
        this.#o.log("credential_revoked", { reason: reason.slice(0, 120) });
        this.stop(reason.startsWith("kicked") ? "kicked" : "credential revoked");
        return;
      }
      if (code === CLOSE_SESSION_ENDED) {
        if (this.#o.session() === session) {
          this.#o.resetSession();
          this.#replaced = true;
          this.#o.log("replaced");
          return;
        }
        // Already joined again (a tool call raced the close): attach with it.
        this.#attempt = 0;
        void this.#connect();
        return;
      }
      if (code === CLOSE_REFUSED) this.#o.resetSession();
      if (lasted >= this.#o.stableMs) this.#attempt = 0;
      if (!opened && this.#o.probeCredential) {
        // Never opened: maybe the upgrade was refused. Ask once whether the
        // token is revoked before retrying.
        this.#o.probeCredential().then(
          () => this.#schedule(),
          (err: unknown) => {
            if (err instanceof CredentialRevokedError) this.#revoked(err.message);
            else this.#schedule();
          },
        );
        return;
      }
      this.#schedule();
    };
    ws.addEventListener("close", (ev) => onGone(ev.code, ev.reason ?? ""));
    ws.addEventListener("error", () => {
      // A failed upgrade (401, 403) arrives as an error and then a close.
      this.#o.log("socket_error");
    });
  }

  /** The token was refused as revoked: stop for good and log why. */
  #revoked(reason: string): void {
    this.#o.log("credential_revoked", { reason: reason.slice(0, 120) });
    this.stop("credential revoked");
  }

  #onMessage(raw: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.#o.log("bad_frame");
      return;
    }
    if (m.type === "doorbell" && typeof m.id === "string" && typeof m.text === "string") {
      this.#o.log("doorbell", { id: m.id });
      this.#o.onDoorbell({ id: m.id, text: m.text });
    } else if (m.type === "kicked") {
      this.#o.log("kicked");
      this.stop("kicked");
    } else {
      this.#o.log("unknown_frame", { type: typeof m.type === "string" ? m.type.slice(0, 32) : null });
    }
  }
}
