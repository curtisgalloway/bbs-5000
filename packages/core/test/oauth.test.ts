// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth on `/mcp` for remote connectors (issue #55, design §9 "Connectors"):
 * the authorization request and its checks, the person's decision, the code
 * exchange, refresh with rotation and replay handling, the access token on
 * `/mcp`, sliding expiry and pruning, listing and revoking, and the kick.
 */

import { describe, expect, it } from "vitest";
import { checkClientIdUrl, s256 } from "../src/actions/oauth.ts";
import type { OAuthTokenResult } from "../src/act.ts";
import { callTool, TOOLS } from "../src/tools.ts";
import { validateConfig, DEFAULT_CONFIG, type ActResult, type BoardConfig, type CallContext } from "../src/types.ts";
import { ADMIN, makeBoard, sha256, type Fixture } from "./helpers.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const CLIENT = "https://client.example/oauth/client.json";
const REDIRECT = "https://client.example/callback";
const RESOURCE = "https://api.example/mcp";
const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ-._~0123";
const CHALLENGE = s256(sha256, VERIFIER);
const SOURCE = "ip:9.9.9.9";

const webCtx = (handle = ADMIN): CallContext => ({ handle, via: "web", webSession: "ws_test" });

function doc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CLIENT,
    client_name: "Claude Test",
    redirect_uris: [REDIRECT, "http://127.0.0.1/cb"],
    ...over,
  };
}

function authorizeParams(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    response_type: "code",
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: RESOURCE,
    state: "st-1",
    resource_expected: RESOURCE,
    client_doc: doc(),
    ...over,
  };
}

interface Consent {
  status: "consent";
  request_id: string;
  client: { id: string; name: string; host: string };
  redirect: { uri: string; host: string; localhost: boolean };
  scope: string;
  expires_in_ms: number;
  suggested_handle: string;
  agents: string[];
}

function request(f: Fixture, over: Record<string, unknown> = {}, ctx = webCtx()): ActResult<Record<string, unknown>> {
  return f.board.oauthRequest(ctx, authorizeParams(over)) as ActResult<Record<string, unknown>>;
}

function consent(f: Fixture, over: Record<string, unknown> = {}): Consent {
  const r = request(f, over);
  if (!r.ok) throw new Error(`request refused: ${r.error.message}`);
  return r.value as unknown as Consent;
}

interface Approved {
  approved: true;
  redirect_uri: string;
  state?: string;
  code: string;
  grant: string;
  handle: string;
  created: boolean;
}

function decide(f: Fixture, requestId: string, over: Record<string, unknown> = {}, ctx = webCtx()) {
  return f.board.oauthDecide(ctx, { request_id: requestId, approve: true, handle: "claude-ai", ...over });
}

/** Request and approve; returns the authorization code and grant id. */
function approve(f: Fixture, handle = "claude-ai", over: Record<string, unknown> = {}): Approved {
  const c = consent(f, over);
  const d = decide(f, c.request_id, { handle });
  if (!d.ok) throw new Error(`decide refused: ${d.error.message}`);
  return d.value as Approved;
}

function exchange(f: Fixture, code: string, over: Record<string, string | undefined> = {}): OAuthTokenResult {
  return f.board.oauthToken({
    params: {
      grant_type: "authorization_code",
      code,
      code_verifier: VERIFIER,
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      resource: RESOURCE,
      ...over,
    },
    resource: RESOURCE,
    source: SOURCE,
  });
}

function refresh(f: Fixture, token: string, over: Record<string, string | undefined> = {}): OAuthTokenResult {
  return f.board.oauthToken({
    params: { grant_type: "refresh_token", refresh_token: token, client_id: CLIENT, resource: RESOURCE, ...over },
    resource: RESOURCE,
    source: SOURCE,
  });
}

interface Pair {
  access: string;
  refresh: string;
  grant: string;
  handle: string;
}

/** A whole sign-in: request, approval, exchange. */
function signIn(f: Fixture, handle = "claude-ai"): Pair {
  const a = approve(f, handle);
  const t = exchange(f, a.code);
  if (!t.ok) throw new Error(`exchange refused: ${t.description}`);
  return { access: t.value.access_token, refresh: t.value.refresh_token, grant: a.grant, handle };
}

function ok(r: OAuthTokenResult): { access_token: string; refresh_token: string } {
  if (!r.ok) throw new Error(`token refused: ${r.error}: ${r.description}`);
  return r.value;
}

/** `/mcp`'s sign-in with an access token: the board's view of the Authorization header. */
function auth(f: Fixture, token: string, accessToken = true) {
  return f.board.authenticate(token, { via: "mcp", source: SOURCE, accessToken });
}

/** A call as the connector, with the grant the Worker would put in the context. */
function callAs(f: Fixture, p: Pair, action = "topics", params: unknown = {}) {
  return f.board.act({ handle: p.handle, via: "mcp", oauthGrant: p.grant }, action, params);
}

function rowsOf(f: Fixture, action: string) {
  return f.auditRows().filter((r) => r.action === action);
}

function fx(config: Partial<BoardConfig> = {}): Fixture {
  return makeBoard({ config });
}

function refused(r: ActResult): { code: string; message: string } {
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
}

describe("client id and redirect addresses", () => {
  it("accepts https URLs with a path on a public name", () => {
    expect(checkClientIdUrl("https://client.example/id.json").ok).toBe(true);
    expect(checkClientIdUrl("https://a.b.example:8443/x?y=1").ok).toBe(true);
  });

  it.each([
    ["http://client.example/id.json", "https"],
    ["https://localhost/id.json", "localhost"],
    ["https://app.localhost/id.json", "localhost"],
    ["https://intranet/id.json", "single-label"],
    ["https://127.0.0.1/id.json", "address"],
    ["https://2130706433/id.json", "address"],
    ["https://[::1]/id.json", "address"],
    ["https://203.0.113.7/id.json", "address"],
    ["https://client.example/", "path"],
    ["https://client.example", "path"],
    ["https://user:pw@client.example/id.json", "credentials"],
    ["https://client.example/id.json#frag", "fragment"],
    ["client.example/id.json", "https"],
    ["https://client.example./id.json", "plain hostname"],
  ])("refuses %s", (raw, why) => {
    const c = checkClientIdUrl(raw);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reason).toContain(why);
  });

  it("allows a local client address only with the test-only allowance", () => {
    expect(checkClientIdUrl("http://127.0.0.1:5555/client.json").ok).toBe(false);
    expect(checkClientIdUrl("http://127.0.0.1:5555/client.json", true).ok).toBe(true);
    expect(checkClientIdUrl("http://localhost:5555/client.json", true).ok).toBe(true);
    expect(checkClientIdUrl("http://client.example/client.json", true).ok).toBe(false);
    expect(checkClientIdUrl("http://203.0.113.7/client.json", true).ok).toBe(false);
  });
});

