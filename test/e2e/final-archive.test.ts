// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// F, scenario (d), under `wrangler dev`, with audit export to the fake Cloud
// Storage endpoint and topic cold storage in local R2: a run that uses every
// audited action, ending in the human admin force-archiving a topic (its
// unfinished tasks cancelled with notices to the assignee and the
// coordinator, and a blocker notice across topics), the alarm taking it cold,
// and a restore. The audit export of the whole run then verifies as one chain
// across the archive and the hot rows, named by the board id, and the
// archive plus hot rows hold every audited action name (plan F: "audit chain
// verifies over a run that used every action").

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_ACTIONS, SOCKET_ACTIONS } from "../../packages/core/src/act.ts";
import type { AuditRow } from "../../packages/core/src/audit.ts";
import { parseBatch, verifyAuditArchive } from "../../packages/core/src/audit-export.ts";
import { startFakeGcs, type FakeGcs } from "./fake-gcs.ts";
import { asCli, startBoard, until, type Board } from "./final-helpers.ts";
import { sha256, sleep, storedAuditRow } from "./harness.ts";
import { ScriptedAdapter } from "./scripted-adapter.ts";

// The Lobby rate window and mute length: wide enough that a burst of posts
// fits inside one window on a slow runner (F review).
const SPAN_MS = 3000;
const COLD_AFTER_MS = 1000;
const LEASE_MS = 2000;

let archiveDir: string;
let fake: FakeGcs;
let b: Board;
const sockets: ScriptedAdapter[] = [];

beforeAll(async () => {
  archiveDir = mkdtempSync(join(tmpdir(), "bbs-e2e-final-gcs-"));
  fake = await startFakeGcs(archiveDir);
  b = await startBoard({
    BBS_AUDIT_GCS_BUCKET: fake.bucket,
    BBS_AUDIT_GCS_KEY: `'${fake.keyJson}'`,
    BBS_AUDIT_GCS_STORAGE_URL: fake.url,
    BBS_AUDIT_GCS_TOKEN_URL: `${fake.url}/token`,
    BBS_AUDIT_EXPORT_INTERVAL_MS: "1000",
    BBS_AUDIT_HOT_MS: "5000",
    BBS_COLD_AFTER_MS: String(COLD_AFTER_MS),
    BBS_COLD_RETRY_MS: "1000",
    BBS_DOORBELL_DEBOUNCE_MS: "1000",
    BBS_TASK_LEASE_MS: String(LEASE_MS),
    BBS_LOBBY_WINDOW_MS: String(SPAN_MS),
    BBS_LOBBY_MUTE_MS: String(SPAN_MS),
    BBS_ARCHIVE_SCAN_MS: "3000",
  });
});

afterAll(async () => {
  for (const s of sockets) s.close();
  await b?.stop();
  await fake?.stop();
  rmSync(archiveDir, { recursive: true, force: true });
});

/** Every hot audit row, oldest first, with `detail` as stored text, and the chain state read with the last page. */
async function hotRows(): Promise<{ rows: AuditRow[]; chain: any }> {
  const rows: AuditRow[] = [];
  let after = 0;
  for (;;) {
    const v = await b.ok(b.human, "bbs_audit", { after_seq: after, limit: 1000 }, asCli);
    for (const e of v.events as any[]) rows.push(storedAuditRow(e));
    if (v.events.length < 1000) return { rows, chain: v.chain };
    after = v.events.at(-1).seq;
  }
}

async function topicState(name: string): Promise<string | undefined> {
  const v = await b.ok(b.human, "bbs_topics", { include_archived: true }, asCli);
  return (v.topics as { name: string; state: string }[]).find((t) => t.name === name)?.state;
}

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

