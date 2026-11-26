// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Ending a connector grant ends the board sessions joined through it (issue
 * #86): every grant-ending route, the sessions made before `sessions.grant_id`
 * existed, and the per-handle cap.
 */

import { describe, expect, it } from "vitest";
import { s256 } from "../src/actions/oauth.ts";
import type { OAuthTokenResult } from "../src/act.ts";
import { type ActResult, type BoardConfig, type CallContext } from "../src/types.ts";
import { ADMIN, makeBoard, sha256, type Fixture } from "./helpers.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const CLIENT = "https://client.example/oauth/client.json";
const REDIRECT = "https://client.example/callback";
const RESOURCE = "https://api.example/mcp";
const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ-._~0123";
const SOURCE = "ip:9.9.9.9";
const webCtx: CallContext = { handle: ADMIN, via: "web", webSession: "ws_test" };

function fx(config: Partial<BoardConfig> = {}): Fixture {
  return makeBoard({ config });
}

interface Approved {
  code: string;
  grant: string;
}

/** Request and approve a grant for `handle` (the agent is made when new). */
function approve(f: Fixture, handle: string): Approved {
  const r = f.board.oauthRequest(webCtx, {
    response_type: "code",
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    code_challenge: s256(sha256, VERIFIER),
    code_challenge_method: "S256",
    resource: RESOURCE,
    state: "st",
    resource_expected: RESOURCE,
    client_doc: { client_id: CLIENT, client_name: "Claude Test", redirect_uris: [REDIRECT] },
  }) as ActResult<{ request_id: string }>;
  if (!r.ok) throw new Error(r.error.message);
  const d = f.board.oauthDecide(webCtx, { request_id: r.value.request_id, approve: true, handle });
  if (!d.ok) throw new Error(d.error.message);
  return d.value as unknown as Approved;
}

function exchange(f: Fixture, code: string): OAuthTokenResult {
  return f.board.oauthToken({
    params: {
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      resource: RESOURCE,
    },
    resource: RESOURCE,
    source: SOURCE,
  });
}

interface Pair {
  access: string;
  refresh: string;
  grant: string;
  code: string;
  handle: string;
}

function signIn(f: Fixture, handle = "claude-ai"): Pair {
  const a = approve(f, handle);
  const t = exchange(f, a.code);
  if (!t.ok) throw new Error(t.description);
  return { access: t.value.access_token, refresh: t.value.refresh_token, grant: a.grant, code: a.code, handle };
}

/** A join the way the Worker makes one for this grant: a new connector session. */
function joinVia(f: Fixture, handle: string, grant: string): string {
  const r = f.board.act<{ session: string }>({ handle, via: "mcp", oauthGrant: grant }, "join", {});
  if (!r.ok) throw new Error(r.error.message);
  return r.value.session;
}

const liveIds = (f: Fixture, handle = "claude-ai"): string[] =>
  f.sql
    .all<{ id: string }>("SELECT id FROM sessions WHERE handle = ? AND state <> 'gone' ORDER BY attached_at, id", handle)
    .map((r) => r.id);

const rowsOf = (f: Fixture, action: string) => f.auditRows().filter((r) => r.action === action);
const detailOf = (f: Fixture, action: string): Record<string, unknown> =>
  JSON.parse(rowsOf(f, action).at(-1)?.detail as string) as Record<string, unknown>;

const revoke = (f: Fixture, id: string) => f.board.act<{ revoked: string; handle: string; sessions_ended: number }>(f.ctx(ADMIN, "cli"), "oauth_grant_revoke", { id });

/** Two grants of one handle, a session through each. */
function twoGrants(f: Fixture): { a: Pair; b: Pair; sa: string; sb: string } {
  const a = signIn(f);
  const b = signIn(f);
  f.clock.advance(1_000);
  const sa = joinVia(f, "claude-ai", a.grant);
  f.clock.advance(1_000);
  const sb = joinVia(f, "claude-ai", b.grant);
  return { a, b, sa, sb };
}

describe("the session records its grant", () => {
  it("a join through a grant stores the grant id; any other join stores none", () => {
    const f = fx();
    const a = signIn(f);
    const s = joinVia(f, "claude-ai", a.grant);
    expect(f.sql.one("SELECT via_grant, grant_id FROM sessions WHERE id = ?", s)).toEqual({ via_grant: 1, grant_id: a.grant });
    f.addUser("coder");
    const plain = f.board.act<{ session: string }>(f.ctx("coder"), "join", {});
    expect(plain.ok).toBe(true);
    expect(f.sql.one("SELECT via_grant, grant_id FROM sessions WHERE handle = 'coder'")).toEqual({ via_grant: 0, grant_id: null });
  });
});

