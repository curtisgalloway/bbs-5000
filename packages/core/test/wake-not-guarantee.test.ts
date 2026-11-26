// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #71: a wake is a nudge, not a guarantee. A lost wake may delay a
 * message; it must never drop one. And a wake carries a pointer, never text.
 *
 * - Whatever happens to a doorbell (no adapter, a failed or held ring, a
 *   reconnect that loses it, the wake budget), the unread state stays on the
 *   board until `bbs_inbox`, and the next `bbs_inbox` returns every item.
 * - A guard: a distinctive marker fed through every user-text path (message
 *   body, reply, task title and description, task comment, role) appears in no
 *   ring text, and a ring holds nothing but the one fixed-shape line.
 */

import { describe, expect, it } from "vitest";
import type { ActResult, BoardConfig, CallContext, NotificationWork, RingNotification } from "../src/types.ts";
import { AGENT_GUIDE } from "../src/agent-guide.ts";
import { makeBoard, type Fixture } from "./helpers.ts";

const DEBOUNCE = 5_000;
const MARKER = "ZQX-marker-7731";

function ok<T>(r: ActResult<T>): Extract<ActResult<T>, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
}

function ringsOf(rs: ActResult | ActResult[]): RingNotification[] {
  const list = Array.isArray(rs) ? rs : [rs];
  return list.flatMap((r) => (r.ok ? r.notifications : []).filter((n): n is RingNotification => n.type === "ring"));
}

interface Inbox {
  wake: { body: string }[];
  digest: { body?: string; messages?: { body: string }[] }[];
  notices: { reason: string }[];
}

interface World extends Fixture {
  session: string;
  ws(): CallContext;
  attach(state?: "idle" | "busy"): ActResult;
  settle(): ActResult[];
  /** Everything every call returned as a ring, so the guard can read it all. */
  allRings: RingNotification[];
  /** Run an action and keep any ring it returns. */
  act<T = unknown>(handle: string, action: string, params: Record<string, unknown>): ActResult<T>;
}

/** a and b are agents; b joined and holds #t at wake and the Lobby at digest; a created #t. */
function world(config?: Partial<BoardConfig>): World {
  const f = makeBoard(config ? { config } : {});
  f.addUser("a");
  f.addUser("b");
  ok(f.board.act(f.ctx("a"), "join", {}));
  const session = ok(f.board.act<{ session: string }>(f.ctx("b"), "join", {})).value.session;
  ok(f.board.act(f.ctx("a"), "topic_create", { name: "t" }));
  f.sql.exec("DELETE FROM timers WHERE kind = 'topic_announce'");
  ok(f.board.act(f.ctx("b"), "subscribe", { topic: "t", level: "wake" }));
  ok(f.board.act(f.ctx("b"), "inbox", {}));
  const allRings: RingNotification[] = [];
  const keep = <T>(r: ActResult<T>): ActResult<T> => {
    allRings.push(...ringsOf(r));
    return r;
  };
  const w: World = {
    ...f,
    session,
    allRings,
    ws: () => ({ handle: "b", via: "ws", session }),
    act: (handle, action, params) => keep(f.board.act(f.ctx(handle), action, params)),
    attach(state = "idle") {
      ok(f.board.socketAct({ handle: "b", via: "ws" }, "socket_open", {}));
      return keep(f.board.socketAct(w.ws(), "socket_hello", { harness: "claude-code", machine: "workstation-1", state }));
    },
    settle() {
      f.clock.advance(DEBOUNCE);
      const rs = f.board.runDueTimers();
      for (const r of rs) allRings.push(...ringsOf(r));
      return rs;
    },
  };
  return w;
}

/**
 * Give b one of each kind of unread item: a mention in its wake topic, a
 * plain post there, a post in a digest topic, an @mention in a topic it never
 * joined, and a task assigned to it.
 */
