// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * A small client for the Codex app-server (G3): JSON-RPC over a WebSocket on
 * the app-server's unix socket. Each JSON-RPC message is one WebSocket text
 * frame (app-server docs, read 2026-11-21; plain JSON lines on that socket
 * get no reply). It initializes, then sends requests and passes
 * notifications on. It reconnects with backoff when the socket closes.
 *
 * Requests the server sends to a client (approvals, elicitations) are not
 * expected, since this client never subscribes to a thread. Any that arrive
 * are logged and left unanswered: another client (the TUI) may hold the same
 * request, and the first answer settles it, so an error from here could
 * decide a person's approval.
 */

import WebSocket from "ws";

/** The part of a WebSocket the client uses (the `ws` package's fits). */
export interface AppSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(ev: "open", cb: () => void): unknown;
  on(ev: "message", cb: (data: unknown) => void): unknown;
  on(ev: "close", cb: () => void): unknown;
  on(ev: "error", cb: (err: Error) => void): unknown;
}

export type AppSocketFactory = (socketPath: string) => AppSocketLike;

/** A WebSocket over a unix socket, with the `ws` package (`ws+unix://<path>:/`). */
export const unixWebSocket: AppSocketFactory = (socketPath) =>
  new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: 5_000, maxPayload: 16 * 1024 * 1024 }) as unknown as AppSocketLike;

/** What the Codex ring needs from an app-server connection (a fake in tests). */
export interface AppServerLike {
  readonly ready: boolean;
  request(method: string, params: unknown): Promise<unknown>;
  onReady(cb: () => void): void;
  onNotification(cb: (method: string, params: unknown) => void): void;
  onClose(cb: () => void): void;
}

/** A JSON-RPC error answer from the app-server. */
export class AppServerError extends Error {
  readonly code: number | undefined;
  constructor(method: string, code: number | undefined, message: string) {
    super(`${method}: ${message}`);
    this.name = "AppServerError";
    this.code = code;
  }
}

export interface AppServerClientOptions {
  /** Path of the app-server's unix socket. */
  socketPath: string;
  log(event: string, detail?: Record<string, unknown>): void;
  /** Reported to the app-server in `initialize`. */
  clientVersion: string;
  connect?: AppSocketFactory;
  requestTimeoutMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

const OPEN = 1;

interface Pending {
  method: string;
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: unknown;
}

export class AppServerClient implements AppServerLike {
  readonly #o: Required<Omit<AppServerClientOptions, "log">> & Pick<AppServerClientOptions, "log">;
  #ws: AppSocketLike | undefined;
  #ready = false;
  #stopped = false;
  #nextId = 1;
  #attempt = 0;
  #timer: unknown;
  readonly #pending = new Map<number, Pending>();
  readonly #onReady: (() => void)[] = [];
  readonly #onNotification: ((method: string, params: unknown) => void)[] = [];
  readonly #onClose: (() => void)[] = [];

  constructor(o: AppServerClientOptions) {
    this.#o = {
      connect: unixWebSocket,
      requestTimeoutMs: 10_000,
      initialBackoffMs: 1_000,
      maxBackoffMs: 30_000,
      setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...o,
    };
  }

  get ready(): boolean {
    return this.#ready;
  }

  onReady(cb: () => void): void {
    this.#onReady.push(cb);
  }

  onNotification(cb: (method: string, params: unknown) => void): void {
    this.#onNotification.push(cb);
  }

  onClose(cb: () => void): void {
    this.#onClose.push(cb);
  }

