// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// G5: `bbs_admin_status`, the human admin's board-health read. Refused (and
// audited as denied) for every agent and every person without admin; never on
// /mcp; unaudited and write-free when allowed; flags only the three
// conditions Curtis chose (kicked or muted agents, rings that keep failing,
// audit export failing); wake budget as plain data.

import { describe, expect, it } from "vitest";
import { failingSince, formatSpan, RING_HISTORY_SQL } from "../src/actions/admin-status.ts";
import { exportAudit, type AuditSink } from "../src/audit-export.ts";
import { callTool, findTool, TOOLS } from "../src/tools.ts";
import type { ActResult, CallContext, RuntimeFacts } from "../src/types.ts";
import { ADMIN, makeBoard, RecordingSql, type Fixture } from "./helpers.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

function ok<T>(r: ActResult<T>): Extract<ActResult<T>, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
}

interface Flag {
  kind: string;
  handle?: string;
  since: number | null;
  until?: number | null;
  what: string;
  todo: string;
  action?: string;
}

interface UserStatus {
  handle: string;
  kind: string;
  status: string;
  coordinator: boolean;
  muted_until: number | null;
  kicked_at: number | null;
  session: { state: string; socket_recorded: boolean; machine: string | null } | null;
  open_sockets: number | null;
  rings: { at: number; result: string }[];
  rings_failing_since: number | null;
  wake_budget: { used: number; limit: number; window_ends_at: number | null } | null;
  doorbell: { pending_since: number } | null;
}

interface Status {
  now: number;
  users: UserStatus[];
  audit_export: {
    configured: boolean | null;
    unexported_rows: number;
    failing_since: number | null;
    last_ok_at: number | null;
    last_error: string | null;
  };
  needs_you: Flag[];
}

function status(f: Fixture, via: "cli" | "web" = "cli"): Status {
  return ok(f.board.act<Status>(f.ctx(ADMIN, via), "admin_status", {})).value;
}

const userOf = (s: Status, h: string): UserStatus => {
  const u = s.users.find((x) => x.handle === h);
  if (!u) throw new Error(`no ${h}`);
  return u;
};

/** Flood the Lobby until the first refusal. */
function flood(f: Fixture, h: string): void {
  for (let i = 0; i < 50; i++) {
    if (!f.board.act(f.ctx(h), "post", { topic: "Lobby", body: `m${i}` }).ok) return;
  }
  throw new Error("never refused");
}

/** Warn, mute, kick (design §10 with B34). */
function kick(f: Fixture, h: string): void {
  flood(f, h);
  f.clock.advance(11 * MIN);
  flood(f, h);
  f.clock.advance(HOUR + MIN);
  f.board.runDueTimers();
  flood(f, h);
}

/** Attach h's adapter socket (join, open, hello); returns the ws context. */
function attach(f: Fixture, h: string): CallContext {
  const session = ok(f.board.act<{ session: string }>(f.ctx(h), "join", {})).value.session;
  ok(f.board.socketAct({ handle: h, via: "ws" }, "socket_open", {}));
  const ws: CallContext = { handle: h, via: "ws", session };
  ok(f.board.socketAct(ws, "socket_hello", { harness: "claude-code", machine: "workstation-1", state: "idle" }));
  return ws;
}

function ringResult(f: Fixture, ws: CallContext, result: "failed" | "turn_started" | "held_busy"): void {
  ok(f.board.socketAct(ws, "ring_result", { id: "d_test", result }));
}

class FakeRuntime implements RuntimeFacts {
  sockets = new Map<string, number>();
  configured = false;
  openSockets(handle: string): number {
    return this.sockets.get(handle) ?? 0;
  }
  auditExportConfigured(): boolean {
    return this.configured;
  }
}

class Sink implements AuditSink {
  failing = false;
  async create(): Promise<"created" | "exists"> {
    if (this.failing) throw new Error("HTTP 503 (backendError)");
    return "created";
  }
}