describe("authorization request (design §9 steps 3 and 4)", () => {
  it("stores a pending request by hash and describes it for the consent page", () => {
    const f = fx();
    f.addUser("claude-ai-2");
    const c = consent(f);
    expect(c).toMatchObject({
      status: "consent",
      client: { id: CLIENT, name: "Claude Test", host: "client.example" },
      redirect: { uri: REDIRECT, host: "client.example", localhost: false },
      scope: "board",
      expires_in_ms: 10 * MIN,
      suggested_handle: "claude-test",
    });
    expect(c.agents).toEqual(["claude-ai-2"]);
    expect(c.request_id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(f.sql.one("SELECT id_hash, state, requested_by FROM oauth_requests")).toEqual({
      id_hash: sha256(c.request_id),
      state: "st-1",
      requested_by: ADMIN,
    });
    expect(JSON.stringify(f.auditRows())).not.toContain(c.request_id);
    expect(rowsOf(f, "oauth_request")[0]).toMatchObject({ actor: ADMIN, via: "web", result: "ok", target_type: "oauth_request" });
  });

  it("suggests a handle nobody has yet", () => {
    const f = fx();
    f.addUser("claude-test");
    expect(consent(f).suggested_handle).toBe("claude-test-2");
    expect(consent(f, { client_doc: doc({ client_name: "!!!" }) }).suggested_handle).toBe("connector");
  });

  it("uses the board's copy of the client document until it is older than the cache span", () => {
    const f = fx();
    expect(f.board.oauthClientFresh(CLIENT)).toBe(false);
    consent(f);
    expect(f.board.oauthClientFresh(CLIENT)).toBe(true);
    // No document sent: the cached one is used.
    expect(consent(f, { client_doc: undefined }).client.name).toBe("Claude Test");
    f.clock.advance(DAY + 1);
    expect(f.board.oauthClientFresh(CLIENT)).toBe(false);
    expect(refused(request(f, { client_doc: undefined })).code).toBe("bad_request");
    // A fresh document replaces the copy.
    expect(consent(f, { client_doc: doc({ client_name: "Renamed" }) }).client.name).toBe("Renamed");
    expect(f.sql.one("SELECT name FROM oauth_clients")).toEqual({ name: "Renamed" });
  });

  it("refuses a request before its redirect address is known to be the client's", () => {
    const f = fx();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ client_id: "http://client.example/oauth/client.json", client_doc: doc({ client_id: "http://client.example/oauth/client.json" }) }, /https/],
      [{ client_id: "https://localhost/c.json", client_doc: doc({ client_id: "https://localhost/c.json" }) }, /localhost/],
      [{ client_doc: doc({ client_id: "https://other.example/id.json" }) }, /not its own address/],
      [{ client_doc: "not an object" }, /not a JSON object/],
      [{ client_doc: doc({ redirect_uris: [] }) }, /redirect_uris/],
      [{ client_doc: doc({ redirect_uris: ["http://client.example/cb"] }) }, /https, or http on localhost/],
      [{ client_doc: doc({ redirect_uris: ["myapp://callback"] }) }, /https, or http on localhost/],
      [{ client_doc: doc({ redirect_uris: [REDIRECT + "#f"] }) }, /fragment/],
      [{ client_doc: doc({ redirect_uris: [42] }) }, /non-string/],
      [{ client_doc: doc({ token_endpoint_auth_method: "client_secret_basic" }) }, /does not support/],
      [{ client_doc: doc({ client_name: "Evil‮Name" }) }, /bidirectional/],
      [{ client_doc: doc({ client_name: 5 }) }, /must be a string/],
      [{ redirect_uri: "https://client.example/other" }, /not one of the addresses/],
      [{ redirect_uri: "https://client.example/callback?x=1" }, /not one of the addresses/],
      [{ redirect_uri: "https://client.example:8443/callback" }, /not one of the addresses/],
    ];
    for (const [over, why] of cases) {
      const e = refused(request(f, over));
      expect(e.code, JSON.stringify(over)).toBe("bad_request");
      expect(e.message, JSON.stringify(over)).toMatch(why);
    }
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_requests")).toEqual({ n: 0 });
    // A refused document is not cached either.
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_clients")).toEqual({ n: 0 });
  });

  it("takes only a short name, and uses the host for a client that gives none", () => {
    const f = fx();
    expect(consent(f, { client_doc: doc({ client_name: "x".repeat(200) }) }).client.name).toBe("x".repeat(80));
    expect(consent(f, { client_doc: doc({ client_name: undefined }) }).client.name).toBe("client.example");
  });

  it("sends the other failures back to the client's redirect address, with its state", () => {
    const f = fx();
    const cases: [Record<string, unknown>, string][] = [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge_method: undefined }, "invalid_request"],
      [{ code_challenge: undefined }, "invalid_request"],
      [{ code_challenge: "short" }, "invalid_request"],
      [{ resource: "https://api.example/other" }, "invalid_target"],
      [{ resource: undefined }, "invalid_target"],
      [{ scope: "board admin" }, "invalid_scope"],
    ];
    for (const [over, error] of cases) {
      const r = request(f, over);
      expect(r, JSON.stringify(over)).toMatchObject({
        ok: true,
        value: { status: "redirect_error", error, redirect_uri: REDIRECT, state: "st-1" },
      });
    }
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_requests")).toEqual({ n: 0 });
    expect(request(f, { scope: "board" })).toMatchObject({ ok: true, value: { status: "consent" } });
  });

  it("applies the localhost port rule: any port for http://localhost and http://127.0.0.1, nothing else", () => {
    const f = fx();
    const local = (uri: string, over: Record<string, unknown> = {}) =>
      request(f, { redirect_uri: uri, client_doc: doc({ redirect_uris: ["http://127.0.0.1/cb", "http://localhost/other", REDIRECT], ...over }) });
    expect(local("http://127.0.0.1:54321/cb")).toMatchObject({ ok: true, value: { status: "consent", redirect: { localhost: true, host: "127.0.0.1:54321" } } });
    expect(local("http://127.0.0.1/cb")).toMatchObject({ ok: true });
    expect(local("http://localhost:3000/other")).toMatchObject({ ok: true });
    // The path, the host name and the scheme still have to match.
    expect(refused(local("http://127.0.0.1:54321/elsewhere")).code).toBe("bad_request");
    expect(refused(local("http://localhost:54321/cb")).code).toBe("bad_request");
    expect(refused(local("https://127.0.0.1:54321/cb")).code).toBe("bad_request");
    expect(refused(local("http://127.0.0.1:54321/cb?x=1")).code).toBe("bad_request");
    // A public host gets no such leniency.
    expect(refused(local("https://client.example:8443/callback")).code).toBe("bad_request");
  });

  it("limits pending requests board-wide as a condition of the write, and expired ones do not count", () => {
    const f = fx({ oauthRequestMaxPending: 2 });
    consent(f);
    const second = consent(f);
    const e = refused(request(f));
    expect(e).toMatchObject({ code: "rate_limited" });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_requests")).toEqual({ n: 2 });
    // A decided request frees its place.
    expect(decide(f, second.request_id).ok).toBe(true);
    expect(request(f).ok).toBe(true);
    // So does time.
    f.clock.advance(11 * MIN);
    expect(request(f).ok).toBe(true);
    expect(request(f).ok).toBe(true);
    expect(refused(request(f)).code).toBe("rate_limited");
  });

  it("is for the human admin only, through the web view", () => {
    const f = fx();
    f.addUser("agent-a");
    f.addUser("pat", "human");
    expect(refused(request(f, {}, { handle: "agent-a", via: "mcp" })).message).toMatch(/only a human admin/);
    expect(refused(request(f, {}, { handle: "agent-a", via: "web" })).message).toMatch(/agent users cannot act via web/);
    expect(refused(request(f, {}, webCtx("pat"))).message).toMatch(/only a human admin/);
    expect(refused(request(f, {}, { handle: ADMIN, via: "cli" })).message).toMatch(/not available here/);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_requests")).toEqual({ n: 0 });
    expect(rowsOf(f, "oauth_request").map((r) => r.result)).toEqual(["denied", "denied", "denied", "denied"]);
  });
});