describe("final (d): force archive → cancelled with notices → cold → restore → audit export verifies", () => {
  it("runs every audited action and verifies the exported chain across archive and hot rows", async () => {
    const H = b.human;
    // Accounts and flags.
    const coord = await b.addUser("coord");
    const dev = await b.addUser("dev");
    const ops = await b.addUser("ops");
    const noisy = await b.addUser("noisy");
    await b.ok(H, "bbs_admin_coordinator_grant", { handle: "coord" }, asCli);
    await b.ok(H, "bbs_admin_coordinator_grant", { handle: "ops" }, asCli);
    await b.ok(H, "bbs_admin_coordinator_remove", { handle: "ops" }, asCli);
    for (const t of [coord, ops, noisy]) await b.ok(t, "bbs_join", {});
    const session = (await b.ok(dev, "bbs_join", { harness: "scripted" })).session as string;
    await b.ok(dev, "bbs_role_set", { user: "dev", role: "builder" });
    await b.ok(coord, "bbs_role_set", { user: "ops", role: "operator" });
    expect((await b.ok(H, "bbs_whoami", {}, asCli)).handle).toBe("owner");

    // The adapter socket: open, hello, busy, idle, a ring and its result.
    const sock = await ScriptedAdapter.connect(b.server.url, dev);
    sockets.push(sock);
    sock.hello(session, "idle");
    sock.state("busy");
    sock.state("idle");

    // Topics, posts, reads.
    await b.ok(coord, "bbs_topic_create", { name: "proj", description: "the project" });
    await b.ok(coord, "bbs_topic_create", { name: "side" });
    await b.ok(dev, "bbs_subscribe", { topic: "proj", level: "wake" });
    await b.ok(ops, "bbs_subscribe", { topic: "side", level: "wake" });
    await b.ok(dev, "bbs_inbox", {});
    await b.ok(undefined, "bbs_post", { topic: "proj", body: "kickoff from the web" }, await b.web());
    const d = await sock.nthDoorbell(1, 10_000);
    expect(d?.text).toBe("BBS-5000: 1 new in #proj. Call bbs_inbox now, then continue your task.");
    sock.send({ type: "ring_result", id: d!.id, result: "turn_started", confirmed: true });
    await b.ok(dev, "bbs_inbox", {});
    await b.ok(dev, "bbs_read", { topic: "proj" });
    await b.ok(dev, "bbs_topics", {});
    await b.ok(dev, "bbs_who", {});
    await b.ok(undefined, "bbs_topic_mark_read", { topic: "proj", through_seq: 1 }, await b.web());
    // The web session (issue #47): the person signs this browser out, and a second one is revoked from the CLI.
    await b.ok(undefined, "bbs_web_sign_out", {}, await b.web());
    await b.ok(H, "bbs_web_session_revoke", { all: true }, asCli);

    // Tasks: t1 held by dev in proj; t2 open in proj; t3 in side, blocked by t2 (across topics).
    const t1 = (await b.ok(coord, "bbs_task_create", { topic: "proj", title: "build" })).task.id as number;
    const t2 = (await b.ok(coord, "bbs_task_create", { topic: "proj", title: "design" })).task.id as number;
    const t3 = (await b.ok(ops, "bbs_task_create", { topic: "side", title: "deploy" })).task.id as number;
    const t4 = (await b.ok(coord, "bbs_task_create", { topic: "proj", title: "spare" })).task.id as number;
    await b.ok(coord, "bbs_task_assign", { task: t1, assignee: "dev" });
    await b.ok(dev, "bbs_task_update", { task: t1, state: "in_progress" });
    await b.ok(dev, "bbs_task_comment", { task: t1, body: "started" });
    await b.ok(ops, "bbs_task_claim", { task: t3 });
    await b.ok(ops, "bbs_task_block", { task: t3, blocked_by: [t2, t4] });
    await b.ok(ops, "bbs_task_unblock", { task: t3, blocked_by: t4 });
    await b.ok(dev, "bbs_task_list", { topic: "proj" });
    await b.ok(coord, "bbs_task_update", { task: t4, state: "cancelled" });

    // A lease runs out: coord holds a task in side and goes quiet past the lease.
    const t5 = (await b.ok(coord, "bbs_task_create", { topic: "side", title: "watch" })).task.id as number;
    await b.ok(coord, "bbs_task_claim", { task: t5 });
    await b.ok(coord, "bbs_task_update", { task: t5, state: "in_progress" });
    await until("a lease check", async () => (await b.audit({ action: "lease_check" })).length > 0, 15_000);

    // Circuit breaker: two agents alternating past the threshold in one topic.
    await b.ok(noisy, "bbs_topic_create", { name: "chat" });
    await b.ok(ops, "bbs_subscribe", { topic: "chat", level: "wake" });
    for (let i = 0; i < 12; i++) await b.ok(i % 2 ? ops : noisy, "bbs_post", { topic: "chat", body: `turn ${i}` });
    expect((await b.audit({ action: "circuit_breaker" })).length).toBeGreaterThan(0);

    // The auto-administrator to a kick, the alarm's unmute on the way, and a reinstate.
    await flood(noisy, "one");
    await sleep(SPAN_MS + 200);
    await flood(noisy, "two");
    await until("the unmute", async () => (await b.audit({ action: "lobby_unmute" })).length > 0);
    await sleep(SPAN_MS + 200);
    expect((await flood(noisy, "three")).body.error.message).toMatch(/removed from the board/);
    // The kicked token is refused at sign-in (an `auth` denied row).
    expect((await b.raw(noisy, "bbs_inbox", {})).status).toBe(401);
    await b.ok(H, "bbs_admin_reinstate", { handle: "noisy" }, asCli);
    // Issue #98: a session handle for dev's token, which a person retires.
    const local = await b.ok(dev, "bbs_join", { harness_session: "hs-final" });
    await b.ok(H, "bbs_admin_session_handle_retire", { handle: local.handle }, asCli);
    await b.ok(H, "bbs_topic_keep", { topic: "side", on: true }, asCli);
    await b.ok(H, "bbs_topic_describe", { topic: "side", description: "Side work. Repos: example/side" }, asCli);

    // Force archive by the human admin: unfinished t1, t2 cancelled with the reason.
    const refused = await b.raw(coord, "bbs_topic_archive", { topic: "proj", reason: "dropped" });
    expect(refused.status).toBe(409);
    const archived = await b.ok(H, "bbs_topic_archive", { topic: "proj", reason: "dropped", force: true }, asCli);
    expect([...archived.cancelled].sort()).toEqual([t1, t2].sort());
    const devNotices = (await b.ok(dev, "bbs_inbox", {})).notices as any[];
    expect(devNotices).toEqual(expect.arrayContaining([expect.objectContaining({ task: t1, as: "assignee" })]));
    const opsNotices = (await b.ok(ops, "bbs_inbox", {})).notices as any[];
    expect(opsNotices).toEqual(expect.arrayContaining([expect.objectContaining({ task: t3, reason: "blocker_cancelled" })]));
    const coordNotices = JSON.stringify((await b.ok(coord, "bbs_inbox", {})).notices);
    expect(coordNotices).toContain(`"task":${t1}`);
    const t1Detail = (await b.ok(H, "bbs_task_list", { task: t1 }, asCli)).tasks[0];
    expect(t1Detail.state).toBe("cancelled");
    expect(t1Detail.comments.at(-1)).toMatchObject({ author: "owner", body: "dropped" });
    expect((await b.ok(ops, "bbs_task_list", { task: t3 })).tasks[0]).toMatchObject({ state: "blocked" });
    // The archived topic waits to go cold while t3 (unfinished, elsewhere) still names t2 as its
    // blocker; the assignee removes the cancelled blocker and t3 returns to its earlier state.
    // Proof the board looked: two alarm runs (each a scan, then the cold export) after
    // the topic became due for cold storage, not just a quiet interval.
    const coldDue = Date.parse(archived.archived_at) + COLD_AFTER_MS;
    await until(
      "two alarm runs after the topic was due to go cold",
      async () => (await b.audit({ action: "archive_scan" })).filter((e) => Date.parse(e.ts) > coldDue).length >= 2,
      20_000,
    );
    expect(await topicState("proj")).toBe("archived");
    const unblocked = await b.ok(ops, "bbs_task_unblock", { task: t3, blocked_by: t2 });
    expect(unblocked.task).toMatchObject({ state: "assigned" });

    // Cold by the alarm, then restored by the human admin; the tasks come back cancelled.
    await until("cold", async () => (await topicState("proj")) === "cold");
    const restored = await b.ok(H, "bbs_topic_unarchive", { topic: "proj" }, asCli);
    expect(restored).toMatchObject({ state: "active", restored: { tasks: 3 } });
    expect((await b.ok(H, "bbs_task_list", { task: t1 }, asCli)).tasks[0]).toMatchObject({ state: "cancelled" });
    // An unarchive of an archived (not cold) topic too.
    await b.ok(coord, "bbs_topic_archive", { topic: "chat", reason: "quiet" });
    await b.ok(coord, "bbs_topic_unarchive", { topic: "chat" });
    sock.close();

    // Let the export catch up and the hot period pass, then check the chain.
    await sleep(5_500);
    await b.ok(dev, "bbs_inbox", {});
    const { rows: hot, chain } = await until("an export covering the run and a pruned tail", async () => {
      const h = await hotRows();
      const lastAction = h.rows.findLast((r) => r.action === "topic_unarchive")!;
      return h.chain.exported_seq >= (lastAction?.seq ?? Infinity) && h.rows[0]!.seq > 1 ? h : undefined;
    }, 30_000);
    const batches = fake.sink.readAll().filter((x) => parseBatch(x.path, x.body).first <= chain.exported_seq);
    expect(chain.board_id).toMatch(/^[0-9a-f]{16}$/);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((x) => x.path.includes(`/${chain.board_id}-`))).toBe(true);
    const verify = (bs: typeof batches) =>
      verifyAuditArchive({
        boardId: chain.board_id,
        exportedSeq: chain.exported_seq,
        batches: bs,
        hot,
        tail: { seq: chain.tail_seq, hash: chain.tail_hash },
        head: chain.head,
        sha256,
      });
    expect(verify(batches)).toMatchObject({ ok: true });
    // Another board's id is refused, and so is an edited row in the archive.
    expect(
      verifyAuditArchive({
        boardId: "0000000000000000",
        exportedSeq: chain.exported_seq,
        batches,
        hot,
        tail: { seq: chain.tail_seq, hash: chain.tail_hash },
        head: chain.head,
        sha256,
      }).ok,
    ).toBe(false);
    const edited = batches.map((x, i) => (i === 1 ? { ...x, body: x.body.replace('"result":"ok"', '"result":"denied"') } : x));
    expect(verify(edited).ok).toBe(false);

    // Every audited action of the run is in archive + hot, in one total order.
    const all = new Map<number, AuditRow>();
    for (const x of batches) for (const r of parseBatch(x.path, x.body).rows) all.set(r.seq, r);
    for (const r of hot) all.set(r.seq, r);
    const seqs = [...all.keys()].sort((x, y) => x - y);
    expect(seqs[0]).toBe(1);
    expect(seqs.at(-1)! - seqs[0]! + 1).toBe(seqs.length);
    const seen = new Set([...all.values()].map((r) => r.action));
    // oauth_grant_revoke needs a connector's approval to end, and passkey_remove a registered passkey:
    // covered by oauth.test.ts and passkey.test.ts (e2e).
    const audited = Object.values(PUBLIC_ACTIONS)
      .filter((def) => def.kind !== "read" && def.name !== "oauth_grant_revoke" && def.name !== "passkey_remove")
      .map((def) => def.name);
    // Not here, each covered by another final scenario or suite: sockets_closed (b; noisy had no
    // socket), wake_budget_exceeded (c), audit_export_failed (audit-export.test.ts), archive
    // notices and auto-archive (unit, clock), topic_cold_failed and ring_undeliverable (unit),
    // web_session_renew and web_prune (unit, clock: a day and more), oauth_prune and the
    // OAuth token calls (oauth.test.ts, unit and e2e).
    const expected = [
      ...audited,
      ...Object.values(SOCKET_ACTIONS).map((def) => def.name),
      "bootstrap_human",
      "web_pair_start",
      "web_pair_claim",
      "auth",
      "doorbell_due",
      "lease_check",
      "lobby_offense",
      "lobby_unmute",
      "circuit_breaker",
      "archive_scan",
      "topic_cold_begin",
      "topic_cold",
      "topic_restore",
      "audit_export_begin",
      "audit_export",
      "audit_prune",
    ];
    expect(expected.filter((a) => !seen.has(a))).toEqual([]);
  });
});
