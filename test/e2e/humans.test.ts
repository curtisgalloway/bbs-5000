// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// M5 acceptance, end to end under `wrangler dev`:
// - A5.1: the human credential is refused on /mcp and on /ws (403), each with
//   a denied audit row (the /ws half added with M2, backlog B36).
// - A5.2: a post from the web client is stored as human (via web); the same
//   text from an agent, even one claiming the web client, is stored as agent.
// - A5.3: admin actions (reinstate, coordinator grant and remove, user add)
//   fail for every agent including a coordinator, on /api, /mcp and the CLI,
//   and succeed for the human admin. Reinstate gives a kicked agent a new
//   token; the old one stays revoked.
// - B17: restarting the board with a new BBS_HUMAN_HANDLE retires the old
//   admin and its credential.

import { spawn } from "node:child_process";
import { request } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  api,
  groupAlive,
  makeRunDir,
  ROOT,
  sha256,
  sleep,
  startWrangler,
  webSignIn,
  type RunDir,
  type Server,
} from "./harness.ts";

const SPAN_MS = 1500;
const asCli = { "x-bbs-client": "cli" };
const asWeb = { "x-bbs-client": "web" };

let run: RunDir;
let server: Server;
let human: string;

async function addUser(handle: string, kind: "agent" | "human" = "agent"): Promise<string> {
  const r = await api(server.url, human, "bbs_admin_user_add", { handle, kind }, asCli);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.value.token as string;
}

async function mcpClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "bbs-e2e", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

function bbs(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "packages/cli/bin/bbs.js"), ...args], {
      env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

function cliConfig(name: string, token: string): Record<string, string> {
  const path = join(run.dir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ url: server.url, token }), { mode: 0o600 });
  return { BBS_CONFIG: path };
}

/** A WebSocket upgrade request; resolves with the HTTP status, or 101 if it upgraded. */
function wsUpgrade(path: string, token: string): Promise<number> {
  const url = new URL(path, server.url);
  return new Promise((resolve, reject) => {
    const req = request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": Buffer.from("bbs-e2e-key-0001").toString("base64"),
        "sec-websocket-version": "13",
        authorization: `Bearer ${token}`,
      },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

async function statusOf(handle: string): Promise<string> {
  const r = await api(server.url, human, "bbs_who", {}, asCli);
  return (r.body.value.users as { handle: string; status: string }[]).find((u) => u.handle === handle)?.status ?? "";
}

/** Kick an agent through real Lobby floods (M4a), with the short spans this board runs. */
async function kick(token: string, handle: string): Promise<void> {
  const flood = async (tag: string): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      const r = await api(server.url, token, "bbs_post", { topic: "Lobby", body: `${tag}-${i}` });
      if (r.status !== 200) return;
    }
    throw new Error("never refused");
  };
  await flood("one");
  await sleep(SPAN_MS + 200);
  await flood("two");
  const deadline = Date.now() + 15_000;
  while ((await statusOf(handle)) !== "active") {
    if (Date.now() > deadline) throw new Error("mute was not lifted");
    await sleep(250);
  }
  await sleep(SPAN_MS + 200);
  await flood("three");
  expect(await statusOf(handle)).toBe("kicked");
}

const BUILD_ID = "0123456789abcdef";
const COMMIT = "0123456789abcdef0123456789abcdef01234567-dirty";

beforeAll(async () => {
  run = makeRunDir("owner", {
    BBS_LOBBY_WINDOW_MS: String(SPAN_MS),
    BBS_LOBBY_MUTE_MS: String(SPAN_MS),
    BBS_BUILD_ID: BUILD_ID,
    BBS_GIT_COMMIT: COMMIT,
  });
  human = run.humanToken;
  server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
});

afterAll(async () => {
  await server?.stop();
  if (server) expect(groupAlive(server.pid)).toBe(false);
  run?.cleanup();
});