describe("decision (design §9 step 5)", () => {
  it("approving makes the agent user (no static token), the grant and a code, in one audited call", () => {
    const f = fx();
    const c = consent(f);
    const before = f.auditRows().length;
    const d = decide(f, c.request_id, { handle: "claude-ai" });
    expect(d).toMatchObject({ ok: true, value: { approved: true, redirect_uri: REDIRECT, state: "st-1", handle: "claude-ai", created: true } });
    const v = (d as unknown as { value: Approved }).value;
    expect(f.auditRows().length - before).toBe(1);
    expect(f.sql.one("SELECT kind, token_hash, status FROM users WHERE handle = 'claude-ai'")).toEqual({ kind: "agent", token_hash: null, status: "active" });
    expect(f.sql.one("SELECT id, client_id, client_name, client_host, handle, approved_by, created_at, last_used_at, expires_at FROM oauth_grants")).toEqual({
      id: v.grant,
      client_id: CLIENT,
      client_name: "Claude Test",
      client_host: "client.example",
      handle: "claude-ai",
      approved_by: ADMIN,
      created_at: f.clock.t,
      last_used_at: null,
      expires_at: f.clock.t + 30 * DAY,
    });
    expect(f.sql.one("SELECT code_hash, grant_id, client_id, redirect_uri, code_challenge, resource, expires_at, used_at FROM oauth_codes")).toEqual({
      code_hash: sha256(v.code),
      grant_id: v.grant,
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      resource: RESOURCE,
      expires_at: f.clock.t + 2 * MIN,
      used_at: null,
    });
    expect(v.grant).toMatch(/^og_[A-Za-z0-9_-]{12}$/);
    expect(rowsOf(f, "oauth_decide")[0]).toMatchObject({ actor: ADMIN, via: "web", target_type: "oauth_grant", target_id: v.grant, result: "ok" });
    expect(JSON.stringify(f.auditRows())).not.toContain(v.code);
    expect(JSON.stringify(f.auditRows())).not.toContain(c.request_id);
  });

  it("denying consumes the request and makes nothing", () => {
    const f = fx();
    const c = consent(f);
    const d = decide(f, c.request_id, { approve: false, handle: undefined });
    expect(d).toMatchObject({ ok: true, value: { approved: false, redirect_uri: REDIRECT, state: "st-1" } });
    expect(JSON.stringify((d as { value: unknown }).value)).not.toContain("code");
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM users WHERE handle = 'claude-ai'")).toEqual({ n: 0 });
    expect(refused(decide(f, c.request_id)).code).toBe("not_found");
  });

  it("is consumed by its first decision: a second decision, or two at once, makes one grant", async () => {
    const f = fx();
    const c = consent(f);
    const results = await Promise.all([0, 1, 2].map(async () => decide(f, c.request_id)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => refused(r).code)).toEqual(["not_found", "not_found"]);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 1 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_codes")).toEqual({ n: 1 });
  });

  it("names what is approved: a request id the board does not hold, or an expired one, is refused", () => {
    const f = fx();
    expect(refused(decide(f, "nope")).code).toBe("not_found");
    const c = consent(f);
    f.clock.advance(10 * MIN + 1);
    expect(refused(decide(f, c.request_id)).code).toBe("not_found");
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
  });

  it("is for the human admin only: an agent and a person without the flag are refused and the request stays pending", () => {
    const f = fx();
    f.addUser("agent-a");
    f.addUser("pat", "human");
    const c = consent(f);
    expect(refused(decide(f, c.request_id, {}, { handle: "agent-a", via: "mcp" })).message).toMatch(/only a human admin/);
    expect(refused(decide(f, c.request_id, {}, { handle: "agent-a", via: "web" })).message).toMatch(/agent users cannot act via web/);
    expect(refused(decide(f, c.request_id, {}, webCtx("pat"))).message).toMatch(/only a human admin/);
    expect(refused(decide(f, c.request_id, {}, { handle: ADMIN, via: "cli" })).message).toMatch(/not available here/);
    expect(f.sql.one("SELECT consumed_at FROM oauth_requests")).toEqual({ consumed_at: null });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
    expect(decide(f, c.request_id).ok).toBe(true);
  });

  it("lends an existing agent handle, and refuses a person, a removed agent, a differently cased clash and a bad handle", () => {
    const f = fx();
    f.addUser("claude-ai");
    expect(approve(f, "claude-ai")).toMatchObject({ created: false });
    expect(f.sql.one("SELECT token_hash IS NOT NULL AS has FROM users WHERE handle = 'claude-ai'")).toEqual({ has: 1 });
    const c = consent(f);
    expect(refused(decide(f, c.request_id, { handle: "owner" })).message).toMatch(/is a person/);
    expect(refused(decide(f, c.request_id, { handle: "CLAUDE-AI" })).code).toBe("exists");
    expect(refused(decide(f, c.request_id, { handle: "system" })).code).toBe("bad_request");
    expect(refused(decide(f, c.request_id, { handle: "has space" })).code).toBe("bad_request");
    expect(refused(decide(f, c.request_id, { handle: undefined })).code).toBe("bad_request");
    expect(refused(decide(f, c.request_id, { approve: "yes" })).code).toBe("bad_request");
    f.addUser("gone");
    f.sql.exec("UPDATE users SET status = 'kicked', token_hash = NULL WHERE handle = 'gone'");
    expect(refused(decide(f, c.request_id, { handle: "gone" })).code).toBe("conflict");
    // Every refusal rolled the consumption back: the request is still pending.
    expect(f.sql.one("SELECT consumed_at FROM oauth_requests WHERE id_hash = ?", sha256(c.request_id))).toEqual({ consumed_at: null });
  });

  it("refuses a case variant of an existing agent, naming the stored spelling, and makes a new one once (issue #90)", () => {
    const f = fx();
    f.addUser("ChatGPT-99");
    const c = consent(f);
    const no = refused(decide(f, c.request_id, { handle: "chatgpt-99" }));
    expect(no.code).toBe("exists");
    expect(no.message).toContain("ChatGPT-99");
    expect(f.sql.one("SELECT consumed_at FROM oauth_requests WHERE id_hash = ?", sha256(c.request_id))).toEqual({ consumed_at: null });
    expect(approve(f, "ChatGPT-99")).toMatchObject({ handle: "ChatGPT-99", created: false });
    expect(approve(f, "NewBot")).toMatchObject({ handle: "NewBot", created: true });
    const c2 = consent(f);
    expect(refused(decide(f, c2.request_id, { handle: "newbot" })).code).toBe("exists");
    expect(f.sql.one("SELECT COUNT(*) AS n FROM users WHERE handle COLLATE NOCASE IN ('newbot', 'chatgpt-99')")).toEqual({ n: 2 });
  });

  it("limits live grants per handle as a condition of the write, and a refusal leaves the request pending", () => {
    const f = fx({ oauthGrantMaxPerHandle: 2 });
    const a = approve(f);
    approve(f);
    const c = consent(f);
    const e = refused(decide(f, c.request_id));
    expect(e.code).toBe("conflict");
    expect(e.message).toMatch(/revoke one first/);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants WHERE handle = 'claude-ai'")).toEqual({ n: 2 });
    expect(f.sql.one("SELECT consumed_at FROM oauth_requests WHERE id_hash = ?", sha256(c.request_id))).toEqual({ consumed_at: null });
    // Another handle is not affected; revoking one makes room.
    expect(approve(f, "other-agent")).toMatchObject({ created: true });
    expect(f.board.act(f.ctx(ADMIN, "cli"), "oauth_grant_revoke", { id: a.grant }).ok).toBe(true);
    expect(decide(f, c.request_id).ok).toBe(true);
    // An expired grant does not count.
    f.clock.advance(31 * DAY);
    expect(approve(f).grant).toBeDefined();
  });
});