describe("the admin revoke", () => {
  it("ends only the revoked grant's session; the other stays live and usable", () => {
    const f = fx();
    const { a, sa, sb } = twoGrants(f);
    f.clock.advance(MIN);
    const r = revoke(f, a.grant);
    expect(r).toMatchObject({ ok: true, value: { revoked: a.grant, handle: "claude-ai", sessions_ended: 1 } });
    expect(liveIds(f)).toEqual([sb]);
    expect(f.sql.one("SELECT state, detached_at FROM sessions WHERE id = ?", sa)).toEqual({ state: "gone", detached_at: f.clock.t });
    expect(detailOf(f, "oauth_grant_revoke")).toMatchObject({ reason: "admin_revoke", sessions_ended: 1, ended_sessions: [sa] });
    const b = { handle: "claude-ai", via: "mcp" as const, oauthGrant: signInGrantOf(f, sb), sessionArg: sb };
    expect(f.board.act(b, "post", { topic: "Lobby", body: "still here" }).ok).toBe(true);
    expect(f.sql.one("SELECT session FROM audit WHERE action = 'post' ORDER BY seq DESC LIMIT 1")).toEqual({ session: sb });
  });

  it("reports zero when the grant has no session, and bbs_who lists no peer once the last is gone", () => {
    const f = fx();
    const a = signIn(f);
    expect(revoke(f, a.grant)).toMatchObject({ ok: true, value: { sessions_ended: 0 } });
    const b = signIn(f);
    joinVia(f, "claude-ai", b.grant);
    f.addUser("coder");
    const who = () =>
      (f.board.act(f.ctx("coder"), "who", {}) as unknown as { value: { users: { handle: string; sessions?: unknown[] }[] } }).value.users.find(
        (u) => u.handle === "claude-ai",
      );
    expect(who()?.sessions).toHaveLength(1);
    revoke(f, b.grant);
    expect(who()?.sessions ?? []).toHaveLength(0);
  });

  it("frees a place under connectorSessionsMaxPerHandle, so a new join succeeds at the cap", () => {
    const f = fx({ connectorSessionsMaxPerHandle: 2 });
    const { a, b } = twoGrants(f);
    const full = f.board.act({ handle: "claude-ai", via: "mcp", oauthGrant: b.grant }, "join", {});
    expect(full).toMatchObject({ ok: false, error: { code: "rate_limited" } });
    revoke(f, a.grant);
    expect(f.board.act({ handle: "claude-ai", via: "mcp", oauthGrant: b.grant }, "join", {}).ok).toBe(true);
    expect(liveIds(f)).toHaveLength(2);
  });
});

/** The grant a session was made through. */
function signInGrantOf(f: Fixture, session: string): string {
  return (f.sql.one<{ grant_id: string }>("SELECT grant_id FROM sessions WHERE id = ?", session) as { grant_id: string }).grant_id;
}

