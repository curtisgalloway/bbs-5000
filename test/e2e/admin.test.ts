// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// M4a acceptance, end to end under `wrangler dev`: a Lobby flood through
// /api walks warn, mute (lifted by the real Durable Object alarm) and kick;
// the kicked token then gets 401; #admin-log carries a line per action; and
// failed sign-ins over the limit get 429 without an audit row each (B5).
// The board runs with a 1.5 s Lobby window and mute so this fits in a test;
// nothing else changes the clock. Closing a live socket on kick: budget.test.ts (M4b).

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, groupAlive, makeRunDir, sleep, startWrangler, type RunDir, type Server } from "./harness.ts";

const SPAN_MS = 1500;

let run: RunDir;
let server: Server;
let human: string;
const asCli = { "x-bbs-client": "cli" };

async function addUser(handle: string): Promise<string> {
  const r = await api(server.url, human, "bbs_admin_user_add", { handle }, asCli);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.value.token as string;
}

async function lobby(token: string, body: string): Promise<{ status: number; body: any }> {
  return api(server.url, token, "bbs_post", { topic: "Lobby", body });
}

/** Post to the Lobby until the first refusal; returns it. */
async function flood(token: string, tag: string): Promise<{ status: number; body: any }> {
  for (let i = 0; i < 20; i++) {
    const r = await lobby(token, `${tag}-${i}`);
    if (r.status !== 200) return r;
  }
  throw new Error("never refused");
}

async function statusOf(handle: string): Promise<string> {
  const r = await api(server.url, human, "bbs_who", {}, asCli);
  expect(r.status).toBe(200);
  return (r.body.value.users as { handle: string; status: string }[]).find((u) => u.handle === handle)?.status ?? "";
}

beforeAll(async () => {
  run = makeRunDir("owner", { BBS_LOBBY_WINDOW_MS: String(SPAN_MS), BBS_LOBBY_MUTE_MS: String(SPAN_MS) });
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

describe("auto-administrator over /api (A4.1, A4.2)", () => {
  it("warns, mutes in the Lobby only, lifts the mute by alarm, kicks, and the kicked token gets 401", async () => {
    const alice = await addUser("alice");
    const join = await api(server.url, alice, "bbs_join", { role: "flooder" });
    expect(join.status).toBe(200);
    await api(server.url, alice, "bbs_topic_create", { name: "work" });

    // Step 1: the join's system message does not count; five posts pass, the sixth is refused.
    for (let i = 0; i < 5; i++) expect((await lobby(alice, `one-${i}`)).status).toBe(200);
    const first = await lobby(alice, "one-5");
    expect(first.status).toBe(429);
    expect(first.body.error.code).toBe("rate_limited");
    expect(first.body.error.message).toMatch(/take it to a topic/);
    expect(first.body.error.message).toMatch(/Warning/);

    // Step 2: a second flood after the window, within the hour: Lobby mute.
    await sleep(SPAN_MS + 200);
    const second = await flood(alice, "two");
    expect(second.status).toBe(429);
    expect(second.body.error.message).toMatch(/muted in the Lobby/);
    expect(await statusOf("alice")).toBe("muted_lobby");
    expect((await api(server.url, alice, "bbs_post", { topic: "work", body: "still working" })).status).toBe(200);

    // The unmute timer runs through the Durable Object alarm.
    const deadline = Date.now() + 15_000;
    while ((await statusOf("alice")) !== "active") {
      if (Date.now() > deadline) throw new Error("mute was not lifted");
      await sleep(250);
    }

    // Step 3: a third flood within 24 hours kicks.
    await sleep(SPAN_MS + 200);
    const third = await flood(alice, "three");
    expect(third.status).toBe(429);
    expect(third.body.error.message).toMatch(/removed from the board and your token is revoked/);
    expect(await statusOf("alice")).toBe("kicked");

    // The revoked token is refused at sign-in, and the refusal is audited under alice.
    const after = await api(server.url, alice, "bbs_topics", {});
    expect(after.status).toBe(401);
    expect(after.body.error.message).toMatch(/revoked_token/);
    const audit = await api(server.url, human, "bbs_audit", { actor: "alice", action: "auth", limit: 10 }, asCli);
    expect(audit.status).toBe(200);
    expect(audit.body.value.events.at(-1)).toMatchObject({ actor: "alice", action: "auth", result: "denied" });

    // Every administrator action has a system line in #admin-log and an audit row.
    const log = await api(server.url, human, "bbs_read", { topic: "admin-log" }, asCli);
    expect(log.status).toBe(200);
    const lines = (log.body.value.messages as { body: string }[]).map((m) => m.body);
    expect(lines).toEqual([
      expect.stringMatching(/^lobby: warned alice/),
      expect.stringMatching(/^lobby: muted alice in Lobby/),
      "lobby: mute on alice ended",
      expect.stringMatching(/^kick: alice removed .*token revoked, 1 session\(s\) detached/),
    ]);
    const system = await api(server.url, human, "bbs_audit", { actor: "system", limit: 100 }, asCli);
    const actions = (system.body.value.events as { action: string; detail: { outcome?: string } }[])
      .filter((e) => e.action === "lobby_offense" || e.action === "lobby_unmute")
      .map((e) => `${e.action}:${e.detail.outcome}`);
    expect(actions).toEqual([
      "lobby_offense:warned",
      "lobby_offense:muted",
      "lobby_unmute:unmuted",
      "lobby_offense:kicked",
    ]);

    // #admin-log is the board's: users cannot post there.
    const bob = await addUser("bob");
    const fake = await api(server.url, bob, "bbs_post", { topic: "admin-log", body: "kick: bob removed" });
    expect(fake.status).toBe(403);
  });
});

describe("failed sign-in limit (B5)", () => {
  it("answers 429 past the limit without an audit row each, and still accepts a valid token", async () => {
    const before = await api(server.url, human, "bbs_audit", { action: "auth", limit: 1000 }, asCli);
    const n0 = (before.body.value.events as unknown[]).length;
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await api(server.url, `bad-${i}`, "bbs_topics", {})).status);
    // Earlier tests in this file used some of the window (the kicked token's 401).
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(5);
    expect(statuses.slice(0, statuses.indexOf(429)).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(statuses.indexOf(429)).every((s) => s === 429)).toBe(true);
    // The 429 says when to try again: whole seconds, inside the one-minute window (F review).
    const limited = await fetch(`${server.url}/api/bbs_topics`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bad-again" },
      body: "{}",
    });
    expect(limited.status).toBe(429);
    const retryAfter = limited.headers.get("retry-after");
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
    await limited.body?.cancel();
    const after = await api(server.url, human, "bbs_audit", { action: "auth", limit: 1000 }, asCli);
    const events = after.body.value.events as { detail: { source?: string; limit_reached?: boolean } }[];
    expect(events.length - n0).toBe(statuses.indexOf(429));
    expect(events.at(-1)?.detail).toMatchObject({ limit_reached: true });
    // The source key the Worker saw, for the evidence (no address is asserted).
    console.log(`sign-in source key under wrangler dev: ${String(events.at(-1)?.detail.source).replace(/^(ip:).*/, "$1<addr>")}`);
    expect((await api(server.url, human, "bbs_topics", {}, asCli)).status).toBe(200);
  });
});