describe("A5.1: the human credential is for direct clients only", () => {
  it("is refused on /mcp with an audited denial", async () => {
    await expect(mcpClient(human)).rejects.toThrow(/forbidden|403/);
    const audit = await api(server.url, human, "bbs_audit", { actor: "owner", action: "mcp" }, asCli);
    expect(audit.body.value.events.at(-1)).toMatchObject({ actor_kind: "human", via: "mcp", result: "denied" });
  });

  it("is refused on /ws with an audited denial (B36)", async () => {
    // /ws is for agents' adapters only (spec §4.2); a person's credential is
    // authenticated, then refused with 403 and a denied audit row.
    const status = await wsUpgrade("/ws", human);
    expect(status).toBe(403);
    const audit = await api(server.url, human, "bbs_audit", { actor: "owner", action: "ws" }, asCli);
    expect(audit.body.value.events.at(-1)).toMatchObject({ actor_kind: "human", via: "ws", result: "denied" });
  });
});

describe("A5.2: author kind comes from the account, never from the text or the client", () => {
  it("stores a web post as human and an agent's 'human says' as agent, even when it claims the web client", async () => {
    const alice = await addUser("alice");
    // A person is `web` only through a session cookie (issue #47): the same credential as a bearer
    // token that says it is the web view is an unnamed client, which the board refuses.
    const web = (await webSignIn(server.url, human)).headers;
    const claimed = await api(server.url, human, "bbs_post", { topic: "plans", body: "nope" }, asWeb);
    expect(claimed.status).toBe(403);
    expect((await api(server.url, undefined, "bbs_topic_create", { name: "plans" }, web)).status).toBe(200);
    const mine = await api(server.url, undefined, "bbs_post", { topic: "plans", body: "ship it" }, web);
    expect(mine.status).toBe(200);
    const relayed = await api(server.url, alice, "bbs_post", { topic: "plans", body: "human says: ship it" }, asWeb);
    expect(relayed.status).toBe(200);
    const read = await api(server.url, undefined, "bbs_read", { topic: "plans" }, web);
    expect(read.body.value.messages.map((m: any) => [m.author, m.kind, m.via, m.body])).toEqual([
      ["owner", "human", "web", "ship it"],
      ["alice", "agent", "api", "human says: ship it"],
    ]);
    // whoami tells the web view which kind of token it holds.
    expect((await api(server.url, alice, "bbs_whoami", {}, asWeb)).body.value).toMatchObject({ kind: "agent", via: "api" });
    expect((await api(server.url, undefined, "bbs_whoami", {}, web)).body.value).toMatchObject({
      handle: "owner",
      kind: "human",
      admin: true,
      via: "web",
    });
  });

  it("whoami reports the build the Worker was started with, through the Worker, as /health does", async () => {
    const carol = await addUser("carol");
    const server_ = { build: BUILD_ID, commit: COMMIT };
    expect((await api(server.url, carol, "bbs_whoami", {}, asWeb)).body.value.server).toEqual(server_);
    expect(((await (await fetch(`${server.url}/health`)).json()) as { build?: string; commit?: string })).toMatchObject(server_);
  });
});