function unreadForB(w: World): void {
  ok(w.act("a", "topic_create", { name: "quiet" }));
  w.sql.exec("DELETE FROM timers WHERE kind = 'topic_announce'");
  ok(w.act("b", "subscribe", { topic: "quiet", level: "digest" }));
  ok(w.act("a", "topic_create", { name: "elsewhere" }));
  w.sql.exec("DELETE FROM timers WHERE kind = 'topic_announce'");
  ok(w.act("b", "inbox", {}));
  ok(w.act("a", "post", { topic: "t", body: "@b mention in wake topic" }));
  ok(w.act("a", "post", { topic: "t", body: "plain post in wake topic" }));
  ok(w.act("a", "post", { topic: "quiet", body: "digest post" }));
  ok(w.act("a", "post", { topic: "elsewhere", body: "@b mention in an unjoined topic" }));
  const task = ok(w.act<{ task: { id: number } }>("a", "task_create", { topic: "t", title: "do it" }));
  ok(w.act("a", "task_assign", { task: task.value.task.id, assignee: "b" }));
}

/** The next `bbs_inbox` returns every item `unreadForB` made, then nothing. */
function expectEverythingInInbox(w: World): void {
  const first = ok(w.act<Inbox>("b", "inbox", {})).value;
  const wakeBodies = first.wake.map((m) => m.body);
  expect(wakeBodies).toContain("@b mention in wake topic");
  expect(wakeBodies).toContain("plain post in wake topic");
  expect(wakeBodies).toContain("@b mention in an unjoined topic");
  const digestBodies = first.digest.flatMap((m) => (m.messages ? m.messages.map((x) => x.body) : [m.body ?? ""]));
  expect(digestBodies).toContain("digest post");
  expect(first.notices.map((n) => n.reason)).toContain("task_assigned");
  expect(w.sql.one("SELECT 1 AS x FROM doorbells WHERE handle = 'b'")).toBeUndefined();
  const second = ok(w.act<Inbox>("b", "inbox", {})).value;
  expect(second.wake).toEqual([]);
  expect(second.digest).toEqual([]);
  expect(second.notices).toEqual([]);
}

describe("a lost wake delays an item and never drops it (issue #71)", () => {
  it("no adapter is attached at all: the doorbell waits, and bbs_inbox returns everything", () => {
    const w = world();
    unreadForB(w);
    expect(w.settle().length).toBeGreaterThan(0);
    expect(w.allRings).toEqual([]);
    expect(w.sql.one("SELECT 1 AS x FROM doorbells WHERE handle = 'b'")).toBeDefined();
    expectEverythingInInbox(w);
  });

  it("every ring fails, through all the retries: bbs_inbox still returns everything", () => {
    const w = world();
    w.attach();
    unreadForB(w);
    for (let i = 0; i < 6; i++) {
      for (const r of ringsOf(w.settle())) {
        ok(w.board.socketAct(w.ws(), "ring_result", { id: r.id, result: "failed" }));
      }
      w.clock.advance(11 * 60_000);
    }
    expect(w.allRings.length).toBeGreaterThan(1);
    expectEverythingInInbox(w);
  });

  it("a ring held busy and never rung again: bbs_inbox still returns everything", () => {
    const w = world();
    w.attach("busy");
    unreadForB(w);
    expect(ringsOf(w.settle())).toEqual([]);
    expect(w.sql.one("SELECT held_at FROM doorbells WHERE handle = 'b'")).toMatchObject({ held_at: expect.any(Number) });
    expectEverythingInInbox(w);
  });

  it("a ring answered held_busy by the adapter: bbs_inbox still returns everything", () => {
    const w = world();
    w.attach();
    unreadForB(w);
    const [r] = ringsOf(w.settle());
    ok(w.board.socketAct(w.ws(), "ring_result", { id: r?.id, result: "held_busy" }));
    expect(w.sql.one("SELECT sent_at FROM doorbells WHERE handle = 'b'")).toEqual({ sent_at: null });
    expectEverythingInInbox(w);
  });

  it("a ring lost to a reconnect (the socket closes before any answer): bbs_inbox still returns everything", () => {
    const w = world();
    w.attach();
    unreadForB(w);
    expect(ringsOf(w.settle())).toHaveLength(1);
    ok(w.board.socketAct({ handle: "b", via: "ws" }, "socket_close", { session: w.session, code: 1006 }));
    expectEverythingInInbox(w);
  });

  it("a ring the Durable Object could not send (no open socket): bbs_inbox still returns everything", () => {
    const w = world();
    w.attach();
    unreadForB(w);
    const [r] = ringsOf(w.settle());
    ok(w.board.ringUndeliverable("b", r?.id ?? "", w.session));
    expectEverythingInInbox(w);
  });

  it("past the wake budget the ring is withheld, and bbs_inbox still returns everything", () => {
    const w = world({ wakeBudgetPerHour: 1 });
    w.attach();
    ok(w.act("a", "post", { topic: "t", body: "uses the budget" }));
    const [first] = ringsOf(w.settle());
    ok(w.board.socketAct(w.ws(), "ring_result", { id: first?.id, result: "turn_started", confirmed: true }));
    ok(w.act("b", "inbox", {}));
    unreadForB(w);
    const before = w.allRings.length;
    w.settle();
    expect(w.allRings).toHaveLength(before);
    expectEverythingInInbox(w);
  });

  it("a ring delivered and confirmed whose turn never reads the inbox leaves everything unread", () => {
    const w = world();
    w.attach();
    unreadForB(w);
    const [r] = ringsOf(w.settle());
    ok(w.board.socketAct(w.ws(), "ring_result", { id: r?.id, result: "turn_started", confirmed: true }));
    expectEverythingInInbox(w);
  });
});

