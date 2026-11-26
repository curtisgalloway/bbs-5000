// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// The fetch of a client's metadata document (issue #55, design §9 step 3):
// https only, to a public hostname, no redirects, a timeout and a byte cap;
// and the test-only loopback allowance that a deployed board cannot switch on.

import { describe, expect, it, vi } from "vitest";
import { fetchClientDocument, fetchClientKeys, loopbackClientsAllowed } from "../src/oauth-client.ts";
import { apiOrigin, mcpChallenge, parseForm, redirectWith, webOrigin } from "../src/http.ts";

const CLIENT = "https://client.example/oauth/client.json";
const OPTS = { allowLoopback: false, timeoutMs: 5_000, maxBytes: 16 * 1024 };

function jsonResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("fetchClientDocument", () => {
  it("fetches the document with no redirects, a timeout signal and an accept header, and parses it", async () => {
    const fetchFn = vi.fn(async () => jsonResponse('{"client_id":"x"}'));
    const r = await fetchClientDocument(CLIENT, { ...OPTS, fetchFn });
    expect(r).toEqual({ ok: true, doc: { client_id: "x" } });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CLIENT);
    expect(init).toMatchObject({ method: "GET", redirect: "manual", headers: { accept: "application/json" } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["http://client.example/id.json", "https"],
    ["https://localhost/id.json", "localhost"],
    ["https://127.0.0.1/id.json", "address"],
    ["https://[::1]/id.json", "address"],
    ["https://192.0.2.5/id.json", "address"],
    ["https://intranet/id.json", "single-label"],
    ["https://client.example/", "path"],
    ["https://u:p@client.example/id.json", "credentials"],
    ["not a url", "https"],
  ])("never calls out for %s", async (id, why) => {
    const fetchFn = vi.fn(async () => jsonResponse("{}"));
    const r = await fetchClientDocument(id, { ...OPTS, fetchFn });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(why);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses a redirect instead of following it", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const fetchFn = vi.fn(async () => new Response(null, { status, headers: { location: "https://elsewhere.example/id.json" } }));
      const r = await fetchClientDocument(CLIENT, { ...OPTS, fetchFn });
      expect(r, String(status)).toEqual({ ok: false, reason: "it redirects, and redirects are not followed" });
      expect(fetchFn).toHaveBeenCalledOnce();
    }
  });

  it("refuses an error status and a document that is not JSON", async () => {
    expect(await fetchClientDocument(CLIENT, { ...OPTS, fetchFn: async () => new Response("no", { status: 404 }) })).toEqual({
      ok: false,
      reason: "it answered HTTP 404",
    });
    expect(await fetchClientDocument(CLIENT, { ...OPTS, fetchFn: async () => jsonResponse("<html>") })).toEqual({ ok: false, reason: "it is not JSON" });
  });

  it("stops at the byte cap, by the declared length or by counting what arrives", async () => {
    const big = "x".repeat(1_000);
    const declared = await fetchClientDocument(CLIENT, {
      ...OPTS,
      maxBytes: 100,
      fetchFn: async () => jsonResponse(big, { headers: { "content-length": "1000" } }),
    });
    expect(declared).toEqual({ ok: false, reason: "it is larger than 100 bytes" });
    // No usable content-length: the stream is counted and cut off.
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode("y".repeat(60)));
        if (pulled > 1_000) controller.close();
      },
    });
    const counted = await fetchClientDocument(CLIENT, { ...OPTS, maxBytes: 100, fetchFn: async () => new Response(stream, { status: 200 }) });
    expect(counted).toEqual({ ok: false, reason: "it is larger than 100 bytes" });
    expect(pulled).toBeLessThan(10);
    // Exactly at the cap is fine.
    const exact = JSON.stringify({ a: "b".repeat(90) });
    expect(await fetchClientDocument(CLIENT, { ...OPTS, maxBytes: exact.length, fetchFn: async () => jsonResponse(exact) })).toMatchObject({ ok: true });
  });

  it("gives up after the timeout, whether the answer or its body stalls", async () => {
    const stalls = (signal: AbortSignal | null | undefined) =>
      new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
    const slowAnswer = await fetchClientDocument(CLIENT, {
      ...OPTS,
      timeoutMs: 20,
      fetchFn: (async (_url: string, init?: RequestInit) => stalls(init?.signal)) as unknown as typeof fetch,
    });
    expect(slowAnswer).toEqual({ ok: false, reason: "it took too long to answer" });
    const slowBody = await fetchClientDocument(CLIENT, {
      ...OPTS,
      timeoutMs: 20,
      fetchFn: (async (_url: string, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"a":'));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        });
        return new Response(stream, { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(slowBody).toEqual({ ok: false, reason: "it took too long to answer" });
  });

  it("reports an unreachable host without leaking the error", async () => {
    const r = await fetchClientDocument(CLIENT, {
      ...OPTS,
      fetchFn: async () => {
        throw new TypeError("connect ECONNREFUSED 203.0.113.9:443");
      },
    });
    expect(r).toEqual({ ok: false, reason: "it could not be reached" });
  });
});

describe("fetchClientKeys (a client's key set, design §9 client authentication)", () => {
  const JWKS = "https://client.example/oauth/jwks.json";
  const KEYS_OPTS = { ...OPTS, maxBytes: 64 * 1024 };

  it("fetches the set from the client's own host under the document's rules", async () => {
    const fetchFn = vi.fn(async () => jsonResponse('{"keys":[]}'));
    expect(await fetchClientKeys(JWKS, CLIENT, { ...KEYS_OPTS, fetchFn })).toEqual({ ok: true, doc: { keys: [] } });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JWKS);
    expect(init).toMatchObject({ method: "GET", redirect: "manual", headers: { accept: "application/json" } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["https://other.example/jwks.json", "same host"],
    ["https://sub.client.example/jwks.json", "same host"],
    ["http://client.example/jwks.json", "https"],
    ["https://127.0.0.1/jwks.json", "address"],
    ["https://intranet/jwks.json", "single-label"],
    ["https://u:p@client.example/jwks.json", "credentials"],
    ["https://client.example/jwks.json#f", "fragment"],
    ["https://client.example/", "path"],
    ["not a url", "https"],
  ])("never calls out for %s", async (uri, why) => {
    const fetchFn = vi.fn(async () => jsonResponse("{}"));
    const r = await fetchClientKeys(uri, CLIENT, { ...KEYS_OPTS, fetchFn });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(why);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses a redirect, an error status and a body that is not JSON", async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/k" } }));
    expect(await fetchClientKeys(JWKS, CLIENT, { ...KEYS_OPTS, fetchFn: redirect })).toEqual({ ok: false, reason: "it redirects, and redirects are not followed" });
    expect(redirect).toHaveBeenCalledOnce();
    expect(await fetchClientKeys(JWKS, CLIENT, { ...KEYS_OPTS, fetchFn: async () => new Response("no", { status: 503 }) })).toEqual({ ok: false, reason: "it answered HTTP 503" });
    expect(await fetchClientKeys(JWKS, CLIENT, { ...KEYS_OPTS, fetchFn: async () => jsonResponse("<html>") })).toEqual({ ok: false, reason: "it is not JSON" });
  });

  it("stops at the byte cap and gives up after the timeout", async () => {
    const big = "x".repeat(2_000);
    expect(
      await fetchClientKeys(JWKS, CLIENT, { ...KEYS_OPTS, maxBytes: 100, fetchFn: async () => jsonResponse(big, { headers: { "content-length": "2000" } }) }),
    ).toEqual({ ok: false, reason: "it is larger than 100 bytes" });
    expect(await fetchClientKeys(JWKS, CLIENT, { ...KEYS_OPTS, maxBytes: 100, fetchFn: async () => jsonResponse(big) })).toEqual({
      ok: false,
      reason: "it is larger than 100 bytes",
    });
    const slow = await fetchClientKeys(JWKS, CLIENT, {
      ...KEYS_OPTS,
      timeoutMs: 20,
      fetchFn: (async (_url: string, init?: RequestInit) =>
        new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch,
    });
    expect(slow).toEqual({ ok: false, reason: "it took too long to answer" });
  });

  it("lets a local address through only with the test allowance, and only on the client's own host", async () => {
    const local = "http://127.0.0.1:5555/client.json";
    const localKeys = "http://127.0.0.1:5555/jwks.json";
    const fetchFn = vi.fn(async () => jsonResponse('{"keys":[]}'));
    expect((await fetchClientKeys(localKeys, local, { ...KEYS_OPTS, fetchFn })).ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await fetchClientKeys(localKeys, local, { ...KEYS_OPTS, allowLoopback: true, fetchFn })).toEqual({ ok: true, doc: { keys: [] } });
    // A client on localhost cannot point at another loopback name, nor an ordinary client at a local port.
    expect((await fetchClientKeys("http://localhost:5555/jwks.json", local, { ...KEYS_OPTS, allowLoopback: true, fetchFn })).ok).toBe(false);
    expect((await fetchClientKeys(localKeys, CLIENT, { ...KEYS_OPTS, allowLoopback: true, fetchFn })).ok).toBe(false);
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

describe("the test-only loopback allowance", () => {
  const local = "http://127.0.0.1:5555/client.json";

  it("needs the flag and a request that arrived on a loopback hostname", () => {
    expect(loopbackClientsAllowed("1", new URL("http://127.0.0.1:8787/api/web/oauth/request"))).toBe(true);
    expect(loopbackClientsAllowed("1", new URL("http://localhost:8787/api/web/oauth/request"))).toBe(true);
    expect(loopbackClientsAllowed(undefined, new URL("http://127.0.0.1:8787/"))).toBe(false);
    expect(loopbackClientsAllowed("0", new URL("http://127.0.0.1:8787/"))).toBe(false);
    expect(loopbackClientsAllowed("true", new URL("http://127.0.0.1:8787/"))).toBe(false);
    // A deployed board, reached by its own hostname, ignores the variable.
    for (const host of ["https://app.example.com/", "https://api.example.com/", "https://bbs.workers.dev/", "https://app.127.0.0.1.example.com/"]) {
      expect(loopbackClientsAllowed("1", new URL(host)), host).toBe(false);
    }
  });

  it("lets only a local address through, and only with the allowance", async () => {
    const fetchFn = vi.fn(async () => jsonResponse('{"ok":true}'));
    expect((await fetchClientDocument(local, { ...OPTS, fetchFn })).ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(await fetchClientDocument(local, { ...OPTS, allowLoopback: true, fetchFn })).toEqual({ ok: true, doc: { ok: true } });
    // The allowance is not a general one.
    const other = await fetchClientDocument("http://client.example/c.json", { ...OPTS, allowLoopback: true, fetchFn });
    expect(other.ok).toBe(false);
    const privateHost = await fetchClientDocument("http://192.0.2.5/c.json", { ...OPTS, allowLoopback: true, fetchFn });
    expect(privateHost.ok).toBe(false);
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

describe("origins, the challenge and forms", () => {
  it("derives the API and web origins from either hostname", () => {
    const api = new URL("https://api.example.com/oauth/token");
    const web = new URL("https://app.example.com:8443/api/web/oauth/request");
    const local = new URL("http://localhost:8787/mcp");
    expect(apiOrigin(api)).toBe("https://api.example.com");
    expect(apiOrigin(web)).toBe("https://api.example.com:8443");
    expect(apiOrigin(local)).toBe("http://localhost:8787");
    expect(webOrigin(api)).toBe("https://app.example.com");
    expect(webOrigin(web)).toBe("https://app.example.com:8443");
    expect(webOrigin(local)).toBe("http://localhost:8787");
    expect(apiOrigin(new URL("https://board.workers.dev/mcp"))).toBe("https://board.workers.dev");
  });

  it("names the resource's metadata and the scope in the challenge", () => {
    expect(mcpChallenge(new URL("https://api.example.com/mcp"))).toBe(
      'Bearer resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/mcp", scope="board"',
    );
    expect(mcpChallenge(new URL("https://app.example.com/mcp"))).toContain('resource_metadata="https://api.example.com/');
  });

  it("parses a form body and builds a redirect with extra parameters", () => {
    const f = parseForm("grant_type=authorization_code&code=a%2Bb&code=second&empty=");
    expect(f.get("grant_type")).toBe("authorization_code");
    expect(f.get("code")).toBe("a+b");
    expect(f.get("empty")).toBe("");
    expect(f.get("missing")).toBeUndefined();
    expect(redirectWith("https://c.example/cb?x=1", { code: "abc", state: undefined, iss: "https://api.example.com" })).toBe(
      "https://c.example/cb?x=1&code=abc&iss=https%3A%2F%2Fapi.example.com",
    );
  });
});
