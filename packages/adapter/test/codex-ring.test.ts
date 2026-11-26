// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The Codex ring (G3) against a fake Codex app-server: a real WebSocket
 * server (`ws`) on a unix socket in a temp directory, speaking the JSON-RPC
 * methods the ring uses, with the behavior observed on Codex CLI 0.171.0
 * (recorded when the Codex ring was built): per-thread MCP server resources, broadcast
 * `thread/status/changed`, `turn/start` steering into a running turn, and
 * `clientUserMessageId` shown as the first user message's `clientId`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Adapter } from "../src/adapter.ts";
import { AppServerClient, AppServerError, type AppSocketLike } from "../src/app-server-client.ts";
import { BoardApi, type FetchLike } from "../src/board-api.ts";
import type { SocketLike } from "../src/board-socket.ts";
import { AGENT_GUIDE } from "@bbs-5000/core";
import { CODEX_INSTRUCTIONS, CodexRing, stateOf } from "../src/codex-ring.ts";
import { codexSocketPath, harnessOf, run } from "../src/main.ts";

interface FakeTurn {
  id: string;
  items: { type: "userMessage"; clientId: string | null; text: string }[];
}

interface FakeThread {
  id: string;
  status: "idle" | "active";
  /** Resource URIs this thread's `bbs` server lists. */
  resources: string[];
  turns: FakeTurn[];
}

/** A fake Codex app-server on a unix socket. */
class FakeAppServer {
  readonly dir = mkdtempSync(join(tmpdir(), "bbs-cx-"));
  readonly path = join(this.dir, "as.sock");
  readonly threads = new Map<string, FakeThread>();
  readonly requests: { method: string; params: any }[] = [];
  readonly clients = new Set<WsSocket>();
  /** Answers sent to client requests the server made (id → message). */
  readonly answers: unknown[] = [];
  /** How long a new turn's first user message stays hidden from `thread/turns/list`. */
  itemDelayMs = 0;
  /** When set, `turn/start` answers this JSON-RPC error. */
  turnStartError: { code: number; message: string } | undefined;
  /** When true, a busy thread's status change is not broadcast (the race in "merged"). */
  silentStatus = false;
  #http: HttpServer | undefined;
  #wss: WebSocketServer | undefined;
  #turnSeq = 0;

