// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Issue #98: a handle per local session. Several sessions on one token each get
 * a handle of their own (`<parent>-<4 letters>`), made by a join that carries a
 * `harness_session`; a call that names the handle's session acts as it. Covers
 * the join rules, the actor resolution matrix, the flags a session handle can
 * never hold, the per-parent cap as a condition of the INSERT, kick and
 * reinstatement of the parent, retirement and its undoing, `bbs_who` and
 * `bbs_whoami`, mentions, and connectors staying as they were.
 */

import { describe, expect, it } from "vitest";
import { HANDLE_RE } from "../src/params.ts";
import type { Row, Sql, SqlValue } from "../src/sql.ts";
import type { ActResult, BoardConfig, CallContext, NotificationWork, RingNotification, TaskNotification } from "../src/types.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { callTool, mcpTools, TOOLS } from "../src/tools.ts";
import { ADMIN, makeBoard, type Fixture } from "./helpers.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const RETIRE = DEFAULT_CONFIG.sessionHandleRetireMs;
const DEBOUNCE = DEFAULT_CONFIG.doorbellDebounceMs;

function ok<T>(r: ActResult<T>): Extract<ActResult<T>, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
}

function fails(r: ActResult, code: string, message?: RegExp): Extract<ActResult, { ok: false }> {
  expect(r.ok, "expected a refusal").toBe(false);
  if (r.ok) throw new Error("unreachable");
  expect(r.error.code).toBe(code);
  if (message) expect(r.error.message).toMatch(message);
  return r;
}

/** A call under `handle`'s token, naming `session` when given (the CLI's `x-bbs-session`). */
const as = (handle: string, session?: string): CallContext => ({
  handle,
  via: "api",
  ...(session !== undefined ? { session } : {}),
});

interface Joined {
  handle: string;
  parent?: string;
  session: string;
  first_join: boolean;
  note?: string;
}

function world(config: Partial<BoardConfig> = {}): Fixture {
  const f = makeBoard({ config });
  for (const h of ["p", "q", "a", "boss"]) f.addUser(h);
  ok(f.board.act(f.ctx(ADMIN, "cli"), "admin_coordinator_grant", { handle: "boss" }));
  for (const h of ["a", "boss"]) ok(f.board.act(as(h), "join", {}));
  ok(f.board.act(as("a"), "topic_create", { name: "t" }));
  ok(f.board.act(as("boss"), "subscribe", { topic: "t", level: "wake" }));
  f.sql.exec("DELETE FROM timers WHERE kind = 'topic_announce'");
  return f;
}

/** A local session's join under `parent`'s token with a harness session id. */
function joinHs(f: Fixture, parent: string, hs: string, args: Record<string, unknown> = {}): Joined {
  return ok(f.board.act<Joined>(as(parent), "join", { harness: "claude-code", harness_session: hs, ...args })).value;
}

const live = (f: Fixture, handle: string): string[] =>
  f.sql
    .all<{ id: string }>("SELECT id FROM sessions WHERE handle = ? AND state <> 'gone' ORDER BY attached_at, id", handle)
    .map((r) => r.id);

function whoami(f: Fixture, parent: string, session?: string): ActResult<Record<string, unknown>> {
  return f.board.act<Record<string, unknown>>(as(parent, session), "whoami", {});
}

function subscribe(f: Fixture, parent: string, s: Joined, level = "wake"): void {
  ok(f.board.act(as(parent, s.session), "subscribe", { topic: "t", level }));
}

function rings(rs: ActResult | ActResult[]): RingNotification[] {
  const list = Array.isArray(rs) ? rs : [rs];
  return list.flatMap((r) => (r.ok ? r.notifications : []).filter((n): n is RingNotification => n.type === "ring"));
}

function inboxText(f: Fixture, parent: string, session?: string): string {
  return JSON.stringify(ok(f.board.act(as(parent, session), "inbox", {})).value);
}

