// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The adapter without a board or Claude Code: the board socket against a
 * fake WebSocket, the shared adapter's hold-while-busy, the Claude ring
 * against an in-memory MCP client (SDK 1.x), and the hook socket for real.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PEER_CONTENT_NOTICE, SESSION_ENDED_MARKER } from "@bbs-5000/core";
import { Adapter } from "../src/adapter.ts";
import { BoardApi, isRevokedToken, type FetchLike } from "../src/board-api.ts";
import { BoardSocket, CredentialRevokedError, type SessionState, type SocketLike } from "../src/board-socket.ts";
import { CHANNEL_METHOD, ClaudeRing } from "../src/claude-ring.ts";
import { ensureSocketDir, hookKeys, HookListener, messagingKey, pidKey, promptOrigin, runHook, socketDir } from "../src/hooks.ts";
import { claudeHarnessSession, codexHarnessSession, run, sessionLabels } from "../src/main.ts";
import type { RingFunction, StateSource } from "../src/ring.ts";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "bbs-adapter.js");

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  readonly #l: Record<string, ((ev: any) => void)[]> = {};
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  addEventListener(type: string, cb: (ev: any) => void): void {
    (this.#l[type] ??= []).push(cb);
  }
  #emit(type: string, ev: unknown): void {
    for (const cb of this.#l[type] ?? []) cb(ev);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code = 1000, reason = ""): void {
    this.serverClose(code, reason);
  }
  open(): void {
    this.readyState = 1;
    this.#emit("open", {});
  }
  frame(obj: unknown): void {
    this.#emit("message", { data: JSON.stringify(obj) });
  }
  serverClose(code: number, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit("close", { code, reason });
  }
}

interface Harness {
  sockets: FakeSocket[];
  timers: { fn: () => void; ms: number }[];
  logs: { event: string; detail?: Record<string, unknown> }[];
  state: SessionState;
  session: string | undefined;
  joins: number;
  resets: number;
  socket: BoardSocket;
  doorbells: { id: string; text: string }[];
  flush(): Promise<void>;
}

function harness(over: Partial<ConstructorParameters<typeof BoardSocket>[0]> = {}): Harness {
  const h = {
    sockets: [] as FakeSocket[],
    timers: [] as { fn: () => void; ms: number }[],
    logs: [] as { event: string; detail?: Record<string, unknown> }[],
    state: "idle" as SessionState,
    session: undefined as string | undefined,
    joins: 0,
    resets: 0,
    doorbells: [] as { id: string; text: string }[],
  } as Harness;
  let t = 1_000_000;
  h.socket = new BoardSocket({
    url: "http://board.test/",
    token: "tok_secret",
    session: () => h.session,
    async ensureSession() {
      h.joins += 1;
      h.session = "s_one";
    },
    resetSession() {
      h.resets += 1;
      h.session = undefined;
    },
    harness: "test",
    machine: "workstation-1",
    state: () => h.state,
    onDoorbell: (d) => h.doorbells.push(d),
    log: (event, detail) => h.logs.push({ event, ...(detail ? { detail } : {}) }),
    connect: (url, headers) => {
      const s = new FakeSocket(url, headers);
      h.sockets.push(s);
      return s;
    },
    random: () => 1,
    setTimer: (fn, ms) => {
      h.timers.push({ fn, ms });
      return h.timers.length;
    },
    clearTimer: () => undefined,
    now: () => (t += 1000),
    ...over,
  });
  h.flush = () => new Promise((r) => setTimeout(r, 0));
  return h;
}