  async start(): Promise<void> {
    this.#http = createServer();
    this.#wss = new WebSocketServer({ server: this.#http });
    this.#wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      ws.on("message", (data) => this.#onMessage(ws, String(data)));
    });
    await new Promise<void>((r) => this.#http!.listen(this.path, r));
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.terminate();
    await new Promise<void>((r) => this.#wss?.close(() => r()) ?? r());
    await new Promise<void>((r) => this.#http?.close(() => r()) ?? r());
    rmSync(this.dir, { recursive: true, force: true });
  }

  addThread(id: string, resources: string[] = [], status: "idle" | "active" = "idle"): FakeThread {
    const t: FakeThread = { id, status, resources, turns: [] };
    this.threads.set(id, t);
    return t;
  }

  broadcast(method: string, params: unknown): void {
    for (const c of this.clients) c.send(JSON.stringify({ method, params }));
  }

  setStatus(id: string, status: "idle" | "active"): void {
    this.threads.get(id)!.status = status;
    if (!this.silentStatus) {
      this.broadcast("thread/status/changed", {
        threadId: id,
        status: status === "active" ? { type: "active", activeFlags: [] } : { type: "idle" },
      });
    }
  }

  /** A turn the person typed in the TUI. */
  typedTurn(id: string, text = "typed"): FakeTurn {
    const turn: FakeTurn = { id: `turn-${++this.#turnSeq}`, items: [{ type: "userMessage", clientId: null, text }] };
    this.threads.get(id)!.turns.unshift(turn);
    this.setStatus(id, "active");
    return turn;
  }

  methods(name: string): any[] {
    return this.requests.filter((r) => r.method === name).map((r) => r.params);
  }

  #onMessage(ws: WsSocket, raw: string): void {
    const m = JSON.parse(raw) as { id?: number; method?: string; params?: any; result?: unknown; error?: unknown };
    if (m.method === undefined) {
      this.answers.push(m);
      return;
    }
    if (m.id === undefined) return; // `initialized`
    this.requests.push({ method: m.method, params: m.params });
    const ok = (result: unknown) => ws.send(JSON.stringify({ id: m.id, result }));
    const fail = (code: number, message: string) => ws.send(JSON.stringify({ id: m.id, error: { code, message } }));
    const p = m.params ?? {};
    const thread = typeof p.threadId === "string" ? this.threads.get(p.threadId) : undefined;
    switch (m.method) {
      case "initialize":
        return ok({ userAgent: "fake", codexHome: "/nowhere", platformFamily: "unix", platformOs: "test" });
      case "thread/loaded/list":
        return ok({ data: [...this.threads.keys()], nextCursor: null });
      case "mcpServerStatus/list":
        if (!thread) return fail(-32600, "thread not loaded");
        return ok({
          data: p.serverName === "bbs" ? [{ name: "bbs", resources: thread.resources.map((uri) => ({ uri, name: "x" })) }] : [],
          nextCursor: null,
        });
      case "thread/read":
        if (!thread) return fail(-32600, "no thread");
        return ok({ thread: { id: thread.id, status: { type: thread.status } } });
      case "turn/start": {
        if (this.turnStartError) return fail(this.turnStartError.code, this.turnStartError.message);
        if (!thread) return fail(-32600, "thread not loaded");
        const text = String(p.input?.[0]?.text ?? "");
        const item = { type: "userMessage" as const, clientId: (p.clientUserMessageId as string) ?? null, text };
        if (thread.status === "active" && thread.turns[0]) {
          // Codex steers input into the running turn (recorded when the Codex ring was built).
          thread.turns[0].items.push(item);
          return ok({ turn: { id: thread.turns[0].id, items: [], status: "inProgress" } });
        }
        const turn: FakeTurn = { id: `turn-${++this.#turnSeq}`, items: [] };
        thread.turns.unshift(turn);
        setTimeout(() => turn.items.push(item), this.itemDelayMs);
        ok({ turn: { id: turn.id, items: [], status: "inProgress" } });
        this.setStatus(thread.id, "active");
        return;
      }
      case "thread/turns/list":
        if (!thread) return fail(-32600, "no thread");
        return ok({ data: thread.turns.slice(0, p.limit ?? 5).map((t) => ({ id: t.id, items: [...t.items] })), nextCursor: null });
      default:
        return fail(-32601, "method not found");
    }
  }
}

const servers: FakeAppServer[] = [];
const closers: (() => void)[] = [];

afterEach(async () => {
  for (const c of closers.splice(0)) c();
  for (const s of servers.splice(0)) await s.stop();
});

async function fakeServer(): Promise<FakeAppServer> {
  const s = new FakeAppServer();
  await s.start();
  servers.push(s);
  return s;
}

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const noFetch: FetchLike = async () => ({ status: 200, json: async () => ({ ok: true, value: {} }) });

interface Rig {
  ring: CodexRing;
  app: AppServerClient;
  client: Client;
  logs: { event: string; detail?: Record<string, unknown> }[];
  threads: string[];
}

async function rig(server: FakeAppServer, over: Partial<ConstructorParameters<typeof CodexRing>[0]> = {}): Promise<Rig> {
  const logs: Rig["logs"] = [];
  const log = (event: string, detail?: Record<string, unknown>) => logs.push({ event, ...(detail ? { detail } : {}) });
  const app = new AppServerClient({ socketPath: server.path, log, clientVersion: "test", initialBackoffMs: 20, requestTimeoutMs: 2000 });
  const threads: string[] = [];
  const ring = new CodexRing({
    api: new BoardApi({ url: "http://board.test", token: "tok", fetch: noFetch }),
    session: () => "s_one",
    log,
    app,
    nonce: "n0nce",
    confirmMs: 1000,
    pollMs: 20,
    locateEveryMs: 50,
    onThread: (t) => threads.push(t),
    ...over,
  });
  closers.push(() => {
    ring.close();
    app.stop();
  });
  app.start();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "codex-mcp-client", version: "0" });
  await ring.connect(b);
  await client.connect(a);
  return { ring, app, client, logs, threads };
}

const MINE = "bbs://adapter/n0nce";

