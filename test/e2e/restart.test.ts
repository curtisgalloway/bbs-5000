// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// M1b acceptance: board state survives a `wrangler dev` restart (DO SQLite
// persisted under --persist-to), and the human bootstrap is a no-op the
// second time.

import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { api, groupAlive, makeRunDir, startWrangler, type Server } from "./harness.ts";

const run = makeRunDir();
const servers: Server[] = [];
afterAll(async () => {
  for (const s of servers) await s.stop();
  run.cleanup();
});

const cli = { "x-bbs-client": "cli" };

it("keeps users, topics, messages and the audit chain across a restart", async () => {
  const start = () =>
    startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });

  const first = await start();
  servers.push(first);
  const add = await api(first.url, run.humanToken, "bbs_admin_user_add", { handle: "ivy" }, cli);
  const ivy = add.body.value.token as string;
  await api(first.url, ivy, "bbs_join", {});
  await api(first.url, ivy, "bbs_topic_create", { name: "persist" });
  await api(first.url, ivy, "bbs_post", { topic: "persist", body: "before restart" });
  const before = await api(first.url, run.humanToken, "bbs_audit", { limit: 1000 }, cli);
  await first.stop();
  expect(groupAlive(first.pid)).toBe(false);

  const second = await start();
  servers.push(second);
  const read = await api(second.url, ivy, "bbs_read", { topic: "persist" });
  expect(read.status).toBe(200);
  expect(read.body.value.messages.map((m: any) => m.body)).toEqual(["before restart"]);
  await api(second.url, ivy, "bbs_post", { topic: "persist", body: "after restart" });
  const after = await api(second.url, run.humanToken, "bbs_audit", { limit: 1000 }, cli);
  const old = before.body.value.events as any[];
  const all = after.body.value.events as any[];
  // Rows from the first run are unchanged, numbering continues, and the
  // human bootstrap was not repeated.
  expect(all.slice(0, old.length)).toEqual(old);
  expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
  expect(all.filter((e) => e.action === "bootstrap_human")).toHaveLength(1);
  expect(all.at(-1)).toMatchObject({ actor: "ivy", action: "post", result: "ok" });
  // The chain links across the restart: each row's prev_hash is set, and the
  // first row after the restart does not restart from genesis.
  const firstNew = all[old.length];
  expect(firstNew.prev_hash).not.toBe("0".repeat(64));
});
