// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// M4b acceptance under `wrangler dev`: the wake budget (A4.3) with a
// scripted adapter, and a kick closing the agent's live socket (A4.1, B48)
// for both the scripted adapter and the real adapter's board connection
// (`BoardSocket`), which stops and does not reconnect. The board runs with a
// 1 s debounce, a budget of 2 doorbells per minute, and 1.5 s Lobby spans so
// a flood reaches a kick inside the test.

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BoardSocket } from "../../packages/adapter/src/board-socket.ts";
import { api, groupAlive, makeRunDir, sleep, startWrangler, type RunDir, type Server } from "./harness.ts";
import { ScriptedAdapter } from "./scripted-adapter.ts";

const DEBOUNCE_MS = 1000;
const QUIET_MS = DEBOUNCE_MS + 1500;
const BUDGET = 2;
const SPAN_MS = 1500;

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

async function adminLog(): Promise<string[]> {
  return ((await call(human, "bbs_read", { topic: "admin-log", limit: 200 }, asCli)).messages as { body: string }[]).map(
    (m) => m.body,
  );
}

/** Post to the Lobby until the first refusal; returns it. */
async function flood(token: string, tag: string): Promise<{ status: number; body: any }> {
  for (let i = 0; i < 20; i++) {
    const r = await api(server.url, token, "bbs_post", { topic: "Lobby", body: `${tag}-${i}` });
    if (r.status !== 200) return r;
  }
  throw new Error("never refused");
}

/** Walk an agent through warn, mute (lifted by the alarm) and kick; returns the kicking refusal. */
async function kick(token: string, handle: string): Promise<{ status: number; body: any }> {
  await flood(token, "one");
  await sleep(SPAN_MS + 200);
  await flood(token, "two");
  const deadline = Date.now() + 15_000;
  for (;;) {
    const who = await call(human, "bbs_who", {}, asCli);
    if ((who.users as { handle: string; status: string }[]).find((u) => u.handle === handle)?.status === "active") break;
    if (Date.now() > deadline) throw new Error("mute was not lifted");
    await sleep(250);
  }
  await sleep(SPAN_MS + 200);
  return flood(token, "three");
}

beforeAll(async () => {
  run = makeRunDir("owner", {
    BBS_DOORBELL_DEBOUNCE_MS: String(DEBOUNCE_MS),
    BBS_WAKE_BUDGET: String(BUDGET),
    BBS_WAKE_BUDGET_WINDOW_MS: "60000",
    BBS_LOBBY_WINDOW_MS: String(SPAN_MS),
    BBS_LOBBY_MUTE_MS: String(SPAN_MS),
  });
  human = run.humanToken;
  server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
});

afterAll(async () => {
  for (const s of sockets) s.close();
  await server?.stop();
  if (server) expect(groupAlive(server.pid)).toBe(false);
  run?.cleanup();
});

describe("wake budget (A4.3)", () => {
  it("past the budget, events arrive as digest and the coordinator is told", async () => {
    const a = await addUser("wa");
    const b = await addUser("wb");
    const lead = await addUser("wlead");
    await call(human, "bbs_admin_coordinator_grant", { handle: "wlead" }, asCli);
    await call(a, "bbs_join", {});
    await call(lead, "bbs_join", {});
    const session = (await call(b, "bbs_join", { harness: "scripted" })).session as string;
    await call(a, "bbs_topic_create", { name: "wt" });
    await call(b, "bbs_subscribe", { topic: "wt", level: "wake" });
    await call(b, "bbs_inbox", {});
    const sock = await ScriptedAdapter.connect(server.url, b);
    sockets.push(sock);
    sock.hello(session, "idle");
    await sleep(200);

    // Within the budget: each post rings once.
    for (let n = 1; n <= BUDGET; n++) {
      await call(a, "bbs_post", { topic: "wt", body: `ring ${n}` });
      const d = await sock.nthDoorbell(n, 10_000);
      expect(d?.text).toBe("BBS-5000: 1 new in #wt. Call bbs_inbox now, then continue your task.");
      sock.send({ type: "ring_result", id: d!.id, result: "turn_started", confirmed: true });
      await call(b, "bbs_inbox", {});
    }

    // Past it: no ring, an agent's @mention included; the inbox still has everything.
    await call(a, "bbs_post", { topic: "wt", body: "over the budget" });
    await call(a, "bbs_post", { topic: "Lobby", body: "@wb a mention past the budget" });
    await sleep(QUIET_MS);
    expect(sock.doorbells()).toHaveLength(BUDGET);
    const inbox = await call(b, "bbs_inbox", {});
    expect(inbox.wake.map((m: any) => m.topic).sort()).toEqual(["Lobby", "wt"]);
    expect(inbox.notices).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "admin", reason: "wake_budget" })]));

    // One #admin-log line, the fallback on the record, and the coordinator told.
    expect((await adminLog()).filter((l) => l.startsWith("wake budget:"))).toEqual([
      expect.stringMatching(/^wake budget: wb reached 2 doorbells in 1 minute; further events fall back to digest until /),
    ]);
    const due = (await audit({ action: "doorbell_due" })).filter((e) => e.target_id === "wb");
    expect(due.at(-1)?.detail).toMatchObject({ ring: { result: "over_budget" } });
    const exceeded = await audit({ action: "wake_budget_exceeded" });
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]).toMatchObject({ actor: "system", detail: { outcome: "fallback", rung: BUDGET } });
    const leadInbox = await call(lead, "bbs_inbox", {});
    expect(leadInbox.notices).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "admin", reason: "wake_budget", as: "coordinator" })]),
    );

    // Still over: a further event writes no second line and does not ring.
    await call(a, "bbs_post", { topic: "wt", body: "still over" });
    await sleep(QUIET_MS);
    expect(sock.doorbells()).toHaveLength(BUDGET);
    expect((await adminLog()).filter((l) => l.startsWith("wake budget:"))).toHaveLength(1);

    // A person's @mention rings even past the budget (B52, decided by Curtis).
    await call(human, "bbs_post", { topic: "Lobby", body: "@wb please answer" }, asCli);
    const d = await sock.nthDoorbell(BUDGET + 1, 10_000);
    expect(d?.text).toMatch(/1 new in #Lobby \(1 mention\)/);
    const rung = (await audit({ action: "doorbell_due" })).filter((e) => e.target_id === "wb").at(-1);
    expect(rung?.detail).toMatchObject({ ring: { result: "rung", past_budget: "human_mention" } });
  });
});

