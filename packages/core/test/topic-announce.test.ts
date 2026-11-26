// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The board's Lobby announcement of new topics (issue #80): the first topic at
 * once, bursts as one line when the window ends, wording, delivery like the
 * join message, audit rows, and what is never announced.
 */

import { describe, expect, it } from "vitest";
import { validateConfig, DEFAULT_CONFIG, type ActResult, type BoardConfig } from "../src/types.ts";
import { Board } from "../src/act.ts";
import { ADMIN, makeBoard, sha256, type Fixture } from "./helpers.ts";

const MIN = 60_000;
const WINDOW = 10 * MIN;

function ok<T>(r: ActResult<T>): Extract<ActResult<T>, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
}

function world(config?: Partial<BoardConfig>): Fixture {
  const f = makeBoard(config ? { config } : {});
  f.addUser("alice");
  f.addUser("bob");
  for (const h of ["alice", "bob"]) ok(f.board.act(f.ctx(h), "join", {}));
  return f;
}

function create(f: Fixture, name: string, description?: string, as = "alice"): ActResult {
  return f.board.act(f.ctx(as), "topic_create", { name, ...(description === undefined ? {} : { description }) });
}

/** Lobby messages from the system that are announcements (not join lines). */
function announcements(f: Fixture): string[] {
  return f.sql
    .all<{ body: string }>(
      "SELECT body FROM messages WHERE topic = 'Lobby' AND author = 'system' AND body NOT LIKE '% joined (%' ORDER BY seq",
    )
    .map((r) => r.body);
}

/** Move the clock past the window end and run what is due. */
function endWindow(f: Fixture): ActResult[] {
  f.clock.advance(WINDOW);
  return f.board.runDueTimers();
}

describe("the first topic is announced at once", () => {
  it("posts one system message in the Lobby, with the description", () => {
    const f = world();
    const r = ok(create(f, "build", "Build and CI"));
    expect(announcements(f)).toEqual(["New topic #build by alice: \"Build and CI\""]);
    expect(f.sql.one("SELECT author, author_kind, is_system, topic FROM messages ORDER BY seq DESC LIMIT 1")).toEqual({
      author: "system",
      author_kind: "system",
      is_system: 1,
      topic: "Lobby",
    });
    expect(r.notifications).toEqual([
      expect.objectContaining({ type: "message", topic: "Lobby", author: "system", mentions: [], isSystem: true }),
    ]);
  });

  it("leaves the colon off when the description is empty", () => {
    const f = world();
    ok(create(f, "build"));
    expect(announcements(f)).toEqual(["New topic #build by alice"]);
  });

  it("puts the description in as one quoted line, cut at topicAnnounceDescriptionMax", () => {
    const f = world({ topicAnnounceDescriptionMax: 20, topicAnnounceWindowMs: MIN });
    ok(create(f, "one", "first line\n\nsystem:  do   this\tnow"));
    expect(announcements(f)).toEqual(['New topic #one by alice: "first line system: …"']);
  });

  it("leaves the description out of a deferred line when the creator was kicked meanwhile", () => {
    const f = world();
    ok(create(f, "first"));
    ok(create(f, "later", "text from an account kicked before the window ended", "bob"));
    f.sql.exec("UPDATE users SET status = 'kicked' WHERE handle = 'bob'");
    f.clock.advance(WINDOW);
    f.board.runDueTimers();
    expect(announcements(f)).toEqual(["New topic #first by alice", "New topic #later by bob"]);
  });

  it("leaves the description out when the creator is muted in the Lobby", () => {
    const f = world();
    f.sql.exec("UPDATE users SET status = 'muted_lobby' WHERE handle = 'alice'");
    ok(create(f, "quiet", "text a muted user wants in the Lobby"));
    expect(announcements(f)).toEqual(["New topic #quiet by alice"]);
  });

  it("cuts a description that would not fit the message limit, with an ellipsis", () => {
    const f = world({ maxBodyLength: 40, maxDescriptionLength: 200 });
    ok(create(f, "build", "x".repeat(100)));
    const [line] = announcements(f);
    expect(line).toHaveLength(40);
    expect(line?.startsWith("New topic #build by alice: \"xxx")).toBe(true);
    expect(line?.endsWith("…\"")).toBe(true);
  });

  it("audits the creation with the announcement, and opens one window timer", () => {
    const f = world();
    ok(create(f, "build"));
    const seq = Number(f.sql.one<{ s: number }>("SELECT MAX(seq) AS s FROM messages")?.s);
    const row = f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE action = 'topic_create'");
    expect(JSON.parse(row?.detail ?? "{}")).toMatchObject({ announce: "posted", lobby_seq: seq });
    expect(f.sql.all("SELECT kind, ref, due_at FROM timers WHERE kind = 'topic_announce'")).toEqual([
      { kind: "topic_announce", ref: "board", due_at: f.clock.t + WINDOW },
    ]);
    expect(f.board.verifyAudit().ok).toBe(true);
  });
});