describe("CodexRing: which thread is mine (A3G.1)", () => {
  it("lists its own resource URI and finds the loaded thread whose bbs server lists it, before any tool call", async () => {
    const s = await fakeServer();
    s.addThread("th-other", ["bbs://adapter/someone-else"]);
    s.addThread("th-mine", [MINE]);
    s.addThread("th-third", []);
    const r = await rig(s);
    expect(r.client.getServerCapabilities()).toMatchObject({ tools: {}, resources: {} });
    expect(r.client.getServerCapabilities()?.experimental).toBeUndefined();
    expect(r.client.getInstructions()).toBe(CODEX_INSTRUCTIONS);
    expect(CODEX_INSTRUCTIONS.endsWith(AGENT_GUIDE)).toBe(true);
    const listed = await r.client.listResources();
    expect(listed.resources.map((x) => x.uri)).toEqual([MINE]);
    const read = await r.client.readResource({ uri: MINE });
    expect(read.contents[0]).toMatchObject({ uri: MINE });
    await until(() => r.ring.threadId !== undefined);
    expect(r.ring.threadId).toBe("th-mine");
    // onThread fires after the thread's status read, which follows threadId.
    await until(() => r.threads.length > 0);
    expect(r.threads).toEqual(["th-mine"]);
    expect(s.methods("mcpServerStatus/list").every((p) => p.serverName === "bbs")).toBe(true);
    expect(s.methods("thread/read")).toEqual([{ threadId: "th-mine", includeTurns: false }]);
    expect(r.logs.find((l) => l.event === "codex_thread")?.detail).toEqual({ thread: "th-mine", how: "resource" });
  });

  it("keeps looking while no thread lists it, and finds it once one does", async () => {
    const s = await fakeServer();
    s.addThread("th-other", []);
    const r = await rig(s);
    await until(() => s.methods("thread/loaded/list").length >= 2);
    expect(r.ring.threadId).toBeUndefined();
    s.addThread("th-late", [MINE]);
    s.broadcast("thread/started", { thread: { id: "th-late" } });
    await until(() => r.ring.threadId === "th-late");
  });

  it("a tool call's _meta.threadId pins the thread (the resource search found none)", async () => {
    const s = await fakeServer();
    s.addThread("th-x", []);
    const r = await rig(s);
    await until(() => s.methods("thread/loaded/list").length >= 1);
    await r.client.callTool({ name: "bbs_whoami", arguments: {}, _meta: { threadId: "01a20039-0101-7c51-a95e-f78f39e0884d" } });
    await until(() => r.ring.threadId !== undefined);
    expect(r.ring.threadId).toBe("01a20039-0101-7c51-a95e-f78f39e0884d");
    expect(r.logs.find((l) => l.event === "codex_thread")?.detail).toMatchObject({ how: "tool_call" });
    // A malformed id is ignored; another thread's call does not move it.
    await r.client.callTool({ name: "bbs_whoami", arguments: {}, _meta: { threadId: "bad id with spaces" } });
    await r.client.callTool({ name: "bbs_whoami", arguments: {}, _meta: { threadId: "01a2ffff-0000-7000-8000-000000000000" } });
    expect(r.ring.threadId).toBe("01a20039-0101-7c51-a95e-f78f39e0884d");
    expect(r.logs.some((l) => l.event === "codex_thread_other")).toBe(true);
  });

  it("forgets a thread the app-server closed, reports idle, and finds it again", async () => {
    const s = await fakeServer();
    s.addThread("th-mine", [MINE]);
    const r = await rig(s);
    await until(() => r.ring.threadId === "th-mine");
    s.setStatus("th-mine", "active");
    await until(() => r.ring.current() === "busy");
    s.threads.delete("th-mine");
    s.broadcast("thread/closed", { threadId: "th-mine" });
    await until(() => r.ring.threadId === undefined);
    expect(r.ring.current()).toBe("idle");
    s.addThread("th-mine", [MINE]);
    await until(() => r.ring.threadId === "th-mine");
  });
});