describe("kick closes the live socket (A4.1, B48)", () => {
  it("the scripted adapter gets a kicked frame and close 4004; the old token cannot reconnect", async () => {
    const token = await addUser("kx");
    const session = (await call(token, "bbs_join", { harness: "scripted" })).session as string;
    const sock = await ScriptedAdapter.connect(server.url, token);
    sockets.push(sock);
    sock.hello(session, "idle");
    await sleep(200);

    const third = await kick(token, "kx");
    expect(third.status).toBe(429);
    expect(third.body.error.message).toMatch(/removed from the board/);
    // Closed in the same request: by the time the refusal is back, the close is on its way.
    expect(await sock.waitClosed(3000)).toMatchObject({ code: 4004, reason: "kicked: token revoked" });
    expect(sock.frames.map((f) => f.data.type)).toContain("kicked");

    const closed = await audit({ action: "sockets_closed" });
    const row = closed.find((e) => e.target_id === "kx");
    expect(row).toMatchObject({ actor: "system", detail: { reason: "kicked", closed: 1, code: 4004 } });
    const kickRow = (await audit({ action: "lobby_offense" })).find((e) => e.detail.outcome === "kicked" && e.target_id === "kx");
    expect(row.request_id).toBe(kickRow.request_id);

    // A reconnect with the old token is refused at sign-in.
    await expect(ScriptedAdapter.connect(server.url, token)).rejects.toThrow();
    const denied = (await audit({ actor: "kx", action: "auth" })).at(-1);
    expect(denied).toMatchObject({ result: "denied", detail: { revoked: "kicked", endpoint: "/ws" } });
  });

  it("the real adapter's board connection stops on the kick and does not reconnect", async () => {
    const token = await addUser("ky");
    let session: string | undefined;
    const logs: { event: string; detail?: Record<string, unknown> }[] = [];
    let stoppedWhy: string | undefined;
    const socket = new BoardSocket({
      url: server.url,
      token,
      session: () => session,
      ensureSession: async () => {
        session = (await call(token, "bbs_join", { harness: "claude-code" })).session as string;
      },
      resetSession: () => {
        session = undefined;
      },
      harness: "claude-code",
      state: () => "idle",
      onDoorbell: () => undefined,
      onStopped: (why) => {
        stoppedWhy = why;
      },
      log: (event, detail) => logs.push({ event, ...(detail ? { detail } : {}) }),
      initialBackoffMs: 200,
    });
    socket.start();
    const attachedBy = Date.now() + 5000;
    while (!socket.connected && Date.now() < attachedBy) await sleep(50);
    expect(socket.connected).toBe(true);
    await sleep(200);

    await kick(token, "ky");
    const stopBy = Date.now() + 5000;
    while (stoppedWhy === undefined && Date.now() < stopBy) await sleep(50);
    expect(stoppedWhy).toBe("kicked");
    expect(logs.map((l) => l.event)).toContain("kicked");
    // No reconnect attempt after the stop.
    await sleep(1000);
    expect(logs.filter((l) => l.event === "reconnect_scheduled")).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain(token);
  });
});
