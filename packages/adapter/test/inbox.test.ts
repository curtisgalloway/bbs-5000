// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * G4: the Claude ring through the session's inbox socket, against a fake
 * inbox (a real unix socket server standing in for Claude Code's), with the
 * hook listener confirming rings from the posted text.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BoardApi, type FetchLike } from "../src/board-api.ts";
import { AGENT_GUIDE } from "@bbs-5000/core";
import { CHANNEL_METHOD, ClaudeRing, INSTRUCTIONS } from "../src/claude-ring.ts";
import { HookListener, messagingKey, promptOrigin, runHook } from "../src/hooks.ts";
import { claudeInbox, InboxError, inboxDoorbell, inboxTarget, inboxText, postToInbox, type InboxTarget } from "../src/inbox-socket.ts";

const TEXT = "BBS-5000: 2 new in #t (1 mention). Call bbs_inbox now, then continue your task.";
const TOKEN = "messaging-token-for-test";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "bbs-i-"));
  dirs.push(d);
  return d;
}

interface FakeInbox {
  target: InboxTarget;
  /** Each connection's lines, parsed. */
  connections: Record<string, unknown>[][];
  /** Called with each user message's content, as Claude Code would start a turn. */
  onMessage?: (content: string) => void;
}

/** A stand-in for Claude Code's inbox socket: reads newline-delimited JSON, answers nothing. */
async function fakeInbox(): Promise<FakeInbox> {
  const path = join(tmp(), "inbox.sock");
  const f: FakeInbox = { target: { socketPath: path, token: TOKEN }, connections: [] };
  const server = createServer((sock) => {
    const lines: Record<string, unknown>[] = [];
    f.connections.push(lines);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
        buf = buf.slice(i + 1);
        lines.push(line);
        if (line.type === "user") f.onMessage?.(String((line.message as { content: unknown }).content));
      }
    });
    sock.on("error", () => undefined);
  });
  await new Promise<void>((r) => server.listen(path, () => r()));
  servers.push(server);
  return f;
}

const noFetch: FetchLike = async () => ({ status: 500, json: async () => ({ ok: false }) });