describe("BoardSocket (spec §4.3)", () => {
  it("joins when it has no session, then says hello with the session and current state", async () => {
    const h = harness();
    h.state = "busy";
    h.socket.start();
    await h.flush();
    expect(h.joins).toBe(1);
    const s = h.sockets[0]!;
    expect(s.url).toBe("ws://board.test/ws");
    expect(s.headers).toEqual({ authorization: "Bearer tok_secret" });
    s.open();
    expect(s.sent).toEqual([
      { type: "hello", session: "s_one", harness: "test", machine: "workstation-1", state: "busy" },
    ]);
    s.frame({ type: "doorbell", id: "d_1", text: "BBS-5000: 1 new in #t. Call bbs_inbox now, then continue your task." });
    expect(h.doorbells).toEqual([{ id: "d_1", text: "BBS-5000: 1 new in #t. Call bbs_inbox now, then continue your task." }]);
    h.socket.sendState("idle");
    h.socket.sendRingResult("d_1", "turn_started", true);
    expect(s.sent.slice(1)).toEqual([
      { type: "state", state: "idle" },
      { type: "ring_result", id: "d_1", result: "turn_started", confirmed: true },
    ]);
    // The token never reaches the log.
    expect(JSON.stringify(h.logs)).not.toContain("tok_secret");
  });

  it("reconnects with exponential backoff, capped, and drops state sent while down", async () => {
    const h = harness({ initialBackoffMs: 1000, maxBackoffMs: 4000 });
    h.socket.start();
    await h.flush();
    h.sockets[0]!.open();
    h.sockets[0]!.serverClose(1006);
    h.socket.sendState("busy");
    expect(h.sockets[0]!.sent).toHaveLength(1);
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const timer = h.timers.at(-1)!;
      delays.push(timer.ms);
      timer.fn();
      await h.flush();
      h.sockets.at(-1)!.serverClose(1006);
    }
    expect(delays).toEqual([1000, 2000, 4000, 4000]);
    expect(h.joins).toBe(1);
  });

  it("jitters each delay between half and all of the backoff step (F review N01)", async () => {
    const rolls = [0, 0.5, 0.25];
    const h = harness({ initialBackoffMs: 1000, maxBackoffMs: 8000, random: () => rolls.shift() ?? 1 });
    h.socket.start();
    await h.flush();
    h.sockets[0]!.serverClose(1006);
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      const timer = h.timers.at(-1)!;
      delays.push(timer.ms);
      timer.fn();
      await h.flush();
      h.sockets.at(-1)!.serverClose(1006);
    }
    // base 1000, 2000, 4000 times (0.5 + r / 2).
    expect(delays).toEqual([500, 1500, 2500]);
  });

  it("a connection that stayed up stableMs resets the backoff; a short one does not (F review N02)", async () => {
    let t = 0;
    const h = harness({ initialBackoffMs: 1000, maxBackoffMs: 30_000, stableMs: 60_000, now: () => t });
    h.socket.start();
    await h.flush();
    const delays: number[] = [];
    const cycle = async (upFor: number): Promise<void> => {
      h.sockets.at(-1)!.open();
      t += upFor;
      h.sockets.at(-1)!.serverClose(1006);
      const timer = h.timers.at(-1)!;
      delays.push(timer.ms);
      timer.fn();
      await h.flush();
    };
    await cycle(1_000); // short: attempt 0 -> 1000
    await cycle(1_000); // short: 2000
    await cycle(1_000); // short: 4000
    await cycle(60_000); // stable: back to 1000
    await cycle(59_999); // just short of stable: 2000
    expect(delays).toEqual([1000, 2000, 4000, 1000, 2000]);
  });

  it("waits after 4001 (session replaced) until resumed, stops on a kicked frame, forgets the session on 4003", async () => {
    const h = harness();
    h.socket.start();
    await h.flush();
    h.sockets[0]!.open();
    h.sockets[0]!.serverClose(4003, "refused");
    expect(h.resets).toBe(1);
    h.timers.at(-1)!.fn();
    await h.flush();
    expect(h.joins).toBe(2);
    h.sockets[1]!.open();
    h.sockets[1]!.serverClose(4001, "session replaced");
    // Review M1: not stopped, the session forgotten, no reconnect scheduled.
    expect(h.socket.stopped).toBeUndefined();
    expect(h.socket.replaced).toBe(true);
    expect(h.resets).toBe(2);
    expect(h.session).toBeUndefined();
    const timers = h.timers.length;
    await h.flush();
    expect(h.timers.length).toBe(timers);
    expect(h.sockets).toHaveLength(2);
    // resume() joins fresh and attaches again.
    h.socket.resume();
    await h.flush();
    expect(h.joins).toBe(3);
    expect(h.sockets).toHaveLength(3);
    h.sockets[2]!.open();
    expect(h.sockets[2]!.sent[0]).toMatchObject({ type: "hello", session: h.session });

    const k = harness();
    k.socket.start();
    await k.flush();
    k.sockets[0]!.open();
    k.sockets[0]!.frame({ type: "kicked", reason: "flood" });
    expect(k.socket.stopped).toBe("kicked");
  });

  it("a revoked token at bbs_join is terminal: stops, logs credential_revoked, no retry (review m4)", async () => {
    let joins = 0;
    const h = harness({
      async ensureSession() {
        joins += 1;
        throw new CredentialRevokedError("bbs_join refused: revoked_token");
      },
    });
    h.socket.start();
    await h.flush();
    expect(h.socket.stopped).toBe("credential revoked");
    expect(h.logs).toContainEqual({ event: "credential_revoked", detail: { reason: "bbs_join refused: revoked_token" } });
    expect(h.timers).toHaveLength(0);
    expect(h.sockets).toHaveLength(0);
    expect(joins).toBe(1);
    // Any other join failure still retries.
    const g = harness({
      async ensureSession() {
        throw new Error("board down");
      },
    });
    g.socket.start();
    await g.flush();
    expect(g.socket.stopped).toBeUndefined();
    expect(g.timers).toHaveLength(1);
  });

  it("a connection that never opened asks probeCredential: revoked stops, anything else retries (review m4)", async () => {
    let probes = 0;
    const h = harness({
      async probeCredential() {
        probes += 1;
        throw new CredentialRevokedError("upgrade refused: revoked_token");
      },
    });
    h.socket.start();
    await h.flush();
    h.sockets[0]!.serverClose(1006, "");
    await h.flush();
    expect(probes).toBe(1);
    expect(h.socket.stopped).toBe("credential revoked");
    expect(h.timers).toHaveLength(0);

    const g = harness({ async probeCredential() {} });
    g.socket.start();
    await g.flush();
    g.sockets[0]!.serverClose(1006, "");
    await g.flush();
    expect(g.socket.stopped).toBeUndefined();
    expect(g.timers).toHaveLength(1);
    // A connection that opened and then dropped does not probe.
    let opened = 0;
    const k = harness({
      async probeCredential() {
        opened += 1;
      },
    });
    k.socket.start();
    await k.flush();
    k.sockets[0]!.open();
    k.sockets[0]!.serverClose(1006, "");
    await k.flush();
    expect(opened).toBe(0);
    expect(k.timers).toHaveLength(1);
  });

  it("recognizes a revoked-token answer from the board", () => {
    expect(isRevokedToken({ status: 401, body: { ok: false, error: { code: "unauthorized", message: "authentication failed: revoked_token" } } })).toBe(true);
    expect(isRevokedToken({ status: 401, body: { ok: false, error: { code: "unauthorized", message: "authentication failed: unknown_token" } } })).toBe(false);
    expect(isRevokedToken({ status: 429, body: { ok: false, error: { message: "revoked_token" } } })).toBe(false);
  });

  it("stops for good on 4004 (credential revoked, M4b) and logs why; no reconnect", async () => {
    for (const [reason, stopped] of [
      ["kicked: token revoked", "kicked"],
      ["credential revoked or replaced", "credential revoked"],
    ] as const) {
      const h = harness();
      h.socket.start();
      await h.flush();
      h.sockets[0]!.open();
      const timers = h.timers.length;
      h.sockets[0]!.serverClose(4004, reason);
      expect(h.socket.stopped).toBe(stopped);
      expect(h.logs).toContainEqual({ event: "credential_revoked", detail: { reason } });
      await h.flush();
      expect(h.timers.length).toBe(timers);
      expect(h.sockets).toHaveLength(1);
      // resume() does nothing once stopped.
      h.socket.resume();
      await h.flush();
      expect(h.sockets).toHaveLength(1);
    }
  });

  it("a 4001 that arrives after a fresh join (a tool call raced it) attaches with the new session at once", async () => {
    const h = harness();
    h.socket.start();
    await h.flush();
    h.sockets[0]!.open();
    h.session = "s_two"; // joined again by a tool call
    h.sockets[0]!.serverClose(4001, "session replaced");
    await h.flush();
    expect(h.socket.replaced).toBe(false);
    expect(h.resets).toBe(0);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.open();
    expect(h.sockets[1]!.sent[0]).toMatchObject({ type: "hello", session: "s_two" });
  });

  it("retries the join with backoff when the board is down", async () => {
    const h = harness({
      ensureSession: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });
    h.socket.start();
    await h.flush();
    expect(h.sockets).toHaveLength(0);
    expect(h.timers).toHaveLength(1);
    expect(h.logs.map((l) => l.event)).toContain("join_failed");
  });
});

