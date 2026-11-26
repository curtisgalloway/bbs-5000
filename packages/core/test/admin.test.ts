// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// M4a: the auto-administrator (Lobby flood: warn, mute, kick), the topic
// circuit breaker, #admin-log, and the failed sign-in limit (B5). Time moves
// only through the injected clock.

import { describe, expect, it } from "vitest";
import { BREAKER_RUN_SQL, BREAKER_WINDOW_START_SQL, circuitBreaker, formatSpan } from "../src/actions/admin.ts";
import { Board } from "../src/act.ts";
import { NodeSqliteSql } from "../src/node-sqlite.ts";
import { validateConfig } from "../src/types.ts";
import { sha256 } from "./helpers.ts";
import type {
  ActResult,
  AdminNotification,
  BoardConfig,
  NotificationWork,
  TaskNotification,
} from "../src/types.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { ADMIN, makeBoard, type Fixture } from "./helpers.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

function ok<T>(r: ActResult<T>): Extract<ActResult<T>, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
}

function board(config: Partial<BoardConfig> = {}, ...handles: string[]): Fixture {
  const f = makeBoard({ config });
  for (const h of handles) {
    f.addUser(h, h.startsWith("human") ? "human" : "agent");
    ok(f.board.act(f.ctx(h), "join", {}));
  }
  return f;
}

function lobbyPost(f: Fixture, h: string, body = "hello"): ActResult {
  return f.board.act({ ...f.ctx(h), requestId: `req-${f.clock.t}-${body}` }, "post", { topic: "Lobby", body });
}

/** Post until the first refusal; returns it. */
function flood(f: Fixture, h: string): Extract<ActResult, { ok: false }> {
  for (let i = 0; i < 50; i++) {
    const r = lobbyPost(f, h, `m${i}`);
    if (!r.ok) return r;
  }
  throw new Error("never refused");
}

function adminLog(f: Fixture): string[] {
  return f.sql
    .all<{ body: string }>("SELECT body FROM messages WHERE topic = 'admin-log' ORDER BY seq")
    .map((r) => r.body);
}

function status(f: Fixture, h: string): string {
  return f.sql.one<{ status: string }>("SELECT status FROM users WHERE handle = ?", h)?.status ?? "";
}

function admins(n: NotificationWork[]): AdminNotification[] {
  return n.filter((x): x is AdminNotification => x.type === "admin");
}

describe("Lobby flood, step 1 (A4.1)", () => {
  it("refuses the post over the limit with the take-it-to-a-topic text and warns", () => {
    const f = board({}, "alice");
    for (let i = 0; i < 5; i++) ok(lobbyPost(f, "alice", `m${i}`));
    const r = lobbyPost(f, "alice", "sixth");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("rate_limited");
    expect(r.error.message).toMatch(/at most 5 posts in 10 minutes/);
    expect(r.error.message).toMatch(/take it to a topic/);
    expect(r.error.message).toMatch(/Warning/);
    expect(r.result).toBe("denied");
    // The refused post is not stored.
    expect(f.sql.one("SELECT COUNT(*) AS n FROM messages WHERE body = 'sixth'")).toEqual({ n: 0 });
    // Warning: a notice for the user and a line in #admin-log.
    const notes = admins(r.notifications);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ reason: "lobby_warning", recipient: "alice", as: "user", subjects: ["alice"] });
    expect(adminLog(f)).toEqual([expect.stringMatching(/^lobby: warned alice \(over the limit of 5 Lobby posts/)]);
    expect(r.notifications).toContainEqual(expect.objectContaining({ type: "message", topic: "admin-log" }));
    expect(status(f, "alice")).toBe("active");
  });

  it("audits the refusal and the warning as two rows tied by the request id", () => {
    const f = board({}, "alice");
    for (let i = 0; i < 5; i++) ok(lobbyPost(f, "alice", `m${i}`));
    const r = lobbyPost(f, "alice", "sixth");
    const rows = f.sql.all<{ actor: string; action: string; result: string; request_id: string; detail: string }>(
      "SELECT actor, action, result, request_id, detail FROM audit WHERE seq >= ? ORDER BY seq",
      r.auditSeq ?? 0,
    );
    expect(rows.map((x) => [x.actor, x.action, x.result])).toEqual([
      ["alice", "post", "denied"],
      ["system", "lobby_offense", "ok"],
    ]);
    expect(rows[1]?.request_id).toBe(rows[0]?.request_id);
    expect(JSON.parse(rows[1]?.detail ?? "{}")).toMatchObject({ outcome: "warned", step: 1, offenses: 1 });
  });

  it("does not count join system messages (A4.2)", () => {
    const f = board({ lobbyPostLimit: 2 }, "alice");
    // Several joins: only the first posts a system message, but add more
    // system lines in the Lobby to be sure none count.
    for (let i = 0; i < 4; i++) {
      f.sql.exec(
        `INSERT INTO messages (topic, author, author_kind, via, body, is_system, created_at)
         VALUES ('Lobby', 'alice', 'system', 'system', 'alice joined', 1, ?)`,
        f.clock.t,
      );
    }
    ok(f.board.act(f.ctx("alice"), "join", {}));
    ok(lobbyPost(f, "alice", "one"));
    ok(lobbyPost(f, "alice", "two"));
    expect(lobbyPost(f, "alice", "three").ok).toBe(false);
  });

  it("counts only the Lobby and only the poster's own posts", () => {
    const f = board({ lobbyPostLimit: 2 }, "alice", "bob");
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "work" }));
    for (let i = 0; i < 5; i++) ok(f.board.act(f.ctx("alice"), "post", { topic: "work", body: `w${i}` }));
    ok(lobbyPost(f, "bob", "b1"));
    ok(lobbyPost(f, "bob", "b2"));
    ok(lobbyPost(f, "alice", "a1"));
    ok(lobbyPost(f, "alice", "a2"));
  });

  it("treats refusals inside one window as one offense, then accepts posts once the window passes", () => {
    const f = board({}, "alice");
    flood(f, "alice");
    f.clock.advance(MIN);
    const again = lobbyPost(f, "alice", "again");
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.message).toMatch(/not sent/);
    expect(again.notifications).toEqual([]);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM admin_events WHERE handle = 'alice'")).toEqual({ n: 1 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM audit WHERE action = 'lobby_offense'")).toEqual({ n: 1 });
    f.clock.advance(10 * MIN);
    ok(lobbyPost(f, "alice", "later"));
  });
});