describe("who may read it", () => {
  it("is refused for an agent, a coordinator agent and a person without admin, each audited as denied/forbidden", () => {
    const f = makeBoard();
    f.addUser("alice");
    f.addUser("coord");
    f.addUser("pat", "human");
    ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "coord" }));
    for (const [h, via] of [["alice", "mcp"], ["alice", "api"], ["coord", "api"], ["pat", "cli"], ["pat", "web"]] as const) {
      const before = f.auditRows().length;
      const r = f.board.act({ handle: h, via }, "admin_status", {});
      expect(r.ok, `${h} via ${via}`).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("forbidden");
      const rows = f.auditRows().slice(before);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: h, action: "admin_status", result: "denied" });
    }
  });

  it("is offered on /api and the CLI only, never on /mcp; asking there is refused and audited", () => {
    const tool = findTool("bbs_admin_status");
    expect(tool?.surfaces).toEqual(["api", "cli"]);
    expect(tool?.cli).toEqual(["admin", "status"]);
    expect(TOOLS.filter((t) => t.surfaces.includes("mcp")).map((t) => t.name)).not.toContain("bbs_admin_status");
    const f = makeBoard();
    f.addUser("alice");
    const before = f.auditRows().length;
    const r = callTool(f.board, f.ctx("alice"), "bbs_admin_status", {}, "mcp");
    expect(r.isError).toBe(true);
    expect(f.auditRows().slice(before)).toMatchObject([{ action: "admin_status", result: "denied" }]);
    // Even the human admin's call is refused on /mcp (people never reach it; the guard is the surface list).
    expect(callTool(f.board, f.ctx(ADMIN), "bbs_admin_status", {}, "mcp").isError).toBe(true);
  });
});

describe("a read: not audited, and writes nothing", () => {
  it("adds no audit row for the human admin", () => {
    const f = makeBoard();
    f.addUser("alice");
    const before = f.auditRows().length;
    status(f);
    status(f, "web");
    expect(f.auditRows()).toHaveLength(before);
  });

  it("through the web view, runs no write statement at all (B38: a person's web reads are not activity)", () => {
    let rec: RecordingSql | undefined;
    const f = makeBoard({ wrap: (raw) => (rec = new RecordingSql(raw)) });
    f.addUser("alice");
    const ws = attach(f, "alice");
    ringResult(f, ws, "failed");
    if (!rec) throw new Error("no recorder");
    const from = rec.log.length;
    status(f, "web");
    expect(rec.log.slice(from).filter((s) => s.write)).toEqual([]);
  });

  it("through the CLI, writes only the caller's last_seen (and lease renewal), as every call does", () => {
    let rec: RecordingSql | undefined;
    const f = makeBoard({ wrap: (raw) => (rec = new RecordingSql(raw)) });
    if (!rec) throw new Error("no recorder");
    const from = rec.log.length;
    status(f, "cli");
    const writes = rec.log.slice(from).filter((s) => s.write).map((s) => s.sql.trim().split(/\s+/).slice(0, 3).join(" "));
    for (const w of writes) expect(["UPDATE users SET", "UPDATE tasks SET"]).toContain(w);
  });
});

describe("a healthy board is dark", () => {
  it("lists every user by handle with plain data and nothing in needs_you", () => {
    const rt = new FakeRuntime();
    const f = makeBoard({ runtime: rt });
    f.addUser("zed");
    f.addUser("alice");
    f.addUser("pat", "human");
    attach(f, "alice");
    rt.sockets.set("alice", 1);
    const s = status(f);
    expect(s.users.map((u) => u.handle)).toEqual(["alice", ADMIN, "pat", "zed"]);
    expect(s.needs_you).toEqual([]);
    const alice = userOf(s, "alice");
    expect(alice).toMatchObject({
      kind: "agent",
      status: "active",
      open_sockets: 1,
      session: { state: "idle", socket_recorded: true, machine: "workstation-1" },
      rings: [],
      rings_failing_since: null,
      wake_budget: { used: 0, limit: 20, window_ends_at: null },
    });
    expect(userOf(s, "zed")).toMatchObject({ session: null, open_sockets: 0 });
    // People: no session, rings or wake budget.
    expect(userOf(s, "pat")).toMatchObject({ kind: "human", session: null, open_sockets: null, wake_budget: null });
    expect(s.audit_export.configured).toBe(false);
  });

  it("reports runtime facts as unknown (null) when the shell gave none", () => {
    const f = makeBoard();
    f.addUser("alice");
    const s = status(f);
    expect(userOf(s, "alice").open_sockets).toBeNull();
    expect(s.audit_export.configured).toBeNull();
  });
});

