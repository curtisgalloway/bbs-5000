// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #104: a truncated `bbs_inbox` read must not leave the unread rest
 * without a ring. It leaves a pending doorbell with a short timer
 * (`inboxTruncatedRingMs`) when wake items remain; a rest of digest items is
 * not rung early; a read that returns everything clears the bell.
 */

import { describe, expect, it } from "vitest";
import type { ActResult, CallContext, RingNotification } from "../src/types.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { makeBoard } from "./helpers.ts";

const DEBOUNCE = DEFAULT_CONFIG.doorbellDebounceMs;
const REARM = DEFAULT_CONFIG.inboxTruncatedRingMs;

function ok<T>(r: ActResult<T>): Extract<ActResult<T>, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
}

function ringsOf(rs: ActResult | ActResult[]): RingNotification[] {
  const list = Array.isArray(rs) ? rs : [rs];
  return list.flatMap((r) => (r.ok ? r.notifications : []).filter((n): n is RingNotification => n.type === "ring"));
}

interface Page {
  wake: { body: string }[];
  digest: unknown[];
  truncated: boolean;
}

/** a posts, b reads; b is attached and idle. `level` is b's level in #t. */
function world(level: "wake" | "digest") {
  const f = makeBoard({ config: { inboxDefaultLimit: 3 } });
  f.addUser("a");
  f.addUser("b");
  ok(f.board.act(f.ctx("a"), "join", {}));
  const session = ok(f.board.act<{ session: string }>(f.ctx("b"), "join", {})).value.session;
  ok(f.board.act(f.ctx("a"), "topic_create", { name: "t" }));
  f.sql.exec("DELETE FROM timers WHERE kind = 'topic_announce'");
  ok(f.board.act(f.ctx("b"), "subscribe", { topic: "t", level }));
  ok(f.board.act(f.ctx("b"), "inbox", {}));
  const ws = (): CallContext => ({ handle: "b", via: "ws", session });
  ok(f.board.socketAct({ handle: "b", via: "ws" }, "socket_open", {}));
  ok(f.board.socketAct(ws(), "socket_hello", { harness: "claude-code", state: "idle" }));
  const rung = (): number | undefined => {
    const row = f.sql.one<{ value: string }>("SELECT value FROM meta WHERE key = 'wake_budget:b'");
    return row ? (JSON.parse(row.value) as { rung: number }).rung : undefined;
  };
  return {
    ...f,
    ws,
    rung,
    post(n: number) {
      for (let i = 0; i < n; i++) ok(f.board.act(f.ctx("a"), "post", { topic: "t", body: `m${i}` }));
    },
    inbox: () => ok(f.board.act<Page>(f.ctx("b"), "inbox", {})).value,
    bell: () => f.sql.one<{ id: string }>("SELECT id FROM doorbells WHERE handle = 'b'"),
    timers: () => f.sql.all("SELECT id FROM timers WHERE kind = 'doorbell' AND ref = 'b'").length,
    advance(ms: number): RingNotification[] {
      f.clock.advance(ms);
      return ringsOf(f.board.runDueTimers());
    },
    delivered: (ring: RingNotification) =>
      ok(f.board.socketAct(ws(), "ring_result", { id: ring.id, result: "turn_started" })),
  };
}

describe("a truncated inbox read rings again for the rest (issue #104)", () => {
  it("rings a second time after inboxTruncatedRingMs with no new event, and a drain ends clean", () => {
    const w = world("wake");
    w.post(7);
    const first = w.advance(DEBOUNCE);
    expect(first).toHaveLength(1);
    w.delivered(first[0]!);
    expect(w.rung()).toBe(1);

    const p1 = w.inbox();
    expect(p1.truncated).toBe(true);
    expect(p1.wake).toHaveLength(3);
    expect(w.bell()).toBeDefined();
    expect(w.timers()).toBe(1);

    expect(w.advance(REARM - 1)).toEqual([]);
    const second = w.advance(1);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).not.toBe(first[0]!.id);
    w.delivered(second[0]!);
    expect(w.rung()).toBe(2);

    const p2 = w.inbox();
    expect(p2.truncated).toBe(true);
    expect(p2.wake).toHaveLength(3);
    const third = w.advance(REARM);
    expect(third).toHaveLength(1);
    w.delivered(third[0]!);

    const p3 = w.inbox();
    expect(p3.truncated).toBe(false);
    expect(p3.wake).toHaveLength(1);
    expect(w.bell()).toBeUndefined();
    expect(w.timers()).toBe(0);
    expect(w.advance(60 * 60_000)).toEqual([]);
    expect(w.rung()).toBe(3);
  });

  it("the follow-up ring counts once, when it is delivered, like any ring (B51)", () => {
    const w = world("wake");
    w.post(4);
    const first = w.advance(DEBOUNCE);
    w.delivered(first[0]!);
    w.inbox();
    const second = w.advance(REARM);
    expect(second).toHaveLength(1);
    expect(w.rung()).toBe(1);
    w.delivered(second[0]!);
    expect(w.rung()).toBe(2);
  });

  it("an exact fit is not truncated and leaves no doorbell", () => {
    const w = world("wake");
    w.post(3);
    expect(w.inbox().truncated).toBe(false);
    expect(w.bell()).toBeUndefined();
    expect(w.timers()).toBe(0);
  });

  it("a rest that is digest-only is not rung early", () => {
    const w = world("digest");
    w.post(7);
    const p = w.inbox();
    expect(p.truncated).toBe(true);
    expect(w.bell()).toBeUndefined();
    expect(w.timers()).toBe(0);
    expect(w.advance(REARM * 10)).toEqual([]);
  });

  it("a person gets no doorbell from a truncated read", () => {
    const f = makeBoard({ config: { inboxDefaultLimit: 2 } });
    f.addUser("a");
    f.addUser("p", "human");
    ok(f.board.act(f.ctx("a"), "join", {}));
    ok(f.board.act(f.ctx("a"), "topic_create", { name: "t" }));
    ok(f.board.act(f.ctx("p"), "subscribe", { topic: "t", level: "wake" }));
    for (let i = 0; i < 5; i++) ok(f.board.act(f.ctx("a"), "post", { topic: "t", body: `m${i}` }));
    expect(ok(f.board.act<Page>(f.ctx("p"), "inbox", {})).value.truncated).toBe(true);
    expect(f.sql.one("SELECT 1 AS x FROM doorbells WHERE handle = 'p'")).toBeUndefined();
  });
});