describe("Lobby flood, step 2: mute (A4.1)", () => {
  it("mutes in the Lobby only, on a second offense within the hour, and lifts the mute by timer", () => {
    const f = board({}, "alice");
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "work" }));
    // The new-topic announcement window is not under test here; drop its timer so
    // the only timer left is the unmute timer.
    f.sql.exec("DELETE FROM timers WHERE kind = 'topic_announce'");
    flood(f, "alice");
    f.clock.advance(11 * MIN);
    const second = flood(f, "alice");
    expect(second.error.message).toMatch(/Second offense: you are muted in the Lobby for 1 hour/);
    // The next offense (the third within 24 hours) kicks; the text says so (review m1).
    expect(second.error.message).toMatch(/After the mute, another flood within 24 hours removes you from the board/);
    expect(admins(second.notifications)).toEqual([
      expect.objectContaining({ reason: "lobby_muted", recipient: "alice" }),
    ]);
    expect(status(f, "alice")).toBe("muted_lobby");
    expect(adminLog(f)[1]).toMatch(/^lobby: muted alice in Lobby for 1 hour/);
    // Muted: Lobby refused (not a new offense), other topics fine.
    f.clock.advance(15 * MIN);
    const muted = lobbyPost(f, "alice", "still");
    expect(muted.ok).toBe(false);
    if (!muted.ok) {
      expect(muted.error.code).toBe("rate_limited");
      expect(muted.error.message).toMatch(/muted in the Lobby until .*other topics are unaffected/);
    }
    ok(f.board.act(f.ctx("alice"), "post", { topic: "work", body: "fine here" }));
    expect(f.sql.one("SELECT COUNT(*) AS n FROM admin_events WHERE handle = 'alice'")).toEqual({ n: 2 });
    // The unmute timer runs as the system through runDueTimers.
    expect(f.board.nextTimerDue()).toBe(f.clock.t - 15 * MIN + HOUR);
    f.clock.advance(HOUR);
    const results = f.board.runDueTimers();
    expect(results).toHaveLength(1);
    expect(status(f, "alice")).toBe("active");
    expect(adminLog(f).at(-1)).toBe("lobby: mute on alice ended");
    const row = f.sql.one<{ actor: string; action: string }>("SELECT actor, action FROM audit ORDER BY seq DESC LIMIT 1");
    expect(row).toEqual({ actor: "system", action: "lobby_unmute" });
    ok(lobbyPost(f, "alice", "back"));
  });

  it("only warns a second offense more than an hour after the first", () => {
    const f = board({}, "alice");
    flood(f, "alice");
    f.clock.advance(HOUR + MIN);
    const second = flood(f, "alice");
    expect(second.error.message).toMatch(/Warning/);
    expect(status(f, "alice")).toBe("active");
  });
});

