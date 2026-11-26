// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// M6a, end to end under `wrangler dev`: the Board DO's alarm exports audit
// batches through the Worker's real `GcsSink` (JWT signed with Web Crypto
// inside workerd, B14) to a fake Cloud Storage endpoint that stores them with
// `LocalDirSink`. Every upload carries `ifGenerationMatch=0`; a failing
// endpoint leaves the rows and the same batch is retried; exported rows past
// a short hot period are deleted; the chain verifies across archive and hot
// rows. The board runs with a 1 s export interval and a 4 s hot period.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chainValueAfter, type AuditRow } from "../../packages/core/src/audit.ts";
import { parseBatch, verifyAuditArchive } from "../../packages/core/src/audit-export.ts";
import { startFakeGcs, type FakeGcs } from "./fake-gcs.ts";
import { api, makeRunDir, sha256, sleep, startWrangler, storedAuditRow, type RunDir, type Server } from "./harness.ts";

const HOT_MS = 4_000;
const asCli = { "x-bbs-client": "cli" };

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
    BBS_AUDIT_EXPORT_INTERVAL_MS: "1000",
    BBS_AUDIT_HOT_MS: String(HOT_MS),
  });
  server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
});

afterAll(async () => {
  await server?.stop();
  await fake?.stop();
  run?.cleanup();
  rmSync(archiveDir, { recursive: true, force: true });
});

interface ChainState {
  board_id: string;
  tail_seq: number;
  tail_hash: string;
  head: string;
  exported_seq: number;
}

/** The board's recorded chain state, as `bbs_audit` returns it (review m3). */
let lastChain: ChainState | undefined;

/** Every hot audit row, oldest first, with `detail` back as stored text. */
async function hotRows(): Promise<AuditRow[]> {
  const out: AuditRow[] = [];
  let after = 0;
  for (;;) {
    const r = await api(server.url, run.humanToken, "bbs_audit", { after_seq: after, limit: 1000 }, asCli);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const events = r.body.value.events as any[];
    // The state read with the last page: its head is the chain value after the last row returned.
    lastChain = r.body.value.chain as ChainState;
    for (const e of events) {
      // The tool parses detail; it was written by JSON.stringify, so this restores the stored text.
      out.push(storedAuditRow(e));
    }
    if (events.length < 1000) return out;
    after = events.at(-1).seq;
  }
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

it("exports, retries a failed write, prunes past the hot period, and the chain verifies across the boundary", async () => {
  const add = await api(server.url, run.humanToken, "bbs_admin_user_add", { handle: "ivy" }, asCli);
  const ivy = add.body.value.token as string;
  await api(server.url, ivy, "bbs_topic_create", { name: "exp" });
  for (let i = 0; i < 3; i++) await api(server.url, ivy, "bbs_post", { topic: "exp", body: `m${i}` });

  // A6.1: the alarm writes NDJSON batches at audit/dt=YYYY-MM-DD/<board_id>-<first>-<last>.ndjson.
  await until("first batch", async () => fake.sink.readAll().length > 0);
  const first = fake.sink.readAll()[0]!;
  expect(first.path).toMatch(/^audit\/dt=\d{4}-\d{2}-\d{2}\/[0-9a-f]{16}-1-\d+\.ndjson$/);
  const parsed = parseBatch(first.path, first.body);
  expect(parsed.rows[0]!.action).toBe("bootstrap_human");
  // The last line carries the chain value after the batch's last row.
  expect(parsed.chains.at(-1)).toBe(chainValueAfter(parsed.rows.at(-1)!, sha256));
  expect(fake.tokensIssued).toBe(1);

  // A6.2: a failing endpoint leaves the rows; the same batch is retried.
  fake.failUploads = 3;
  await api(server.url, ivy, "bbs_post", { topic: "exp", body: "during the outage" });
  const failed = await until("a failed export", async () => {
    const rows = await hotRows();
    return rows.find((r) => r.action === "audit_export_failed");
  });
  const pendingFirst = JSON.parse(failed.detail).first as number;
  // While it fails, the batch's rows are still in SQLite (never pruned unexported).
  expect((await hotRows()).some((r) => r.seq === pendingFirst)).toBe(true);
  const recovered = await until("the export after the outage", async () => {
    const rows = await hotRows();
    return rows.find((r) => r.action === "audit_export" && JSON.parse(r.detail).after_failures === 3);
  });
  expect(JSON.parse(recovered.detail).first).toBe(pendingFirst);
  const failedUploads = fake.uploads.filter((u) => u.status === 503).map((u) => u.name);
  expect(failedUploads).toHaveLength(3);
  expect(new Set(failedUploads).size).toBe(1);
  expect(fake.uploads.find((u) => u.status === 200 && u.name === failedUploads[0])).toBeDefined();

  // A6.2: rows past the hot period are deleted once exported.
  await sleep(HOT_MS);
  await api(server.url, ivy, "bbs_post", { topic: "exp", body: "after the hot period" });
  await until("pruning", async () => (await hotRows())[0]!.seq > 1, 20_000);

  // A6.3: every write carried the does-not-exist precondition; nothing else was asked.
  expect(fake.uploads.length).toBeGreaterThan(2);
  expect(fake.uploads.every((u) => u.ifGenerationMatch === "0" && u.uploadType === "media")).toBe(true);
  expect(fake.violations).toEqual([]);

  // A6.4: archive + hot rows verify as one chain against the board's recorded
  // tail, head and exported seq (review m3). Export keeps running (each audit
  // read is a new row), so take the hot rows and the state first, then the
  // archive, and keep the batches confirmed by then (first seq at most the
  // recorded exported seq); a later batch may already be in the archive.
  const hot = await hotRows();
  const chain = lastChain!;
  const batches = fake.sink.readAll().filter((b) => parseBatch(b.path, b.body).first <= chain.exported_seq);
  expect(chain.board_id).toMatch(/^[0-9a-f]{16}$/);
  expect(batches.every((b) => b.path.includes(`/${chain.board_id}-`))).toBe(true);
  expect(chain.tail_seq).toBe(hot[0]!.seq);
  expect(chain.tail_hash).toBe(hot[0]!.prev_hash);
  expect(chain.exported_seq).toBeGreaterThan(1);
  // bbs_audit reads the rows and the state in one transaction, before its own
  // audit row: the head is the chain value after the last row returned.
  expect(chain.head).toBe(chainValueAfter(hot.at(-1)!, sha256));
  const check = (b: typeof batches) =>
    verifyAuditArchive({
      boardId: chain.board_id,
      exportedSeq: chain.exported_seq,
      batches: b,
      hot,
      tail: { seq: chain.tail_seq, hash: chain.tail_hash },
      head: chain.head,
      sha256,
    });
  expect(check(batches)).toMatchObject({ ok: true });
  expect(hot[0]!.seq).toBeGreaterThan(1);
  // An edited archived row, and a missing batch, are detected.
  const edited = batches.map((b, i) => (i === 0 ? { ...b, body: b.body.replace('"actor":"owner"', '"actor":"mallory"') } : b));
  expect(edited[0]!.body).not.toBe(batches[0]!.body);
  expect(check(edited).ok).toBe(false);
  if (batches.length > 2) expect(check(batches.filter((_, i) => i !== 1)).ok).toBe(false);
  // The last confirmed batch missing: its rows are exported (and may still be hot).
  expect(check(batches.slice(0, -1))).toMatchObject({ ok: false, reason: expect.stringMatching(/^missing batch/) });
});
