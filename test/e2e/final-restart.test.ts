// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// F, scenario (e), under `wrangler dev`: stop and start the board in the
// middle of work, over the same state directory and port. Kept across the
// restart: users and tokens, an archived topic, a task's lease (its timer runs
// out after the restart, through the alarm), a doorbell left pending for an
// agent with no adapter (rung when it attaches after the restart), the board
// id and the audit chain. The real adapter's board connection (`BoardSocket`)
// reconnects by itself and is rung again.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BoardSocket } from "../../packages/adapter/src/board-socket.ts";
import { verifyAuditArchive } from "../../packages/core/src/audit-export.ts";
import type { AuditRow } from "../../packages/core/src/audit.ts";
import { asCli, startBoard, until, type Board } from "./final-helpers.ts";
import { sha256, sleep, storedAuditRow } from "./harness.ts";
import { ScriptedAdapter } from "./scripted-adapter.ts";

const DEBOUNCE_MS = 1000;
// Long enough that a slow restart still ends before the lease runs out (F review).
const LEASE_MS = 20_000;

let b: Board;
let socket: BoardSocket | undefined;
const sockets: ScriptedAdapter[] = [];

beforeAll(async () => {
  b = await startBoard({ BBS_DOORBELL_DEBOUNCE_MS: String(DEBOUNCE_MS), BBS_TASK_LEASE_MS: String(LEASE_MS) });
});

afterAll(async () => {
  socket?.stop();
  for (const s of sockets) s.close();
  await b?.stop();
});

async function hot(): Promise<{ rows: AuditRow[]; chain: any }> {
  const v = await b.ok(b.human, "bbs_audit", { limit: 1000 }, asCli);
  expect(v.events.length).toBeLessThan(1000);
  const rows = (v.events as any[]).map(storedAuditRow);
  return { rows, chain: v.chain };
}