describe("Lobby flood, step 3: kick (A4.1)", () => {
  function kickAlice(f: Fixture): Extract<ActResult, { ok: false }> {
    flood(f, "alice");
    f.clock.advance(11 * MIN);
    flood(f, "alice");
    f.clock.advance(HOUR + MIN);
    f.board.runDueTimers();
    return flood(f, "alice");
  }

  it("kicks on the third offense within 24 hours: status, token, sessions, timers", () => {
    const f = board({}, "alice");
    const token = f.tokens.get("alice");
    const third = kickAlice(f);
    expect(third.error.message).toMatch(/Offense 3 within 24 hours: you are removed from the board/);
    expect(status(f, "alice")).toBe("kicked");
    expect(f.sql.one("SELECT token_hash FROM users WHERE handle = 'alice'")).toEqual({ token_hash: null });
    expect(f.sql.all("SELECT state FROM sessions WHERE handle = 'alice' AND state <> 'gone'")).toEqual([]);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM timers WHERE kind = 'lobby_unmute'")).toEqual({ n: 0 });
    expect(adminLog(f).at(-1)).toMatch(/^kick: alice removed .*token revoked, 1 session\(s\) detached, 0 task\(s\) marked stale$/);
    // Authentication with the old token is refused as revoked, audited denied under alice.
    const auth = f.board.authenticate(token, { via: "mcp", source: "test" });
    expect(auth).toMatchObject({ ok: false, reason: "revoked_token" });
    const row = f.sql.one<{ actor: string; action: string; result: string }>(
      "SELECT actor, action, result FROM audit ORDER BY seq DESC LIMIT 1",
    );
    expect(row).toEqual({ actor: "alice", action: "auth", result: "denied" });
    // A call under the handle is refused too.
    const r = f.board.act(f.ctx("alice"), "topics", {});
    expect(r.ok).toBe(false);
  });

  it("ends every session of the kicked handle, connector chats' included", () => {
    const f = board({}, "alice");
    const chat = (n: number) => ({ handle: "alice", via: "mcp" as const, oauthGrant: "og_test", mcpSession: sha256(`chat-${n}`) });
    ok(f.board.act(chat(1), "join", {}));
    ok(f.board.act(chat(2), "join", {}));
    expect(f.sql.all("SELECT id FROM sessions WHERE handle = 'alice' AND state <> 'gone'")).toHaveLength(3);
    kickAlice(f);
    expect(f.sql.all("SELECT id FROM sessions WHERE handle = 'alice' AND state <> 'gone'")).toEqual([]);
  });

  it("marks held tasks stale and tells the coordinator, or records that nobody was told", () => {
    // A lease shorter than the hour kickAlice waits (the default is 2 hours).
    const f = board({ taskLeaseMs: 30 * MIN }, "alice", "carol");
    ok(f.board.act(f.ctx("carol"), "topic_create", { name: "work" }));
    ok(f.board.act(f.ctx("alice"), "subscribe", { topic: "work", level: "wake" }));
    const a = ok<{ task: { id: number } }>(
      f.board.act(f.ctx("carol"), "task_create", { topic: "work", title: "one" }) as ActResult<{ task: { id: number } }>,
    ).value.task.id;
    const b = ok<{ task: { id: number } }>(
      f.board.act(f.ctx("carol"), "task_create", { topic: "work", title: "two" }) as ActResult<{ task: { id: number } }>,
    ).value.task.id;
    const done = ok<{ task: { id: number } }>(
      f.board.act(f.ctx("carol"), "task_create", { topic: "work", title: "three" }) as ActResult<{ task: { id: number } }>,
    ).value.task.id;
    for (const id of [a, b, done]) ok(f.board.act(f.ctx("carol"), "task_assign", { task: id, assignee: "alice" }));
    ok(f.board.act(f.ctx("alice"), "task_update", { task: a, state: "in_progress" }));
    ok(f.board.act(f.ctx("alice"), "task_update", { task: done, state: "in_progress" }));
    ok(f.board.act(f.ctx("alice"), "task_update", { task: done, state: "in_review" }));
    ok(f.board.act(f.ctx("carol"), "task_update", { task: done, state: "done" }));
    f.sql.exec("UPDATE users SET is_coordinator = 1 WHERE handle = 'carol'");

    const third = kickAlice(f);
    expect(
      f.sql.all<{ id: number; is_stale: number }>("SELECT id, is_stale FROM tasks ORDER BY id").map((t) => [
        Number(t.id),
        Number(t.is_stale),
      ]),
    ).toEqual([
      [a, 1],
      [b, 1],
      [done, 0],
    ]);
    // Task a's lease ran out during the hour kickAlice waits, so it was already
    // stale (and its holder told then): the kick notifies only for b (review n4).
    const taskNotes = third.notifications.filter((n): n is TaskNotification => n.type === "task");
    expect(taskNotes.map((n) => [n.reason, n.recipient, n.task])).toEqual([["assignee_kicked", "carol", b]]);
    expect(admins(third.notifications)).toEqual([
      expect.objectContaining({ reason: "user_kicked", recipient: "carol", as: "coordinator", subjects: ["alice"] }),
    ]);
    expect(adminLog(f).at(-1)).toMatch(/1 task\(s\) marked stale$/);
  });

  it("does not notify again for a task already stale (review n4)", () => {
    const f = board({}, "alice", "carol");
    ok(f.board.act(f.ctx("carol"), "topic_create", { name: "work" }));
    ok(f.board.act(f.ctx("alice"), "subscribe", { topic: "work", level: "wake" }));
    const id = (
      ok(f.board.act(f.ctx("carol"), "task_create", { topic: "work", title: "one" })) as { value: { task: { id: number } } }
    ).value.task.id;
    ok(f.board.act(f.ctx("carol"), "task_assign", { task: id, assignee: "alice" }));
    f.sql.exec("UPDATE tasks SET is_stale = 1 WHERE id = ?", id);
    f.sql.exec("UPDATE users SET is_coordinator = 1 WHERE handle = 'carol'");
    const third = kickAlice(f);
    expect(third.notifications.filter((n) => n.type === "task")).toEqual([]);
    expect(f.sql.one("SELECT is_stale FROM tasks WHERE id = ?", id)).toEqual({ is_stale: 1 });
    expect(adminLog(f).at(-1)).toMatch(/0 task\(s\) marked stale$/);
  });

  it("records an undelivered notice when there is no coordinator", () => {
    const f = board({}, "alice");
    const third = kickAlice(f);
    expect(admins(third.notifications)).toEqual([
      expect.objectContaining({ reason: "user_kicked", recipient: null, undelivered: "no_coordinator" }),
    ]);
  });

  it("never kicks without a mute first: warn, warn, then mute instead of kick, then kick (B34)", () => {
    const f = board({}, "alice");
    const first = flood(f, "alice");
    expect(first.error.message).toMatch(/Warning: another flood within 1 hour mutes you/);
    f.clock.advance(2 * HOUR);
    const second = flood(f, "alice");
    // Two offenses, never muted: the next one mutes, it does not remove.
    expect(second.error.message).toMatch(/Warning: another flood within 24 hours mutes you in the Lobby for 1 hour\.$/);
    expect(second.error.message).not.toMatch(/removes you/);
    f.clock.advance(2 * HOUR);
    const third = flood(f, "alice");
    expect(third.error.message).toMatch(/Offense 3 within 24 hours: you are muted in the Lobby for 1 hour\..*After the mute, another flood within 24 hours removes you/);
    expect(status(f, "alice")).toBe("muted_lobby");
    expect(adminLog(f).at(-1)).toMatch(/^lobby: muted alice in Lobby for 1 hour \(.*; offense 3 within 24 hours, not muted before\)$/);
    expect(f.sql.all("SELECT step FROM admin_events WHERE handle = 'alice' ORDER BY id")).toEqual([{ step: 1 }, { step: 1 }, { step: 2 }]);
    f.clock.advance(HOUR + MIN);
    f.board.runDueTimers();
    const fourth = flood(f, "alice");
    expect(fourth.error.message).toMatch(/Offense 4 within 24 hours: you are removed from the board/);
    expect(status(f, "alice")).toBe("kicked");
  });

  it("a mute older than the kick span does not count (B34)", () => {
    const f = board({}, "alice");
    flood(f, "alice");
    f.clock.advance(11 * MIN);
    flood(f, "alice"); // muted
    f.clock.advance(25 * HOUR); // both offenses and the mute leave the span
    f.board.runDueTimers();
    flood(f, "alice");
    f.clock.advance(2 * HOUR);
    flood(f, "alice");
    f.clock.advance(2 * HOUR);
    flood(f, "alice"); // third in the span, no mute in it: muted, not kicked
    expect(status(f, "alice")).toBe("muted_lobby");
  });

  it("never mutes or kicks a person: rate-limited only (design §4)", () => {
    const f = board({}, "human1");
    for (let round = 0; round < 4; round++) {
      const r = flood(f, "human1");
      expect(r.error.message).toMatch(/limit applies to everyone/);
      expect(admins(r.notifications)).toEqual([expect.objectContaining({ reason: "lobby_warning" })]);
      expect(status(f, "human1")).toBe("active");
      f.clock.advance(11 * MIN);
    }
    expect(f.sql.one("SELECT COUNT(*) AS n FROM admin_events WHERE handle = 'human1'")).toEqual({ n: 4 });
    expect(adminLog(f).every((l) => l.startsWith("lobby: warned human1"))).toBe(true);
  });
});