  start(): void {
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) this.#o.clearTimer(this.#timer);
    this.#timer = undefined;
    try {
      this.#ws?.close();
    } catch {
      // Already closed.
    }
  }

  /** Send a request once initialized; rejects on an error answer, a timeout or a closed socket. */
  request(method: string, params: unknown): Promise<unknown> {
    if (!this.#ready) return Promise.reject(new AppServerError(method, undefined, "app-server not connected"));
    return this.#send(method, params);
  }

  #send(method: string, params: unknown): Promise<unknown> {
    const ws = this.#ws;
    if (ws?.readyState !== OPEN) return Promise.reject(new AppServerError(method, undefined, "app-server not connected"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = this.#o.setTimer(() => {
        this.#pending.delete(id);
        reject(new AppServerError(method, undefined, "timed out"));
      }, this.#o.requestTimeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (err) {
        this.#o.clearTimer(timer);
        this.#pending.delete(id);
        reject(new AppServerError(method, undefined, err instanceof Error ? err.message : "send failed"));
      }
    });
  }

  #connect(): void {
    if (this.#stopped) return;
    let ws: AppSocketLike;
    try {
      ws = this.#o.connect(this.#o.socketPath);
    } catch (err) {
      this.#o.log("app_server_error", { error: err instanceof Error ? err.message.slice(0, 120) : "error" });
      this.#schedule();
      return;
    }
    this.#ws = ws;
    ws.on("open", () => {
      void this.#initialize(ws);
    });
    ws.on("message", (data) => this.#onMessage(ws, data));
    ws.on("error", (err) => {
      this.#o.log("app_server_error", { error: err.message.slice(0, 120) });
    });
    ws.on("close", () => {
      if (this.#ws !== ws) return;
      this.#ws = undefined;
      const wasReady = this.#ready;
      this.#ready = false;
      for (const [id, p] of this.#pending) {
        this.#o.clearTimer(p.timer);
        p.reject(new AppServerError(p.method, undefined, "app-server connection closed"));
        this.#pending.delete(id);
      }
      if (wasReady) {
        this.#o.log("app_server_closed");
        for (const cb of this.#onClose) cb();
      }
      this.#schedule();
    });
  }

  async #initialize(ws: AppSocketLike): Promise<void> {
    try {
      await this.#send("initialize", {
        clientInfo: { name: "bbs-adapter", title: "BBS-5000 adapter", version: this.#o.clientVersion },
        capabilities: { experimentalApi: true },
      });
      if (this.#ws !== ws) return;
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
      this.#ready = true;
      this.#attempt = 0;
      this.#o.log("app_server_ready");
      for (const cb of this.#onReady) cb();
    } catch (err) {
      this.#o.log("app_server_error", { error: err instanceof Error ? err.message.slice(0, 120) : "error" });
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
  }

  #onMessage(ws: AppSocketLike, data: unknown): void {
    let m: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    try {
      m = JSON.parse(String(data)) as typeof m;
    } catch {
      return;
    }
    if (typeof m !== "object" || m === null) return;
    if (typeof m.method === "string") {
      if (m.id !== undefined) {
        // A request from the server: not expected, never answered (see the file comment).
        this.#o.log("app_server_request_ignored", { method: m.method.slice(0, 80) });
        return;
      }
      for (const cb of this.#onNotification) {
        try {
          cb(m.method, m.params);
        } catch {
          // A listener's failure must not stop the others.
        }
      }
      return;
    }
    if (typeof m.id !== "number") return;
    const p = this.#pending.get(m.id);
    if (!p) return;
    this.#pending.delete(m.id);
    this.#o.clearTimer(p.timer);
    if (m.error !== undefined) {
      const code = typeof m.error?.code === "number" ? m.error.code : undefined;
      const message = typeof m.error?.message === "string" ? m.error.message.slice(0, 200) : "error";
      p.reject(new AppServerError(p.method, code, message));
    } else {
      p.resolve(m.result);
    }
  }

  #schedule(): void {
    if (this.#stopped || this.#timer !== undefined) return;
    const delay = Math.min(this.#o.maxBackoffMs, this.#o.initialBackoffMs * 2 ** this.#attempt);
    this.#attempt += 1;
    this.#timer = this.#o.setTimer(() => {
      this.#timer = undefined;
      this.#connect();
    }, delay);
  }
}
