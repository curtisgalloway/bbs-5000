// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// Issue #98 under `wrangler dev`: several local sessions on one token each get
// a handle of their own. Two `bbs` CLI sessions with different
// `--harness-session` values both stay joined and each reads only its own
// mention; two adapter sockets on one token attach to their own sessions and
// only the one that is mentioned is rung; a rejoin gets the same handle back
// and closes only its own earlier socket; and two real adapter processes with
// different Claude Code session ids do the same through their channels.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { run as cliRun } from "../../packages/cli/src/main.ts";
import { api, groupAlive, makeRunDir, ROOT, sleep, startWrangler, type RunDir, type Server } from "./harness.ts";
import { ScriptedAdapter } from "./scripted-adapter.ts";

const BIN = join(ROOT, "packages/adapter/bin/bbs-adapter.js");
const DEBOUNCE_MS = 1000;
const QUIET_MS = DEBOUNCE_MS + 1500;

let run: RunDir;
let server: Server;
let human: string;
const asCli = { "x-bbs-client": "cli" };
const sockets: ScriptedAdapter[] = [];
const clients: Client[] = [];

async function addUser(handle: string): Promise<string> {
  const r = await api(server.url, human, "bbs_admin_user_add", { handle }, asCli);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.value.token as string;
}

async function call(token: string, tool: string, args: unknown = {}, session?: string): Promise<any> {
  const r = await api(server.url, token, tool, args, session !== undefined ? { "x-bbs-session": session } : {});
  expect(r.status, `${tool}: ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.value;
}

/** One `bbs` command as a person's shell runs it: its stdout parsed as JSON, and its stderr. */
async function bbs(token: string, argv: string[], session?: string): Promise<{ code: number; value: any; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const env = { BBS_URL: server.url, BBS_TOKEN: token, ...(session !== undefined ? { BBS_SESSION: session } : {}) };
  const code = await cliRun(argv, env, { out: (t) => void out.push(t), err: (t) => void err.push(t) });
  return { code, value: out.length > 0 ? JSON.parse(out.join("")) : undefined, err: err.join("\n") };
}

beforeAll(async () => {
  run = makeRunDir("owner", { BBS_DOORBELL_DEBOUNCE_MS: String(DEBOUNCE_MS) });
  human = run.humanToken;
  server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
});

afterAll(async () => {
  for (const s of sockets) s.close();
  for (const c of clients) await c.close().catch(() => undefined);
  await server?.stop();
  if (server) expect(groupAlive(server.pid)).toBe(false);
  run?.cleanup();
});

describe("two CLI sessions on one token", () => {
  it("both stay joined, each acts as its own handle and reads only its own mention", async () => {
    const p = await addUser("cp");
    const a = await addUser("ca");
    await call(a, "bbs_join", {});
    await call(a, "bbs_topic_create", { name: "ct" });

    const one = await bbs(p, ["join", "--harness-session", "hs-one", "--role", "first"]);
    const two = await bbs(p, ["join", "--harness-session", "hs-two", "--role", "second"]);
    expect([one.code, two.code]).toEqual([0, 0]);
    expect(one.value.handle).toMatch(/^cp-[a-z2-7]{4}$/);
    expect(two.value.handle).toMatch(/^cp-[a-z2-7]{4}$/);
    expect(one.value.handle).not.toBe(two.value.handle);
    expect(one.value).toMatchObject({ parent: "cp", first_join: true });
    expect(one.err).toMatch(/this session acts as cp-[a-z2-7]{4}/);

    // `bbs whoami` agrees with what the join printed, with the session and without it.
    const who1 = await bbs(p, ["whoami"], one.value.session);
    const who2 = await bbs(p, ["whoami"], two.value.session);
    expect(who1.value).toMatchObject({ handle: one.value.handle, parent: "cp", session: one.value.session });
    expect(who2.value).toMatchObject({ handle: two.value.handle, parent: "cp" });
    expect((await bbs(p, ["whoami"])).value).toMatchObject({ handle: "cp" });
    expect((await bbs(p, ["whoami"])).value).not.toHaveProperty("parent");

    // Both are on the board, live, as handles under cp; the session ids are not shown.
    const board = await call(a, "bbs_who", {});
    const mine = board.users.filter((u: any) => u.parent === "cp");
    expect(mine.map((u: any) => u.handle).sort()).toEqual([one.value.handle, two.value.handle].sort());
    expect(mine.every((u: any) => u.session === "idle")).toBe(true);
    expect(JSON.stringify(board)).not.toContain(one.value.session);

    // A mention of the first reaches the first only.
    await call(a, "bbs_post", { topic: "ct", body: `@${one.value.handle} the parser is yours` });
    await call(a, "bbs_post", { topic: "ct", body: `@${two.value.handle} the lexer is yours` });
    const in1 = JSON.stringify((await bbs(p, ["inbox"], one.value.session)).value);
    const in2 = JSON.stringify((await bbs(p, ["inbox"], two.value.session)).value);
    const inP = JSON.stringify((await bbs(p, ["inbox"])).value);
    expect(in1).toContain("the parser is yours");
    expect(in1).not.toContain("the lexer is yours");
    expect(in2).toContain("the lexer is yours");
    expect(in2).not.toContain("the parser is yours");
    expect(inP).not.toContain("is yours");

    // A rejoin with the same harness session is the same handle, and ends only its own earlier session.
    const again = await bbs(p, ["join", "--harness-session", "hs-one"]);
    expect(again.value.handle).toBe(one.value.handle);
    expect(again.value.session).not.toBe(one.value.session);
    expect((await bbs(p, ["whoami"], two.value.session)).code).toBe(0);
    const stale = await bbs(p, ["whoami"], one.value.session);
    expect(stale.code).not.toBe(0);

    // A session id that belongs to another token's session handle is refused like an unknown one.
    const other = await addUser("cq");
    const theirs = await bbs(other, ["join", "--harness-session", "hs-q"]);
    const foreign = await bbs(p, ["whoami"], theirs.value.session);
    const unknown = await bbs(p, ["whoami"], "s_no_such_session");
    expect(foreign.code).not.toBe(0);
    expect(foreign.err).toBe(unknown.err);
  });
});

describe("adapter sockets on one token", () => {
  it("each socket attaches to its own session and only the mentioned one is rung; a rejoin closes only its own earlier socket", async () => {
    const p = await addUser("sp");
    const a = await addUser("sa");
    await call(a, "bbs_join", {});
    await call(a, "bbs_topic_create", { name: "st" });
    const one = await call(p, "bbs_join", { harness: "scripted", harness_session: "hs-one" });
    const two = await call(p, "bbs_join", { harness: "scripted", harness_session: "hs-two" });
    expect(one.handle).not.toBe(two.handle);
    await call(p, "bbs_inbox", {}, one.session);
    await call(p, "bbs_inbox", {}, two.session);

    const sock1 = await ScriptedAdapter.connect(server.url, p);
    const sock2 = await ScriptedAdapter.connect(server.url, p);
    sockets.push(sock1, sock2);
    sock1.hello(one.session, "idle");
    sock2.hello(two.session, "idle");
    await sleep(300);
    const board = await call(a, "bbs_who", {});
    for (const h of [one.handle, two.handle]) {
      expect(board.users.find((u: any) => u.handle === h).sessions).toMatchObject([{ wake: "adapter" }]);
    }

    await call(a, "bbs_post", { topic: "st", body: `@${one.handle} please look` });
    const first = await sock1.nthDoorbell(1, 10_000);
    expect(first?.text).toMatch(/^BBS-5000: 1 mention/);
    await sleep(QUIET_MS);
    expect(sock2.doorbells()).toHaveLength(0);
    sock1.send({ type: "ring_result", id: first!.id, result: "turn_started", confirmed: true });

    await call(a, "bbs_post", { topic: "st", body: `@${two.handle} you too` });
    expect(await sock2.nthDoorbell(1, 10_000)).toBeDefined();
    expect(sock1.doorbells()).toHaveLength(1);

    // The first one's conversation is resumed: same handle, a new session; its old socket is closed, the other's is not.
    const again = await call(p, "bbs_join", { harness: "scripted", harness_session: "hs-one" });
    expect(again.handle).toBe(one.handle);
    expect(await sock1.waitClosed(5000)).toMatchObject({ code: 4001 });
    await sleep(300);
    expect(sock2.closed).toBeUndefined();
    const sock3 = await ScriptedAdapter.connect(server.url, p);
    sockets.push(sock3);
    sock3.hello(again.session, "idle");
    await sleep(300);
    await call(a, "bbs_post", { topic: "st", body: `@${one.handle} once more` });
    expect(await sock3.nthDoorbell(1, 10_000)).toBeDefined();
  });
});

describe("two real adapter processes on one token", () => {
  interface Adapter {
    client: Client;
    events: { at: number; content: string }[];
    session: string;
    handle: string;
  }

  async function start(token: string, name: string, claudeSession: string): Promise<Adapter> {
    const dir = join(run.dir, name);
    mkdirSync(dir, { recursive: true });
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ url: server.url, token }), { mode: 0o600 });
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      BBS_CONFIG: config,
      BBS_ADAPTER_LOG: join(dir, "adapter.jsonl"),
      BBS_MACHINE: "workstation-1",
      BBS_ADAPTER_SOCKET_DIR: join(dir, "sock"),
      CLAUDE_CODE_MESSAGING_SOCKET: join(dir, "claude-messaging.sock"),
      CLAUDE_CODE_SESSION_ID: claudeSession,
    };
    const client = new Client({ name: "fake-claude-code", version: "0" });
    const events: Adapter["events"] = [];
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === "notifications/claude/channel") {
        events.push({ at: Date.now(), content: String((n.params as Record<string, unknown>)?.content) });
      }
    };
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], env, stderr: "ignore" }));
    clients.push(client);
    // Who the adapter acts as, through its own tools: the session it joined with and the handle it names.
    const me = (await client.callTool({ name: "bbs_whoami", arguments: {} })).structuredContent as Record<string, unknown>;
    return { client, events, session: String(me.session), handle: String(me.handle) };
  }

  it("each joins with its own Claude Code session id, acts as its own handle, and only the mentioned one is woken", async () => {
    const p = await addUser("rp");
    const a = await addUser("ra");
    await call(a, "bbs_join", {});
    await call(a, "bbs_topic_create", { name: "rt" });
    const one = await start(p, "rp1", "claude-session-one");
    const two = await start(p, "rp2", "claude-session-two");
    // The adapter joined before its first tool call, and the second did not end the first.
    expect(one.handle).toMatch(/^rp-[a-z2-7]{4}$/);
    expect(two.handle).toMatch(/^rp-[a-z2-7]{4}$/);
    expect(one.handle).not.toBe(two.handle);
    // Both sockets attach shortly after the joins.
    const ready = (us: any[]): boolean =>
      us.length === 2 && us.every((u) => u.session === "idle" && u.sessions.length > 0 && u.sessions.every((s: any) => s.wake === "adapter"));
    let mine: any[] = [];
    for (const until = Date.now() + 40_000; Date.now() < until && !ready(mine); await sleep(250)) {
      const board = await call(a, "bbs_who", {});
      mine = board.users.filter((u: any) => u.parent === "rp");
    }
    expect(mine.map((u: any) => u.handle).sort()).toEqual([one.handle, two.handle].sort());
    expect(mine.map((u: any) => [u.session, u.sessions.map((s: any) => s.wake)])).toEqual([
      ["idle", ["adapter"]],
      ["idle", ["adapter"]],
    ]);

    await call(a, "bbs_post", { topic: "rt", body: `@${two.handle} look at this` });
    const deadline = Date.now() + 10_000;
    while (two.events.length < 1 && Date.now() < deadline) await sleep(50);
    expect(two.events[0]?.content).toMatch(/^BBS-5000: 1 mention/);
    await sleep(QUIET_MS);
    expect(one.events).toHaveLength(0);
    const inbox = (await two.client.callTool({ name: "bbs_inbox", arguments: {} })).structuredContent as { wake: { body: string }[] };
    expect(inbox.wake.map((m) => m.body).join("\n")).toContain("look at this");
    const none = (await one.client.callTool({ name: "bbs_inbox", arguments: {} })).structuredContent as { wake: unknown[] };
    expect(none.wake).toEqual([]);
  });

  it("an adapter that attaches and then closes shows wake none afterwards, and its handle can rejoin", async () => {
    const p = await addUser("wp");
    const a = await addUser("wa");
    await call(a, "bbs_join", {});
    const one = await start(p, "wp1", "claude-session-close");
    const sessionsOf = async (): Promise<any[]> => {
      const board = await call(a, "bbs_who", {});
      return board.users.find((u: any) => u.handle === one.handle)?.sessions ?? [];
    };
    let sessions: any[] = [];
    for (const until = Date.now() + 40_000; Date.now() < until && sessions[0]?.wake !== "adapter"; await sleep(250)) sessions = await sessionsOf();
    expect(sessions.map((s) => s.wake)).toEqual(["adapter"]);
    // The adapter goes away (Claude Code exits): its socket closes, and the board must notice.
    await one.client.close();
    for (const until = Date.now() + 40_000; Date.now() < until && sessions[0]?.wake !== "none"; await sleep(250)) sessions = await sessionsOf();
    expect(sessions.map((s) => s.wake)).toEqual(["none"]);
    // A new adapter for the same conversation gets the same handle and attaches again.
    const again = await start(p, "wp2", "claude-session-close");
    expect(again.handle).toBe(one.handle);
  });
});
