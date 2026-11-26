// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// Backlog B4 and B8: Durable Object SQL under wrangler dev behaves as core
// assumes, and the same as the node:sqlite handle the unit tests use.

import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate } from "@bbs-5000/core";
import { NodeSqliteSql } from "@bbs-5000/core/node-sqlite";
import { sqlChecks } from "../../packages/worker/probe/checks.ts";
import { makeRunDir, startWrangler, WORKER_DIR, type RunDir, type Server } from "./harness.ts";

let run: RunDir;
let server: Server;
let durable: Record<string, any>;
let node: Record<string, any>;

beforeAll(async () => {
  run = makeRunDir();
  server = await startWrangler({
    stateDir: run.stateDir,
    config: join(WORKER_DIR, "probe/wrangler.jsonc"),
    service: "bbs-5000-sql-probe",
    logFile: join(run.dir, "wrangler.log"),
  });
  durable = (await (await fetch(server.url)).json()) as Record<string, any>;
  const sql = new NodeSqliteSql();
  migrate(sql, Date.now());
  migrate(sql, Date.now());
  node = sqlChecks(sql);
  console.log(JSON.stringify({ durable, node }, null, 2));
});

afterAll(async () => {
  await server?.stop();
  run?.cleanup();
});

it("B4: both enforce foreign keys", () => {
  expect(durable.orphan_insert_refused).toBe(true);
  expect(node.orphan_insert_refused).toBe(true);
  expect(durable.orphan_error).toMatch(/FOREIGN KEY/i);
});

it("B8: migrate reads sqlite_master (twice, idempotent)", () => {
  expect(durable.sqlite_master).toEqual([{ name: "audit" }, { name: "meta" }]);
  expect(node.sqlite_master).toEqual(durable.sqlite_master);
});

it("B8: json_each works", () => {
  expect(durable.json_each).toEqual([{ value: "a" }, { value: "b" }]);
  expect(node.json_each).toEqual(durable.json_each);
});

it("B8: 100 bound parameters work and 101 do not, in both", () => {
  expect(durable.params_90).toEqual({ ok: true });
  expect(durable.params_100).toEqual({ ok: true });
  expect(durable.params_101.ok).toBe(false);
  expect(node.params_101.ok).toBe(false);
});
