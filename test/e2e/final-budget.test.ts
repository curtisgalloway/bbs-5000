// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// F, scenario (c), under `wrangler dev`: an agent uses up its wake budget
// (2 per 20 s window here). Past it, another agent's @mention and a task
// assigned to it stay digest (M3 × M4), the coordinator is told once, and a
// person's @mention still rings and counts (B52, decided by Curtis). When the
// window ends, the held task notice rings once by itself, with no new event.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asCli, startBoard, until, type Board } from "./final-helpers.ts";
import { sleep } from "./harness.ts";
import { ScriptedAdapter } from "./scripted-adapter.ts";

const DEBOUNCE_MS = 1000;
const BUDGET = 2;
// Long enough that the steps after the budget runs out finish well inside the
// window even on a slow runner (F review); the test waits for its end once.
const WINDOW_MS = 30_000;

let b: Board;
const sockets: ScriptedAdapter[] = [];

beforeAll(async () => {
  b = await startBoard({
    BBS_DOORBELL_DEBOUNCE_MS: String(DEBOUNCE_MS),
    BBS_WAKE_BUDGET: String(BUDGET),
    BBS_WAKE_BUDGET_WINDOW_MS: String(WINDOW_MS),
  });
});

afterAll(async () => {
  for (const s of sockets) s.close();
  await b?.stop();
});

describe("final (c): wake budget exhausted while a person's @mention still rings", () => {
  it("falls back to digest past the budget, rings for a person, and rings the held notice at the window's end", async () => {
    const peer = await b.addUser("peer");
    const busy = await b.addUser("busy");
    const lead = await b.addUser("lead");
    await b.ok(b.human, "bbs_admin_coordinator_grant", { handle: "lead" }, asCli);
    await b.ok(peer, "bbs_join", {});
    await b.ok(lead, "bbs_join", {});
    const session = (await b.ok(busy, "bbs_join", { harness: "scripted" })).session as string;
    await b.ok(peer, "bbs_topic_create", { name: "ops" });
    await b.ok(busy, "bbs_subscribe", { topic: "ops", level: "wake" });
    const task = (await b.ok(peer, "bbs_task_create", { topic: "ops", title: "rotate the logs" })).task.id as number;
    await b.ok(busy, "bbs_inbox", {});
    await b.ok(lead, "bbs_inbox", {});

    const sock = await ScriptedAdapter.connect(b.server.url, busy);
    sockets.push(sock);
    sock.hello(session, "idle");
    await sleep(200);

    // Within the budget: each post rings once. The first ring opens the window.
    for (let n = 1; n <= BUDGET; n++) {
      await b.ok(peer, "bbs_post", { topic: "ops", body: `event ${n}` });
      const d = await sock.nthDoorbell(n, 10_000);
      expect(d?.text).toBe("BBS-5000: 1 new in #ops. Call bbs_inbox now, then continue your task.");
      sock.send({ type: "ring_result", id: d!.id, result: "turn_started", confirmed: true });
      await b.ok(busy, "bbs_inbox", {});
    }
    /** The board's own record of doorbells held past the budget for busy. */
    const overBudget = async (): Promise<any[]> =>
      (await b.audit({ action: "doorbell_due" })).filter((e) => e.target_id === "busy" && e.detail.ring?.result === "over_budget");

    // Past it: an agent's @mention does not ring. Wait for the board to record
    // the held doorbell (so the check below is not just a quiet interval).
    await b.ok(peer, "bbs_post", { topic: "ops", body: "@busy are you there?" });
    const held = await until("the doorbell held past the budget", async () => (await overBudget())[0], 15_000);
    expect(sock.doorbells()).toHaveLength(BUDGET);
    // The window's end comes from the board (the first ring plus the configured window).
    const windowEnd = Date.parse(held.detail.ring.budget_until);
    expect(windowEnd - sock.doorbells()[0]!.at).toBeGreaterThan(WINDOW_MS - 2_000);
    expect(windowEnd - sock.doorbells()[0]!.at).toBeLessThan(WINDOW_MS + 2_000);
    expect((await b.adminLog()).filter((l) => l.startsWith("wake budget: busy"))).toHaveLength(1);
    const leadNotices = (await b.ok(lead, "bbs_inbox", {})).notices;
    expect(leadNotices).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "admin", reason: "wake_budget", as: "coordinator" })]),
    );

    // A person's @mention rings anyway and counts (B52).
    await b.ok(b.human, "bbs_post", { topic: "ops", body: "@busy the disk is filling" }, asCli);
    const d3 = await sock.nthDoorbell(BUDGET + 1, 10_000);
    expect(d3?.text).toMatch(/^BBS-5000: 2 new in #ops \(2 mentions\)\. Call bbs_inbox now, then continue your task\.$/);
    sock.send({ type: "ring_result", id: d3!.id, result: "turn_started", confirmed: true });
    const rung = (await b.audit({ action: "doorbell_due" })).filter((e) => e.target_id === "busy").at(-1);
    expect(rung?.detail).toMatchObject({ ring: { result: "rung", past_budget: "human_mention" } });
    const seen = await b.ok(busy, "bbs_inbox", {});
    expect(seen.wake.map((m: any) => m.body)).toEqual(["@busy are you there?", "@busy the disk is filling"]);

    // M3 × M4: an assignment past the budget is digest until the window ends.
    const heldBefore = (await overBudget()).length;
    await b.ok(peer, "bbs_task_assign", { task, assignee: "busy" });
    const heldAssign = await until(
      "the assignment's doorbell held past the budget",
      async () => (await overBudget())[heldBefore],
      15_000,
    );
    expect(sock.doorbells()).toHaveLength(BUDGET + 1);
    expect(Date.parse(heldAssign.detail.ring.budget_until)).toBe(windowEnd);
    expect(Date.parse(heldAssign.ts)).toBeLessThan(windowEnd);
    // Still one #admin-log line for this window.
    expect((await b.adminLog()).filter((l) => l.startsWith("wake budget: busy"))).toHaveLength(1);

    // The window ends: the held notice rings once by itself.
    const d4 = await sock.nthDoorbell(BUDGET + 2, windowEnd - Date.now() + 8_000);
    expect(d4?.text).toBe("BBS-5000: 1 task assigned. Call bbs_inbox now, then continue your task.");
    expect(d4!.at).toBeGreaterThanOrEqual(windowEnd - 500);
    const last = await b.ok(busy, "bbs_inbox", {});
    expect(last.notices).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "task", reason: "task_assigned", task, wake: true })]),
    );
    expect(sock.doorbells()).toHaveLength(BUDGET + 2);
  });
});
