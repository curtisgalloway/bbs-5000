// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// OAuth on /mcp for remote connectors (issue #55), end to end under `wrangler
// dev`: the free challenge, the metadata, a scripted client that publishes its
// own metadata document from a local server, consent through the web view's two
// calls with a paired web session, the code exchange, a real MCP client using
// the access token, refresh with rotation and replay, and revoke. The consent
// page's HTML is part B; its two calls are what is driven here.
//
// The https-only rule for a client's address needs the test-only allowance
// (BBS_TEST_OAUTH_LOOPBACK_CLIENTS in the harness's env file), which the Worker
// honors only for a request that arrived on a loopback hostname.

import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { api, groupAlive, makeRunDir, startWrangler, webSignIn, type RunDir, type Server, type WebSession } from "./harness.ts";

let run: RunDir;
let server: Server;
let web: WebSession;
let clientServer: HttpServer;
let clientBase: string;
let clientId: string;
/** The scripted signing client (private_key_jwt): its own document, and its key set served beside it. */
let signingId: string;
const signingKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

const asCli = { "x-bbs-client": "cli" };
const REDIRECT = "http://127.0.0.1:53682/callback";

beforeAll(async () => {
  run = makeRunDir("owner", { BBS_TEST_OAUTH_LOOPBACK_CLIENTS: "1", BBS_OAUTH_REFRESH_GRACE_MS: "2000" });
  server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
  // The scripted client's own metadata document, as a remote client publishes it.
  clientServer = createServer((req, res) => {
    const path = req.url ?? "";
    if (path === "/client.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ client_id: clientId, client_name: "E2E Client", redirect_uris: ["http://127.0.0.1/callback"] }));
    } else if (path === "/signing.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          client_id: signingId,
          client_name: "E2E Signing Client",
          redirect_uris: ["http://127.0.0.1/callback"],
          token_endpoint_auth_method: "private_key_jwt",
          token_endpoint_auth_signing_alg: "RS256",
          jwks_uri: `${clientBase}/jwks.json`,
        }),
      );
    } else if (path === "/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [{ ...signingKeys.publicKey.export({ format: "jwk" }), kid: "e2e-key", use: "sig", alg: "RS256" }] }));
    } else if (path === "/redirect.json") {
      res.writeHead(302, { location: `${clientBase}/client.json` });
      res.end();
    } else if (path === "/big.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ client_id: `${clientBase}/big.json`, pad: "x".repeat(40_000) }));
    } else if (path === "/stall.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => clientServer.listen(0, "127.0.0.1", r));
  const addr = clientServer.address();
  if (addr === null || typeof addr === "string") throw new Error("no client server port");
  clientBase = `http://127.0.0.1:${addr.port}`;
  clientId = `${clientBase}/client.json`;
  signingId = `${clientBase}/signing.json`;
  web = await webSignIn(server.url, run.humanToken);
});

afterAll(async () => {
  await new Promise<void>((r) => {
    clientServer?.closeAllConnections();
    clientServer ? clientServer.close(() => r()) : r();
  });
  await server?.stop();
  if (server) expect(groupAlive(server.pid)).toBe(false);
  run?.cleanup();
});

/** Audit rows after `seq`, without the human's own audit reads. */
async function auditAfter(seq: number): Promise<any[]> {
  const r = await api(server.url, run.humanToken, "bbs_audit", { after_seq: seq, limit: 1000 }, asCli);
  expect(r.status).toBe(200);
  return r.body.value.events.filter((e: any) => !(e.action === "audit" && e.actor === run.humanHandle));
}

async function headSeq(): Promise<number> {
  const r = await api(server.url, run.humanToken, "bbs_audit", { after_seq: 0, limit: 1000 }, asCli);
  return (r.body.value.events as { seq: number }[]).at(-1)?.seq ?? 0;
}

interface Pkce {
  verifier: string;
  challenge: string;
}

function pkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** One of the consent page's two calls, as the page makes it: a same-origin POST with the session cookie. */
async function consent(path: "request" | "decide", body: unknown, headers: Record<string, string> = web.headers) {
  const res = await fetch(`${server.url}/api/web/oauth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

function authorizeBody(p: Pkce, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    resource: `${server.url}/mcp`,
    state: `state-${randomBytes(6).toString("hex")}`,
    ...over,
  };
}

/** The client's side of the redirect: the parameters the page would send the browser back with. */
function redirectParams(redirectTo: string): URLSearchParams {
  const u = new URL(redirectTo);
  expect(`${u.origin}${u.pathname}`).toBe(REDIRECT);
  return u.searchParams;
}

/** Authorize, consent as the person, and return the code the redirect carries. */
async function authorize(handle: string, p = pkce(), over: Record<string, unknown> = {}): Promise<{ code: string; p: Pkce; grant: string; state: string }> {
  const body = authorizeBody(p, over);
  const requested = await consent("request", body);
  expect(requested.status, JSON.stringify(requested.body)).toBe(200);
  expect(requested.body.value.status).toBe("consent");
  const decided = await consent("decide", { request_id: requested.body.value.request_id, approve: true, handle });
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  const params = redirectParams(decided.body.value.redirect_to);
  expect(params.get("state")).toBe(body.state);
  expect(params.get("iss")).toBe(server.url);
  return { code: params.get("code") as string, p, grant: decided.body.value.grant, state: body.state as string };
}

async function token(fields: Record<string, string>): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${server.url}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const codeFields = (a: { code: string; p: Pkce }): Record<string, string> => ({
  grant_type: "authorization_code",
  code: a.code,
  code_verifier: a.p.verifier,
  client_id: clientId,
  redirect_uri: REDIRECT,
  resource: `${server.url}/mcp`,
});

const refreshFields = (refreshToken: string): Record<string, string> => ({
  grant_type: "refresh_token",
  refresh_token: refreshToken,
  client_id: clientId,
  resource: `${server.url}/mcp`,
});

/** A raw MCP call, for the status and headers the SDK client hides. */
async function mcpRaw(accessToken: string | undefined): Promise<Response> {
  return fetch(`${server.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(accessToken !== undefined ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

async function mcpClient(accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "e2e-connector", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("the challenge and the metadata", () => {
  const challenge = () => `Bearer resource_metadata="${server.url}/.well-known/oauth-protected-resource/mcp", scope="board"`;

  it("answers /mcp with no Authorization header with a free 401 that writes no audit row", async () => {
    const before = await headSeq();
    for (let i = 0; i < 3; i++) {
      const res = await mcpRaw(undefined);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(challenge());
    }
    expect(await auditAfter(before)).toEqual([]);
  });

  it("gives a refused token the same header, and counts it as a failed sign-in", async () => {
    const before = await headSeq();
    const res = await mcpRaw("bbsat_not-a-token");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(challenge());
    const rows = await auditAfter(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "anonymous", action: "auth", via: "mcp", result: "denied" });
  });

  it("publishes the resource and the authorization server, open to any origin", async () => {
    const prm = await fetch(`${server.url}/.well-known/oauth-protected-resource/mcp`);
    expect(prm.headers.get("access-control-allow-origin")).toBe("*");
    expect(await prm.json()).toMatchObject({ resource: `${server.url}/mcp`, authorization_servers: [server.url], scopes_supported: ["board"] });
    expect(await (await fetch(`${server.url}/.well-known/oauth-protected-resource`)).json()).toMatchObject({ resource: `${server.url}/mcp` });
    const as = (await (await fetch(`${server.url}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(as).toMatchObject({
      issuer: server.url,
      authorization_endpoint: `${server.url}/oauth/authorize`,
      token_endpoint: `${server.url}/oauth/token`,
      revocation_endpoint: `${server.url}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: ["RS256", "ES256"],
      scopes_supported: ["board"],
    });
    const pre = await fetch(`${server.url}/oauth/token`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("consent through the web view's two calls", () => {
  it("needs the person's session cookie and a same-origin POST", async () => {
    const body = authorizeBody(pkce());
    const origin = new URL(server.url).origin;
    expect((await consent("request", body, { origin })).status).toBe(401);
    expect((await consent("request", body, { cookie: web.cookie })).status).toBe(403);
    expect((await consent("request", body, { cookie: web.cookie, origin: "https://evil.example" })).status).toBe(403);
    // A bearer token, even the human credential, is not a session.
    expect((await consent("request", body, { origin, authorization: `Bearer ${run.humanToken}`, "x-bbs-client": "cli" })).status).toBe(401);
    expect((await consent("decide", { request_id: "x", approve: true, handle: "x" }, { origin })).status).toBe(401);
  });

  it("describes the client from the document it published, and stores only a hash of the request id", async () => {
    const r = await consent("request", authorizeBody(pkce()));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.value).toMatchObject({
      status: "consent",
      client: { id: clientId, name: "E2E Client", host: new URL(clientBase).host },
      redirect: { uri: REDIRECT, host: "127.0.0.1:53682", localhost: true },
      scope: "board",
      suggested_handle: "e2e-client",
    });
    expect(r.body.value.request_id).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(r.body.value.agents).toEqual(expect.any(Array));
    const rows = await auditAfter((await headSeq()) - 1);
    expect(JSON.stringify(rows)).not.toContain(r.body.value.request_id);
  });

  it("refuses what is wrong before a redirect address is known, and sends the rest back to the client", async () => {
    const p = pkce();
    const wrongRedirect = await consent("request", authorizeBody(p, { redirect_uri: "http://127.0.0.1:53682/other" }));
    expect(wrongRedirect.status).toBe(400);
    expect(wrongRedirect.body).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(wrongRedirect.body.error.message).toMatch(/not one of the addresses/);
    const badClient = await consent("request", authorizeBody(p, { client_id: "https://intranet/client.json" }));
    expect(badClient.status).toBe(400);
    expect(badClient.body.error.message).toMatch(/single-label/);
    const noClient = await consent("request", authorizeBody(p, { client_id: undefined }));
    expect(noClient.status).toBe(400);
    // After the redirect address is known to be the client's: back to it, with the error and its state.
    const body = authorizeBody(p, { resource: "https://elsewhere.example/mcp" });
    const wrongResource = await consent("request", body);
    expect(wrongResource.status).toBe(200);
    expect(wrongResource.body.value.status).toBe("redirect");
    const params = redirectParams(wrongResource.body.value.redirect_to);
    expect(params.get("error")).toBe("invalid_target");
    expect(params.get("state")).toBe(body.state);
    expect(params.get("iss")).toBe(server.url);
    const plain = await consent("request", authorizeBody(p, { code_challenge_method: "plain" }));
    expect(redirectParams(plain.body.value.redirect_to).get("error")).toBe("invalid_request");
  });

  it("fetches the client's document under limits: no redirects, a byte cap, a timeout", async () => {
    for (const [path, why] of [
      ["redirect.json", /redirects are not followed/],
      ["big.json", /larger than 16384 bytes/],
      ["missing.json", /HTTP 404/],
    ] as const) {
      const r = await consent("request", authorizeBody(pkce(), { client_id: `${clientBase}/${path}` }));
      expect(r.status, path).toBe(400);
      expect(r.body.error.message, path).toMatch(why);
    }
    const stalled = await consent("request", authorizeBody(pkce(), { client_id: `${clientBase}/stall.json` }));
    expect(stalled.status).toBe(400);
    expect(stalled.body.error.message).toMatch(/took too long|could not be read/);
  }, 30_000);

  it("denying redirects with access_denied and makes nothing; a request is decided once", async () => {
    const body = authorizeBody(pkce());
    const requested = await consent("request", body);
    const denied = await consent("decide", { request_id: requested.body.value.request_id, approve: false });
    expect(denied.status).toBe(200);
    expect(denied.body.value.approved).toBe(false);
    const params = redirectParams(denied.body.value.redirect_to);
    expect(params.get("error")).toBe("access_denied");
    expect(params.get("state")).toBe(body.state);
    expect(params.has("code")).toBe(false);
    const again = await consent("decide", { request_id: requested.body.value.request_id, approve: true, handle: "e2e-denied" });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("not_found");
    const unknown = await consent("decide", { request_id: "unknown", approve: true, handle: "e2e-denied" });
    expect(unknown.status).toBe(404);
  });
});

describe("the whole flow", () => {
  it("a scripted client signs in, a real MCP client uses the token, it refreshes, and revokes", async () => {
    const before = await headSeq();
    const a = await authorize("e2e-agent");
    expect(a.code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // A wrong verifier does not spend the code; the right one makes the pair.
    const wrong = await token({ ...codeFields(a), code_verifier: randomBytes(32).toString("base64url") });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("invalid_grant");
    const t0 = await token(codeFields(a));
    expect(t0.status, JSON.stringify(t0.body)).toBe(200);
    expect(t0.headers.get("cache-control")).toBe("no-store");
    expect(t0.headers.get("access-control-allow-origin")).toBe("*");
    expect(t0.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "board" });
    expect(t0.body.access_token).toMatch(/^bbsat_/);
    expect(t0.body.refresh_token).toMatch(/^bbsrt_/);

    // No secret reaches an audit row.
    const rows = await auditAfter(before);
    const everything = JSON.stringify(rows);
    for (const secret of [a.code, t0.body.access_token, t0.body.refresh_token, a.p.verifier]) expect(everything).not.toContain(secret);
    expect(rows.map((r: any) => r.action)).toEqual(expect.arrayContaining(["oauth_request", "oauth_decide", "oauth_code_exchange"]));

    // A real MCP client with the access token: the agent tools, no admin tools, one call as the agent.
    const mcp = await mcpClient(t0.body.access_token);
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("bbs_post");
    // Every listed tool declares the optional `session` argument, as a real client receives it.
    for (const t of tools) expect((t.inputSchema.properties as Record<string, any>)?.session, t.name).toMatchObject({ type: "string" });
    expect(tools.find((t) => t.name === "bbs_join")?.description).toContain("pass the session id");
    for (const hidden of ["bbs_oauth_grants", "bbs_oauth_grant_revoke", "bbs_admin_user_add", "bbs_web_sessions"]) expect(names).not.toContain(hidden);
    const joined = await mcp.callTool({ name: "bbs_join", arguments: { handle: "e2e-agent", role: "connector test" } });
    expect(joined.isError, JSON.stringify(joined)).toBeFalsy();
    await mcp.close();
    const joinRow = (await auditAfter(before)).find((r: any) => r.action === "join");
    expect(joinRow).toMatchObject({ actor: "e2e-agent", actor_kind: "agent", via: "mcp", result: "ok" });
    expect(joinRow.detail.grant).toBe(a.grant);

    // The access token is for /mcp only.
    expect((await api(server.url, t0.body.access_token, "bbs_topics")).status).toBe(401);

    // The person sees the grant from the CLI: client, host, handle, approver, last use.
    const grants = await api(server.url, run.humanToken, "bbs_oauth_grants", {}, asCli);
    expect(grants.status).toBe(200);
    const mine = grants.body.value.grants.find((g: any) => g.id === a.grant);
    expect(mine).toMatchObject({ client_id: clientId, client_name: "E2E Client", handle: "e2e-agent", approved_by: "owner" });
    expect(mine.last_used_at).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    expect(Date.parse(mine.expires_at)).toBeGreaterThan(Date.now() + 29 * 24 * 3_600_000);
    expect(grants.body.peer_content_notice).toBeTruthy();
    // An agent cannot list or revoke: not with its own token, not with the access token.
    expect((await api(server.url, t0.body.access_token, "bbs_oauth_grants")).status).toBe(401);

    // Refresh rotates, and a refresh does not cut an access token short: two refreshes at once with
    // one token both succeed, and every access token works until one of the new pairs is refreshed.
    const [t1, again] = await Promise.all([token(refreshFields(t0.body.refresh_token)), token(refreshFields(t0.body.refresh_token))]);
    expect(t1.status, JSON.stringify(t1.body)).toBe(200);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(t1.body.refresh_token).not.toBe(t0.body.refresh_token);
    expect(again.body.refresh_token).not.toBe(t1.body.refresh_token);
    for (const t of [t0, t1, again]) expect((await mcpRaw(t.body.access_token)).status).toBe(200);
    // The first refresh of one of them picks the surviving line and retires the other at once.
    const t2 = await token(refreshFields(t1.body.refresh_token));
    expect(t2.status, JSON.stringify(t2.body)).toBe(200);
    expect((await mcpRaw(again.body.access_token)).status).toBe(401);
    const mcp2 = await mcpClient(t2.body.access_token);
    expect((await mcp2.callTool({ name: "bbs_topics", arguments: {} })).isError).toBeFalsy();
    await mcp2.close();
    // After the grace a replaced token is a replay: the grant ends, and every token of it with it.
    await new Promise((r) => setTimeout(r, 2_500));
    const replay = await token(refreshFields(t0.body.refresh_token));
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect((await mcpRaw(t2.body.access_token)).status).toBe(401);
    const afterReplay = await api(server.url, run.humanToken, "bbs_oauth_grants", {}, asCli);
    expect(afterReplay.body.value.grants.map((g: any) => g.id)).not.toContain(a.grant);

    // A second approval under the same handle: the person's revoke, then the client's own.
    const b = await authorize("e2e-agent");
    const tb = await token(codeFields(b));
    expect(tb.status).toBe(200);
    const revokeFields = (tok: string): URLSearchParams => new URLSearchParams({ token: tok, client_id: clientId });
    const other = await fetch(`${server.url}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tb.body.access_token, client_id: "https://other.example/client.json" }),
    });
    expect(other.status).toBe(401);
    expect((await mcpRaw(tb.body.access_token)).status).toBe(200);
    const revoked = await fetch(`${server.url}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: revokeFields(tb.body.refresh_token),
    });
    expect(revoked.status).toBe(200);
    expect((await mcpRaw(tb.body.access_token)).status).toBe(401);
    expect((await token(refreshFields(tb.body.refresh_token))).status).toBe(400);

    // The human admin's revoke from the CLI ends a third.
    const c = await authorize("e2e-agent");
    const tc = await token(codeFields(c));
    expect((await mcpRaw(tc.body.access_token)).status).toBe(200);
    const byId = await api(server.url, run.humanToken, "bbs_oauth_grant_revoke", { id: c.grant }, asCli);
    expect(byId.status, JSON.stringify(byId.body)).toBe(200);
    expect((await mcpRaw(tc.body.access_token)).status).toBe(401);
    expect((await api(server.url, run.humanToken, "bbs_oauth_grant_revoke", { id: c.grant }, asCli)).status).toBe(404);
  }, 60_000);

  it("a stolen refresh token used inside the grace ends the grant when the second holder refreshes", async () => {
    const a = await authorize("e2e-thief");
    const t0 = await token(codeFields(a));
    const client = await token(refreshFields(t0.body.refresh_token));
    const thief = await token(refreshFields(t0.body.refresh_token));
    expect([client.status, thief.status]).toEqual([200, 200]);
    const next = await token(refreshFields(client.body.refresh_token));
    expect(next.status).toBe(200);
    expect((await mcpRaw(thief.body.access_token)).status).toBe(401);
    const caught = await token(refreshFields(thief.body.refresh_token));
    expect(caught.status).toBe(400);
    expect((await mcpRaw(next.body.access_token)).status).toBe(401);
  });

  it("the token a refreshed pair came from is closed at once: a late presentation inside its grace ends the grant", async () => {
    const a = await authorize("e2e-late");
    const x = await token(codeFields(a));
    const y1 = await token(refreshFields(x.body.refresh_token));
    const z = await token(refreshFields(y1.body.refresh_token));
    expect([y1.status, z.status]).toEqual([200, 200]);
    const late = await token(refreshFields(x.body.refresh_token));
    expect(late.status).toBe(400);
    expect((await mcpRaw(z.body.access_token)).status).toBe(401);
  });

  it("a code exchanged twice at once makes one token pair, and the second use ends the grant", async () => {
    const a = await authorize("e2e-race");
    const results = await Promise.all([token(codeFields(a)), token(codeFields(a))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const winner = results.find((r) => r.status === 200)!;
    expect(results.find((r) => r.status === 400)!.body.error).toBe("invalid_grant");
    // The grant ended with the second use, so even the winner's token is dead.
    expect((await mcpRaw(winner.body.access_token)).status).toBe(401);
    expect((await token(refreshFields(winner.body.refresh_token))).status).toBe(400);
    const grants = await api(server.url, run.humanToken, "bbs_oauth_grants", {}, asCli);
    expect(grants.body.value.grants.map((g: any) => g.id)).not.toContain(a.grant);
  });

  it("serves the consent page on the web host with the Content-Security-Policy, and 404s it on the API host", async () => {
    const web = await fetch(`${server.url}/oauth/authorize?client_id=x`);
    expect(web.status).toBe(200);
    expect(web.headers.get("content-type")).toContain("text/html");
    expect(web.headers.get("content-security-policy")).toMatch(/default-src 'none'; script-src 'self'; style-src 'self'/);
    const html = await web.text();
    expect(html).toContain('src="/authorize.js"');
    expect((await fetch(`${server.url}/authorize.js`)).status).toBe(200);
    // The API host is the one whose name starts with "api.": same server, another Host header.
    const { port } = new URL(server.url);
    const apiHost = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/oauth/authorize?client_id=x", headers: { host: `api.localhost:${port}` } }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(apiHost.status).toBe(404);
    expect(apiHost.body).not.toContain("authorize.js");
  });

  it("an agent's own token keeps working on /mcp beside the connectors'", async () => {
    const added = await api(server.url, run.humanToken, "bbs_admin_user_add", { handle: "e2e-local" }, asCli);
    const own = added.body.value.token as string;
    const res = await mcpRaw(own);
    expect(res.status).toBe(200);
    // The person is refused on /mcp whichever credential: the human credential is not an agent's.
    expect((await mcpRaw(run.humanToken)).status).toBe(403);
  });
});

describe("a client that signs its token requests (private_key_jwt)", () => {
  /** A signed client assertion (RS256) for the signing client, valid now unless `over` says otherwise. */
  function assertion(over: Record<string, unknown> = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const input = [
      { alg: "RS256", typ: "JWT", kid: "e2e-key" },
      { iss: signingId, sub: signingId, aud: server.url, iat: now, exp: now + 300, jti: randomBytes(12).toString("hex"), ...over },
    ]
      .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
      .join(".");
    return `${input}.${createSign("RSA-SHA256").update(input).sign(signingKeys.privateKey).toString("base64url")}`;
  }

  const signed = (fields: Record<string, string>, jwt: string | null = assertion()): Record<string, string> => ({
    ...fields,
    client_id: signingId,
    ...(jwt !== null ? { client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: jwt } : {}),
  });

  it("signs in with an assertion, uses the token, refreshes with a new one, and is refused without one or with a replayed one", async () => {
    // The refusals above and below share this source's failed sign-in window (20 a minute); let it roll over first.
    await new Promise((r) => setTimeout(r, 61_000));
    const before = await headSeq();
    const p = pkce();
    const requested = await consent("request", authorizeBody(p, { client_id: signingId }));
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    expect(requested.body.value.client_auth).toBe("private_key_jwt");
    const decided = await consent("decide", { request_id: requested.body.value.request_id, approve: true, handle: "e2e-signer" });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const code = redirectParams(decided.body.value.redirect_to).get("code") as string;
    const grant = decided.body.value.grant as string;
    const fields = { grant_type: "authorization_code", code, code_verifier: p.verifier, redirect_uri: REDIRECT, resource: `${server.url}/mcp` };

    // No assertion, a bad one: invalid_client, and the code is still good.
    const none = await token(signed(fields, null));
    expect(none.status).toBe(401);
    expect(none.body.error).toBe("invalid_client");
    const forged = await token(signed(fields, assertion({ aud: "https://elsewhere.example" })));
    expect(forged.status).toBe(401);
    expect(forged.body.error).toBe("invalid_client");

    const jwt = assertion();
    const t0 = await token(signed(fields, jwt));
    expect(t0.status, JSON.stringify(t0.body)).toBe(200);
    expect(t0.body.access_token).toMatch(/^bbsat_/);
    // The same assertion again is a replay of its jti.
    const replay = await token(signed({ ...fields, code: "other" }, jwt));
    expect(replay.status).toBe(401);
    expect(replay.body.error).toBe("invalid_client");

    const mcp = await mcpClient(t0.body.access_token);
    expect((await mcp.callTool({ name: "bbs_topics", arguments: {} })).isError).toBeFalsy();
    await mcp.close();

    const grants = await api(server.url, run.humanToken, "bbs_oauth_grants", {}, asCli);
    expect(grants.body.value.grants.find((g: any) => g.id === grant)).toMatchObject({ client_auth: "private_key_jwt", client_name: "E2E Signing Client" });

    const refresh = { grant_type: "refresh_token", refresh_token: t0.body.refresh_token, resource: `${server.url}/mcp` };
    expect((await token(signed(refresh, null))).status).toBe(401);
    const t1 = await token(signed(refresh));
    expect(t1.status, JSON.stringify(t1.body)).toBe(200);
    expect((await mcpRaw(t1.body.access_token)).status).toBe(200);

    // The assertion is a credential of its own: it never reaches an audit row, and the grant survived every refusal.
    const rows = JSON.stringify(await auditAfter(before));
    expect(rows).not.toContain(jwt);
    expect(rows).toContain('"client_auth":"private_key_jwt"');

    const revoke = (tok: string, jwtFor: string | null) =>
      fetch(`${server.url}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tok, ...signed({}, jwtFor) }),
      });
    expect((await revoke(t1.body.refresh_token, null)).status).toBe(401);
    expect((await mcpRaw(t1.body.access_token)).status).toBe(200);
    expect((await revoke(t1.body.refresh_token, assertion())).status).toBe(200);
    expect((await mcpRaw(t1.body.access_token)).status).toBe(401);
  }, 120_000);
});

describe("one board session per connector chat", () => {
  it("assigns an Mcp-Session-Id at initialize; two chats on one grant each join and both show in bbs_who", async () => {
    const a = await authorize("e2e-chats");
    const t = await token(codeFields(a));
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const access = t.body.access_token as string;

    const init = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${access}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
      }),
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    // The default way to use the board reaches a connector as MCP instructions.
    expect(await init.text()).toContain("#coordination");

    const served = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${access}`,
        "mcp-session-id": sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(served.status).toBe(200);
    await served.text();

    const one = await mcpClient(access);
    const two = await mcpClient(access);
    for (const [client, machine] of [[one, "chat-one"], [two, "chat-two"]] as const) {
      const joined = await client.callTool({ name: "bbs_join", arguments: { machine } });
      expect(joined.isError, JSON.stringify(joined)).toBeFalsy();
    }
    const who = (await one.callTool({ name: "bbs_who", arguments: {} })) as any;
    expect(who.isError).toBeFalsy();
    const me = who.structuredContent.users.find((u: any) => u.handle === "e2e-chats");
    expect(me.sessions.map((s: any) => s.machine).sort()).toEqual(["chat-one", "chat-two"]);
    await one.close();
    await two.close();
  }, 60_000);

  it("two clients that send no Mcp-Session-Id each join and both show in bbs_who; a call passing session is attributed", async () => {
    const a = await authorize("e2e-nohdr");
    const t = await token(codeFields(a));
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const access = t.body.access_token as string;

    let id = 100;
    const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
      const res = await fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${access}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const data = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5);
      return (JSON.parse(data) as any).result;
    };

    const one = await call("bbs_join", { machine: "nohdr-one" });
    const two = await call("bbs_join", { machine: "nohdr-two" });
    expect(one.isError, JSON.stringify(one)).toBeFalsy();
    expect(two.isError, JSON.stringify(two)).toBeFalsy();
    expect(one.structuredContent.session).not.toBe(two.structuredContent.session);
    expect(one.structuredContent.note).toMatch(/session/);

    const who = await call("bbs_who", {});
    const me = who.structuredContent.users.find((u: any) => u.handle === "e2e-nohdr");
    expect(me.sessions.map((s: any) => s.machine).sort()).toEqual(["nohdr-one", "nohdr-two"]);

    const bound = await call("bbs_whoami", { session: one.structuredContent.session });
    expect(bound.isError).toBeFalsy();
    expect(bound.structuredContent.session).toBe(one.structuredContent.session);
    const stale = await call("bbs_whoami", { session: "s_stale" });
    expect(stale.isError).toBeFalsy();
    expect(stale.structuredContent.session).toBeUndefined();
  }, 60_000);

  it("revoking the grant from the CLI ends the sessions joined through it, and bbs_who stops listing them (issue #86)", async () => {
    const a = await authorize("e2e-revoked");
    const t = await token(codeFields(a));
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    const one = await mcpClient(t.body.access_token as string);
    const two = await mcpClient(t.body.access_token as string);
    for (const [client, machine] of [[one, "revoke-one"], [two, "revoke-two"]] as const) {
      const joined = await client.callTool({ name: "bbs_join", arguments: { machine } });
      expect(joined.isError, JSON.stringify(joined)).toBeFalsy();
    }
    const whoSessions = async (): Promise<any[]> => {
      const r = await api(server.url, run.humanToken, "bbs_who", {}, asCli);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.value.users.find((u: any) => u.handle === "e2e-revoked")?.sessions ?? [];
    };
    expect((await whoSessions()).map((s: any) => s.machine).sort()).toEqual(["revoke-one", "revoke-two"]);

    const revoked = await api(server.url, run.humanToken, "bbs_oauth_grant_revoke", { id: a.grant }, asCli);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.value.sessions_ended).toBe(2);
    expect(await whoSessions()).toEqual([]);
    await one.close();
    await two.close();
  }, 60_000);
});
