// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// The Worker's side of web sign-in by pairing code (issue #47), through its
// fetch handler with the Board DO faked: the cookie's name and attributes, the
// same-origin rule for cookie calls, the API host ignoring cookies, and the
// pairing endpoints being the web host's alone.

import { describe, expect, it, vi } from "vitest";
import { readCookie, sessionClearCookie, sessionSetCookie, summarizeUserAgent } from "../src/http.ts";

vi.mock("../src/board-do.ts", () => ({
  BoardDO: class {},
  WS_HANDLE_HEADER: "x-h",
  WS_REQUEST_HEADER: "x-r",
  WS_TOKEN_HASH_HEADER: "x-t",
}));
vi.mock("agents/mcp/server", () => ({ createMcpHandler: () => () => new Response("mcp") }));

const { default: worker } = await import("../src/index.ts");

const exec = {} as ExecutionContext;

function makeEnv() {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    };
  const toolResult = { isError: false, content: [], structuredContent: { signed_out: true } };
  const stub = {
    authenticate: record("authenticate", { ok: false, reason: "missing_token", auditSeq: 1 }),
    authenticateWebSession: record("authenticateWebSession", { ok: true, handle: "owner", kind: "human", webSession: "ws_1" }),
    callTool: record("callTool", toolResult),
    webPairStart: record("webPairStart", {
      ok: true,
      value: { code: "ABCD-2345", poll_secret: "secret", expires_in_ms: 300_000 },
      notifications: [],
      auditSeq: 1,
    }),
    webPairClaim: record("webPairClaim", {
      ok: true,
      value: { status: "approved", session: "cookie-value", id: "ws_1", handle: "owner", max_age_ms: 30 * 24 * 60 * 60_000 },
      notifications: [],
      auditSeq: 2,
    }),
  };
  const env = {
    BOARD: { idFromName: () => "id", get: () => stub },
    ASSETS: { fetch: async () => new Response("asset") },
  };
  return { env: env as never, calls, stub };
}

async function call(url: string, init: RequestInit = {}, env = makeEnv()) {
  const res = await worker.fetch(new Request(url, init), env.env, exec);
  return { res, text: await res.text(), calls: env.calls };
}

const WEB = "https://app.example.com";
const API = "https://api.example.com";
const post = (headers: Record<string, string>, body = "{}"): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body });

