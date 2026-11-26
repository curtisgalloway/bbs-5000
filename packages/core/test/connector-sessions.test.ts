// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector sessions: one handle signed in by an OAuth grant holds one board
 * session per chat, named by the `session` argument or the hash of the chat's
 * MCP session id. Covers the join rules, the argument, the cap, the idle end and
 * `bbs_who`'s `sessions` list.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type ActResult, type BoardConfig, type CallContext } from "../src/types.ts";
import { callTool, mcpTools, TOOLS } from "../src/tools.ts";
import { makeBoard, sha256, type Fixture } from "./helpers.ts";

const HOUR = 3_600_000;

function ok<T>(r: ActResult<unknown>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.message}`);
  return r.value as T;
}

function world(config: Partial<BoardConfig> = {}): Fixture {
  const f = makeBoard({ config });
  f.addUser("claude-ai");
  f.addUser("coder");
  ok(f.board.act(f.ctx("coder"), "topic_create", { name: "t" }));
  return f;
}

const chat = (n: number | undefined, handle = "claude-ai"): CallContext => ({
  handle,
  via: "mcp",
  oauthGrant: "og_test",
  ...(n !== undefined ? { mcpSession: sha256(`mcp-${n}`) } : {}),
});

const join = (f: Fixture, ctx: CallContext, args: Record<string, unknown> = {}): ActResult<{ session: string }> =>
  f.board.act<{ session: string }>(ctx, "join", args);

const live = (f: Fixture, handle = "claude-ai"): { id: string; mcp_session_hash: string | null }[] =>
  f.sql.all(
    "SELECT id, mcp_session_hash FROM sessions WHERE handle = ? AND state <> 'gone' ORDER BY attached_at, id",
    handle,
  );

interface WhoSession {
  state: string;
  machine: string | null;
  attached_at: number;
  last_active_at?: number;
}

function whoSessions(f: Fixture, handle: string): WhoSession[] {
  const r = ok<{ users: { handle: string; sessions: WhoSession[] }[] }>(f.board.act(f.ctx("coder"), "who", {}));
  return r.users.find((u) => u.handle === handle)?.sessions ?? [];
}

describe("defaults", () => {
  it("20 live connector sessions per handle, ended after 24 hours idle", () => {
    expect(DEFAULT_CONFIG.connectorSessionsMaxPerHandle).toBe(20);
    expect(DEFAULT_CONFIG.connectorSessionIdleMs).toBe(24 * HOUR);
  });
});

describe("joins through a grant", () => {
  it("two chats with different MCP session ids hold two live sessions, and bbs_who lists both", () => {
    const f = world();
    const a = ok<{ session: string }>(join(f, chat(1), { machine: "chat-a" }));
    f.clock.advance(1_000);
    const b = ok<{ session: string }>(join(f, chat(2), { machine: "chat-b" }));
    expect(a.session).not.toBe(b.session);
    expect(live(f)).toHaveLength(2);
    const detail = JSON.parse(
      f.sql.one<{ detail: string }>("SELECT detail FROM audit WHERE action = 'join' ORDER BY seq DESC LIMIT 1")?.detail ?? "{}",
    ) as { replaced_sessions: string[] };
    expect(detail.replaced_sessions).toEqual([]);
    const sessions = whoSessions(f, "claude-ai");
    expect(sessions.map((s) => s.machine)).toEqual(["chat-b", "chat-a"]);
    expect(sessions.every((s) => typeof s.attached_at === "number")).toBe(true);
  });

  it("bbs_who keeps the top-level fields of the newest session and shows no session id or hash", () => {
    const f = world();
    join(f, chat(1), { machine: "chat-a" });
    f.clock.advance(1_000);
    join(f, chat(2), { machine: "chat-b" });
    const r = ok<{ users: Record<string, unknown>[] }>(f.board.act(f.ctx("coder"), "who", {}));
    const me = r.users.find((u) => u.handle === "claude-ai");
    expect(me).toMatchObject({ session: "idle", machine: "chat-b" });
    const text = JSON.stringify(me);
    for (const secret of [sha256("mcp-1"), sha256("mcp-2"), ...live(f).map((s) => s.id)]) {
      expect(text).not.toContain(secret);
    }
  });

  it("a re-join with the same MCP session id updates its session in place", () => {
    const f = world();
    const a = ok<{ session: string }>(join(f, chat(1), { machine: "chat-a" }));
    join(f, chat(2), { machine: "chat-b" });
    const again = ok<{ session: string }>(join(f, chat(1), { role: "reviewer", model: "m1" }));
    expect(again.session).toBe(a.session);
    expect(live(f)).toHaveLength(2);
    expect(f.sql.one("SELECT machine, model FROM sessions WHERE id = ?", a.session)).toEqual({
      machine: "chat-a",
      model: "m1",
    });
  });

  it("a call from a chat is bound to its session: its audit row carries the session id", () => {
    const f = world();
    const a = ok<{ session: string }>(join(f, chat(1)));
    const b = ok<{ session: string }>(join(f, chat(2)));
    ok(f.board.act(chat(2), "post", { topic: "Lobby", body: "hi" }));
    const row = f.sql.one<{ session: string }>("SELECT session FROM audit WHERE action = 'post' ORDER BY seq DESC LIMIT 1");
    expect(row?.session).toBe(b.session);
    expect(row?.session).not.toBe(a.session);
  });

  it("an unknown MCP session id leaves the call with no session", () => {
    const f = world();
    ok(f.board.act(chat(9), "post", { topic: "Lobby", body: "hi" }));
    const row = f.sql.one<{ session: string | null }>("SELECT session FROM audit WHERE action = 'post'");
    expect(row?.session).toBeNull();
  });

  it("joins with no MCP session id and no session argument each add a session, and bbs_who lists both", () => {
    const f = world();
    const one = ok<{ session: string }>(join(f, chat(undefined), { machine: "chat-a" }));
    f.clock.advance(1_000);
    const two = ok<{ session: string }>(join(f, chat(undefined), { machine: "chat-b" }));
    expect(one.session).not.toBe(two.session);
    expect(live(f).map((s) => s.id)).toEqual([one.session, two.session]);
    expect(whoSessions(f, "claude-ai").map((s) => s.machine)).toEqual(["chat-b", "chat-a"]);
  });

  it("a join with an agent token (no grant) still replaces every live session", () => {
    const f = world();
    join(f, chat(1));
    join(f, chat(2));
    const token = ok<{ session: string }>(f.board.act(f.ctx("claude-ai"), "join", {}));
    expect(live(f).map((s) => s.id)).toEqual([token.session]);
  });

  it("an MCP session id sent without a grant is ignored", () => {
    const f = world();
    const ctx: CallContext = { handle: "claude-ai", via: "mcp", mcpSession: sha256("mcp-1") };
    const first = ok<{ session: string }>(join(f, ctx));
    join(f, ctx);
    expect(live(f)).toHaveLength(1);
    expect(f.sql.one("SELECT mcp_session_hash FROM sessions WHERE id = ?", first.session)).toEqual({
      mcp_session_hash: null,
    });
    ok(f.board.act(ctx, "post", { topic: "Lobby", body: "hi" }));
    expect(f.sql.one<{ session: string | null }>("SELECT session FROM audit WHERE action = 'post'")?.session).toBeNull();
  });

  it("stores only the SHA-256 of the MCP session id", () => {
    const f = world();
    join(f, chat(1));
    expect(f.sql.one("SELECT mcp_session_hash FROM sessions")).toEqual({ mcp_session_hash: sha256("mcp-1") });
  });
});

const arg = (session: unknown, n?: number, handle = "claude-ai"): CallContext => ({
  ...chat(n, handle),
  sessionArg: session as string,
});

const auditSession = (f: Fixture, action: string): string | null | undefined =>
  f.sql.one<{ session: string | null }>(
    "SELECT session FROM audit WHERE action = ? ORDER BY seq DESC LIMIT 1",
    action,
  )?.session;

describe("the session argument", () => {
  it("binds a call to the named session: its audit row carries it and only its last_active_at moves", () => {
    const f = world();
    const a = ok<{ session: string }>(join(f, chat(undefined), { machine: "chat-a" }));
    const b = ok<{ session: string }>(join(f, chat(undefined), { machine: "chat-b" }));
    f.clock.advance(5_000);
    ok(f.board.act(arg(a.session), "post", { topic: "t", body: "hi" }));
    expect(auditSession(f, "post")).toBe(a.session);
    const byMachine = Object.fromEntries(whoSessions(f, "claude-ai").map((s) => [s.machine, s]));
    expect(byMachine["chat-a"]?.last_active_at).toBe(f.clock.now());
    expect(byMachine["chat-b"]?.last_active_at).toBeLessThan(f.clock.now());
    expect(b.session).not.toBe(a.session);
  });

  it("a join naming a live session updates it in place and adds none", () => {
    const f = world();
    const a = ok<{ session: string }>(join(f, chat(undefined), { machine: "chat-a" }));
    join(f, chat(undefined), { machine: "chat-b" });
    const again = ok<{ session: string }>(join(f, arg(a.session), { model: "m1" }));
    expect(again.session).toBe(a.session);
    expect(live(f)).toHaveLength(2);
    expect(f.sql.one("SELECT machine, model FROM sessions WHERE id = ?", a.session)).toEqual({
      machine: "chat-a",
      model: "m1",
    });
  });

  it("an unknown, ended, other-handle or malformed value is ignored without error; a join adds a session", () => {
    const f = world();
    const ended = ok<{ session: string }>(join(f, chat(undefined)));
    f.sql.exec("UPDATE sessions SET state = 'gone' WHERE id = ?", ended.session);
    const other = ok<{ session: string }>(join(f, chat(undefined, "coder")));
    const tokenOwn = ok<{ session: string }>(f.board.act(f.ctx("claude-ai"), "join", {}));
    for (const bad of ["s_nope", ended.session, other.session, tokenOwn.session, "", "x".repeat(500), 7, null]) {
      const before = live(f).length;
      ok(f.board.act(arg(bad), "post", { topic: "t", body: "hi" }));
      expect(auditSession(f, "post")).toBeNull();
      ok(join(f, arg(bad)));
      expect(live(f)).toHaveLength(before + 1);
    }
  });

  it("wins over a header hash when both are present", () => {
    const f = world();
    const a = ok<{ session: string }>(join(f, chat(1)));
    const b = ok<{ session: string }>(join(f, chat(2)));
    ok(f.board.act(arg(a.session, 2), "post", { topic: "t", body: "hi" }));
    expect(auditSession(f, "post")).toBe(a.session);
    expect(b.session).not.toBe(a.session);
  });

  it("falls back to the header hash when the value names nothing", () => {
    const f = world();
    join(f, chat(1));
    const b = ok<{ session: string }>(join(f, chat(2)));
    ok(f.board.act(arg("s_nope", 2), "post", { topic: "t", body: "hi" }));
    expect(auditSession(f, "post")).toBe(b.session);
  });

  it("is ignored for a call without a grant and for a person", () => {
    const f = world();
    const a = ok<{ session: string }>(join(f, chat(undefined)));
    f.addUser("curtis", "human");
    const noGrant: CallContext = { handle: "claude-ai", via: "mcp", sessionArg: a.session };
    ok(f.board.act(noGrant, "post", { topic: "t", body: "hi" }));
    expect(auditSession(f, "post")).toBeNull();
    const person: CallContext = { handle: "curtis", via: "cli", oauthGrant: "og_test", sessionArg: a.session };
    ok(f.board.act(person, "post", { topic: "t", body: "hi" }));
    expect(auditSession(f, "post")).toBeNull();
  });

  it("is taken off the arguments by callTool, so no action sees it", () => {
    const f = world();
    const a = ok<{ session: string }>(join(f, chat(undefined)));
    const r = callTool(f.board, chat(undefined), "bbs_post", { topic: "t", body: "hi", session: a.session }, "mcp");
    expect(r.isError).toBe(false);
    expect(auditSession(f, "post")).toBe(a.session);
    const refused = callTool(f.board, chat(undefined), "bbs_post", { topic: "t", body: "hi", session: a.session }, "api");
    expect(refused.isError).toBe(false);
    expect(auditSession(f, "post")).toBeNull();
  });

  it("bbs_whoami reports the bound session, and a grant join carries a note", () => {
    const f = world();
    const joined = callTool(f.board, chat(undefined), "bbs_join", {}, "mcp");
    const session = String(joined.structuredContent.session);
    expect(String(joined.structuredContent.note)).toMatch(/`session`/);
    const me = callTool(f.board, chat(undefined), "bbs_whoami", { session }, "mcp");
    expect(me.structuredContent.session).toBe(session);
    const unbound = callTool(f.board, chat(undefined), "bbs_whoami", {}, "mcp");
    expect(unbound.structuredContent.session).toBeUndefined();
    const who = callTool(f.board, chat(undefined), "bbs_who", {}, "mcp");
    expect(JSON.stringify(who.structuredContent)).not.toContain(session);
  });

  it("is on every tool listed on /mcp and on no CLI or /api definition", () => {
    const listed = mcpTools();
    expect(listed.length).toBeGreaterThan(0);
    for (const t of listed) {
      expect(t.inputSchema.properties.session).toBeDefined();
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
    expect(listed.find((t) => t.name === "bbs_join")?.description).toMatch(/pass the session id/);
    for (const t of TOOLS) expect(t.inputSchema.properties.session).toBeUndefined();
  });
});

describe("the cap on live connector sessions", () => {
  it("counts sessions that carry no MCP session id", async () => {
    const f = world({ connectorSessionsMaxPerHandle: 3, joinMaxPerWindow: 50 });
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => Promise.resolve().then(() => join(f, chat(undefined)))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(live(f)).toHaveLength(3);
  });

  it("admits exactly the allowed number of concurrent joins and names the limit on the rest", async () => {
    const f = world({ connectorSessionsMaxPerHandle: 3, joinMaxPerWindow: 50 });
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => Promise.resolve().then(() => join(f, chat(n)))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const refused = results.filter((r) => !r.ok);
    expect(refused).toHaveLength(3);
    for (const r of refused) {
      if (!r.ok) {
        expect(r.error.code).toBe("rate_limited");
        expect(r.error.message).toMatch(/too many live connector sessions for claude-ai \(3\)/);
      }
    }
    expect(live(f)).toHaveLength(3);
  });

  it("a freed place can be used again", () => {
    const f = world({ connectorSessionsMaxPerHandle: 1, joinMaxPerWindow: 50, connectorSessionIdleMs: HOUR });
    expect(join(f, chat(1)).ok).toBe(true);
    expect(join(f, chat(2)).ok).toBe(false);
    f.clock.advance(HOUR);
    f.board.runDueTimers();
    expect(join(f, chat(2)).ok).toBe(true);
  });
});

describe("the idle end", () => {
  it("ends a session with no audited call for the idle time, keeps an active one, and audits the timer", () => {
    const f = world({ connectorSessionIdleMs: HOUR, joinMaxPerWindow: 50 });
    const idle = ok<{ session: string }>(join(f, chat(1)));
    const active = ok<{ session: string }>(join(f, chat(2)));
    f.clock.advance(HOUR / 2);
    ok(f.board.act(chat(2), "post", { topic: "Lobby", body: "still here" }));
    f.clock.advance(HOUR / 2 + 1_000);
    const results = f.board.runDueTimers();
    expect(results.every((r) => r.ok)).toBe(true);
    expect(live(f).map((s) => s.id)).toEqual([active.session]);
    const row = f.sql.one<{ actor: string; detail: string }>(
      "SELECT actor, detail FROM audit WHERE action = 'connector_idle' ORDER BY seq DESC LIMIT 1",
    );
    expect(row?.actor).toBe("system");
    expect((JSON.parse(row?.detail ?? "{}") as { ended: string[] }).ended).toEqual([idle.session]);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM timers WHERE kind = 'connector_idle'")).toEqual({ n: 1 });
    f.clock.advance(HOUR);
    f.board.runDueTimers();
    expect(live(f)).toHaveLength(0);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM timers WHERE kind = 'connector_idle'")).toEqual({ n: 0 });
  });

  it("ends an unbound grant session by attached_at", () => {
    const f = world({ connectorSessionIdleMs: HOUR });
    join(f, chat(undefined));
    f.clock.advance(HOUR);
    f.board.runDueTimers();
    expect(live(f)).toHaveLength(0);
  });

  it("never ends a session made by an agent token", () => {
    const f = world({ connectorSessionIdleMs: HOUR });
    ok(f.board.act(f.ctx("coder"), "join", {}));
    join(f, chat(1));
    f.clock.advance(5 * HOUR);
    f.board.runDueTimers();
    expect(live(f, "coder")).toHaveLength(1);
    expect(live(f)).toHaveLength(0);
  });

  it("bbs_who shows last_active_at once a session has an audited call", () => {
    const f = world();
    join(f, chat(1));
    f.clock.advance(5_000);
    ok(f.board.act(chat(1), "post", { topic: "Lobby", body: "hi" }));
    const [s] = whoSessions(f, "claude-ai");
    expect(s?.last_active_at).toBe(f.clock.now());
  });
});