describe("CodexRing: busy and idle from the app-server (A3G.5)", () => {
  it("follows thread/status/changed for its own thread only", async () => {
    const s = await fakeServer();
    s.addThread("th-other", []);
    s.addThread("th-mine", [MINE]);
    const r = await rig(s);
    await until(() => r.ring.threadId === "th-mine");
    const seen: string[] = [];
    r.ring.onChange((x) => seen.push(x));
    s.setStatus("th-other", "active");
    s.setStatus("th-mine", "active");
    await until(() => seen.length === 1);
    s.setStatus("th-other", "idle");
    s.setStatus("th-mine", "idle");
    await until(() => seen.length === 2);
    expect(seen).toEqual(["busy", "idle"]);
    expect(stateOf("active")).toBe("busy");
    for (const other of ["idle", "notLoaded", "systemError", undefined]) expect(stateOf(other)).toBe("idle");
  });

  it("reads the thread's status when it finds it (already busy)", async () => {
    const s = await fakeServer();
    s.addThread("th-mine", [MINE], "active");
    const r = await rig(s);
    await until(() => r.ring.threadId === "th-mine");
    await until(() => r.ring.current() === "busy");
  });
});

describe("CodexRing: ring (A3G.2–A3G.4)", () => {
  it("idle: starts a turn on its own thread with the doorbell text only, confirmed by its own first user message", async () => {
    const s = await fakeServer();
    s.addThread("th-other", []);
    s.addThread("th-mine", [MINE]);
    s.itemDelayMs = 60;
    const r = await rig(s);
    await until(() => r.ring.threadId === "th-mine");
    const out = await r.ring.ring({ id: "d_1", text: "BBS-5000: 1 new in #x. Call bbs_inbox now, then continue your task." });
    expect(out).toEqual({ result: "turn_started", confirmed: true });
    expect(s.methods("turn/start")).toEqual([
      {
        threadId: "th-mine",
        input: [{ type: "text", text: "BBS-5000: 1 new in #x. Call bbs_inbox now, then continue your task." }],
        clientUserMessageId: "d_1",
      },
    ]);
    await until(() => r.ring.current() === "busy");
  });

  it("busy: held_busy and no turn/start", async () => {
    const s = await fakeServer();
    s.addThread("th-mine", [MINE]);
    const r = await rig(s);
    await until(() => r.ring.threadId === "th-mine");
    s.typedTurn("th-mine");
    await until(() => r.ring.current() === "busy");
    expect(await r.ring.ring({ id: "d_2", text: "BBS-5000: x" })).toEqual({ result: "held_busy", confirmed: false });
    expect(s.methods("turn/start")).toEqual([]);
  });

  it("merged into someone else's turn (a typed turn began before the status arrived): held_busy, unconfirmed", async () => {
    const s = await fakeServer();
    s.addThread("th-mine", [MINE]);
    const r = await rig(s);
    await until(() => r.ring.threadId === "th-mine");
    s.silentStatus = true;
    s.typedTurn("th-mine");
    expect(r.ring.current()).toBe("idle");
    expect(await r.ring.ring({ id: "d_3", text: "BBS-5000: x" })).toEqual({ result: "held_busy", confirmed: false });
    expect(s.methods("turn/start")).toHaveLength(1);
    expect(r.logs.some((l) => l.event === "codex_ring_merged")).toBe(true);
  });

  it("a turn that shows no user message within confirmMs: turn_started, unconfirmed", async () => {
    const s = await fakeServer();
    s.addThread("th-mine", [MINE]);
    s.itemDelayMs = 5000;
    const r = await rig(s, { confirmMs: 100 });
    await until(() => r.ring.threadId === "th-mine");
    expect(await r.ring.ring({ id: "d_4", text: "BBS-5000: x" })).toEqual({ result: "turn_started", confirmed: false });
  });

  it("a refused turn/start: failed", async () => {
    const s = await fakeServer();
    s.addThread("th-mine", [MINE]);
    s.turnStartError = { code: -32001, message: "overloaded" };
    const r = await rig(s);
    await until(() => r.ring.threadId === "th-mine");
    expect(await r.ring.ring({ id: "d_5", text: "BBS-5000: x" })).toEqual({ result: "failed" });
    expect(r.logs.find((l) => l.event === "codex_turn_start_failed")?.detail).toMatchObject({ id: "d_5" });
  });

  it("no thread of its own among the loaded ones: failed, and no turn/start", async () => {
    const s = await fakeServer();
    s.addThread("th-other", ["bbs://adapter/someone-else"]);
    const r = await rig(s);
    await until(() => s.methods("thread/loaded/list").length >= 1);
    expect(await r.ring.ring({ id: "d_6", text: "BBS-5000: x" })).toEqual({ result: "failed" });
    expect(s.methods("turn/start")).toEqual([]);
  });

  it("no app-server at the socket: failed", async () => {
    const s = await fakeServer();
    const missing = join(s.dir, "absent.sock");
    const logs: { event: string }[] = [];
    const app = new AppServerClient({ socketPath: missing, log: (event) => logs.push({ event }), clientVersion: "t", initialBackoffMs: 1000 });
    const ring = new CodexRing({
      api: new BoardApi({ url: "http://board.test", token: "tok", fetch: noFetch }),
      session: () => undefined,
      log: () => undefined,
      app,
      nonce: "n0nce",
    });
    closers.push(() => {
      ring.close();
      app.stop();
    });
    app.start();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await ring.connect(b);
    await new Client({ name: "c", version: "0" }).connect(a);
    await until(() => logs.some((l) => l.event === "app_server_error"));
    expect(app.ready).toBe(false);
    expect(await ring.ring({ id: "d_7", text: "BBS-5000: x" })).toEqual({ result: "failed" });
    await expect(app.request("thread/loaded/list", {})).rejects.toBeInstanceOf(AppServerError);
  });

  it("before the MCP client initialized: failed", async () => {
    const s = await fakeServer();
    s.addThread("th-mine", [MINE]);
    const app = new AppServerClient({ socketPath: s.path, log: () => undefined, clientVersion: "t" });
    const ring = new CodexRing({
      api: new BoardApi({ url: "http://board.test", token: "tok", fetch: noFetch }),
      session: () => undefined,
      log: () => undefined,
      app,
      nonce: "n0nce",
    });
    closers.push(() => {
      ring.close();
      app.stop();
    });
    app.start();
    expect(await ring.ring({ id: "d_8", text: "BBS-5000: x" })).toEqual({ result: "failed" });
  });
});

