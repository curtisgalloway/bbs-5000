// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared adapter: one board socket, one ring function, one busy/idle
 * source. Hold while busy (decided by orchestrator, 2026-11-20): a doorbell
 * that arrives while the session is busy is not rung; the adapter answers
 * `held_busy` and the board rings it again when the adapter reports idle.
 */

import { BoardSocket, type BoardSocketOptions, type Doorbell } from "./board-socket.ts";
import type { RingFunction, StateSource } from "./ring.ts";

export interface AdapterOptions extends Omit<BoardSocketOptions, "onDoorbell" | "state" | "harness"> {
  ring: RingFunction;
  state: StateSource;
}

export class Adapter {
  readonly socket: BoardSocket;
  readonly #ring: RingFunction;
  readonly #state: StateSource;
  readonly #log: BoardSocketOptions["log"];
  /** Doorbell ids being rung now; a repeat while ringing is ignored. */
  readonly #ringing = new Set<string>();
  /** An idle report held back until the ring in progress has its `ring_result` sent. */
  #idleHeld = false;

  constructor(o: AdapterOptions) {
    this.#ring = o.ring;
    this.#state = o.state;
    this.#log = o.log;
    this.socket = new BoardSocket({
      ...o,
      harness: o.ring.harness,
      state: () => o.state.current(),
      onDoorbell: (d) => void this.#onDoorbell(d),
    });
    o.state.onChange((s) => {
      this.#log("state", { state: s });
      // An idle report must not overtake the ring_result of the turn it ends
      // (B57): the board re-rings a delivered doorbell at idle, so idle has to
      // arrive after the doorbell is acknowledged. Busy goes at once.
      if (s === "idle" && this.#ringing.size > 0) {
        this.#idleHeld = true;
        return;
      }
      this.#idleHeld = false;
      this.socket.sendState(s);
    });
  }

  start(): void {
    this.socket.start();
  }

  /** After the board replaced this adapter's session (4001): attach again. */
  resume(): void {
    this.socket.resume();
  }

  stop(reason?: string): void {
    this.socket.stop(reason);
  }

  async #onDoorbell(d: Doorbell): Promise<void> {
    if (this.#ringing.has(d.id)) return;
    if (this.#state.current() === "busy") {
      this.#log("ring", { id: d.id, result: "held_busy" });
      this.socket.sendRingResult(d.id, "held_busy");
      return;
    }
    this.#ringing.add(d.id);
    try {
      const out = await this.#ring.ring(d);
      this.#log("ring", { id: d.id, result: out.result, confirmed: out.confirmed ?? null, ...(out.via ? { via: out.via } : {}) });
      this.socket.sendRingResult(d.id, out.result, out.confirmed);
    } catch (err) {
      this.#log("ring", { id: d.id, result: "failed", error: err instanceof Error ? err.name : "error" });
      this.socket.sendRingResult(d.id, "failed");
    } finally {
      this.#ringing.delete(d.id);
      if (this.#ringing.size === 0 && this.#idleHeld) {
        this.#idleHeld = false;
        if (this.#state.current() === "idle") this.socket.sendState("idle");
      }
    }
  }
}