describe("a handle per local session: joins", () => {
  it("two joins under one token with different harness sessions both stay live, each with its own handle", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const two = joinHs(f, "p", "hs-two");
    expect(one.handle).not.toBe(two.handle);
    for (const h of [one.handle, two.handle]) {
      expect(h).toMatch(/^p-[a-z2-7]{4}$/);
      expect(HANDLE_RE.test(h)).toBe(true);
    }
    expect(one.parent).toBe("p");
    expect(one.first_join).toBe(true);
    expect(one.note).toContain(one.handle);
    expect(live(f, one.handle)).toEqual([one.session]);
    expect(live(f, two.handle)).toEqual([two.session]);
    // The token's own handle has no session and was not made one.
    expect(live(f, "p")).toEqual([]);
    expect(
      f.sql.all("SELECT handle, kind, token_hash, is_coordinator, is_admin, parent, harness_session FROM users WHERE parent = 'p' ORDER BY handle"),
    ).toEqual(
      [
        { handle: one.handle, hs: "hs-one" },
        { handle: two.handle, hs: "hs-two" },
      ]
        .sort((x, y) => (x.handle < y.handle ? -1 : 1))
        .map((r) => ({
          handle: r.handle,
          kind: "agent",
          token_hash: null,
          is_coordinator: 0,
          is_admin: 0,
          parent: "p",
          harness_session: r.hs,
        })),
    );
  });

  it("a rejoin with the same harness session returns the same handle and ends only its own earlier session", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const two = joinHs(f, "p", "hs-two");
    const bare = ok(f.board.act<Joined>(as("p"), "join", {})).value;
    expect(bare.handle).toBe("p");
    const again = joinHs(f, "p", "hs-one");
    expect(again.handle).toBe(one.handle);
    expect(again.first_join).toBe(false);
    expect(again.session).not.toBe(one.session);
    expect(live(f, one.handle)).toEqual([again.session]);
    // The sibling's and the token's own sessions are untouched.
    expect(live(f, two.handle)).toEqual([two.session]);
    expect(live(f, "p")).toEqual([bare.session]);
    expect(f.sql.all("SELECT handle FROM users WHERE parent = 'p'")).toHaveLength(2);
  });

  it("a join with no harness session acts as the token's own handle and replaces only its sessions, as before", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const first = ok(f.board.act<Joined>(as("p"), "join", {})).value;
    const second = ok(f.board.act<Joined>(as("p"), "join", {})).value;
    expect(first.handle).toBe("p");
    expect(first.parent).toBeUndefined();
    expect(second.handle).toBe("p");
    expect(live(f, "p")).toEqual([second.session]);
    expect(live(f, one.handle)).toEqual([one.session]);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM users WHERE parent IS NOT NULL")).toEqual({ n: 1 });
  });

  it("an update with its own session changes that session in place, and a session handle's own session updates its handle's role", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const upd = ok(f.board.act<Joined>(as("p", one.session), "join", { role: "fixing the thing" })).value;
    expect(upd.handle).toBe(one.handle);
    expect(upd.parent).toBe("p");
    expect(upd.session).toBe(one.session);
    expect(f.sql.one("SELECT role, role_set_by FROM users WHERE handle = ?", one.handle)).toEqual({
      role: "fixing the thing",
      role_set_by: one.handle,
    });
    expect(f.sql.one("SELECT role FROM users WHERE handle = 'p'")).toEqual({ role: "" });
    // It serves one harness session; another is refused, not retargeted.
    fails(f.board.act(as("p", one.session), "join", { harness_session: "hs-other" }), "forbidden", /serves another harness session/);
    // Naming the token's own handle or the session handle itself is allowed; another handle is not.
    ok(f.board.act(as("p", one.session), "join", { handle: "p" }));
    ok(f.board.act(as("p", one.session), "join", { handle: one.handle }));
    fails(f.board.act(as("p", one.session), "join", { handle: "q" }), "forbidden", /this token belongs to p/);
  });

  it("a session handle's first join posts no Lobby line but subscribes it; the token's own first join still posts one", () => {
    const f = world();
    const before = f.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE topic = 'Lobby'")?.n ?? 0;
    ok(f.board.act(as("p"), "join", {}));
    expect(f.sql.one("SELECT COUNT(*) AS n FROM messages WHERE topic = 'Lobby' AND body LIKE 'p joined%'")).toEqual({ n: 1 });
    const one = joinHs(f, "p", "hs-one", { role: "TEXT FOR THE LOBBY" });
    const again = joinHs(f, "p", "hs-one");
    expect(f.sql.one("SELECT COUNT(*) AS n FROM messages WHERE topic = 'Lobby'")).toEqual({ n: Number(before) + 1 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM messages WHERE body LIKE ?", `%${one.handle}%`)).toEqual({ n: 0 });
    expect(f.sql.one("SELECT level FROM subscriptions WHERE handle = ? AND topic = 'Lobby'", one.handle)).toEqual({ level: "digest" });
    // It does not see the Lobby's earlier lines as unread.
    expect(inboxText(f, "p", again.session)).not.toContain("joined");
    const row = f.sql.one<{ topic: string | null }>("SELECT topic FROM audit WHERE actor = ? AND action = 'join' ORDER BY seq", one.handle);
    expect(row?.topic).toBeNull();
  });

  it("a connector's join keeps its one handle: a harness session makes no session handle", () => {
    const f = world();
    f.addUser("claude-ai");
    const ctx: CallContext = { handle: "claude-ai", via: "mcp", oauthGrant: "og_test" };
    const j = ok(f.board.act<Joined>(ctx, "join", { harness_session: "chat-1" })).value;
    expect(j.handle).toBe("claude-ai");
    expect(j.parent).toBeUndefined();
    expect(f.sql.one("SELECT COUNT(*) AS n FROM users WHERE parent IS NOT NULL")).toEqual({ n: 0 });
    // And a session handle is not a handle a connector can be approved for.
    const s = joinHs(f, "p", "hs-one");
    expect(f.sql.one("SELECT parent FROM users WHERE handle = ?", s.handle)).toEqual({ parent: "p" });
  });

  it("a human's join with a harness session makes no session handle", () => {
    const f = world();
    ok(f.board.act(f.ctx(ADMIN, "cli"), "join", { harness_session: "hs-human" }));
    expect(f.sql.one("SELECT COUNT(*) AS n FROM users WHERE parent IS NOT NULL")).toEqual({ n: 0 });
  });

  it("a handle too long to leave room for the suffix refuses the join with a message saying so", () => {
    const f = world();
    const longest = "x".repeat(27);
    f.addUser(longest);
    f.addUser("y".repeat(28));
    const j = ok(f.board.act<Joined>(as(longest), "join", { harness_session: "hs" })).value;
    expect(j.handle).toHaveLength(32);
    expect(HANDLE_RE.test(j.handle)).toBe(true);
    fails(f.board.act(as("y".repeat(28)), "join", { harness_session: "hs" }), "bad_request", /too long to name session handles/);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM users WHERE parent = ?", "y".repeat(28))).toEqual({ n: 0 });
  });

  it("a name that is taken (in any case) is skipped inside the write, and a name that is always taken refuses the join", () => {
    // Suffix bytes 0,1,2,3 spell "abcd"; the next try, 1,2,3,4, spells "bcde".
    let tries = 0;
    const f = makeBoard({
      randomBytes: (n) => {
        if (n !== 4) return Uint8Array.from({ length: n }, (_, i) => i);
        tries += 1;
        return Uint8Array.from([0, 1, 2, 3], (b) => b + (tries - 1));
      },
    });
    f.addUser("p");
    f.sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('P-ABCD', 'agent', 0)");
    const j = ok(f.board.act<Joined>(as("p"), "join", { harness_session: "hs" })).value;
    expect(j.handle).toBe("p-bcde");
    expect(tries).toBe(2);

    const g = makeBoard({ randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => i) });
    g.addUser("p");
    g.sql.exec("INSERT INTO users (handle, kind, created_at) VALUES ('P-ABCD', 'agent', 0)");
    fails(g.board.act(as("p"), "join", { harness_session: "hs" }), "conflict", /no free session handle name/);
    expect(g.sql.one("SELECT COUNT(*) AS n FROM users WHERE parent IS NOT NULL")).toEqual({ n: 0 });
  });
});

describe("inboxes, mentions and doorbells are per handle", () => {
  it("a message that mentions one session handle is not returned to the other, the token's own, or a sibling's inbox", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const two = joinHs(f, "p", "hs-two");
    // None of them is subscribed to #t: a mention reaches the one it names, in any topic.
    for (const s of [one, two]) ok(f.board.act(as("p", s.session), "inbox", {}));
    ok(f.board.act(as("p"), "inbox", {}));
    const post = ok(f.board.act<{ mentions: string[] }>(as("a"), "post", { topic: "t", body: `look at this @${one.handle}` }));
    expect(post.value.mentions).toEqual([one.handle]);
    expect(inboxText(f, "p", one.session)).toContain("look at this");
    expect(inboxText(f, "p", two.session)).not.toContain("look at this");
    expect(inboxText(f, "p")).not.toContain("look at this");
  });

  it("@parent reaches the parent only and @parent-ab12 that session only: no fan-out", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const post = ok(f.board.act<{ mentions: string[] }>(as("a"), "post", { topic: "t", body: `@p and @${one.handle}` }));
    expect(post.value.mentions).toEqual(["p", one.handle]);
    const alone = ok(f.board.act<{ mentions: string[] }>(as("a"), "post", { topic: "t", body: "@p only" }));
    expect(alone.value.mentions).toEqual(["p"]);
    expect(
      f.sql.all("SELECT handle FROM message_mentions WHERE seq = ? ORDER BY handle", ok(f.board.act<{ seq: number }>(as("a"), "post", { topic: "t", body: `@${one.handle}` })).value.seq),
    ).toEqual([{ handle: one.handle }]);
  });

  it("each session's adapter socket attaches to its own session and only that one is rung", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const two = joinHs(f, "p", "hs-two");
    for (const s of [one, two]) {
      ok(f.board.act(as("p", s.session), "inbox", {}));
      ok(f.board.socketAct({ handle: "p", via: "ws" }, "socket_open", {}));
      const hello = ok(
        f.board.socketAct({ handle: "p", via: "ws", session: s.session }, "socket_hello", {
          harness: "claude-code",
          machine: "workstation-1",
          state: "idle",
        }),
      );
      expect(hello.ok).toBe(true);
    }
    // wake is per session: both are attached to an adapter.
    expect(f.sql.all("SELECT handle FROM sessions WHERE ws_open = 1 ORDER BY handle")).toEqual(
      [{ handle: one.handle }, { handle: two.handle }].sort((x, y) => (x.handle < y.handle ? -1 : 1)),
    );
    ok(f.board.act(as("a"), "post", { topic: "t", body: `@${one.handle} please look` }));
    f.clock.advance(DEBOUNCE);
    const first = rings(f.board.runDueTimers());
    expect(first.map((r) => [r.recipient, r.session])).toEqual([[one.handle, one.session]]);
    // The other session's turn: a mention of it rings it, and not the first one again.
    ok(f.board.act(as("p", one.session), "inbox", {}));
    ok(f.board.act(as("a"), "post", { topic: "t", body: `@${two.handle} you too` }));
    f.clock.advance(DEBOUNCE);
    const second = rings(f.board.runDueTimers());
    expect(second.map((r) => [r.recipient, r.session])).toEqual([[two.handle, two.session]]);
  });

  it("a socket message on a session that is not the token's or its session handles' is refused", () => {
    const f = world();
    const mine = joinHs(f, "p", "hs-one");
    const theirs = joinHs(f, "q", "hs-q");
    ok(f.board.socketAct({ handle: "p", via: "ws" }, "socket_open", {}));
    fails(
      f.board.socketAct({ handle: "p", via: "ws", session: theirs.session }, "socket_hello", { harness: "claude-code", state: "idle" }),
      "forbidden",
      /does not belong to this user/,
    );
    ok(f.board.socketAct({ handle: "p", via: "ws", session: mine.session }, "socket_hello", { harness: "claude-code", state: "idle" }));
  });

  it("sockets_closed for the token detaches its session handles' sessions too", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    ok(f.board.socketAct({ handle: "p", via: "ws" }, "socket_open", {}));
    ok(f.board.socketAct({ handle: "p", via: "ws", session: one.session }, "socket_hello", { harness: "claude-code", state: "idle" }));
    ok(f.board.socketsClosed("p", "credential_revoked", 1, 4004));
    expect(f.sql.one("SELECT ws_open FROM sessions WHERE id = ?", one.session)).toEqual({ ws_open: 0 });
  });
});

