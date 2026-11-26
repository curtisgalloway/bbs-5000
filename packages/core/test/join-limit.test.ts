// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #43: the per-handle limit on new sessions made by `bbs_join`. The
 * limit is a condition of the session insert; the first refusal in a window
 * gets one `denied` row and the rest are written as one `join_rate_suppressed`
 * row when the window ends, so a join/refusal loop writes a bounded number of
 * audit rows.
 */

import { describe, expect, it } from "vitest";
import type { ActResult, BoardConfig, CallContext } from "../src/types.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { makeBoard, type Fixture } from "./helpers.ts";

const MIN = 60_000;
const LIMIT = 4;

function world(config: Partial<BoardConfig> = {}): Fixture {
  const f = makeBoard({ config: { joinMaxPerWindow: LIMIT, joinWindowMs: 10 * MIN, ...config } });
  f.addUser("a");
  f.addUser("b");
  return f;
}

const join = (f: Fixture, handle = "a", ctx: Partial<CallContext> = {}): ActResult<{ session: string }> =>
  f.board.act<{ session: string }>({ ...f.ctx(handle), ...ctx }, "join", {});

const count = (f: Fixture, action: string): number =>
  f.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE action = ?", action)?.n ?? 0;

const sessions = (f: Fixture, handle: string): number =>
  f.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE handle = ?", handle)?.n ?? 0;

describe("the default join limit", () => {
  it("allows 20 new sessions per handle per 10 minutes", () => {
    expect(DEFAULT_CONFIG.joinMaxPerWindow).toBe(20);
    expect(DEFAULT_CONFIG.joinWindowMs).toBe(10 * MIN);
  });
});

