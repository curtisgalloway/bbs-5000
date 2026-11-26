// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// M6b, end to end under `wrangler dev` with local R2 (the `COLD` binding,
// stored in the run's --persist-to directory; nothing in the cloud):
// archive refused with unfinished tasks; force refused for a coordinator
// agent (B37) and done by the human admin; the Board DO alarm moves the topic to R2 (cold age 1 s
// here) and its rows leave SQLite; the object is read back from local R2 with
// `wrangler r2 object get --local`; restore through bbs_topic_unarchive
// round-trips messages, tasks, comments and blocks. A post (and a task
// change) gets the design's text on the cold path, and on the archived path
// for a topic kept from going cold (keep set before archiving).

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, groupAlive, makeRunDir, ROOT, sleep, startWrangler, WORKER_DIR, type RunDir, type Server } from "./harness.ts";

let run: RunDir;
let server: Server;
let human: string;
const asCli = { "x-bbs-client": "cli" };

async function ok(token: string, tool: string, args: unknown = {}, headers: Record<string, string> = {}): Promise<any> {
  const r = await api(server.url, token, tool, args, headers);
  expect(r.status, `${tool}: ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.value;
}

async function addUser(handle: string): Promise<string> {
  return (await ok(human, "bbs_admin_user_add", { handle }, asCli)).token as string;
}

async function topicState(name: string): Promise<{ state: string; messages: number } | undefined> {
  const v = await ok(human, "bbs_topics", { include_archived: true }, asCli);
  return (v.topics as { name: string; state: string; messages: number }[]).find((t) => t.name === name);
}

/** The object as stored in local R2, read by wrangler from the run's state directory. */
function r2Get(key: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    [
      join(ROOT, "node_modules/wrangler/bin/wrangler.js"),
      "r2",
      "object",
      "get",
      `bbs-5000-cold/${key}`,
      "--local",
      "--persist-to",
      run.stateDir,
      "--pipe",
      "--config",
      join(WORKER_DIR, "wrangler.jsonc"),
    ],
    { cwd: WORKER_DIR, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1" }, timeout: 60_000 },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(async () => {
  run = makeRunDir("owner", { BBS_COLD_AFTER_MS: "1000", BBS_COLD_RETRY_MS: "1000" });
  human = run.humanToken;
  server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
});

afterAll(async () => {
  await server?.stop();
  if (server) expect(groupAlive(server.pid)).toBe(false);
  run?.cleanup();
});

describe("topic archiving and R2 cold storage (A6.6–A6.9)", () => {
  it("refuses, force-archives, goes cold in local R2, refuses posts, and restores", async () => {
    const coord = await addUser("coord");
    const dev = await addUser("dev");
    await ok(human, "bbs_admin_coordinator_grant", { handle: "coord" }, asCli);
    await ok(coord, "bbs_join", {});
    await ok(dev, "bbs_join", {});
    await ok(dev, "bbs_topic_create", { name: "proj" });
    await ok(dev, "bbs_post", { topic: "proj", body: "kickoff" });
    await ok(dev, "bbs_post", { topic: "proj", body: "ping @coord" });
    const t1 = (await ok(dev, "bbs_task_create", { topic: "proj", title: "build", description: "the thing" })).task.id;
    const t2 = (await ok(dev, "bbs_task_create", { topic: "proj", title: "design" })).task.id;
    await ok(dev, "bbs_task_claim", { task: t1 });
    await ok(dev, "bbs_task_block", { task: t1, blocked_by: [t2] });
    await ok(dev, "bbs_task_comment", { task: t2, body: "needs a sketch" });

    // Refused with unfinished tasks, listing them.
    const refused = await api(server.url, coord, "bbs_topic_archive", { topic: "proj", reason: "wrap up" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(
      `#proj has unfinished tasks: ${t1} (blocked), ${t2} (open). Finish, cancel or move them first.`,
    );
    // force: refused for the coordinator agent (B37), on /api and /mcp alike in core.
    const forced = await api(server.url, coord, "bbs_topic_archive", { topic: "proj", reason: "wrap up", force: true });
    expect(forced.status).toBe(403);
    expect(forced.body.error.message).toBe("force is a human admin power; agents (coordinators included) cannot use it");
    expect((await topicState("proj"))?.state).toBe("active");

    const before = await ok(dev, "bbs_read", { topic: "proj" });
    expect(before.messages).toHaveLength(2);
    // The human admin's force cancels both tasks with the reason.
    const archived = await ok(human, "bbs_topic_archive", { topic: "proj", reason: "wrap up", force: true }, asCli);
    expect(archived).toMatchObject({ state: "archived", archived_by: "owner" });
    expect([...archived.cancelled].sort()).toEqual([t1, t2].sort());
    const tasksBefore = await ok(dev, "bbs_task_list", { topic: "proj" });
    const detailBefore = await ok(dev, "bbs_task_list", { task: t1 });

    const date = new Date(archived.archived_at).toISOString().slice(0, 10);
    const text = `Topic archived on ${date} by owner. Ask a coordinator to unarchive it.`;

    // The alarm moves it to R2 after the 1 s cold age.
    const deadline = Date.now() + 20_000;
    while ((await topicState("proj"))?.state !== "cold") {
      if (Date.now() > deadline) throw new Error("topic never went cold");
      await sleep(250);
    }
    expect(await topicState("proj")).toMatchObject({ state: "cold", messages: 0 });
    const read = await ok(dev, "bbs_read", { topic: "proj" });
    expect(read).toMatchObject({ state: "cold", messages: [] });
    expect((await ok(dev, "bbs_task_list", { topic: "proj" })).tasks).toEqual([]);
    // The cold path: a post, and a task change on one of its (now cold) tasks, get the design's text.
    const post2 = await api(server.url, dev, "bbs_post", { topic: "proj", body: "anyone?" });
    expect(post2.status).toBe(409);
    expect(post2.body.error).toEqual({ code: "topic_archived", message: text });
    const comment = await api(server.url, dev, "bbs_task_comment", { task: t1, body: "still there?" });
    expect(comment.body.error).toEqual({ code: "topic_archived", message: text });
    const audit = await ok(human, "bbs_audit", { action: "topic_cold" }, asCli);
    const cold = audit.events.find((e: any) => e.result === "ok");
    const key = `topics/proj/${Date.parse(archived.archived_at)}.ndjson`;
    expect(cold.detail).toMatchObject({ key, outcome: "created", deleted: { messages: 2, tasks: 2, blocks: 1, mentions: 1 } });

    // The object exists in local R2, read back by wrangler from the run's state.
    const obj = r2Get(key);
    expect(obj.status, obj.stderr).toBe(0);
    const lines = obj.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "topic", format: "bbs-5000-topic/1", name: "proj", archived_by: "owner" });
    expect(lines.filter((l) => l.type === "message").map((l) => l.body)).toEqual(["kickoff", "ping @coord"]);
    expect(lines.filter((l) => l.type === "task")).toHaveLength(2);
    expect(lines.filter((l) => l.type === "block")).toEqual([expect.objectContaining({ task: t1, blocked_by: t2 })]);
    expect(lines.filter((l) => l.type === "comment").map((l) => l.body)).toContain("needs a sketch");
    expect(cold.detail.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Restore: a plain agent is refused; the coordinator restores from R2.
    const denied = await api(server.url, dev, "bbs_topic_unarchive", { topic: "proj" });
    expect(denied.status).toBe(403);
    const restored = await ok(coord, "bbs_topic_unarchive", { topic: "proj" });
    expect(restored).toMatchObject({ state: "active", restored: { messages: 2, tasks: 2, blocks: 1 }, blocks_pending: 0 });
    const after = await ok(dev, "bbs_read", { topic: "proj" });
    expect(after.messages).toEqual(before.messages);
    expect(await ok(dev, "bbs_task_list", { topic: "proj" })).toEqual(tasksBefore);
    expect(await ok(dev, "bbs_task_list", { task: t1 })).toEqual(detailBefore);
    await ok(dev, "bbs_post", { topic: "proj", body: "back again" });
  });

  it("the archived path: a kept topic stays archived past the cold age; posts refused; unarchive", async () => {
    const coord2 = await addUser("coord2");
    await ok(human, "bbs_admin_coordinator_grant", { handle: "coord2" }, asCli);
    await ok(coord2, "bbs_topic_create", { name: "side" });
    await ok(coord2, "bbs_post", { topic: "side", body: "note" });
    // keep set while active also keeps the archived topic from going cold (review m5).
    await ok(coord2, "bbs_topic_keep", { topic: "side", on: true });
    const a = await ok(coord2, "bbs_topic_archive", { topic: "side", reason: "quiet" });
    expect(a).toMatchObject({ state: "archived", archived_by: "coord2", cancelled: [] });
    // keep cannot change while archived (review m1).
    expect((await api(server.url, coord2, "bbs_topic_keep", { topic: "side", on: false })).status).toBe(409);
    // Well past the 1 s cold age, with the alarm running for #proj's work: still archived, rows still here.
    await sleep(2_500);
    expect(await topicState("side")).toMatchObject({ state: "archived", messages: 1 });
    const date = new Date(a.archived_at).toISOString().slice(0, 10);
    const post = await api(server.url, coord2, "bbs_post", { topic: "side", body: "hi" });
    expect(post.status).toBe(409);
    expect(post.body.error).toEqual({
      code: "topic_archived",
      message: `Topic archived on ${date} by coord2. Ask a coordinator to unarchive it.`,
    });
    const u = await ok(coord2, "bbs_topic_unarchive", { topic: "side" });
    expect(u.state).toBe("active");
    await ok(coord2, "bbs_post", { topic: "side", body: "hi again" });
  });
});
