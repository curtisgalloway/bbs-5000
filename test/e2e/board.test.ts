// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// M1b acceptance, end to end under `wrangler dev`: the M1 criteria through
// /api, /mcp and the bbs CLI; bad tokens; human credential on /mcp.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { PEER_CONTENT_NOTICE } from "@bbs-5000/core";
import { api, groupAlive, makeRunDir, ROOT, startWrangler, type RunDir, type Server } from "./harness.ts";

let run: RunDir;
let server: Server;
let human: string;

/** Audit rows after `seq`, without the human's own audit reads. */
async function auditAfter(seq: number): Promise<any[]> {
  const r = await api(server.url, human, "bbs_audit", { after_seq: seq, limit: 1000 }, { "x-bbs-client": "cli" });
  expect(r.status).toBe(200);
  return r.body.value.events.filter((e: any) => !(e.action === "audit" && e.actor === run.humanHandle));
}

async function headSeq(): Promise<number> {
  const r = await api(server.url, human, "bbs_audit", { after_seq: 0, limit: 1000 }, { "x-bbs-client": "cli" });
  const events = r.body.value.events as { seq: number }[];
  return events.at(-1)?.seq ?? 0;
}

async function addUser(handle: string, kind: "agent" | "human" = "agent"): Promise<string> {
  const r = await api(server.url, human, "bbs_admin_user_add", { handle, kind }, { "x-bbs-client": "cli" });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.value.token as string;
}

beforeAll(async () => {
  run = makeRunDir();
  human = run.humanToken;
  server = await startWrangler({
    stateDir: run.stateDir,
    envFile: run.envFile,
    logFile: join(run.dir, "wrangler.log"),
  });
});

afterAll(async () => {
  await server?.stop();
  if (server) expect(groupAlive(server.pid)).toBe(false);
  run?.cleanup();
});

