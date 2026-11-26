// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * M4b: the wake budget (design §6, A4.3) with the injected clock, and the
 * credential checks behind closing a kicked or revoked user's adapter
 * sockets (A4.1 socket part, backlog B48): `takeDisconnects`,
 * `socketCredential`, `socketsClosed`.
 */

import { describe, expect, it } from "vitest";
import type { ActResult, AdminNotification, BoardConfig, CallContext, RingNotification } from "../src/types.ts";
import { DEFAULT_CONFIG, validateConfig } from "../src/types.ts";
import { ADMIN, ADMIN_TOKEN, makeBoard, sha256, type Fixture } from "./helpers.ts";

const DEBOUNCE = 5_000;
const WINDOW = 60_000;
const BUDGET = 3;

function ok<T>(r: ActResult<T>): Extract<ActResult<T>, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
}

function rings(rs: ActResult | ActResult[]): RingNotification[] {
  const list = Array.isArray(rs) ? rs : [rs];
  return list.flatMap((r) => r.notifications.filter((n): n is RingNotification => n.type === "ring"));
}

interface World extends Fixture {
  session: string;
  ws(): CallContext;
  post(who: string, topic: string, body: string): ActResult;
  settle(): ActResult[];
  /** The adapter reports that a ring started a turn; only this counts against the budget (B51). */
  delivered(ring: RingNotification | undefined, confirmed?: boolean): ActResult;
  /** One full cycle: a posts in #t, the debounce rings b, the adapter reports the turn started, b reads its inbox. Returns the rings. */
  cycle(body?: string): RingNotification[];
  adminLog(): string[];
  notices(handle: string): { reason: string; detail: string }[];
  ringResults(): unknown[];
}

/**
 * a and b are agents, c is an agent coordinator; b joined, is in #t at wake,
 * and its adapter socket is attached idle. Budget 3 per 60 s.
 */
function world(config: Partial<BoardConfig> = {}): World {
  const f = makeBoard({
    config: { wakeBudgetPerHour: BUDGET, wakeBudgetWindowMs: WINDOW, doorbellDebounceMs: DEBOUNCE, ...config },
  });
  f.addUser("a");
  f.addUser("b");
  f.addUser("c");
  ok(f.board.act(f.ctx(ADMIN, "cli"), "admin_coordinator_grant", { handle: "c" }));
  ok(f.board.act(f.ctx("a"), "join", {}));
  ok(f.board.act(f.ctx("c"), "join", {}));
  const session = ok(f.board.act<{ session: string }>(f.ctx("b"), "join", {})).value.session;
  ok(f.board.act(f.ctx("a"), "topic_create", { name: "t" }));
  ok(f.board.act(f.ctx("b"), "subscribe", { topic: "t", level: "wake" }));
  ok(f.board.act(f.ctx("b"), "inbox", {}));
  const ws = (): CallContext => ({ handle: "b", via: "ws", session });
  ok(f.board.socketAct({ handle: "b", via: "ws" }, "socket_open", {}));
  ok(f.board.socketAct(ws(), "socket_hello", { harness: "claude-code", state: "idle" }));
  const w: World = {
    ...f,
    session,
    ws,
    post: (who, topic, body) => f.board.act(f.ctx(who), "post", { topic, body }),
    settle() {
      f.clock.advance(DEBOUNCE);
      return f.board.runDueTimers();
    },
    delivered: (ring, confirmed) =>
      f.board.socketAct(ws(), "ring_result", {
        id: ring?.id,
        result: "turn_started",
        ...(confirmed === undefined ? {} : { confirmed }),
      }),
    cycle(body = "x") {
      ok(w.post("a", "t", body));
      const r = rings(w.settle());
      for (const ring of r) ok(w.delivered(ring));
      ok(f.board.act(f.ctx("b"), "inbox", {}));
      return r;
    },
    adminLog: () =>
      f.sql
        .all<{ body: string }>("SELECT body FROM messages WHERE topic = 'admin-log' ORDER BY seq")
        .map((r) => r.body)
        .filter((b) => b.startsWith("wake budget")),
    notices: (handle) =>
      f.sql.all<{ reason: string; detail: string }>(
        "SELECT reason, detail FROM notices WHERE handle = ? AND kind = 'admin' ORDER BY id",
        handle,
      ),
    ringResults: () =>
      f.sql
        .all<{ detail: string }>("SELECT detail FROM audit WHERE action = 'doorbell_due' ORDER BY seq")
        .map((r) => (JSON.parse(r.detail) as { ring?: unknown }).ring),
  };
  return w;
}

