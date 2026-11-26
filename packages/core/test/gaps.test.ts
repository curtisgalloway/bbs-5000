// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * F, test-sufficiency audit: behavior that no unit test reached before F
 * (found from v8 branch coverage of `core/src/actions`, the pre-publication F test audit).
 * Each test names the branch it closes.
 */

import { describe, expect, it } from "vitest";
import { exportColdTopics, MemoryColdStore } from "../src/cold.ts";
import type { ActResult } from "../src/types.ts";
import { ADMIN, makeBoard, sha256, type Fixture } from "./helpers.ts";

const DAY = 24 * 60 * 60_000;

// Loosely typed: these tests read tool values field by field.
function ok(r: ActResult<any>): any {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

function err(r: ActResult): { code: string; message: string; result: string } {
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.value)}`);
  return { ...r.error, result: r.result };
}

/** alice, bob (agents), coord (agent coordinator); #t by alice, bob subscribed. */
function world(): Fixture {
  const f = makeBoard();
  for (const h of ["alice", "bob", "coord"]) f.addUser(h);
  ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "coord" }));
  for (const h of ["alice", "bob", "coord"]) ok(f.board.act(f.ctx(h), "join", {}));
  ok(f.board.act(f.ctx("alice"), "topic_create", { name: "t" }));
  ok(f.board.act(f.ctx("bob"), "subscribe", { topic: "t", level: "wake" }));
  return f;
}

describe("audit filters (audit-read.ts: topic, task, action, since)", () => {
  it("each filter narrows the rows, and they combine", () => {
    const f = world();
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "u" }));
    ok(f.board.act(f.ctx("alice"), "post", { topic: "t", body: "in t" }));
    ok(f.board.act(f.ctx("alice"), "post", { topic: "u", body: "in u" }));
    const id = ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "x" })).task.id as number;
    ok(f.board.act(f.ctx("bob"), "task_claim", { task: id }));
    f.clock.advance(60_000);
    const since = f.clock.t;
    ok(f.board.act(f.ctx("bob"), "task_comment", { task: id, body: "later" }));
    const q = (args: Record<string, unknown>) =>
      ok(f.board.act(f.ctx(ADMIN), "audit", { limit: 500, ...args })).events as { action: string; topic: string | null; target_type: string | null; target_id: string | null; ts: number; actor: string }[];

    const inT = q({ topic: "t" });
    expect(inT.length).toBeGreaterThan(0);
    expect(inT.every((e) => e.topic === "t")).toBe(true);
    expect(inT.map((e) => e.action)).toEqual(expect.arrayContaining(["post", "task_create", "task_claim"]));
    const task = q({ task: id });
    expect(task.map((e) => e.action)).toEqual(["task_create", "task_claim", "task_comment"]);
    expect(task.every((e) => e.target_type === "task" && e.target_id === String(id))).toBe(true);
    expect(q({ action: "post" }).every((e) => e.action === "post")).toBe(true);
    expect(q({ action: "post" }).length).toBeGreaterThanOrEqual(2);
    const late = q({ since });
    expect(late.every((e) => e.ts >= since)).toBe(true);
    expect(late.map((e) => e.action)).toContain("task_comment");
    expect(late.map((e) => e.action)).not.toContain("task_create");
    // Combined: bob's rows on the task after `since`.
    expect(q({ actor: "bob", task: id, since }).map((e) => e.action)).toEqual(["task_comment"]);
    // The audit read is itself audited, carrying the topic filter.
    const own = f.sql.one<{ topic: string | null }>("SELECT topic FROM audit WHERE action = 'audit' ORDER BY seq LIMIT 1");
    expect(own?.topic).toBe("t");
  });
});

describe("topic_keep off (archive.ts)", () => {
  it("ends the exemption, audited before and after", () => {
    const f = world();
    expect(ok(f.board.act(f.ctx("coord"), "topic_keep", { topic: "t", on: true }))).toEqual({ topic: "t", keep: true });
    expect(ok(f.board.act(f.ctx("coord"), "topic_keep", { topic: "t", on: false }))).toEqual({ topic: "t", keep: false });
    expect(f.sql.one("SELECT keep FROM topics WHERE name = 't'")).toEqual({ keep: 0 });
    expect(err(f.board.act(f.ctx("coord"), "topic_keep", { topic: "t" })).code).toBe("bad_request");
    expect(err(f.board.act(f.ctx("alice"), "topic_keep", { topic: "t", on: true })).result).toBe("denied");
  });
});

describe("topic_mark_read needs through_seq (read-mark.ts)", () => {
  it("is refused as a bad request without it", () => {
    const f = world();
    expect(err(f.board.act(f.ctx(ADMIN, "web"), "topic_mark_read", { topic: "t" }))).toMatchObject({
      code: "bad_request",
      message: "through_seq is required",
    });
  });
});

describe("blocker lists (tasks.ts reqBlockerIds)", () => {
  it("takes a single id, drops duplicates, and refuses more than maxBlockersPerCall", () => {
    const f = world();
    const mk = (title: string) => ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title })).task.id as number;
    const a = mk("a");
    const b = mk("b");
    ok(f.board.act(f.ctx("alice"), "task_claim", { task: a }));
    const one = ok(f.board.act(f.ctx("alice"), "task_block", { task: a, blocked_by: b }));
    expect(one.task).toMatchObject({ state: "blocked" });
    const c = mk("c");
    ok(f.board.act(f.ctx("alice"), "task_block", { task: a, blocked_by: [c, c, c] }));
    expect(f.sql.all("SELECT blocked_by FROM task_blocks WHERE task = ? ORDER BY blocked_by", a)).toEqual([
      { blocked_by: b },
      { blocked_by: c },
    ]);
    const max = 20;
    const many = Array.from({ length: max + 1 }, (_, i) => i + 1);
    const f2 = makeBoard({ config: { maxBlockersPerCall: max } });
    f2.addUser("alice");
    ok(f2.board.act(f2.ctx("alice"), "topic_create", { name: "t" }));
    const t = ok(f2.board.act(f2.ctx("alice"), "task_create", { topic: "t", title: "x" })).task.id as number;
    expect(err(f2.board.act(f2.ctx("alice"), "task_block", { task: t, blocked_by: many }))).toMatchObject({
      code: "bad_request",
      message: `at most ${max} blockers per call`,
    });
    expect(err(f.board.act(f.ctx("alice"), "task_block", { task: a, blocked_by: ["1"] })).message).toBe(
      "blocked_by must be a list of task ids",
    );
  });
});

describe("assignment refusals (tasks.ts task_assign)", () => {
  it("refuses a removed (kicked) user and the current assignee", () => {
    const f = world();
    const id = ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "x" })).task.id as number;
    ok(f.board.act(f.ctx("alice"), "task_assign", { task: id, assignee: "bob" }));
    expect(err(f.board.act(f.ctx("alice"), "task_assign", { task: id, assignee: "bob" }))).toMatchObject({
      code: "conflict",
      message: `task ${id} is already assigned to bob`,
    });
    ok(f.board.act(f.ctx("coord"), "subscribe", { topic: "t", level: "wake" }));
    f.sql.exec("UPDATE users SET status = 'kicked' WHERE handle = 'coord'");
    expect(err(f.board.act(f.ctx("alice"), "task_assign", { task: id, assignee: "coord" }))).toMatchObject({
      code: "conflict",
      message: "coord has been removed",
    });
    expect(err(f.board.act(f.ctx("alice"), "task_assign", { task: id, assignee: "nobody" })).code).toBe("not_found");
  });
});

describe("task_comment needs a body (tasks.ts)", () => {
  it("refuses an empty or blank comment", () => {
    const f = world();
    const id = ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "x" })).task.id as number;
    for (const body of ["", "   "]) {
      expect(err(f.board.act(f.ctx("alice"), "task_comment", { task: id, body })).code).toBe("bad_request");
    }
    expect(err(f.board.act(f.ctx("alice"), "task_comment", { body: "no task" }))).toMatchObject({
      code: "bad_request",
      message: "task is required (a task id)",
    });
  });
});

describe("task_list filters (tasks.ts: state, assignee me, stale)", () => {
  it("filters by state, by 'me' and by the stale mark", () => {
    const f = makeBoard({ config: { taskLeaseMs: 60_000 } });
    for (const h of ["alice", "bob"]) f.addUser(h);
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "t" }));
    ok(f.board.act(f.ctx("bob"), "subscribe", { topic: "t", level: "wake" }));
    const mk = (title: string) => ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title })).task.id as number;
    const a = mk("a");
    const b = mk("b");
    mk("c");
    ok(f.board.act(f.ctx("bob"), "task_claim", { task: a }));
    ok(f.board.act(f.ctx("bob"), "task_update", { task: a, state: "in_progress" }));
    ok(f.board.act(f.ctx("alice"), "task_claim", { task: b }));
    const ids = (args: Record<string, unknown>, who = "bob") =>
      (ok(f.board.act(f.ctx(who), "task_list", args)).tasks as { id: number }[]).map((t) => t.id).sort();
    expect(ids({ state: "open" })).toEqual([3]);
    expect(ids({ assignee: "me" })).toEqual([a]);
    expect(ids({ assignee: "me" }, "alice")).toEqual([b]);
    expect(ids({ stale: true })).toEqual([]);
    f.clock.advance(60_000);
    f.board.runDueTimers();
    expect(ids({ stale: true })).toEqual([a]);
    expect(ids({ stale: false, topic: "t" })).toEqual([1, 2, 3].filter((x) => x !== a));
  });
});

describe("re-join with your own live session (users.ts join)", () => {
  it("updates role and harness in place, audited before and after, with no second Lobby message", () => {
    const f = world();
    const s = ok(f.board.act(f.ctx("alice"), "join", { role: "first" })).session as string;
    const lobbyBefore = f.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE topic = 'Lobby'")!.n;
    const r = ok(f.board.act({ ...f.ctx("alice"), session: s }, "join", { role: "second", harness: "claude-desktop" }));
    expect(r).toMatchObject({ handle: "alice", role: "second", session: s, first_join: false });
    expect(f.sql.one("SELECT role, harness FROM users WHERE handle = 'alice'")).toEqual({ role: "second", harness: "claude-desktop" });
    const row = f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE action = 'join' AND session = ? ORDER BY seq DESC LIMIT 1", s)!;
    expect(JSON.parse(row.detail)).toMatchObject({
      rejoined: true,
      role: { before: "first", after: "second" },
      harness: { before: "claude-code", after: "claude-desktop" },
    });
    expect(f.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE topic = 'Lobby'")!.n).toBe(lobbyBefore);
    // The session was kept, not replaced.
    expect(f.sql.one("SELECT state FROM sessions WHERE id = ?", s)).toMatchObject({ state: expect.not.stringMatching(/^gone$/) });
  });
});

describe("cold export when the topic changes while the object is written (cold.ts confirm refused)", () => {
  it("an unarchive during the write refuses the confirm: rows kept, failure recorded, no tight retry", async () => {
    const f = world();
    ok(f.board.act(f.ctx("alice"), "post", { topic: "t", body: "keep me" }));
    ok(f.board.act(f.ctx("coord"), "topic_archive", { topic: "t", reason: "quiet" }));
    f.clock.advance(90 * DAY);
    const inner = new MemoryColdStore(sha256);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = {
      put: async (key: string, body: string, sha: string) => {
        await gate;
        return inner.put(key, body, sha);
      },
      get: (key: string) => inner.get(key),
    };
    const running = exportColdTopics(f.board, store, 1);
    // The write is in flight; a coordinator unarchives meanwhile.
    await Promise.resolve();
    ok(f.board.act(f.ctx("coord"), "topic_unarchive", { topic: "t" }));
    release();
    const r = await running;
    expect(r.done).toEqual([]);
    expect(r.failed).toEqual([{ topic: "t", error: expect.stringMatching(/not archived/) }]);
    expect(f.sql.one("SELECT state FROM topics WHERE name = 't'")).toEqual({ state: "active" });
    expect(f.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE topic = 't'")!.n).toBe(1);
    const failed = f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE action = 'topic_cold_failed' ORDER BY seq DESC LIMIT 1")!;
    expect(JSON.parse(failed.detail).error).toMatch(/^confirm refused/);
    // An active topic is not due for cold export at all.
    expect(f.board.nextColdExportDue()).toBeNull();
    expect(f.board.verifyAudit()).toMatchObject({ ok: true });
  });
});

describe("size and page limits come from the config (A4.5, every BoardConfig cap)", () => {
  it("enforces each length cap and page limit at the configured value", () => {
    const f = makeBoard({
      config: {
        maxBodyLength: 10,
        maxRoleLength: 5,
        maxDescriptionLength: 6,
        readDefaultLimit: 2,
        readMaxLimit: 3,
        inboxDefaultLimit: 2,
        inboxMaxLimit: 3,
        auditDefaultLimit: 2,
        auditMaxLimit: 3,
        maxTaskTitleLength: 7,
        maxTaskCommentLength: 8,
        taskListDefaultLimit: 2,
        taskListMaxLimit: 3,
      },
    });
    f.addUser("alice");
    f.addUser("bob");
    ok(f.board.act(f.ctx("bob"), "join", {}));
    const a = f.ctx("alice");
    const refused = (action: string, params: Record<string, unknown>) => err(f.board.act(a, action, params)).code;

    expect(refused("join", { role: "toolong" })).toBe("bad_request");
    ok(f.board.act(a, "join", { role: "short" }));
    expect(refused("topic_create", { name: "t", description: "1234567" })).toBe("bad_request");
    ok(f.board.act(a, "topic_create", { name: "t", description: "123456" }));
    ok(f.board.act(f.ctx("bob"), "subscribe", { topic: "t", level: "wake" }));
    expect(refused("post", { topic: "t", body: "12345678901" })).toBe("bad_request");
    for (let i = 0; i < 5; i++) ok(f.board.act(a, "post", { topic: "t", body: `m${i}` }));
    expect(ok(f.board.act(a, "read", { topic: "t" })).messages).toHaveLength(2);
    expect(ok(f.board.act(a, "read", { topic: "t", limit: 3 })).messages).toHaveLength(3);
    expect(refused("read", { topic: "t", limit: 4 })).toBe("bad_request");
    const bobInbox = (limit?: number) => f.board.act(f.ctx("bob"), "inbox", limit === undefined ? {} : { limit });
    expect(err(bobInbox(4)).code).toBe("bad_request");
    expect(ok(bobInbox()).wake).toHaveLength(2);
    expect(refused("task_create", { topic: "t", title: "12345678" })).toBe("bad_request");
    for (let i = 0; i < 4; i++) ok(f.board.act(a, "task_create", { topic: "t", title: `x${i}` }));
    expect(refused("task_comment", { task: 1, body: "123456789" })).toBe("bad_request");
    ok(f.board.act(a, "task_comment", { task: 1, body: "12345678" }));
    expect(ok(f.board.act(a, "task_list", {})).tasks).toHaveLength(2);
    expect(ok(f.board.act<any>(a, "task_list", { limit: 3 })).tasks).toHaveLength(3);
    expect(refused("task_list", { limit: 4 })).toBe("bad_request");
    const h = f.ctx(ADMIN);
    expect(ok(f.board.act<any>(h, "audit", {})).events).toHaveLength(2);
    expect(ok(f.board.act<any>(h, "audit", { limit: 3 })).events).toHaveLength(3);
    expect(err(f.board.act(h, "audit", { limit: 4 })).code).toBe("bad_request");
  });
});

describe("archive scan cap (archiveScanMaxTopics)", () => {
  it("one scan takes at most archiveScanMaxTopics candidates; the rest wait for the next scan", () => {
    const f = makeBoard({ config: { archiveScanMaxTopics: 2 } });
    f.addUser("alice");
    for (const n of ["a", "b", "c"]) ok(f.board.act(f.ctx("alice"), "topic_create", { name: n }));
    expect(f.board.ensureArchiveScan()).not.toBeNull();
    f.clock.advance(27 * DAY);
    f.board.runDueTimers();
    const noticed = () => (f.sql.all("SELECT name FROM topics WHERE archive_notice_at IS NOT NULL ORDER BY name") as { name: string }[]).map((r) => r.name);
    expect(noticed()).toHaveLength(2);
    f.clock.advance(60 * 60_000);
    f.board.runDueTimers();
    // Waiting topics still count toward the cap (B54), so the third waits until the first two are archived.
    expect(noticed()).toHaveLength(2);
    f.clock.advance(3 * DAY);
    f.board.runDueTimers();
    expect((f.sql.all("SELECT name FROM topics WHERE state = 'archived' ORDER BY name") as unknown[]).length).toBe(2);
    f.clock.advance(60 * 60_000);
    f.board.runDueTimers();
    // The third, never noticed yet, is noticed by the next scan.
    expect(f.sql.all("SELECT name FROM topics WHERE state = 'active' AND archive_notice_at IS NOT NULL")).toHaveLength(1);
    expect(f.board.verifyAudit()).toMatchObject({ ok: true });
  });
});

describe("small task paths (tasks.ts)", () => {
  it("blocking again with only existing blockers adds no comment; assigning a task blocked from review keeps in_review to return to", () => {
    const f = world();
    const mk = (title: string) => ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title })).task.id as number;
    const a = mk("a");
    const b = mk("b");
    ok(f.board.act(f.ctx("alice"), "task_claim", { task: a }));
    ok(f.board.act(f.ctx("alice"), "task_update", { task: a, state: "in_progress" }));
    ok(f.board.act(f.ctx("alice"), "task_update", { task: a, state: "in_review" }));
    ok(f.board.act(f.ctx("alice"), "task_block", { task: a, blocked_by: [b] }));
    const comments = () => f.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM task_comments WHERE task = ?", a)!.n;
    const before = comments();
    const again = ok(f.board.act(f.ctx("alice"), "task_block", { task: a, blocked_by: [b] }));
    expect(again.added).toEqual([]);
    expect(comments()).toBe(before);
    // Reassigned while blocked from in_review: it returns to in_review, not assigned.
    ok(f.board.act(f.ctx("alice"), "task_assign", { task: a, assignee: "bob" }));
    expect(f.sql.one("SELECT state, prior_state, assignee FROM tasks WHERE id = ?", a)).toEqual({
      state: "blocked",
      prior_state: "in_review",
      assignee: "bob",
    });
    ok(f.board.act(f.ctx("alice"), "task_update", { task: b, state: "cancelled" }));
    ok(f.board.act(f.ctx("bob"), "task_unblock", { task: a, blocked_by: b }));
    expect(f.sql.one("SELECT state FROM tasks WHERE id = ?", a)).toEqual({ state: "in_review" });
    // task_list by a named assignee (not "me").
    const listed = ok(f.board.act(f.ctx("alice"), "task_list", { assignee: "bob" })).tasks as { id: number }[];
    expect(listed.map((t) => t.id)).toEqual([a]);
  });
});

describe("independent review additions (F review)", () => {
  it("N16: a handle mentioned twice (any case) is one mention; repeats do not use up the candidate cap", () => {
    const f = world();
    const r = ok(f.board.act(f.ctx("alice"), "post", { topic: "t", body: "@bob @Bob @bob look" }));
    expect(r.mentions).toEqual(["bob"]);
    // 600 repeats of one name, then a second name: still found (500 distinct candidates at most).
    const r2 = ok(f.board.act(f.ctx("alice"), "post", { topic: "t", body: `${"@bob ".repeat(600)}@coord` }));
    expect(r2.mentions).toEqual(["bob", "coord"]);
    expect(f.sql.all("SELECT handle FROM message_mentions WHERE seq = ? ORDER BY handle", r2.seq)).toEqual([
      { handle: "bob" },
      { handle: "coord" },
    ]);
  });

  it("bootstrap_human refuses a token hash that is not 64 lowercase hex digits, and audits it", () => {
    const f = world();
    for (const bad of ["A".repeat(64), "0".repeat(63), "g".repeat(64), ""]) {
      const r = f.board.bootstrapHuman("owner9", bad);
      expect(r, bad).toMatchObject({ ok: false, error: { code: "bad_request" } });
      expect(f.auditRows().at(-1), bad).toMatchObject({ action: "bootstrap_human", result: "error" });
    }
    expect(f.sql.one("SELECT handle FROM users WHERE handle = 'owner9'")).toBeUndefined();
  });
});