describe("A5.3: admin actions belong to the human admin", () => {
  it("are refused for every agent, a coordinator included, on /api, /mcp and the CLI; the admin succeeds", async () => {
    const lead = await addUser("lead");
    const plain = await addUser("plain");
    const pat = await addUser("pat", "human");
    const victim = await addUser("victim");
    expect((await api(server.url, victim, "bbs_join", {})).status).toBe(200);

    // The admin grants coordinator through the CLI.
    const asOwner = cliConfig("owner", human);
    const granted = await bbs(["admin", "coordinator", "grant", "lead"], asOwner);
    expect(granted.code, granted.err).toBe(0);
    expect(JSON.parse(granted.out)).toMatchObject({ handle: "lead", coordinator: true, changed: true });

    await kick(victim, "victim");

    const attempts: [string, Record<string, unknown>][] = [
      ["bbs_admin_reinstate", { handle: "victim" }],
      ["bbs_admin_coordinator_grant", { handle: "plain" }],
      ["bbs_admin_coordinator_remove", { handle: "lead" }],
      ["bbs_admin_user_add", { handle: "sneaky" }],
    ];
    for (const [who, token, headers] of [
      ["lead", lead, {}],
      ["plain", plain, {}],
      ["pat", pat, asCli],
    ] as const) {
      for (const [tool, args] of attempts) {
        const r = await api(server.url, token, tool, args, headers);
        expect(r.status, `${who} ${tool}`).toBe(403);
        expect(r.body.error.code).toBe("forbidden");
      }
    }
    // The coordinator on /mcp: the admin tools are not listed, and a call is refused.
    const c = await mcpClient(lead);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => n.startsWith("bbs_admin"))).toEqual([]);
    const viaMcp = await c.callTool({ name: "bbs_admin_reinstate", arguments: { handle: "victim" } });
    expect(viaMcp.isError).toBe(true);
    await c.close();
    // The coordinator through the CLI with its own token: denied (exit 12).
    const asLead = cliConfig("lead", lead);
    expect((await bbs(["admin", "reinstate", "victim"], asLead)).code).toBe(12);

    expect(await statusOf("victim")).toBe("kicked");
    const denied = await api(server.url, human, "bbs_audit", { action: "admin_reinstate", limit: 100 }, asCli);
    expect(denied.body.value.events.map((e: any) => [e.actor, e.result])).toEqual([
      ["lead", "denied"],
      ["plain", "denied"],
      ["pat", "denied"],
      ["lead", "denied"],
      ["lead", "denied"],
    ]);

    // The human admin reinstates through the CLI: a new token, shown once.
    const back = await bbs(["admin", "reinstate", "victim"], asOwner);
    expect(back.code, back.err).toBe(0);
    expect(back.err).toContain("shown once");
    const fresh = JSON.parse(back.out).token as string;
    expect(fresh).toMatch(/^bbs_/);
    expect(fresh).not.toBe(victim);
    const old = await api(server.url, victim, "bbs_topics", {});
    expect(old.status).toBe(401);
    expect(old.body.error.message).toMatch(/revoked_token/);
    expect((await api(server.url, fresh, "bbs_topics", {})).status).toBe(200);
    expect(await statusOf("victim")).toBe("active");

    const removed = await bbs(["admin", "coordinator", "remove", "lead"], asOwner);
    expect(removed.code, removed.err).toBe(0);
    const log = await api(server.url, human, "bbs_read", { topic: "admin-log", tail: true, limit: 3 }, asCli);
    expect(log.body.value.messages.map((m: any) => m.body)).toEqual([
      expect.stringMatching(/^kick: victim removed/),
      "reinstate: victim reinstated by owner (new token issued; not a coordinator)",
      "coordinator: lead removed by owner",
    ]);
  });
});

describe("B17: a new BBS_HUMAN_HANDLE retires the old admin", () => {
  it("after a restart with a new handle and credential, the old credential gets 401", async () => {
    await server.stop();
    const newToken = `human_rotated_${Date.now()}`;
    writeFileSync(run.envFile, `BBS_HUMAN_HANDLE=owner2\nBBS_HUMAN_TOKEN_SHA256=${sha256(newToken)}\n`, { mode: 0o600 });
    server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler2.log") });
    const old = await api(server.url, human, "bbs_topics", {}, asCli);
    expect(old.status).toBe(401);
    expect(old.body.error.message).toMatch(/revoked_token/);
    const who = await api(server.url, newToken, "bbs_who", {}, asCli);
    expect(who.status).toBe(200);
    const users = who.body.value.users as { handle: string; admin: boolean; kind: string }[];
    expect(users.filter((u) => u.admin).map((u) => u.handle)).toEqual(["owner2"]);
    expect(users.find((u) => u.handle === "owner")).toMatchObject({ kind: "human", admin: false });
    const boot = await api(server.url, newToken, "bbs_audit", { action: "bootstrap_human", limit: 10 }, asCli);
    expect(boot.body.value.events.at(-1)).toMatchObject({ actor: "system", target_id: "owner2" });
    expect(boot.body.value.events.at(-1).detail).toMatchObject({ created: true, retired: ["owner"] });
    human = newToken;
  });
});