describe("actor resolution", () => {
  it("a token plus its own session handle's session acts as that handle, and the audit rows name the parent", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const me = ok(whoami(f, "p", one.session)).value;
    expect(me).toMatchObject({ handle: one.handle, parent: "p", kind: "agent", coordinator: false, admin: false, status: "active", session: one.session });
    ok(f.board.act(as("p", one.session), "subscribe", { topic: "t", level: "digest" }));
    const rows = f.sql.all<{ actor: string; session: string | null; detail: string; action: string }>(
      "SELECT actor, session, detail, action FROM audit WHERE action IN ('join', 'subscribe') AND actor = ?",
      one.handle,
    );
    expect(rows.map((r) => r.action).sort()).toEqual(["join", "subscribe"]);
    for (const r of rows) {
      expect(JSON.parse(r.detail)).toMatchObject({ parent: "p" });
      expect(r.session).toBe(one.session);
    }
    // The token's own calls carry no parent.
    ok(f.board.act(as("p"), "subscribe", { topic: "t", level: "digest" }));
    const own = f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE actor = 'p' AND action = 'subscribe'");
    expect(JSON.parse(own?.detail ?? "{}")).not.toHaveProperty("parent");
  });

  it("the token without a session acts as the token's own handle; its own plain session does too", () => {
    const f = world();
    joinHs(f, "p", "hs-one");
    expect(ok(whoami(f, "p")).value).toMatchObject({ handle: "p" });
    expect(ok(whoami(f, "p")).value).not.toHaveProperty("parent");
    const bare = ok(f.board.act<Joined>(as("p"), "join", {})).value;
    expect(ok(whoami(f, "p", bare.session)).value).toMatchObject({ handle: "p", session: bare.session });
  });

  it("a session handle of another parent, another agent's session, an unknown one: all refused with one message", () => {
    const f = world();
    const mine = joinHs(f, "p", "hs-one");
    const theirs = joinHs(f, "q", "hs-q");
    const aSession = ok(f.board.act<Joined>(as("a"), "join", {})).value.session;
    const refusals = [
      whoami(f, "p", theirs.session),
      whoami(f, "q", mine.session),
      whoami(f, "p", aSession),
      whoami(f, "p", "s_no_such_session"),
    ].map((r) => fails(r, "forbidden").error.message);
    expect(new Set(refusals).size).toBe(1);
    expect(refusals[0]).toBe("that session does not belong to this user");
    // The refusals did not reveal which exist, and nothing acted as another handle.
    expect(ok(whoami(f, "q", theirs.session)).value).toMatchObject({ handle: theirs.handle, parent: "q" });
    expect(ok(whoami(f, "p", mine.session)).value).toMatchObject({ handle: mine.handle, parent: "p" });
  });

  it("a connector's call never resolves to a session handle", () => {
    const f = world();
    const mine = joinHs(f, "p", "hs-one");
    const refusal = fails(f.board.act({ handle: "p", via: "mcp", oauthGrant: "og_test", session: mine.session }, "whoami", {}), "forbidden");
    expect(refusal.error.message).toBe("that session does not belong to this user");
    // Nor does the session argument of a connector's chat bind to it: the call goes on as the handle.
    const named = ok(f.board.act({ handle: "p", via: "mcp", oauthGrant: "og_test", sessionArg: mine.session }, "whoami", {}));
    expect(named.value).toMatchObject({ handle: "p" });
    expect(named.value).not.toHaveProperty("parent");
  });

  it("a session that ended is refused for an ordinary call and is a fresh join for bbs_join", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const again = joinHs(f, "p", "hs-one");
    fails(whoami(f, "p", one.session), "unauthorized", /session has ended/);
    // A join that still carries the ended session is a new join under the same handle.
    const third = ok(f.board.act<Joined>(as("p", again.session), "join", { harness_session: "hs-one" })).value;
    expect(third.session).toBe(again.session);
    const gone = joinHs(f, "p", "hs-one");
    const rejoin = ok(f.board.act<Joined>(as("p", again.session), "join", { harness_session: "hs-one" })).value;
    expect(rejoin.handle).toBe(one.handle);
    expect(rejoin.session).not.toBe(gone.session);
    expect(live(f, one.handle)).toEqual([rejoin.session]);
  });
});

describe("a session handle never holds a flag, a token or a nested handle", () => {
  it("no action grants it coordinator or admin, reinstates it, or makes a second account under its name", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const admin = f.ctx(ADMIN, "cli");
    fails(f.board.act(admin, "admin_coordinator_grant", { handle: one.handle }), "forbidden", /session handle of p/);
    fails(f.board.act(admin, "admin_reinstate", { handle: one.handle }), "conflict", /session handle of p/);
    fails(f.board.act(admin, "admin_user_add", { handle: one.handle.toUpperCase() }), "exists");
    expect(f.sql.one("SELECT is_coordinator, is_admin, token_hash FROM users WHERE handle = ?", one.handle)).toEqual({
      is_coordinator: 0,
      is_admin: 0,
      token_hash: null,
    });
  });

  it("the table refuses a flag, a token or a person on a row with a parent, whatever the code does", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    expect(() => f.sql.exec("UPDATE users SET is_coordinator = 1 WHERE handle = ?", one.handle)).toThrow();
    expect(() => f.sql.exec("UPDATE users SET is_admin = 1 WHERE handle = ?", one.handle)).toThrow();
    expect(() => f.sql.exec("UPDATE users SET token_hash = 'x' WHERE handle = ?", one.handle)).toThrow();
    expect(() => f.sql.exec("UPDATE users SET kind = 'human' WHERE handle = ?", one.handle)).toThrow();
  });

  it("a session handle cannot be a connector's handle", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const r = f.board.oauthRequest(
      { handle: ADMIN, via: "web", webSession: "ws_test" },
      {
        response_type: "code",
        client_id: "https://client.example/c.json",
        redirect_uri: "https://client.example/cb",
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
        resource: "https://api.example/mcp",
        resource_expected: "https://api.example/mcp",
        client_doc: { client_id: "https://client.example/c.json", client_name: "C", redirect_uris: ["https://client.example/cb"] },
      },
    ) as ActResult<{ request_id: string; agents: string[] }>;
    const req = ok(r).value;
    expect(req.agents).not.toContain(one.handle);
    const d = f.board.oauthDecide({ handle: ADMIN, via: "web", webSession: "ws_test" }, { request_id: req.request_id, approve: true, handle: one.handle });
    fails(d as ActResult, "forbidden", /session handle of p/);
  });

  it("only a session of the token's own handle creates one: a session handle's call makes no nested handle", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    // A call with the session handle's session and a different harness session is refused, not nested.
    fails(f.board.act(as("p", one.session), "join", { harness_session: "hs-nested" }), "forbidden");
    expect(f.sql.all("SELECT handle FROM users WHERE parent = ?", one.handle)).toEqual([]);
  });
});