describe("a ring carries a pointer and never user text (issue #71)", () => {
  /** The one fixed shape: `BBS-5000: ` counts and phrases, then the closing sentence. */
  const SHAPE = /^BBS-5000: [^\n]+\. Call bbs_inbox now, then continue your task\.$/;

  it("a marker in a message body, reply, task title, description, comment and role reaches no ring", () => {
    const w = world();
    w.attach();
    ok(w.act("a", "join", { role: `${MARKER} role` }));
    const post = ok(w.act<{ seq: number }>("a", "post", { topic: "t", body: `@b ${MARKER} body` }));
    ok(w.act("a", "post", { topic: "t", body: `${MARKER} reply`, reply_to: post.value.seq }));
    ok(w.act("a", "post", { topic: "Lobby", body: `@b ${MARKER} in the Lobby` }));
    const task = ok(
      w.act<{ task: { id: number } }>("a", "task_create", {
        topic: "t",
        title: `${MARKER} title`,
        description: `${MARKER} description`,
      }),
    );
    ok(w.act("a", "task_assign", { task: task.value.task.id, assignee: "b" }));
    ok(w.act("a", "task_comment", { task: task.value.task.id, body: `${MARKER} comment` }));
    for (let i = 0; i < 4; i++) {
      for (const r of ringsOf(w.settle())) {
        ok(w.board.socketAct(w.ws(), "ring_result", { id: r.id, result: "failed" }));
      }
    }
    expect(w.allRings.length).toBeGreaterThan(0);
    for (const r of w.allRings) {
      expect(r.text).not.toContain(MARKER);
      expect(r.text).not.toContain("marker");
      expect(r.text).toMatch(SHAPE);
    }
    // The ring itself holds an id, the recipient, the session and the text, nothing else.
    for (const r of w.allRings) {
      expect(Object.keys(r).sort()).toEqual(["id", "recipient", "session", "text", "type"]);
    }
  });

  it("the doorbell state stored on the board holds counts, never the marker", () => {
    const w = world();
    w.attach();
    ok(w.act("a", "post", { topic: "t", body: `@b ${MARKER} body` }));
    const row = w.sql.one<{ summary: string }>("SELECT summary FROM doorbells WHERE handle = 'b'");
    expect(row?.summary).not.toContain(MARKER);
  });

  it("every notification the board returns besides a ring is message, task or admin work, never ring text", () => {
    const w = world();
    w.attach();
    const r = ok(w.act("a", "post", { topic: "t", body: `@b ${MARKER} body` }));
    const types = new Set((r.notifications as NotificationWork[]).map((n) => n.type));
    expect([...types].every((t) => t === "message" || t === "task" || t === "admin" || t === "ring")).toBe(true);
    expect(ringsOf(r)).toEqual([]);
  });
});

describe("the instruction text every harness and connector receives (issue #71)", () => {
  it("tells an agent to read its inbox after joining and, with no doorbell, at the start of a turn", () => {
    expect(AGENT_GUIDE).toContain("Call bbs_inbox right after joining");
    expect(AGENT_GUIDE).toContain("before you hand work back to your user");
    expect(AGENT_GUIDE).toContain("Without doorbells (a remote connector), call it at the start of any turn that uses the board");
  });
});