async function ringWith(o: Partial<ConstructorParameters<typeof ClaudeRing>[0]> & { hooks: HookListener }): Promise<{
  ring: ClaudeRing;
  notes: { method: string; params: unknown }[];
  logs: { event: string; detail?: Record<string, unknown> }[];
}> {
  const logs: { event: string; detail?: Record<string, unknown> }[] = [];
  const { hooks, ...rest } = o;
  const ring = new ClaudeRing({
    api: new BoardApi({ url: "http://board.test", token: "tok", fetch: noFetch }),
    session: () => "s_one",
    busy: () => ({
      lastBusyAt: hooks.lastBusyAt,
      seen: hooks.seen,
      busyNow: hooks.current() === "busy",
      doorbellTurnAt: (id) => hooks.doorbellTurnAt(id),
      lastUnknownBusyAt: hooks.lastUnknownBusyAt,
    }),
    log: (event, detail) => logs.push({ event, ...(detail ? { detail } : {}) }),
    confirmMs: 400,
    ...rest,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fake-claude", version: "0" });
  const notes: { method: string; params: unknown }[] = [];
  client.fallbackNotificationHandler = async (n) => {
    notes.push({ method: n.method, params: n.params });
  };
  await ring.connect(b);
  await client.connect(a);
  return { ring, notes, logs };
}

/** What Claude Code does with a delivered message: a turn whose UserPromptSubmit prompt is the text. */
function startsTurn(hooks: HookListener): (content: string) => void {
  return (content) => hooks.event("UserPromptSubmit", promptOrigin(JSON.stringify({ prompt: content })));
}

describe("inbox target and marker (G4)", () => {
  it("uses the inbox only when both variables are set", () => {
    expect(inboxTarget({ CLAUDE_CODE_MESSAGING_SOCKET: "/x/s", CLAUDE_CODE_MESSAGING_TOKEN: "t" })).toEqual({ socketPath: "/x/s", token: "t" });
    expect(inboxTarget({ CLAUDE_CODE_MESSAGING_SOCKET: "/x/s" })).toBeUndefined();
    expect(inboxTarget({ CLAUDE_CODE_MESSAGING_TOKEN: "t" })).toBeUndefined();
    expect(inboxTarget({ CLAUDE_CODE_MESSAGING_SOCKET: " ", CLAUDE_CODE_MESSAGING_TOKEN: "t" })).toBeUndefined();
    expect(inboxTarget({})).toBeUndefined();
    const both = { CLAUDE_CODE_MESSAGING_SOCKET: "/x/s", CLAUDE_CODE_MESSAGING_TOKEN: "t" };
    expect(claudeInbox(both)).toEqual({ socketPath: "/x/s", token: "t" });
    expect(claudeInbox({ ...both, BBS_CLAUDE_RING: "channel" })).toBeUndefined();
    expect(claudeInbox({ ...both, BBS_CLAUDE_RING: "auto" })).toEqual({ socketPath: "/x/s", token: "t" });
  });

  it("appends the marker, numbering repeats, and reads the id back only from a whole doorbell line", () => {
    expect(inboxText(TEXT, "d_Ab-9_x")).toBe(`${TEXT} [bbs doorbell d_Ab-9_x]`);
    expect(inboxText(TEXT, "d_Ab-9_x", 2)).toBe(`${TEXT} [bbs doorbell d_Ab-9_x 2]`);
    expect(inboxDoorbell(inboxText(TEXT, "d_Ab-9_x"))).toBe("d_Ab-9_x");
    expect(inboxDoorbell(inboxText(TEXT, "d_Ab-9_x", 3))).toBe("d_Ab-9_x");
    expect(inboxDoorbell(`  ${inboxText(TEXT, "d_1")}\n`)).toBe("d_1");
    // Not a doorbell line: typed text quoting a marker, the marker mid-line,
    // a second line, no BBS-5000 prefix, a bad id, too long.
    expect(inboxDoorbell("Please look at [bbs doorbell d_1]")).toBeUndefined();
    expect(inboxDoorbell(`${inboxText(TEXT, "d_1")} thanks`)).toBeUndefined();
    expect(inboxDoorbell(`${TEXT}\nmore [bbs doorbell d_1]`)).toBeUndefined();
    expect(inboxDoorbell(`bbs-5000: x [bbs doorbell d_1]`)).toBeUndefined();
    expect(inboxDoorbell(`BBS-5000: x [bbs doorbell x_1]`)).toBeUndefined();
    expect(inboxDoorbell(`BBS-5000: x [bbs doorbell d_1 12345]`)).toBeUndefined();
    expect(inboxDoorbell(`BBS-5000: ${"x".repeat(1100)} [bbs doorbell d_1]`)).toBeUndefined();
  });

  it("the UserPromptSubmit hook reads an inbox doorbell, and still never confuses a typed prompt", () => {
    const input = (prompt: string): string => JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt });
    expect(promptOrigin(input(inboxText(TEXT, "d_in1")))).toEqual({ doorbells: ["d_in1"] });
    expect(promptOrigin(input(inboxText(TEXT, "d_in1", 2)))).toEqual({ doorbells: ["d_in1"] });
    expect(promptOrigin(input("What does [bbs doorbell d_in1] mean?"))).toEqual({ origin: "prompt" });
    // The channel form still works.
    expect(promptOrigin(input(`<channel source="bbs" doorbell="d_c1">${TEXT}</channel>`))).toEqual({ doorbells: ["d_c1"] });
  });

  it("the hook command reports an inbox doorbell's id to the adapter, never the text", async () => {
    const dir = join(tmp(), "s");
    const env = { BBS_ADAPTER_SOCKET_DIR: dir, CLAUDE_CODE_MESSAGING_SOCKET: "/some/claude/socket" };
    const lines: Record<string, unknown>[] = [];
    const l = new HookListener((event, detail) => lines.push({ event, ...detail }));
    await l.listen(dir, [messagingKey(env)!]);
    try {
      const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: inboxText(TEXT, "d_h1") });
      expect(await runHook("UserPromptSubmit", env, 999_999, () => undefined, input)).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(l.doorbellTurnAt("d_h1")).toBeGreaterThan(0);
      expect(lines).toContainEqual({ event: "UserPromptSubmit", origin: "doorbell" });
      expect(JSON.stringify(lines)).not.toContain("BBS-5000");
    } finally {
      l.close();
    }
  });

  it("tells the model about both doorbell forms", () => {
    expect(INSTRUCTIONS).toContain("[bbs doorbell d_...]");
    expect(INSTRUCTIONS).toContain("<channel");
  });

  it("carries the default way to use the board (docs/agent-defaults.md)", () => {
    expect(INSTRUCTIONS.endsWith(AGENT_GUIDE)).toBe(true);
  });
});