describe("code exchange (design §9 step 6)", () => {
  it("makes an access and a refresh token, stored as hashes only, and spends the code", () => {
    const f = fx();
    const a = approve(f);
    const r = exchange(f, a.code);
    expect(r).toMatchObject({ ok: true, value: { token_type: "Bearer", expires_in: 3_600, scope: "board" } });
    const v = ok(r);
    expect(v.access_token).toMatch(/^bbsat_[A-Za-z0-9_-]{43}$/);
    expect(v.refresh_token).toMatch(/^bbsrt_[A-Za-z0-9_-]{43}$/);
    expect(f.sql.one("SELECT access_hash, access_expires_at, refresh_hash, replaced_at FROM oauth_tokens")).toEqual({
      access_hash: sha256(v.access_token),
      access_expires_at: f.clock.t + HOUR,
      refresh_hash: sha256(v.refresh_token),
      replaced_at: null,
    });
    expect(f.sql.one("SELECT used_at FROM oauth_codes")).toEqual({ used_at: f.clock.t });
    const everything = JSON.stringify(f.auditRows()) + JSON.stringify(f.sql.all("SELECT * FROM oauth_tokens"));
    for (const secret of [a.code, v.access_token, v.refresh_token, VERIFIER]) expect(everything).not.toContain(secret);
    expect(rowsOf(f, "oauth_code_exchange")[0]).toMatchObject({ actor: "system", via: "system", target_type: "oauth_grant", target_id: a.grant, result: "ok" });
  });

  it("refuses a verifier that does not match the challenge, and does not spend the code", () => {
    const f = fx();
    const a = approve(f);
    const wrong = exchange(f, a.code, { code_verifier: "z".repeat(43) });
    expect(wrong).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(exchange(f, a.code, { code_verifier: "short" })).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(f.sql.one("SELECT used_at FROM oauth_codes")).toEqual({ used_at: null });
    expect(exchange(f, a.code).ok).toBe(true);
  });

  it("refuses a wrong redirect address, client, resource, an expired code and an unknown one", () => {
    const f = fx();
    const a = approve(f);
    expect(exchange(f, a.code, { redirect_uri: "https://client.example/other" })).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(exchange(f, a.code, { client_id: "https://other.example/id.json" })).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(exchange(f, a.code, { resource: "https://api.example/other" })).toMatchObject({ ok: false, error: "invalid_target" });
    expect(exchange(f, "unknown-code")).toMatchObject({ ok: false, error: "invalid_grant" });
    f.clock.advance(2 * MIN + 1);
    expect(exchange(f, a.code)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_tokens")).toEqual({ n: 0 });
  });

  it("asks for the right fields and grant type", () => {
    const f = fx();
    const a = approve(f);
    for (const missing of ["code", "code_verifier", "redirect_uri", "resource", "client_id"]) {
      expect(exchange(f, a.code, { [missing]: undefined }), missing).toMatchObject({ ok: false, error: "invalid_request" });
    }
    expect(exchange(f, a.code, { grant_type: "password" })).toMatchObject({ ok: false, error: "unsupported_grant_type" });
    expect(exchange(f, a.code, { grant_type: undefined })).toMatchObject({ ok: false, error: "unsupported_grant_type" });
    expect(exchange(f, a.code).ok).toBe(true);
  });

  it("makes one token pair when the code is exchanged twice at once, and ends the grant on the second use", async () => {
    const f = fx();
    const a = approve(f);
    const results = await Promise.all([exchange(f, a.code), exchange(f, a.code)].map(async (r) => r));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const lost = results.find((r) => !r.ok);
    expect(lost).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_tokens")).toEqual({ n: 0 });
    const won = results.find((r) => r.ok);
    expect(auth(f, ok(won as OAuthTokenResult).access_token)).toMatchObject({ ok: false, reason: "unknown_token" });
    expect(rowsOf(f, "oauth_grant_ended")[0]).toMatchObject({ target_id: a.grant, result: "ok" });
    expect(JSON.parse(rowsOf(f, "oauth_grant_ended")[0]?.detail as string)).toMatchObject({ reason: "code_replay", handle: "claude-ai" });
    // The agent account stays; only the approval ends.
    expect(f.sql.one("SELECT COUNT(*) AS n FROM users WHERE handle = 'claude-ai'")).toEqual({ n: 1 });
  });

  it("counts refused exchanges as failed sign-ins instead of writing a row each", () => {
    const f = fx();
    approve(f);
    for (let i = 0; i < 40; i++) exchange(f, `bad-code-${i}`);
    const authRows = rowsOf(f, "auth");
    expect(authRows).toHaveLength(20);
    expect(JSON.parse(authRows[0]?.detail as string)).toMatchObject({ endpoint: "/oauth/token", source: SOURCE });
    const limited = exchange(f, "one-more");
    expect(limited).toMatchObject({ ok: false, error: "temporarily_unavailable" });
    expect((limited as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(0);
    expect(rowsOf(f, "sign_in_limited")).toHaveLength(1);
  });
});

describe("access token on /mcp (design §9 step 7)", () => {
  it("authenticates as the agent, via mcp, with the grant's id, and an agent's own token still works", () => {
    const f = fx();
    const own = f.addUser("local-agent");
    const p = signIn(f);
    expect(auth(f, p.access)).toEqual({ ok: true, handle: "claude-ai", kind: "agent", oauthGrant: p.grant });
    expect(auth(f, own)).toEqual({ ok: true, handle: "local-agent", kind: "agent" });
    const r = callAs(f, p, "join", { role: "connector" });
    expect(r.ok).toBe(true);
    const row = rowsOf(f, "join")[0];
    expect(row).toMatchObject({ actor: "claude-ai", actor_kind: "agent", via: "mcp" });
    expect(JSON.parse(row?.detail as string).grant).toBe(p.grant);
    // A refused call carries it too.
    const denied = f.board.refuse({ handle: "claude-ai", via: "mcp", oauthGrant: p.grant }, "mcp", "nope");
    expect(denied.ok).toBe(false);
    expect(JSON.parse(rowsOf(f, "mcp")[0]?.detail as string).grant).toBe(p.grant);
  });

  it("is accepted on /mcp only: with no access-token flag the value is just an unknown token", () => {
    const f = fx();
    const p = signIn(f);
    expect(auth(f, p.access, false)).toMatchObject({ ok: false, reason: "unknown_token" });
    expect(f.board.authenticate(p.access, { via: "api", source: SOURCE })).toMatchObject({ ok: false, reason: "unknown_token" });
    expect(f.board.authenticate(p.access, { via: "ws", source: SOURCE })).toMatchObject({ ok: false, reason: "unknown_token" });
    // A refresh token is not an access token.
    expect(auth(f, p.refresh)).toMatchObject({ ok: false, reason: "unknown_token" });
  });

  it("stops working when it expires, when its grant expires, when the agent is kicked, and when the grant ends", () => {
    const f = fx();
    const p = signIn(f);
    f.clock.advance(HOUR - 1);
    expect(auth(f, p.access).ok).toBe(true);
    f.clock.advance(1);
    expect(auth(f, p.access)).toMatchObject({ ok: false, reason: "expired_token" });
    // A refresh makes a new one, valid for another hour.
    const next = ok(refresh(f, p.refresh));
    expect(auth(f, next.access_token).ok).toBe(true);
    // The earlier access token has its own expiry; the refresh did not end it.
    expect(auth(f, p.access)).toMatchObject({ ok: false, reason: "expired_token" });

    f.sql.exec("UPDATE oauth_grants SET expires_at = ? WHERE id = ?", f.clock.t, p.grant);
    expect(auth(f, next.access_token)).toMatchObject({ ok: false, reason: "expired_grant" });
    f.sql.exec("UPDATE oauth_grants SET expires_at = ? WHERE id = ?", f.clock.t + DAY, p.grant);
    expect(auth(f, next.access_token).ok).toBe(true);
    f.sql.exec("UPDATE users SET status = 'kicked' WHERE handle = 'claude-ai'");
    expect(auth(f, next.access_token)).toMatchObject({ ok: false, reason: "revoked_token" });
    f.sql.exec("UPDATE users SET status = 'muted_lobby' WHERE handle = 'claude-ai'");
    expect(auth(f, next.access_token).ok).toBe(true);
    expect(f.board.act(f.ctx(ADMIN, "cli"), "oauth_grant_revoke", { id: p.grant }).ok).toBe(true);
    expect(auth(f, next.access_token)).toMatchObject({ ok: false, reason: "unknown_token" });
  });

  it("counts refusals through the failed sign-in guards, with the grant named for an expired token", () => {
    const f = fx();
    const p = signIn(f);
    f.clock.advance(2 * HOUR);
    auth(f, p.access);
    const row = rowsOf(f, "auth").at(-1);
    expect(row).toMatchObject({ actor: "anonymous", via: "mcp", result: "denied" });
    expect(JSON.parse(row?.detail as string)).toMatchObject({ grant: p.grant, endpoint: null });
  });

  it("marks the grant used by a call made with it", () => {
    const f = fx();
    const p = signIn(f);
    expect(f.sql.one("SELECT last_used_at FROM oauth_grants")).toEqual({ last_used_at: null });
    f.clock.advance(5 * MIN);
    expect(callAs(f, p).ok).toBe(true);
    expect(f.sql.one("SELECT last_used_at FROM oauth_grants")).toEqual({ last_used_at: f.clock.t });
    // The call is the agent's activity, like any other.
    expect(f.sql.one("SELECT last_seen FROM users WHERE handle = 'claude-ai'")).toEqual({ last_seen: f.clock.t });
  });

  it("a connector is an agent: it cannot reach the admin tools, and the OAuth tools are not offered on /mcp", () => {
    const f = fx();
    const p = signIn(f);
    const ctx: CallContext = { handle: "claude-ai", via: "mcp", oauthGrant: p.grant };
    for (const name of ["bbs_oauth_grants", "bbs_oauth_grant_revoke", "bbs_admin_user_add", "bbs_web_sessions"]) {
      const r = callTool(f.board, ctx, name, { id: p.grant }, "mcp");
      expect(r.isError, name).toBe(true);
      expect(r.content[0]?.text, name).toMatch(/not offered on mcp/);
    }
    expect(TOOLS.filter((t) => t.surfaces.includes("mcp")).map((t) => t.name)).not.toContain("bbs_oauth_grants");
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 1 });
    const direct = f.board.act(ctx, "oauth_grant_revoke", { id: p.grant });
    expect(direct.ok).toBe(false);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 1 });
  });
});

