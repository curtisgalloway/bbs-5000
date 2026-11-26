// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// The Worker's side of OAuth on /mcp (issue #55), through its fetch handler
// with the Board DO faked: the host rule of every new route, the free 401
// challenge, the metadata documents, the token and revoke routes, and the
// consent page's two calls.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/board-do.ts", () => ({
  BoardDO: class {},
  WS_HANDLE_HEADER: "x-h",
  WS_REQUEST_HEADER: "x-r",
  WS_TOKEN_HASH_HEADER: "x-t",
}));
vi.mock("agents/mcp/server", () => ({ createMcpHandler: () => () => new Response("mcp") }));

const { default: worker } = await import("../src/index.ts");

const exec = {} as ExecutionContext;
const WEB = "https://app.example.com";
const API = "https://api.example.com";
const CLIENT = "https://client.example/oauth/client.json";
const REDIRECT = "https://client.example/callback";

interface Call {
  method: string;
  args: unknown[];
}

function makeEnv(extra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const assetPaths: string[] = [];
  const okToken = { ok: true, value: { access_token: "at", refresh_token: "rt", token_type: "Bearer", expires_in: 3600, scope: "board" } };
  const results: Record<string, unknown> = {
    authenticate: { ok: false, reason: "unknown_token", auditSeq: 1 },
    authenticateWebSession: { ok: true, handle: "owner", kind: "human", webSession: "ws_1" },
    oauthClientFresh: false,
    oauthToken: { ok: true, value: { access_token: "at", refresh_token: "rt", token_type: "Bearer", expires_in: 3600, scope: "board" } },
    oauthRevoke: { ok: true },
    oauthClaimKeyRefetch: null,
    oauthStoreKeys: true,
    oauthRequest: { ok: true, value: { status: "consent", request_id: "rq", client: { id: CLIENT, name: "C", host: "client.example" } }, notifications: [], auditSeq: 1 },
    oauthDecide: { ok: true, value: { approved: true, redirect_uri: REDIRECT, state: "s1", code: "the-code", grant: "og_1", handle: "claude-ai", created: true }, notifications: [], auditSeq: 2 },
    refuse: { code: "bad_request", message: "refused" },
    callTool: { isError: false, content: [], structuredContent: {} },
  };
  const stub = Object.fromEntries(
    Object.keys(results).map((method) => [
      method,
      async (...args: unknown[]) => {
        calls.push({ method, args });
        const r = results[method];
        return typeof r === "function" ? (r as (...a: unknown[]) => unknown)(...args) : r;
      },
    ]),
  );
  const env = {
    BOARD: { idFromName: () => "id", get: () => stub },
    ASSETS: {
      fetch: async (req: Request) => {
        assetPaths.push(new URL(req.url).pathname);
        return new Response(null, { status: 404 });
      },
    },
    ...extra,
  };
  return { env: env as never, calls, assetPaths, results, okToken };
}

async function call(url: string, init: RequestInit = {}, e = makeEnv()) {
  const res = await worker.fetch(new Request(url, init), e.env, exec);
  const text = await res.text();
  return { res, text, calls: e.calls, assetPaths: e.assetPaths, e };
}

const json = (headers: Record<string, string>, body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const form = (body: string, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  body,
});
const cookie = { cookie: "__Host-bbs-session=abc" };

afterEach(() => vi.unstubAllGlobals());

