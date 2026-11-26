// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #105, decided by Curtis 2026-11-25: "One per task". Past
 * `noticesMaxPerUser`, a stored notice makes room by deleting, oldest first,
 * notices that are not the latest of their task; only when every stored
 * notice is the latest of its task does the oldest go and count as dropped.
 */

import { describe, expect, it } from "vitest";
import type { ActResult } from "../src/types.ts";
import { makeBoard } from "./helpers.ts";

function ok<T>(r: ActResult<T>): Extract<ActResult<T>, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
}

interface Stored {
  id: number;
  kind: string;
  reason: string;
  wake: number;
  detail: string;
}

/** a is the coordinator-side author; b is the agent whose notices are capped. */
function world(cap: number) {
  const f = makeBoard({ config: { noticesMaxPerUser: cap } });
  f.addUser("a");
  f.addUser("b");
  ok(f.board.act(f.ctx("a"), "join", {}));
  ok(f.board.act(f.ctx("b"), "join", {}));
  ok(f.board.act(f.ctx("a"), "topic_create", { name: "t" }));
  ok(f.board.act(f.ctx("b"), "subscribe", { topic: "t", level: "wake" }));
  ok(f.board.act(f.ctx("b"), "inbox", {}));
  f.sql.exec("DELETE FROM notices WHERE handle = 'b'");
  const act = (name: string, args: Record<string, unknown>) => ok(f.board.act(f.ctx("a"), name, args));
  return {
    ...f,
    /** A new task assigned to b: one notice, `task_assigned`. */
    assign(title: string): number {
      const id = ok(f.board.act<{ task: { id: number } }>(f.ctx("a"), "task_create", { topic: "t", title })).value.task.id;
      act("task_assign", { task: id, assignee: "b" });
      return id;
    },
    /** A comment on b's task: one more notice, `task_comment`. */
    comment: (task: number) => void act("task_comment", { task, body: "x" }),
    stored: () => f.sql.all<Stored>("SELECT id, kind, reason, wake, detail FROM notices WHERE handle = 'b' AND kind = 'task' ORDER BY id"),
    tasksOf: () => f.sql.all<Stored>("SELECT id, kind, reason, wake, detail FROM notices WHERE handle = 'b' AND kind = 'task' ORDER BY id").map((n) => `${(JSON.parse(n.detail) as { task: number }).task}:${n.reason}`),
    dropped: () => f.sql.one<{ n: number }>("SELECT n FROM notice_drops WHERE handle = 'b'")?.n ?? 0,
  };
}