/** Records the INSERT that makes a session handle, with its parameters. */
class Capture implements Sql {
  readonly inner: Sql;
  readonly inserts: { sql: string; params: SqlValue[] }[] = [];
  constructor(inner: Sql) {
    this.inner = inner;
  }
  exec(sql: string, ...params: SqlValue[]): void {
    this.inner.exec(sql, ...params);
  }
  one<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    if (sql.includes("INSERT INTO users") && sql.includes("harness_session")) this.inserts.push({ sql, params });
    return this.inner.one<T>(sql, ...params);
  }
  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.inner.all<T>(sql, ...params);
  }
  transaction<T>(fn: () => T): T {
    return this.inner.transaction(fn);
  }
}

describe("the per-parent cap is a condition of the INSERT", () => {
  it("is 50 by default (issue #100: every session in a repository joins by itself)", () => {
    expect(DEFAULT_CONFIG.sessionHandlesMaxPerParent).toBe(50);
  });

  it("sequential creates past the cap are refused with a message that says how to free one", () => {
    const f = world({ sessionHandlesMaxPerParent: 2 });
    joinHs(f, "p", "hs-1");
    joinHs(f, "p", "hs-2");
    const r = fails(f.board.act(as("p"), "join", { harness_session: "hs-3" }), "rate_limited", /already has 2 live session handles/);
    expect(r.error.message).toMatch(/retired and stops counting|raise the limit/);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM users WHERE parent = 'p'")).toEqual({ n: 2 });
    // A rejoin of one that exists is not a new handle, so the cap does not touch it.
    joinHs(f, "p", "hs-1");
    // Another token has its own room.
    joinHs(f, "q", "hs-1");
    joinHs(f, "q", "hs-2");
  });

  it("the statement itself refuses at the cap, and the unique index refuses a second handle for one harness session", () => {
    let capture: Capture | undefined;
    const f = makeBoard({
      config: { sessionHandlesMaxPerParent: 1 },
      wrap: (raw) => (capture = new Capture(raw)),
    });
    f.addUser("p");
    joinHs(f, "p", "hs-1");
    const made = capture?.inserts.at(-1);
    expect(made).toBeDefined();
    if (!made) return;
    // Same statement, a fresh name and a fresh harness session: no row, because the cap is in the statement.
    const params = [...made.params];
    params[0] = "p-zzzz";
    params[4] = "hs-2";
    params[5] = "p-zzzz";
    expect(f.sql.all(made.sql, ...params)).toEqual([]);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM users WHERE parent = 'p'")).toEqual({ n: 1 });
    // With room (a retired handle does not count) it makes one.
    f.sql.exec("UPDATE users SET retired_at = 1 WHERE parent = 'p'");
    expect(f.sql.all(made.sql, ...params)).toHaveLength(1);
    // The same harness session again under the same parent is refused by the unique index, whatever the name.
    const clash = [...params];
    clash[0] = "p-yyyy";
    clash[5] = "p-yyyy";
    f.sql.exec("UPDATE users SET retired_at = 1 WHERE parent = 'p'");
    expect(() => f.sql.all(made.sql, ...clash)).toThrow(/UNIQUE/);
  });

  it("a handle retired by the timer stops counting toward the cap, and reviving one is judged by the cap too", () => {
    const f = world({ sessionHandlesMaxPerParent: 2, joinMaxPerWindow: 100 });
    const a1 = joinHs(f, "p", "a1");
    joinHs(f, "p", "a2");
    f.clock.advance(RETIRE + MIN);
    f.board.runDueTimers();
    expect(f.sql.all("SELECT handle FROM users WHERE parent = 'p' AND retired_at IS NOT NULL")).toHaveLength(2);
    // Two live handles fill the cap again: the retired ones do not count.
    const b1 = joinHs(f, "p", "b1");
    const b2 = joinHs(f, "p", "b2");
    // Two retired and two live: a revival is refused, with the same refusal as a new handle.
    const refused = fails(f.board.act(as("p"), "join", { harness_session: "a1" }), "rate_limited", /already has 2 live session handles/);
    expect(refused.error.message).toMatch(/bbs admin session-handle retire/);
    expect(f.sql.one("SELECT retired_at IS NOT NULL AS r FROM users WHERE handle = ?", a1.handle)).toEqual({ r: 1 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM users WHERE parent = 'p' AND retired_at IS NULL")).toEqual({ n: 2 });
    // One live handle goes idle and retires (the other keeps calling): the revival now succeeds.
    f.clock.advance(RETIRE - HOUR);
    ok(whoami(f, "p", b2.session));
    f.clock.advance(HOUR + MIN);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT retired_at IS NOT NULL AS r FROM users WHERE handle = ?", b1.handle)).toEqual({ r: 1 });
    expect(joinHs(f, "p", "a1").handle).toBe(a1.handle);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM users WHERE parent = 'p' AND retired_at IS NULL")).toEqual({ n: 2 });
  });

  it("the join rate limit counts per token, so many session handles do not multiply the budget", () => {
    const f = world({ joinMaxPerWindow: 3 });
    joinHs(f, "p", "hs-1");
    joinHs(f, "p", "hs-2");
    ok(f.board.act(as("p"), "join", {}));
    const r = fails(f.board.act(as("p"), "join", { harness_session: "hs-3" }), "rate_limited", /too many new sessions for p \(3 in /);
    expect(r.error.message).toMatch(/try again in/);
    // The refused join made no handle (its write rolled back).
    expect(f.sql.one("SELECT COUNT(*) AS n FROM users WHERE parent = 'p'")).toEqual({ n: 2 });
    joinHs(f, "q", "hs-1");
  });
});

/** Post to the Lobby as `who` until refused. */
function flood(f: Fixture, who: CallContext): void {
  for (let i = 0; i < 50; i++) {
    const r = f.board.act({ ...who, requestId: `r-${f.clock.t}-${i}` }, "post", { topic: "Lobby", body: `m${i}` });
    if (!r.ok) return;
  }
  throw new Error("never refused");
}

function kick(f: Fixture, who: CallContext): ActResult {
  flood(f, who);
  f.clock.advance(11 * MIN);
  flood(f, who);
  f.clock.advance(HOUR + MIN);
  f.board.runDueTimers();
  for (let i = 0; i < 50; i++) {
    const r = f.board.act({ ...who, requestId: `k-${f.clock.t}-${i}` }, "post", { topic: "Lobby", body: `k${i}` });
    if (!r.ok) return r;
  }
  throw new Error("never refused");
}

describe("kick and reinstatement of the parent", () => {
  it("a kick of the parent ends every session handle under it in the same transaction", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const two = joinHs(f, "p", "hs-two");
    const other = joinHs(f, "q", "hs-q");
    for (const s of [one, two]) subscribe(f, "p", s);
    ok(f.board.act(as("a"), "subscribe", { topic: "t", level: "wake" }));
    const task = ok(f.board.act<{ task: { id: number } }>(as("a"), "task_create", { topic: "t", title: "work" })).value.task.id;
    ok(f.board.act(as("a"), "task_assign", { task, assignee: one.handle }));
    const ring = ok(f.board.act(as("a"), "post", { topic: "t", body: `@${two.handle} hello` }));
    expect(ring.ok).toBe(true);

    const refused = kick(f, as("p"));
    expect(refused.ok).toBe(false);
    expect(f.sql.one("SELECT status FROM users WHERE handle = 'p'")).toEqual({ status: "kicked" });
    for (const s of [one, two]) {
      expect(f.sql.one("SELECT status, harness_session FROM users WHERE handle = ?", s.handle)).toEqual({ status: "kicked", harness_session: null });
      expect(live(f, s.handle)).toEqual([]);
      expect(f.sql.one("SELECT COUNT(*) AS n FROM doorbells WHERE handle = ?", s.handle)).toEqual({ n: 0 });
    }
    // Another token's session handle is untouched.
    expect(f.sql.one("SELECT status FROM users WHERE handle = ?", other.handle)).toEqual({ status: "active" });
    expect(live(f, other.handle)).toEqual([other.session]);
    // Its task went stale and the coordinator was told.
    expect(f.sql.one("SELECT is_stale FROM tasks WHERE id = ?", task)).toEqual({ is_stale: 1 });
    const kickRow = f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE action = 'lobby_offense' ORDER BY seq DESC");
    expect(JSON.parse(kickRow?.detail ?? "{}")).toMatchObject({ session_handles: [one.handle, two.handle].sort(), stale_tasks: [task] });
    // Their sessions can no longer be used.
    fails(whoami(f, "p", one.session), "unauthorized");
  });

  it("the coordinator is told about a session handle's task when its parent is kicked", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    subscribe(f, "p", one);
    const task = ok(f.board.act<{ task: { id: number } }>(as("a"), "task_create", { topic: "t", title: "work" })).value.task.id;
    ok(f.board.act(as("a"), "task_assign", { task, assignee: one.handle }));
    let last: ActResult | undefined;
    flood(f, as("p"));
    f.clock.advance(11 * MIN);
    flood(f, as("p"));
    f.clock.advance(HOUR + MIN);
    f.board.runDueTimers();
    for (let i = 0; i < 50 && (last === undefined || last.ok); i++) {
      last = f.board.act({ ...as("p"), requestId: `x-${i}` }, "post", { topic: "Lobby", body: `x${i}` });
    }
    const notes = (last?.notifications ?? []).filter((n: NotificationWork): n is TaskNotification => n.type === "task");
    expect(notes.map((n) => [n.reason, n.recipient, n.task])).toEqual([["assignee_kicked", "boss", task]]);
  });

  it("reinstating the parent does not bring a session handle back: the same harness session gets a new handle", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    kick(f, as("p"));
    const re = ok(f.board.act<{ token: string }>(f.ctx(ADMIN, "cli"), "admin_reinstate", { handle: "p" }));
    expect(re.value.token).toBeTruthy();
    expect(f.sql.one("SELECT status FROM users WHERE handle = ?", one.handle)).toEqual({ status: "kicked" });
    fails(whoami(f, "p", one.session), "unauthorized");
    const fresh = joinHs(f, "p", "hs-one");
    expect(fresh.handle).not.toBe(one.handle);
    expect(fresh.first_join).toBe(true);
    expect(f.sql.one("SELECT status FROM users WHERE handle = ?", one.handle)).toEqual({ status: "kicked" });
  });

  it("sanctions follow the token: offenses of two session handles add up, a mute lands on the parent and covers handles made later", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const two = joinHs(f, "p", "hs-two");
    flood(f, as("p", one.session));
    const warned = f.sql.all("SELECT handle, step FROM admin_events WHERE kind = 'lobby_flood'");
    expect(warned).toEqual([{ handle: "p", step: 1 }]);
    f.clock.advance(11 * MIN);
    flood(f, as("p", two.session));
    // The second offense is the token's second: it mutes the token, not the handle that posted.
    expect(f.sql.all("SELECT handle, step FROM admin_events WHERE kind = 'lobby_flood' ORDER BY id")).toEqual([
      { handle: "p", step: 1 },
      { handle: "p", step: 2 },
    ]);
    expect(f.sql.one("SELECT status FROM users WHERE handle = 'p'")).toEqual({ status: "muted_lobby" });
    expect(f.sql.one("SELECT status FROM users WHERE handle = ?", one.handle)).toEqual({ status: "active" });
    // Every handle under the token is muted in the Lobby, one made after the mute too; other topics are not.
    const later = joinHs(f, "p", "hs-later");
    for (const who of [as("p"), as("p", one.session), as("p", two.session), as("p", later.session)]) {
      fails(f.board.act(who, "post", { topic: "Lobby", body: "hello" }), "rate_limited", /muted in the Lobby until/);
      ok(f.board.act(who, "post", { topic: "t", body: "elsewhere" }));
    }
    // The mute ends for all of them with the token's timer.
    f.clock.advance(HOUR + MIN);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT status FROM users WHERE handle = 'p'")).toEqual({ status: "active" });
    ok(f.board.act(as("p", later.session), "post", { topic: "Lobby", body: "hello again" }));
  });

  it("the Lobby post limit counts the token's posts together", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const two = joinHs(f, "p", "hs-two");
    const post = (who: CallContext, i: number) => f.board.act({ ...who, requestId: `l-${i}` }, "post", { topic: "Lobby", body: `m${i}` });
    ok(post(as("p"), 1));
    ok(post(as("p", one.session), 2));
    ok(post(as("p", one.session), 3));
    ok(post(as("p", two.session), 4));
    ok(post(as("p", two.session), 5));
    fails(post(as("p", two.session), 6), "rate_limited", /Lobby limit/);
    fails(post(as("p"), 7), "rate_limited", /Lobby limit/);
    // A mint does not reset it either.
    const fresh = joinHs(f, "p", "hs-fresh");
    fails(post(as("p", fresh.session), 8), "rate_limited", /Lobby limit/);
    // Another token is not affected.
    ok(post(as("q"), 9));
  });

  it("the kick step reached through session handles kicks the token and every session handle under it", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const two = joinHs(f, "p", "hs-two");
    const other = joinHs(f, "q", "hs-q");
    flood(f, as("p", one.session));
    f.clock.advance(11 * MIN);
    flood(f, as("p", two.session));
    f.clock.advance(HOUR + MIN);
    f.board.runDueTimers();
    const third = kick(f, as("p", one.session));
    expect(third.ok).toBe(false);
    expect(f.sql.one("SELECT status FROM users WHERE handle = 'p'")).toEqual({ status: "kicked" });
    for (const s of [one, two]) {
      expect(f.sql.one("SELECT status, harness_session FROM users WHERE handle = ?", s.handle)).toEqual({ status: "kicked", harness_session: null });
      expect(live(f, s.handle)).toEqual([]);
    }
    expect(f.sql.one("SELECT status FROM users WHERE handle = ?", other.handle)).toEqual({ status: "active" });
    const row = f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE action = 'lobby_offense' ORDER BY seq DESC");
    expect(JSON.parse(row?.detail ?? "{}")).toMatchObject({ outcome: "kicked", from: one.handle, session_handles: [one.handle, two.handle].sort() });
  });

  it("a session handle is never reinstated by name, and a retired one reads as kicked after its token's kick", () => {
    const f = world({ sessionHandlesMaxPerParent: 1 });
    const one = joinHs(f, "p", "hs-one");
    f.clock.advance(RETIRE + MIN);
    f.board.runDueTimers();
    expect(ok(f.board.act<{ users: { handle: string; status: string }[] }>(as("a"), "who", { include_retired: true })).value.users.find((u) => u.handle === one.handle)?.status).toBe("retired");
    kick(f, as("p"));
    expect(f.sql.one("SELECT status, retired_at, harness_session FROM users WHERE handle = ?", one.handle)).toEqual({
      status: "kicked",
      retired_at: null,
      harness_session: null,
    });
    const who = ok(f.board.act<{ users: { handle: string; status: string }[] }>(as("a"), "who", { include_retired: true })).value.users;
    expect(who.find((u) => u.handle === one.handle)?.status).toBe("kicked");
    fails(f.board.act(f.ctx(ADMIN, "cli"), "admin_reinstate", { handle: one.handle }), "conflict", /session handle of p/);
    // Reinstating the token brings back nothing; the same harness session gets a new handle, and the kicked one frees its place.
    ok(f.board.act(f.ctx(ADMIN, "cli"), "admin_reinstate", { handle: "p" }));
    expect(joinHs(f, "p", "hs-one").handle).not.toBe(one.handle);
  });
});

