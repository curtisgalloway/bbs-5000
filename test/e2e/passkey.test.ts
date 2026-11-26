// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// Passkey sign-in (issue #54) end to end under `wrangler dev`: the four web
// endpoints driven with a software authenticator (the test-side one the core
// tests use), registration from a pairing session, sign-in setting a working
// session cookie, the refusals, and the API host answering 404. The relying
// party id and origin are the Worker's own view of the request: `127.0.0.1` and
// the server's origin. A real browser authenticator is checked separately, by
// scripts/web-check.mjs where Chrome's virtual authenticator is available.

import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SoftwareAuthenticator, type Alg, type CeremonyOptions } from "../../packages/core/test/authenticator.ts";
import { api, groupAlive, makeRunDir, startWrangler, webSignIn, type RunDir, type Server } from "./harness.ts";

let run: RunDir;
let server: Server;
let origin: string;
let rpId: string;

const asCli = { "x-bbs-client": "cli" };

beforeAll(async () => {
  run = makeRunDir();
  server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
  origin = new URL(server.url).origin;
  rpId = new URL(server.url).hostname;
});

afterAll(async () => {
  await server?.stop();
  if (server) expect(groupAlive(server.pid)).toBe(false);
  run?.cleanup();
});

function post(path: string, body: unknown, headers: Record<string, string> = { origin }): Promise<Response> {
  return fetch(`${server.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

/** Register `auth` from a pairing session; returns the session the registration came from. */
async function register(auth: SoftwareAuthenticator, label = "E2E key") {
  const web = await webSignIn(server.url, run.humanToken);
  const started = await post("/api/web/passkey/register/start", {}, web.headers);
  expect(started.status).toBe(200);
  const options = ((await started.json()) as any).value;
  const credential = auth.register({ challenge: options.challenge, rpId, origin });
  const finished = await post("/api/web/passkey/register/finish", { credential, label }, web.headers);
  return { web, options, finished };
}

async function signIn(auth: SoftwareAuthenticator, tamper: Partial<CeremonyOptions> = {}) {
  const started = await post("/api/web/passkey/signin/start", {});
  expect(started.status).toBe(200);
  const options = ((await started.json()) as any).value;
  expect(options).toMatchObject({ rpId, allowCredentials: [], userVerification: "required" });
  const credential = await auth.assert({ challenge: options.challenge, rpId, origin, ...tamper });
  return post("/api/web/passkey/signin/finish", { credential });
}

describe.each<Alg>(["ES256", "RS256"])("passkey sign-in with %s over HTTP", (alg) => {
  it("registers from a pairing session and signs a new browser in; the session cookie works", async () => {
    const auth = await SoftwareAuthenticator.create(alg, { backupEligible: true, backupState: true });
    const { web, options, finished } = await register(auth, `E2E ${alg}`);
    expect(finished.status).toBe(200);
    expect(((await finished.json()) as any).value).toMatchObject({ label: `E2E ${alg}`, synced: true });
    expect(options.rp).toEqual({ id: rpId, name: "BBS-5000" });

    const listed = await api(server.url, undefined, "bbs_passkeys", {}, web.headers);
    expect(listed.status).toBe(200);
    expect(listed.body.value.passkeys.map((p: any) => [p.label, p.synced, p.algorithm])).toContainEqual([`E2E ${alg}`, true, alg]);
    expect(JSON.stringify(listed.body)).not.toContain(options.user.id);

    const res = await signIn(auth);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^bbs-session=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Strict$/);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain(setCookie.split(";")[0]!.split("=")[1]!);
    expect(JSON.parse(body)).toEqual({ ok: true, value: { status: "approved", handle: "owner" } });
    const cookie = setCookie.split(";")[0]!;

    const who = await api(server.url, undefined, "bbs_whoami", {}, { cookie, origin });
    expect(who.body.value).toMatchObject({ handle: "owner", kind: "human", via: "web" });

    // A session made by a passkey cannot register another one.
    const again = await post("/api/web/passkey/register/start", {}, { cookie, origin });
    expect(again.status).toBe(403);
    expect(JSON.stringify(await again.json())).toContain("sign in with a pairing code");
    const note = await api(server.url, undefined, "bbs_passkeys", {}, { cookie, origin });
    expect(note.body.value).toMatchObject({ can_register: false });
  });
});

describe("refusals and limits over HTTP", () => {
  it("refuse a tampered assertion with 401 and a replayed challenge, and keep the credential", async () => {
    const auth = await SoftwareAuthenticator.create("ES256");
    await register(auth);
    const bad = await signIn(auth, { corruptSignature: true });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify(await bad.json())).toContain("bad_signature");
    const wrongOrigin = await signIn(auth, { clientOrigin: "https://evil.example" });
    expect(wrongOrigin.status).toBe(401);

    const started = await post("/api/web/passkey/signin/start", {});
    const options = ((await started.json()) as any).value;
    const credential = await auth.assert({ challenge: options.challenge, rpId, origin });
    expect((await post("/api/web/passkey/signin/finish", { credential })).status).toBe(200);
    expect((await post("/api/web/passkey/signin/finish", { credential })).status).toBe(401);
    expect((await signIn(auth)).status).toBe(200);
  });

  it("require a same-origin POST, a session cookie to register, and a JSON object body", async () => {
    expect((await post("/api/web/passkey/signin/start", {}, {})).status).toBe(403);
    expect((await post("/api/web/passkey/signin/finish", {}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(`${server.url}/api/web/passkey/signin/start`, { headers: { origin } })).status).toBe(405);
    const noCookie = await post("/api/web/passkey/register/start", {});
    expect(noCookie.status).toBe(401);
    const web = await webSignIn(server.url, run.humanToken);
    expect((await post("/api/web/passkey/register/finish", { credential: "nope" }, web.headers)).status).toBe(400);
    const notJson = await fetch(`${server.url}/api/web/passkey/signin/finish`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: "[1]" });
    expect(notJson.status).toBe(400);
  });

  it("ends the sessions a removed passkey made: its cookie stops working, others keep working", async () => {
    const keep = await SoftwareAuthenticator.create("ES256");
    const lose = await SoftwareAuthenticator.create("ES256");
    const { web } = await register(keep, "keeper");
    const second = await post("/api/web/passkey/register/start", {}, web.headers);
    const options = ((await second.json()) as any).value;
    const credential = lose.register({ challenge: options.challenge, rpId, origin });
    expect((await post("/api/web/passkey/register/finish", { credential, label: "to lose" }, web.headers)).status).toBe(200);
    const cookieOf = async (auth: SoftwareAuthenticator) => (await signIn(auth)).headers.get("set-cookie")!.split(";")[0]!;
    const lostCookie = await cookieOf(lose);
    const keptCookie = await cookieOf(keep);
    const headers = (cookie: string) => ({ cookie, origin });
    expect((await api(server.url, undefined, "bbs_whoami", {}, headers(lostCookie))).status).toBe(200);
    const listed = await api(server.url, undefined, "bbs_passkeys", {}, headers(keptCookie));
    const id = listed.body.value.passkeys.find((p: any) => p.label === "to lose").id;
    // The lost passkey's own session removes it: the answer clears the cookie.
    const own = await fetch(`${server.url}/api/bbs_passkey_remove`, { method: "POST", headers: { ...headers(lostCookie), "content-type": "application/json" }, body: JSON.stringify({ id }) });
    expect(own.status).toBe(200);
    expect(own.headers.get("set-cookie")).toMatch(/^bbs-session=; Max-Age=0; Path=\//);
    expect((await api(server.url, undefined, "bbs_whoami", {}, headers(lostCookie))).status).toBe(401);
    expect((await api(server.url, undefined, "bbs_whoami", {}, headers(keptCookie))).status).toBe(200);
    expect((await api(server.url, undefined, "bbs_whoami", {}, web.headers)).status).toBe(200);
    expect((await signIn(lose)).status).toBe(401);
  });

  it("remove a passkey from the web, but the last one only from the CLI", async () => {
    const a = await SoftwareAuthenticator.create("ES256");
    const { web } = await register(a, "to remove");
    const listed = await api(server.url, undefined, "bbs_passkeys", {}, web.headers);
    const mine = listed.body.value.passkeys.find((p: any) => p.label === "to remove");
    const others = listed.body.value.passkeys.filter((p: any) => p.id !== mine.id);
    expect(others.length).toBeGreaterThan(0);
    expect((await api(server.url, undefined, "bbs_passkey_remove", { id: mine.id }, web.headers)).status).toBe(200);
    // Remove all but one from the web; the last is refused there and goes from the CLI.
    for (const p of others.slice(0, -1)) {
      expect((await api(server.url, undefined, "bbs_passkey_remove", { id: p.id }, web.headers)).status).toBe(200);
    }
    const last = others.at(-1);
    const refused = await api(server.url, undefined, "bbs_passkey_remove", { id: last.id }, web.headers);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("only available from the bbs CLI");
    expect((await api(server.url, run.humanToken, "bbs_passkey_remove", { id: last.id }, asCli)).status).toBe(200);
    expect((await api(server.url, run.humanToken, "bbs_passkeys", {}, asCli)).body.value.passkeys).toEqual([]);
    // A removed passkey no longer signs in.
    expect((await signIn(a)).status).toBe(401);
  });

  it("are not offered on /mcp or to an agent", async () => {
    const agent = await api(server.url, run.humanToken, "bbs_admin_user_add", { handle: "passkey-probe" }, asCli);
    const token = agent.body.value.token as string;
    expect((await api(server.url, token, "bbs_passkeys", {})).status).toBe(403);
    const mcp = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(await mcp.text()).not.toContain("bbs_passkey");
  });

  it("answer 404 on the API host, where the relying party is not", async () => {
    const { port } = new URL(server.url);
    for (const path of ["/api/web/passkey/signin/start", "/api/web/passkey/signin/finish", "/api/web/passkey/register/start", "/api/web/passkey/register/finish"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers: { host: `api.localhost:${port}`, origin: `http://api.localhost:${port}`, "content-type": "application/json" } }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
        req.end("{}");
      });
      expect(status, path).toBe(404);
    }
  });

  it("leave audit rows without a challenge, a signature or a key", async () => {
    const audit = await api(server.url, run.humanToken, "bbs_audit", { limit: 500 }, asCli);
    const rows = audit.body.value.events as { action: string; detail: unknown }[];
    expect(rows.some((r) => r.action === "passkey_register")).toBe(true);
    expect(rows.some((r) => r.action === "passkey_signin")).toBe(true);
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/"(challenge|signature|public_key|attestationObject|clientDataJSON)"/);
  });
});