describe("one config object (A4.5)", () => {
  it("defines every threshold with the design's defaults", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      lobbyPostLimit: 5,
      lobbyWindowMs: 10 * MIN,
      lobbyMuteWithinMs: HOUR,
      lobbyMuteMs: HOUR,
      lobbyKickOffenses: 3,
      lobbyKickWithinMs: 24 * HOUR,
      breakerMessages: 10,
      breakerWindowMs: 5 * MIN,
      wakeBudgetPerHour: 20,
    });
  });

  it("takes every Lobby threshold from the config", () => {
    const f = board(
      { lobbyPostLimit: 1, lobbyWindowMs: 1_000, lobbyMuteWithinMs: 5_000, lobbyMuteMs: 2_000, lobbyKickOffenses: 2, lobbyKickWithinMs: 60_000 },
      "alice",
    );
    const first = flood(f, "alice");
    expect(first.error.message).toMatch(/at most 1 posts in 1 second/);
    // With a kick at the second offense, the warning still says mute: a kick
    // needs a mute first (B34; before, it said the next flood removes).
    expect(first.error.message).toMatch(/Warning: another flood within 1 minute mutes you in the Lobby for 2 seconds/);
    f.clock.advance(10_000);
    const second = flood(f, "alice");
    expect(second.error.message).toMatch(/Second offense: you are muted in the Lobby for 2 seconds\..*After the mute, another flood within 1 minute removes you/);
    expect(status(f, "alice")).toBe("muted_lobby");
    f.clock.advance(3_000);
    f.board.runDueTimers();
    const third = flood(f, "alice");
    expect(third.error.message).toMatch(/Offense 3 within 1 minute: you are removed/);
    expect(status(f, "alice")).toBe("kicked");
  });

  it("formats spans for the refusal text", () => {
    expect([formatSpan(10 * MIN), formatSpan(HOUR), formatSpan(24 * HOUR), formatSpan(1500), formatSpan(1000)]).toEqual([
      "10 minutes",
      "1 hour",
      "24 hours",
      "1.5 seconds",
      "1 second",
    ]);
  });
});