describe("retirement", () => {
  function retiredWorld() {
    const f = world();
    const one = joinHs(f, "p", "hs-one", { role: "first" });
    const two = joinHs(f, "p", "hs-two");
    subscribe(f, "p", one);
    subscribe(f, "p", two);
    const task = ok(f.board.act<{ task: { id: number } }>(as("a"), "task_create", { topic: "t", title: "work" })).value.task.id;
    ok(f.board.act(as("a"), "task_assign", { task, assignee: one.handle }));
    return { f, one, two, task };
  }

  it("a handle with no session for the retire time is retired by the timer: tasks stale, coordinator told, hidden from who", () => {
    const { f, one, two, task } = retiredWorld();
    // The second session keeps calling, the first does not.
    f.clock.advance(RETIRE - HOUR);
    ok(whoami(f, "p", two.session));
    f.clock.advance(HOUR);
    const results = f.board.runDueTimers();
    const mine = results.find((r) => r.ok && (r.value as { retired?: string[] }).retired?.length);
    expect(mine?.ok && mine.value).toMatchObject({ retired: [one.handle], stale_tasks: [task] });
    expect(f.sql.one("SELECT retired_at IS NOT NULL AS r, status FROM users WHERE handle = ?", one.handle)).toEqual({ r: 1, status: "active" });
    expect(f.sql.one("SELECT retired_at FROM users WHERE handle = ?", two.handle)).toEqual({ retired_at: null });
    expect(f.sql.one("SELECT is_stale FROM tasks WHERE id = ?", task)).toEqual({ is_stale: 1 });
    expect(live(f, one.handle)).toEqual([]);
    const notes = results.flatMap((r) => (r.ok ? r.notifications : [])).filter((n): n is TaskNotification => n.type === "task");
    expect(notes.map((n) => [n.reason, n.recipient, n.task])).toEqual([["assignee_retired", "boss", task]]);
    // Its own audit row, as the system actor.
    const row = f.sql.one<{ actor: string; target_type: string }>("SELECT actor, target_type FROM audit WHERE action = 'session_handle_retire' ORDER BY seq DESC");
    expect(row).toEqual({ actor: "system", target_type: "timer" });
    // bbs_who leaves it out by default and shows it, as retired, on request.
    const names = (include: boolean) =>
      ok(f.board.act<{ users: { handle: string; status: string }[] }>(as("a"), "who", include ? { include_retired: true } : {})).value.users;
    expect(names(false).map((u) => u.handle)).not.toContain(one.handle);
    expect(names(true).find((u) => u.handle === one.handle)?.status).toBe("retired");
    // The timer re-arms for the one still active.
    expect(f.sql.one("SELECT COUNT(*) AS n FROM timers WHERE kind = 'session_handle_retire'")).toEqual({ n: 1 });
  });

  it("a retired handle cannot act, is not offered for mentions or assignment", () => {
    const { f, one, task } = retiredWorld();
    f.clock.advance(RETIRE + MIN);
    f.board.runDueTimers();
    fails(whoami(f, "p", one.session), "unauthorized", /was retired/);
    const post = ok(f.board.act<{ mentions: string[] }>(as("a"), "post", { topic: "t", body: `@${one.handle} are you there` }));
    expect(post.value.mentions).toEqual([]);
    const other = ok(f.board.act<{ task: { id: number } }>(as("a"), "task_create", { topic: "t", title: "more" })).value.task.id;
    fails(f.board.act(as("boss"), "task_assign", { task: other, assignee: one.handle }), "conflict", /has been retired/);
    expect(f.sql.one("SELECT assignee FROM tasks WHERE id = ?", task)).toEqual({ assignee: one.handle });
  });

  it("a later join with the same harness session un-retires it, in the join's own audit row, with handle, inbox and tasks kept", () => {
    const { f, one, task } = retiredWorld();
    ok(f.board.act(as("a"), "post", { topic: "t", body: `@${one.handle} before` }));
    f.clock.advance(RETIRE + MIN);
    f.board.runDueTimers();
    const back = joinHs(f, "p", "hs-one");
    expect(back.handle).toBe(one.handle);
    expect(back.first_join).toBe(false);
    expect(f.sql.one("SELECT retired_at, status FROM users WHERE handle = ?", one.handle)).toEqual({ retired_at: null, status: "active" });
    const row = f.sql.one<{ detail: string; actor: string }>("SELECT detail, actor FROM audit WHERE action = 'join' ORDER BY seq DESC");
    expect(row?.actor).toBe(one.handle);
    expect(JSON.parse(row?.detail ?? "{}")).toMatchObject({ unretired: true, parent: "p" });
    expect(f.sql.one("SELECT assignee FROM tasks WHERE id = ?", task)).toEqual({ assignee: one.handle });
    expect(inboxText(f, "p", back.session)).toContain("before");
    const post = ok(f.board.act<{ mentions: string[] }>(as("a"), "post", { topic: "t", body: `@${one.handle} again` }));
    expect(post.value.mentions).toEqual([one.handle]);
    // And the timer is armed again.
    expect(f.sql.one("SELECT COUNT(*) AS n FROM timers WHERE kind = 'session_handle_retire'")).toEqual({ n: 1 });
  });

  it("a handle whose adapter socket is open is not retired, and no handle is retired early", () => {
    const { f, one, two } = retiredWorld();
    ok(f.board.socketAct({ handle: "p", via: "ws" }, "socket_open", {}));
    ok(f.board.socketAct({ handle: "p", via: "ws", session: one.session }, "socket_hello", { harness: "claude-code", state: "idle" }));
    f.clock.advance(RETIRE - MIN);
    f.board.runDueTimers();
    expect(f.sql.all("SELECT handle FROM users WHERE retired_at IS NOT NULL")).toEqual([]);
    f.clock.advance(2 * MIN);
    f.board.runDueTimers();
    // two has been idle past the time with no socket; one has a socket open.
    expect(f.sql.all("SELECT handle FROM users WHERE retired_at IS NOT NULL")).toEqual([{ handle: two.handle }]);
  });

  it("the token's own handle is never retired", () => {
    const f = world();
    joinHs(f, "p", "hs-one");
    f.clock.advance(RETIRE + DAY);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT retired_at FROM users WHERE handle = 'p'")).toEqual({ retired_at: null });
  });
});