class FakeState implements StateSource {
  s: SessionState = "idle";
  #cbs: ((s: SessionState) => void)[] = [];
  current(): SessionState {
    return this.s;
  }
  onChange(cb: (s: SessionState) => void): void {
    this.#cbs.push(cb);
  }
  set(s: SessionState): void {
    this.s = s;
    for (const cb of this.#cbs) cb(s);
  }
}

describe("Adapter: hold while busy", () => {
  it("answers held_busy without ringing while busy, rings when idle, and reports state changes", async () => {
    const state = new FakeState();
    const rung: string[] = [];
    const ring: RingFunction = {
      harness: "test",
      async ring(d) {
        rung.push(d.id);
        return { result: "turn_started", confirmed: true };
      },
    };
    const sockets: FakeSocket[] = [];
    const adapter = new Adapter({
      url: "http://board.test",
      token: "t",
      session: () => "s_one",
      ensureSession: async () => undefined,
      resetSession: () => undefined,
      ring,
      state,
      log: () => undefined,
      connect: (url, headers) => {
        const s = new FakeSocket(url, headers);
        sockets.push(s);
        return s;
      },
    });
    adapter.start();
    await new Promise((r) => setTimeout(r, 0));
    const s = sockets[0]!;
    s.open();
    state.set("busy");
    s.frame({ type: "doorbell", id: "d_1", text: "x" });
    await new Promise((r) => setTimeout(r, 0));
    expect(rung).toEqual([]);
    state.set("idle");
    s.frame({ type: "doorbell", id: "d_1", text: "x" });
    await new Promise((r) => setTimeout(r, 0));
    expect(rung).toEqual(["d_1"]);
    expect(s.sent.slice(1)).toEqual([
      { type: "state", state: "busy" },
      { type: "ring_result", id: "d_1", result: "held_busy" },
      { type: "state", state: "idle" },
      { type: "ring_result", id: "d_1", result: "turn_started", confirmed: true },
    ]);
    adapter.stop();
  });

  it("holds an idle report back until the ring in progress has sent its ring_result (B57)", async () => {
    const state = new FakeState();
    let finish: () => void = () => undefined;
    const ring: RingFunction = {
      harness: "test",
      ring: () =>
        new Promise((resolve) => {
          finish = () => resolve({ result: "turn_started", confirmed: true });
        }),
    };
    const sockets: FakeSocket[] = [];
    const adapter = new Adapter({
      url: "http://board.test",
      token: "t",
      session: () => "s_one",
      ensureSession: async () => undefined,
      resetSession: () => undefined,
      ring,
      state,
      log: () => undefined,
      connect: (url, headers) => {
        const s = new FakeSocket(url, headers);
        sockets.push(s);
        return s;
      },
    });
    adapter.start();
    await new Promise((r) => setTimeout(r, 0));
    const s = sockets[0]!;
    s.open();
    s.frame({ type: "doorbell", id: "d_1", text: "x" });
    await new Promise((r) => setTimeout(r, 0));
    // The doorbell's turn starts and ends while the ring is still waiting.
    state.set("busy");
    state.set("idle");
    expect(s.sent.slice(1)).toEqual([{ type: "state", state: "busy" }]);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.sent.slice(1)).toEqual([
      { type: "state", state: "busy" },
      { type: "ring_result", id: "d_1", result: "turn_started", confirmed: true },
      { type: "state", state: "idle" },
    ]);
    adapter.stop();
  });
});

