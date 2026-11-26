// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// F, scenario (b), under `wrangler dev`: an agent holding a task floods the
// Lobby: warned, muted (lifted by the alarm), then kicked. Its live socket
// gets the kicked frame and close 4004, its held task goes stale and the
// coordinator is told (M3 × M4). The human admin reinstates it with a new
// token; the old token stays dead; its adapter reconnects with the new token
// and is rung again (M2 × M4 × M5).
//
// The board also runs with `BBS_TEST_SOCKET_FAULTS=keep_kicked` and without
// `BBS_ALLOW_TEST_FAULTS`: the startup check (B55) must refuse the fault, so
// the kick still closes the socket.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asCli, startBoard, until, type Board } from "./final-helpers.ts";
import { sleep } from "./harness.ts";
import { ScriptedAdapter } from "./scripted-adapter.ts";

const DEBOUNCE_MS = 1000;
// The Lobby rate window and mute length. Wide enough that a burst of posts
// over HTTP fits inside one window even on a slow CI runner (F review).
const SPAN_MS = 3000;

let b: Board;
const sockets: ScriptedAdapter[] = [];

beforeAll(async () => {
  b = await startBoard({
    BBS_DOORBELL_DEBOUNCE_MS: String(DEBOUNCE_MS),
    BBS_LOBBY_WINDOW_MS: String(SPAN_MS),
    BBS_LOBBY_MUTE_MS: String(SPAN_MS),
    // Refused at start without BBS_ALLOW_TEST_FAULTS=1 (B55).
    BBS_TEST_SOCKET_FAULTS: "keep_kicked",
  });
});

afterAll(async () => {
  for (const s of sockets) s.close();
  await b?.stop();
});

/**
 * Post to the Lobby until the first refusal; returns it. The posts go out
 * back to back, and the burst must stay inside one rate window.
 */
async function flood(token: string, tag: string): Promise<{ status: number; body: any }> {
  const start = Date.now();
  for (let i = 0; i < 20; i++) {
    const r = await b.raw(token, "bbs_post", { topic: "Lobby", body: `${tag}-${i}` });
    if (r.status !== 200) {
      expect(Date.now() - start, "the flood fit inside one Lobby window").toBeLessThan(SPAN_MS);
      return r;
    }
  }
  throw new Error("never refused");
}

async function status(handle: string): Promise<string | undefined> {
  const who = await b.ok(b.human, "bbs_who", {}, asCli);
  return (who.users as { handle: string; status: string }[]).find((u) => u.handle === handle)?.status;
}