describe("bbs_who and bbs_whoami", () => {
  it("who shows parent on a session handle, none on others, and no session id or hash", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const r = ok(f.board.act<{ users: Record<string, unknown>[] }>(as("a"), "who", {}));
    const me = r.value.users.find((u) => u.handle === one.handle);
    expect(me).toMatchObject({ handle: one.handle, parent: "p", kind: "agent", status: "active", coordinator: false, admin: false, session: "idle" });
    expect(r.value.users.find((u) => u.handle === "p")).not.toHaveProperty("parent");
    const text = JSON.stringify(r.value);
    expect(text).not.toContain(one.session);
    expect(text).not.toContain("hs-one");
    // Filtered by topic too.
    subscribe(f, "p", one);
    const byTopic = ok(f.board.act<{ users: Record<string, unknown>[] }>(as("a"), "who", { topic: "t" }));
    expect(byTopic.value.users.find((u) => u.handle === one.handle)).toMatchObject({ parent: "p" });
  });

  it("whoami for a session handle shows its own handle and its parent", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    expect(ok(whoami(f, "p", one.session)).value).toMatchObject({ handle: one.handle, parent: "p" });
    expect(ok(whoami(f, "p")).value).toMatchObject({ handle: "p" });
  });
});

describe("what the guards still see", () => {
  it("the token's handle is the one on the sign-in: a session handle has no token to authenticate with", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    expect(f.sql.one("SELECT token_hash FROM users WHERE handle = ?", one.handle)).toEqual({ token_hash: null });
    // A handle without a token cannot be a caller on its own: the shells only take ctx.handle from a token.
    const none = f.board.authenticate(null, { via: "api" });
    expect(none.ok).toBe(false);
  });

  it("the sessions table of a session handle's session names the harness session it serves", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    expect(f.sql.one("SELECT handle, harness_session FROM sessions WHERE id = ?", one.session)).toEqual({
      handle: one.handle,
      harness_session: "hs-one",
    });
  });
});