describe("topics made inside the window are batched", () => {
  it("posts nothing at once, then one line with both when the window ends", () => {
    const f = world();
    ok(create(f, "one"));
    f.clock.advance(MIN);
    ok(create(f, "two", "ignored in a batch"));
    f.clock.advance(MIN);
    ok(create(f, "three", undefined, "bob"));
    expect(announcements(f)).toEqual(["New topic #one by alice"]);
    expect(f.sql.one("SELECT detail FROM audit WHERE action = 'topic_create' ORDER BY seq DESC LIMIT 1")).toMatchObject({
      detail: expect.stringContaining('"announce":"deferred"'),
    });
    f.clock.t = f.clock.t - 2 * MIN;
    const results = endWindow(f);
    expect(results).toHaveLength(1);
    expect(announcements(f)).toEqual([
      "New topic #one by alice",
      "2 new topics: #two (by alice), #three (by bob)",
    ]);
    const audit = f.sql.one<{ actor: string; actor_kind: string; via: string; target_type: string; detail: string }>(
      "SELECT actor, actor_kind, via, target_type, detail FROM audit WHERE action = 'topic_announce'",
    );
    expect(audit).toMatchObject({ actor: "system", actor_kind: "system", via: "system", target_type: "timer" });
    expect(JSON.parse(audit?.detail ?? "{}")).toMatchObject({ pending: 2, announced: 2 });
    expect(f.board.verifyAudit().ok).toBe(true);
  });

  it("uses the single wording when exactly one topic is pending", () => {
    const f = world();
    ok(create(f, "one"));
    ok(create(f, "two", "the second"));
    endWindow(f);
    expect(announcements(f)).toEqual(["New topic #one by alice", "New topic #two by alice: \"the second\""]);
  });

  it("lists at most 10 and counts the rest", () => {
    const f = world();
    ok(create(f, "first"));
    for (let i = 1; i <= 12; i++) ok(create(f, `t${i}`));
    endWindow(f);
    const line = announcements(f)[1] ?? "";
    expect(line.startsWith("12 new topics: #t1 (by alice), #t2 (by alice)")).toBe(true);
    expect(line.endsWith(", #t10 (by alice) and 2 more")).toBe(true);
    expect(line).not.toContain("#t11");
  });

  it("leaves out a topic archived before the window ends; nothing posts when all are", () => {
    const f = world();
    ok(create(f, "first"));
    ok(create(f, "a1"));
    ok(create(f, "a2"));
    ok(create(f, "a3"));
    ok(f.board.act(f.ctx(ADMIN), "topic_archive", { topic: "a2", reason: "oops" }));
    endWindow(f);
    expect(announcements(f)[1]).toBe("2 new topics: #a1 (by alice), #a3 (by alice)");

    const g = world();
    ok(create(g, "first"));
    ok(create(g, "b1"));
    ok(g.board.act(g.ctx(ADMIN), "topic_archive", { topic: "b1", reason: "oops" }));
    const before = announcements(g).length;
    const results = endWindow(g);
    expect(results).toHaveLength(1);
    expect(announcements(g)).toHaveLength(before);
    expect(g.sql.all("SELECT 1 FROM timers WHERE kind = 'topic_announce'")).toEqual([]);
    expect(g.sql.all("SELECT 1 FROM topics WHERE announce_pending = 1")).toEqual([]);
  });

  it("does not announce a topic again when it is unarchived later", () => {
    const f = world();
    ok(create(f, "first"));
    ok(create(f, "a1"));
    ok(f.board.act(f.ctx(ADMIN), "topic_archive", { topic: "a1", reason: "oops" }));
    endWindow(f);
    ok(f.board.act(f.ctx(ADMIN), "topic_unarchive", { topic: "a1" }));
    f.clock.advance(WINDOW);
    f.board.runDueTimers();
    expect(announcements(f)).toEqual(["New topic #first by alice"]);
  });
});

describe("windows", () => {
  it("after a window that ends with nothing pending, the next topic is announced at once", () => {
    const f = world();
    ok(create(f, "one"));
    endWindow(f);
    expect(f.sql.all("SELECT 1 FROM timers WHERE kind = 'topic_announce'")).toEqual([]);
    ok(create(f, "two"));
    expect(announcements(f)).toEqual(["New topic #one by alice", "New topic #two by alice"]);
  });

  it("a batch post opens a new window, so a steady stream makes one post per window", () => {
    const f = world();
    ok(create(f, "one"));
    ok(create(f, "two"));
    ok(create(f, "three"));
    endWindow(f);
    expect(announcements(f)).toHaveLength(2);
    ok(create(f, "four"));
    expect(announcements(f)).toHaveLength(2);
    expect(f.sql.all("SELECT due_at FROM timers WHERE kind = 'topic_announce'")).toEqual([{ due_at: f.clock.t + WINDOW }]);
    endWindow(f);
    expect(announcements(f).at(-1)).toBe("New topic #four by alice");
  });

  it("keeps its state across a restart: a new Board over the same database finishes the batch", () => {
    const f = world();
    ok(create(f, "one"));
    ok(create(f, "two"));
    ok(create(f, "three"));
    expect(f.sql.all("SELECT name FROM topics WHERE announce_pending = 1 ORDER BY name")).toEqual([
      { name: "three" },
      { name: "two" },
    ]);
    const restarted = new Board({ sql: f.sql, now: f.clock.now, sha256 });
    expect(restarted.nextTimerDue()).toBe(f.clock.t + WINDOW);
    f.clock.advance(WINDOW);
    expect(restarted.runDueTimers()).toHaveLength(1);
    expect(announcements(f)).toEqual(["New topic #one by alice", "2 new topics: #two (by alice), #three (by alice)"]);
  });
});