describe("#admin-log", () => {
  it("exists from the start and refuses posts from users", () => {
    const f = board({}, "alice", "human1");
    for (const h of ["alice", "human1", ADMIN]) {
      const r = f.board.act(f.ctx(h), "post", { topic: "admin-log", body: "fake: kicked bob" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toMatch(/written by the board only/);
    }
    ok(f.board.act(f.ctx("alice"), "subscribe", { topic: "admin-log", level: "digest" }));
    const task = f.board.act(f.ctx("alice"), "task_create", { topic: "admin-log", title: "x" });
    expect(task.ok).toBe(false);
    if (!task.ok) expect(task.error.message).toMatch(/written by the board only/);
  });
});

describe("topic circuit breaker (A4.4)", () => {
  function pair(config: Partial<BoardConfig> = {}): Fixture {
    const f = board(config, "alice", "bob", "carol", "human1");
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "t" }));
    for (const h of ["bob", "carol", "human1"]) ok(f.board.act(f.ctx(h), "subscribe", { topic: "t", level: "wake" }));
    return f;
  }
  const say = (f: Fixture, h: string, body = "x"): ActResult => {
    f.clock.advance(1_000);
    return ok(f.board.act(f.ctx(h), "post", { topic: "t", body }));
  };
  const level = (f: Fixture, h: string): string | undefined =>
    f.sql.one<{ level: string }>("SELECT level FROM subscriptions WHERE handle = ? AND topic = 't'", h)?.level;
  /** Alternate `n` messages, alice first; returns the last post's result. */
  function alternate(f: Fixture, n: number): ActResult {
    let r: ActResult | undefined;
    for (let i = 0; i < n; i++) r = say(f, i % 2 === 0 ? "alice" : "bob");
    if (!r) throw new Error("no messages");
    return r;
  }

  it("drops both agents to digest after more than 10 alternating messages, and tells the coordinator", () => {
    const f = pair();
    f.sql.exec("UPDATE users SET is_coordinator = 1 WHERE handle = 'carol'");
    alternate(f, 10);
    expect([level(f, "alice"), level(f, "bob")]).toEqual(["wake", "wake"]);
    const r = say(f, "alice");
    expect([level(f, "alice"), level(f, "bob"), level(f, "carol")]).toEqual(["digest", "digest", "wake"]);
    expect(admins(r.notifications).map((n) => [n.reason, n.recipient, n.as])).toEqual([
      ["circuit_breaker", "alice", "user"],
      ["circuit_breaker", "bob", "user"],
      ["circuit_breaker", "carol", "coordinator"],
    ]);
    expect(adminLog(f)).toEqual([
      "circuit breaker: alice and bob alternated 11 messages in #t within 5 minutes with no third party; both set to digest there",
    ]);
    const rows = f.sql.all<{ actor: string; action: string }>("SELECT actor, action FROM audit ORDER BY seq DESC LIMIT 2");
    expect(rows).toEqual([
      { actor: "system", action: "circuit_breaker" },
      { actor: "alice", action: "post" },
    ]);
  });

  it("while the trip stands, the pair's @mentions of each other there are digest; others still ring; wake ends it (B32)", () => {
    const f = pair();
    alternate(f, 11);
    expect([level(f, "alice"), level(f, "bob")]).toEqual(["digest", "digest"]);
    const doorbell = (h: string): unknown => f.sql.one("SELECT handle FROM doorbells WHERE handle = ?", h);
    f.sql.exec("DELETE FROM doorbells");
    f.clock.advance(10 * MIN); // well past the breaker window: the trip still stands
    const r = say(f, "alice", "@bob are you there?");
    expect(doorbell("bob")).toBeUndefined();
    const row = f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE seq = ?", r.auditSeq ?? 0);
    expect(JSON.parse(row?.detail ?? "{}")).toMatchObject({ delivery: { mentions_digest_breaker: ["bob"] } });
    // The mention still reaches bob's inbox (digest).
    const inbox = ok(f.board.act<{ digest: { body: string }[] }>(f.ctx("bob"), "inbox", {})).value;
    expect(JSON.stringify(inbox)).toContain("are you there?");
    // Both ways.
    say(f, "bob", "@alice yes");
    expect(doorbell("alice")).toBeUndefined();
    // A third party's mention of a tripped agent rings.
    say(f, "carol", "@bob a question");
    expect(doorbell("bob")).toBeDefined();
    f.sql.exec("DELETE FROM doorbells");
    // In another topic the pair's mentions ring as usual.
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "u" }));
    ok(f.board.act(f.ctx("bob"), "subscribe", { topic: "u", level: "digest" }));
    f.clock.advance(1_000);
    ok(f.board.act(f.ctx("alice"), "post", { topic: "u", body: "@bob over here" }));
    expect(doorbell("bob")).toBeDefined();
    f.sql.exec("DELETE FROM doorbells");
    // bob sets #t back to wake: his trip there ends; back to digest, alice's mentions ring.
    const sub = ok(f.board.act(f.ctx("bob"), "subscribe", { topic: "t", level: "wake" }));
    const subRow = f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE seq = ?", sub.auditSeq ?? 0);
    expect(JSON.parse(subRow?.detail ?? "{}")).toMatchObject({ breaker_trip_ended: true });
    ok(f.board.act(f.ctx("bob"), "subscribe", { topic: "t", level: "digest" }));
    say(f, "alice", "@bob again");
    expect(doorbell("bob")).toBeDefined();
    // alice never set #t back to wake: bob's mentions of her stay digest.
    say(f, "bob", "@alice still?");
    expect(doorbell("alice")).toBeUndefined();
  });

  it("a third agent who spoke earlier in the window ends the run, not the trip (F review N30)", () => {
    const f = pair();
    say(f, "carol", "kickoff");
    alternate(f, 11);
    expect([level(f, "alice"), level(f, "bob"), level(f, "carol")]).toEqual(["digest", "digest", "wake"]);
    expect(adminLog(f)).toEqual([
      "circuit breaker: alice and bob alternated 11 messages in #t within 5 minutes with no third party; both set to digest there",
    ]);
  });

  it("records an undelivered coordinator notice when there is none", () => {
    const f = pair();
    const r = alternate(f, 11);
    expect(admins(r.notifications).at(-1)).toMatchObject({ recipient: null, undelivered: "no_coordinator" });
  });

  it("counts messages, not turns: double posts count each (design §6 reading, review m5)", () => {
    const f = pair();
    for (let i = 0; i < 5; i++) {
      say(f, i % 2 === 0 ? "alice" : "bob");
      say(f, i % 2 === 0 ? "alice" : "bob");
    }
    expect(level(f, "alice")).toBe("wake");
    say(f, "bob");
    expect([level(f, "alice"), level(f, "bob")]).toEqual(["digest", "digest"]);
  });

  it("needs both agents in the run: one agent alone never trips it", () => {
    const f = pair();
    for (let i = 0; i < 20; i++) say(f, "alice");
    expect(level(f, "alice")).toBe("wake");
  });

  it("finds the window start through the (topic, created_at) index, not a walk of the topic", () => {
    const f = pair();
    const plan = (sqlText: string, ...args: (string | number)[]): string =>
      f.sql
        .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sqlText}`, ...args)
        .map((r) => r.detail)
        .join(" | ");
    expect(plan(BREAKER_WINDOW_START_SQL, "t", 0)).toMatch(/USING COVERING INDEX messages_topic_time \(topic=\? AND created_at>\?\)/);
    expect(plan(BREAKER_RUN_SQL, "t", 1, 200)).toMatch(/INDEX messages_topic_seq \(topic=\? AND seq>\?\)/);
  });

  it("reads a bounded number of rows when the window is quiet", () => {
    const f = pair();
    alternate(f, 300);
    f.clock.advance(10 * MIN);
    let reads = 0;
    const one = f.sql.one.bind(f.sql);
    const all = f.sql.all.bind(f.sql);
    f.sql.one = ((q: string, ...a: never[]) => {
      if (/FROM messages/.test(q)) reads += 1;
      return one(q, ...a);
    }) as typeof f.sql.one;
    f.sql.all = ((q: string, ...a: never[]) => {
      const rows = all(q, ...a);
      if (/FROM messages\s+WHERE topic = \? AND seq >= \?/.test(q)) reads += rows.length;
      return rows;
    }) as typeof f.sql.all;
    say(f, "carol");
    // The window start lookup, plus at most the posts inside the window.
    expect(reads).toBeLessThan(10);
  });

  it("does not trip when a third party speaks: another agent or a person", () => {
    for (const third of ["carol", "human1"]) {
      const f = pair();
      alternate(f, 6);
      say(f, third);
      alternate(f, 10);
      expect([level(f, "alice"), level(f, "bob")], third).toEqual(["wake", "wake"]);
    }
  });

  it("does not trip when one of the two is a person", () => {
    const f = pair();
    ok(f.board.act(f.ctx("human1"), "subscribe", { topic: "t", level: "wake" }));
    for (let i = 0; i < 15; i++) say(f, i % 2 === 0 ? "alice" : "human1");
    expect([level(f, "alice"), level(f, "human1")]).toEqual(["wake", "wake"]);
  });

  it("ignores system messages in the run", () => {
    const f = pair();
    alternate(f, 6);
    f.sql.exec(
      `INSERT INTO messages (topic, author, author_kind, via, body, is_system, created_at)
       VALUES ('t', 'system', 'system', 'system', 'note', 1, ?)`,
      f.clock.t,
    );
    alternate(f, 5);
    expect(level(f, "bob")).toBe("digest");
  });

  it("only counts messages inside the window", () => {
    const f = pair();
    alternate(f, 6);
    f.clock.advance(5 * MIN);
    alternate(f, 6);
    expect([level(f, "alice"), level(f, "bob")]).toEqual(["wake", "wake"]);
  });

  it("starts a new run after a trip", () => {
    const f = pair();
    alternate(f, 11);
    ok(f.board.act(f.ctx("alice"), "subscribe", { topic: "t", level: "wake" }));
    ok(f.board.act(f.ctx("bob"), "subscribe", { topic: "t", level: "wake" }));
    alternate(f, 10);
    expect([level(f, "alice"), level(f, "bob")]).toEqual(["wake", "wake"]);
    alternate(f, 1);
    expect([level(f, "alice"), level(f, "bob")]).toEqual(["digest", "digest"]);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM audit WHERE action = 'circuit_breaker'")).toEqual({ n: 2 });
  });

  it("leaves an off subscription off, and does nothing when neither is at wake", () => {
    const f = pair();
    ok(f.board.act(f.ctx("bob"), "subscribe", { topic: "t", level: "off" }));
    alternate(f, 11);
    expect([level(f, "alice"), level(f, "bob")]).toEqual(["digest", "off"]);
    const g = pair();
    ok(g.board.act(g.ctx("alice"), "subscribe", { topic: "t", level: "digest" }));
    ok(g.board.act(g.ctx("bob"), "subscribe", { topic: "t", level: "digest" }));
    alternate(g, 15);
    expect(g.sql.one("SELECT COUNT(*) AS n FROM audit WHERE action = 'circuit_breaker'")).toEqual({ n: 0 });
  });

  it("takes its thresholds from the config", () => {
    const f = pair({ breakerMessages: 3, breakerWindowMs: 10_000 });
    alternate(f, 4);
    expect(level(f, "bob")).toBe("digest");
  });
});

describe("failed sign-in limit (B5)", () => {
  const rows = (f: Fixture, action: string): Record<string, unknown>[] =>
    f.sql
      .all<{ detail: string; actor: string; result: string }>(
        "SELECT detail, actor, result FROM audit WHERE action = ? ORDER BY seq",
        action,
      )
      .map((r) => ({ actor: r.actor, result: r.result, ...JSON.parse(r.detail) }));

  it("audits the first failures, writes one sign_in_limited row, then counts the rest by reason", () => {
    const f = board({ authFailureLimit: 3, authFailureWindowMs: 60_000 }, "alice");
    const results = [1, 2, 3, 4, 5, 6].map((i) => f.board.authenticate(`bad-${i}`, { via: "api", source: "ip:a" }));
    f.board.authenticate(undefined, { via: "api", source: "ip:a" });
    expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "unknown_token",
      "unknown_token",
      "unknown_token",
      "rate_limited",
      "rate_limited",
      "rate_limited",
    ]);
    expect(results[3]).toMatchObject({ auditSeq: expect.any(Number), retryAfterMs: 60_000 });
    expect(results[5]).toMatchObject({ auditSeq: undefined, retryAfterMs: 60_000 });
    expect(rows(f, "auth")).toHaveLength(3);
    expect(rows(f, "auth")[2]).toMatchObject({ source: "ip:a", limit_reached: true });
    expect(rows(f, "sign_in_limited")).toEqual([
      expect.objectContaining({ actor: "anonymous", result: "denied", source: "ip:a", failure: "unknown_token", code: "rate_limited" }),
    ]);
    // A valid token from the same source still works.
    expect(f.board.authenticate(f.tokens.get("alice"), { via: "api", source: "ip:a" })).toMatchObject({ ok: true });
    // Another source has its own window.
    expect(f.board.authenticate("bad", { via: "api", source: "ip:b" })).toMatchObject({ reason: "unknown_token" });
    expect(rows(f, "sign_in_suppressed")).toEqual([]);
    // When the window ends, the next sign-in from ANY source (here a valid one) flushes the counts.
    f.clock.advance(60_000);
    f.board.authenticate(f.tokens.get("alice"), { via: "api", source: "ip:c" });
    expect(rows(f, "sign_in_suppressed")).toEqual([
      expect.objectContaining({
        actor: "system",
        result: "ok",
        source: "ip:a",
        suppressed: { unknown_token: 2, missing_token: 1 },
        total: 3,
      }),
    ]);
    // Flushed once only.
    f.board.flushAuthWindows();
    expect(rows(f, "sign_in_suppressed")).toHaveLength(1);
  });

  it("flushes from flushAuthWindows (the DO alarm) without any further sign-in", () => {
    const f = board({ authFailureLimit: 1, authFailureWindowMs: 1_000 });
    for (let i = 0; i < 4; i++) f.board.authenticate(undefined, { via: "api", source: "s" });
    f.board.flushAuthWindows();
    expect(rows(f, "sign_in_suppressed")).toEqual([]);
    f.clock.advance(1_000);
    f.board.flushAuthWindows();
    expect(rows(f, "sign_in_suppressed")).toEqual([expect.objectContaining({ total: 2, suppressed: { missing_token: 2 } })]);
  });

  it("flushes a window's counts before evicting it to keep the map bounded", () => {
    const f = board({ authFailureLimit: 1, authFailureWindowMs: 3_600_000, authFailureBoardLimit: 10_000 });
    for (let i = 0; i < 3; i++) f.board.authenticate(undefined, { via: "api", source: "first" });
    for (let i = 0; i < 1_000; i++) f.board.authenticate(undefined, { via: "api", source: `s${i}` });
    expect(rows(f, "sign_in_suppressed")).toEqual([
      expect.objectContaining({ source: "first", total: 1, early: true }),
    ]);
  });

  it("caps failed sign-in rows across sources and writes one board-wide summary (B30)", () => {
    const f = board({ authFailureLimit: 2, authFailureWindowMs: 60_000, authFailureBoardLimit: 5, authFailureBoardWindowMs: 600_000 }, "alice");
    // Ten sources, each failing three times: per-source alone would write 2 auth rows and 1 limited row each.
    const results: ReturnType<typeof f.board.authenticate>[] = [];
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 3; j++) results.push(f.board.authenticate(`bad-${i}-${j}`, { via: "api", source: `ip:${i}` }));
    }
    const written = f.sql.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit WHERE action IN ('auth', 'sign_in_limited', 'sign_in_suppressed')",
    );
    expect(written).toEqual({ n: 5 });
    // The real reason still comes back for a failure the cap kept off the record.
    // The cap-spent sources are still limited per source: their third failure is a 429.
    expect(results.at(-1)).toEqual({ ok: false, reason: "rate_limited", auditSeq: undefined, retryAfterMs: 60_000 });
    // A valid token is never affected.
    expect(f.board.authenticate(f.tokens.get("alice"), { via: "api", source: "ip:99" })).toMatchObject({ ok: true });
    expect(rows(f, "sign_in_suppressed")).toEqual([]);
    // Window end: one board-wide row with the counts and where they came from.
    f.clock.advance(600_000);
    f.board.authenticate(f.tokens.get("alice"), { via: "api", source: "ip:99" });
    const summary = rows(f, "sign_in_suppressed").find((r) => r.scope === "board");
    expect(summary).toMatchObject({ actor: "system", limit: 5, suppressed: { unknown_token: 16 }, total: 16 });
    expect(Object.keys((summary as { sources: object }).sources)).toHaveLength(8);
    // A later window admits rows again.
    f.clock.advance(600_000);
    expect(f.board.authenticate("later", { via: "api", source: "ip:0" })).toMatchObject({ auditSeq: expect.any(Number) });
  });

  it("keeps limiting each source (429) after the board cap is spent, and attributes the counts (B30)", () => {
    const f = board({ authFailureLimit: 2, authFailureWindowMs: 60_000, authFailureBoardLimit: 2, authFailureBoardWindowMs: 600_000 }, "alice");
    // One source spends the whole board cap.
    for (let i = 0; i < 2; i++) f.board.authenticate(`x${i}`, { via: "api", source: "ip:a" });
    // Another source, board cap spent: still limited per source after its own two failures.
    const rs = [0, 1, 2, 3].map((i) => f.board.authenticate(`y${i}`, { via: "api", source: "ip:b" }));
    expect(rs.map((r) => (r.ok ? "ok" : r.reason))).toEqual(["unknown_token", "unknown_token", "rate_limited", "rate_limited"]);
    expect(rs[3]).toMatchObject({ retryAfterMs: 60_000 });
    f.clock.advance(600_000);
    f.board.flushAuthWindows();
    const summary = rows(f, "sign_in_suppressed").find((r) => r.scope === "board");
    expect(summary).toMatchObject({ total: 2, sources: { "ip:b": 2 } });
  });

  it("names the handle of a revoked token in the board summary, bounded (B30)", () => {
    const f = board({ authFailureLimit: 100, authFailureBoardLimit: 1, authFailureBoardWindowMs: 600_000 }, "alice");
    const old = f.tokens.get("alice") as string;
    f.sql.exec("INSERT INTO revoked_tokens (token_hash, handle, revoked_at) VALUES (?, 'alice', 0)", sha256(old));
    f.sql.exec("UPDATE users SET token_hash = NULL WHERE handle = 'alice'");
    for (let i = 0; i < 60; i++) f.board.authenticate(`t${i}`, { via: "api", source: `ip:${i}` });
    for (let i = 0; i < 3; i++) f.board.authenticate(old, { via: "api", source: "ip:r" });
    f.clock.advance(600_000);
    f.board.flushAuthWindows();
    const b = rows(f, "sign_in_suppressed").find((r) => r.scope === "board") as { sources: Record<string, number>; handles?: Record<string, number> };
    expect(Object.keys(b.sources)).toHaveLength(51);
    expect(b.sources.other).toBeGreaterThan(0);
    expect(b.handles).toEqual({ alice: 3 });
  });

  it("folds a per-source summary into the board-wide one when the cap is spent (B30)", () => {
    const f = board({ authFailureLimit: 1, authFailureWindowMs: 1_000, authFailureBoardLimit: 3, authFailureBoardWindowMs: 3_600_000 });
    // ip:a: auth row, limited row, then two counted (its own summary is due at 1 s).
    for (let i = 0; i < 4; i++) f.board.authenticate(undefined, { via: "api", source: "ip:a" });
    // The board window has one row left (the summary); use it up first with another source.
    f.board.authenticate(undefined, { via: "api", source: "ip:b" });
    f.clock.advance(1_000);
    f.board.flushAuthWindows();
    expect(rows(f, "sign_in_suppressed")).toEqual([]);
    f.clock.advance(3_600_000);
    f.board.flushAuthWindows();
    expect(rows(f, "sign_in_suppressed")).toEqual([
      expect.objectContaining({ scope: "board", total: 2, suppressed: { missing_token: 2 } }),
    ]);
  });

  it("counts missing tokens too, and defaults the source", () => {
    const f = board({ authFailureLimit: 1 }, "alice");
    expect(f.board.authenticate(undefined, { via: "api" })).toMatchObject({ reason: "missing_token" });
    expect(f.board.authenticate(undefined, { via: "api" })).toMatchObject({ reason: "rate_limited" });
    expect(rows(f, "auth")[0]).toMatchObject({ source: "unknown" });
  });
});

describe("config validation (review m2)", () => {
  it("accepts the defaults and refuses non-positive values or out-of-order Lobby spans", () => {
    expect(validateConfig(DEFAULT_CONFIG)).toBeUndefined();
    expect(validateConfig({ ...DEFAULT_CONFIG, lobbyPostLimit: 0 })).toMatch(/lobbyPostLimit/);
    expect(validateConfig({ ...DEFAULT_CONFIG, breakerMessages: 1.5 })).toMatch(/breakerMessages/);
    expect(validateConfig({ ...DEFAULT_CONFIG, lobbyWindowMs: HOUR })).toMatch(/lobbyWindowMs must be less/);
    expect(validateConfig({ ...DEFAULT_CONFIG, lobbyMuteWithinMs: 25 * HOUR })).toMatch(/must not exceed/);
    // The one list-valued setting (F review N09).
    for (const bad of [[30_000, 0], [-1], [1.5], [Number.NaN]]) {
      expect(validateConfig({ ...DEFAULT_CONFIG, doorbellRetryMs: bad }), String(bad)).toMatch(/doorbellRetryMs/);
    }
    expect(validateConfig({ ...DEFAULT_CONFIG, doorbellRetryMs: [1, 2] })).toBeUndefined();
    expect(
      () => new Board({ sql: new NodeSqliteSql(), now: () => 0, sha256, config: { lobbyWindowMs: 2 * HOUR } }),
    ).toThrow(/invalid board config/);
  });
});

describe("follow-ups after a committed call (review m3)", () => {
  it("a follow-up that throws leaves the call ok and its own error audit row", () => {
    const f = board({ breakerMessages: 2 }, "alice", "bob");
    ok(f.board.act(f.ctx("alice"), "topic_create", { name: "t" }));
    ok(f.board.act(f.ctx("bob"), "subscribe", { topic: "t", level: "wake" }));
    const original = circuitBreaker.run;
    circuitBreaker.run = () => {
      throw new Error("boom");
    };
    try {
      ok(f.board.act(f.ctx("alice"), "post", { topic: "t", body: "1" }));
      ok(f.board.act(f.ctx("bob"), "post", { topic: "t", body: "2" }));
      const r = f.board.act(f.ctx("alice"), "post", { topic: "t", body: "3" });
      expect(r.ok).toBe(true);
    } finally {
      circuitBreaker.run = original;
    }
    expect(f.sql.one("SELECT COUNT(*) AS n FROM messages WHERE topic = 't'")).toEqual({ n: 3 });
    const row = f.sql.one<{ actor: string; result: string; detail: string }>(
      "SELECT actor, result, detail FROM audit WHERE action = 'circuit_breaker'",
    );
    expect(row).toMatchObject({ actor: "system", result: "error" });
    expect(JSON.parse(row?.detail ?? "{}")).toMatchObject({ code: "internal", internal: "boom" });
  });
});