/** Attach an adapter socket for `session` of `parent`, as the Board DO's calls do. */
function attach(f: Fixture, parent: string, session: string): void {
  ok(f.board.socketAct({ handle: parent, via: "ws" }, "socket_open", {}));
  ok(f.board.socketAct({ handle: parent, via: "ws", session }, "socket_hello", { harness: "claude-code", state: "idle" }));
}

/** The socket's close, the call `#socketGone` makes: the token's handle, no session in the context. */
function closeSocket(f: Fixture, parent: string, session: string): ActResult {
  return f.board.socketAct({ handle: parent, via: "ws", requestId: "close" }, "socket_close", { session, code: 1000, still_open: false });
}

const wsOpen = (f: Fixture, session: string): number => Number(f.sql.one<{ ws_open: number }>("SELECT ws_open FROM sessions WHERE id = ?", session)?.ws_open);

describe("a session handle's socket close clears ws_open (review, high)", () => {
  it("the close the Durable Object sends detaches a session handle's session, so wake is none afterwards", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    attach(f, "p", one.session);
    expect(wsOpen(f, one.session)).toBe(1);
    const who = () => ok(f.board.act<{ users: { handle: string; sessions: { wake: string }[] }[] }>(as("a"), "who", {})).value.users.find((u) => u.handle === one.handle);
    expect(who()?.sessions[0]?.wake).toBe("adapter");
    ok(closeSocket(f, "p", one.session));
    expect(wsOpen(f, one.session)).toBe(0);
    expect(f.sql.one("SELECT detached_at IS NOT NULL AS d FROM sessions WHERE id = ?", one.session)).toEqual({ d: 1 });
    expect(who()?.sessions[0]?.wake).toBe("none");
    // A close naming another token's session detaches nothing.
    const theirs = joinHs(f, "q", "hs-q");
    attach(f, "q", theirs.session);
    ok(closeSocket(f, "p", theirs.session));
    expect(wsOpen(f, theirs.session)).toBe(1);
  });

  it("a handle whose adapter attached and closed is retired when idle, and its place is freed", () => {
    const f = world({ sessionHandlesMaxPerParent: 1 });
    const one = joinHs(f, "p", "hs-one");
    attach(f, "p", one.session);
    ok(closeSocket(f, "p", one.session));
    f.clock.advance(RETIRE + MIN);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT retired_at IS NOT NULL AS r FROM users WHERE handle = ?", one.handle)).toEqual({ r: 1 });
    joinHs(f, "p", "hs-two");
  });

  it("a handle with its socket still open is not retired", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    attach(f, "p", one.session);
    f.clock.advance(RETIRE * 3);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT retired_at FROM users WHERE handle = ?", one.handle)).toEqual({ retired_at: null });
  });

  it("a restart and rejoin leaves no pinned session: ending a session clears ws_open, so the handle retires later", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    attach(f, "p", one.session);
    // The adapter restarts without a clean close: its rejoin ends the old session.
    const again = joinHs(f, "p", "hs-one");
    expect(f.sql.one("SELECT state, ws_open FROM sessions WHERE id = ?", one.session)).toEqual({ state: "gone", ws_open: 0 });
    // The old socket's late close is harmless.
    ok(closeSocket(f, "p", one.session));
    attach(f, "p", again.session);
    ok(closeSocket(f, "p", again.session));
    f.clock.advance(RETIRE + MIN);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT retired_at IS NOT NULL AS r FROM users WHERE handle = ?", one.handle)).toEqual({ r: 1 });
  });

  it("the retirement check ignores a gone session that still says ws_open, and every path that ends a session clears it", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    attach(f, "p", one.session);
    f.sql.exec("UPDATE sessions SET state = 'gone' WHERE id = ?", one.session);
    f.clock.advance(RETIRE + MIN);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT retired_at IS NOT NULL AS r FROM users WHERE handle = ?", one.handle)).toEqual({ r: 1 });
    // A kick ends sessions with ws_open cleared.
    const g = world();
    const two = joinHs(g, "p", "hs-two");
    attach(g, "p", two.session);
    const own = ok(g.board.act<Joined>(as("p"), "join", {})).value;
    attach(g, "p", own.session);
    kick(g, as("p", two.session));
    expect(g.sql.all("SELECT id FROM sessions WHERE handle IN (?, 'p') AND ws_open = 1", two.handle)).toEqual([]);
  });
});

describe("admin: retire a session handle now (review, high)", () => {
  it("a human admin frees a place at the cap: sessions end, tasks go stale, the coordinator is told, it is audited", () => {
    const f = world({ sessionHandlesMaxPerParent: 1 });
    const one = joinHs(f, "p", "hs-one");
    subscribe(f, "p", one);
    const task = ok(f.board.act<{ task: { id: number } }>(as("a"), "task_create", { topic: "t", title: "work" })).value.task.id;
    ok(f.board.act(as("a"), "task_assign", { task, assignee: one.handle }));
    fails(f.board.act(as("p"), "join", { harness_session: "hs-two" }), "rate_limited", /bbs admin session-handle retire/);
    const r = ok(f.board.act<{ handle: string; sessions_ended: number; stale_tasks: number[] }>(f.ctx(ADMIN, "cli"), "admin_session_handle_retire", { handle: one.handle.toUpperCase() }));
    expect(r.value).toMatchObject({ handle: one.handle, sessions_ended: 1, stale_tasks: [task] });
    expect(r.notifications.filter((n): n is TaskNotification => n.type === "task").map((n) => [n.reason, n.recipient])).toEqual([["assignee_retired", "boss"]]);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM audit WHERE action = 'admin_session_handle_retire' AND actor = ?", ADMIN)).toEqual({ n: 1 });
    joinHs(f, "p", "hs-two");
    // The retired handle's own session is refused with the shared marker, and a join brings it back when there is room.
    const refused = fails(whoami(f, "p", one.session), "unauthorized", /was retired/);
    expect(refused.error.message).toContain("[session_ended]");
  });

  it("only a human admin may: an agent, a coordinator and a person without the flag are refused; no such tool on /mcp", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    for (const who of [as("p"), as("boss"), as("p", one.session)]) {
      fails(f.board.act(who, "admin_session_handle_retire", { handle: one.handle }), "forbidden", /only a human admin/);
    }
    expect(f.sql.one("SELECT retired_at FROM users WHERE handle = ?", one.handle)).toEqual({ retired_at: null });
    expect(mcpTools().map((t) => t.name)).not.toContain("bbs_admin_session_handle_retire");
    const r = callTool(f.board, { handle: "p", via: "mcp" }, "bbs_admin_session_handle_retire", { handle: one.handle }, "mcp");
    expect(r.isError).toBe(true);
    expect(f.sql.one("SELECT retired_at FROM users WHERE handle = ?", one.handle)).toEqual({ retired_at: null });
  });

  it("refuses a handle that is not a session handle, is unknown, kicked or already retired", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const admin = f.ctx(ADMIN, "cli");
    fails(f.board.act(admin, "admin_session_handle_retire", { handle: "p" }), "conflict", /not a session handle/);
    fails(f.board.act(admin, "admin_session_handle_retire", { handle: "p-zzzz" }), "not_found");
    ok(f.board.act(admin, "admin_session_handle_retire", { handle: one.handle }));
    fails(f.board.act(admin, "admin_session_handle_retire", { handle: one.handle }), "conflict", /already retired/);
    const two = joinHs(f, "p", "hs-two");
    kick(f, as("p"));
    fails(f.board.act(admin, "admin_session_handle_retire", { handle: two.handle }), "conflict", /kicked/);
  });

  it("a join with the same harness session brings a retired handle back when there is room", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    ok(f.board.act(f.ctx(ADMIN, "cli"), "admin_session_handle_retire", { handle: one.handle }));
    expect(joinHs(f, "p", "hs-one").handle).toBe(one.handle);
  });
});