describe("refresh (design §9 steps 8 and 9)", () => {
  it("rotates: a new pair, the old one marked replaced, the old access token working until its own expiry, the grant's expiry unchanged within a day", () => {
    const f = fx();
    const p = signIn(f);
    const expires = f.sql.one<{ expires_at: number }>("SELECT expires_at FROM oauth_grants")?.expires_at;
    f.clock.advance(30 * MIN);
    const r = ok(refresh(f, p.refresh));
    expect(r.access_token).not.toBe(p.access);
    expect(r.refresh_token).not.toBe(p.refresh);
    expect(f.sql.all("SELECT access_hash, refresh_hash, replaced_at FROM oauth_tokens ORDER BY id")).toEqual([
      { access_hash: sha256(p.access), refresh_hash: sha256(p.refresh), replaced_at: f.clock.t },
      { access_hash: sha256(r.access_token), refresh_hash: sha256(r.refresh_token), replaced_at: null },
    ]);
    // A refresh does not cut an access token short.
    expect(auth(f, p.access).ok).toBe(true);
    expect(auth(f, r.access_token).ok).toBe(true);
    f.clock.advance(30 * MIN);
    expect(auth(f, p.access)).toMatchObject({ ok: false, reason: "expired_token" });
    expect(auth(f, r.access_token).ok).toBe(true);
    expect(f.sql.one("SELECT expires_at FROM oauth_grants")).toEqual({ expires_at: expires });
    expect(rowsOf(f, "oauth_refresh")[0]).toMatchObject({ actor: "system", target_id: p.grant });
    expect(JSON.parse(rowsOf(f, "oauth_refresh")[0]?.detail as string)).toMatchObject({ renewed: false });
    const everything = JSON.stringify(f.auditRows());
    expect(everything).not.toContain(r.refresh_token);
    expect(everything).not.toContain(p.refresh);
  });

  it("two refreshes with the same token inside the grace both succeed, and both pairs work until one is refreshed", () => {
    const f = fx();
    const p = signIn(f);
    const r2 = ok(refresh(f, p.refresh));
    f.clock.advance(5_000);
    const r3 = ok(refresh(f, p.refresh));
    expect(r3.refresh_token).not.toBe(r2.refresh_token);
    for (const t of [r2, r3]) expect(auth(f, t.access_token).ok).toBe(true);
    // The first presentation fixed replaced_at; the second did not move it.
    expect(f.sql.one("SELECT replaced_at, successors FROM oauth_tokens WHERE refresh_hash = ?", sha256(p.refresh))).toEqual({ replaced_at: f.clock.t - 5_000, successors: 2 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 1 });
  });

  it("the benign parallel case: two at once, the client keeps one pair and refreshes it for many rounds", () => {
    const f = fx();
    const p = signIn(f);
    const kept = ok(refresh(f, p.refresh));
    const other = ok(refresh(f, p.refresh));
    let t = kept;
    for (let round = 0; round < 8; round++) {
      f.clock.advance(10 * MIN);
      expect(auth(f, t.access_token).ok, `round ${round}`).toBe(true);
      t = ok(refresh(f, t.refresh_token));
    }
    expect(auth(f, t.access_token).ok).toBe(true);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 1 });
    // The pair it did not keep was retired by the first refresh of the kept one.
    expect(auth(f, other.access_token)).toMatchObject({ ok: false });
  });

  it("a stolen token used inside the grace: the holder who refreshes second ends the grant (client first)", () => {
    const f = fx();
    const p = signIn(f);
    const y1 = ok(refresh(f, p.refresh));
    f.clock.advance(5_000);
    const y2 = ok(refresh(f, p.refresh));
    expect(auth(f, y2.access_token).ok).toBe(true);
    // The client refreshes first: that picks its line and retires the thief's pair at once.
    const z1 = ok(refresh(f, y1.refresh_token));
    expect(auth(f, y2.access_token)).toMatchObject({ ok: false, reason: "expired_token" });
    expect(auth(f, z1.access_token).ok).toBe(true);
    expect(refresh(f, y2.refresh_token)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
    expect(auth(f, z1.access_token).ok).toBe(false);
    expect(JSON.parse(rowsOf(f, "oauth_grant_ended")[0]?.detail as string)).toMatchObject({ reason: "refresh_replay" });
  });

  it("closes the token a pair came from: presenting it again inside its grace, after a child was refreshed, ends the grant", () => {
    const f = fx();
    const p = signIn(f);
    const y1 = ok(refresh(f, p.refresh));
    f.clock.advance(5_000);
    const z = ok(refresh(f, y1.refresh_token));
    expect(f.sql.one("SELECT replaced_at FROM oauth_tokens WHERE refresh_hash = ?", sha256(p.refresh))).toEqual({ replaced_at: f.clock.t - 60_000 });
    const rowsBefore = f.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM oauth_tokens")?.n;
    // X is only 5 seconds into its grace, but no Y2 is issued: it is a replay.
    expect(refresh(f, p.refresh)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(rowsBefore).toBe(3);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_tokens")).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
    expect(auth(f, z.access_token).ok).toBe(false);
    expect(JSON.parse(rowsOf(f, "oauth_grant_ended")[0]?.detail as string)).toMatchObject({ reason: "refresh_replay" });
  });

  it("the conditional UPDATE also refuses a closed token, called directly with no pre-check", async () => {
    const f = fx();
    const p = signIn(f);
    const y1 = ok(refresh(f, p.refresh));
    ok(refresh(f, y1.refresh_token));
    // The same race through Promise.all: whichever comes first, none gets a pair from the closed token.
    const results = await Promise.all([0, 1].map(async () => refresh(f, p.refresh)));
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_tokens WHERE parent_id = (SELECT id FROM oauth_tokens WHERE refresh_hash = ?)", sha256(p.refresh))).toEqual({ n: 0 });
  });

  it("a stolen token used inside the grace: the holder who refreshes second ends the grant (thief first)", () => {
    const f = fx();
    const p = signIn(f);
    const y1 = ok(refresh(f, p.refresh));
    f.clock.advance(5_000);
    const y2 = ok(refresh(f, p.refresh));
    const z2 = ok(refresh(f, y2.refresh_token));
    expect(auth(f, y1.access_token)).toMatchObject({ ok: false, reason: "expired_token" });
    expect(refresh(f, y1.refresh_token)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
    expect(auth(f, z2.access_token).ok).toBe(false);
  });

  it("limits the pairs one refresh token produces: the sixth is refused, the grant lives, the five pairs work", () => {
    const f = fx();
    const p = signIn(f);
    const pairs = [0, 1, 2, 3, 4].map(() => ok(refresh(f, p.refresh)));
    const sixth = refresh(f, p.refresh);
    expect(sixth).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 1 });
    expect(f.sql.one("SELECT successors FROM oauth_tokens WHERE refresh_hash = ?", sha256(p.refresh))).toEqual({ successors: 5 });
    for (const t of pairs) expect(auth(f, t.access_token).ok).toBe(true);
    // It was counted as a failed sign-in, not treated as a replay.
    expect(rowsOf(f, "oauth_grant_ended")).toHaveLength(0);
    expect(rowsOf(f, "auth").at(-1)?.result).toBe("denied");
    expect(refresh(f, (pairs[0] as { refresh_token: string }).refresh_token).ok).toBe(true);
  });

  it("a replaced refresh token presented after the grace is a replay and ends the grant", () => {
    const f = fx();
    const p = signIn(f);
    const r2 = ok(refresh(f, p.refresh));
    // Right at the end of the grace it is a replay (the grace is open: newer than now - grace).
    f.clock.advance(60_000);
    expect(refresh(f, p.refresh)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_tokens")).toEqual({ n: 0 });
    expect(auth(f, r2.access_token).ok).toBe(false);
    expect(refresh(f, r2.refresh_token)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(JSON.parse(rowsOf(f, "oauth_grant_ended")[0]?.detail as string)).toMatchObject({ reason: "refresh_replay" });
  });

  it("one second inside the grace is still good", () => {
    const f = fx();
    const p = signIn(f);
    ok(refresh(f, p.refresh));
    f.clock.advance(59_999);
    expect(refresh(f, p.refresh).ok).toBe(true);
  });

  it("the refresh's conditional UPDATE is the verdict: concurrent refreshes inside the grace all get a pair, none after it", async () => {
    const f = fx();
    const p = signIn(f);
    const inside = await Promise.all([0, 1, 2].map(async () => refresh(f, p.refresh)));
    expect(inside.every((r) => r.ok)).toBe(true);
    expect(new Set(inside.map((r) => ok(r).refresh_token)).size).toBe(3);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_tokens")).toEqual({ n: 4 });
    f.clock.advance(60_000);
    const after = await Promise.all([0, 1].map(async () => refresh(f, p.refresh)));
    expect(after.every((r) => !r.ok)).toBe(true);
    // The first one found the replay and ended the grant; the second found nothing.
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
  });

  it("is judged by the UPDATE itself: a replaced token past the grace changes no row even when called directly", () => {
    const f = fx();
    const p = signIn(f);
    ok(refresh(f, p.refresh));
    f.clock.advance(61_000);
    const direct = f.board.oauthToken({
      params: { grant_type: "refresh_token", refresh_token: p.refresh, client_id: CLIENT, resource: RESOURCE },
      resource: RESOURCE,
      source: SOURCE,
    });
    expect(direct.ok).toBe(false);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_tokens")).toEqual({ n: 0 });
  });

  it("must repeat the grant's client and resource", () => {
    const f = fx();
    const p = signIn(f);
    expect(refresh(f, p.refresh, { client_id: "https://other.example/id.json" })).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(refresh(f, p.refresh, { resource: "https://api.example/other" })).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(refresh(f, p.refresh, { resource: undefined })).toMatchObject({ ok: false, error: "invalid_request" });
    expect(refresh(f, p.refresh, { client_id: undefined })).toMatchObject({ ok: false, error: "invalid_request" });
    expect(refresh(f, p.refresh, { refresh_token: undefined })).toMatchObject({ ok: false, error: "invalid_request" });
    expect(refresh(f, "bbsrt_unknown")).toMatchObject({ ok: false, error: "invalid_grant" });
    // None of those ended the grant.
    expect(refresh(f, p.refresh).ok).toBe(true);
  });

  it("is refused for a grant that has ended", () => {
    const f = fx();
    const p = signIn(f);
    f.clock.advance(30 * DAY + 1);
    expect(refresh(f, p.refresh)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(auth(f, p.access).ok).toBe(false);
  });

  it("renews the grant's expiry only when the last renewal is more than a day old", () => {
    const f = fx();
    const p = signIn(f);
    const created = f.clock.t;
    let token = p.refresh;
    // Hourly refreshes for a day renew nothing.
    for (let i = 0; i < 24; i++) {
      f.clock.advance(HOUR);
      token = ok(refresh(f, token)).refresh_token;
    }
    expect(f.sql.one("SELECT renewed_at, expires_at FROM oauth_grants")).toEqual({ renewed_at: created, expires_at: created + 30 * DAY });
    // The first refresh past a day renews it, 30 days from now.
    f.clock.advance(MIN);
    token = ok(refresh(f, token)).refresh_token;
    expect(f.sql.one("SELECT renewed_at, expires_at FROM oauth_grants")).toEqual({ renewed_at: f.clock.t, expires_at: f.clock.t + 30 * DAY });
    expect(JSON.parse(rowsOf(f, "oauth_refresh").at(-1)?.detail as string)).toMatchObject({ renewed: true });
    // So a client that refreshes every day outlives 30 days.
    for (let day = 0; day < 40; day++) {
      f.clock.advance(DAY + MIN);
      token = ok(refresh(f, token)).refresh_token;
    }
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 1 });
  });

  it("keeps the newest 20 replaced pairs per grant; an older refresh token is unknown, not a replay", () => {
    const f = fx();
    const p = signIn(f);
    let token = p.refresh;
    for (let i = 0; i < 30; i++) {
      f.clock.advance(MIN);
      token = ok(refresh(f, token)).refresh_token;
    }
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_tokens WHERE replaced_at IS NOT NULL")).toEqual({ n: 20 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_tokens WHERE replaced_at IS NULL")).toEqual({ n: 1 });
    expect(refresh(f, p.refresh)).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 1 });
    expect(refresh(f, token).ok).toBe(true);
  });

  it("the cap never deletes a row that has not been replaced", () => {
    const f = fx();
    const p = signIn(f);
    const y1 = ok(refresh(f, p.refresh));
    const y2 = ok(refresh(f, p.refresh));
    // Far more than 20 replaced rows, as if many rounds had gone by.
    for (let i = 0; i < 25; i++) {
      f.sql.exec(
        `INSERT INTO oauth_tokens (grant_id, parent_id, access_hash, access_expires_at, refresh_hash, issued_at, replaced_at)
         VALUES (?, NULL, ?, 1, ?, 1, 1)`,
        p.grant,
        `access-${i}`,
        `refresh-${i}`,
      );
    }
    const y3 = ok(refresh(f, p.refresh));
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_tokens WHERE replaced_at IS NOT NULL")).toEqual({ n: 20 });
    const unreplaced = f.sql.all<{ refresh_hash: string }>("SELECT refresh_hash FROM oauth_tokens WHERE replaced_at IS NULL ORDER BY id");
    expect(unreplaced.map((r) => r.refresh_hash)).toEqual([y1, y2, y3].map((t) => sha256(t.refresh_token)));
    // Until one of the siblings is refreshed and retires the others.
    ok(refresh(f, y1.refresh_token));
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_tokens WHERE replaced_at IS NULL")).toEqual({ n: 1 });
  });
});

