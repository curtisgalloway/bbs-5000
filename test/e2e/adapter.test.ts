// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// The real adapter process (packages/adapter) against `wrangler dev`, with
// this test standing in for Claude Code: it starts the adapter over stdio as
// an MCP client (SDK 1.x, as Claude Code would), receives its channel
// events, runs `bbs-adapter hook <event>` processes for the busy/idle hooks,
// and calls bbs_inbox through the adapter as the model would. This is the
// dry run of the Claude ring; a real Claude Code session is the Curtis-run
// gate (test/manual/).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { api, groupAlive, makeRunDir, ROOT, sleep, startWrangler, type RunDir, type Server } from "./harness.ts";

const BIN = join(ROOT, "packages/adapter/bin/bbs-adapter.js");
const DEBOUNCE_MS = 1000;
const QUIET_MS = DEBOUNCE_MS + 2000;

let run: RunDir;
let server: Server;
let human: string;
const asCli = { "x-bbs-client": "cli" };

async function addUser(handle: string): Promise<string> {
  const r = await api(server.url, human, "bbs_admin_user_add", { handle }, asCli);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.value.token as string;
}

async function call(token: string, tool: string, args: unknown = {}): Promise<any> {
  const r = await api(server.url, token, tool, args);
  expect(r.status, `${tool}: ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.value;
}

interface FakeClaude {
  client: Client;
  events: { at: number; content: string; params: Record<string, unknown> }[];
  env: Record<string, string>;
  logFile: string;
  /** Run a hook command; `prompt` is the `UserPromptSubmit` input's prompt text. */
  hook(event: string, prompt?: string): void;
  log(): Record<string, unknown>[];
  waitEvent(n: number, ms: number): Promise<FakeClaude["events"][number] | undefined>;
  waitLog(pred: (l: Record<string, unknown>) => boolean, ms: number): Promise<boolean>;
}

async function startClaude(token: string, name: string, opts: { cwd?: string; sessionId?: string } = {}): Promise<FakeClaude> {
  const dir = join(run.dir, name);
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ url: server.url, token }), { mode: 0o600 });
  const logFile = join(dir, "adapter.jsonl");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    BBS_CONFIG: config,
    BBS_ADAPTER_LOG: logFile,
    BBS_MACHINE: "workstation-1",
    BBS_ADAPTER_SOCKET_DIR: join(dir, "sock"),
    CLAUDE_CODE_MESSAGING_SOCKET: join(dir, "claude-messaging.sock"),
    ...(opts.sessionId !== undefined ? { CLAUDE_CODE_SESSION_ID: opts.sessionId } : {}),
  };
  const client = new Client({ name: "fake-claude-code", version: "0" });
  const events: FakeClaude["events"] = [];
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") {
      const params = (n.params ?? {}) as Record<string, unknown>;
      events.push({ at: Date.now(), content: String(params.content), params });
    }
  };
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [BIN], env, ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}), stderr: "ignore" }),
  );
  const c: FakeClaude = {
    client,
    events,
    env,
    logFile,
    hook(event, prompt) {
      // As Claude Code runs a hook command: JSON on stdin, our environment.
      const r = spawnSync(process.execPath, [BIN, "hook", event], {
        input: JSON.stringify({ hook_event_name: event, ...(prompt !== undefined ? { prompt } : {}) }),
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    },
    log() {
      try {
        return readFileSync(logFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>);
      } catch {
        return [];
      }
    },
    async waitEvent(n, ms) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && events.length < n) await sleep(50);
      return events[n - 1];
    },
    async waitLog(pred, ms) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (c.log().some(pred)) return true;
        await sleep(50);
      }
      return false;
    },
  };
  return c;
}

/**
 * The prompt Claude Code gives a channel-started turn (I0): the event as a
 * `<channel>` tag with each meta entry as an attribute.
 */
function channelPrompt(e: FakeClaude["events"][number]): string {
  const meta = (e.params.meta ?? {}) as Record<string, string>;
  const attrs = Object.entries(meta).map(([k, v]) => ` ${k}="${v}"`).join("");
  return `<channel source="bbs"${attrs}>${e.content}</channel>`;
}

/** One fake turn started by the latest channel event: busy hook, bbs_inbox through the adapter, idle hook. Returns the inbox value. */
async function turn(c: FakeClaude): Promise<any> {
  c.hook("UserPromptSubmit", channelPrompt(c.events.at(-1)!));
  const r = await c.client.callTool({ name: "bbs_inbox", arguments: {} });
  c.hook("Stop");
  return r.structuredContent;
}

const claudes: FakeClaude[] = [];

beforeAll(async () => {
  run = makeRunDir("owner", { BBS_DOORBELL_DEBOUNCE_MS: String(DEBOUNCE_MS) });
  human = run.humanToken;
  server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
});

afterAll(async () => {
  for (const c of claudes) await c.client.close().catch(() => undefined);
  await server?.stop();
  if (server) expect(groupAlive(server.pid)).toBe(false);
  run?.cleanup();
});

describe("adapter process with a stand-in Claude Code", () => {
  it("wakes on a post, holds while busy, skips Lobby digest, rings an @mention, never rings own posts", async () => {
    const a = await addUser("aa");
    const b = await addUser("ab");
    await call(a, "bbs_join", {});
    await call(a, "bbs_topic_create", { name: "at" });
    await call(b, "bbs_subscribe", { topic: "at", level: "wake" });
    await call(b, "bbs_inbox", {});
    const c = await startClaude(b, "ab");
    claudes.push(c);
    expect(await c.waitLog((l) => l.ev === "attached", 10_000)).toBe(true);
    // The adapter joined: a session with the harness, attached over /ws.
    const who = await call(a, "bbs_who", {});
    expect(who.users.find((u: any) => u.handle === "ab")).toMatchObject({ harness: "claude-code", session: "idle" });
    await call(b, "bbs_inbox", {}); // b's join message in the Lobby is digest; start clean

    // A2.1: idle session, A posts; the channel event arrives with the doorbell text only.
    const t0 = Date.now();
    const posted = await call(a, "bbs_post", { topic: "at", body: "please look at the parser" });
    const e1 = await c.waitEvent(1, 10_000);
    expect(e1?.content).toBe("BBS-5000: 1 new in #at. Call bbs_inbox now, then continue your task.");
    expect(e1!.at - t0).toBeLessThan(10_000);
    expect(Object.keys(e1!.params)).toEqual(["content", "meta"]);
    expect(e1!.params.meta).toEqual({ doorbell: expect.stringMatching(/^d_[A-Za-z0-9_-]+$/) });
    const inbox1 = await turn(c);
    expect(inbox1.wake.map((m: any) => m.seq)).toEqual([posted.seq]);
    // No hook had fired before this first ring, but the busy hook of the turn
    // arrived within the adapter's wait, so it is confirmed (B56; before, it
    // was reported unconfirmed at once).
    expect(await c.waitLog((l) => l.ev === "ring" && l.result === "turn_started" && l.confirmed === true, 5000)).toBe(true);

    // A2.4: busy (a typed prompt); a post is held, then rung after Stop.
    c.hook("UserPromptSubmit", "Refactor the parser.");
    await sleep(300);
    await call(a, "bbs_post", { topic: "at", body: "while you are busy" });
    await sleep(QUIET_MS);
    expect(c.events).toHaveLength(1);
    const tStop = Date.now();
    c.hook("Stop");
    const e2 = await c.waitEvent(2, 5000);
    expect(e2?.content).toBe("BBS-5000: 1 new in #at. Call bbs_inbox now, then continue your task.");
    expect(e2!.at - tStop).toBeLessThan(3000);
    await turn(c);
    // Hooks are known now: this ring was confirmed by the busy hook.
    expect(await c.waitLog((l) => l.ev === "ring" && l.result === "turn_started" && l.confirmed === true, 5000)).toBe(true);

    // A2.5: Lobby post rings nothing; an @mention in the Lobby does.
    await call(a, "bbs_post", { topic: "Lobby", body: "hello all" });
    // A2.6: b's own post (b's token, as the model would through its tools) never rings b.
    await c.client.callTool({ name: "bbs_post", arguments: { topic: "at", body: "my own update, @ab" } });
    await sleep(QUIET_MS);
    expect(c.events).toHaveLength(2);
    await call(a, "bbs_post", { topic: "Lobby", body: "@ab a question for you" });
    const e3 = await c.waitEvent(3, 10_000);
    expect(e3?.content).toBe("BBS-5000: 1 new in #Lobby (1 mention). Call bbs_inbox now, then continue your task.");
    const inbox3 = await turn(c);
    expect(inbox3.wake.map((m: any) => m.topic)).toEqual(["Lobby"]);

    // The model's bbs_join (setting a role) keeps the adapter's session attached.
    await c.client.callTool({ name: "bbs_join", arguments: { role: "parser work" } });
    await call(a, "bbs_post", { topic: "at", body: "still there?" });
    expect((await c.waitEvent(4, 10_000))?.content).toBe("BBS-5000: 1 new in #at. Call bbs_inbox now, then continue your task.");

    // The adapter's log holds ids and counts, never message text or the token.
    const raw = readFileSync(c.logFile, "utf8");
    expect(raw).not.toContain("parser");
    expect(raw).not.toContain(b);
  });

  it("B57: a typed prompt does not confirm a ring; a doorbell turn that ends without bbs_inbox rings again", async () => {
    const a = await addUser("ra");
    const b = await addUser("rb");
    await call(a, "bbs_join", {});
    await call(a, "bbs_topic_create", { name: "rt" });
    await call(b, "bbs_subscribe", { topic: "rt", level: "wake" });
    const c = await startClaude(b, "rb");
    claudes.push(c);
    expect(await c.waitLog((l) => l.ev === "attached", 10_000)).toBe(true);
    await call(b, "bbs_inbox", {});
    c.hook("Stop"); // hooks are configured (seen)

    // The person types a prompt right after the doorbell is pushed: the ring is
    // not confirmed by it; the session is busy, so the board holds it.
    await call(a, "bbs_post", { topic: "rt", body: "one" });
    const e1 = await c.waitEvent(1, 10_000);
    c.hook("UserPromptSubmit", "Fix the failing test.");
    expect(await c.waitLog((l) => l.ev === "ring" && l.result === "held_busy", 15_000)).toBe(true);
    expect(c.log().some((l) => l.ev === "ring" && l.result === "turn_started")).toBe(false);
    // The typed turn ends: the held doorbell rings again (same doorbell).
    c.hook("Stop");
    const e2 = await c.waitEvent(2, 10_000);
    expect(e2?.params.meta).toEqual(e1?.params.meta);

    // The doorbell's own turn starts and ends without bbs_inbox (B49's model
    // declining): confirmed, then rung once more at the idle report.
    c.hook("UserPromptSubmit", channelPrompt(e2!));
    c.hook("Stop");
    const e3 = await c.waitEvent(3, 10_000);
    expect(e3?.params.meta).toEqual(e1?.params.meta);
    expect(c.log().filter((l) => l.ev === "ring" && l.result === "turn_started" && l.confirmed === true)).toHaveLength(1);
    const audit = await api(server.url, human, "bbs_audit", { actor: "rb", action: "session_state" }, asCli);
    expect(audit.status, JSON.stringify(audit.body)).toBe(200);
    const reRing = (audit.body.value.events as any[]).filter((r) => r.detail?.re_ring === "turn_ended");
    expect(reRing).toHaveLength(1);

    // This time the model reads the board: nothing rings after its turn.
    await turn(c);
    await sleep(QUIET_MS);
    expect(c.events).toHaveLength(3);
  });

  it("two adapters on one agent token: the newer one holds the board; the other waits, and takes it back when its model uses a tool (review M1)", async () => {
    const a = await addUser("ta");
    const t = await addUser("tb");
    await call(a, "bbs_join", {});
    await call(a, "bbs_topic_create", { name: "tt" });
    await call(t, "bbs_subscribe", { topic: "tt", level: "wake" });
    const c1 = await startClaude(t, "tb1");
    claudes.push(c1);
    expect(await c1.waitLog((l) => l.ev === "attached", 10_000)).toBe(true);
    const c2 = await startClaude(t, "tb2");
    claudes.push(c2);
    expect(await c2.waitLog((l) => l.ev === "attached", 10_000)).toBe(true);
    expect(await c1.waitLog((l) => l.ev === "replaced", 10_000)).toBe(true);
    await call(t, "bbs_inbox", {});

    await call(a, "bbs_post", { topic: "tt", body: "first" });
    expect((await c2.waitEvent(1, 10_000))?.content).toBe("BBS-5000: 1 new in #tt. Call bbs_inbox now, then continue your task.");
    await turn(c2);
    expect(c1.events).toHaveLength(0);

    // c1's model uses a tool: a fresh join (never the ended session), c1 attaches, c2 waits.
    const who = await c1.client.callTool({ name: "bbs_who", arguments: {} });
    expect(who.isError).toBeFalsy();
    expect(await c1.waitLog((l) => l.ev === "resumed", 10_000)).toBe(true);
    expect(await c2.waitLog((l) => l.ev === "replaced", 10_000)).toBe(true);
    await call(a, "bbs_post", { topic: "tt", body: "second" });
    expect((await c1.waitEvent(1, 10_000))?.content).toBe("BBS-5000: 1 new in #tt. Call bbs_inbox now, then continue your task.");
    await turn(c1);

    // No fight: neither joins again on its own.
    const joins = (c: FakeClaude): number => c.log().filter((l) => l.ev === "joined").length;
    const before = [joins(c1), joins(c2)];
    await sleep(QUIET_MS);
    expect([joins(c1), joins(c2)]).toEqual(before);
    expect(before).toEqual([2, 1]);
  });
  it("issue #100: an adapter started in a git repository joins by itself, with its own session handle and wake adapter, and one outside a repository stays off the board", async () => {
    const watcher = await addUser("ja");
    const inRepo = await addUser("jp");
    const outside = await addUser("jq");
    await call(watcher, "bbs_join", {});
    const repo = join(run.dir, "widget-app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const elsewhere = join(run.dir, "not-a-repo");
    mkdirSync(elsewhere, { recursive: true });

    // Neither test call below is a bbs_join: the adapter does it.
    const c = await startClaude(inRepo, "jp1", { cwd: repo, sessionId: "auto-join-session-one" });
    claudes.push(c);
    const other = await startClaude(outside, "jq1", { cwd: elsewhere, sessionId: "auto-join-session-two" });
    claudes.push(other);

    const mine = async (parent: string): Promise<any[]> => {
      const board = await call(watcher, "bbs_who", {});
      return board.users.filter((u: any) => u.parent === parent);
    };
    let handles: any[] = [];
    for (const until = Date.now() + 40_000; Date.now() < until && !handles.some((u) => u.sessions?.[0]?.wake === "adapter"); await sleep(250)) {
      handles = await mine("jp");
    }
    expect(handles).toHaveLength(1);
    expect(handles[0].handle).toMatch(/^jp-[a-z2-7]{4}$/);
    expect(handles[0]).toMatchObject({ harness: "claude-code", role: "widget-app: (no task yet)" });
    expect(handles[0].sessions.map((s: any) => s.wake)).toEqual(["adapter"]);
    expect(JSON.stringify(handles[0])).not.toContain(run.dir);

    // The session-start hook, run as Claude Code would, tells the model who it is on the board.
    const started = spawnSync(process.execPath, [BIN, "hook", "SessionStart"], {
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
      env: c.env,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(started.status).toBe(0);
    const text = JSON.parse(started.stdout).hookSpecificOutput.additionalContext as string;
    expect(text).toContain(handles[0].handle);
    expect(text).toContain("bbs_inbox");

    // Outside a repository nothing joined; the tools still work and the first use joins it, as before.
    expect(await mine("jq")).toEqual([]);
    const none = spawnSync(process.execPath, [BIN, "hook", "SessionStart"], {
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
      env: other.env,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(JSON.parse(none.stdout).hookSpecificOutput.additionalContext).toContain("has not joined");
    const r = await other.client.callTool({ name: "bbs_whoami", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect((await mine("jq")).length).toBe(1);
  });
});