describe("every other route that ends a grant", () => {
  it("a code used twice ends the grant and its session", () => {
    const f = fx();
    const p = signIn(f);
    const s = joinVia(f, "claude-ai", p.grant);
    expect(exchange(f, p.code)).toMatchObject({ ok: false });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
    expect(liveIds(f)).toEqual([]);
    expect(detailOf(f, "oauth_grant_ended")).toMatchObject({ reason: "code_replay", sessions_ended: 1, ended_sessions: [s] });
  });

  it("a replayed refresh token ends the grant and its session", () => {
    const f = fx();
    const p = signIn(f);
    const s = joinVia(f, "claude-ai", p.grant);
    f.board.oauthToken({
      params: { grant_type: "refresh_token", refresh_token: p.refresh, client_id: CLIENT, resource: RESOURCE },
      resource: RESOURCE,
      source: SOURCE,
    });
    f.clock.advance(MIN);
    const again = f.board.oauthToken({
      params: { grant_type: "refresh_token", refresh_token: p.refresh, client_id: CLIENT, resource: RESOURCE },
      resource: RESOURCE,
      source: SOURCE,
    });
    expect(again).toMatchObject({ ok: false });
    expect(liveIds(f)).toEqual([]);
    expect(detailOf(f, "oauth_grant_ended")).toMatchObject({ reason: "refresh_replay", sessions_ended: 1, ended_sessions: [s] });
  });

  it("the client's own /oauth/revoke ends the session", () => {
    const f = fx();
    const p = signIn(f);
    joinVia(f, "claude-ai", p.grant);
    expect(f.board.oauthRevoke({ token: p.access, clientId: CLIENT, source: SOURCE })).toEqual({ ok: true });
    expect(liveIds(f)).toEqual([]);
    expect(detailOf(f, "oauth_grant_ended")).toMatchObject({ reason: "client_revoke", sessions_ended: 1 });
  });

  it("the code_unexchanged timer ends the session of a grant never completed", () => {
    const f = fx();
    const a = approve(f, "chatgpt");
    const s = joinVia(f, "chatgpt", a.grant);
    f.clock.advance(2 * MIN);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
    expect(liveIds(f, "chatgpt")).toEqual([]);
    expect(detailOf(f, "oauth_code_unused")).toMatchObject({ reason: "code_unexchanged", sessions_ended: 1, ended_sessions: [s] });
  });

  it("the expiry prune ends the sessions of an expired grant", () => {
    const f = fx({ connectorSessionIdleMs: 365 * DAY });
    const p = signIn(f);
    joinVia(f, "claude-ai", p.grant);
    f.clock.advance(31 * DAY);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
    expect(liveIds(f)).toEqual([]);
    expect(detailOf(f, "oauth_prune")).toMatchObject({ grants: 1, sessions_ended: 1 });
  });

  it("a kick ends the agent's grant sessions and leaves another handle's alone", () => {
    const f = fx();
    const p = signIn(f, "bob");
    const other = signIn(f, "carol");
    const so = joinVia(f, "carol", other.grant);
    joinVia(f, "bob", p.grant);
    const hour = 61 * MIN;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 7; i++) {
        f.board.act({ handle: "bob", via: "mcp", oauthGrant: p.grant }, "post", { topic: "Lobby", body: `b${round}-${i}` });
      }
      f.clock.advance(hour);
      f.board.runDueTimers();
      f.clock.advance(-50 * MIN);
    }
    expect(f.sql.one("SELECT status FROM users WHERE handle = 'bob'")).toEqual({ status: "kicked" });
    expect(liveIds(f, "bob")).toEqual([]);
    expect(liveIds(f, "carol")).toEqual([so]);
  });
});

describe("sessions made before schema version 18 (no grant_id)", () => {
  /** A live connector session as an older board made it: via_grant = 1, grant_id NULL. */
  function legacySession(f: Fixture, handle: string): string {
    const id = joinVia(f, handle, "og_legacy");
    f.sql.exec("UPDATE sessions SET grant_id = NULL WHERE id = ?", id);
    return id;
  }

  it("are left alone while another grant of the handle remains", () => {
    const f = fx();
    const a = signIn(f);
    signIn(f);
    const old = legacySession(f, "claude-ai");
    expect(revoke(f, a.grant)).toMatchObject({ ok: true, value: { sessions_ended: 0 } });
    expect(liveIds(f)).toEqual([old]);
  });

  it("end with the handle's last grant, and are counted", () => {
    const f = fx();
    const a = signIn(f);
    const b = signIn(f);
    const old = legacySession(f, "claude-ai");
    const mine = joinVia(f, "claude-ai", b.grant);
    revoke(f, a.grant);
    expect(liveIds(f)).toHaveLength(2);
    expect(liveIds(f)).toContain(old);
    const r = revoke(f, b.grant);
    expect(r).toMatchObject({ ok: true, value: { sessions_ended: 2 } });
    expect(liveIds(f)).toEqual([]);
    expect(detailOf(f, "oauth_grant_revoke").ended_sessions).toEqual(expect.arrayContaining([old, mine]));
  });

  it("a session made by an agent token (via_grant = 0) is never touched", () => {
    const f = fx();
    const a = signIn(f);
    const token = f.board.act<{ session: string }>(f.ctx("claude-ai"), "join", {});
    expect(token.ok).toBe(true);
    revoke(f, a.grant);
    expect(liveIds(f)).toHaveLength(1);
  });
});

describe("the audit rows", () => {
  it("add no row beyond the one the ending already wrote", () => {
    const f = fx();
    const { a } = twoGrants(f);
    const before = f.auditRows().length;
    revoke(f, a.grant);
    expect(f.auditRows().length).toBe(before + 1);
  });
});