describe("final (e): a restart of wrangler dev mid-scenario keeps the board's state", () => {
  it("keeps tokens, topics, a running lease, a pending doorbell and the chain; the adapter reconnects", async () => {
    const lead = await b.addUser("lead");
    const live = await b.addUser("live");
    const away = await b.addUser("away");
    await b.ok(b.human, "bbs_admin_coordinator_grant", { handle: "lead" }, asCli);
    await b.ok(lead, "bbs_join", {});
    const awaySession = (await b.ok(away, "bbs_join", { harness: "scripted" })).session as string;
    await b.ok(lead, "bbs_topic_create", { name: "work" });
    await b.ok(lead, "bbs_topic_create", { name: "old" });
    for (const t of [live, away]) await b.ok(t, "bbs_subscribe", { topic: "work", level: "wake" });
    await b.ok(b.human, "bbs_topic_archive", { topic: "old", reason: "done with it" }, asCli);

    // live runs the real adapter's board connection.
    let session: string | undefined;
    const doorbells: string[] = [];
    const logs: string[] = [];
    socket = new BoardSocket({
      url: b.server.url,
      token: live,
      session: () => session,
      ensureSession: async () => {
        session = (await b.ok(live, "bbs_join", { harness: "claude-code" })).session as string;
      },
      resetSession: () => {
        session = undefined;
      },
      harness: "claude-code",
      state: () => "idle",
      onDoorbell: (d) => {
        doorbells.push(d.text);
      },
      onStopped: () => undefined,
      log: (event) => logs.push(event),
      initialBackoffMs: 200,
      maxBackoffMs: 1000,
    });
    socket.start();
    await until("the adapter attached", async () => socket!.connected, 5000);
    await b.ok(live, "bbs_inbox", {});
    await b.ok(away, "bbs_inbox", {});

    // A task in progress for live: its lease timer is in SQLite.
    const task = (await b.ok(lead, "bbs_task_create", { topic: "work", title: "migrate" })).task.id as number;
    await b.ok(live, "bbs_task_claim", { task });
    await b.ok(live, "bbs_task_update", { task, state: "in_progress" });

    // A post: live is rung now; away has no adapter, so its doorbell waits.
    await b.ok(lead, "bbs_post", { topic: "work", body: "before the restart" });
    await until("live rung", async () => doorbells.length === 1, 10_000);
    await sleep(DEBOUNCE_MS + 500);
    const before = await hot();
    const pendingAway = before.rows.filter((r) => r.action === "doorbell_due" && r.target_id === "away");
    expect(pendingAway.length).toBeGreaterThan(0);
    expect(doorbells).toEqual(["BBS-5000: 1 new in #work. Call bbs_inbox now, then continue your task."]);
    // live's last call renews its lease; the board's own expiry time is the reference.
    await b.ok(live, "bbs_inbox", {});
    const expiresAt = Date.parse((await b.ok(lead, "bbs_task_list", { task })).tasks[0].lease_expires_at);
    expect(expiresAt).toBeGreaterThan(Date.now());

    // Restart.
    await b.restart();
    // The lease has not run out yet: the expiry that follows is the alarm re-armed from SQLite.
    const afterRestart = (await b.ok(lead, "bbs_task_list", { task })).tasks[0];
    expect(afterRestart, `restart took past the lease (${Date.now() - expiresAt} ms late)`).toMatchObject({ stale: false });
    expect(Date.parse(afterRestart.lease_expires_at)).toBe(expiresAt);

    // Tokens, topics and messages survive.
    expect((await b.ok(b.human, "bbs_whoami", {}, asCli)).handle).toBe("owner");
    const topics = (await b.ok(lead, "bbs_topics", { include_archived: true })).topics as any[];
    expect(topics.find((t) => t.name === "old")).toMatchObject({ state: "archived" });
    expect((await b.ok(lead, "bbs_read", { topic: "work" })).messages.map((m: any) => m.body)).toEqual(["before the restart"]);

    // The adapter reconnects by itself (same session) and is rung for a new post.
    await until("the adapter reattached", async () => socket!.connected, 15_000);
    expect(logs).toContain("reconnect_scheduled");
    await sleep(300);
    await b.ok(lead, "bbs_post", { topic: "work", body: "after the restart" });
    await until("live rung again", async () => doorbells.length === 2, 10_000);
    expect(doorbells[1]).toBe("BBS-5000: 1 new in #work. Call bbs_inbox now, then continue your task.");

    // away's pending doorbell rings when it attaches, with both posts in it.
    const sock = await ScriptedAdapter.connect(b.server.url, away);
    sockets.push(sock);
    sock.hello(awaySession, "idle");
    const d = await sock.nthDoorbell(1, 10_000);
    expect(d?.text).toBe("BBS-5000: 2 new in #work. Call bbs_inbox now, then continue your task.");

    // The lease set before the restart runs out after it, through the alarm. (live keeps
    // calling only through its socket, which does not renew leases.)
    await until(
      "the lease to run out",
      async () => (await b.ok(lead, "bbs_task_list", { task })).tasks[0].stale === true,
      expiresAt - Date.now() + 15_000,
    );
    const leadNotices = JSON.stringify((await b.ok(lead, "bbs_inbox", {})).notices);
    expect(leadNotices).toMatch(/lease/);

    // The chain verifies from genesis over both runs, with the same board id.
    const after = await hot();
    expect(after.chain.board_id).toBe(before.chain.board_id);
    expect(after.rows[0]!.seq).toBe(1);
    const verdict = verifyAuditArchive({
      boardId: after.chain.board_id,
      exportedSeq: after.chain.exported_seq,
      batches: [],
      hot: after.rows,
      tail: { seq: after.chain.tail_seq, hash: after.chain.tail_hash },
      head: after.chain.head,
      sha256,
    });
    expect(verdict).toMatchObject({ ok: true });
    // The rows from before the restart are unchanged.
    expect(after.rows.slice(0, before.rows.length)).toEqual(before.rows);
  });
});