describe("CodexRing in the shared adapter (A3G.5)", () => {
  it("holds while busy, rings when idle, and reports the app-server's busy/idle to the board after ring_result", async () => {
    const s = await fakeServer();
    s.addThread("th-mine", [MINE]);
    const r = await rig(s);
    await until(() => r.ring.threadId === "th-mine");
    const sent: Record<string, unknown>[] = [];
    let onMessage: ((ev: { data: unknown }) => void) | undefined;
    const sock: SocketLike = {
      readyState: 1,
      send: (d) => sent.push(JSON.parse(d) as Record<string, unknown>),
      close: () => undefined,
      addEventListener: ((type: string, cb: (ev: any) => void) => {
        if (type === "open") setTimeout(() => cb({}), 0);
        if (type === "message") onMessage = cb;
      }) as SocketLike["addEventListener"],
    };
    const adapter = new Adapter({
      url: "http://board.test",
      token: "tok",
      session: () => "s_one",
      ensureSession: async () => undefined,
      resetSession: () => undefined,
      ring: r.ring,
      state: r.ring,
      log: () => undefined,
      connect: () => sock,
    });
    closers.push(() => adapter.stop());
    adapter.start();
    await until(() => sent.some((m) => m.type === "hello"));
    expect(sent.find((m) => m.type === "hello")).toMatchObject({ harness: "codex", state: "idle" });
    // Busy: held without a turn/start.
    s.typedTurn("th-mine");
    await until(() => sent.some((m) => m.type === "state" && m.state === "busy"));
    onMessage!({ data: JSON.stringify({ type: "doorbell", id: "d_a", text: "BBS-5000: x" }) });
    await until(() => sent.some((m) => m.type === "ring_result"));
    expect(sent.find((m) => m.type === "ring_result")).toEqual({ type: "ring_result", id: "d_a", result: "held_busy" });
    expect(s.methods("turn/start")).toEqual([]);
    // Idle: rung and confirmed; the turn's idle comes after its ring_result.
    s.setStatus("th-mine", "idle");
    await until(() => sent.some((m) => m.type === "state" && m.state === "idle"));
    sent.length = 0;
    onMessage!({ data: JSON.stringify({ type: "doorbell", id: "d_b", text: "BBS-5000: y" }) });
    await until(() => sent.some((m) => m.type === "ring_result"));
    expect(sent.find((m) => m.type === "ring_result")).toEqual({ type: "ring_result", id: "d_b", result: "turn_started", confirmed: true });
    s.setStatus("th-mine", "idle");
    await until(() => sent.some((m) => m.type === "state" && m.state === "idle"));
    const order = sent.map((m) => `${m.type}:${(m.state ?? m.result) as string}`);
    expect(order.indexOf("ring_result:turn_started")).toBeLessThan(order.lastIndexOf("state:idle"));
  });
});