describe("postToInbox (G4)", () => {
  it("writes the auth line, then the user message, then closes", async () => {
    const f = await fakeInbox();
    await postToInbox(f.target, "hello", { lingerMs: 20 });
    await new Promise((r) => setTimeout(r, 20));
    expect(f.connections).toEqual([
      [
        { type: "auth", token: TOKEN },
        { type: "user", message: { role: "user", content: "hello" } },
      ],
    ]);
  });

  it("rejects with a short code, never the path or the token, when there is no socket", async () => {
    const d = tmp();
    const err = await postToInbox({ socketPath: join(d, "missing.sock"), token: TOKEN }, "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InboxError);
    expect((err as InboxError).code).toBe("ENOENT");
    expect((err as Error).message).not.toContain(d);
    expect((err as Error).message).not.toContain(TOKEN);
    const file = join(d, "plain-file");
    writeFileSync(file, "");
    const err2 = await postToInbox({ socketPath: file, token: TOKEN }, "x").catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(InboxError);
  });
});

describe("ClaudeRing through the inbox (G4)", () => {
  it("posts the doorbell with its marker to the inbox, pushes no channel event, and confirms by the marker", async () => {
    const f = await fakeInbox();
    const hooks = new HookListener(() => undefined);
    hooks.event("Stop"); // hooks are configured
    f.onMessage = startsTurn(hooks);
    const { ring, notes } = await ringWith({ hooks, inbox: f.target });
    expect(await ring.ring({ id: "d_1", text: TEXT })).toEqual({ result: "turn_started", confirmed: true, via: "inbox" });
    expect(f.connections[0]![1]).toEqual({ type: "user", message: { role: "user", content: `${TEXT} [bbs doorbell d_1]` } });
    expect(f.connections[0]![0]).toEqual({ type: "auth", token: TOKEN });
    hooks.event("Stop");
    // The same doorbell rung again (B57 re-ring) is not an identical message.
    expect(await ring.ring({ id: "d_1", text: TEXT })).toMatchObject({ result: "turn_started", confirmed: true });
    expect(f.connections[1]![1]).toEqual({ type: "user", message: { role: "user", content: `${TEXT} [bbs doorbell d_1 2]` } });
    await new Promise((r) => setTimeout(r, 10));
    expect(notes).toEqual([]);
  });

  it("a delivered message that starts no turn (held or refused by Claude Code) fails, with no channel push", async () => {
    const f = await fakeInbox();
    const hooks = new HookListener(() => undefined);
    hooks.event("Stop");
    const { ring, notes } = await ringWith({ hooks, inbox: f.target });
    expect(await ring.ring({ id: "d_2", text: TEXT })).toEqual({ result: "failed", confirmed: false, via: "inbox" });
    expect(f.connections).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  it("a typed prompt during the wait is not the doorbell's turn: held_busy (B57)", async () => {
    const f = await fakeInbox();
    const hooks = new HookListener(() => undefined);
    hooks.event("Stop");
    f.onMessage = () => hooks.event("UserPromptSubmit", promptOrigin(JSON.stringify({ prompt: "typed by the person" })));
    const { ring } = await ringWith({ hooks, inbox: f.target });
    expect(await ring.ring({ id: "d_3", text: TEXT })).toEqual({ result: "held_busy", confirmed: false, via: "inbox" });
  });

  it("falls back to the channel when the inbox post fails, and logs only a short code", async () => {
    const d = tmp();
    const hooks = new HookListener(() => undefined);
    hooks.event("Stop");
    const target = { socketPath: join(d, "gone.sock"), token: TOKEN };
    const { ring, notes, logs } = await ringWith({ hooks, inbox: target });
    expect(await ring.ring({ id: "d_4", text: TEXT })).toEqual({ result: "failed", confirmed: false, via: "channel" });
    await new Promise((r) => setTimeout(r, 10));
    expect(notes).toEqual([{ method: CHANNEL_METHOD, params: { content: TEXT, meta: { doorbell: "d_4" } } }]);
    expect(logs).toContainEqual({ event: "inbox_error", detail: { id: "d_4", code: "ENOENT" } });
    expect(JSON.stringify(logs)).not.toContain(d);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it("the channel fallback is confirmed by its own <channel> turn, as before", async () => {
    const hooks = new HookListener(() => undefined);
    hooks.event("Stop");
    const { ring } = await ringWith({
      hooks,
      inbox: { socketPath: "/x", token: TOKEN },
      postInbox: async () => {
        throw new InboxError("ECONNREFUSED");
      },
      sleep: async (ms) => {
        hooks.event("UserPromptSubmit", { doorbells: ["d_5"] });
        await new Promise((r) => setTimeout(r, ms));
      },
    });
    expect(await ring.ring({ id: "d_5", text: TEXT })).toEqual({ result: "turn_started", confirmed: true, via: "channel" });
  });

  it("without an inbox target it rings by the channel only (unchanged path)", async () => {
    const hooks = new HookListener(() => undefined);
    let posted = 0;
    const { ring, notes } = await ringWith({
      hooks,
      postInbox: async () => {
        posted += 1;
      },
    });
    // No hook seen yet: turn_started unconfirmed (B56), as before.
    expect(await ring.ring({ id: "d_6", text: TEXT })).toEqual({ result: "turn_started", confirmed: false, via: "channel" });
    await new Promise((r) => setTimeout(r, 10));
    expect(posted).toBe(0);
    expect(notes).toHaveLength(1);
  });

  it("a non-InboxError from the post is logged as error and still falls back", async () => {
    const hooks = new HookListener(() => undefined);
    hooks.event("Stop");
    const { ring, logs, notes } = await ringWith({
      hooks,
      inbox: { socketPath: "/x", token: TOKEN },
      postInbox: async () => {
        throw new Error("boom /secret/path");
      },
    });
    expect((await ring.ring({ id: "d_7", text: TEXT })).via).toBe("channel");
    await new Promise((r) => setTimeout(r, 10));
    expect(notes).toHaveLength(1);
    expect(logs).toContainEqual({ event: "inbox_error", detail: { id: "d_7", code: "error" } });
  });
});