describe("cookie helpers", () => {
  it("name the cookie by scheme and set the attributes", () => {
    expect(sessionSetCookie("v", true, 2592000)).toBe("__Host-bbs-session=v; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict; Secure");
    expect(sessionSetCookie("v", false, 2592000)).toBe("bbs-session=v; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict");
    expect(sessionClearCookie(true)).toContain("Max-Age=0");
    expect(sessionClearCookie(true)).toContain("__Host-bbs-session=;");
  });

  it("reads one cookie from a header", () => {
    expect(readCookie("a=1; bbs-session=xyz; b=2", "bbs-session")).toBe("xyz");
    expect(readCookie("a=1", "bbs-session")).toBeUndefined();
    expect(readCookie("bbs-session=", "bbs-session")).toBeUndefined();
    expect(readCookie(null, "bbs-session")).toBeUndefined();
  });

  it("summarizes a User-Agent as a browser and system", () => {
    expect(summarizeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")).toBe("Chrome on macOS");
    expect(summarizeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
    expect(summarizeUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0")).toBe("Firefox on Linux");
    expect(summarizeUserAgent(null)).toBe("unknown browser");
  });
});

describe("cookie calls on the web host", () => {
  const cookie = { cookie: "__Host-bbs-session=abc" };

  it("sign in a same-origin POST, as via web", async () => {
    const r = await call(`${WEB}/api/bbs_whoami`, post({ ...cookie, origin: WEB }));
    expect(r.calls.map((c) => c.method)).toEqual(["authenticateWebSession", "callTool"]);
    expect(r.calls[0]?.args[0]).toBe("abc");
    expect(r.calls[1]?.args[0]).toMatchObject({ handle: "owner", via: "web", webSession: "ws_1" });
    expect(r.res.status).toBe(200);
  });

  it("are refused without acting when the Origin is missing or another site's", async () => {
    for (const headers of [cookie, { ...cookie, origin: "https://evil.example" }, { ...cookie, origin: "null" }]) {
      const r = await call(`${WEB}/api/bbs_post`, post(headers, '{"topic":"Lobby","body":"x"}'));
      expect(r.res.status).toBe(403);
      expect(r.text).toContain("cross-site request refused");
      expect(r.calls).toEqual([]);
    }
    const get = await call(`${WEB}/api/bbs_whoami`, { method: "GET", headers: { ...cookie, origin: WEB } });
    expect(get.res.status).toBe(403);
    expect(get.calls).toEqual([]);
  });

  it("lose to a bearer token: an Authorization header means the cookie is not used", async () => {
    const r = await call(`${WEB}/api/bbs_whoami`, post({ ...cookie, authorization: "Bearer bbs_token", origin: WEB }));
    expect(r.calls.map((c) => c.method)).toEqual(["authenticate"]);
  });

  it("use the plain name over http (localhost under wrangler dev), and not the __Host- one", async () => {
    const plain = await call("http://localhost:8787/api/bbs_whoami", post({ cookie: "bbs-session=abc", origin: "http://localhost:8787" }));
    expect(plain.calls[0]?.method).toBe("authenticateWebSession");
    const prefixed = await call("http://localhost:8787/api/bbs_whoami", post({ cookie: "__Host-bbs-session=abc", origin: "http://localhost:8787" }));
    expect(prefixed.calls[0]?.method).toBe("authenticate");
  });

  it("a renewing call also carries the cookie again, same value, with the board's lifetime; others carry none", async () => {
    const env = makeEnv();
    env.stub.authenticateWebSession = async () =>
      ({ ok: true, handle: "owner", kind: "human", webSession: "ws_1", renewed: true, maxAgeMs: 7 * 86_400_000 }) as never;
    const renewed = await call(`${WEB}/api/bbs_whoami`, post({ ...cookie, origin: WEB }), env);
    expect(renewed.res.headers.get("set-cookie")).toBe("__Host-bbs-session=abc; Max-Age=604800; Path=/; HttpOnly; SameSite=Strict; Secure");
    const plain = await call(`${WEB}/api/bbs_whoami`, post({ ...cookie, origin: WEB }));
    expect(plain.res.headers.get("set-cookie")).toBeNull();
  });

  it("a sign-out clears the cookie", async () => {
    const r = await call(`${WEB}/api/bbs_web_sign_out`, post({ ...cookie, origin: WEB }));
    expect(r.res.headers.get("set-cookie")).toBe(sessionClearCookie(true));
  });

  it("a refused session clears the stale cookie with the 401", async () => {
    const env = makeEnv();
    env.stub.authenticateWebSession = async () => ({ ok: false, reason: "expired_session", auditSeq: 3 }) as never;
    const r = await call(`${WEB}/api/bbs_whoami`, post({ ...cookie, origin: WEB }), env);
    expect(r.res.status).toBe(401);
    expect(r.res.headers.get("set-cookie")).toBe(sessionClearCookie(true));
  });
});

describe("the API host ignores cookies", () => {
  it("treats a cookie request there as having no credential", async () => {
    const r = await call(`${API}/api/bbs_whoami`, post({ cookie: "__Host-bbs-session=abc", origin: API }));
    expect(r.calls.map((c) => c.method)).toEqual(["authenticate"]);
    expect(r.calls[0]?.args[0]).toBeUndefined();
    expect(r.res.status).toBe(401);
  });

  it("has no pairing endpoints", async () => {
    for (const path of ["/api/web/pair/start", "/api/web/pair/claim"]) {
      const r = await call(`${API}${path}`, post({ origin: API }));
      expect(r.res.status, path).toBe(404);
      expect(r.calls, path).toEqual([]);
    }
  });
});

describe("pairing endpoints on the web host", () => {
  it("start returns the code and poll secret to a same-origin POST, and labels the browser", async () => {
    const r = await call(`${WEB}/api/web/pair/start`, post({ origin: WEB, "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36", "cf-connecting-ip": "203.0.113.9" }, ""));
    expect(r.res.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ ok: true, value: { code: "ABCD-2345", poll_secret: "secret", expires_in_ms: 300000 } });
    expect(r.calls[0]?.args[0]).toMatchObject({ source: "ip:203.0.113.9", label: "Chrome on Windows" });
  });

  it("start and claim refuse a request that is not a same-origin POST", async () => {
    for (const path of ["/api/web/pair/start", "/api/web/pair/claim"]) {
      expect((await call(`${WEB}${path}`, post({ origin: "https://evil.example" }))).res.status, path).toBe(403);
      expect((await call(`${WEB}${path}`, post({}))).res.status, path).toBe(403);
      expect((await call(`${WEB}${path}`, { method: "GET" })).res.status, path).toBe(405);
    }
  });

  it("claim sets the cookie (never in the body) with the right attributes over https", async () => {
    const r = await call(`${WEB}/api/web/pair/claim`, post({ origin: WEB }, '{"poll_secret":"secret"}'));
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get("set-cookie")).toBe("__Host-bbs-session=cookie-value; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict; Secure");
    expect(r.text).not.toContain("cookie-value");
    expect(JSON.parse(r.text)).toEqual({ ok: true, value: { status: "approved", handle: "owner" } });
    expect(r.calls[0]?.args[0]).toMatchObject({ pollSecret: "secret" });
  });

  it("claim over plain http sets bbs-session without Secure", async () => {
    const r = await call("http://localhost:8787/api/web/pair/claim", post({ origin: "http://localhost:8787" }, '{"poll_secret":"secret"}'));
    expect(r.res.headers.get("set-cookie")).toBe("bbs-session=cookie-value; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict");
  });

  it("claim passes a bad body on as a missing poll secret, to be refused and counted", async () => {
    const r = await call(`${WEB}/api/web/pair/claim`, post({ origin: WEB }, "not json"));
    expect(r.calls[0]?.args[0]).toMatchObject({ pollSecret: undefined });
    const big = await call(`${WEB}/api/web/pair/claim`, post({ origin: WEB }, "x".repeat(5000)));
    expect(big.res.status).toBe(413);
  });

  it("refusals map to 429 with Retry-After and 401", async () => {
    const env = makeEnv();
    env.stub.webPairStart = async () => ({ ok: false, error: { code: "rate_limited", message: "busy" }, result: "denied", auditSeq: undefined, notifications: [] }) as never;
    env.stub.webPairClaim = async () => ({ ok: false, error: { code: "unauthorized", message: "no" }, result: "denied", auditSeq: 1, notifications: [] }) as never;
    const start = await call(`${WEB}/api/web/pair/start`, post({ origin: WEB }), env);
    expect(start.res.status).toBe(429);
    expect(start.res.headers.get("retry-after")).toBe("60");
    const claim = await call(`${WEB}/api/web/pair/claim`, post({ origin: WEB }, '{"poll_secret":"x"}'), env);
    expect(claim.res.status).toBe(401);
  });
});

describe("POST /api/web/session (the page's signed-in check)", () => {
  const url = `${WEB}/api/web/session`;

  it("with no cookie answers signed_in false without calling the board", async () => {
    const r = await call(url, post({ origin: WEB }));
    expect(r.res.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ ok: true, value: { signed_in: false } });
    expect(r.calls).toEqual([]);
    expect(r.res.headers.get("set-cookie")).toBeNull();
  });

  it("with a valid cookie answers signed_in true, and a renewal sends the cookie again", async () => {
    const ok = await call(url, post({ cookie: "__Host-bbs-session=abc", origin: WEB }));
    expect(JSON.parse(ok.text)).toEqual({ ok: true, value: { signed_in: true } });
    expect(ok.calls.map((c) => c.method)).toEqual(["authenticateWebSession"]);
    expect(ok.res.headers.get("set-cookie")).toBeNull();
    const env = makeEnv();
    env.stub.authenticateWebSession = async () => ({ ok: true, handle: "owner", kind: "human", webSession: "ws_1", renewed: true, maxAgeMs: 2_592_000_000 }) as never;
    const renewed = await call(url, post({ cookie: "__Host-bbs-session=abc", origin: WEB }), env);
    expect(renewed.res.headers.get("set-cookie")).toContain("Max-Age=2592000");
  });

  it("with a refused cookie answers signed_in false and clears it; 429 when limited", async () => {
    const env = makeEnv();
    env.stub.authenticateWebSession = async () => ({ ok: false, reason: "unknown_session", auditSeq: 1 }) as never;
    const r = await call(url, post({ cookie: "__Host-bbs-session=abc", origin: WEB }), env);
    expect(r.res.status).toBe(200);
    expect(JSON.parse(r.text).value.signed_in).toBe(false);
    expect(r.res.headers.get("set-cookie")).toBe(sessionClearCookie(true));
    env.stub.authenticateWebSession = async () => ({ ok: false, reason: "rate_limited", auditSeq: undefined, retryAfterMs: 5000 }) as never;
    const limited = await call(url, post({ cookie: "__Host-bbs-session=abc", origin: WEB }), env);
    expect(limited.res.status).toBe(429);
    expect(limited.res.headers.get("retry-after")).toBe("5");
  });

  it("is 404 on the API host and 403 cross-site", async () => {
    expect((await call(`${API}/api/web/session`, post({ origin: API }))).res.status).toBe(404);
    for (const headers of [{}, { origin: "https://evil.example" }, { cookie: "__Host-bbs-session=abc" }]) {
      const r = await call(url, post(headers));
      expect(r.res.status).toBe(403);
      expect(r.calls).toEqual([]);
    }
  });
});
