// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * A scripted adapter for e2e tests: a WebSocket client that speaks the spec
 * §4.3 protocol by hand (hello, state, ring_result) and records what the
 * board sends. Stands in for a real adapter beside an agent; it never starts
 * a turn, it only says what an adapter would.
 */

import { sleep } from "./harness.ts";

export interface Frame {
  at: number;
  data: Record<string, unknown>;
}

export class ScriptedAdapter {
  readonly frames: Frame[] = [];
  closed: { code: number; reason: string } | undefined;
  #ws: WebSocket;
  #opened: Promise<void>;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    this.#opened = new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("socket error before open")), { once: true });
    });
    ws.addEventListener("message", (ev) => {
      try {
        this.frames.push({ at: Date.now(), data: JSON.parse(String(ev.data)) as Record<string, unknown> });
      } catch {
        this.frames.push({ at: Date.now(), data: { unparsed: String(ev.data) } });
      }
    });
    ws.addEventListener("close", (ev) => {
      this.closed = { code: ev.code, reason: ev.reason };
    });
  }

  /** Open `/ws` with a bearer token (Node's WebSocket takes headers). */
  static async connect(baseUrl: string, token: string): Promise<ScriptedAdapter> {
    const url = `${baseUrl.replace(/^http/, "ws")}/ws`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as never);
    const a = new ScriptedAdapter(ws);
    await a.#opened;
    return a;
  }

  send(msg: Record<string, unknown>): void {
    this.#ws.send(JSON.stringify(msg));
  }

  hello(session: string, state: "idle" | "busy" = "idle"): void {
    this.send({ type: "hello", session, harness: "scripted", machine: "workstation-1", state });
  }

  state(state: "idle" | "busy"): void {
    this.send({ type: "state", state });
  }

  doorbells(): { id: string; text: string; at: number }[] {
    return this.frames
      .filter((f) => f.data.type === "doorbell")
      .map((f) => ({ id: String(f.data.id), text: String(f.data.text), at: f.at }));
  }

  /** Wait for the n-th doorbell (1-based), up to `ms`; undefined on timeout. */
  async nthDoorbell(n: number, ms: number): Promise<{ id: string; text: string; at: number } | undefined> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const d = this.doorbells()[n - 1];
      if (d) return d;
      await sleep(50);
    }
    return this.doorbells()[n - 1];
  }

  async waitClosed(ms: number): Promise<{ code: number; reason: string } | undefined> {
    const deadline = Date.now() + ms;
    while (!this.closed && Date.now() < deadline) await sleep(50);
    return this.closed;
  }

  close(): void {
    this.#ws.close(1000, "done");
  }
}
