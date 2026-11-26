// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// M5: the Worker serves the web view at / as static files (design §12),
// with a strict Content-Security-Policy and nothing from another origin,
// while /api, /mcp and /health still reach the Worker. The page in a real
// browser is checked by scripts/web-check.mjs (screenshots go to the ignored .web-check/ directory).

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, groupAlive, makeRunDir, startWrangler, webSignIn, type RunDir, type Server } from "./harness.ts";

let run: RunDir;
let server: Server;

beforeAll(async () => {
  run = makeRunDir();
  server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
});

afterAll(async () => {
  await server?.stop();
  if (server) expect(groupAlive(server.pid)).toBe(false);
  run?.cleanup();
});

async function get(
  path: string,
): Promise<{ status: number; type: string; csp: string | null; nosniff: string | null; text: string; headers: Headers }> {
  const res = await fetch(`${server.url}${path}`);
  return {
    headers: res.headers,
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    csp: res.headers.get("content-security-policy"),
    nosniff: res.headers.get("x-content-type-options"),
    text: await res.text(),
  };
}

/**
 * Every security header `_headers` sets, each directive checked on its own
 * (F review E01: dropping frame-ancestors and X-Frame-Options went unnoticed).
 */
function expectSecurityHeaders(h: Headers, path: string): void {
  const csp = (h.get("content-security-policy") ?? "").split(";").map((d) => d.trim());
  expect(csp, path).toEqual([
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ]);
  expect(h.get("x-content-type-options"), path).toBe("nosniff");
  expect(h.get("referrer-policy"), path).toBe("no-referrer");
  expect(h.get("x-frame-options"), path).toBe("DENY");
}

describe("web view at /", () => {
  it("serves the page with a same-origin-only Content-Security-Policy", async () => {
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.type).toMatch(/^text\/html/);
    expect(page.text).toContain('<script type="module" src="/app.js"></script>');
    expect(page.csp).toContain("default-src 'none'");
    expect(page.csp).toContain("script-src 'self'");
    expect(page.csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
    expect(page.nosniff).toBe("nosniff");
    expectSecurityHeaders(page.headers, "/");
  });

  it("serves the script, renderer and style sheet, none of them loading anything from elsewhere", async () => {
    for (const [path, type] of [
      ["/app.js", /javascript/],
      ["/render.js", /javascript/],
      ["/style.css", /^text\/css/],
    ] as const) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(r.type, path).toMatch(type);
      // The headers apply to every static file, not only the page (review n6).
      expect(r.csp, path).toContain("default-src 'none'");
      expect(r.nosniff, path).toBe("nosniff");
      expectSecurityHeaders(r.headers, path);
      expect(r.text, path).not.toMatch(/https?:\/\//);
      // Code only: the comments name these on purpose, to say they are not used.
      const code = r.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, path).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage/);
    }
  });

  it("does not serve the headers file itself, and leaves /health, /api and unknown paths to the Worker", async () => {
    const headers = await get("/_headers");
    expect(headers.text).not.toContain("Content-Security-Policy");
    expect((await get("/health")).text).toContain('"service":"bbs-5000"');
    const web = await webSignIn(server.url, run.humanToken);
    const topics = await api(server.url, undefined, "bbs_topics", {}, web.headers);
    expect(topics.status).toBe(200);
    const missing = await get("/nope");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("no such route");
  });
});