describe("past the cap, one notice per task survives (issue #105)", () => {
  it("removes an old notice of a task with newer ones, never a task's only or latest notice, and counts no drop", () => {
    const w = world(4);
    const a = w.assign("A");
    w.comment(a);
    w.comment(a);
    const b = w.assign("B");
    expect(w.tasksOf()).toEqual([`${a}:task_assigned`, `${a}:task_comment`, `${a}:task_comment`, `${b}:task_assigned`]);
    const c = w.assign("C");
    expect(w.tasksOf()).toEqual([`${a}:task_comment`, `${a}:task_comment`, `${b}:task_assigned`, `${c}:task_assigned`]);
    const d = w.assign("D");
    expect(w.tasksOf()).toEqual([`${a}:task_comment`, `${b}:task_assigned`, `${c}:task_assigned`, `${d}:task_assigned`]);
    expect(w.dropped()).toBe(0);
    const inbox = ok(w.board.act<{ dropped_notices: number; notices: unknown[] }>(w.ctx("b"), "inbox", {}));
    expect(inbox.value.dropped_notices).toBe(0);
    expect(inbox.value.notices).toHaveLength(4);
    const audits = w.sql
      .all<{ detail: string }>("SELECT detail FROM audit WHERE action = 'task_assign' ORDER BY seq")
      .map((r) => (JSON.parse(r.detail) as { delivery?: { notices_dropped?: unknown } }).delivery?.notices_dropped);
    expect(audits.every((x) => x === undefined)).toBe(true);
  });

  it("drops the oldest and counts it only when every stored notice is the latest of its task", () => {
    const w = world(3);
    const ids = [w.assign("1"), w.assign("2"), w.assign("3")];
    expect(w.dropped()).toBe(0);
    const four = w.assign("4");
    expect(w.tasksOf()).toEqual([`${ids[1]}:task_assigned`, `${ids[2]}:task_assigned`, `${four}:task_assigned`]);
    expect(w.dropped()).toBe(1);
    const inbox = ok(w.board.act<{ dropped_notices: number }>(w.ctx("b"), "inbox", {}));
    expect(inbox.value.dropped_notices).toBe(1);
  });

  it("removes only as many superseded notices as the excess, then drops the rest by the old rule", () => {
    const w = world(3);
    const a = w.assign("A");
    w.comment(a);
    const b = w.assign("B");
    const c = w.assign("C");
    expect(w.tasksOf()).toEqual([`${a}:task_comment`, `${b}:task_assigned`, `${c}:task_assigned`]);
    expect(w.dropped()).toBe(0);
    const d = w.assign("D");
    expect(w.tasksOf()).toEqual([`${b}:task_assigned`, `${c}:task_assigned`, `${d}:task_assigned`]);
    expect(w.dropped()).toBe(1);
  });

  it("a removed notice that rang passes the ring to the task's surviving notice", () => {
    const w = world(3);
    const a = w.assign("A");
    w.comment(a);
    expect(w.stored().map((n) => n.wake)).toEqual([1, 1]);
    w.sql.exec("UPDATE notices SET wake = 0 WHERE handle = 'b' AND reason = 'task_comment'");
    w.assign("B");
    w.assign("C");
    const kept = w.stored();
    expect(kept.map((n) => `${(JSON.parse(n.detail) as { task: number }).task}:${n.reason}:${n.wake}`)).toEqual([
      `${a}:task_comment:1`,
      expect.stringMatching(/:task_assigned:1$/),
      expect.stringMatching(/:task_assigned:1$/),
    ]);
    expect(w.dropped()).toBe(0);
  });

  it("a notice that did not ring keeps the survivor's own wake mark", () => {
    const w = world(3);
    const a = w.assign("A");
    w.comment(a);
    w.sql.exec("UPDATE notices SET wake = 0 WHERE handle = 'b'");
    w.assign("B");
    w.assign("C");
    expect(w.stored().map((n) => n.wake)).toEqual([0, 1, 1]);
  });

  it("administrator notices: the same reason and target supersede the older one; others do not", () => {
    const w = world(3);
    const detail = (as: string, who: string): string =>
      JSON.stringify({ as, subjects: [who], log_seq: 1, topic: "Lobby" });
    const put = (reason: string, d: string): void =>
      w.sql.exec(
        "INSERT INTO notices (handle, kind, reason, wake, detail, created_at) VALUES ('b', 'admin', ?, 0, ?, 0)",
        reason,
        d,
      );
    put("lobby_warning", detail("user", "b"));
    put("lobby_muted", detail("user", "b"));
    put("lobby_warning", detail("user", "b"));
    const limit = w.board.config.lobbyPostLimit;
    for (let i = 0; i < limit; i++) ok(w.board.act(w.ctx("b"), "post", { topic: "Lobby", body: `hi ${i}` }));
    expect(w.board.act(w.ctx("b"), "post", { topic: "Lobby", body: "one too many" }).ok).toBe(false);
    const admin = w.sql.all<{ id: number; reason: string }>(
      "SELECT id, reason FROM notices WHERE handle = 'b' AND kind = 'admin' ORDER BY id",
    );
    expect(admin.map((n) => n.reason)).toEqual(["lobby_muted", "lobby_warning", "lobby_warning"]);
    expect(admin[0]?.id).toBeGreaterThan(0);
    expect(w.dropped()).toBe(0);
  });
});