describe("AppServerClient", () => {
  it("leaves a request from the server unanswered (another client may settle it), and rejects pending requests when the socket closes", async () => {
    const s = await fakeServer();
    const logs: string[] = [];
    const app = new AppServerClient({ socketPath: s.path, log: (e) => logs.push(e), clientVersion: "t", initialBackoffMs: 20 });
    closers.push(() => app.stop());
    let ready = 0;
    let closed = 0;
    app.onReady(() => (ready += 1));
    app.onClose(() => (closed += 1));
    app.start();
    await until(() => ready === 1);
    expect(s.methods("initialize")[0]).toMatchObject({ clientInfo: { name: "bbs-adapter" }, capabilities: { experimentalApi: true } });
    for (const c of s.clients) c.send(JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: {} }));
    await until(() => logs.includes("app_server_request_ignored"));
    await new Promise((r) => setTimeout(r, 50));
    expect(s.answers).toEqual([]);
    const pending = app.request("never/answered", {});
    for (const c of s.clients) c.terminate();
    await expect(pending).rejects.toThrow(/closed/);
    await until(() => closed === 1);
    // It reconnects and initializes again.
    await until(() => ready === 2);
  });

  it("times a request out", async () => {
    const s = await fakeServer();
    const app = new AppServerClient({ socketPath: s.path, log: () => undefined, clientVersion: "t", requestTimeoutMs: 50 });
    closers.push(() => app.stop());
    app.start();
    await until(() => app.ready);
    const silent = new Set(s.clients);
    for (const c of silent) c.removeAllListeners("message");
    await expect(app.request("thread/loaded/list", {})).rejects.toThrow(/timed out/);
  });

  it("ignores frames that are not JSON-RPC answers it is waiting for", async () => {
    const frames: string[] = [];
    let handlers: Record<string, (x?: any) => void> = {};
    const fake: AppSocketLike = {
      readyState: 1,
      send: (d) => frames.push(d),
      close: () => undefined,
      on: ((ev: string, cb: (x?: any) => void) => {
        handlers[ev] = cb;
      }) as AppSocketLike["on"],
    };
    const app = new AppServerClient({ socketPath: "/x", log: () => undefined, clientVersion: "t", connect: () => fake });
    app.start();
    handlers.open!();
    handlers.message!("not json");
    handlers.message!(JSON.stringify({ id: 12345, result: {} }));
    handlers.message!(JSON.stringify({ id: 1, result: {} }));
    await until(() => app.ready);
    expect(frames.map((f) => JSON.parse(f).method)).toEqual(["initialize", "initialized"]);
    app.stop();
    handlers = {};
  });
});

describe("bbs-adapter harness selection (A3G.6)", () => {
  it("BBS_HARNESS picks claude-code by default or codex, and refuses anything else", async () => {
    expect(harnessOf({})).toBe("claude-code");
    expect(harnessOf({ BBS_HARNESS: " codex " })).toBe("codex");
    expect(harnessOf({ BBS_HARNESS: "gemini" })).toBeUndefined();
    const err: string[] = [];
    const code = await run([], { BBS_HARNESS: "gemini" }, { out: () => undefined, err: (t) => err.push(t) });
    expect(code).toBe(2);
    expect(err.join("")).toMatch(/BBS_HARNESS must be one of claude-code, codex/);
    const code2 = await run([], { BBS_HARNESS: "codex", BBS_CODEX_SOCKET: "relative/as.sock" }, { out: () => undefined, err: () => undefined });
    expect(code2).toBe(2);
  });

  it("the Codex socket is BBS_CODEX_SOCKET (a path or unix:// URL), else the daemon's control socket", () => {
    expect(codexSocketPath({ BBS_CODEX_SOCKET: "unix:///run/x/as.sock" })).toBe("/run/x/as.sock");
    expect(codexSocketPath({ BBS_CODEX_SOCKET: "/run/y.sock" })).toBe("/run/y.sock");
    expect(codexSocketPath({ CODEX_HOME: "/h/cx" })).toBe("/h/cx/app-server-control/app-server-control.sock");
    expect(codexSocketPath({ HOME: "/h/u" })).toBe("/h/u/.codex/app-server-control/app-server-control.sock");
  });
});