describe("kicked or muted agents", () => {
  it("a kicked agent is flagged with how long ago, what to do, and a reinstate action; reinstating clears it", () => {
    const f = makeBoard();
    f.addUser("alice");
    f.addUser("bob");
    kick(f, "alice");
    const kickedAt = f.clock.t;
    f.clock.advance(12 * MIN);
    const s = status(f);
    expect(userOf(s, "alice")).toMatchObject({ status: "kicked", kicked_at: kickedAt });
    expect(s.needs_you).toEqual([
      expect.objectContaining({ kind: "kicked", handle: "alice", since: kickedAt, action: "reinstate" }),
    ]);
    const flag = s.needs_you[0] as Flag;
    expect(flag.what).toContain("12 min ago");
    expect(flag.todo).toMatch(/Reinstate gives it a new token/);
    ok(f.board.act(f.ctx(ADMIN), "admin_reinstate", { handle: "alice" }));
    const after = status(f);
    expect(after.needs_you).toEqual([]);
    expect(userOf(after, "alice")).toMatchObject({ status: "active", kicked_at: null });
  });

  it("a Lobby-muted agent is flagged with the time left, and the flag goes when the mute lifts", () => {
    const f = makeBoard();
    f.addUser("alice");
    flood(f, "alice");
    f.clock.advance(11 * MIN);
    flood(f, "alice");
    const s = status(f);
    const alice = userOf(s, "alice");
    expect(alice.status).toBe("muted");
    expect(alice.muted_until).toBe(f.clock.t + HOUR);
    expect(s.needs_you).toEqual([expect.objectContaining({ kind: "muted", handle: "alice", until: f.clock.t + HOUR })]);
    expect(s.needs_you[0]?.what).toContain("1 h left");
    expect(s.needs_you[0]?.action).toBeUndefined();
    f.clock.advance(HOUR + MIN);
    f.board.runDueTimers();
    expect(status(f).needs_you).toEqual([]);
  });
});

describe("rings keep failing (last 3 ring results failed)", () => {
  it("flags after three failures in a row, with when the run began and the likely causes", () => {
    const f = makeBoard();
    f.addUser("alice");
    const ws = attach(f, "alice");
    ringResult(f, ws, "turn_started");
    f.clock.advance(MIN);
    ringResult(f, ws, "failed");
    const firstFail = f.clock.t;
    f.clock.advance(MIN);
    ringResult(f, ws, "failed");
    expect(status(f).needs_you).toEqual([]);
    f.clock.advance(MIN);
    ringResult(f, ws, "failed");
    f.clock.advance(10 * MIN);
    const s = status(f);
    expect(userOf(s, "alice").rings.map((r) => r.result)).toEqual(["failed", "failed", "failed", "turn_started"]);
    expect(userOf(s, "alice").rings_failing_since).toBe(firstFail);
    expect(s.needs_you).toEqual([expect.objectContaining({ kind: "rings_failing", handle: "alice", since: firstFail })]);
    expect(s.needs_you[0]?.what).toContain("12 min ago");
    expect(s.needs_you[0]?.todo).toMatch(/Likely causes/);
  });

  it("held_busy breaks the run, and a turn that starts clears the flag", () => {
    const f = makeBoard();
    f.addUser("alice");
    const ws = attach(f, "alice");
    ringResult(f, ws, "failed");
    ringResult(f, ws, "failed");
    ringResult(f, ws, "held_busy");
    ringResult(f, ws, "failed");
    expect(status(f).needs_you).toEqual([]);
    ringResult(f, ws, "failed");
    ringResult(f, ws, "failed");
    expect(status(f).needs_you.map((x) => x.kind)).toEqual(["rings_failing"]);
    ringResult(f, ws, "turn_started");
    expect(status(f).needs_you).toEqual([]);
  });

  it("shows at most adminRingHistory results per agent, newest first, each agent its own", () => {
    const f = makeBoard({ config: { adminRingHistory: 4 } });
    f.addUser("alice");
    f.addUser("bob");
    const a = attach(f, "alice");
    const b = attach(f, "bob");
    for (let i = 0; i < 6; i++) {
      f.clock.advance(1000);
      ringResult(f, a, "turn_started");
    }
    ringResult(f, b, "failed");
    const s = status(f);
    expect(userOf(s, "alice").rings).toHaveLength(4);
    expect(userOf(s, "alice").rings[0]?.at).toBe(f.clock.t);
    expect(userOf(s, "bob").rings).toEqual([{ at: f.clock.t, result: "failed" }]);
  });

  it("failingSince needs a run of at least n failures at the head", () => {
    const r = (result: string, at: number) => ({ result, at });
    expect(failingSince([r("failed", 3), r("failed", 2), r("failed", 1)], 3)).toBe(1);
    expect(failingSince([r("failed", 4), r("failed", 3), r("failed", 2), r("turn_started", 1)], 3)).toBe(2);
    expect(failingSince([r("failed", 3), r("turn_started", 2), r("failed", 1)], 3)).toBeNull();
    expect(failingSince([], 3)).toBeNull();
  });
});

