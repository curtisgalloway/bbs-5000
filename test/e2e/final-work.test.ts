// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// F, scenario (a), under `wrangler dev`: a person posts through the web
// client; the agent's (scripted) adapter is rung with a doorbell that holds no
// message text; the agent reads its inbox (the post is human, via web, as peer
// content), claims the person's task and takes it to done. Then the topic is
// archived, and its subscriptions send nothing (M2 × M6b): posts and task
// changes are refused and no doorbell follows.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asCli, startBoard, type Board } from "./final-helpers.ts";
import { sleep } from "./harness.ts";
import { ScriptedAdapter } from "./scripted-adapter.ts";

const DEBOUNCE_MS = 1000;

let b: Board;
const sockets: ScriptedAdapter[] = [];

beforeAll(async () => {
  b = await startBoard({ BBS_DOORBELL_DEBOUNCE_MS: String(DEBOUNCE_MS) });
});

afterAll(async () => {
  for (const s of sockets) s.close();
  await b?.stop();
});

describe("final (a): web post → doorbell → agent reads, claims, finishes", () => {
  it("rings the agent for a person's web post and the agent completes the person's task", async () => {
    const dev = await b.addUser("dev");
    const other = await b.addUser("other");
    const session = (await b.ok(dev, "bbs_join", { harness: "scripted" })).session as string;
    await b.ok(other, "bbs_join", {});

    // The person makes the topic and a task from the web view.
    await b.ok(undefined, "bbs_topic_create", { name: "build", description: "release work" }, await b.web());
    const task = (await b.ok(undefined, "bbs_task_create", { topic: "build", title: "ship the parser" }, await b.web())).task;
    expect(task).toMatchObject({ state: "open", created_by: "owner" });
    await b.ok(dev, "bbs_subscribe", { topic: "build", level: "wake" });
    await b.ok(other, "bbs_subscribe", { topic: "build", level: "wake" });
    await b.ok(dev, "bbs_inbox", {});
    await b.ok(other, "bbs_inbox", {});

    const sock = await ScriptedAdapter.connect(b.server.url, dev);
    sockets.push(sock);
    sock.hello(session, "idle");
    await sleep(200);

    const body = "Please take the parser task; it blocks the release.";
    const posted = await b.ok(undefined, "bbs_post", { topic: "build", body }, await b.web());
    expect(posted).toMatchObject({ topic: "build", seq: expect.any(Number) });

    const d = await sock.nthDoorbell(1, 10_000);
    expect(d?.text).toBe("BBS-5000: 1 new in #build. Call bbs_inbox now, then continue your task.");
    expect(JSON.stringify(sock.frames)).not.toContain("parser");
    sock.send({ type: "ring_result", id: d!.id, result: "turn_started", confirmed: true });

    // The agent's turn: inbox, then the task.
    const inbox = await b.raw(dev, "bbs_inbox", {});
    expect(inbox.status).toBe(200);
    expect(inbox.body.peer_content_notice).toBeTruthy();
    expect(inbox.body.value.wake).toEqual([
      expect.objectContaining({ peer_content: true, author: "owner", kind: "human", via: "web", topic: "build", body }),
    ]);
    await b.ok(dev, "bbs_task_claim", { task: task.id });
    await b.ok(dev, "bbs_task_update", { task: task.id, state: "in_progress" });
    await b.ok(dev, "bbs_task_comment", { task: task.id, body: "parser done, tests green" });
    await b.ok(dev, "bbs_task_update", { task: task.id, state: "in_review", comment: "ready" });
    const done = await b.ok(undefined, "bbs_task_update", { task: task.id, state: "done" }, await b.web());
    expect(done.task).toMatchObject({ state: "done", assignee: "dev", stale: false });

    const detail = (await b.ok(b.human, "bbs_task_list", { task: task.id }, asCli)).tasks[0];
    expect(detail.comments.map((c: any) => c.state_change).filter(Boolean)).toEqual([
      "open>assigned",
      "assigned>in_progress",
      "in_progress>in_review",
      "in_review>done",
    ]);

    // The record: the post, the ring and the adapter's result, the task path, in order.
    const rows = (await b.audit()).filter((e) => e.result === "ok");
    const seqOf = (pred: (e: any) => boolean) => rows.find(pred)?.seq as number;
    const postSeq = seqOf((e) => e.action === "post" && e.actor === "owner" && e.via === "web");
    const ringSeq = seqOf((e) => e.action === "doorbell_due" && e.target_id === "dev" && e.detail.ring?.result === "rung");
    const resultSeq = seqOf((e) => e.action === "ring_result" && e.actor === "dev" && e.via === "ws");
    const inboxSeq = seqOf((e) => e.action === "inbox" && e.actor === "dev" && e.seq > postSeq);
    const claimSeq = seqOf((e) => e.action === "task_claim" && e.actor === "dev");
    expect(postSeq).toBeLessThan(ringSeq);
    expect(ringSeq).toBeLessThan(resultSeq);
    expect(resultSeq).toBeLessThan(inboxSeq);
    expect(inboxSeq).toBeLessThan(claimSeq);
    expect(rows.find((e) => e.action === "ring_result" && e.actor === "dev")?.detail).toMatchObject({ result: "turn_started" });

    // The person's done is a comment on a task dev holds: that always wakes (design §6).
    const d2 = await sock.nthDoorbell(2, 10_000);
    expect(d2?.text).toBe("BBS-5000: 1 comment on your task. Call bbs_inbox now, then continue your task.");
    sock.send({ type: "ring_result", id: d2!.id, result: "turn_started", confirmed: true });
    const notices = (await b.ok(dev, "bbs_inbox", {})).notices;
    expect(notices).toMatchObject([
      { kind: "task", reason: "task_comment", wake: true, task: task.id, topic: "build", as: "assignee", actor: "owner" },
    ]);
    const rungBefore = sock.doorbells().length;

    // other got its own doorbell for the same post (no adapter, so it waits).
    const otherInbox = await b.ok(other, "bbs_inbox", {});
    expect(otherInbox.wake.map((m: any) => m.body)).toContain(body);

    // M2 × M6b: archive the finished topic. Subscriptions stay, but nothing can be sent.
    const archived = await b.ok(b.human, "bbs_topic_archive", { topic: "build", reason: "released" }, asCli);
    expect(archived).toMatchObject({ state: "archived", archived_by: "owner" });
    const date = new Date(archived.archived_at).toISOString().slice(0, 10);
    const text = `Topic archived on ${date} by owner. Ask a coordinator to unarchive it.`;
    for (const [token, tool, args] of [
      [other, "bbs_post", { topic: "build", body: "@dev one more thing" }],
      [b.human, "bbs_post", { topic: "build", body: "@dev from me too" }],
      [other, "bbs_task_create", { topic: "build", title: "late" }],
      [other, "bbs_task_comment", { task: task.id, body: "late comment" }],
    ] as const) {
      const r = await b.raw(token, tool, args, token === b.human ? asCli : {});
      expect(r.status, tool).toBe(409);
      expect(r.body.error).toEqual({ code: "topic_archived", message: text });
    }
    // Prove the board has processed everything above before checking for silence:
    // a sentinel post in another topic must give the next doorbell, and it names
    // only that one post (a doorbell pending from #build would have been merged in).
    await b.ok(b.human, "bbs_topic_create", { name: "sentinel" }, asCli);
    await b.ok(dev, "bbs_subscribe", { topic: "sentinel", level: "wake" });
    await b.ok(b.human, "bbs_post", { topic: "sentinel", body: "sentinel" }, asCli);
    const d3 = await sock.nthDoorbell(rungBefore + 1, 10_000);
    expect(d3?.text).toBe("BBS-5000: 1 new in #sentinel. Call bbs_inbox now, then continue your task.");
    expect(sock.doorbells()).toHaveLength(rungBefore + 1);
    const after = await b.ok(dev, "bbs_inbox", {});
    expect(after.wake.map((m: any) => m.topic)).toEqual(["sentinel"]);
    // The subscription is kept (design §14).
    const topics = await b.ok(dev, "bbs_topics", { include_archived: true });
    expect(topics.topics.find((t: any) => t.name === "build")).toMatchObject({ state: "archived", level: "wake" });
  });
});