describe("wake budget (A4.3, design §6)", () => {
  it("rings up to the budget, then falls back to digest: no ring, inbox shows everything", () => {
    const w = world();
    const t0 = w.clock.t;
    for (let i = 0; i < BUDGET; i++) expect(w.cycle(`in budget ${i}`)).toHaveLength(1);
    ok(w.post("a", "t", "over budget one"));
    ok(w.post("a", "t", "over budget two"));
    expect(rings(w.settle())).toEqual([]);
    // The doorbell stays pending and unsent: the next inbox clears it.
    expect(w.sql.one("SELECT sent_at FROM doorbells WHERE handle = 'b'")).toEqual({ sent_at: null });
    expect(w.ringResults().at(-1)).toEqual({
      result: "over_budget",
      doorbell: expect.stringMatching(/^d_/),
      budget_until: t0 + DEBOUNCE + WINDOW,
    });
    const inbox = ok(w.board.act<{ wake: unknown[] }>(w.ctx("b"), "inbox", {}));
    expect(inbox.value.wake).toHaveLength(2);
    expect(w.sql.one("SELECT 1 AS x FROM doorbells WHERE handle = 'b'")).toBeUndefined();
    expect(w.board.verifyAudit().ok).toBe(true);
  });

  it("writes one #admin-log line per window and tells the user and the coordinator", () => {
    const w = world();
    for (let i = 0; i < BUDGET; i++) w.cycle();
    ok(w.post("a", "t", "over 1"));
    const due = w.settle();
    const followUpNotes = due.flatMap((r) => r.notifications).filter((n): n is AdminNotification => n.type === "admin");
    expect(followUpNotes.map((n) => [n.reason, n.recipient, n.as])).toEqual([
      ["wake_budget", "b", "user"],
      ["wake_budget", "c", "coordinator"],
    ]);
    expect(w.adminLog()).toEqual([
      expect.stringMatching(/^wake budget: b reached 3 doorbells in 1 minute; further events fall back to digest until 20\d\d-/),
    ]);
    expect(w.notices("b").map((n) => n.reason)).toEqual(["wake_budget"]);
    expect(w.notices("c").map((n) => n.reason)).toEqual(["wake_budget"]);
    // Later refusals in the same window write nothing more.
    ok(w.post("a", "t", "over 2"));
    w.settle();
    ok(w.board.socketAct(w.ws(), "session_state", { state: "idle" }));
    ok(w.post("a", "t", "over 3"));
    w.settle();
    expect(w.adminLog()).toHaveLength(1);
    const rows = w.sql.all<{ actor: string; detail: string; request_id: string | null }>(
      "SELECT actor, detail, request_id FROM audit WHERE action = 'wake_budget_exceeded'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe("system");
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toMatchObject({ outcome: "fallback", rung: BUDGET });
  });

  it("with no coordinator, the notice is recorded as undelivered", () => {
    const w = world();
    ok(w.board.act(w.ctx(ADMIN, "cli"), "admin_coordinator_remove", { handle: "c" }));
    for (let i = 0; i < BUDGET; i++) w.cycle();
    ok(w.post("a", "t", "over"));
    const notes = w.settle().flatMap((r) => r.notifications).filter((n): n is AdminNotification => n.type === "admin");
    expect(notes).toContainEqual(expect.objectContaining({ reason: "wake_budget", recipient: null, undelivered: "no_coordinator" }));
  });

  it("an agent's @mention and a task assignment past the budget do not ring (B52)", () => {
    const w = world();
    for (let i = 0; i < BUDGET; i++) w.cycle();
    ok(w.post("a", "Lobby", "@b please look"));
    expect(rings(w.settle())).toEqual([]);
    const task = ok(w.board.act<{ task: { id: number } }>(w.ctx("a"), "task_create", { topic: "t", title: "do it" }));
    ok(w.board.act(w.ctx("a"), "task_assign", { task: task.value.task.id, assignee: "b" }));
    expect(rings(w.settle())).toEqual([]);
    expect((w.ringResults().at(-1) as { result: string }).result).toBe("over_budget");
    // Both wait in the inbox.
    const inbox = ok(w.board.act<{ wake: unknown[]; notices?: unknown[] }>(w.ctx("b"), "inbox", {}));
    expect(JSON.stringify(inbox.value)).toMatch(/please look/);
    expect(JSON.stringify(inbox.value)).toMatch(/task_assigned/);
  });

  it("a person's @mention rings past the budget and still counts (B52, decided by Curtis)", () => {
    const w = world();
    const start = w.clock.t + DEBOUNCE;
    for (let i = 0; i < BUDGET; i++) w.cycle();
    ok(w.post("a", "t", "agent event, over"));
    expect(rings(w.settle())).toEqual([]);
    // The over-budget doorbell waits on a timer at the window's end; a
    // person's mention brings it forward to the debounce.
    expect(w.board.nextTimerDue()).toBe(start + WINDOW);
    ok(w.board.act(w.ctx(ADMIN, "cli"), "post", { topic: "Lobby", body: "@b need you now" }));
    expect(w.board.nextTimerDue()).toBe(w.clock.t + DEBOUNCE);
    const r = rings(w.settle());
    expect(r.map((x) => x.text)).toEqual(["BBS-5000: 1 new in #Lobby (1 mention), 1 new in #t. Call bbs_inbox now, then continue your task."]);
    expect(w.ringResults().at(-1)).toMatchObject({ result: "rung", past_budget: "human_mention" });
    ok(w.delivered(r[0]));
    const meta = w.sql.one<{ value: string }>("SELECT value FROM meta WHERE key = 'wake_budget:b'");
    expect(JSON.parse(meta?.value ?? "{}")).toMatchObject({ rung: BUDGET + 1 });
    // After inbox, an agent's mention is digest again.
    ok(w.board.act(w.ctx("b"), "inbox", {}));
    ok(w.post("a", "t", "@b again"));
    expect(rings(w.settle())).toEqual([]);
  });

  it("an idle report or a reattach while over budget does not ring", () => {
    const w = world();
    for (let i = 0; i < BUDGET; i++) w.cycle();
    ok(w.post("a", "t", "over"));
    w.settle();
    expect(rings(w.board.socketAct(w.ws(), "session_state", { state: "idle" }))).toEqual([]);
    expect(rings(w.board.socketAct(w.ws(), "socket_hello", { state: "idle" }))).toEqual([]);
  });

  it("is per user: another agent still rings", () => {
    const w = world();
    for (let i = 0; i < BUDGET; i++) w.cycle();
    // c gets its own socket and a mention; b's budget does not touch it.
    const cs = ok(w.board.act<{ session: string }>(w.ctx("c"), "join", {})).value.session;
    ok(w.board.socketAct({ handle: "c", via: "ws" }, "socket_open", {}));
    ok(w.board.socketAct({ handle: "c", via: "ws", session: cs }, "socket_hello", { state: "idle" }));
    ok(w.post("a", "t", "@b @c both"));
    expect(rings(w.settle()).map((r) => r.recipient)).toEqual(["c"]);
  });

  it("across the window boundary: still over one ms before the end; at the end the held doorbell rings by itself", () => {
    const w = world();
    const start = w.clock.t + DEBOUNCE; // the first ring opens the window
    for (let i = 0; i < BUDGET; i++) w.cycle();
    ok(w.post("a", "t", "held 1"));
    expect(rings(w.settle())).toEqual([]);
    // Over budget: one timer, at the window's end (review M1); more events do not add rings.
    expect(w.sql.all("SELECT due_at FROM timers WHERE kind = 'doorbell'")).toEqual([{ due_at: start + WINDOW }]);
    ok(w.post("a", "t", "held 2"));
    w.clock.t = start + WINDOW - 1;
    expect(rings(w.board.runDueTimers())).toEqual([]);
    expect(w.adminLog()).toHaveLength(1);
    // The window ends: the idle agent, with no new event, is rung once with everything since its last inbox.
    w.clock.t = start + WINDOW;
    const r = rings(w.board.runDueTimers());
    expect(r.map((x) => x.text)).toEqual(["BBS-5000: 2 new in #t. Call bbs_inbox now, then continue your task."]);
    ok(w.delivered(r[0]));
    // That ring opened the next window: two more fit, the third is refused and logged again.
    ok(w.board.act(w.ctx("b"), "inbox", {}));
    expect(w.cycle()).toHaveLength(1);
    expect(w.cycle()).toHaveLength(1);
    expect(w.cycle()).toHaveLength(0);
    expect(w.adminLog()).toHaveLength(2);
    const meta = w.sql.one<{ value: string }>("SELECT value FROM meta WHERE key = 'wake_budget:b'");
    expect(JSON.parse(meta?.value ?? "{}")).toMatchObject({ start: start + WINDOW, rung: BUDGET, logged: true });
  });

  it("an agent offline at the window's end is rung when it attaches", () => {
    const w = world();
    for (let i = 0; i < BUDGET; i++) w.cycle();
    ok(w.post("a", "t", "over"));
    w.settle();
    ok(w.board.socketAct(w.ws(), "socket_close", { session: w.session, code: 1000 }));
    w.clock.advance(WINDOW);
    expect(rings(w.board.runDueTimers())).toEqual([]);
    expect(rings(w.board.socketAct(w.ws(), "socket_hello", { state: "idle" })).map((x) => x.text)).toEqual([
      "BBS-5000: 1 new in #t. Call bbs_inbox now, then continue your task.",
    ]);
  });

  it("counts only delivered rings: an undelivered ring rung again counts once (B51)", () => {
    const w = world();
    const meta = (): { rung?: number } => {
      const row = w.sql.one<{ value: string }>("SELECT value FROM meta WHERE key = 'wake_budget:b'");
      return JSON.parse(row?.value ?? "{}") as { rung?: number };
    };
    ok(w.post("a", "t", "x"));
    const [first] = rings(w.settle());
    // Sent but not yet reported: not counted.
    expect(meta().rung).toBeUndefined();
    ok(w.board.socketAct(w.ws(), "ring_result", { id: first?.id, result: "failed" }));
    w.clock.advance(DEFAULT_CONFIG.doorbellRetryMs[0] ?? 0);
    const [second] = rings(w.board.runDueTimers());
    expect(second).toBeDefined();
    expect(meta().rung).toBeUndefined();
    // A flapping adapter: the ring is lost, the socket reattaches, the ring goes again.
    ok(w.board.socketAct(w.ws(), "socket_close", { session: w.session, code: 1006 }));
    const third = rings(w.board.socketAct(w.ws(), "socket_hello", { state: "idle" }))[0];
    expect(third).toBeDefined();
    expect(meta().rung).toBeUndefined();
    ok(w.delivered(third));
    expect(meta()).toMatchObject({ rung: 1 });
  });

  it("held_busy and failed results do not count; turn_started counts, confirmed or not (B51)", () => {
    const w = world();
    const rung = (): number | undefined => {
      const row = w.sql.one<{ value: string }>("SELECT value FROM meta WHERE key = 'wake_budget:b'");
      return (JSON.parse(row?.value ?? "{}") as { rung?: number }).rung;
    };
    ok(w.post("a", "t", "x"));
    const [first] = rings(w.settle());
    ok(w.board.socketAct(w.ws(), "ring_result", { id: first?.id, result: "held_busy" }));
    expect(rung()).toBeUndefined();
    const [second] = rings(w.board.socketAct(w.ws(), "session_state", { state: "idle" }));
    expect(second).toBeDefined();
    ok(w.delivered(second, false));
    expect(rung()).toBe(1);
    // The unconfirmed delivery rings again at the next idle report: a second delivery, counted again.
    const [third] = rings(w.board.socketAct(w.ws(), "session_state", { state: "idle" }));
    expect(third).toBeDefined();
    ok(w.delivered(third, true));
    expect(rung()).toBe(2);
  });

  it("takes its numbers from the config and validates them", () => {
    expect(DEFAULT_CONFIG.wakeBudgetPerHour).toBe(20);
    expect(DEFAULT_CONFIG.wakeBudgetWindowMs).toBe(60 * 60_000);
    expect(validateConfig({ ...DEFAULT_CONFIG, wakeBudgetWindowMs: 0 })).toMatch(/wakeBudgetWindowMs/);
    expect(validateConfig({ ...DEFAULT_CONFIG, wakeBudgetWindowMs: 24 * 60 * 60_000 + 1 })).toMatch(/at most 1 day/);
    expect(validateConfig({ ...DEFAULT_CONFIG, wakeBudgetPerHour: 0 })).toMatch(/wakeBudgetPerHour/);
    expect(validateConfig({ ...DEFAULT_CONFIG, wakeBudgetPerHour: 10_001 })).toMatch(/at most 10000/);
    const w = world({ wakeBudgetPerHour: 1 });
    expect(w.cycle()).toHaveLength(1);
    expect(w.cycle()).toHaveLength(0);
  });
});

describe("closing a kicked or revoked user's sockets (A4.1, B48)", () => {
  const MIN = 60_000;
  function kick(f: Fixture, h: string): void {
    const flood = (): void => {
      for (let i = 0; i < 50; i++) {
        if (!f.board.act(f.ctx(h), "post", { topic: "Lobby", body: `m${f.clock.t}-${i}` }).ok) return;
      }
    };
    flood();
    f.clock.advance(11 * MIN);
    flood();
    f.clock.advance(61 * MIN);
    f.board.runDueTimers();
    flood();
  }

  it("a kick asks the shell to close the user's sockets; the credential check says kicked", () => {
    const f = makeBoard();
    f.addUser("alice");
    ok(f.board.act(f.ctx("alice"), "join", {}));
    const hash = sha256(f.tokens.get("alice") ?? "");
    expect(f.board.socketCredential("alice", hash)).toBe("ok");
    expect(f.board.socketCredential("alice", sha256("some other token"))).toBe("revoked");
    expect(f.board.socketCredential("nobody", hash)).toBe("revoked");
    f.board.takeDisconnects();
    kick(f, "alice");
    expect(f.board.takeDisconnects()).toEqual([{ handle: "alice", reason: "kicked" }]);
    expect(f.board.takeDisconnects()).toEqual([]);
    expect(f.board.socketCredential("alice", hash)).toBe("kicked");
  });

  it("reinstate (a new token) revokes the old one for sockets; the new one holds", () => {
    const f = makeBoard();
    f.addUser("alice");
    ok(f.board.act(f.ctx("alice"), "join", {}));
    const old = sha256(f.tokens.get("alice") ?? "");
    kick(f, "alice");
    f.board.takeDisconnects();
    const r = ok(f.board.act<{ token: string }>(f.ctx(ADMIN, "cli"), "admin_reinstate", { handle: "alice" }));
    expect(f.board.takeDisconnects()).toEqual([{ handle: "alice", reason: "credential_revoked" }]);
    expect(f.board.socketCredential("alice", old)).toBe("revoked");
    expect(f.board.socketCredential("alice", sha256(r.value.token))).toBe("ok");
  });

  it("a rotated human credential (B17) asks for its sockets closed too", () => {
    const f = makeBoard();
    f.board.takeDisconnects();
    ok(f.board.bootstrapHuman(ADMIN, sha256("a new credential")));
    expect(f.board.takeDisconnects()).toEqual([{ handle: ADMIN, reason: "credential_revoked" }]);
    expect(f.board.socketCredential(ADMIN, sha256(ADMIN_TOKEN))).toBe("revoked");
  });

  it("a refused call queues nothing; a plain post queues nothing", () => {
    const f = makeBoard();
    f.addUser("alice");
    f.board.takeDisconnects();
    expect(f.board.act(f.ctx("alice"), "post", { topic: "nope", body: "x" }).ok).toBe(false);
    ok(f.board.act(f.ctx("alice"), "post", { topic: "Lobby", body: "x" }));
    expect(f.board.takeDisconnects()).toEqual([]);
  });

  it("socketsClosed for one socket detaches only that socket's session (review m1)", () => {
    const f = makeBoard();
    f.addUser("alice");
    const s1 = ok(f.board.act<{ session: string }>(f.ctx("alice"), "join", {})).value.session;
    ok(f.board.socketAct({ handle: "alice", via: "ws" }, "socket_open", {}));
    ok(f.board.socketAct({ handle: "alice", via: "ws", session: s1 }, "socket_hello", {}));
    // A second, stale ws_open row of the same user (another session left open).
    const s2 = ok(f.board.act<{ session: string }>(f.ctx("alice"), "join", {})).value.session;
    f.sql.exec("UPDATE sessions SET ws_open = 1 WHERE handle = 'alice'");
    ok(f.board.socketsClosed("alice", "credential_revoked", 1, 4004, "req-2", s2));
    expect(f.sql.all("SELECT id, ws_open FROM sessions WHERE handle = 'alice' ORDER BY attached_at, id").map((r) => r.ws_open).sort()).toEqual([0, 1]);
    expect(f.sql.one("SELECT ws_open FROM sessions WHERE id = ?", s2)).toEqual({ ws_open: 0 });
    expect(f.sql.one("SELECT ws_open FROM sessions WHERE id = ?", s1)).toEqual({ ws_open: 1 });
    // One socket that never said hello detaches nothing.
    ok(f.board.socketsClosed("alice", "credential_revoked", 1, 4004, "req-3", null));
    expect(f.sql.one("SELECT ws_open FROM sessions WHERE id = ?", s1)).toEqual({ ws_open: 1 });
  });

  it("socketsClosed is audited as the system and detaches the user's open sessions", () => {
    const f = makeBoard();
    f.addUser("alice");
    const s = ok(f.board.act<{ session: string }>(f.ctx("alice"), "join", {})).value.session;
    ok(f.board.socketAct({ handle: "alice", via: "ws" }, "socket_open", {}));
    ok(f.board.socketAct({ handle: "alice", via: "ws", session: s }, "socket_hello", {}));
    ok(f.board.socketsClosed("alice", "credential_revoked", 1, 4004, "req-1"));
    expect(f.sql.one("SELECT ws_open FROM sessions WHERE id = ?", s)).toEqual({ ws_open: 0 });
    const row = f.sql.one<{ actor: string; detail: string; request_id: string }>(
      "SELECT actor, detail, request_id FROM audit WHERE action = 'sockets_closed'",
    );
    expect(row?.actor).toBe("system");
    expect(row?.request_id).toBe("req-1");
    expect(JSON.parse(row?.detail ?? "{}")).toEqual({ reason: "credential_revoked", closed: 1, code: 4004, detached: [s] });
  });
});
