// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// M2 acceptance under `wrangler dev`, with a scripted adapter (spec §4.3) in
// place of a real agent: debounce, one pending doorbell, busy hold, Lobby
// digest vs mention, own posts, task assignment and unblock ringing (B23),
// attach after an offline period, a replaced session, and /ws auth. The
// debounce is 1 s here (BBS_DOORBELL_DEBOUNCE_MS); the real Durable Object
// alarm rings. Real Claude Code is the Curtis-run gate (test/manual/).

import { request } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, groupAlive, makeRunDir, sleep, startWrangler, type RunDir, type Server } from "./harness.ts";
import { ScriptedAdapter } from "./scripted-adapter.ts";

const DEBOUNCE_MS = 1000;
/** Long enough for the debounce, the alarm and the socket: a ring that has not come by then is not coming. */
const QUIET_MS = DEBOUNCE_MS + 1500;

let run: RunDir;
let server: Server;
let human: string;
const asCli = { "x-bbs-client": "cli" };
const sockets: ScriptedAdapter[] = [];

async function addUser(handle: string): Promise<string> {
  const r = await api(server.url, human, "bbs_admin_user_add", { handle }, asCli);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.value.token as string;
}

async function call(token: string, tool: string, args: unknown = {}, headers: Record<string, string> = {}): Promise<any> {
  const r = await api(server.url, token, tool, args, headers);
  expect(r.status, `${tool}: ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.value;
}

async function audit(filter: Record<string, unknown>): Promise<any[]> {
  return (await call(human, "bbs_audit", { limit: 1000, ...filter }, asCli)).events;
}

/** Two agents: a created #t; b joined, is in #t at wake, its inbox is empty, and its scripted adapter is attached idle. */
async function pair(prefix: string): Promise<{ a: string; b: string; bHandle: string; session: string; sock: ScriptedAdapter }> {
  const a = await addUser(`${prefix}a`);
  const b = await addUser(`${prefix}b`);
  await call(a, "bbs_join", {});
  const session = (await call(b, "bbs_join", { harness: "scripted" })).session as string;
  await call(a, "bbs_topic_create", { name: `${prefix}t` });
  await call(b, "bbs_subscribe", { topic: `${prefix}t`, level: "wake" });
  await call(b, "bbs_inbox", {});
  const sock = await ScriptedAdapter.connect(server.url, b);
  sockets.push(sock);
  sock.hello(session, "idle");
  await sleep(200);
  return { a, b, bHandle: `${prefix}b`, session, sock };
}

/** HTTP status of a WebSocket upgrade request to /ws (fetch refuses the upgrade header). */
function upgradeStatus(token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${server.url}/ws`, {
      headers: {
        authorization: `Bearer ${token}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  run = makeRunDir("owner", { BBS_DOORBELL_DEBOUNCE_MS: String(DEBOUNCE_MS) });
  human = run.humanToken;
  server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
});

afterAll(async () => {
  for (const s of sockets) s.close();
  await server?.stop();
  if (server) expect(groupAlive(server.pid)).toBe(false);
  run?.cleanup();
});

describe("/ws auth (spec §4.2)", () => {
  it("refuses the human credential (audited) and a bad token", async () => {
    await expect(ScriptedAdapter.connect(server.url, human)).rejects.toThrow();
    await expect(ScriptedAdapter.connect(server.url, "not-a-token")).rejects.toThrow();
    expect(await upgradeStatus(human)).toBe(403);
    expect(await upgradeStatus("not-a-token")).toBe(401);
    const plain = await fetch(`${server.url}/ws`);
    expect(plain.status).toBe(426);
    const refused = (await audit({ action: "ws" })).filter((e) => e.result === "denied");
    expect(refused.length).toBeGreaterThanOrEqual(2);
    expect(refused[0]).toMatchObject({ actor: "owner" });
  });

  it("closes on a message that is not the protocol, and on state before hello", async () => {
    const t = await addUser("proto");
    const s1 = await ScriptedAdapter.connect(server.url, t);
    s1.send({ type: "nonsense" });
    expect(await s1.waitClosed(3000)).toMatchObject({ code: 1008 });
    const s2 = await ScriptedAdapter.connect(server.url, t);
    s2.state("idle");
    expect(await s2.waitClosed(3000)).toMatchObject({ code: 4003 });
    const rows = await audit({ actor: "proto" });
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["socket_open", "socket_message", "socket_close"]),
    );
  });
});

describe("doorbells end to end (A2.2–A2.6)", () => {
  it("five posts give one doorbell; a second burst before inbox gives none; after inbox, a new one", async () => {
    const { a, b, sock } = await pair("d");
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await call(a, "bbs_post", { topic: "dt", body: `private words ${i}` });
    const first = await sock.nthDoorbell(1, 10_000);
    expect(first?.text).toBe("BBS-5000: 5 new in #dt. Call bbs_inbox now, then continue your task.");
    expect(first!.at - t0).toBeGreaterThanOrEqual(DEBOUNCE_MS - 100);
    expect(first!.at - t0).toBeLessThan(10_000);
    sock.send({ type: "ring_result", id: first!.id, result: "turn_started", confirmed: true });
    for (let i = 0; i < 3; i++) await call(a, "bbs_post", { topic: "dt", body: `more ${i}` });
    await sleep(QUIET_MS);
    expect(sock.doorbells()).toHaveLength(1);
    const inbox = await call(b, "bbs_inbox", {});
    expect(inbox.wake).toHaveLength(8);
    await call(a, "bbs_post", { topic: "dt", body: "after inbox" });
    expect((await sock.nthDoorbell(2, 10_000))?.text).toBe("BBS-5000: 1 new in #dt. Call bbs_inbox now, then continue your task.");
    const results = await audit({ action: "ring_result" });
    expect(results.at(-1)).toMatchObject({ actor: "db", via: "ws" });
  });

  it("a post while busy is held (audited) and rung when the turn ends", async () => {
    const { a, sock, bHandle } = await pair("h");
    sock.state("busy");
    await sleep(200);
    await call(a, "bbs_post", { topic: "ht", body: "while you work" });
    await sleep(QUIET_MS);
    expect(sock.doorbells()).toEqual([]);
    const held = (await audit({ action: "doorbell_due" })).filter((e) => e.target_id === bHandle);
    expect(held.at(-1)?.detail).toMatchObject({ ring: { result: "held_busy" } });
    const tIdle = Date.now();
    sock.state("idle");
    const d = await sock.nthDoorbell(1, 5000);
    expect(d?.text).toBe("BBS-5000: 1 new in #ht. Call bbs_inbox now, then continue your task.");
    expect(d!.at - tIdle).toBeLessThan(2000);
  });

  it("an unconfirmed ring rings again once hooks report state (B56)", async () => {
    const { a, b, sock } = await pair("u");
    await call(a, "bbs_post", { topic: "ut", body: "first" });
    const first = await sock.nthDoorbell(1, 10_000);
    sock.send({ type: "ring_result", id: first!.id, result: "turn_started", confirmed: false });
    await call(a, "bbs_post", { topic: "ut", body: "second" });
    await sleep(QUIET_MS);
    expect(sock.doorbells()).toHaveLength(1);
    sock.state("idle");
    const again = await sock.nthDoorbell(2, 5000);
    expect(again?.text).toBe("BBS-5000: 2 new in #ut. Call bbs_inbox now, then continue your task.");
    const inbox = await call(b, "bbs_inbox", {});
    expect(inbox.wake).toHaveLength(2);
  });

  it("a Lobby post does not ring; an @mention in the Lobby does; own posts never do", async () => {
    const { a, b, bHandle, sock } = await pair("l");
    await call(a, "bbs_post", { topic: "Lobby", body: "hello everyone" });
    await call(b, "bbs_post", { topic: "lt", body: `my own note, @${bHandle}` });
    await sleep(QUIET_MS);
    expect(sock.doorbells()).toEqual([]);
    await call(a, "bbs_post", { topic: "Lobby", body: `@${bHandle} over here` });
    expect((await sock.nthDoorbell(1, 10_000))?.text).toBe("BBS-5000: 1 new in #Lobby (1 mention). Call bbs_inbox now, then continue your task.");
    const inbox = await call(b, "bbs_inbox", {});
    expect(inbox.wake.map((m: any) => m.topic)).toEqual(["Lobby"]);
  });

  it("an agent with no adapter attached is rung when it attaches", async () => {
    const { a, b, session, sock } = await pair("o");
    sock.close();
    await sock.waitClosed(3000);
    await sleep(200);
    await call(a, "bbs_post", { topic: "ot", body: "while away" });
    await sleep(QUIET_MS);
    const back = await ScriptedAdapter.connect(server.url, b);
    sockets.push(back);
    back.hello(session, "idle");
    expect((await back.nthDoorbell(1, 5000))?.text).toBe("BBS-5000: 1 new in #ot. Call bbs_inbox now, then continue your task.");
  });

  it("a later bbs_join replaces the session and closes its socket (B19)", async () => {
    const { b, session, sock } = await pair("r");
    await call(b, "bbs_join", {});
    expect(await sock.waitClosed(3000)).toMatchObject({ code: 4001 });
    const stale = await api(server.url, b, "bbs_topics", {}, { "x-bbs-session": session });
    expect(stale.status).toBe(401);
    // Re-join with your live session keeps it.
    const fresh = (await call(b, "bbs_join", {})).session as string;
    const again = await call(b, "bbs_join", { role: "tester" }, { "x-bbs-session": fresh });
    expect(again.session).toBe(fresh);
  });
});

describe("task notices ring (B23)", () => {
  it("assignment and unblock each ring the assignee; bbs_inbox shows the notices", async () => {
    const { a, b, bHandle, sock } = await pair("k");
    const id = (await call(a, "bbs_task_create", { topic: "kt", title: "build it" })).task.id as number;
    const blocker = (await call(a, "bbs_task_create", { topic: "kt", title: "first this" })).task.id as number;
    await call(a, "bbs_task_assign", { task: id, assignee: bHandle });
    const d1 = await sock.nthDoorbell(1, 10_000);
    expect(d1?.text).toBe("BBS-5000: 1 task assigned. Call bbs_inbox now, then continue your task.");
    sock.send({ type: "ring_result", id: d1!.id, result: "turn_started" });
    const inbox1 = await call(b, "bbs_inbox", {});
    expect(inbox1.notices).toMatchObject([{ kind: "task", reason: "task_assigned", task: id, wake: true }]);
    await call(b, "bbs_task_update", { task: id, state: "in_progress" });
    await call(b, "bbs_task_block", { task: id, blocked_by: [blocker] });
    await call(b, "bbs_inbox", {});
    await call(a, "bbs_task_assign", { task: blocker, assignee: "ka" });
    for (const state of ["in_progress", "in_review"]) {
      await call(a, "bbs_task_update", { task: blocker, state });
    }
    await call(human, "bbs_task_update", { task: blocker, state: "done" }, asCli);
    const d2 = await sock.nthDoorbell(2, 10_000);
    expect(d2?.text).toBe("BBS-5000: 1 task unblocked. Call bbs_inbox now, then continue your task.");
    const inbox2 = await call(b, "bbs_inbox", {});
    expect(inbox2.notices.map((n: any) => n.reason)).toEqual(["task_unblocked"]);
  });
});
