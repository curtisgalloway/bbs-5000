// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// Passkeys as approvers (issue #54) end to end under `wrangler dev`: a board
// started with approval off, a device-bound passkey registered on it, then the
// same state restarted with BBS_REQUIRE_APPROVAL=1, the order the deploy docs
// give. Then the pairing approval through the Worker's routes: the CLI's call
// answers approval_required with a link, the browser's poll hands out the
// approval, the two web calls with a software authenticator approve it, and the
// browser claims its session. Also: the routes are the web host's alone, the
// status tool is not on /mcp, and with no passkey that can approve the gated
// call is refused (the fail-closed rule).

import { readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SoftwareAuthenticator } from "../../packages/core/test/authenticator.ts";
import { api, groupAlive, makeRunDir, startWrangler, webSignIn, type RunDir, type Server } from "./harness.ts";

let run: RunDir;
let server: Server;
let origin: string;
let rpId: string;
const auth = { current: undefined as SoftwareAuthenticator | undefined };

const asCli = { "x-bbs-client": "cli" };

beforeAll(async () => {
  run = makeRunDir();
  const log = join(run.dir, "wrangler.log");
  // First boot: approval off. Register a device-bound passkey from a pairing session.
  const first = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: log });
  try {
    const o = new URL(first.url);
    const post = (path: string, body: unknown, headers: Record<string, string>) =>
      fetch(`${first.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const web = await webSignIn(first.url, run.humanToken);
    const started = (await (await post("/api/web/passkey/register/start", {}, web.headers)).json()) as { value: { challenge: string } };
    const key = await SoftwareAuthenticator.create("ES256");
    const credential = key.register({ challenge: started.value.challenge, rpId: o.hostname, origin: o.origin });
    const done = await post("/api/web/passkey/register/finish", { credential, label: "E2E key" }, web.headers);
    expect(done.status).toBe(200);
    auth.current = key;
  } finally {
    await first.stop();
  }
  // Second boot over the same state: approval required.
  server = await startWrangler({ stateDir: run.stateDir, envFile: approvalEnvFile(run), logFile: log });
  origin = new URL(server.url).origin;
  rpId = new URL(server.url).hostname;
});

afterAll(async () => {
  await server?.stop();
  if (server) expect(groupAlive(server.pid)).toBe(false);
  run?.cleanup();
});

/** The run's env file with `BBS_REQUIRE_APPROVAL=1` added, as `npm run setup -- --require-approval` writes it. */
function approvalEnvFile(r: RunDir): string {
  const path = join(r.dir, "dev-approval.vars");
  writeFileSync(path, `${readFileSync(r.envFile, "utf8")}BBS_REQUIRE_APPROVAL=1\n`, { mode: 0o600 });
  return path;
}

function post(path: string, body: unknown, headers: Record<string, string> = { origin }): Promise<Response> {
  return fetch(`${server.url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("a pairing approved by a passkey, over HTTP", () => {
  it("the CLI's approve asks for an approval with a link; the browser's poll and two web calls approve it", async () => {
    const started = (await (await post("/api/web/pair/start", {})).json()) as { value: { code: string; poll_secret: string } };
    const asked = await api(server.url, run.humanToken, "bbs_web_pairing_approve", { code: started.value.code }, asCli);
    expect(asked.status).toBe(200);
    const v = asked.body.value as { status: string; approval: string; match_code: string; url: string; expires_at: string };
    expect(v.status).toBe("approval_required");
    expect(v.match_code).toMatch(/^[A-Z2-9]{6}$/);
    expect(v.expires_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(v.url).toBe(`${origin}/approve#${v.approval}`);

    // The CLI's wait loop: pending.
    const status = await api(server.url, run.humanToken, "bbs_approval_status", { approval: v.approval }, asCli);
    expect(status.body.value).toMatchObject({ status: "pending", action: "web_pairing_approve", match_code: v.match_code });

    // The browser's poll holds the secret that opens it, and the claim is still pending.
    const polled = (await (await post("/api/web/pair/claim", { poll_secret: started.value.poll_secret })).json()) as {
      value: { status: string; approval: string; match_code: string };
    };
    expect(polled.value).toMatchObject({ status: "pending", match_code: v.match_code });

    const begin = (await (await post("/api/web/approval/start", { approval: polled.value.approval })).json()) as {
      value: { action: string; scope: { label: string }; publicKey: { challenge: string; rpId: string; userVerification: string; allowCredentials: unknown[] } };
    };
    expect(begin.value).toMatchObject({ action: "web_pairing_approve", publicKey: { rpId, userVerification: "required" } });
    expect(begin.value.publicKey.allowCredentials).toHaveLength(1);
    const credential = await (auth.current as SoftwareAuthenticator).assert({ challenge: begin.value.publicKey.challenge, rpId, origin });
    const finished = await post("/api/web/approval/finish", { approval: polled.value.approval, credential });
    expect(finished.status).toBe(200);
    expect(((await finished.json()) as any).value).toMatchObject({ status: "approved", action: "web_pairing_approve", result: { approved: true } });

    expect((await api(server.url, run.humanToken, "bbs_approval_status", { approval: v.approval }, asCli)).body.value.status).toBe("approved");
    // Now the browser's next poll claims its session.
    const claim = await post("/api/web/pair/claim", { poll_secret: started.value.poll_secret });
    expect(claim.status).toBe(200);
    expect(claim.headers.get("set-cookie") ?? "").toContain("bbs-session=");
  });

  it("a second finish of a used approval is refused", async () => {
    const started = (await (await post("/api/web/pair/start", {})).json()) as { value: { code: string } };
    const asked = await api(server.url, run.humanToken, "bbs_web_pairing_approve", { code: started.value.code }, asCli);
    const secret = asked.body.value.approval as string;
    const begin = (await (await post("/api/web/approval/start", { approval: secret })).json()) as { value: { publicKey: { challenge: string } } };
    const credential = await (auth.current as SoftwareAuthenticator).assert({ challenge: begin.value.publicKey.challenge, rpId, origin });
    expect((await post("/api/web/approval/finish", { approval: secret, credential })).status).toBe(200);
    expect((await post("/api/web/approval/finish", { approval: secret, credential })).status).toBe(404);
  });

  it("whoami and passkeys say approval is required", async () => {
    const who = await api(server.url, run.humanToken, "bbs_whoami", {}, asCli);
    expect(who.body.value.approval).toEqual({ required: true, allow_synced: false });
    const listed = await api(server.url, run.humanToken, "bbs_passkeys", {}, asCli);
    expect(listed.body.value.approval).toEqual({ required: true, allow_synced: false, approvers: 1 });
    expect(listed.body.value.passkeys[0]).toMatchObject({ synced: false, can_approve: true });
  });
});

describe("the routes and the tool", () => {
  it("answer on the web host (a refusal about the approval) and 404 as no route on the API host", async () => {
    expect((await post("/api/web/approval/start", { approval: "nope" })).status).toBe(404);
    expect((await post("/api/web/approval/finish", { approval: "nope", credential: {} })).status).toBe(403);
    const unknown = (await (await post("/api/web/approval/start", { approval: "nope" })).json()) as any;
    expect(unknown.error.message).toContain("approval request");
    expect((await post("/api/web/approval/start", {}, {})).status).toBe(403);
    const { port } = new URL(server.url);
    for (const path of ["/api/web/approval/start", "/api/web/approval/finish"]) {
      const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST", headers: { host: `api.localhost:${port}`, origin: `http://api.localhost:${port}`, "content-type": "application/json" } }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        });
        req.on("error", reject);
        req.end("{}");
      });
      expect(body.status, path).toBe(404);
      expect(body.text, path).toContain("no such route");
    }
  });

  it("bbs_approval_status is for a person: an agent token is refused and /mcp does not list it", async () => {
    const agent = await api(server.url, run.humanToken, "bbs_admin_user_add", { handle: "alice", kind: "agent", harness: "claude-code" }, asCli);
    const token = agent.body.value.token as string;
    expect((await api(server.url, token, "bbs_approval_status", { approval: "x" })).status).toBe(403);
    const mcp = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(await mcp.text()).not.toContain("bbs_approval_status");
  });

  it("the audit holds the request and the approved change, and no secret id", async () => {
    const audit = await api(server.url, run.humanToken, "bbs_audit", { limit: 500 }, asCli);
    const rows = audit.body.value.events as { action: string; detail: unknown }[];
    expect(rows.some((r) => r.action === "approval_request")).toBe(true);
    expect(rows.some((r) => r.action === "web_pairing_approve" && JSON.stringify(r.detail).includes('"approval"'))).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/"(nonce|challenge|signature)"/);
  });
});