describe("web sign-in by pairing code (issue #47)", () => {
  const asCli = { "x-bbs-client": "cli" };

  it("signs a browser in through start, a CLI approval and a claim, and the cookie is the only credential", async () => {
    const origin = new URL(server.url).origin;
    const post = (path: string, body: unknown, headers: Record<string, string> = { origin }) =>
      fetch(`${server.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

    const started = (await (await post("/api/web/pair/start", {})).json()) as any;
    expect(started.value.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const secret = started.value.poll_secret as string;
    const pending = (await (await post("/api/web/pair/claim", { poll_secret: secret })).json()) as any;
    expect(pending.value.status).toBe("pending");

    // The person looks the code up and approves it, as `bbs web-login` does.
    const shown = await api(server.url, run.humanToken, "bbs_web_pairing_show", { code: started.value.code.toLowerCase() }, asCli);
    expect(shown.body.value.label).toMatch(/\S/);
    expect((await api(server.url, run.humanToken, "bbs_web_pairing_approve", { code: started.value.code }, asCli)).status).toBe(200);

    const claimed = await post("/api/web/pair/claim", { poll_secret: secret });
    const setCookie = claimed.headers.get("set-cookie") ?? "";
    const body = JSON.stringify(await claimed.json());
    // Plain http on localhost: the non-prefixed name and no Secure; always HttpOnly, SameSite=Strict, Path=/, 30 days.
    expect(setCookie).toMatch(/^bbs-session=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Strict$/);
    expect(body).not.toContain(setCookie.split(";")[0]!.split("=")[1]!);
    expect(JSON.parse(body)).toEqual({ ok: true, value: { status: "approved", handle: "owner" } });
    const cookie = setCookie.split(";")[0]!;

    // The pairing is spent.
    expect((await post("/api/web/pair/claim", { poll_secret: secret })).status).toBe(401);

    const who = await api(server.url, undefined, "bbs_whoami", {}, { cookie, origin });
    expect(who.body.value).toMatchObject({ handle: "owner", kind: "human", via: "web" });
    // A cookie call must be a same-origin POST, or it is refused without acting.
    expect((await api(server.url, undefined, "bbs_whoami", {}, { cookie })).status).toBe(403);
    expect((await api(server.url, undefined, "bbs_whoami", {}, { cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(`${server.url}/api/bbs_whoami`, { headers: { cookie, origin } })).status).toBe(403);
    // A pairing approved from the web, or by a bearer token claiming to be the web view, is refused.
    expect((await api(server.url, undefined, "bbs_web_pairing_approve", { code: "AAAA-AAAA" }, { cookie, origin })).status).toBe(403);
    expect((await api(server.url, run.humanToken, "bbs_web_pairing_approve", { code: "AAAA-AAAA" }, { "x-bbs-client": "web" })).status).toBe(403);
  });

  it("the signed-in check answers 200 either way, and a signed-out probe writes no audit row", async () => {
    const origin = new URL(server.url).origin;
    const probe = (headers: Record<string, string>) =>
      fetch(`${server.url}/api/web/session`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    const lastSeq = async () => (await api(server.url, run.humanToken, "bbs_audit", { tail: true, limit: 1 }, { "x-bbs-client": "cli" })).body.value.events[0].seq;
    const before = await lastSeq();
    for (let i = 0; i < 3; i++) {
      const r = await probe({ origin });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, value: { signed_in: false } });
    }
    const after = await lastSeq();
    // Only the audit read itself (one row per read) separates the two reads.
    expect(after - before).toBe(1);
    const web = await webSignIn(server.url, run.humanToken);
    expect(await (await probe(web.headers)).json()).toEqual({ ok: true, value: { signed_in: true } });
    expect((await probe({ cookie: "bbs-session=bogus", origin })).status).toBe(200);
    expect((await probe({})).status).toBe(403);
  });

  it("lists, signs out and revokes sessions; a signed-out cookie stops working", async () => {
    const a = await webSignIn(server.url, run.humanToken);
    const b = await webSignIn(server.url, run.humanToken);
    const listed = await api(server.url, undefined, "bbs_web_sessions", {}, a.headers);
    const mine = listed.body.value.sessions.filter((s: any) => s.current);
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(a.cookie.split("=")[1]);

    const out = await fetch(`${server.url}/api/bbs_web_sign_out`, { method: "POST", headers: { ...a.headers, "content-type": "application/json" }, body: "{}" });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/^bbs-session=; Max-Age=0; Path=\//);
    expect((await api(server.url, undefined, "bbs_whoami", {}, a.headers)).status).toBe(401);
    expect((await api(server.url, undefined, "bbs_whoami", {}, b.headers)).status).toBe(200);

    const id = (await api(server.url, run.humanToken, "bbs_web_sessions", {}, asCli)).body.value.sessions.at(-1).id;
    expect((await api(server.url, run.humanToken, "bbs_web_session_revoke", { id }, asCli)).status).toBe(200);
    expect((await api(server.url, undefined, "bbs_whoami", {}, b.headers)).status).toBe(401);
  });

  it("an agent cannot approve, and the approve tool is not offered on /mcp", async () => {
    const agent = await api(server.url, run.humanToken, "bbs_admin_user_add", { handle: "probe" }, asCli);
    const token = agent.body.value.token as string;
    expect((await api(server.url, token, "bbs_web_pairing_approve", { code: "AAAA-AAAA" })).status).toBe(403);
    const mcp = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(await mcp.text()).not.toContain("bbs_web_pairing");
  });
});