describe("the client's own revoke and the person's (design §9 step 10)", () => {
  it("ends the grant for an access token or a refresh token of the same client", () => {
    for (const which of ["access", "refresh"] as const) {
      const f = fx();
      const p = signIn(f);
      expect(f.board.oauthRevoke({ token: p[which], clientId: CLIENT, source: SOURCE })).toEqual({ ok: true });
      expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
      expect(auth(f, p.access).ok).toBe(false);
      expect(refresh(f, p.refresh)).toMatchObject({ ok: false });
      expect(JSON.parse(rowsOf(f, "oauth_grant_ended")[0]?.detail as string)).toMatchObject({ reason: "client_revoke" });
    }
  });

  it("refuses another client's token, answers success for an unknown token, and counts both", () => {
    const f = fx();
    const p = signIn(f);
    expect(f.board.oauthRevoke({ token: p.access, clientId: "https://other.example/id.json", source: SOURCE })).toMatchObject({ ok: false, error: "invalid_client" });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 1 });
    expect(f.board.oauthRevoke({ token: "bbsat_unknown", clientId: CLIENT, source: SOURCE })).toEqual({ ok: true });
    expect(f.board.oauthRevoke({ token: undefined, clientId: CLIENT, source: SOURCE })).toMatchObject({ ok: false, error: "invalid_request" });
    const reasons = rowsOf(f, "auth").map((r) => JSON.parse(r.detail as string));
    expect(reasons.map((d) => d.endpoint)).toEqual(["/oauth/revoke", "/oauth/revoke"]);
    for (let i = 0; i < 30; i++) f.board.oauthRevoke({ token: `bbsat_unknown_${i}`, clientId: CLIENT, source: SOURCE });
    expect(f.board.oauthRevoke({ token: "bbsat_unknown", clientId: CLIENT, source: SOURCE })).toMatchObject({ ok: false, error: "temporarily_unavailable" });
  });

  it("lists live grants for a person, and the human admin revokes one from the CLI", () => {
    const f = fx();
    const p = signIn(f);
    f.clock.advance(MIN);
    callAs(f, p);
    f.addUser("pat", "human");
    const listed = f.board.act(f.ctx(ADMIN, "cli"), "oauth_grants", {});
    expect(listed).toMatchObject({ ok: true, value: { grants: [{ id: p.grant, client_id: CLIENT, client_name: "Claude Test", client_host: "client.example", handle: "claude-ai", approved_by: ADMIN }] } });
    const g = (listed as unknown as { value: { grants: Record<string, number>[] } }).value.grants[0];
    expect(g).toMatchObject({ last_used_at: f.clock.t });
    expect(JSON.stringify(listed)).not.toContain(p.access);
    // Reads are not audited; a person on the web view may list too, but not revoke.
    expect(f.board.act(webCtx(), "oauth_grants", {}).ok).toBe(true);
    expect(refused(f.board.act(webCtx(), "oauth_grant_revoke", { id: p.grant })).message).toMatch(/only available from the bbs CLI/);
    expect(refused(f.board.act(f.ctx("pat", "cli"), "oauth_grant_revoke", { id: p.grant })).message).toMatch(/only a human admin/);
    expect(refused(f.board.act({ handle: "claude-ai", via: "mcp" }, "oauth_grants", {})).message).toMatch(/only a person/);
    expect(refused(f.board.act(f.ctx(ADMIN, "cli"), "oauth_grant_revoke", { id: "og_nope" })).code).toBe("not_found");
    expect(refused(f.board.act(f.ctx(ADMIN, "cli"), "oauth_grant_revoke", {})).code).toBe("bad_request");

    const revoked = f.board.act(f.ctx(ADMIN, "cli"), "oauth_grant_revoke", { id: p.grant });
    expect(revoked).toMatchObject({ ok: true, value: { revoked: p.grant, handle: "claude-ai" } });
    expect(rowsOf(f, "oauth_grant_revoke").at(-1)).toMatchObject({ actor: ADMIN, via: "cli", target_id: p.grant, result: "ok" });
    expect(auth(f, p.access).ok).toBe(false);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_tokens")).toEqual({ n: 0 });
    expect(f.board.act(f.ctx(ADMIN, "cli"), "oauth_grants", {})).toMatchObject({ ok: true, value: { grants: [] } });
  });

  it("does not list a grant that has expired but is not yet pruned", () => {
    const f = fx();
    signIn(f);
    f.clock.advance(31 * DAY);
    expect(f.board.act(f.ctx(ADMIN, "cli"), "oauth_grants", {})).toMatchObject({ ok: true, value: { grants: [] } });
  });

  it("ends a kicked agent's grants, and reinstating does not bring them back", () => {
    const f = fx();
    const p = signIn(f, "bob");
    const other = signIn(f, "carol");
    expect(callAs(f, p, "join", {}).ok).toBe(true);
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 7; i++) callAs(f, p, "post", { topic: "Lobby", body: `b${round}-${i}` });
      f.clock.advance(61 * MIN);
      f.board.runDueTimers();
      f.clock.advance(-50 * MIN);
    }
    expect(f.sql.one("SELECT status FROM users WHERE handle = 'bob'")).toEqual({ status: "kicked" });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants WHERE handle = 'bob'")).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_tokens WHERE grant_id = ?", p.grant)).toEqual({ n: 0 });
    expect(auth(f, p.access)).toMatchObject({ ok: false, reason: "unknown_token" });
    expect(refresh(f, p.refresh)).toMatchObject({ ok: false });
    // Another agent's grant is untouched.
    expect(auth(f, other.access).ok).toBe(true);
    expect(f.board.act(f.ctx(ADMIN, "cli"), "admin_reinstate", { handle: "bob" }).ok).toBe(true);
    expect(auth(f, p.access).ok).toBe(false);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants WHERE handle = 'bob'")).toEqual({ n: 0 });
  });
});

