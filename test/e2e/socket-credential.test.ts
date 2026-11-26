// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// M4b review m2–m4 under `wrangler dev`: the board's defensive socket checks
// end to end. On normal paths a kick closes the sockets before they can send,
// so this board runs with the test-only `BBS_TEST_SOCKET_FAULTS`
// (packages/worker/src/ws-protocol.ts): `keep_kicked` leaves a kicked user's
// sockets open, `no_hash=nh` keeps nh's sockets without a token hash (a socket
// from before M4b), `bad_hash=bh` forwards a wrong hash for bh's upgrade (a
// revocation between sign-in and upgrade). Also: a reinstate closes a live
// socket with 4004 and no `kicked` frame, and the real adapter process stops
// on a revoked token at bbs_join instead of retrying.

import { request } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BoardSocket } from "../../packages/adapter/src/board-socket.ts";
import { api, groupAlive, makeRunDir, ROOT, sleep, startWrangler, type RunDir, type Server } from "./harness.ts";
import { ScriptedAdapter } from "./scripted-adapter.ts";

const SPAN_MS = 1500;
const BIN = join(ROOT, "packages/adapter/bin/bbs-adapter.js");

let run: RunDir;
let server: Server;
let human: string;
const asCli = { "x-bbs-client": "cli" };
const sockets: ScriptedAdapter[] = [];
const clients: Client[] = [];

async function addUser(handle: string): Promise<string> {
  const r = await api(server.url, human, "bbs_admin_user_add", { handle }, asCli);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.value.token as string;
}

async function call(token: string, tool: string, args: unknown = {}, headers: Record<string, string> = {}): Promise<any> {
  const r = await api(server.url, token, tool, args, headers);
  expect(r.status, `${tool}: ${JSON.stringify(r.body)}`).toBe(200);
  return r.body.value;
}

async function audit(filter: Record<string, unknown>): Promise<any[]> {
  return (await call(human, "bbs_audit", { limit: 1000, ...filter }, asCli)).events;
}

async function flood(token: string, tag: string): Promise<{ status: number; body: any }> {
  for (let i = 0; i < 20; i++) {
    const r = await api(server.url, token, "bbs_post", { topic: "Lobby", body: `${tag}-${i}` });
    if (r.status !== 200) return r;
  }
  throw new Error("never refused");
}

/** Walk an agent through warn, mute (lifted by the alarm) and kick. */
async function kick(token: string, handle: string): Promise<void> {
  await flood(token, "one");
  await sleep(SPAN_MS + 200);
  await flood(token, "two");
  const deadline = Date.now() + 15_000;
  for (;;) {
    const who = await call(human, "bbs_who", {}, asCli);
    if ((who.users as { handle: string; status: string }[]).find((u) => u.handle === handle)?.status === "active") break;
    if (Date.now() > deadline) throw new Error("mute was not lifted");
    await sleep(250);
  }
  await sleep(SPAN_MS + 200);
  const third = await flood(token, "three");
  expect(third.body.error.message).toMatch(/removed from the board/);
}

/** HTTP status of a WebSocket upgrade to /ws. */
function upgradeStatus(token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${server.url}/ws`, {
      headers: {
        authorization: `Bearer ${token}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  run = makeRunDir("owner", {
    BBS_LOBBY_WINDOW_MS: String(SPAN_MS),
    BBS_LOBBY_MUTE_MS: String(SPAN_MS),
    BBS_TEST_SOCKET_FAULTS: "keep_kicked,no_hash=nh,bad_hash=bh",
    // F (B55): faults are refused without the explicit dev flag.
    BBS_ALLOW_TEST_FAULTS: "1",
  });
  human = run.humanToken;
  server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
});

afterAll(async () => {
  for (const s of sockets) s.close();
  for (const c of clients) await c.close().catch(() => undefined);
  await server?.stop();
  if (server) expect(groupAlive(server.pid)).toBe(false);
  run?.cleanup();
});

describe("upgrade-time recheck (B48)", () => {
  it("refuses the upgrade when the forwarded token hash no longer matches, audited", async () => {
    const token = await addUser("bh");
    expect(await upgradeStatus(token)).toBe(403);
    await expect(ScriptedAdapter.connect(server.url, token)).rejects.toThrow();
    const rows = (await audit({ actor: "bh", action: "socket_open" })).filter((e) => e.result === "denied");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].detail).toMatchObject({ credential: "revoked" });
  });
});

describe("a socket without a token hash (from before M4b)", () => {
  it("is refused on its first message with 4003, sign in again; its session is detached", async () => {
    const token = await addUser("nh");
    const session = (await call(token, "bbs_join", {})).session as string;
    const sock = await ScriptedAdapter.connect(server.url, token);
    sockets.push(sock);
    sock.hello(session, "idle");
    expect(await sock.waitClosed(3000)).toEqual({ code: 4003, reason: "sign in again" });
    const refused = (await audit({ actor: "nh", action: "socket_message" })).at(-1);
    expect(refused).toMatchObject({ result: "denied", detail: { no_hash: true } });
    // The close is the user's own socket_close (not a sockets_closed row).
    await sleep(300);
    expect((await audit({ actor: "nh", action: "socket_close" })).length).toBe(1);
  });
});