describe("bbs_join limit on new sessions (#43)", () => {
  it("allows the limit, then refuses with rate_limited and a retry time", () => {
    const f = world();
    for (let i = 0; i < LIMIT; i++) {
      expect(join(f).ok).toBe(true);
      f.clock.advance(1_000);
    }
    const r = join(f);
    expect(r).toMatchObject({ ok: false, error: { code: "rate_limited" }, result: "denied" });
    // The oldest session was made 4 s ago, so a place frees in 10 minutes less 4 s.
    if (!r.ok) expect(r.error.message).toMatch(/try again in 9 min$/);
    expect(sessions(f, "a")).toBe(LIMIT);
  });

  it("a refused join changes nothing else: no new session, the live one stays, the role is kept", () => {
    const f = world();
    for (let i = 0; i < LIMIT; i++) join(f);
    const live = f.sql.one<{ id: string }>("SELECT id FROM sessions WHERE handle = 'a' AND state <> 'gone'")?.id;
    const r = f.board.act(f.ctx("a"), "join", { role: "reviewer" });
    expect(r.ok).toBe(false);
    expect(f.sql.one<{ id: string }>("SELECT id FROM sessions WHERE handle = 'a' AND state <> 'gone'")?.id).toBe(live);
    expect(f.sql.one<{ role: string }>("SELECT role FROM users WHERE handle = 'a'")?.role).not.toBe("reviewer");
  });

  it("the limit resets after the window", () => {
    const f = world();
    for (let i = 0; i < LIMIT; i++) expect(join(f).ok).toBe(true);
    expect(join(f).ok).toBe(false);
    f.clock.advance(10 * MIN);
    for (let i = 0; i < LIMIT; i++) expect(join(f).ok, `join ${i}`).toBe(true);
    expect(join(f).ok).toBe(false);
  });

  it("is a sliding window: a place frees when the oldest session leaves it", () => {
    const f = world();
    for (let i = 0; i < LIMIT; i++) {
      join(f);
      f.clock.advance(MIN);
    }
    expect(join(f).ok).toBe(false);
    f.clock.advance(6 * MIN);
    expect(join(f).ok).toBe(true);
    expect(join(f).ok).toBe(false);
  });

  it("updating the caller's current session is not counted", () => {
    const f = world();
    const first = join(f);
    if (!first.ok) throw new Error("join refused");
    const own = { session: first.value.session };
    for (let i = 0; i < 50; i++) {
      const r = join(f, "a", own);
      expect(r.ok, `rejoin ${i}`).toBe(true);
    }
    expect(sessions(f, "a")).toBe(1);
    // Only the one new session counted: the rest of the limit is still there.
    for (let i = 1; i < LIMIT; i++) expect(join(f).ok).toBe(true);
    expect(join(f).ok).toBe(false);
  });

  it("two handles do not share a window", () => {
    const f = world();
    for (let i = 0; i < LIMIT; i++) expect(join(f, "a").ok).toBe(true);
    expect(join(f, "a").ok).toBe(false);
    for (let i = 0; i < LIMIT; i++) expect(join(f, "b").ok, `b ${i}`).toBe(true);
    expect(join(f, "b").ok).toBe(false);
  });

  it("covers people too: a human's CLI joins count like an agent's", () => {
    const f = world();
    f.addUser("pat", "human");
    for (let i = 0; i < LIMIT; i++) expect(join(f, "pat").ok).toBe(true);
    expect(join(f, "pat")).toMatchObject({ ok: false, error: { code: "rate_limited" } });
  });

  it("concurrent joins at the limit: exactly the allowed number succeed", async () => {
    const f = world();
    const results = await Promise.all(
      Array.from({ length: LIMIT * 3 }, () => Promise.resolve().then(() => join(f))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(LIMIT);
    expect(results.filter((r) => !r.ok)).toHaveLength(LIMIT * 2);
    expect(sessions(f, "a")).toBe(LIMIT);
  });

  it("the first refusal in a window gets one denied row; the rest are counted and written as one summary", () => {
    const f = world();
    for (let i = 0; i < LIMIT; i++) join(f);
    const before = f.auditRows().length;
    const refusals = Array.from({ length: 30 }, () => join(f));
    expect(refusals.every((r) => !r.ok)).toBe(true);
    expect(refusals[0]).toMatchObject({ auditSeq: expect.any(Number) });
    expect(refusals[1]).toMatchObject({ error: { code: "rate_limited" }, result: "denied", auditSeq: undefined });
    expect(f.auditRows().length - before).toBe(1);
    expect(count(f, "join_rate_suppressed")).toBe(0);
    f.clock.advance(10 * MIN);
    f.board.flushAuthWindows();
    const rows = f.sql.all<{ actor: string; detail: string }>(
      "SELECT actor, detail FROM audit WHERE action = 'join_rate_suppressed'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("system");
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({ handle: "a", total: 29 });
  });

  it("a join/refusal loop writes a bounded number of audit rows per window", () => {
    // The adapter's loop: join, its socket is refused (4003), it forgets the
    // session and joins again, 400 times in a few minutes.
    const f = world({ socketMessageLimit: 3 });
    const before = f.auditRows().length;
    let made = 0;
    for (let i = 0; i < 400; i++) {
      const r = join(f);
      if (r.ok) {
        made += 1;
        const ws: CallContext = { handle: "a", via: "ws", session: r.value.session };
        f.board.socketAct({ handle: "a", via: "ws" }, "socket_open", {});
        for (let m = 0; m < 10; m++) f.board.socketAct(ws, "session_state", { state: m % 2 ? "idle" : "busy" });
      }
      f.clock.advance(500);
    }
    f.clock.advance(10 * MIN);
    f.board.flushAuthWindows();
    expect(made).toBe(LIMIT);
    const rows = f.auditRows().length - before;
    // Per allowed join: the join row, socket_open, and at most 3 applied messages
    // plus 1 limited row and 1 summary row; plus the refusal and its summary.
    const bound = LIMIT * (1 + 1 + 3 + 1 + 1) + 2;
    expect(rows).toBeLessThanOrEqual(bound);
    expect(count(f, "join")).toBe(LIMIT + 1);
  });

  it("keeps the bound over many windows: rows grow with windows, not with attempts", () => {
    const f = world();
    const before = f.auditRows().length;
    // 600 attempts, one every 5 s: 3000 s, a little over 5 windows of 10 minutes.
    for (let i = 0; i < 600; i++) {
      join(f);
      f.clock.advance(5_000);
    }
    f.clock.advance(10 * MIN);
    f.board.flushAuthWindows();
    const windows = Math.ceil(3_000_000 / (10 * MIN)) + 1;
    const rows = f.auditRows().length - before;
    expect(rows).toBeLessThanOrEqual(windows * (LIMIT + 2));
    expect(rows).toBeLessThan(600 / 5);
  });
});
