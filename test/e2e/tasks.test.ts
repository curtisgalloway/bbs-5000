// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// M3 acceptance, end to end under `wrangler dev`: tasks through /api, /mcp
// and the bbs CLI; blockers; notification records as the audit row shows
// them (M2 will ring them); and a lease running out through the real
// Durable Object alarm. The board runs with BBS_TASK_LEASE_MS=1500 so the
// lease can expire within the test; nothing else changes the clock.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { api, groupAlive, makeRunDir, ROOT, sleep, startWrangler, type RunDir, type Server } from "./harness.ts";

const LEASE_MS = 1500;

let run: RunDir;
let server: Server;
let human: string;
const asCli = { "x-bbs-client": "cli" };

async function addUser(handle: string): Promise<string> {
  const r = await api(server.url, human, "bbs_admin_user_add", { handle }, asCli);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.value.token as string;
}

/** Audit rows for one task, oldest first. */
async function taskAudit(id: number): Promise<any[]> {
  const r = await api(server.url, human, "bbs_audit", { task: id, limit: 1000 }, asCli);
  expect(r.status).toBe(200);
  return r.body.value.events;
}

async function call(token: string, tool: string, args: unknown): Promise<any> {
  const r = await api(server.url, token, tool, args);
  expect(r.status, `${tool}: ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.value;
}

beforeAll(async () => {
  run = makeRunDir("owner", { BBS_TASK_LEASE_MS: String(LEASE_MS) });
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

describe("tasks over /api", () => {
  it("create, assign, start, review, done; assignment is recorded for the assignee (A3.1, A3.2)", async () => {
    const alice = await addUser("alice");
    const bob = await addUser("bob");
    await call(alice, "bbs_topic_create", { name: "build" });
    // Not in the topic yet: assignment is refused.
    const id = (await call(alice, "bbs_task_create", { topic: "build", title: "parser" })).task.id as number;
    const refused = await api(server.url, alice, "bbs_task_assign", { task: id, assignee: "bob" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/not in #build/);
    // bob in #build at digest only; the assignment still always wakes.
    await call(bob, "bbs_subscribe", { topic: "build", level: "digest" });
    await call(alice, "bbs_task_assign", { task: id, assignee: "bob" });
    await call(bob, "bbs_task_update", { task: id, state: "in_progress" });
    await call(bob, "bbs_task_update", { task: id, state: "in_review", comment: "ready" });
    const done = await call(alice, "bbs_task_update", { task: id, state: "done" });
    expect(done.task).toMatchObject({ id, state: "done", assignee: "bob" });

    const bad = await api(server.url, bob, "bbs_task_update", { task: id, state: "in_progress" });
    expect(bad.status).toBe(409);

    const listed = await api(server.url, bob, "bbs_task_list", { task: id });
    expect(listed.body.peer_content_notice).toBeTruthy();
    expect(listed.body.value.tasks[0].comments.map((c: any) => c.state_change).filter(Boolean)).toEqual([
      "open>assigned",
      "assigned>in_progress",
      "in_progress>in_review",
      "in_review>done",
    ]);

    const rows = (await taskAudit(id)).filter((e) => e.result === "ok");
    expect(rows.map((e) => e.action)).toEqual([
      "task_create",
      "task_assign",
      "task_update",
      "task_update",
      "task_update",
    ]);
    const assign = rows[1];
    expect(assign).toMatchObject({ actor: "alice", via: "api", target_type: "task", topic: "build" });
    expect(assign.detail.notify).toEqual([{ to: "bob", reason: "task_assigned", task: id }]);
  });

  it("only a coordinator or a person takes a task someone else holds (B26)", async () => {
    const owner = await addUser("own26");
    const holder = await addUser("hold26");
    const other = await addUser("oth26");
    await call(owner, "bbs_topic_create", { name: "take26" });
    for (const t of [holder, other]) await call(t, "bbs_subscribe", { topic: "take26", level: "wake" });
    const id = (await call(owner, "bbs_task_create", { topic: "take26", title: "held" })).task.id as number;
    await call(owner, "bbs_task_assign", { task: id, assignee: "hold26" });
    await call(holder, "bbs_task_update", { task: id, state: "in_progress" });
    const refused = await api(server.url, other, "bbs_task_assign", { task: id, assignee: "oth26" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe(
      `task ${id} is held by hold26 (in_progress); only a coordinator or a person can reassign it. ` +
        "An agent can assign an open task, hand on a task it holds, or take a task whose lease has gone stale.",
    );
    const audit = await api(server.url, human, "bbs_audit", { actor: "oth26", action: "task_assign" }, asCli);
    expect(audit.body.value.events.map((e: any) => e.result)).toEqual(["denied"]);
    // Made a coordinator by a person, the same agent may take it.
    const granted = await api(server.url, human, "bbs_admin_coordinator_grant", { handle: "oth26" }, asCli);
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    const taken = await call(other, "bbs_task_assign", { task: id, assignee: "oth26" });
    expect(taken.task).toMatchObject({ state: "assigned", assignee: "oth26" });
    // Later tests here expect no coordinator on the board.
    const removed = await api(server.url, human, "bbs_admin_coordinator_remove", { handle: "oth26" }, asCli);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  });

  it("blockers: refused without an id, self-block and cycles; last done returns the task (A3.3, A3.4)", async () => {
    const carl = await addUser("carl");
    const dina = await addUser("dina");
    await call(carl, "bbs_topic_create", { name: "front" });
    await call(dina, "bbs_topic_create", { name: "back" });
    await call(dina, "bbs_subscribe", { topic: "front", level: "wake" });
    const t = (await call(carl, "bbs_task_create", { topic: "front", title: "page" })).task.id as number;
    const b = (await call(dina, "bbs_task_create", { topic: "back", title: "endpoint" })).task.id as number;
    await call(carl, "bbs_task_claim", { task: t });
    await call(dina, "bbs_task_claim", { task: b });

    expect((await api(server.url, carl, "bbs_task_update", { task: t, state: "blocked" })).status).toBe(400);
    expect((await api(server.url, carl, "bbs_task_block", { task: t, blocked_by: [] })).status).toBe(400);
    expect((await api(server.url, carl, "bbs_task_block", { task: t, blocked_by: [t] })).status).toBe(400);
    expect((await api(server.url, carl, "bbs_task_block", { task: t, blocked_by: [99999] })).status).toBe(404);

    // Cross-topic blocker: front waits on back.
    const blocked = await call(carl, "bbs_task_block", { task: t, blocked_by: [b] });
    expect(blocked.task).toMatchObject({ state: "blocked", prior_state: "assigned" });
    const cycle = await api(server.url, dina, "bbs_task_block", { task: b, blocked_by: [t] });
    expect(cycle.status).toBe(409);
    expect(cycle.body.error.message).toMatch(/cycle/);

    await call(dina, "bbs_task_update", { task: b, state: "in_progress" });
    await call(dina, "bbs_task_update", { task: b, state: "in_review" });
    expect((await api(server.url, human, "bbs_task_update", { task: b, state: "done" }, asCli)).status).toBe(200);
    const after = await call(carl, "bbs_task_list", { task: t });
    expect(after.tasks[0]).toMatchObject({ state: "assigned", prior_state: null });

    const blockRow = (await taskAudit(t)).find((e) => e.action === "task_block" && e.result === "ok");
    expect(blockRow.detail.notify).toEqual([{ to: "dina", reason: "blocks_your_task", task: b }]);
    const doneRow = (await taskAudit(b)).filter((e) => e.action === "task_update").at(-1);
    // A person approved it (issue #87), so the assignee is told as well.
    expect(doneRow.detail.notify).toEqual([
      { to: "dina", reason: "task_comment", task: b },
      { to: "carl", reason: "task_unblocked", task: t },
    ]);
  });

  it("a cancelled blocker leaves the task blocked; with no coordinator nobody else is told (A3.5)", async () => {
    const erin = await addUser("erin");
    await call(erin, "bbs_topic_create", { name: "ops" });
    const t = (await call(erin, "bbs_task_create", { topic: "ops", title: "deploy" })).task.id as number;
    const b = (await call(erin, "bbs_task_create", { topic: "ops", title: "approval" })).task.id as number;
    await call(erin, "bbs_task_claim", { task: t });
    await call(erin, "bbs_task_block", { task: t, blocked_by: [b] });
    const owner = await api(server.url, human, "bbs_task_update", { task: b, state: "cancelled" }, asCli);
    expect(owner.status, JSON.stringify(owner.body)).toBe(200);
    const still = await call(erin, "bbs_task_list", { task: t });
    expect(still.tasks[0]).toMatchObject({ state: "blocked", blocked_by: [{ id: b, state: "cancelled" }] });
    const row = (await taskAudit(b)).filter((e) => e.action === "task_update").at(-1);
    expect(row.actor).toBe("owner");
    expect(row.detail.notify).toEqual([
      { to: "erin", reason: "blocker_cancelled", task: t },
      { to: null, reason: "blocker_cancelled", task: t },
    ]);
  });
});

describe("leases through the Durable Object alarm (A3.6)", () => {
  it("expires to stale without calls, never while blocked, and renews on any call", async () => {
    const fay = await addUser("fay");
    const gus = await addUser("gus");
    await call(fay, "bbs_topic_create", { name: "lease" });
    await call(gus, "bbs_subscribe", { topic: "lease", level: "wake" });
    const idle = (await call(fay, "bbs_task_create", { topic: "lease", title: "idle" })).task.id as number;
    const busy = (await call(fay, "bbs_task_create", { topic: "lease", title: "busy" })).task.id as number;
    const parked = (await call(fay, "bbs_task_create", { topic: "lease", title: "parked" })).task.id as number;
    const blocker = (await call(fay, "bbs_task_create", { topic: "lease", title: "blocker" })).task.id as number;
    await call(fay, "bbs_task_assign", { task: idle, assignee: "fay" });
    await call(fay, "bbs_task_assign", { task: busy, assignee: "gus" });
    await call(fay, "bbs_task_assign", { task: parked, assignee: "fay" });
    await call(fay, "bbs_task_update", { task: idle, state: "in_progress" });
    await call(gus, "bbs_task_update", { task: busy, state: "in_progress" });
    await call(fay, "bbs_task_update", { task: parked, state: "in_progress" });
    await call(fay, "bbs_task_block", { task: parked, blocked_by: [blocker] });

    // gus keeps calling (a read) every 400 ms; fay goes quiet.
    const until = Date.now() + LEASE_MS * 3;
    while (Date.now() < until) {
      await call(gus, "bbs_topics", {});
      await sleep(400);
    }
    const tasks = (await call(gus, "bbs_task_list", { topic: "lease" })).tasks as any[];
    const by = (id: number) => tasks.find((t) => t.id === id);
    expect(by(idle)).toMatchObject({ state: "in_progress", assignee: "fay", stale: true });
    expect(by(busy)).toMatchObject({ state: "in_progress", stale: false });
    expect(by(parked)).toMatchObject({ state: "blocked", stale: false, lease_expires_at: null });

    const check = (await taskAudit(idle)).find((e) => e.action === "lease_check" && e.detail.outcome === "stale");
    expect(check).toMatchObject({ actor: "system", actor_kind: "system", via: "system", result: "ok" });
    expect(check.detail.notify).toEqual([
      { to: "fay", reason: "lease_stale", task: idle },
      { to: null, reason: "lease_stale", task: idle },
    ]);
    // The busy task's timer fired too, and only extended.
    const busyChecks = (await taskAudit(busy)).filter((e) => e.action === "lease_check");
    expect(busyChecks.length).toBeGreaterThan(0);
    expect(busyChecks.every((e) => e.detail.outcome === "extended")).toBe(true);
  });
});

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

describe("tasks over /mcp and the CLI", () => {
  it("runs the task tools through MCP and bbs", async () => {
    const hal = await addUser("hal");
    const c = await mcpClient(hal);
    expect((await c.callTool({ name: "bbs_topic_create", arguments: { name: "mcp-tasks" } })).isError).toBe(false);
    const created = await c.callTool({
      name: "bbs_task_create",
      arguments: { topic: "mcp-tasks", title: "via mcp" },
    });
    expect(created.isError).toBe(false);
    const id = (created.structuredContent as any).task.id as number;
    const self = await c.callTool({ name: "bbs_task_block", arguments: { task: id, blocked_by: [id] } });
    expect(self.isError).toBe(true);

    const config = join(run.dir, "hal.json");
    writeFileSync(config, JSON.stringify({ url: server.url, token: hal }), { mode: 0o600 });
    const env = { BBS_CONFIG: config };
    const made = await bbs(["task", "create", "mcp-tasks", "via cli"], env);
    expect(made.code, made.err).toBe(0);
    const other = JSON.parse(made.out).task.id as number;
    const blocked = await bbs(["task", "block", String(id), String(other)], env);
    expect(blocked.code, blocked.err).toBe(0);
    expect(JSON.parse(blocked.out).task).toMatchObject({ id, state: "blocked" });
    const cycle = await bbs(["task", "block", String(other), String(id)], env);
    expect(cycle.code).toBe(30);
    const listed = await bbs(["task", "list", "--topic", "mcp-tasks", "--state", "blocked"], env);
    expect(listed.code, listed.err).toBe(0);
    expect(JSON.parse(listed.out).tasks.map((t: any) => t.id)).toEqual([id]);
    await c.close();
  });
});