describe("per-message recheck (B48)", () => {
  it("a kicked user's socket left open is closed on its next message: kicked frame, 4004, only its session detached", async () => {
    const token = await addUser("pm");
    const session = (await call(token, "bbs_join", {})).session as string;
    const sock = await ScriptedAdapter.connect(server.url, token);
    sockets.push(sock);
    sock.hello(session, "idle");
    await sleep(200);
    await kick(token, "pm");
    // keep_kicked: the kick did not close it.
    await sleep(500);
    expect(sock.closed).toBeUndefined();
    expect(sock.frames.map((f) => f.data.type)).not.toContain("kicked");
    sock.state("idle");
    expect(await sock.waitClosed(3000)).toEqual({ code: 4004, reason: "kicked: token revoked" });
    expect(sock.frames.map((f) => f.data.type)).toContain("kicked");
    const refused = (await audit({ actor: "pm", action: "socket_message" })).at(-1);
    expect(refused).toMatchObject({ result: "denied" });
    const closed = (await audit({ action: "sockets_closed" })).filter((e) => e.target_id === "pm");
    expect(closed).toHaveLength(1);
    expect(closed[0].detail).toMatchObject({ reason: "kicked", closed: 1, code: 4004, session, detached: [] });
    // The kick had already ended the session and cleared its ws_open, so there was nothing left to detach.
    expect(closed[0].detail).not.toHaveProperty("detached.0");
  });
});

describe("a non-kick revocation closes the live socket (B48, review m3)", () => {
  it("reinstate closes the old token's socket with 4004 and no kicked frame; the real adapter connection stops", async () => {
    const token = await addUser("ri");
    let session: string | undefined;
    const logs: { event: string; detail?: Record<string, unknown> }[] = [];
    let stoppedWhy: string | undefined;
    const socket = new BoardSocket({
      url: server.url,
      token,
      session: () => session,
      ensureSession: async () => {
        session = (await call(token, "bbs_join", { harness: "claude-code" })).session as string;
      },
      resetSession: () => {
        session = undefined;
      },
      harness: "claude-code",
      state: () => "idle",
      onDoorbell: () => undefined,
      onStopped: (why) => {
        stoppedWhy = why;
      },
      log: (event, detail) => logs.push({ event, ...(detail ? { detail } : {}) }),
      initialBackoffMs: 200,
    });
    socket.start();
    const attachedBy = Date.now() + 5000;
    while (!socket.connected && Date.now() < attachedBy) await sleep(50);
    expect(socket.connected).toBe(true);
    await kick(token, "ri");
    await sleep(500);
    expect(stoppedWhy).toBeUndefined(); // keep_kicked: still open
    const reinstated = await call(human, "bbs_admin_reinstate", { handle: "ri" }, asCli);
    expect(typeof reinstated.token).toBe("string");
    const stopBy = Date.now() + 5000;
    while (stoppedWhy === undefined && Date.now() < stopBy) await sleep(50);
    expect(stoppedWhy).toBe("credential revoked");
    expect(logs).toContainEqual({ event: "credential_revoked", detail: { reason: "credential revoked or replaced" } });
    expect(logs.map((l) => l.event)).not.toContain("kicked");
    await sleep(800);
    expect(logs.filter((l) => l.event === "reconnect_scheduled")).toEqual([]);
    const closed = (await audit({ action: "sockets_closed" })).filter((e) => e.target_id === "ri");
    expect(closed.at(-1)?.detail).toMatchObject({ reason: "credential_revoked", closed: 1, code: 4004 });
  });
});

describe("the real adapter with a revoked token (review m4)", () => {
  it("stops at bbs_join with credential_revoked and does not retry", async () => {
    const token = await addUser("ka");
    await call(token, "bbs_join", {});
    await kick(token, "ka");
    const dir = join(run.dir, "ka");
    mkdirSync(dir, { recursive: true });
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ url: server.url, token }), { mode: 0o600 });
    const logFile = join(dir, "adapter.jsonl");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      BBS_CONFIG: config,
      BBS_ADAPTER_LOG: logFile,
      BBS_ADAPTER_SOCKET_DIR: join(dir, "sock"),
      CLAUDE_CODE_MESSAGING_SOCKET: join(dir, "claude-messaging.sock"),
    };
    const client = new Client({ name: "fake-claude-code", version: "0" });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], env, stderr: "ignore" }));
    const read = (): Record<string, unknown>[] => {
      try {
        return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      } catch {
        return [];
      }
    };
    const deadline = Date.now() + 10_000;
    while (!read().some((l) => l.ev === "credential_revoked") && Date.now() < deadline) await sleep(100);
    expect(read().find((l) => l.ev === "credential_revoked")).toMatchObject({ reason: "bbs_join refused: revoked_token" });
    await sleep(2500);
    const lines = read();
    expect(lines.filter((l) => l.ev === "join_failed" || l.ev === "reconnect_scheduled")).toEqual([]);
    expect(lines.filter((l) => l.ev === "credential_revoked")).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(token);
  });
});