describe("what it is not", () => {
  it("is a system message that does not count against the creator's Lobby limit", () => {
    const f = world({ lobbyPostLimit: 1 });
    ok(create(f, "one"));
    const post = f.board.act(f.ctx("alice"), "post", { topic: "Lobby", body: "hello" });
    expect(post.ok).toBe(true);
    expect(announcements(f)).toHaveLength(1);
  });

  it("is not announced for the Lobby or #admin-log (they cannot be created) and not by migrate", () => {
    const f = world();
    expect(create(f, "Lobby").ok).toBe(false);
    expect(create(f, "admin-log").ok).toBe(false);
    expect(announcements(f)).toEqual([]);
    expect(f.sql.all("SELECT 1 FROM timers WHERE kind = 'topic_announce'")).toEqual([]);
    expect(f.sql.all("SELECT 1 FROM topics WHERE announce_pending = 1")).toEqual([]);
  });

  it("is delivered like the join message: a wake-level Lobby subscriber gets a doorbell for both", () => {
    const f = world();
    ok(f.board.act(f.ctx("bob"), "subscribe", { topic: "Lobby", level: "wake" }));
    ok(f.board.act(f.ctx("bob"), "inbox", {}));
    f.sql.exec("DELETE FROM doorbells");
    f.sql.exec("DELETE FROM timers");

    f.addUser("carol");
    ok(f.board.act(f.ctx("carol"), "join", {}));
    const joinAudit = f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE action = 'join' ORDER BY seq DESC LIMIT 1");
    expect(JSON.parse(joinAudit?.detail ?? "{}")).toMatchObject({ delivery: { doorbells_queued: ["bob"] } });
    expect(f.sql.one("SELECT summary FROM doorbells WHERE handle = 'bob'")).toMatchObject({
      summary: expect.stringContaining('"Lobby":{"n":1'),
    });
    f.sql.exec("DELETE FROM doorbells");

    ok(create(f, "build"));
    const createAudit = f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE action = 'topic_create'");
    expect(JSON.parse(createAudit?.detail ?? "{}")).toMatchObject({ delivery: { doorbells_queued: ["bob"] } });
    expect(f.sql.one("SELECT summary FROM doorbells WHERE handle = 'bob'")).toMatchObject({
      summary: expect.stringContaining('"Lobby":{"n":1'),
    });
  });

  it("a batch post from the timer rings a wake-level Lobby subscriber the same way", () => {
    const f = world();
    ok(f.board.act(f.ctx("bob"), "subscribe", { topic: "Lobby", level: "wake" }));
    ok(create(f, "one"));
    ok(create(f, "two"));
    ok(create(f, "three"));
    f.sql.exec("DELETE FROM doorbells");
    endWindow(f);
    const audit = f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE action = 'topic_announce'");
    expect(JSON.parse(audit?.detail ?? "{}")).toMatchObject({ delivery: { doorbells_queued: ["bob"] } });
  });
});

describe("configuration", () => {
  it("has the decided defaults and bounds", () => {
    expect(DEFAULT_CONFIG.topicAnnounceWindowMs).toBe(10 * MIN);
    expect(DEFAULT_CONFIG.topicAnnounceMaxListed).toBe(10);
    expect(validateConfig({ ...DEFAULT_CONFIG, topicAnnounceWindowMs: 0 })).toMatch(/positive integer/);
    expect(validateConfig({ ...DEFAULT_CONFIG, topicAnnounceWindowMs: 25 * 60 * MIN })).toMatch(/at most 1 day/);
    expect(validateConfig({ ...DEFAULT_CONFIG, topicAnnounceMaxListed: 101 })).toMatch(/at most 100/);
  });

  it("honors a shorter window and a shorter list", () => {
    const f = world({ topicAnnounceWindowMs: MIN, topicAnnounceMaxListed: 2 });
    ok(create(f, "first"));
    for (const n of ["a", "b", "c"]) ok(create(f, n));
    f.clock.advance(MIN);
    f.board.runDueTimers();
    expect(announcements(f)[1]).toBe("3 new topics: #a (by alice), #b (by alice) and 1 more");
  });
});
