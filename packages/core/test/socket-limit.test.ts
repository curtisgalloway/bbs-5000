// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * B45: the per-session rate limit on adapter `state` and `ring_result`
 * messages. Over the limit a message is refused and not applied; the first
 * refusal in a window gets one `socket_rate_limited` row and the rest are
 * written as one `socket_rate_suppressed` row when the window ends.
 */

import { describe, expect, it } from "vitest";
import type { ActResult, BoardConfig, CallContext } from "../src/types.ts";
import { DEFAULT_CONFIG, validateConfig } from "../src/types.ts";
import { makeBoard, type Fixture } from "./helpers.ts";

function ok<T>(r: ActResult<T>): Extract<ActResult<T>, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
}

interface World extends Fixture {
  ws(handle?: string): CallContext;
  count(action: string): number;
}

function world(config: Partial<BoardConfig> = {}): World {
  const f = makeBoard({ config: { socketMessageLimit: 3, socketMessageWindowMs: 60_000, ...config } });
  const sessions = new Map<string, string>();
  for (const handle of ["a", "b"]) {
    f.addUser(handle);
    sessions.set(handle, ok(f.board.act<{ session: string }>(f.ctx(handle), "join", {})).value.session);
    const ctx = { handle, via: "ws" as const, session: sessions.get(handle) };
    ok(f.board.socketAct({ handle, via: "ws" }, "socket_open", {}));
    ok(f.board.socketAct(ctx, "socket_hello", { harness: "claude-code", state: "idle" }));
  }
  // The setup hellos counted too; start the tests in a fresh window.
  f.clock.advance(config.socketMessageWindowMs ?? 60_000);
  return {
    ...f,
    ws: (handle = "a") => ({ handle, via: "ws", session: sessions.get(handle) }),
    count: (action) =>
      f.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE action = ?", action)?.n ?? 0,
  };
}

const state = (w: World, s: "idle" | "busy", handle = "a"): ActResult =>
  w.board.socketAct(w.ws(handle), "session_state", { state: s });

describe("adapter socket message limit (B45)", () => {
  it("audits messages up to the limit, then refuses with one row and counts the rest", () => {
    const w = world();
    const before = w.count("session_state");
    const results = ["busy", "idle", "busy", "idle", "busy", "idle"].map((s) => state(w, s as "idle" | "busy"));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false, false, false]);
    expect(w.count("session_state") - before).toBe(3);
    expect(w.count("socket_rate_limited")).toBe(1);
    expect(results[3]).toMatchObject({ ok: false, error: { code: "rate_limited" }, result: "denied", auditSeq: expect.any(Number) });
    expect(results[4]).toMatchObject({ ok: false, error: { code: "rate_limited" }, auditSeq: undefined });
    // A refused message is not applied: the session is still busy from the last accepted one.
    expect(w.sql.one("SELECT state FROM sessions WHERE handle = 'a'")).toEqual({ state: "busy" });
    // Counted, written once when the window ends (at the next socket call or alarm).
    expect(w.count("socket_rate_suppressed")).toBe(0);
    w.clock.advance(60_000);
    w.board.flushAuthWindows();
    const rows = w.sql.all<{ actor: string; detail: string }>(
      "SELECT actor, detail FROM audit WHERE action = 'socket_rate_suppressed'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("system");
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({ handle: "a", suppressed: { session_state: 2 }, total: 2 });
    w.board.flushAuthWindows();
    expect(w.count("socket_rate_suppressed")).toBe(1);
  });

  it("counts state and ring_result together, and leaves close and other sessions alone", () => {
    const w = world();
    ok(state(w, "busy"));
    ok(w.board.socketAct(w.ws(), "ring_result", { id: "none", result: "turn_started" }));
    ok(state(w, "idle"));
    expect(w.board.socketAct(w.ws(), "ring_result", { id: "none", result: "failed" })).toMatchObject({ ok: false });
    expect(w.count("socket_rate_limited")).toBe(1);
    // Another session has its own window; hello shares the count (refused here), close is not limited.
    ok(state(w, "busy", "b"));
    expect(w.board.socketAct(w.ws(), "socket_hello", { harness: "claude-code", state: "idle" })).toMatchObject({ ok: false });
    ok(w.board.socketAct(w.ws(), "socket_close", { session: w.ws().session, code: 1000, still_open: false }));
  });

  it("counts hello in the same window, so hellos past the limit are refused with bounded rows", () => {
    const w = world();
    const rowsBefore = w.auditRows().length;
    const hello = (): ActResult => w.board.socketAct(w.ws(), "socket_hello", { harness: "claude-code", state: "idle" });
    const results = Array.from({ length: 10 }, hello);
    const accepted = results.filter((r) => r.ok).length;
    expect(accepted).toBe(3);
    expect(results.at(-1)).toMatchObject({ ok: false, error: { code: "rate_limited" }, auditSeq: undefined });
    expect(w.count("socket_rate_limited")).toBe(1);
    // Rows: three hellos accepted plus one refusal, not ten.
    expect(w.auditRows().length - rowsBefore).toBe(4);
    // After the window the resync works again, and the summary is written once.
    w.clock.advance(60_000);
    expect(hello().ok).toBe(true);
    expect(w.count("socket_rate_suppressed")).toBe(1);
  });

  it("starts a fresh window when the old one ends, writing the old one's summary", () => {
    const w = world();
    for (let i = 0; i < 5; i++) state(w, i % 2 ? "idle" : "busy");
    w.clock.advance(60_000);
    expect(state(w, "busy").ok).toBe(true);
    expect(w.count("socket_rate_suppressed")).toBe(1);
  });

  it("keeps the window map bounded by writing out the oldest windows early", () => {
    const w = world({ socketMessageLimit: 1, socketMessageWindowMs: 3_600_000 });
    state(w, "busy");
    state(w, "idle");
    state(w, "busy");
    expect(w.count("socket_rate_suppressed")).toBe(0);
    for (let i = 0; i < 1_000; i++) {
      // Unknown sessions: the call itself is refused, but its window is still kept.
      w.board.socketAct({ handle: `u${i}`, via: "ws", session: `s${i}` }, "session_state", { state: "busy" });
    }
    const early = w.sql.all<{ detail: string }>("SELECT detail FROM audit WHERE action = 'socket_rate_suppressed'");
    expect(early.map((r) => JSON.parse(r.detail))).toEqual([expect.objectContaining({ handle: "a", total: 1, early: true })]);
  });

  it("has defaults that validate", () => {
    expect(DEFAULT_CONFIG.socketMessageLimit).toBe(60);
    expect(validateConfig({ ...DEFAULT_CONFIG, socketMessageLimit: 0 })).toMatch(/socketMessageLimit/);
    expect(validateConfig({ ...DEFAULT_CONFIG, authFailureBoardLimit: 0 })).toMatch(/authFailureBoardLimit/);
  });
});