describe("final (b): flood → mute → kick → socket closed → reinstate → reconnect", () => {
  it("walks the auto-administrator to a kick and back through the human admin", async () => {
    const lead = await b.addUser("lead");
    await b.ok(b.human, "bbs_admin_coordinator_grant", { handle: "lead" }, asCli);
    await b.ok(lead, "bbs_join", {});
    const spam = await b.addUser("spam");
    const session = (await b.ok(spam, "bbs_join", { harness: "scripted" })).session as string;
    await b.ok(lead, "bbs_topic_create", { name: "work" });
    await b.ok(spam, "bbs_subscribe", { topic: "work", level: "wake" });
    const task = (await b.ok(lead, "bbs_task_create", { topic: "work", title: "index the logs" })).task.id as number;
    await b.ok(spam, "bbs_task_claim", { task });
    await b.ok(spam, "bbs_task_update", { task, state: "in_progress" });
    await b.ok(spam, "bbs_inbox", {});
    await b.ok(lead, "bbs_inbox", {});

    const sock = await ScriptedAdapter.connect(b.server.url, spam);
    sockets.push(sock);
    sock.hello(session, "idle");
    await sleep(200);

    // Step 1: warning; posts elsewhere still work.
    const first = await flood(spam, "one");
    expect(first.status).toBe(429);
    expect(first.body.error.message).toMatch(/take it to a topic/i);
    await b.ok(spam, "bbs_post", { topic: "work", body: "still working" });
    // Step 2: muted in the Lobby; the alarm lifts it.
    await sleep(SPAN_MS + 200);
    const second = await flood(spam, "two");
    expect(second.body.error.message).toMatch(/muted in the Lobby/);
    expect(await status("spam")).toBe("muted_lobby");
    await until("the mute lifted by the alarm", async () => (await status("spam")) === "active");
    // Step 3: kicked.
    await sleep(SPAN_MS + 200);
    const third = await flood(spam, "three");
    expect(third.body.error.message).toMatch(/removed from the board/);
    expect(await status("spam")).toBe("kicked");

    // The live socket: kicked frame, then 4004, despite keep_kicked (refused, B55).
    expect(await sock.waitClosed(5000)).toMatchObject({ code: 4004 });
    expect(sock.frames.map((f) => f.data.type)).toContain("kicked");
    const closed = (await b.audit({ action: "sockets_closed" })).find((e) => e.target_id === "spam");
    expect(closed).toMatchObject({ actor: "system", detail: { reason: "kicked", closed: 1, code: 4004 } });

    // M3 × M4: the held task is stale, still assigned (never reassigned), and the coordinator was told.
    const t = (await b.ok(lead, "bbs_task_list", { task })).tasks[0];
    expect(t).toMatchObject({ state: "in_progress", assignee: "spam", stale: true });
    const leadInbox = await b.ok(lead, "bbs_inbox", {});
    expect(leadInbox.notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "task", reason: "assignee_kicked", task, as: "coordinator" }),
        expect.objectContaining({ kind: "admin", reason: "user_kicked" }),
      ]),
    );

    // The #admin-log has the whole walk.
    const log = await b.adminLog();
    const spamLines = log.filter((l) => l.includes("spam"));
    expect(spamLines.length).toBeGreaterThanOrEqual(4);
    expect(spamLines.join("\n")).toMatch(/warn/i);
    expect(spamLines.join("\n")).toMatch(/mute/i);
    expect(spamLines.join("\n")).toMatch(/kick/i);

    // The old token is dead on every endpoint: /api, /mcp and /ws.
    expect((await b.raw(spam, "bbs_inbox", {})).status).toBe(401);
    const mcp = await fetch(`${b.server.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${spam}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bbs_inbox", arguments: {} } }),
    });
    expect(mcp.status).toBe(401);
    await mcp.body?.cancel();
    await expect(ScriptedAdapter.connect(b.server.url, spam)).rejects.toThrow();

    // An agent (even the coordinator) cannot reinstate; the human admin can, with a new token.
    expect((await b.raw(lead, "bbs_admin_reinstate", { handle: "spam" })).status).toBe(403);
    const reinstated = await b.ok(b.human, "bbs_admin_reinstate", { handle: "spam" }, asCli);
    expect(reinstated).toMatchObject({ handle: "spam", coordinator: false });
    const fresh = reinstated.token as string;
    expect(fresh).not.toBe(spam);
    expect((await b.raw(spam, "bbs_inbox", {})).status).toBe(401);
    expect(await status("spam")).toBe("active");
    expect((await b.adminLog()).filter((l) => /reinstate/i.test(l) && l.includes("spam"))).toHaveLength(1);

    // The adapter starts again with the new token: join, connect, hello; a post rings it.
    const session2 = (await b.ok(fresh, "bbs_join", { harness: "scripted" })).session as string;
    expect(session2).not.toBe(session);
    await b.ok(fresh, "bbs_inbox", {});
    const sock2 = await ScriptedAdapter.connect(b.server.url, fresh);
    sockets.push(sock2);
    sock2.hello(session2, "idle");
    await sleep(200);
    await b.ok(lead, "bbs_post", { topic: "work", body: "welcome back, the logs still need indexing" });
    const d = await sock2.nthDoorbell(1, 10_000);
    expect(d?.text).toBe("BBS-5000: 1 new in #work. Call bbs_inbox now, then continue your task.");
    sock2.send({ type: "ring_result", id: d!.id, result: "turn_started", confirmed: true });
    // Offenses were cleared: once the rate window has passed, a Lobby post is accepted again.
    await sleep(SPAN_MS + 200);
    await b.ok(fresh, "bbs_post", { topic: "Lobby", body: "back, and quieter" });
    // The stale mark clears when it works on the task again.
    await b.ok(fresh, "bbs_task_comment", { task, body: "resuming" });
    expect((await b.ok(lead, "bbs_task_list", { task })).tasks[0]).toMatchObject({ stale: false, assignee: "spam" });

    // The refused fault was logged at start.
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(b.server.logFile, "utf8")).toMatch(/BBS_TEST_SOCKET_FAULTS refused/);
  });
});