describe("an approval whose code is never exchanged (issue #67)", () => {
  const unused = (f: Fixture) => f.sql.all("SELECT ref, due_at FROM timers WHERE kind = 'oauth_code_unused'");

  it("ends the grant when the code expires, as an audited system action, and the handle can be approved again", () => {
    const f = fx({ oauthGrantMaxPerHandle: 1 });
    const a = approve(f, "chatgpt");
    expect(unused(f)).toEqual([{ ref: a.grant, due_at: f.clock.t + 2 * MIN }]);

    // Not yet: the code is still live.
    f.clock.advance(2 * MIN - 1);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 1 });

    f.clock.advance(1);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_codes")).toEqual({ n: 0 });
    expect(unused(f)).toEqual([]);
    expect(rowsOf(f, "oauth_code_unused")).toHaveLength(1);
    expect(rowsOf(f, "oauth_code_unused")[0]).toMatchObject({ actor: "system", via: "system", target_type: "oauth_grant", target_id: a.grant, result: "ok" });
    expect(JSON.parse(rowsOf(f, "oauth_code_unused")[0]?.detail as string)).toMatchObject({
      outcome: "ended",
      reason: "code_unexchanged",
      handle: "chatgpt",
      client: CLIENT,
    });
    expect((f.board.act(f.ctx(ADMIN, "cli"), "oauth_grants", {}) as { value: { grants: unknown[] } }).value.grants).toEqual([]);
    expect(exchange(f, a.code).ok).toBe(false);

    // The never-used account stays, is suggested again, and a new approval reuses it,
    // even with a limit of one grant per handle.
    expect(f.sql.one("SELECT kind, token_hash, status FROM users WHERE handle = 'chatgpt'")).toEqual({ kind: "agent", token_hash: null, status: "active" });
    expect(consent(f, { client_doc: doc({ client_name: "ChatGPT" }) }).suggested_handle).toBe("chatgpt");
    const again = approve(f, "chatgpt");
    expect(again).toMatchObject({ created: false });
    expect(ok(exchange(f, again.code)).access_token).toBeDefined();
  });

  it("leaves an exchanged grant alone", () => {
    const f = fx();
    const p = signIn(f);
    f.clock.advance(2 * MIN);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 1 });
    expect(JSON.parse(rowsOf(f, "oauth_code_unused")[0]?.detail as string)).toMatchObject({ outcome: "exchanged" });
    expect(auth(f, p.access).ok).toBe(true);
  });

  it("drops its timer when the grant ends first", () => {
    const f = fx();
    const a = approve(f);
    expect(f.board.act(f.ctx(ADMIN, "cli"), "oauth_grant_revoke", { id: a.grant }).ok).toBe(true);
    expect(unused(f)).toEqual([]);
    f.clock.advance(2 * MIN);
    f.board.runDueTimers();
    expect(rowsOf(f, "oauth_code_unused")).toHaveLength(0);
  });

  it("suggests only a never-used account: not one with a static token, a live grant or a sign-in", () => {
    const name = { client_doc: doc({ client_name: "ChatGPT" }) };
    const withAccount = (): Fixture => {
      const f = fx();
      f.sql.exec("INSERT INTO users (handle, kind, token_hash, created_at) VALUES ('chatgpt', 'agent', NULL, ?)", f.clock.t);
      return f;
    };
    expect(consent(withAccount(), name).suggested_handle).toBe("chatgpt");

    const granted = withAccount();
    approve(granted, "chatgpt");
    expect(consent(granted, name).suggested_handle).toBe("chatgpt-2");

    const seen = withAccount();
    seen.sql.exec("UPDATE users SET last_seen = ? WHERE handle = 'chatgpt'", seen.clock.t);
    expect(consent(seen, name).suggested_handle).toBe("chatgpt-2");

    const static_ = fx();
    static_.addUser("chatgpt");
    expect(consent(static_, name).suggested_handle).toBe("chatgpt-2");
  });
});