function fakeFetch(calls: { url: string; headers: Record<string, string>; body: unknown }[]): FetchLike {
  return async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (url.endsWith("/bbs_inbox")) {
      return { status: 200, json: async () => ({ ok: true, value: { wake: [{ seq: 7, body: "peer words" }], digest: [], notices: [] } }) };
    }
    return { status: 409, json: async () => ({ ok: false, error: { code: "conflict", message: "nope" } }) };
  };
}

async function linked(ring: ClaudeRing): Promise<{ client: Client; notes: { method: string; params: unknown }[] }> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "fake-claude", version: "0" });
  const notes: { method: string; params: unknown }[] = [];
  client.fallbackNotificationHandler = async (n) => {
    notes.push({ method: n.method, params: n.params });
  };
  await ring.connect(b);
  await client.connect(a);
  return { client, notes };
}

describe("ClaudeRing (spec §4.4)", () => {
  it("declares claude/channel, serves the bbs tools (no admin) and proxies them with the session", async () => {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const ring = new ClaudeRing({
      api: new BoardApi({ url: "http://board.test", token: "tok", fetch: fakeFetch(calls) }),
      session: () => "s_one",
      busy: () => ({ lastBusyAt: 0, seen: false }),
      log: () => undefined,
    });
    const { client } = await linked(ring);
    expect(client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });
    expect(client.getInstructions()).toMatch(/bbs_inbox/);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("bbs_inbox");
    expect(names).toContain("bbs_task_claim");
    expect(names).not.toContain("bbs_admin_user_add");
    const inbox = await client.callTool({ name: "bbs_inbox", arguments: {} });
    expect(calls[0]).toMatchObject({
      url: "http://board.test/api/bbs_inbox",
      headers: { authorization: "Bearer tok", "x-bbs-session": "s_one" },
    });
    const text = (inbox.content as { text: string }[])[0]!.text;
    expect(text.startsWith(PEER_CONTENT_NOTICE)).toBe(true);
    const err = await client.callTool({ name: "bbs_post", arguments: { topic: "t", body: "x" } });
    expect(err.isError).toBe(true);
    expect((err.content as { text: string }[])[0]!.text).toBe("Error (conflict): nope");
    const unknown = await client.callTool({ name: "bbs_admin_user_add", arguments: { handle: "x" } });
    expect(unknown.isError).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("joins fresh before a tool call when it has no session, and retries once when the board says the session ended", async () => {
    let session: string | undefined;
    let joins = 0;
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers });
      if (init.headers["x-bbs-session"] === "s_gone") {
        return {
          status: 401,
          json: async () => ({ ok: false, error: { code: "unauthorized", message: `this session has ended (a later bbs_join replaced it); join again ${SESSION_ENDED_MARKER}` } }),
        };
      }
      return { status: 200, json: async () => ({ ok: true, value: {} }) };
    };
    const ring = new ClaudeRing({
      api: new BoardApi({ url: "http://board.test", token: "tok", fetch }),
      session: () => session,
      busy: () => ({ lastBusyAt: 0, seen: false }),
      log: () => undefined,
      async prepareCall() {
        if (session !== undefined) return;
        joins += 1;
        session = `s_new${joins}`;
      },
      sessionEnded() {
        session = undefined;
      },
    });
    const { client } = await linked(ring);
    await client.callTool({ name: "bbs_who", arguments: {} });
    expect(joins).toBe(1);
    expect(calls.at(-1)!.headers["x-bbs-session"]).toBe("s_new1");
    session = "s_gone";
    const r = await client.callTool({ name: "bbs_who", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(joins).toBe(2);
    expect(calls.map((c) => c.headers["x-bbs-session"])).toEqual(["s_new1", "s_gone", "s_new2"]);
  });

  it("joins again on a retired session handle's refusal (the shared marker, whatever the wording), and not on text alone", async () => {
    const run = async (message: string): Promise<number> => {
      let session: string | undefined = "s_retired";
      let joins = 0;
      const fetch: FetchLike = async (_url, init) =>
        init.headers["x-bbs-session"] === "s_retired"
          ? { status: 401, json: async () => ({ ok: false, error: { code: "unauthorized", message } }) }
          : { status: 200, json: async () => ({ ok: true, value: {} }) };
      const ring = new ClaudeRing({
        api: new BoardApi({ url: "http://board.test", token: "tok", fetch }),
        session: () => session,
        busy: () => ({ lastBusyAt: 0, seen: false }),
        log: () => undefined,
        async prepareCall() {
          if (session !== undefined) return;
          joins += 1;
          session = `s_new${joins}`;
        },
        sessionEnded() {
          session = undefined;
        },
      });
      const { client } = await linked(ring);
      await client.callTool({ name: "bbs_who", arguments: {} });
      return joins;
    };
    expect(await run(`this session has ended: p-ab2c was retired after a long time with no session; join again ${SESSION_ENDED_MARKER}`)).toBe(1);
    expect(await run(`reworded entirely ${SESSION_ENDED_MARKER}`)).toBe(1);
    expect(await run("this session has ended, said some other way")).toBe(0);
  });

  it("rings with one channel event whose content is the doorbell text only", async () => {
    let busy = { lastBusyAt: 0, seen: false };
    let now = 1000;
    const ring = new ClaudeRing({
      api: new BoardApi({ url: "http://board.test", token: "tok", fetch: fakeFetch([]) }),
      session: () => "s_one",
      busy: () => busy,
      log: () => undefined,
      confirmMs: 500,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    expect(await ring.ring({ id: "d_0", text: "too early" })).toEqual({ result: "failed" });
    const { notes } = await linked(ring);
    const text = "BBS-5000: 2 new in #t (1 mention). Call bbs_inbox now, then continue your task.";
    // No hook seen yet and none arrives within confirmMs: delivered, cannot tell (B56).
    const before = now;
    expect(await ring.ring({ id: "d_1", text })).toEqual({ result: "turn_started", confirmed: false, via: "channel" });
    expect(now - before).toBeGreaterThanOrEqual(500);
    await new Promise((r) => setTimeout(r, 10));
    expect(notes).toEqual([{ method: CHANNEL_METHOD, params: { content: text, meta: { doorbell: "d_1" } } }]);
    // No hook seen yet, but a busy hook arrives within confirmMs: confirmed.
    busy = { lastBusyAt: 0, seen: false };
    const first = ring.ring({ id: "d_1b", text });
    busy = { lastBusyAt: now + 50, seen: true };
    expect(await first).toEqual({ result: "turn_started", confirmed: true, via: "channel" });
    // Hooks configured: a busy hook after the push confirms the turn.
    busy = { lastBusyAt: 0, seen: true };
    const pending = ring.ring({ id: "d_2", text });
    busy = { lastBusyAt: now + 50, seen: true };
    expect(await pending).toEqual({ result: "turn_started", confirmed: true, via: "channel" });
    // Hooks configured but no busy hook: failed (the board rings again at the next idle).
    busy = { lastBusyAt: 0, seen: true };
    expect(await ring.ring({ id: "d_3", text })).toEqual({ result: "failed", confirmed: false, via: "channel" });
  });

  it("confirms a ring only by its own doorbell's turn, not by a typed prompt (B57)", async () => {
    let now = 1000;
    const hooks = new HookListener(() => undefined, { now: () => now });
    let onSleep: () => void = () => undefined;
    const ring = new ClaudeRing({
      api: new BoardApi({ url: "http://board.test", token: "tok", fetch: fakeFetch([]) }),
      session: () => "s_one",
      busy: () => ({
        lastBusyAt: hooks.lastBusyAt,
        seen: hooks.seen,
        busyNow: hooks.current() === "busy",
        doorbellTurnAt: (id) => hooks.doorbellTurnAt(id),
        lastUnknownBusyAt: hooks.lastUnknownBusyAt,
      }),
      log: () => undefined,
      confirmMs: 500,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        onSleep();
      },
    });
    await linked(ring);
    const text = "BBS-5000: 1 new in #t. Call bbs_inbox now, then continue your task.";
    // The person types a prompt during the wait: busy, but not the doorbell's turn.
    onSleep = () => hooks.event("UserPromptSubmit", { origin: "prompt" });
    expect(await ring.ring({ id: "d_a", text })).toEqual({ result: "held_busy", confirmed: false, via: "channel" });
    hooks.event("Stop");
    // Another doorbell's turn does not confirm this one either.
    onSleep = () => hooks.event("UserPromptSubmit", { doorbells: ["d_other"] });
    expect(await ring.ring({ id: "d_b", text })).toEqual({ result: "held_busy", confirmed: false, via: "channel" });
    hooks.event("Stop");
    // Its own channel turn confirms.
    onSleep = () => hooks.event("UserPromptSubmit", { doorbells: ["d_c"] });
    expect(await ring.ring({ id: "d_c", text })).toEqual({ result: "turn_started", confirmed: true, via: "channel" });
    hooks.event("Stop");
    // A typed turn that already ended in the wait, and no doorbell turn: failed.
    onSleep = () => {
      hooks.event("UserPromptSubmit", { origin: "prompt" });
      hooks.event("Stop");
    };
    expect(await ring.ring({ id: "d_d", text })).toEqual({ result: "failed", confirmed: false, via: "channel" });
    // Hook input that could not be read: the earlier rule (any busy confirms).
    onSleep = () => hooks.event("UserPromptSubmit");
    expect(await ring.ring({ id: "d_e", text })).toEqual({ result: "turn_started", confirmed: true, via: "channel" });
  });
});

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sockDir(): string {
  const d = mkdtempSync(join(tmpdir(), "bbs-h-"));
  tmp.push(d);
  return join(d, "s");
}

describe("hooks (busy/idle, I0)", () => {
  it("a hook process reaches the adapter by the hashed messaging socket", async () => {
    const dir = sockDir();
    const env = { BBS_ADAPTER_SOCKET_DIR: dir, CLAUDE_CODE_MESSAGING_SOCKET: "/some/claude/socket" };
    const l = new HookListener(() => undefined);
    const changes: SessionState[] = [];
    l.onChange((s) => changes.push(s));
    const paths = await l.listen(dir, [messagingKey(env)!]);
    expect(paths[0]).not.toContain("claude");
    expect(await runHook("UserPromptSubmit", env, 999_999)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(l.current()).toBe("busy");
    expect(l.seen).toBe(true);
    expect(await runHook("StopFailure", env, 999_999)).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(changes).toEqual(["busy", "idle"]);
    expect(await runHook("Notification", env, 999_999)).toBe(false);
    l.close();
  });

  it("without the messaging socket, a hook finds the adapter under a parent process id", async () => {
    const dir = sockDir();
    const l = new HookListener(() => undefined);
    await l.listen(dir, [pidKey(4242)]);
    expect(hookKeys({}, 100, (pid) => (pid === 100 ? 4242 : undefined))).toEqual(["p-100", "p-4242"]);
    // runHook walks real parents; check the key it would use for a direct child.
    expect(await runHook("Stop", { BBS_ADAPTER_SOCKET_DIR: dir }, 4242)).toBe(true);
    l.close();
  });

  it("reports idle after busy with no hook event for busyMaxMs (an interrupted turn fires no Stop); idle_prompt is idle", () => {
    let now = 0;
    const timers: { fn: () => void; at: number }[] = [];
    const logs: string[] = [];
    const l = new HookListener((e) => logs.push(e), {
      busyMaxMs: 10 * 60_000,
      now: () => now,
      setTimer: (fn, ms) => {
        const t = { fn, at: now + ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        const i = timers.indexOf(t as never);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    const fire = (): void => {
      const t = timers.shift()!;
      now = t.at;
      t.fn();
    };
    l.event("UserPromptSubmit");
    expect(timers).toHaveLength(1);
    now = 5 * 60_000;
    l.event("UserPromptSubmit"); // a later busy signal pushes the limit out
    fire();
    expect(now).toBe(15 * 60_000);
    expect(l.current()).toBe("idle");
    expect(logs).toContain("busy_expired");
    l.event("UserPromptSubmit");
    l.event("idle_prompt");
    expect(l.current()).toBe("idle");
    expect(timers).toHaveLength(0);
  });

  it("close() leaves a successor's socket at the same path; a hook stops at the nearest existing socket", async () => {
    const dir = sockDir();
    const first = new HookListener(() => undefined);
    const [path] = await first.listen(dir, [pidKey(5151)]);
    const second = new HookListener(() => undefined);
    await second.listen(dir, [pidKey(5151)]);
    first.close();
    expect(existsSync(path!)).toBe(true);
    // A stale socket file at the nearest ancestor: the hook does not go on to an outer adapter.
    const outer = new HookListener(() => undefined);
    await outer.listen(dir, [pidKey(7272)]);
    second.close();
    expect(existsSync(path!)).toBe(false);
    writeFileSync(path!, ""); // stale: not a socket
    const parents = (pid: number): number | undefined => (pid === 5151 ? 7272 : undefined);
    expect(await runHook("Stop", { BBS_ADAPTER_SOCKET_DIR: dir }, 5151, parents)).toBe(false);
    expect(outer.seen).toBe(false);
    rmSync(path!);
    expect(await runHook("Stop", { BBS_ADAPTER_SOCKET_DIR: dir }, 5151, parents)).toBe(true);
    outer.close();
  });

  it("refuses a symlinked socket directory and one owned by another user (F review N03)", () => {
    const real = sockDir();
    mkdirSync(real, { mode: 0o700 });
    const link = `${real}-link`;
    symlinkSync(real, link);
    tmp.push(link);
    expect(() => ensureSocketDir(link)).toThrow(/not a directory/);
    const file = `${real}-file`;
    writeFileSync(file, "");
    tmp.push(file);
    expect(() => ensureSocketDir(file)).toThrow();
    const uid = process.getuid!();
    const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    try {
      expect(() => ensureSocketDir(real)).toThrow(/another user/);
    } finally {
      spy.mockRestore();
    }
    expect(() => ensureSocketDir(real)).not.toThrow();
  });

  it("drops a hook connection that sends more than 1 KB (F review N04)", async () => {
    const dir = sockDir();
    const l = new HookListener(() => undefined);
    const [path] = await l.listen(dir, [pidKey(6161)]);
    const send = (line: string): Promise<void> =>
      new Promise((resolve) => {
        const sock = netConnect(path!);
        sock.on("error", () => resolve());
        sock.on("close", () => resolve());
        sock.end(line);
      });
    await send(`${JSON.stringify({ event: "UserPromptSubmit", pad: "x".repeat(1100) })}\n`);
    await new Promise((r) => setTimeout(r, 50));
    expect(l.current()).toBe("idle");
    expect(l.seen).toBe(false);
    await send(`${JSON.stringify({ event: "UserPromptSubmit", pad: "x".repeat(900) })}\n`);
    await new Promise((r) => setTimeout(r, 50));
    expect(l.current()).toBe("busy");
    l.close();
  });

  it("walks at most four parent processes (F review N05)", () => {
    const keys = hookKeys({}, 100, (pid) => pid + 1);
    expect(keys).toEqual(["p-100", "p-101", "p-102", "p-103"]);
  });

  it("refuses a socket directory open to other users", () => {
    const dir = sockDir();
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    expect(() => ensureSocketDir(dir)).toThrow(/open to other users/);
  });

  it("reads where a UserPromptSubmit turn came from out of the hook input (B57)", () => {
    const input = (prompt: unknown): string => JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt });
    expect(promptOrigin(input('<channel source="bbs" doorbell="d_Ab-9_x">BBS-5000: 1 new in #t.</channel>'))).toEqual({
      doorbells: ["d_Ab-9_x"],
    });
    // Two queued events in one prompt; a repeated id once.
    expect(
      promptOrigin(input('<channel source="bbs" doorbell="d_1">a</channel>\n<channel source="bbs" doorbell="d_2">b</channel><channel doorbell="d_1"></channel>')),
    ).toEqual({ doorbells: ["d_1", "d_2"] });
    // Loaded as the `bbs` plugin (G2), the source names the plugin's server.
    expect(promptOrigin(input('<channel source="plugin:bbs:bbs" doorbell="d_p1">BBS-5000: 1 new in #t.</channel>'))).toEqual({
      doorbells: ["d_p1"],
    });
    expect(promptOrigin(input("Say hello."))).toEqual({ origin: "prompt" });
    expect(promptOrigin(input('<channel source="other">a webhook</channel>'))).toEqual({ origin: "prompt" });
    expect(promptOrigin(input('doorbell="d_1" typed by hand'))).toEqual({ origin: "prompt" });
    expect(promptOrigin("not json")).toBeUndefined();
    expect(promptOrigin(JSON.stringify({ hook_event_name: "UserPromptSubmit" }))).toBeUndefined();
  });

  it("the hook command sends the prompt's origin, never its text; the adapter records the doorbell's turn (B57)", async () => {
    const dir = sockDir();
    const env = { BBS_ADAPTER_SOCKET_DIR: dir, CLAUDE_CODE_MESSAGING_SOCKET: "/some/claude/socket" };
    const logs: { ev: string; detail?: Record<string, unknown> }[] = [];
    const l = new HookListener((ev, detail) => logs.push({ ev, ...(detail ? { detail } : {}) }));
    await l.listen(dir, [messagingKey(env)!]);
    const r = spawnSync(process.execPath, [BIN, "hook", "UserPromptSubmit"], {
      input: JSON.stringify({ prompt: '<channel source="bbs" doorbell="d_q1">BBS-5000: 1 new in #t.</channel>' }),
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    await new Promise((res) => setTimeout(res, 50));
    expect(l.doorbellTurnAt("d_q1")).toBe(l.lastBusyAt);
    expect(l.lastUnknownBusyAt).toBe(0);
    expect(await runHook("UserPromptSubmit", env, 999_999, undefined, JSON.stringify({ prompt: "secret words" }))).toBe(true);
    await new Promise((res) => setTimeout(res, 50));
    expect(l.lastUnknownBusyAt).toBe(0);
    expect(logs.filter((x) => x.ev === "hook").map((x) => x.detail?.origin)).toEqual(["doorbell", "prompt"]);
    expect(JSON.stringify(logs)).not.toContain("secret");
    l.close();
  });

  it("the hook command prints nothing and exits 0, even with no adapter running", () => {
    const r = spawnSync(process.execPath, [BIN, "hook", "Stop"], {
      input: '{"hook_event_name":"Stop"}',
      env: { ...process.env, BBS_ADAPTER_SOCKET_DIR: sockDir(), CLAUDE_CODE_MESSAGING_SOCKET: "/x" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("bbs-adapter command", () => {
  it("prints usage, refuses unknown commands, and needs a config to serve", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };
    expect(await run(["--help"], {}, io)).toBe(0);
    expect(out.join("")).toMatch(/hook <event>/);
    expect(await run(["bogus"], {}, io)).toBe(2);
    expect(await run([], { BBS_CONFIG: join(sockDir(), "missing.json") }, io)).toBe(3);
    expect(err.join("\n")).toMatch(/no config/);
  });
});

describe("hook socket directory (F traceability)", () => {
  it("is BBS_ADAPTER_SOCKET_DIR, else $XDG_RUNTIME_DIR/bbs-5000, else a per-user directory in tmp", () => {
    expect(socketDir({ BBS_ADAPTER_SOCKET_DIR: "/run/x", XDG_RUNTIME_DIR: "/run/user/1" })).toBe("/run/x");
    expect(socketDir({ XDG_RUNTIME_DIR: "/run/user/1" })).toBe(join("/run/user/1", "bbs-5000"));
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    expect(socketDir({})).toBe(join(tmpdir(), `bbs-5000-${uid}`));
  });
});

describe("the labels the adapter sends with bbs_join", () => {
  const host = {
    hostname: () => "workstation-1.example.test",
    platform: () => "linux",
    type: () => "Linux",
    release: () => "6.8.0",
  };

  it("sends this host's short name and operating system when the config sets neither", () => {
    expect(sessionLabels({}, host)).toEqual({ machine: "workstation-1", os: "Linux" });
    expect(sessionLabels({ BBS_MACHINE: "  " }, host)).toEqual({ machine: "workstation-1", os: "Linux" });
  });

  it("BBS_MACHINE and BBS_OS win; the model goes only when BBS_MODEL names it", () => {
    expect(sessionLabels({ BBS_MACHINE: "laptop-2", BBS_OS: "Plan 9", BBS_MODEL: "gpt-5" }, host)).toEqual({
      machine: "laptop-2",
      os: "Plan 9",
      model: "gpt-5",
    });
    expect(sessionLabels({ BBS_MACHINE: "laptop-2" }, host)).not.toHaveProperty("model");
  });
});

describe("the harness session a join carries (issue #98)", () => {
  it("is Claude Code's session id from the environment when it is a plain label", () => {
    expect(claudeHarnessSession({ CLAUDE_CODE_SESSION_ID: " 0a1b2c3d-4e5f-6789-abcd-ef0123456789 " })).toBe("0a1b2c3d-4e5f-6789-abcd-ef0123456789");
    expect(claudeHarnessSession({})).toBeUndefined();
    expect(claudeHarnessSession({ CLAUDE_CODE_SESSION_ID: "" })).toBeUndefined();
    expect(claudeHarnessSession({ CLAUDE_CODE_SESSION_ID: "has space" })).toBeUndefined();
    expect(claudeHarnessSession({ CLAUDE_CODE_SESSION_ID: "x".repeat(129) })).toBeUndefined();
  });

  it("is the Codex thread id once the thread is known", () => {
    expect(codexHarnessSession("019ab3f0-1111-7222-8333-444455556666")).toBe("019ab3f0-1111-7222-8333-444455556666");
    expect(codexHarnessSession(undefined)).toBeUndefined();
    expect(codexHarnessSession("bad id")).toBeUndefined();
  });
});