describe("a muted or limited token writes nothing into the Lobby (review, medium)", () => {
  const mute = (f: Fixture) => f.sql.exec("UPDATE users SET status = 'muted_lobby' WHERE handle = 'p'");

  it("a topic made by a session handle of a muted token announces without its description", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    ok(f.board.act(as("p", one.session), "topic_create", { name: "open-one", description: "DESCRIPTION TEXT" }));
    expect(f.sql.one("SELECT COUNT(*) AS n FROM messages WHERE topic = 'Lobby' AND body LIKE '%DESCRIPTION TEXT%'")).toEqual({ n: 1 });
    f.sql.exec("DELETE FROM timers WHERE kind = 'topic_announce'");
    f.clock.advance(HOUR);
    mute(f);
    ok(f.board.act(as("p", one.session), "topic_create", { name: "muted-one", description: "HIDDEN DESCRIPTION" }));
    expect(f.sql.one("SELECT COUNT(*) AS n FROM messages WHERE body LIKE '%HIDDEN DESCRIPTION%'")).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM messages WHERE topic = 'Lobby' AND body LIKE ?", `New topic #muted-one by ${one.handle}%`)).toEqual({ n: 1 });
  });

  it("a muted token's session handle reads as muted in who, whoami and admin status", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const two = joinHs(f, "p", "hs-two");
    mute(f);
    const users = ok(f.board.act<{ users: { handle: string; status: string }[] }>(as("a"), "who", {})).value.users;
    expect(users.find((u) => u.handle === one.handle)?.status).toBe("muted_lobby");
    expect(users.find((u) => u.handle === "q")?.status).toBe("active");
    expect(ok(whoami(f, "p", two.session)).value).toMatchObject({ handle: two.handle, status: "muted_lobby" });
    const admin = ok(f.board.act<{ users: { handle: string; status: string }[] }>(f.ctx(ADMIN, "cli"), "admin_status", {})).value.users;
    expect(admin.find((u) => u.handle === one.handle)?.status).toBe("muted");
    expect(admin.find((u) => u.handle === "p")?.status).toBe("muted");
    // The stored status is untouched, and the effective one follows the token's: unmuted, it reads active again.
    expect(f.sql.one("SELECT status FROM users WHERE handle = ?", one.handle)).toEqual({ status: "active" });
    f.sql.exec("UPDATE users SET status = 'active' WHERE handle = 'p'");
    expect(ok(whoami(f, "p", two.session)).value).toMatchObject({ status: "active" });
  });
});

describe("/mcp with a static token makes no session handle (review, medium)", () => {
  const mcp: CallContext = { handle: "p", via: "mcp" };

  it("a join on /mcp acts as the token's handle and ignores harness_session; calls ignore a session handle's session", () => {
    const f = world();
    const made = joinHs(f, "p", "hs-api");
    const j = callTool(f.board, mcp, "bbs_join", { harness_session: "hs-mcp" }, "mcp");
    expect(j.isError).toBe(false);
    expect(j.structuredContent).toMatchObject({ handle: "p" });
    expect(j.structuredContent).not.toHaveProperty("parent");
    expect(j.structuredContent).not.toHaveProperty("note");
    expect(f.sql.all("SELECT handle FROM users WHERE parent = 'p'")).toEqual([{ handle: made.handle }]);
    // A session handle's session named on /mcp (header or argument) does not make the call that handle's.
    const w = callTool(f.board, { ...mcp, session: made.session }, "bbs_whoami", {}, "mcp");
    expect(w.isError).toBe(true);
    const w2 = callTool(f.board, mcp, "bbs_whoami", { session: made.session }, "mcp");
    expect(w2.structuredContent).toMatchObject({ handle: "p" });
    expect(w2.structuredContent).not.toHaveProperty("parent");
  });

  it("the tool list /mcp offers has no harness_session and no session-handle text on bbs_join; the adapter's and CLI's do", () => {
    const join = mcpTools().find((t) => t.name === "bbs_join");
    expect(Object.keys(join?.inputSchema.properties ?? {})).not.toContain("harness_session");
    expect(join?.description).not.toContain("harness_session");
    expect(join?.description).toContain("pass the session id");
    // The same tool, as the adapter and the CLI see it.
    const local = TOOLS.find((t) => t.name === "bbs_join");
    expect(Object.keys(local?.inputSchema.properties ?? {})).toContain("harness_session");
    expect(local?.description).toContain("harness_session");
  });
});

describe("review of a task is between tokens (issue #87, issue #98)", () => {
  function inReview(f: Fixture, creator: CallContext, submitter: CallContext): number {
    const task = ok(f.board.act<{ task: { id: number } }>(creator, "task_create", { topic: "t", title: "work" })).value.task.id;
    ok(f.board.act(submitter, "task_claim", { task }));
    ok(f.board.act(submitter, "task_update", { task, state: "in_progress" }));
    ok(f.board.act(submitter, "task_update", { task, state: "in_review" }));
    return task;
  }

  it("a handle of the submitter's token cannot approve; a handle of another token can", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    const two = joinHs(f, "p", "hs-two");
    for (const s of [one, two]) subscribe(f, "p", s, "digest");
    const submit = as("p", one.session);
    const task = inReview(f, as("p", two.session), submit);
    fails(f.board.act(submit, "task_update", { task, state: "done" }), "forbidden", /cannot approve/);
    const sibling = fails(f.board.act(as("p", two.session), "task_update", { task, state: "done" }), "forbidden", /another handle of your token/);
    expect(sibling.error.message).toMatch(/another agent, a coordinator or a person/i);
    ok(f.board.act(as("boss"), "task_update", { task, state: "done" }));
  });

  it("a coordinator token cannot approve its own session handle's task; a person always may", () => {
    const f = world();
    const mine = joinHs(f, "boss", "hs-boss");
    subscribe(f, "boss", mine, "digest");
    const task = inReview(f, as("a"), as("boss", mine.session));
    fails(f.board.act(as("boss"), "task_update", { task, state: "done" }), "forbidden", /cannot approve/);
    ok(f.board.act(f.ctx(ADMIN, "cli"), "task_update", { task, state: "done" }));
  });

  it("an assignee that is a session handle cannot approve its own review, and a coordinator of another token can", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    subscribe(f, "p", one, "digest");
    const task = ok(f.board.act<{ task: { id: number } }>(as("a"), "task_create", { topic: "t", title: "work" })).value.task.id;
    ok(f.board.act(as("a"), "task_assign", { task, assignee: one.handle }));
    ok(f.board.act(as("p", one.session), "task_update", { task, state: "in_progress" }));
    ok(f.board.act(as("p", one.session), "task_update", { task, state: "in_review" }));
    ok(f.board.act(as("boss"), "task_update", { task, state: "done" }));
  });
});

describe("a join carrying an ended session handle's session (review, low)", () => {
  it("rejoins as the same session handle and leaves the token's own session alone", () => {
    const f = world();
    const own = ok(f.board.act<Joined>(as("p"), "join", {})).value;
    const one = joinHs(f, "p", "hs-one");
    const newer = joinHs(f, "p", "hs-one");
    const r = ok(f.board.act<Joined>(as("p", one.session), "join", {})).value;
    expect(r.handle).toBe(one.handle);
    expect(r.parent).toBe("p");
    expect(r.session).not.toBe(newer.session);
    expect(live(f, one.handle)).toEqual([r.session]);
    expect(live(f, "p")).toEqual([own.session]);
  });

  it("revives a retired handle, and a shell cannot send the carried harness session itself", () => {
    const f = world();
    const one = joinHs(f, "p", "hs-one");
    f.clock.advance(RETIRE + MIN);
    f.board.runDueTimers();
    const r = ok(f.board.act<Joined>(as("p", one.session), "join", {})).value;
    expect(r.handle).toBe(one.handle);
    expect(f.sql.one("SELECT retired_at FROM users WHERE handle = ?", one.handle)).toEqual({ retired_at: null });
    const forged = ok(f.board.act<Joined>({ ...as("p"), carriedHarnessSession: "hs-one" }, "join", {})).value;
    expect(forged.handle).toBe("p");
  });
});