describe("the challenge on /mcp", () => {
  const CHALLENGE = 'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp", scope="board"';

  it("answers a request with no Authorization header with a free 401, without calling the board", async () => {
    for (const method of ["POST", "GET"]) {
      const r = await call(`${API}/mcp`, method === "POST" ? { method, body: "{}" } : { method });
      expect(r.res.status).toBe(401);
      expect(r.res.headers.get("www-authenticate")).toBe(CHALLENGE);
      expect(r.calls).toEqual([]);
    }
    // From the web host the challenge still names the API host's metadata.
    const web = await call(`${WEB}/mcp`, { method: "POST", body: "{}" });
    expect(web.res.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(web.calls).toEqual([]);
    const local = await call("http://localhost:8787/mcp", { method: "POST", body: "{}" });
    expect(local.res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://localhost:8787/.well-known/oauth-protected-resource/mcp", scope="board"',
    );
  });

  it("gives a token the board refuses the same header, after asking the board, which may also take an access token", async () => {
    const r = await call(`${API}/mcp`, { method: "POST", headers: { authorization: "Bearer bbsat_x" }, body: "{}" });
    expect(r.res.status).toBe(401);
    expect(r.res.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(r.calls.map((c) => c.method)).toEqual(["authenticate"]);
    expect(r.calls[0]?.args[1]).toMatchObject({ via: "mcp", endpoint: "/mcp", accessToken: true });
  });

  it("a refusal for a failed sign-in limit keeps its 429 and has no challenge", async () => {
    const e = makeEnv();
    e.results.authenticate = { ok: false, reason: "rate_limited", auditSeq: undefined, retryAfterMs: 5_000 };
    const r = await call(`${API}/mcp`, { method: "POST", headers: { authorization: "Bearer x" }, body: "{}" }, e);
    expect(r.res.status).toBe(429);
    expect(r.res.headers.get("retry-after")).toBe("5");
    expect(r.res.headers.get("www-authenticate")).toBeNull();
  });

  it("an access token is for /mcp only: /api and /ws never ask the board to accept one", async () => {
    const api = await call(`${API}/api/bbs_topics`, { method: "POST", headers: { authorization: "Bearer bbsat_x" }, body: "{}" });
    expect(api.calls[0]?.args[1]).not.toHaveProperty("accessToken");
    expect(api.res.headers.get("www-authenticate")).toBe('Bearer realm="bbs-5000"');
    const ws = await call(`${API}/ws`, { headers: { authorization: "Bearer bbsat_x", upgrade: "websocket" } });
    expect(ws.calls[0]?.args[1]).not.toHaveProperty("accessToken");
  });

  it("puts the grant the board named in the call's context", async () => {
    const e = makeEnv();
    e.results.authenticate = { ok: true, handle: "claude-ai", kind: "agent", oauthGrant: "og_1" };
    const r = await call(`${API}/mcp`, json({ authorization: "Bearer bbsat_x", accept: "application/json, text/event-stream" }, { jsonrpc: "2.0", id: 1, method: "tools/list" }), e);
    expect(r.res.status).toBe(200);
    expect(r.calls.map((c) => c.method)).toEqual(["authenticate"]);
  });
});

describe("the metadata documents", () => {
  it("name the resource and the authorization server on the API host", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const r = await call(`${API}${path}`);
      expect(r.res.status, path).toBe(200);
      expect(r.res.headers.get("access-control-allow-origin")).toBe("*");
      expect(JSON.parse(r.text)).toEqual({
        resource: `${API}/mcp`,
        authorization_servers: [API],
        scopes_supported: ["board"],
        bearer_methods_supported: ["header"],
        resource_name: "BBS-5000",
      });
      expect(r.calls).toEqual([]);
    }
  });

  it("describe the server: the issuer, the endpoints, the consent page on the web host", async () => {
    const r = await call(`${API}/.well-known/oauth-authorization-server`);
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get("access-control-allow-origin")).toBe("*");
    expect(JSON.parse(r.text)).toEqual({
      issuer: API,
      authorization_endpoint: `${WEB}/oauth/authorize`,
      token_endpoint: `${API}/oauth/token`,
      revocation_endpoint: `${API}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["RS256", "ES256"],
      revocation_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      revocation_endpoint_auth_signing_alg_values_supported: ["RS256", "ES256"],
      scopes_supported: ["board"],
    });
  });

  it("use one origin for everything on a single hostname", async () => {
    const r = await call("http://localhost:8787/.well-known/oauth-authorization-server");
    expect(JSON.parse(r.text)).toMatchObject({
      issuer: "http://localhost:8787",
      authorization_endpoint: "http://localhost:8787/oauth/authorize",
      token_endpoint: "http://localhost:8787/oauth/token",
    });
    const prm = await call("http://localhost:8787/.well-known/oauth-protected-resource/mcp");
    expect(JSON.parse(prm.text)).toMatchObject({ resource: "http://localhost:8787/mcp", authorization_servers: ["http://localhost:8787"] });
  });

  it("answer a preflight, and only GET otherwise", async () => {
    const pre = await call(`${API}/.well-known/oauth-authorization-server`, { method: "OPTIONS" });
    expect(pre.res.status).toBe(204);
    expect(pre.res.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.res.headers.get("access-control-allow-methods")).toContain("POST");
    const post = await call(`${API}/.well-known/oauth-authorization-server`, { method: "POST", body: "{}" });
    expect(post.res.status).toBe(405);
  });
});

describe("the consent page and its two calls are the web host's alone", () => {
  it("serves /oauth/authorize from the assets on the web host and a plain 404 on the API host", async () => {
    const web = await call(`${WEB}/oauth/authorize?client_id=x`);
    expect(web.assetPaths).toEqual(["/oauth/authorize"]);
    const local = await call("http://localhost:8787/oauth/authorize");
    expect(local.assetPaths).toEqual(["/oauth/authorize"]);
    const api = await call(`${API}/oauth/authorize?client_id=x`);
    expect(api.res.status).toBe(404);
    expect(api.text).toContain("no such route");
    expect(api.assetPaths).toEqual([]);
    expect(api.calls).toEqual([]);
  });

  it("404s both calls on the API host without touching the board", async () => {
    for (const path of ["/api/web/oauth/request", "/api/web/oauth/decide"]) {
      const r = await call(`${API}${path}`, json({ ...cookie, origin: API }, {}));
      expect(r.res.status, path).toBe(404);
      expect(r.calls, path).toEqual([]);
    }
  });

  it("answers the token and revoke routes on the API host (and on a single hostname), not the metadata routes' neighbors", async () => {
    for (const base of [API, "http://localhost:8787"]) {
      const token = await call(`${base}/oauth/token`, form("grant_type=refresh_token"));
      expect(token.calls.map((c) => c.method), base).toEqual(["oauthToken"]);
      const revoke = await call(`${base}/oauth/revoke`, form("token=x&client_id=y"));
      expect(revoke.calls.map((c) => c.method), base).toEqual(["oauthRevoke"]);
    }
    // Other paths on the API host stay 404.
    for (const path of ["/oauth", "/oauth/", "/oauth/register", "/.well-known/openid-configuration", "/.well-known/oauth-protected-resource/other"]) {
      expect((await call(`${API}${path}`)).res.status, path).toBe(404);
    }
  });
});

describe("POST /oauth/token", () => {
  const body = "grant_type=authorization_code&code=c1&code_verifier=v1&client_id=https%3A%2F%2Fclient.example%2Foauth%2Fclient.json&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&resource=https%3A%2F%2Fapi.example.com%2Fmcp";

  it("passes the form to the board with this board's /mcp as the resource, and answers with no-store and CORS", async () => {
    const r = await call(`${API}/oauth/token`, form(body, { "cf-connecting-ip": "203.0.113.4" }));
    expect(r.res.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ access_token: "at", refresh_token: "rt", token_type: "Bearer", expires_in: 3600, scope: "board" });
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.res.headers.get("pragma")).toBe("no-cache");
    expect(r.res.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.calls[0]?.args[0]).toMatchObject({
      params: { grant_type: "authorization_code", code: "c1", code_verifier: "v1", client_id: CLIENT, redirect_uri: REDIRECT, resource: `${API}/mcp` },
      resource: `${API}/mcp`,
      // An assertion's `aud` may name the issuer or the token endpoint.
      audiences: [API, `${API}/oauth/token`],
      keysRefetched: false,
      source: "ip:203.0.113.4",
    });
  });

  it("passes the assertion fields through, unread", async () => {
    const r = await call(`${API}/oauth/token`, form(`${body}&client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer&client_assertion=a.b.c`));
    expect(r.res.status).toBe(200);
    expect(r.calls[0]?.args[0]).toMatchObject({
      params: { client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: "a.b.c" },
    });
  });

  it("asks once more after fetching the key set again when the board names a rotated key", async () => {
    const keys = { keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y", kid: "new" }] };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(keys), { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);
    const e = makeEnv();
    let n = 0;
    e.results.oauthToken = () => (++n === 1 ? { ok: false, error: "invalid_client", description: "x", refetchKeys: CLIENT } : e.okToken);
    e.results.oauthClaimKeyRefetch = "https://client.example/oauth/jwks.json";
    const r = await call(`${API}/oauth/token`, form(body), e);
    expect(r.res.status).toBe(200);
    expect(r.calls.map((c) => c.method)).toEqual(["oauthToken", "oauthClaimKeyRefetch", "oauthStoreKeys", "oauthToken"]);
    expect(r.calls[0]?.args[0]).toMatchObject({ keysRefetched: false });
    expect(r.calls[3]?.args[0]).toMatchObject({ keysRefetched: true });
    expect(r.calls[1]?.args[0]).toBe(CLIENT);
    expect(r.calls[2]?.args.slice(0, 2)).toEqual([CLIENT, keys]);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect((fetchFn.mock.calls[0] as unknown as [string])[0]).toBe("https://client.example/oauth/jwks.json");
  });

  it("does not fetch when the board refuses the claim (too soon), and still asks the second time, which is the verdict", async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const e = makeEnv();
    e.results.oauthToken = (info: { keysRefetched: boolean }) =>
      info.keysRefetched
        ? { ok: false, error: "invalid_client", description: "client authentication failed" }
        : { ok: false, error: "invalid_client", description: "x", refetchKeys: CLIENT };
    e.results.oauthClaimKeyRefetch = null;
    const r = await call(`${API}/oauth/token`, form(body), e);
    expect(r.res.status).toBe(401);
    expect(r.calls.map((c) => c.method)).toEqual(["oauthToken", "oauthClaimKeyRefetch", "oauthToken"]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not store a key set that could not be fetched, and never asks a third time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const e = makeEnv();
    e.results.oauthToken = { ok: false, error: "invalid_client", description: "x", refetchKeys: CLIENT };
    e.results.oauthClaimKeyRefetch = "https://client.example/oauth/jwks.json";
    const r = await call(`${API}/oauth/token`, form(body), e);
    expect(r.res.status).toBe(401);
    expect(r.calls.map((c) => c.method)).toEqual(["oauthToken", "oauthClaimKeyRefetch", "oauthToken"]);
  });

  it("reads no cookie and no Authorization header: the host never signs a person in here", async () => {
    const r = await call(`${API}/oauth/token`, form(body, { ...cookie, authorization: "Bearer x" }));
    expect(r.calls.map((c) => c.method)).toEqual(["oauthToken"]);
  });

  it("maps the board's refusals to OAuth errors", async () => {
    const cases: [Record<string, unknown>, number][] = [
      [{ ok: false, error: "invalid_grant", description: "that code is not valid" }, 400],
      [{ ok: false, error: "invalid_request", description: "x" }, 400],
      [{ ok: false, error: "invalid_client", description: "x" }, 401],
      [{ ok: false, error: "temporarily_unavailable", description: "x", retryAfterMs: 12_000 }, 429],
    ];
    for (const [result, status] of cases) {
      const e = makeEnv();
      e.results.oauthToken = result;
      const r = await call(`${API}/oauth/token`, form(body), e);
      expect(r.res.status).toBe(status);
      expect(JSON.parse(r.text)).toEqual({ error: result.error, error_description: result.description });
      expect(r.res.headers.get("cache-control")).toBe("no-store");
      expect(r.res.headers.get("access-control-allow-origin")).toBe("*");
      if (status === 429) expect(r.res.headers.get("retry-after")).toBe("12");
    }
  });

  it("takes POST only, answers a preflight, and caps the body", async () => {
    expect((await call(`${API}/oauth/token`)).res.status).toBe(400);
    const pre = await call(`${API}/oauth/token`, { method: "OPTIONS" });
    expect(pre.res.status).toBe(204);
    expect(pre.res.headers.get("access-control-allow-origin")).toBe("*");
    const big = await call(`${API}/oauth/token`, form(`code=${"a".repeat(20_000)}`));
    expect(big.res.status).toBe(400);
    expect(JSON.parse(big.text).error).toBe("invalid_request");
    expect(big.calls).toEqual([]);
  });
});

describe("POST /oauth/revoke", () => {
  it("passes the token and client to the board, and answers 200 with no body", async () => {
    const r = await call(`${API}/oauth/revoke`, form("token=bbsat_x&client_id=https%3A%2F%2Fclient.example%2Foauth%2Fclient.json"));
    expect(r.res.status).toBe(200);
    expect(r.text).toBe("");
    expect(r.res.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.calls[0]?.args[0]).toMatchObject({
      token: "bbsat_x",
      clientId: CLIENT,
      // A revoke assertion may also name the revocation endpoint.
      audiences: [API, `${API}/oauth/token`, `${API}/oauth/revoke`],
    });
  });

  it("passes the assertion fields through, unread", async () => {
    const r = await call(`${API}/oauth/revoke`, form("token=bbsat_x&client_assertion_type=t&client_assertion=a.b.c"));
    expect(r.calls[0]?.args[0]).toMatchObject({ token: "bbsat_x", clientAssertionType: "t", clientAssertion: "a.b.c" });
  });

  it("maps a refusal to an OAuth error", async () => {
    const e = makeEnv();
    e.results.oauthRevoke = { ok: false, error: "invalid_client", description: "that token belongs to another client" };
    const r = await call(`${API}/oauth/revoke`, form("token=a&client_id=b"), e);
    expect(r.res.status).toBe(401);
    expect(JSON.parse(r.text).error).toBe("invalid_client");
  });
});

describe("POST /api/web/oauth/request and /decide", () => {
  const origin = { origin: WEB };
  const authorize = {
    response_type: "code",
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
    resource: `${API}/mcp`,
    state: "s1",
  };

  it("needs a same-origin POST with the session cookie, and refuses everything else before the board", async () => {
    for (const path of ["/api/web/oauth/request", "/api/web/oauth/decide"]) {
      expect((await call(`${WEB}${path}`, { method: "GET", headers: { ...cookie, ...origin } })).res.status, path).toBe(405);
      const crossSite = await call(`${WEB}${path}`, json({ ...cookie, origin: "https://evil.example" }, authorize));
      expect(crossSite.res.status, path).toBe(403);
      expect(crossSite.calls, path).toEqual([]);
      const noCookie = await call(`${WEB}${path}`, json(origin, authorize));
      expect(noCookie.res.status, path).toBe(401);
      expect(noCookie.calls, path).toEqual([]);
      // A bearer token is no substitute.
      const bearer = await call(`${WEB}${path}`, json({ ...origin, authorization: "Bearer bbs_x" }, authorize));
      expect(bearer.res.status, path).toBe(401);
      expect(bearer.calls, path).toEqual([]);
    }
  });

  it("signs in by the cookie, fetches the client's document, and asks the board with only the fields it reads", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ client_id: CLIENT, redirect_uris: [REDIRECT] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);
    const r = await call(
      `${WEB}/api/web/oauth/request`,
      json({ ...cookie, ...origin }, { ...authorize, resource_expected: "https://evil.example/mcp", client_doc: { client_id: CLIENT, redirect_uris: ["https://evil.example/cb"] }, allow_loopback_client: true, extra: 1 }),
    );
    expect(r.res.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({ ok: true, value: { status: "consent", request_id: "rq" } });
    expect(r.calls.map((c) => c.method)).toEqual(["authenticateWebSession", "oauthClientFresh", "oauthRequest"]);
    expect(r.calls[0]?.args[0]).toBe("abc");
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CLIENT);
    expect(init.redirect).toBe("manual");
    const [ctx, params] = r.calls[2]?.args as [Record<string, unknown>, Record<string, unknown>];
    expect(ctx).toMatchObject({ handle: "owner", via: "web", webSession: "ws_1" });
    // The page cannot set what the board trusts: the fetched document and this board's /mcp win.
    expect(params).toEqual({
      ...authorize,
      resource_expected: `${API}/mcp`,
      client_doc: { client_id: CLIENT, redirect_uris: [REDIRECT] },
    });
  });

  it("fetches the key set of a client that signs its requests from its jwks_uri, and hands both to the board", async () => {
    const jwksUri = "https://client.example/oauth/jwks.json";
    const doc = { client_id: CLIENT, redirect_uris: [REDIRECT], token_endpoint_auth_method: "private_key_jwt", jwks_uri: jwksUri };
    const keys = { keys: [{ kty: "EC", crv: "P-256", x: "x", y: "y" }] };
    const fetchFn = vi.fn(async (url: string) => new Response(JSON.stringify(url === CLIENT ? doc : keys), { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);
    const r = await call(`${WEB}/api/web/oauth/request`, json({ ...cookie, ...origin }, authorize));
    expect(r.res.status).toBe(200);
    expect(fetchFn.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual([CLIENT, jwksUri]);
    expect(r.calls.at(-1)?.args[1]).toMatchObject({ client_doc: doc, client_jwks: keys });
  });

  it("refuses, audited, a client whose key set is on another host or cannot be fetched", async () => {
    for (const jwksUri of ["https://elsewhere.example/jwks.json", "https://client.example/jwks.json"]) {
      const doc = { client_id: CLIENT, redirect_uris: [REDIRECT], token_endpoint_auth_method: "private_key_jwt", jwks_uri: jwksUri };
      const fetchFn = vi.fn(async (url: string) =>
        url === CLIENT ? new Response(JSON.stringify(doc), { status: 200 }) : new Response("no", { status: 404 }),
      );
      vi.stubGlobal("fetch", fetchFn);
      const r = await call(`${WEB}/api/web/oauth/request`, json({ ...cookie, ...origin }, authorize));
      expect(r.res.status, jwksUri).toBe(400);
      expect(r.calls.map((c) => c.method), jwksUri).toEqual(["authenticateWebSession", "oauthClientFresh", "refuse"]);
      expect(r.calls[2]?.args[2], jwksUri).toContain("key set could not be used");
      // Only the document is fetched for another host; the other host is never contacted.
      expect(fetchFn.mock.calls.length, jwksUri).toBe(jwksUri.includes("elsewhere") ? 1 : 2);
    }
  });

  it("skips the fetch when the board holds a fresh copy", async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    const e = makeEnv();
    e.results.oauthClientFresh = true;
    const r = await call(`${WEB}/api/web/oauth/request`, json({ ...cookie, ...origin }, authorize), e);
    expect(r.res.status).toBe(200);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(r.calls[2]?.args[1]).not.toHaveProperty("client_doc");
  });

  it("refuses, audited, a client whose document cannot be fetched, without asking the board for a request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } })));
    const r = await call(`${WEB}/api/web/oauth/request`, json({ ...cookie, ...origin }, authorize));
    expect(r.res.status).toBe(400);
    expect(JSON.parse(r.text)).toEqual({ ok: false, error: { code: "bad_request", message: "refused" } });
    expect(r.calls.map((c) => c.method)).toEqual(["authenticateWebSession", "oauthClientFresh", "refuse"]);
    expect(r.calls[2]?.args[2]).toContain("redirects are not followed");
  });

  it("never fetches a client id the host rules refuse", async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    for (const id of ["http://client.example/id.json", "https://127.0.0.1/id.json", "https://localhost/id.json", "https://intranet/id.json"]) {
      const r = await call(`${WEB}/api/web/oauth/request`, json({ ...cookie, ...origin }, { ...authorize, client_id: id }));
      expect(r.res.status, String(id)).toBe(400);
      expect(r.calls.map((c) => c.method).includes("oauthRequest"), String(id)).toBe(false);
    }
    // No usable client_id at all: nothing to fetch, and the board refuses the request itself.
    for (const id of ["", 7]) {
      const r = await call(`${WEB}/api/web/oauth/request`, json({ ...cookie, ...origin }, { ...authorize, client_id: id }));
      expect(r.calls.map((c) => c.method), String(id)).toEqual(["authenticateWebSession", "oauthRequest"]);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("allows a local client address only with the test flag on a loopback host", async () => {
    const local = "http://127.0.0.1:5555/client.json";
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ client_id: local, redirect_uris: ["http://127.0.0.1/cb"] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);
    const body = { ...authorize, client_id: local, redirect_uri: "http://127.0.0.1:6000/cb" };
    const on = await call("http://127.0.0.1:8787/api/web/oauth/request", json({ cookie: "bbs-session=abc", origin: "http://127.0.0.1:8787" }, body), makeEnv({ BBS_TEST_OAUTH_LOOPBACK_CLIENTS: "1" }));
    expect(on.res.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(on.calls.at(-1)?.args[1]).toMatchObject({ allow_loopback_client: true });
    // Without the flag, or with it on a deployed hostname, no.
    for (const [url, e] of [
      ["http://127.0.0.1:8787/api/web/oauth/request", makeEnv()],
      [`${WEB}/api/web/oauth/request`, makeEnv({ BBS_TEST_OAUTH_LOOPBACK_CLIENTS: "1" })],
    ] as const) {
      fetchFn.mockClear();
      const origin2 = new URL(url).origin;
      const cookie2 = url.startsWith("https") ? cookie : { cookie: "bbs-session=abc" };
      const r = await call(url, json({ ...cookie2, origin: origin2 }, body), e);
      expect(r.res.status, url).toBe(400);
      expect(fetchFn, url).not.toHaveBeenCalled();
    }
  });

  it("turns a failure after the redirect is known into a redirect back to the client", async () => {
    const e = makeEnv();
    e.results.oauthClientFresh = true;
    e.results.oauthRequest = {
      ok: true,
      value: { status: "redirect_error", error: "invalid_target", error_description: "resource must be this board's /mcp address", redirect_uri: REDIRECT, state: "s1" },
      notifications: [],
      auditSeq: 1,
    };
    const r = await call(`${WEB}/api/web/oauth/request`, json({ ...cookie, ...origin }, authorize), e);
    expect(JSON.parse(r.text)).toEqual({
      ok: true,
      value: {
        status: "redirect",
        redirect_to: `${REDIRECT}?error=invalid_target&error_description=resource+must+be+this+board%27s+%2Fmcp+address&state=s1&iss=${encodeURIComponent(API)}`,
      },
    });
  });

  it("passes the board's refusals on with their status", async () => {
    const e = makeEnv();
    e.results.oauthClientFresh = true;
    for (const [code, status] of [["bad_request", 400], ["forbidden", 403], ["rate_limited", 429], ["not_found", 404], ["conflict", 409]] as const) {
      e.results.oauthRequest = { ok: false, error: { code, message: "no" }, result: "denied", auditSeq: 1, notifications: [] };
      const r = await call(`${WEB}/api/web/oauth/request`, json({ ...cookie, ...origin }, authorize), e);
      expect(r.res.status, code).toBe(status);
      expect(JSON.parse(r.text)).toEqual({ ok: false, error: { code, message: "no" } });
    }
  });

  it("decide: an approval answers with the redirect (code, state, iss) and the grant; a denial with access_denied", async () => {
    const approved = await call(`${WEB}/api/web/oauth/decide`, json({ ...cookie, ...origin }, { request_id: "rq", approve: true, handle: "claude-ai", redirect_uri: "https://evil.example/", code: "x" }));
    expect(approved.res.status).toBe(200);
    expect(JSON.parse(approved.text)).toEqual({
      ok: true,
      value: {
        approved: true,
        redirect_to: `${REDIRECT}?code=the-code&state=s1&iss=${encodeURIComponent(API)}`,
        grant: "og_1",
        handle: "claude-ai",
        created: true,
      },
    });
    // Only what the page may say reaches the board.
    expect(approved.calls.at(-1)?.args[1]).toEqual({ request_id: "rq", approve: true, handle: "claude-ai" });

    const e = makeEnv();
    e.results.oauthDecide = { ok: true, value: { approved: false, redirect_uri: REDIRECT, state: "s1" }, notifications: [], auditSeq: 3 };
    const denied = await call(`${WEB}/api/web/oauth/decide`, json({ ...cookie, ...origin }, { request_id: "rq", approve: false }), e);
    expect(JSON.parse(denied.text)).toEqual({
      ok: true,
      value: { approved: false, redirect_to: `${REDIRECT}?error=access_denied&state=s1&iss=${encodeURIComponent(API)}` },
    });
  });

  it("decide: a refusal (not the admin, not pending) is an error with the board's status and no redirect", async () => {
    const e = makeEnv();
    e.results.oauthDecide = { ok: false, error: { code: "forbidden", message: "only a human admin can approve a connector" }, result: "denied", auditSeq: 4, notifications: [] };
    const r = await call(`${WEB}/api/web/oauth/decide`, json({ ...cookie, ...origin }, { request_id: "rq", approve: true, handle: "x" }), e);
    expect(r.res.status).toBe(403);
    expect(JSON.parse(r.text)).toEqual({ ok: false, error: { code: "forbidden", message: "only a human admin can approve a connector" } });
  });

  it("a refused cookie is refused with the sign-in guards' answer", async () => {
    const e = makeEnv();
    e.results.authenticateWebSession = { ok: false, reason: "expired_session", auditSeq: 1 };
    const r = await call(`${WEB}/api/web/oauth/request`, json({ ...cookie, ...origin }, authorize), e);
    expect(r.res.status).toBe(401);
    expect(r.calls.map((c) => c.method)).toEqual(["authenticateWebSession"]);
    expect(r.res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