describe("/api", () => {
  it("runs the M1 flow with one audit row per action (A1.1–A1.4)", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");

    // A1.1: first join posts a Lobby system message and subscribes at digest.
    let seq = await headSeq();
    const join = await api(server.url, alice, "bbs_join", { role: "builder", harness: "claude-code" });
    expect(join.status).toBe(200);
    expect(join.body.value).toMatchObject({ handle: "alice", first_join: true });
    const session = join.body.value.session as string;
    let rows = await auditAfter(seq);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "alice",
      actor_kind: "agent",
      via: "api",
      action: "join",
      target_type: "session",
      target_id: session,
      result: "ok",
    });
    const lobby = await api(server.url, bob, "bbs_read", { topic: "Lobby" });
    expect(lobby.body.value.messages.at(-1)).toMatchObject({
      peer_content: true,
      author: "system",
      is_system: true,
      topic: "Lobby",
    });
    expect(lobby.body.value.messages.at(-1).body).toContain("alice joined");
    expect(lobby.body.peer_content_notice).toBe(PEER_CONTENT_NOTICE);
    const topics = await api(server.url, alice, "bbs_topics", {});
    expect(topics.body.value.topics.find((t: any) => t.name === "Lobby")).toMatchObject({ level: "digest" });

    // A1.2: any user creates a topic, posts anywhere, reads anywhere.
    const withSession = { "x-bbs-session": session };
    seq = await headSeq();
    expect((await api(server.url, alice, "bbs_topic_create", { name: "build" }, withSession)).status).toBe(200);
    const post = await api(server.url, bob, "bbs_post", { topic: "#build", body: "hello @alice" });
    expect(post.status).toBe(200);
    expect((await api(server.url, alice, "bbs_post", { topic: "Lobby", body: "hi all" }, withSession)).status).toBe(200);
    const read = await api(server.url, alice, "bbs_read", { topic: "build" });
    expect(read.body.value.messages.map((m: any) => [m.author, m.kind, m.via, m.body])).toEqual([
      ["bob", "agent", "api", "hello @alice"],
    ]);
    rows = await auditAfter(seq);
    expect(rows.map((r) => [r.actor, r.action, r.target_type, r.result])).toEqual([
      ["alice", "topic_create", "topic", "ok"],
      ["bob", "post", "message", "ok"],
      ["alice", "post", "message", "ok"],
    ]);
    expect(rows[0].session).toBe(session);
    expect(rows[0].target_id).toBe("build");

    // A1.3: inbox returns unread items and advances last_read_seq.
    const inbox = await api(server.url, alice, "bbs_inbox", {});
    expect(inbox.body.value.wake.map((m: any) => m.body)).toEqual(["hello @alice"]);
    const again = await api(server.url, alice, "bbs_inbox", {});
    expect(again.body.value.wake).toEqual([]);
    expect(again.body.value.digest).toEqual([]);
    const topicsAfter = await api(server.url, alice, "bbs_topics", {});
    expect(topicsAfter.body.value.topics.find((t: any) => t.name === "build")).toMatchObject({ unread: 0 });
  });

  it("answers a bad or missing token with 401 and a denied audit row (A1.5)", async () => {
    const seq = await headSeq();
    const bad = await api(server.url, "bbs_not-a-real-token", "bbs_topics", {});
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("unauthorized");
    const none = await api(server.url, undefined, "bbs_post", { topic: "Lobby", body: "x" });
    expect(none.status).toBe(401);
    const rows = await auditAfter(seq);
    expect(rows.map((r) => [r.actor, r.actor_kind, r.action, r.result, r.detail.reason])).toEqual([
      ["anonymous", "anonymous", "auth", "denied", "authentication failed: unknown_token"],
      ["anonymous", "anonymous", "auth", "denied", "authentication failed: missing_token"],
    ]);
    expect(rows[0].detail.endpoint).toBe("/api");
    expect(JSON.stringify(rows)).not.toContain("bbs_not-a-real-token");
  });

  it("does not let an unauthenticated caller set via, and refuses over-long tokens", async () => {
    const seq = await headSeq();
    const claimed = await api(server.url, "bbs_wrong", "bbs_topics", {}, { "x-bbs-client": "cli" });
    expect(claimed.status).toBe(401);
    // A real token with junk appended must not match after truncation.
    const real = await addUser("longtok");
    const long = await api(server.url, real + "x".repeat(600), "bbs_topics", {});
    expect(long.status).toBe(401);
    expect(long.body.error.message).toContain("token_too_long");
    const rows = (await auditAfter(seq)).filter((r) => r.action === "auth");
    expect(rows.map((r) => [r.via, r.result, r.detail.claimed_client ?? null, r.detail.reason])).toEqual([
      ["api", "denied", "cli", "authentication failed: unknown_token"],
      ["api", "denied", null, "authentication failed: token_too_long"],
    ]);
  });

  it("answers /health with a marker and no board data", async () => {
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "bbs-5000" });
  });

  it("records a person on the CLI as via=cli and refuses a person who names no client", async () => {
    const seq = await headSeq();
    const ok = await api(server.url, human, "bbs_post", { topic: "Lobby", body: "from the owner" }, { "x-bbs-client": "cli" });
    expect(ok.status).toBe(200);
    const plain = await api(server.url, human, "bbs_post", { topic: "Lobby", body: "no client" });
    expect(plain.status).toBe(403);
    // The phone app is not built in v1, so a script cannot label posts via=app-voice.
    // (`web` became a human client in M5, B22; see humans.test.ts.)
    const app = await api(server.url, human, "bbs_post", { topic: "Lobby", body: "app?" }, { "x-bbs-client": "app-voice" });
    expect(app.status).toBe(403);
    const rows = await auditAfter(seq);
    expect(rows.map((r) => [r.actor_kind, r.via, r.action, r.result])).toEqual([
      ["human", "cli", "post", "ok"],
      ["human", "api", "post", "denied"],
      ["human", "api", "post", "denied"],
    ]);
    const lobby = await api(server.url, human, "bbs_read", { topic: "Lobby" }, { "x-bbs-client": "cli" });
    const mine = lobby.body.value.messages.filter((m: any) => m.author === run.humanHandle);
    expect(mine.map((m: any) => [m.kind, m.via, m.body])).toEqual([["human", "cli", "from the owner"]]);
  });

  it("refuses another handle's session (B7), an admin tool for an agent, and bad JSON", async () => {
    const carol = await addUser("carol");
    const dave = await addUser("dave");
    const daveSession = (await api(server.url, dave, "bbs_join", {})).body.value.session;
    const spoof = await api(server.url, carol, "bbs_post", { topic: "Lobby", body: "x" }, { "x-bbs-session": daveSession });
    expect(spoof.status).toBe(403);
    const admin = await api(server.url, carol, "bbs_admin_user_add", { handle: "eve" });
    expect(admin.status).toBe(403);
    let seq = await headSeq();
    const badJson = await api(server.url, carol, "bbs_post", "{not json");
    expect(badJson.status).toBe(400);
    expect(badJson.body.error).toEqual({ code: "bad_request", message: "invalid JSON" });
    expect((await auditAfter(seq)).map((r) => [r.actor, r.action, r.result, r.detail.code, r.detail.tool])).toEqual([
      ["carol", "api", "denied", "bad_request", "bbs_post"],
    ]);
    const get = await fetch(`${server.url}/api/bbs_topics`, { headers: { authorization: `Bearer ${carol}` } });
    expect(get.status).toBe(405);
    expect((await fetch(`${server.url}/nowhere`)).status).toBe(404);
    seq = await headSeq();
    const huge = await api(server.url, carol, "bbs_post", { topic: "Lobby", body: "x".repeat(300 * 1024) });
    expect(huge.status).toBe(413);
    // A stream body: Node's fetch sends it chunked, with no content-length.
    // The cap still holds, on /api and /mcp.
    const chunked = async (path: string) => {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent >= 400 * 1024) return c.close();
          sent += 16 * 1024;
          c.enqueue(new Uint8Array(16 * 1024).fill(0x20));
        },
      });
      const res = await fetch(`${server.url}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${carol}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body,
        duplex: "half",
      } as RequestInit);
      return res.status;
    };
    expect(await chunked("/api/bbs_post")).toBe(413);
    expect(await chunked("/mcp")).toBe(413);
    const rows = await auditAfter(seq);
    expect(rows.map((r) => [r.actor, r.action, r.result, r.detail.reason, r.detail.endpoint])).toEqual([
      ["carol", "request", "denied", "request body too large", "/api"],
      ["carol", "request", "denied", "request body too large", "/api"],
      ["carol", "request", "denied", "request body too large", "/mcp"],
    ]);
  });
});

async function mcpClient(token: string, headers: Record<string, string> = {}): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } },
  });
  const client = new Client({ name: "bbs-e2e", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("/mcp", () => {
  it("lists the agent tools and runs the M1 flow through them", async () => {
    const frank = await addUser("frank");
    const gina = await addUser("gina");
    const c = await mcpClient(frank);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "bbs_audit",
      "bbs_inbox",
      "bbs_join",
      "bbs_post",
      "bbs_read",
      "bbs_role_set",
      "bbs_subscribe",
      "bbs_task_assign",
      "bbs_task_block",
      "bbs_task_claim",
      "bbs_task_comment",
      "bbs_task_create",
      "bbs_task_list",
      "bbs_task_unblock",
      "bbs_task_update",
      // M6b: archiving (force is refused for every agent inside core, B37).
      "bbs_topic_archive",
      "bbs_topic_create",
      // Agent defaults (D12): keep a topic's description (its repositories) current.
      "bbs_topic_describe",
      "bbs_topic_keep",
      "bbs_topic_unarchive",
      "bbs_topics",
      "bbs_who",
      // Offered on /mcp so a connector chat can ask who it is signed in as.
      "bbs_whoami",
    ]);
    expect(tools.find((t) => t.name === "bbs_post")?.inputSchema).toMatchObject({ required: ["topic", "body"] });

    const seq = await headSeq();
    const joined = await c.callTool({ name: "bbs_join", arguments: { role: "reviewer" } });
    expect(joined.isError).toBe(false);
    const session = (joined.structuredContent as any).session as string;
    await c.close();
    const s = await mcpClient(frank, { "x-bbs-session": session });
    expect((await s.callTool({ name: "bbs_topic_create", arguments: { name: "review" } })).isError).toBe(false);
    const g = await mcpClient(gina);
    expect((await g.callTool({ name: "bbs_post", arguments: { topic: "review", body: "ptal" } })).isError).toBe(false);
    const read = await s.callTool({ name: "bbs_read", arguments: { topic: "review" } });
    const text = (read.content as { text: string }[])[0]?.text ?? "";
    expect(text.split("\n")[0]).toMatch(/peer content/i);
    expect((read.structuredContent as any).messages[0]).toMatchObject({
      peer_content: true,
      author: "gina",
      kind: "agent",
      via: "mcp",
      topic: "review",
      body: "ptal",
    });
    const inbox = await s.callTool({ name: "bbs_inbox", arguments: {} });
    expect((inbox.structuredContent as any).wake.map((m: any) => m.body)).toEqual(["ptal"]);
    const bad = await s.callTool({ name: "bbs_post", arguments: { topic: "review" } });
    expect(bad.isError).toBe(true);
    await s.close();
    await g.close();

    const rows = await auditAfter(seq);
    expect(rows.map((r) => [r.actor, r.via, r.action, r.result])).toEqual([
      ["frank", "mcp", "join", "ok"],
      ["frank", "mcp", "topic_create", "ok"],
      ["gina", "mcp", "post", "ok"],
      ["frank", "mcp", "inbox", "ok"],
      ["frank", "mcp", "post", "error"],
    ]);
    expect(rows[1].session).toBe(session);
  });

  it("refuses the human credential (403, denied) and a bad token (401, denied)", async () => {
    const seq = await headSeq();
    await expect(mcpClient(human)).rejects.toThrow(/forbidden|403/);
    await expect(mcpClient("bbs_wrong")).rejects.toThrow();
    const rows = await auditAfter(seq);
    expect(rows.map((r) => [r.actor, r.actor_kind, r.via, r.result])).toEqual([
      [run.humanHandle, "human", "mcp", "denied"],
      ["anonymous", "anonymous", "mcp", "denied"],
    ]);
    expect(rows[1].detail.endpoint).toBe("/mcp");
  });
});

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

describe("bbs CLI", () => {
  it("adds a user as the human admin, then works as that agent", async () => {
    const humanConfig = join(run.dir, "human.json");
    writeFileSync(humanConfig, JSON.stringify({ url: server.url, token: human }), { mode: 0o600 });
    const asHuman = { BBS_CONFIG: humanConfig };

    expect((await bbs(["doctor"], asHuman)).code).toBe(0);
    const added = await bbs(["admin", "user", "add", "hank", "--role", "cli tester"], asHuman);
    expect(added.code, added.err).toBe(0);
    expect(added.err).toContain("shown once");
    const token = JSON.parse(added.out).token as string;
    expect(token).toMatch(/^bbs_/);
    expect((await bbs(["admin", "user", "add", "hank"], asHuman)).code).toBe(30);

    const agentConfig = join(run.dir, "hank.json");
    writeFileSync(agentConfig, JSON.stringify({ url: server.url, token }), { mode: 0o600 });
    const asHank = { BBS_CONFIG: agentConfig };
    const joined = await bbs(["join"], asHank);
    expect(joined.code, joined.err).toBe(0);
    const session = JSON.parse(joined.out).session as string;
    const withSession = { ...asHank, BBS_SESSION: session };
    expect((await bbs(["topic", "create", "cli-topic", "--description", "made by bbs"], withSession)).code).toBe(0);
    expect((await bbs(["post", "cli-topic", "first post"], withSession)).code).toBe(0);
    const read = await bbs(["read", "cli-topic"], withSession);
    expect(read.code).toBe(0);
    expect(JSON.parse(read.out).messages[0]).toMatchObject({ author: "hank", via: "api", body: "first post" });
    expect((await bbs(["post", "cli-topic", "from the person"], asHuman)).code).toBe(0);
    const inbox = await bbs(["inbox"], withSession);
    expect(JSON.parse(inbox.out).wake.map((m: any) => [m.author, m.kind, m.via])).toEqual([
      [run.humanHandle, "human", "cli"],
    ]);
    expect((await bbs(["read", "no-such-topic"], withSession)).code).toBe(30);
    expect((await bbs(["admin", "user", "add", "x"], asHank)).code).toBe(12);

    const badConfig = join(run.dir, "bad.json");
    writeFileSync(badConfig, JSON.stringify({ url: server.url, token: "bbs_wrong" }));
    expect((await bbs(["topics"], { BBS_CONFIG: badConfig })).code).toBe(10);
  });
});
