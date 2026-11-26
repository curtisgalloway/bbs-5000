// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * M6b: topic archiving (design §14) — manual archive and its refusals, force
 * for human admins only (B37), the archived-topic error text, the archive
 * scan's four conditions and its notice that wakes nobody, cold export to a
 * store with the delete only after the write, and restore.
 */

import { describe, expect, it } from "vitest";
import { callToolWithCold, MemoryColdStore } from "../src/cold.ts";
import { coldBody, coldKey, parseColdBody, readColdContent } from "../src/cold-object.ts";
import { Board } from "../src/act.ts";
import { exportColdTopics } from "../src/cold.ts";
import type { ActResult, BoardConfig } from "../src/types.ts";
import { ADMIN, makeBoard, RecordingSql, sha256, type Fixture } from "./helpers.ts";

const DAY = 24 * 60 * 60_000;

function ok<T>(r: ActResult<T>): Extract<ActResult<T>, { ok: true }> {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r;
}

function err(r: ActResult): { code: string; message: string; result: string } {
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.value)}`);
  return { ...r.error, result: r.result };
}

/** alice (agent), bob (agent), coord (agent coordinator), pat (person, no flags); topic t by alice. */
function world(config?: Partial<BoardConfig>): Fixture {
  const f = makeBoard(config ? { config } : {});
  for (const h of ["alice", "bob", "coord"]) f.addUser(h);
  f.addUser("pat", "human");
  ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "coord" }));
  for (const h of ["alice", "bob", "coord"]) ok(f.board.act(f.ctx(h), "join", {}));
  ok(f.board.act(f.ctx("alice"), "topic_create", { name: "t" }));
  ok(f.board.act(f.ctx("bob"), "subscribe", { topic: "t", level: "wake" }));
  return f;
}

const topicRow = (f: Fixture, name = "t") => f.sql.one<Record<string, unknown>>("SELECT * FROM topics WHERE name = ?", name)!;
const count = (f: Fixture, q: string, ...p: (string | number)[]) => Number(f.sql.one<{ n: number }>(q, ...p)?.n ?? 0);

describe("manual archive (design §14)", () => {
  it("is open to a coordinator (agent or person) and a human admin; reason required; Lobby and #admin-log never", () => {
    const f = world();
    expect(err(f.board.act(f.ctx("alice"), "topic_archive", { topic: "t", reason: "done" }))).toMatchObject({
      code: "forbidden",
      result: "denied",
      message: "only a coordinator or a human admin can archive a topic",
    });
    expect(err(f.board.act(f.ctx("pat"), "topic_archive", { topic: "t", reason: "done" })).code).toBe("forbidden");
    expect(err(f.board.act(f.ctx("coord"), "topic_archive", { topic: "t" })).code).toBe("bad_request");
    expect(err(f.board.act(f.ctx("coord"), "topic_archive", { topic: "t", reason: "  " })).code).toBe("bad_request");
    expect(err(f.board.act(f.ctx(ADMIN), "topic_archive", { topic: "Lobby", reason: "x" })).message).toBe("#Lobby is never archived");
    expect(err(f.board.act(f.ctx(ADMIN), "topic_archive", { topic: "admin-log", reason: "x" })).message).toBe(
      "#admin-log is never archived",
    );
    const r = ok(f.board.act(f.ctx("coord"), "topic_archive", { topic: "t", reason: "finished" }));
    expect(r.value).toMatchObject({ topic: "t", state: "archived", archived_by: "coord", cancelled: [] });
    expect(topicRow(f)).toMatchObject({ state: "archived", archived_by: "coord", archive_reason: "finished", archived_at: f.clock.t });
    expect(err(f.board.act(f.ctx("coord"), "topic_archive", { topic: "t", reason: "again" })).message).toBe("#t is already archived");
    // A person coordinator may archive too.
    ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "pat" }));
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "u" }));
    ok(f.board.act(f.ctx("pat"), "topic_archive", { topic: "u", reason: "r" }));
    // Hidden from the default topic list, shown with include_archived.
    const names = (v: unknown) => (v as { topics: { name: string; state: string }[] }).topics.map((t) => `${t.name}:${t.state}`);
    expect(names(ok(f.board.act(f.ctx("bob"), "topics", {})).value)).not.toContain("t:archived");
    expect(names(ok(f.board.act(f.ctx("bob"), "topics", { include_archived: true })).value)).toContain("t:archived");
  });

  it("is refused with unfinished tasks, listing them; finished ones do not count", () => {
    const f = world();
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "a" }));
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "b" }));
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "c" }));
    ok(f.board.act(f.ctx("alice"), "task_claim", { task: 2 }));
    ok(f.board.act(f.ctx("alice"), "task_update", { task: 3, state: "cancelled" }));
    const e = err(f.board.act(f.ctx("coord"), "topic_archive", { topic: "t", reason: "done" }));
    expect(e).toEqual({
      code: "conflict",
      result: "error",
      message: "#t has unfinished tasks: 1 (open), 2 (assigned). Finish, cancel or move them first.",
    });
    expect(topicRow(f).state).toBe("active");
    // The same for the human admin without force.
    expect(err(f.board.act(f.ctx(ADMIN), "topic_archive", { topic: "t", reason: "done" })).code).toBe("conflict");
  });

  it("force is refused for every agent, a coordinator included, and for a person without admin (B37)", () => {
    const f = world();
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "a" }));
    for (const who of ["coord", "alice"]) {
      for (const via of ["mcp", "api"] as const) {
        expect(err(f.board.act(f.ctx(who, via), "topic_archive", { topic: "t", reason: "x", force: true }))).toMatchObject({
          code: "forbidden",
          result: "denied",
          message: "force is a human admin power; agents (coordinators included) cannot use it",
        });
      }
    }
    // Refused even when there is nothing to cancel.
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "empty" }));
    expect(err(f.board.act(f.ctx("coord"), "topic_archive", { topic: "empty", reason: "x", force: true })).code).toBe("forbidden");
    ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "pat" }));
    expect(err(f.board.act(f.ctx("pat"), "topic_archive", { topic: "t", reason: "x", force: true })).code).toBe("forbidden");
    expect(topicRow(f).state).toBe("active");
    const denied = f.sql.all<{ actor: string; result: string }>(
      "SELECT actor, result FROM audit WHERE action = 'topic_archive' ORDER BY seq",
    );
    expect(denied.every((r) => r.result === "denied")).toBe(true);
    expect(denied.map((r) => r.actor)).toEqual(["coord", "coord", "alice", "alice", "coord", "pat"]);
  });

  it("a human admin's force cancels unfinished tasks with the reason, tells assignees and the coordinator", () => {
    const f = world();
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "other" }));
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "a" })); // 1
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "b" })); // 2
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "other", title: "c" })); // 3
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "d" })); // 4
    ok(f.board.act(f.ctx("bob"), "task_claim", { task: 1 }));
    ok(f.board.act(f.ctx("bob"), "task_update", { task: 1, state: "in_progress" }));
    ok(f.board.act(f.ctx("alice"), "task_claim", { task: 3 }));
    ok(f.board.act(f.ctx("alice"), "task_block", { task: 3, blocked_by: [2] }));
    ok(f.board.act(f.ctx("alice"), "task_update", { task: 4, state: "cancelled" }));
    const r = ok(f.board.act(f.ctx(ADMIN), "topic_archive", { topic: "t", reason: "project dropped", force: true }));
    expect(r.value).toMatchObject({ state: "archived", cancelled: [1, 2] });
    for (const id of [1, 2]) {
      const task = f.sql.one<{ state: string; lease_expires_at: number | null }>("SELECT state, lease_expires_at FROM tasks WHERE id = ?", id);
      expect(task).toEqual({ state: "cancelled", lease_expires_at: null });
      expect(f.sql.one("SELECT author, body, state_change FROM task_comments WHERE task = ? ORDER BY id DESC LIMIT 1", id)).toMatchObject({
        author: ADMIN,
        body: "project dropped",
      });
    }
    expect(f.sql.one("SELECT COUNT(*) AS n FROM timers WHERE kind = 'lease'")).toEqual({ n: 0 });
    const notes = r.notifications
      .filter((n) => n.type === "task")
      .map((n) => (n.type === "task" ? `${n.recipient}:${n.as}:${n.reason}:${n.task}` : ""))
      .sort();
    expect(notes).toEqual(
      [
        "bob:assignee:task_comment:1",
        "coord:coordinator:task_comment:1",
        "coord:coordinator:task_comment:2",
        // Task 3 in #other was blocked by 2: it stays blocked; its assignee and the coordinator are told.
        "alice:assignee:blocker_cancelled:3",
        "coord:coordinator:blocker_cancelled:3",
      ].sort(),
    );
    // Stored for bbs_inbox (M2), in the same transaction.
    expect(count(f, "SELECT COUNT(*) AS n FROM notices WHERE handle = 'bob'")).toBe(1);
    const row = f.sql.one<{ detail: string; actor: string }>("SELECT actor, detail FROM audit WHERE action = 'topic_archive' AND result = 'ok'")!;
    expect(row.actor).toBe(ADMIN);
    expect(JSON.parse(row.detail)).toMatchObject({ force: true, cancelled: [1, 2], before: "active", after: "archived" });
    expect(f.board.verifyAudit()).toMatchObject({ ok: true });
  });
});

describe("archived topics (design §14 Effects)", () => {
  it("a post or task change returns the design's text; reads still work; unarchive and keep", () => {
    const f = world();
    ok(f.board.act(f.ctx("alice"), "post", { topic: "t", body: "hello" }));
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "a" }));
    ok(f.board.act(f.ctx("alice"), "task_update", { task: 1, state: "cancelled" }));
    ok(f.board.act(f.ctx("coord"), "topic_archive", { topic: "t", reason: "done" }));
    const text = "Topic archived on 2026-11-20 by coord. Ask a coordinator to unarchive it.";
    expect(err(f.board.act(f.ctx("bob"), "post", { topic: "t", body: "hi" }))).toEqual({ code: "topic_archived", result: "error", message: text });
    expect(err(f.board.act(f.ctx("bob"), "task_create", { topic: "t", title: "x" })).message).toBe(text);
    expect(err(f.board.act(f.ctx("bob"), "task_comment", { task: 1, body: "x" })).message).toBe(text);
    const read = ok(f.board.act<{ state: string; messages: unknown[] }>(f.ctx("bob"), "read", { topic: "t" }));
    expect(read.value).toMatchObject({ state: "archived" });
    expect(read.value.messages).toHaveLength(1);
    // Unarchive: same roles.
    expect(err(f.board.act(f.ctx("alice"), "topic_unarchive", { topic: "t" })).code).toBe("forbidden");
    f.clock.advance(1_000);
    ok(f.board.act(f.ctx(ADMIN), "topic_unarchive", { topic: "t" }));
    expect(topicRow(f)).toMatchObject({ state: "active", archived_at: null, archived_by: null, last_activity_at: f.clock.t });
    expect(err(f.board.act(f.ctx(ADMIN), "topic_unarchive", { topic: "t" })).message).toBe("#t is not archived");
    ok(f.board.act(f.ctx("bob"), "post", { topic: "t", body: "back" }));
    // Keep: same roles, needs on.
    expect(err(f.board.act(f.ctx("alice"), "topic_keep", { topic: "t", on: true })).code).toBe("forbidden");
    expect(err(f.board.act(f.ctx("coord"), "topic_keep", { topic: "t" })).code).toBe("bad_request");
    ok(f.board.act(f.ctx("coord"), "topic_keep", { topic: "t", on: true }));
    expect(topicRow(f).keep).toBe(1);
  });
});

describe("topic describe (agent defaults)", () => {
  it("is open to the creator, a coordinator and a human admin; never the Lobby or #admin-log; active topics only", () => {
    const f = world();
    expect(err(f.board.act(f.ctx("bob"), "topic_describe", { topic: "t", description: "x" }))).toMatchObject({
      code: "forbidden",
      result: "denied",
    });
    expect(err(f.board.act(f.ctx("pat"), "topic_describe", { topic: "t", description: "x" })).code).toBe("forbidden");
    expect(err(f.board.act(f.ctx("alice"), "topic_describe", { topic: "t" })).code).toBe("bad_request");
    ok(f.board.act(f.ctx("alice"), "topic_describe", { topic: "t", description: "Repos: a" }));
    expect(topicRow(f).description).toBe("Repos: a");
    ok(f.board.act(f.ctx("coord"), "topic_describe", { topic: "#t", description: "Repos: a, b" }));
    ok(f.board.act(f.ctx(ADMIN), "topic_describe", { topic: "t", description: "" }));
    expect(topicRow(f).description).toBe("");
    expect(err(f.board.act(f.ctx(ADMIN), "topic_describe", { topic: "Lobby", description: "x" })).code).toBe("forbidden");
    expect(err(f.board.act(f.ctx("coord"), "topic_describe", { topic: "admin-log", description: "x" })).code).toBe("forbidden");
    ok(f.board.act(f.ctx("coord"), "topic_archive", { topic: "t", reason: "done" }));
    expect(err(f.board.act(f.ctx("coord"), "topic_describe", { topic: "t", description: "x" })).code).toBe("conflict");
    const rows = f.sql.all<{ result: string }>("SELECT result FROM audit WHERE action = 'topic_describe' ORDER BY seq");
    expect(rows.map((r) => r.result)).toEqual(["denied", "denied", "error", "ok", "ok", "ok", "denied", "denied", "error"]);
  });
});

describe("automatic archiving (design §14)", () => {
  /** World with the scan armed; `bob` is attached (live idle socket) and subscribed at wake to t. */
  function auto(config?: Partial<BoardConfig>) {
    const f = world(config);
    const s = ok(f.board.act<{ session: string }>(f.ctx("bob"), "join", {})).value.session;
    ok(f.board.socketAct({ handle: "bob", via: "ws" }, "socket_open", {}));
    ok(f.board.socketAct({ handle: "bob", via: "ws", session: s }, "socket_hello", { harness: "claude-code", machine: "workstation-1", state: "idle" }));
    ok(f.board.act(f.ctx("bob"), "inbox", {}));
    f.sql.exec("DELETE FROM doorbells");
    expect(f.board.ensureArchiveScan()).not.toBeNull();
    expect(f.board.ensureArchiveScan()).toBeNull();
    const scan = (days: number) => {
      f.clock.advance(days * DAY);
      return f.board.runDueTimers();
    };
    return { f, scan, t0: f.clock.t };
  }

  it("posts the notice three days before (no doorbell), then archives as system after thirty days idle", () => {
    const { f, scan } = auto();
    scan(26);
    expect(count(f, "SELECT COUNT(*) AS n FROM messages WHERE topic = 't'")).toBe(0);
    const at27 = scan(1);
    const msg = f.sql.one<{ author: string; is_system: number; body: string; seq: number }>(
      "SELECT seq, author, is_system, body FROM messages WHERE topic = 't'",
    )!;
    expect(msg).toMatchObject({ author: "system", is_system: 1 });
    expect(msg.body).toMatch(/^This topic will be archived on or after 2026-12-20 \(UTC\) after 30 days without a message or task change\./);
    // It wakes nobody: no doorbell for the wake subscriber with a live idle session, no ring.
    expect(f.sql.all("SELECT * FROM doorbells")).toEqual([]);
    expect(at27.flatMap((r) => r.notifications)).toEqual([]);
    // ...and does not reset the clock it warns about.
    expect(topicRow(f).archive_notice_at).toBe(f.clock.t);
    // Subscribers see it at their next inbox.
    const inbox = ok(f.board.act<{ wake: { seq: number }[] }>(f.ctx("bob"), "inbox", {}));
    expect(JSON.stringify(inbox.value)).toContain(String(msg.seq));
    scan(2);
    expect(topicRow(f).state).toBe("active");
    scan(1);
    expect(topicRow(f)).toMatchObject({ state: "archived", archived_by: "system", archive_reason: "no message or task change for 30 days" });
    expect(f.sql.all("SELECT action, actor FROM audit WHERE action IN ('archive_notice', 'topic_auto_archive') ORDER BY seq")).toEqual([
      { action: "archive_notice", actor: "system" },
      { action: "topic_auto_archive", actor: "system" },
    ]);
    // Control: a normal post in a wake topic does start a doorbell for bob.
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "live" }));
    ok(f.board.act(f.ctx("bob"), "subscribe", { topic: "live", level: "wake" }));
    ok(f.board.act(f.ctx("alice"), "post", { topic: "live", body: "x" }));
    expect(f.sql.one("SELECT handle FROM doorbells")).toEqual({ handle: "bob" });
    // The Lobby and #admin-log are never archived.
    expect(f.sql.all("SELECT name FROM topics WHERE state <> 'active' ORDER BY name")).toEqual([{ name: "t" }]);
    expect(f.board.verifyAudit()).toMatchObject({ ok: true });
  });

  it("any post after the notice resets the clock; a new notice comes before archiving", () => {
    const { f, scan } = auto();
    scan(27);
    expect(topicRow(f).archive_notice_at).not.toBeNull();
    ok(f.board.act(f.ctx("bob"), "post", { topic: "t", body: "still here" }));
    scan(3);
    expect(topicRow(f).state).toBe("active");
    scan(23);
    expect(count(f, "SELECT COUNT(*) AS n FROM messages WHERE topic = 't' AND is_system = 1")).toBe(1);
    scan(1); // 27 days after the post: second notice
    expect(count(f, "SELECT COUNT(*) AS n FROM messages WHERE topic = 't' AND is_system = 1")).toBe(2);
    scan(3);
    expect(topicRow(f).state).toBe("archived");
  });

  it("does nothing unless all four conditions hold", () => {
    const { f, scan } = auto();
    // Condition 2: an unfinished task.
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "open" }));
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "open", title: "x" }));
    // Condition 3: a task in another topic is blocked by one of its tasks (cancelled blocker).
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "blocker" }));
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "waiter" }));
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "blocker", title: "b" })); // 2
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "waiter", title: "w" })); // 3
    ok(f.board.act(f.ctx("alice"), "task_claim", { task: 3 }));
    ok(f.board.act(f.ctx("alice"), "task_block", { task: 3, blocked_by: [2] }));
    ok(f.board.act(f.ctx("alice"), "task_update", { task: 2, state: "cancelled" }));
    // Condition 4: keep.
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "kept" }));
    ok(f.board.act(f.ctx("coord"), "topic_keep", { topic: "kept", on: true }));
    // Condition 1: a task change counts as activity (comment at day 20 on a finished task in "recent").
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "recent" }));
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "recent", title: "r" })); // 4
    ok(f.board.act(f.ctx("alice"), "task_update", { task: 4, state: "cancelled" }));
    scan(20);
    ok(f.board.act(f.ctx("alice"), "task_comment", { task: 4, body: "note" }));
    scan(7);
    scan(3);
    const states = Object.fromEntries(
      f.sql.all<{ name: string; state: string }>("SELECT name, state FROM topics").map((r) => [r.name, r.state]),
    );
    expect(states).toEqual({
      Lobby: "active",
      "admin-log": "active",
      t: "archived",
      open: "active",
      blocker: "active",
      waiter: "active",
      kept: "active",
      recent: "active",
    });
    // "waiter" is idle too but has an unfinished (blocked) task: condition 2.
    const noticed = f.sql.all<{ topic: string }>("SELECT DISTINCT topic FROM messages WHERE is_system = 1 AND topic NOT IN ('Lobby', 'admin-log') ORDER BY topic");
    expect(noticed).toEqual([{ topic: "t" }]);
    // "recent": notice at day 47 (27 after the comment), archived at day 50.
    scan(17);
    expect(topicRow(f, "recent").state).toBe("active");
    scan(3);
    expect(topicRow(f, "recent").state).toBe("archived");
    // Unblocking the waiter lets "blocker" age out too (its own clock is long past).
    ok(f.board.act(f.ctx("alice"), "task_unblock", { task: 3, blocked_by: 2 }));
    ok(f.board.act(f.ctx("alice"), "task_update", { task: 3, state: "cancelled" }));
    scan(1);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM messages WHERE topic = 'blocker' AND is_system = 1")).toEqual({ n: 1 });
    scan(3);
    expect(topicRow(f, "blocker").state).toBe("archived");
  });

  it("refuses an archiveNoticeMs not shorter than archiveIdleMs", () => {
    expect(() => makeBoard({ config: { archiveIdleMs: DAY, archiveNoticeMs: DAY } })).toThrow(/archiveNoticeMs/);
  });
});

describe("cold storage (design §14 cold, R2)", () => {
  /** t with messages (one @mention), tasks, comments, blocks (one to #other), archived by coord. */
  function coldWorld() {
    const f = world();
    const store = new MemoryColdStore(sha256);
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "other" }));
    ok(f.board.act(f.ctx("alice"), "post", { topic: "t", body: "first" }));
    ok(f.board.act(f.ctx("bob"), "post", { topic: "t", body: "hey @alice" }));
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "a", description: "d" })); // 1
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "b" })); // 2
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "other", title: "o" })); // 3
    ok(f.board.act(f.ctx("bob"), "task_claim", { task: 1 }));
    ok(f.board.act(f.ctx("bob"), "task_block", { task: 1, blocked_by: [2] }));
    ok(f.board.act(f.ctx("alice"), "task_claim", { task: 3 }));
    ok(f.board.act(f.ctx("alice"), "task_block", { task: 3, blocked_by: [2] }));
    ok(f.board.act(f.ctx("alice"), "task_comment", { task: 2, body: "on it" }));
    ok(f.board.act(f.ctx("alice"), "task_update", { task: 2, state: "cancelled" }));
    ok(f.board.act(f.ctx("bob"), "task_update", { task: 1, state: "cancelled" }));
    ok(f.board.act(f.ctx("alice"), "task_update", { task: 3, state: "cancelled" }));
    ok(f.board.act(f.ctx("coord"), "topic_archive", { topic: "t", reason: "done" }));
    const archivedAt = f.clock.t;
    const before = readColdContent(f.sql, "t");
    return { f, store, archivedAt, before };
  }

  it("goes cold after coldAfterMs: object at topics/<name>/<archived_at>.ndjson, then rows deleted in one transaction", async () => {
    const { f, store, archivedAt, before } = coldWorld();
    const noticesBefore = count(f, "SELECT COUNT(*) AS n FROM notices WHERE json_extract(detail, '$.topic') = 't'");
    expect(noticesBefore).toBeGreaterThan(0);
    expect(before.header.counts).toEqual({ messages: 2, tasks: 2, comments: before.comments.length, blocks: 2 });
    expect(f.board.nextColdExportDue()).toBe(archivedAt + 90 * DAY);
    f.clock.advance(90 * DAY - 1);
    expect(await exportColdTopics(f.board, store)).toEqual({ done: [], failed: [] });
    f.clock.advance(1);
    expect(await exportColdTopics(f.board, store)).toEqual({ done: ["t"], failed: [] });
    const key = coldKey("t", archivedAt);
    expect(key).toBe(`topics/t/${archivedAt}.ndjson`);
    const obj = store.objects.get(key)!;
    expect(parseColdBody(obj.body)).toEqual(before);
    // The object is the body built from the SQLite snapshot taken before (independent of the store's own hash).
    expect(obj.body).toBe(coldBody(before));
    expect(topicRow(f).cold_sha256).toBe(sha256(coldBody(before)));
    // Gone from SQLite, with mentions, comments and blocks; subscriptions, notices (review m4) and the stub kept.
    expect(count(f, "SELECT COUNT(*) AS n FROM messages WHERE topic = 't'")).toBe(0);
    expect(count(f, "SELECT COUNT(*) AS n FROM tasks WHERE topic = 't'")).toBe(0);
    expect(count(f, "SELECT COUNT(*) AS n FROM task_comments WHERE task IN (1, 2)")).toBe(0);
    expect(count(f, "SELECT COUNT(*) AS n FROM task_blocks")).toBe(0);
    expect(count(f, "SELECT COUNT(*) AS n FROM message_mentions WHERE handle = 'alice'")).toBe(0);
    expect(count(f, "SELECT COUNT(*) AS n FROM notices WHERE json_extract(detail, '$.topic') = 't'")).toBe(noticesBefore);
    expect(count(f, "SELECT COUNT(*) AS n FROM subscriptions WHERE topic = 't'")).toBe(2);
    expect(topicRow(f)).toMatchObject({ state: "cold", cold_key: key, cold_sha256: obj.sha256, archived_by: "coord" });
    // #other's task and its comments stay.
    expect(count(f, "SELECT COUNT(*) AS n FROM tasks WHERE id = 3")).toBe(1);
    const audit = f.sql.one<{ detail: string; actor: string }>("SELECT actor, detail FROM audit WHERE action = 'topic_cold'")!;
    expect(audit.actor).toBe("system");
    expect(JSON.parse(audit.detail)).toMatchObject({ key, outcome: "created", deleted: { messages: 2, tasks: 2, blocks: 2, mentions: 1 } });
    expect(audit.detail).not.toContain("hey @alice");
    // Reads show the stub; writes keep the archived text.
    expect(ok(f.board.act(f.ctx("bob"), "read", { topic: "t" })).value).toMatchObject({ state: "cold", messages: [] });
    expect(err(f.board.act(f.ctx("bob"), "post", { topic: "t", body: "x" })).message).toBe(
      "Topic archived on 2026-11-20 by coord. Ask a coordinator to unarchive it.",
    );
    expect(f.board.nextColdExportDue()).toBeNull();
    expect(f.board.verifyAudit()).toMatchObject({ ok: true });
  });

  it("a failed write leaves everything and is retried after coldRetryMs; an object already there with the same hash confirms", async () => {
    const { f, store } = coldWorld();
    f.clock.advance(90 * DAY);
    store.failPuts = 1;
    const r1 = await exportColdTopics(f.board, store);
    expect(r1).toEqual({ done: [], failed: [{ topic: "t", error: "store unavailable" }] });
    expect(topicRow(f)).toMatchObject({ state: "archived", cold_attempt_at: f.clock.t, cold_pending: null });
    expect(count(f, "SELECT COUNT(*) AS n FROM messages WHERE topic = 't'")).toBe(2);
    expect(f.sql.one("SELECT actor, result FROM audit WHERE action = 'topic_cold_failed'")).toEqual({ actor: "system", result: "ok" });
    expect(f.board.nextColdExportDue()).toBe(f.clock.t + 60 * 60_000);
    expect((await exportColdTopics(f.board, store)).done).toEqual([]);
    f.clock.advance(60 * 60_000);
    // The object landed but its confirmation was lost (begin recorded, no confirm):
    // the next try waits the retry delay, then "exists" with the same hash confirms.
    const job = f.board.beginColdExport()!;
    await store.put(job.key, job.body, job.sha256);
    expect(f.board.nextColdExportDue()).toBe(f.clock.t + 60 * 60_000);
    expect((await exportColdTopics(f.board, store)).done).toEqual([]);
    f.clock.advance(60 * 60_000);
    expect(await exportColdTopics(f.board, store)).toEqual({ done: ["t"], failed: [] });
    expect(JSON.parse(f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE action = 'topic_cold'")!.detail).outcome).toBe("exists");
  });

  it("other content at the key: never overwritten, human admins told once, no hourly retry; unarchive clears it", async () => {
    const { f, store, archivedAt } = coldWorld();
    store.objects.set(coldKey("t", archivedAt), { body: "x\n", sha256: sha256("x\n") });
    f.clock.advance(90 * DAY);
    const r = await exportColdTopics(f.board, store);
    expect(r.failed[0]?.error).toMatch(/other content/);
    expect(store.objects.get(coldKey("t", archivedAt))?.body).toBe("x\n");
    expect(topicRow(f)).toMatchObject({ state: "archived", cold_conflict_at: f.clock.t });
    const line = f.sql.one<{ body: string }>("SELECT body FROM messages WHERE topic = 'admin-log' ORDER BY seq DESC LIMIT 1")!;
    expect(line.body).toMatch(/^cold export of #t stopped: an object with other content is already at topics\/t\/\d+\.ndjson\. .*unarchive the topic and archive it again/);
    expect(f.sql.all("SELECT handle, reason FROM notices WHERE reason = 'cold_conflict'")).toEqual([{ handle: ADMIN, reason: "cold_conflict" }]);
    // Not retried (no silent hourly loop) and not told again.
    expect(f.board.nextColdExportDue()).toBeNull();
    f.clock.advance(10 * DAY);
    expect(await exportColdTopics(f.board, store)).toEqual({ done: [], failed: [] });
    expect(count(f, "SELECT COUNT(*) AS n FROM notices WHERE reason = 'cold_conflict'")).toBe(1);
    // The fix: unarchive, archive again (a new key), then it goes cold.
    ok(f.board.act(f.ctx("coord"), "topic_unarchive", { topic: "t" }));
    ok(f.board.act(f.ctx("coord"), "topic_archive", { topic: "t", reason: "again" }));
    f.clock.advance(90 * DAY);
    expect((await exportColdTopics(f.board, store)).done).toEqual(["t"]);
  });

  it("waits while an unfinished task in another topic has a blocker row on one of its tasks", async () => {
    const { f, store } = coldWorld();
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "other", title: "live" })); // 5? next id
    const id = Number(f.sql.one<{ id: number }>("SELECT MAX(id) AS id FROM tasks")!.id);
    f.sql.exec("INSERT INTO task_blocks (task, blocked_by, created_by, created_at) VALUES (?, 1, 'alice', 0)", id);
    f.clock.advance(90 * DAY);
    expect(f.board.nextColdExportDue()).toBeNull();
    expect(await exportColdTopics(f.board, store)).toEqual({ done: [], failed: [] });
  });

  it("a topic over coldMaxBytes is refused from its SQL size estimate, without building the object", async () => {
    const f = world({ coldMaxBytes: 100 });
    const store = new MemoryColdStore(sha256);
    ok(f.board.act(f.ctx("alice"), "post", { topic: "t", body: "x".repeat(200) }));
    ok(f.board.act(f.ctx("coord"), "topic_archive", { topic: "t", reason: "r" }));
    f.clock.advance(90 * DAY);
    expect(await exportColdTopics(f.board, store)).toEqual({ done: [], failed: [] });
    expect(store.objects.size).toBe(0);
    expect(JSON.parse(f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE action = 'topic_cold_failed'")!.detail).error).toMatch(
      /^object estimated at \d+ bytes, over coldMaxBytes/,
    );
    expect(count(f, "SELECT COUNT(*) AS n FROM audit WHERE action = 'topic_cold_begin'")).toBe(0);
  });

  it("restore round-trips messages, tasks, comments and blocks; same roles as unarchive", async () => {
    const { f, store, before } = coldWorld();
    f.clock.advance(90 * DAY);
    await exportColdTopics(f.board, store);
    // A plain agent is refused (no store read); a board without a store refuses with the reason.
    const refused = await callToolWithCold(f.board, store, f.ctx("alice"), "bbs_topic_unarchive", { topic: "t" }, "mcp");
    expect(refused.structuredContent).toEqual({ error: { code: "forbidden", message: "only a coordinator or a human admin can unarchive a topic" } });
    const noStore = await callToolWithCold(f.board, null, f.ctx("coord"), "bbs_topic_unarchive", { topic: "t" }, "mcp");
    expect((noStore.structuredContent.error as { message: string }).message).toBe(
      "#t is in cold storage and this board has no cold store to restore it from",
    );
    // A store failure or a corrupt object leaves the topic cold.
    store.failGets = 1;
    const failed = await callToolWithCold(f.board, store, f.ctx("coord"), "bbs_topic_unarchive", { topic: "t" }, "mcp");
    expect((failed.structuredContent.error as { message: string }).message).toBe("could not read #t's cold object: store unavailable");
    const key = String(topicRow(f).cold_key);
    const good = store.objects.get(key)!;
    store.objects.set(key, { ...good, body: good.body.replace("first", "FIRST") });
    const bad = await callToolWithCold(f.board, store, f.ctx("coord"), "bbs_topic_unarchive", { topic: "t" }, "mcp");
    expect((bad.structuredContent.error as { message: string }).message).toBe("#t's cold object does not match its recorded SHA-256");
    expect(topicRow(f).state).toBe("cold");
    store.objects.set(key, good);
    // The coordinator restores it.
    const r = await callToolWithCold(f.board, store, f.ctx("coord"), "bbs_topic_unarchive", { topic: "#t" }, "mcp");
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toMatchObject({ topic: "t", state: "active", restored: before.header.counts, blocks_pending: 0 });
    const after = readColdContent(f.sql, "t");
    expect(after.messages).toEqual(before.messages);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.comments).toEqual(before.comments);
    expect(after.blocks).toEqual(before.blocks);
    expect(count(f, "SELECT COUNT(*) AS n FROM message_mentions WHERE handle = 'alice'")).toBe(1);
    expect(topicRow(f)).toMatchObject({ state: "active", cold_key: null, archived_at: null, last_activity_at: f.clock.t });
    // Usable again: post, task list with comments; new ids do not collide.
    ok(f.board.act(f.ctx("bob"), "post", { topic: "t", body: "back" }));
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "new" }));
    const restoreRow = f.sql.one<{ actor: string; detail: string }>("SELECT actor, detail FROM audit WHERE action = 'topic_restore' AND result = 'ok'")!;
    expect(restoreRow.actor).toBe("coord");
    expect(restoreRow.detail).not.toContain("first");
    expect(f.sql.all("SELECT result FROM audit WHERE action = 'topic_restore' ORDER BY seq")).toEqual([
      { result: "error" },
      { result: "error" },
      { result: "ok" },
    ]);
    expect(f.board.verifyAudit()).toMatchObject({ ok: true });
  });

  it("restore keeps a blocker row whose other task is cold elsewhere until that topic is restored", async () => {
    const { f, store } = coldWorld();
    // #other goes cold too, after t (its task 3 blocked by t's task 2: the row is in t's object only).
    f.clock.advance(1);
    ok(f.board.act(f.ctx("coord"), "topic_archive", { topic: "other", reason: "r" }));
    f.clock.advance(90 * DAY);
    expect((await exportColdTopics(f.board, store)).done).toEqual(["t", "other"]);
    const r = await callToolWithCold(f.board, store, f.ctx(ADMIN), "bbs_topic_unarchive", { topic: "t" }, "cli");
    expect(r.structuredContent).toMatchObject({ blocks_pending: 1, blocks_resumed: 0 });
    expect(count(f, "SELECT COUNT(*) AS n FROM task_blocks WHERE task = 1 AND blocked_by = 2")).toBe(1);
    expect(count(f, "SELECT COUNT(*) AS n FROM cold_blocks")).toBe(1);
    const r2 = await callToolWithCold(f.board, store, f.ctx(ADMIN), "bbs_topic_unarchive", { topic: "other" }, "cli");
    expect(r2.structuredContent).toMatchObject({ state: "active", blocks_pending: 0, blocks_resumed: 1 });
    expect(count(f, "SELECT COUNT(*) AS n FROM task_blocks WHERE task = 3 AND blocked_by = 2")).toBe(1);
    expect(count(f, "SELECT COUNT(*) AS n FROM cold_blocks")).toBe(0);
  });
});

describe("archive scan timer", () => {
  it("is started once, re-arms itself, and is started again after a failed run dropped it", () => {
    const f = world({ archiveScanIntervalMs: 60_000 });
    expect(ok(f.board.ensureArchiveScan()!).value).toEqual({ due: f.clock.t + 60_000 });
    f.clock.advance(60_000);
    f.board.runDueTimers();
    expect(f.sql.all("SELECT due_at FROM timers WHERE kind = 'archive_scan'")).toEqual([{ due_at: f.clock.t + 60_000 }]);
    f.sql.exec("DELETE FROM timers WHERE kind = 'archive_scan'");
    expect(f.board.ensureArchiveScan()).not.toBeNull();
    expect(count(f, "SELECT COUNT(*) AS n FROM timers WHERE kind = 'archive_scan'")).toBe(1);
  });
});

describe("independent review fixes (orchestrator, M6b)", () => {
  const coldTopic = async (config?: Partial<BoardConfig>) => {
    const f = world(config);
    const store = new MemoryColdStore(sha256);
    ok(f.board.act(f.ctx("alice"), "post", { topic: "t", body: "one" }));
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "a" }));
    ok(f.board.act(f.ctx("alice"), "task_update", { task: 1, state: "cancelled" }));
    ok(f.board.act(f.ctx("coord"), "topic_archive", { topic: "t", reason: "r" }));
    return { f, store };
  };

  it("M1: the size refusal reads no rows of the topic (the object is not built)", async () => {
    let rec: RecordingSql | undefined;
    const f = makeBoard({ wrap: (raw) => (rec = new RecordingSql(raw)), config: { coldMaxBytes: 100 } });
    f.addUser("coord");
    ok(f.board.act(f.ctx(ADMIN), "admin_coordinator_grant", { handle: "coord" }));
    ok(f.board.act(f.ctx("coord"), "topic_create", { name: "t" }));
    ok(f.board.act(f.ctx("coord"), "post", { topic: "t", body: "x".repeat(500) }));
    ok(f.board.act(f.ctx("coord"), "topic_archive", { topic: "t", reason: "r" }));
    f.clock.advance(90 * DAY);
    const from = rec!.log.length;
    expect(f.board.beginColdExport()).toBeNull();
    const ran = rec!.log.slice(from).map((s) => s.sql);
    expect(ran.some((q) => /SELECT \* FROM messages WHERE topic/.test(q))).toBe(false);
    expect(ran.some((q) => /INSERT INTO audit/.test(q))).toBe(true);
  });

  it("M1: the attempt is persisted at begin, so a restarted board waits the retry delay (no alarm loop)", async () => {
    const { f, store } = await coldTopic();
    f.clock.advance(90 * DAY);
    // Begin, then the process dies before the write is confirmed.
    expect(f.board.beginColdExport()).not.toBeNull();
    expect(topicRow(f).cold_attempt_at).toBe(f.clock.t);
    const restarted = new Board({ sql: f.sql, now: f.clock.now, sha256 });
    expect(restarted.nextColdExportDue()).toBe(f.clock.t + 60 * 60_000);
    expect(await exportColdTopics(restarted, store)).toEqual({ done: [], failed: [] });
    f.clock.advance(60 * 60_000);
    expect((await exportColdTopics(restarted, store)).done).toEqual(["t"]);
  });

  it("M1: confirm checks the begin record's fingerprint, not a rebuilt object", async () => {
    const { f, store } = await coldTopic();
    f.clock.advance(90 * DAY);
    const job = f.board.beginColdExport()!;
    await store.put(job.key, job.body, job.sha256);
    // A row changes behind the board's back: the fingerprint differs, nothing is deleted.
    f.sql.exec("UPDATE tasks SET updated_at = updated_at + 1 WHERE id = 1");
    const r = f.board.confirmColdExport(job, "created");
    expect(err(r).message).toBe("#t changed after its cold object was built");
    expect(count(f, "SELECT COUNT(*) AS n FROM messages WHERE topic = 't'")).toBe(1);
    // Wrong SHA-256 for the recorded begin: refused too.
    expect(err(f.board.confirmColdExport({ ...job, sha256: "0".repeat(64) }, "created")).message).toBe(
      "#t has no matching cold export in progress",
    );
  });

  it("m1: keep is refused on an archived topic", async () => {
    const { f } = await coldTopic();
    expect(err(f.board.act(f.ctx("coord"), "topic_keep", { topic: "t", on: true }))).toMatchObject({
      code: "conflict",
      message: "#t is archived; keep applies to active topics (unarchive it first)",
    });
  });

  it("m5: keep set before a (force) archive also keeps the archived topic from going cold", async () => {
    const f = world();
    const store = new MemoryColdStore(sha256);
    ok(f.board.act(f.ctx("coord"), "topic_keep", { topic: "t", on: true }));
    ok(f.board.act(f.ctx(ADMIN), "topic_archive", { topic: "t", reason: "r", force: true }));
    f.clock.advance(365 * DAY);
    expect(f.board.nextColdExportDue()).toBeNull();
    expect(await exportColdTopics(f.board, store)).toEqual({ done: [], failed: [] });
    expect(topicRow(f).state).toBe("archived");
  });

  it("m2: a task action on a cold topic's task returns the archived text; restore clears the map", async () => {
    const { f, store } = await coldTopic();
    f.clock.advance(90 * DAY);
    await exportColdTopics(f.board, store);
    const text = "Topic archived on 2026-11-20 by coord. Ask a coordinator to unarchive it.";
    expect(err(f.board.act(f.ctx("bob"), "task_comment", { task: 1, body: "x" }))).toMatchObject({ code: "topic_archived", message: text });
    expect(err(f.board.act(f.ctx("bob"), "task_claim", { task: 1 })).message).toBe(text);
    expect(err(f.board.act(f.ctx("bob"), "task_comment", { task: 99, body: "x" })).message).toBe("no task 99");
    await callToolWithCold(f.board, store, f.ctx("coord"), "bbs_topic_unarchive", { topic: "t" }, "mcp");
    expect(count(f, "SELECT COUNT(*) AS n FROM cold_tasks")).toBe(0);
    ok(f.board.act(f.ctx("bob"), "task_comment", { task: 1, body: "x" }));
  });

  it("m3: a subscription started while cold begins after the topic's last seq", async () => {
    const { f, store } = await coldTopic();
    const last = Number(f.sql.one<{ m: number }>("SELECT MAX(seq) AS m FROM messages WHERE topic = 't'")!.m);
    f.clock.advance(90 * DAY);
    await exportColdTopics(f.board, store);
    expect(topicRow(f).cold_last_seq).toBe(last);
    f.addUser("dana");
    ok(f.board.act(f.ctx("dana"), "subscribe", { topic: "t", level: "digest" }));
    expect(f.sql.one("SELECT last_read_seq FROM subscriptions WHERE handle = 'dana' AND topic = 't'")).toEqual({ last_read_seq: last });
    await callToolWithCold(f.board, store, f.ctx("coord"), "bbs_topic_unarchive", { topic: "t" }, "mcp");
    const inbox = ok(f.board.act<{ digest: unknown[] }>(f.ctx("dana"), "inbox", {}));
    expect(JSON.stringify(inbox.value)).not.toContain('"one"');
  });

  it("n4: a restore refuses an object from another board", async () => {
    const { f, store } = await coldTopic();
    f.clock.advance(90 * DAY);
    await exportColdTopics(f.board, store);
    const key = String(topicRow(f).cold_key);
    const body = store.objects.get(key)!.body.replace(/"board_id":"[0-9a-f]+"/, '"board_id":"ffffffffffffffff"');
    store.objects.set(key, { body, sha256: sha256(body) });
    f.sql.exec("UPDATE topics SET cold_sha256 = ? WHERE name = 't'", sha256(body));
    const r = await callToolWithCold(f.board, store, f.ctx("coord"), "bbs_topic_unarchive", { topic: "t" }, "mcp");
    expect((r.structuredContent.error as { message: string }).message).toBe("#t's cold object is for another topic, archive or board");
    expect(topicRow(f).state).toBe("cold");
  });

  it("n7: a restore that fails part way rolls back every row it inserted", async () => {
    const { f, store } = await coldTopic();
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "x" }));
    f.clock.advance(90 * DAY);
    await exportColdTopics(f.board, store);
    // Something now holds task id 1 (by hand), so the task insert fails after the messages went in.
    f.sql.exec("INSERT INTO tasks (id, topic, title, state, created_by, created_at, updated_at) VALUES (1, 'x', 'squatter', 'open', 'alice', 0, 0)");
    const r = await callToolWithCold(f.board, store, f.ctx("coord"), "bbs_topic_unarchive", { topic: "t" }, "mcp");
    expect(r.isError).toBe(true);
    expect(count(f, "SELECT COUNT(*) AS n FROM messages WHERE topic = 't'")).toBe(0);
    expect(count(f, "SELECT COUNT(*) AS n FROM cold_tasks WHERE topic = 't'")).toBe(1);
    expect(topicRow(f).state).toBe("cold");
    expect(f.sql.one("SELECT result FROM audit WHERE action = 'topic_restore' ORDER BY seq DESC LIMIT 1")).toEqual({ result: "error" });
  });

  it("n8: force does not send blocker_cancelled for a task the same archive cancels", () => {
    const f = world();
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "blocker" })); // 1
    ok(f.board.act(f.ctx("alice"), "task_create", { topic: "t", title: "waiter" })); // 2
    ok(f.board.act(f.ctx("bob"), "task_claim", { task: 2 }));
    ok(f.board.act(f.ctx("bob"), "task_block", { task: 2, blocked_by: [1] }));
    const r = ok(f.board.act(f.ctx(ADMIN), "topic_archive", { topic: "t", reason: "drop", force: true }));
    const reasons = r.notifications.map((n) => (n.type === "task" ? `${n.recipient}:${n.reason}:${n.task}` : "")).sort();
    expect(reasons).toEqual(["bob:task_comment:2", "coord:task_comment:1", "coord:task_comment:2"]);
  });

  it("n5: the notice says 'on or after'", () => {
    const f = world();
    f.board.ensureArchiveScan();
    f.clock.advance(27 * DAY);
    f.board.runDueTimers();
    expect(f.sql.one<{ body: string }>("SELECT body FROM messages WHERE topic = 't'")!.body).toMatch(
      /^This topic will be archived on or after 2026-12-20 \(UTC\)/,
    );
  });
});