describe("the status read does not scan the audit table (issue #45)", () => {
  it("reads each agent's ring results through the (action, actor, seq) index, with no table scan of audit", () => {
    const f = makeBoard();
    f.addUser("amy");
    const ws = attach(f, "amy");
    for (let i = 0; i < 5; i++) ringResult(f, ws, "failed");
    const plan = f.sql
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${RING_HISTORY_SQL}`, "amy", 3)
      .map((r) => r.detail);
    expect(plan.join(" | ")).toMatch(/audit_action_actor_seq/);
    expect(plan.join(" | ")).toMatch(/action=\? AND actor=\?/);
    for (const step of plan) expect(step, step).not.toMatch(/^SCAN (TABLE )?audit\b(?! USING)/);
    expect(plan.join(" | ")).not.toMatch(/USE TEMP B-TREE/);
  });

  it("the status still lists the newest results after the index (same rows as before)", () => {
    const f = makeBoard();
    f.addUser("amy");
    f.addUser("bob");
    const wsA = attach(f, "amy");
    const wsB = attach(f, "bob");
    for (const r of ["held_busy", "failed", "failed", "failed", "failed"] as const) {
      f.clock.advance(1_000);
      ringResult(f, wsA, r);
    }
    f.clock.advance(1_000);
    ringResult(f, wsB, "turn_started");
    const s = status(f);
    expect(userOf(s, "amy").rings.map((r) => r.result)).toEqual(["failed", "failed", "failed", "failed", "held_busy"]);
    expect(userOf(s, "bob").rings.map((r) => r.result)).toEqual(["turn_started"]);
  });
});

describe("wake budget is plain data, never a flag", () => {
  it("reports rings used against the limit and when the window ends, with nothing in needs_you even past it", () => {
    const f = makeBoard({ config: { wakeBudgetPerHour: 2 } });
    f.addUser("alice");
    f.addUser("bob");
    const ws = attach(f, "bob");
    ok(f.board.act(f.ctx("alice"), "join", {}));
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "t" }));
    ok(f.board.act(f.ctx("bob"), "subscribe", { topic: "t", level: "wake" }));
    const start = f.clock.t;
    for (let i = 0; i < 4; i++) {
      ok(f.board.act(f.ctx("alice"), "post", { topic: "t", body: `x${i}` }));
      f.clock.advance(6_000);
      f.board.runDueTimers();
      // A ring counts when the adapter reports it delivered (B51), so report
      // each one that was sent; rings past the budget are never sent.
      const bell = f.sql.one<{ id: string }>("SELECT id FROM doorbells WHERE handle = 'bob' AND sent_at IS NOT NULL");
      if (bell) ok(f.board.socketAct(ws, "ring_result", { id: bell.id, result: "turn_started" }));
      ok(f.board.act(f.ctx("bob"), "inbox", {}));
    }
    const s = status(f);
    const budget = userOf(s, "bob").wake_budget;
    expect(budget?.used).toBe(2);
    expect(budget?.limit).toBe(2);
    expect(budget?.window_ends_at).toBeGreaterThan(start);
    expect(s.needs_you).toEqual([]);
  });
});

describe("audit export", () => {
  it("flags a configured export that is failing, with the error and rows waiting", async () => {
    const rt = new FakeRuntime();
    rt.configured = true;
    const f = makeBoard({ runtime: rt });
    f.addUser("alice");
    const sink = new Sink();
    sink.failing = true;
    f.clock.advance(15 * MIN);
    await exportAudit(f.board, sink);
    const failedAt = f.clock.t;
    f.clock.advance(20 * MIN);
    const s = status(f);
    expect(s.audit_export).toMatchObject({ configured: true, failing_since: failedAt, last_error: expect.stringContaining("503") });
    expect(s.audit_export.unexported_rows).toBeGreaterThan(0);
    expect(s.needs_you).toEqual([expect.objectContaining({ kind: "audit_export_failing", since: failedAt })]);
    expect(s.needs_you[0]?.what).toContain("failing for 20 min");
    expect(s.needs_you[0]?.handle).toBeUndefined();
    // Recovery clears the flag and records when it last worked.
    sink.failing = false;
    f.clock.advance(15 * MIN);
    await exportAudit(f.board, sink);
    const after = status(f);
    expect(after.needs_you).toEqual([]);
    expect(after.audit_export.last_ok_at).toBe(f.clock.t);
    expect(after.audit_export.failing_since).toBeNull();
  });

  it("flags rows piling up past the interval plus adminExportOverdueMs with no failure recorded", () => {
    const rt = new FakeRuntime();
    rt.configured = true;
    const f = makeBoard({ runtime: rt });
    f.addUser("alice");
    f.clock.advance(59 * MIN);
    expect(status(f).needs_you).toEqual([]);
    f.clock.advance(2 * MIN);
    const s = status(f);
    expect(s.needs_you).toEqual([expect.objectContaining({ kind: "audit_export_failing" })]);
    expect(s.needs_you[0]?.what).toMatch(/piling up/);
  });

  it("an export that is not configured is plain data, never a flag", () => {
    const rt = new FakeRuntime();
    const f = makeBoard({ runtime: rt });
    f.addUser("alice");
    f.clock.advance(10 * HOUR);
    const s = status(f);
    expect(s.audit_export.configured).toBe(false);
    expect(s.audit_export.unexported_rows).toBeGreaterThan(0);
    expect(s.needs_you).toEqual([]);
  });
});

describe("needs_you order is stable", () => {
  it("kicked first, then failing rings, then mutes, then export; by handle within a kind", () => {
    const rt = new FakeRuntime();
    rt.configured = true;
    const f = makeBoard({ runtime: rt });
    for (const h of ["dan", "cat", "bob", "amy"]) f.addUser(h);
    kick(f, "dan");
    kick(f, "cat");
    flood(f, "bob");
    f.clock.advance(11 * MIN);
    flood(f, "bob");
    const ws = attach(f, "amy");
    for (let i = 0; i < 3; i++) ringResult(f, ws, "failed");
    f.clock.advance(30 * MIN);
    expect(status(f).needs_you.map((x) => `${x.kind}:${x.handle ?? ""}`)).toEqual([
      "kicked:cat",
      "kicked:dan",
      "rings_failing:amy",
      "muted:bob",
      "audit_export_failing:",
    ]);
  });
});

describe("formatSpan", () => {
  it("says elapsed time in words", () => {
    expect(formatSpan(30_000)).toBe("under a minute");
    expect(formatSpan(-5)).toBe("under a minute");
    expect(formatSpan(12 * MIN)).toBe("12 min");
    expect(formatSpan(2 * HOUR)).toBe("2 h");
    expect(formatSpan(3 * HOUR + 5 * MIN)).toBe("3 h 5 min");
    expect(formatSpan(52 * HOUR)).toBe("2 d 4 h");
    expect(formatSpan(48 * HOUR)).toBe("2 d");
  });
});
