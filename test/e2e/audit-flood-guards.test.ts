// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// B44, end to end under `wrangler dev`: audit rows written by failed sign-ins
// alone bring the row-count export forward. The board runs with a one-day
// export interval (so only the row count can trigger an export) and a trigger
// of 10 unexported rows. Nothing but failed sign-ins follows the first rows,
// so without the alarm being re-armed by `authenticate` no export would run.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseBatch } from "../../packages/core/src/audit-export.ts";
import { startFakeGcs, type FakeGcs } from "./fake-gcs.ts";
import { api, makeRunDir, sleep, startWrangler, type RunDir, type Server } from "./harness.ts";

let archiveDir: string;
let fake: FakeGcs;
let run: RunDir;
let server: Server;

beforeAll(async () => {
  archiveDir = mkdtempSync(join(tmpdir(), "bbs-e2e-gcs-"));
  fake = await startFakeGcs(archiveDir);
  run = makeRunDir("owner", {
    BBS_AUDIT_GCS_BUCKET: fake.bucket,
    BBS_AUDIT_GCS_KEY: `'${fake.keyJson}'`,
    BBS_AUDIT_GCS_STORAGE_URL: fake.url,
    BBS_AUDIT_GCS_TOKEN_URL: `${fake.url}/token`,
    BBS_AUDIT_EXPORT_INTERVAL_MS: String(24 * 60 * 60 * 1000),
    BBS_AUDIT_EXPORT_BATCH_ROWS: "10",
  });
  server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
});

afterAll(async () => {
  await server?.stop();
  await fake?.stop();
  run?.cleanup();
  rmSync(archiveDir, { recursive: true, force: true });
});

it("exports once failed sign-ins alone reach the row-count trigger (B44)", async () => {
  // Let the board start (its first rows are written), then confirm that
  // nothing has been exported: the interval is a day and the rows are few.
  const health = await fetch(`${server.url}/health`);
  expect(health.status).toBe(200);
  await sleep(1_500);
  expect(fake.sink.readAll()).toHaveLength(0);

  // Only failed sign-ins from here: no tool call re-arms the alarm.
  for (let i = 0; i < 12; i++) {
    const r = await api(server.url, `not-a-token-${i}`, "bbs_post", { topic: "x", body: "y" });
    expect(r.status).toBe(401);
  }

  const deadline = Date.now() + 20_000;
  while (fake.sink.readAll().length === 0) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the row-count export");
    await sleep(250);
  }
  const first = fake.sink.readAll()[0]!;
  const parsed = parseBatch(first.path, first.body);
  expect(parsed.rows.filter((r) => r.action === "auth").length).toBeGreaterThan(0);
});