describe("expiry and pruning (design §9 step 9)", () => {
  it("arms one prune timer, which deletes what expired and runs again while any row is left", () => {
    const f = fx();
    expect(f.sql.all("SELECT * FROM timers WHERE kind = 'oauth_prune'")).toHaveLength(0);
    const p = signIn(f);
    expect(f.sql.all("SELECT due_at FROM timers WHERE kind = 'oauth_prune'")).toEqual([{ due_at: f.clock.t + DAY }]);
    consent(f);
    expect(f.sql.all("SELECT * FROM timers WHERE kind = 'oauth_prune'")).toHaveLength(1);

    // A day on: the used code and the expired request go; the live grant stays, and so does the client copy it uses.
    f.clock.advance(DAY);
    expect(f.board.runDueTimers().map((r) => r.ok)).toContain(true);
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_codes")).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_requests")).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_clients")).toEqual({ n: 1 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 1 });
    expect(f.sql.all("SELECT * FROM timers WHERE kind = 'oauth_prune'")).toHaveLength(1);
    expect(JSON.parse(rowsOf(f, "oauth_prune")[0]?.detail as string)).toMatchObject({ requests: 2, codes: 1, grants: 0, clients: 0, rearmed: true });

    // Past the grant's end it goes with its tokens, and with nothing left the timer stays off.
    f.clock.advance(30 * DAY);
    f.board.runDueTimers();
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_tokens")).toEqual({ n: 0 });
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_clients")).toEqual({ n: 0 });
    expect(f.sql.all("SELECT * FROM timers WHERE kind = 'oauth_prune'")).toHaveLength(0);
    expect(JSON.parse(rowsOf(f, "oauth_prune").at(-1)?.detail as string)).toMatchObject({ grants: 1, clients: 1, rearmed: false });
    expect(auth(f, p.access).ok).toBe(false);
  });

  it("a day of ordinary use never ends a grant that is used", () => {
    const f = fx();
    const p = signIn(f);
    let token = p.refresh;
    for (let day = 0; day < 45; day++) {
      f.clock.advance(DAY - HOUR);
      f.board.runDueTimers();
      const t = ok(refresh(f, token));
      token = t.refresh_token;
      expect(auth(f, t.access_token).ok).toBe(true);
      f.clock.advance(HOUR);
    }
    expect(f.sql.one("SELECT COUNT(*) AS n FROM oauth_grants")).toEqual({ n: 1 });
  });
});

describe("admin status", () => {
  it("shows an agent made by a connector's approval, which has no static token, as active", () => {
    const f = fx();
    signIn(f);
    const r = f.board.act(f.ctx(ADMIN, "cli"), "admin_status", {});
    expect(r).toMatchObject({ ok: true });
    const users = (r as unknown as { value: { users: { handle: string; status: string }[] } }).value.users;
    expect(users.find((u) => u.handle === "claude-ai")).toMatchObject({ status: "active" });
  });
});

describe("configuration", () => {
  it("has the design's defaults", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      oauthClientCacheMs: DAY,
      oauthClientFetchTimeoutMs: 5_000,
      oauthClientMaxBytes: 16 * 1024,
      oauthRequestTtlMs: 10 * MIN,
      oauthCodeTtlMs: 2 * MIN,
      oauthAccessTtlMs: HOUR,
      oauthGrantTtlMs: 30 * DAY,
      oauthGrantRenewAfterMs: DAY,
      oauthRefreshGraceMs: 60_000,
      oauthRefreshMaxSuccessors: 5,
      oauthGrantMaxPerHandle: 10,
      oauthRequestMaxPending: 20,
    });
  });

  it("validates the new fields: positive integers, and a renewal span shorter than the grant's life", () => {
    expect(validateConfig({ ...DEFAULT_CONFIG })).toBeUndefined();
    for (const key of ["oauthClientCacheMs", "oauthCodeTtlMs", "oauthAccessTtlMs", "oauthGrantMaxPerHandle", "oauthRefreshMaxSuccessors", "oauthRequestMaxPending", "oauthPruneIntervalMs"] as const) {
      expect(validateConfig({ ...DEFAULT_CONFIG, [key]: 0 }), key).toMatch(new RegExp(`${key} must be a positive integer`));
      expect(validateConfig({ ...DEFAULT_CONFIG, [key]: 1.5 }), key).toMatch(/positive integer/);
    }
    expect(validateConfig({ ...DEFAULT_CONFIG, oauthGrantRenewAfterMs: 30 * DAY })).toMatch(/oauthGrantRenewAfterMs must be less/);
    expect(() => makeBoard({ config: { oauthCodeTtlMs: -1 } })).toThrow(/invalid board config/);
  });
});
