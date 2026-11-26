// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// G5, end to end under `wrangler dev`: `bbs_admin_status` for the human admin
// (via the CLI client, the web client and the `bbs` command), refused and
// audited for an agent, absent from /mcp; a user added through /api shows in
// it; the Board DO's open adapter sockets reach it (the runtime facts); three
// failed ring results flag "rings keep failing" (the window-function query in
// the Durable Object's SQLite); a muted and then a kicked agent are flagged,
// and reinstating clears the flag. Lobby window 1.5 s and mute 3 s, so the
// walk to a kick fits in a test.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { api, groupAlive, makeRunDir, ROOT, sleep, startWrangler, webSignIn, type RunDir, type Server } from "./harness.ts";
import { ScriptedAdapter } from "./scripted-adapter.ts";

const WINDOW_MS = 1500;
const MUTE_MS = 3000;
const asCli = { "x-bbs-client": "cli" };

let run: RunDir;
let server: Server;
let human: string;
const sockets: ScriptedAdapter[] = [];

beforeAll(async () => {
  run = makeRunDir("owner", { BBS_LOBBY_WINDOW_MS: String(WINDOW_MS), BBS_LOBBY_MUTE_MS: String(MUTE_MS) });
  human = run.humanToken;
  server = await startWrangler({ stateDir: run.stateDir, envFile: run.envFile, logFile: join(run.dir, "wrangler.log") });
});

afterAll(async () => {
  for (const s of sockets) {
    try {
      s.close();
    } catch {
      // Already closed.
    }
  }
  await server?.stop();
  if (server) expect(groupAlive(server.pid)).toBe(false);
  run?.cleanup();
});

async function addUser(handle: string, extra: Record<string, string> = {}): Promise<string> {
  const r = await api(server.url, human, "bbs_admin_user_add", { handle, ...extra }, asCli);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.value.token as string;
}

async function status(headers: Record<string, string> = asCli, token: string | null = human): Promise<any> {
  const r = await api(server.url, token ?? undefined, "bbs_admin_status", {}, headers);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.value;
}

const userIn = (s: any, handle: string): any => s.users.find((u: any) => u.handle === handle);

async function until<T>(what: string, fn: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
}

/** Post to the Lobby until the first refusal; returns it. */
async function flood(token: string, tag: string): Promise<{ status: number; body: any }> {
  for (let i = 0; i < 20; i++) {
    const r = await api(server.url, token, "bbs_post", { topic: "Lobby", body: `${tag}-${i}` });
    if (r.status !== 200) return r;
  }
  throw new Error("never refused");
}

function bbs(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "packages/cli/bin/bbs.js"), ...args], {
      env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

describe("bbs_admin_status (G5)", () => {
  it("answers the human admin through the CLI and web clients, unaudited; a healthy board has nothing in needs_you", async () => {
    const before = (await api(server.url, human, "bbs_audit", { tail: true, limit: 1 }, asCli)).body.value.events[0].seq;
    const s = await status();
    expect(s.needs_you).toEqual([]);
    expect(s.users.map((u: any) => u.handle)).toEqual(["owner"]);
    // No sink in this run: export off, as plain data.
    expect(s.audit_export.configured).toBe(false);
    const w = await status((await webSignIn(server.url, human)).headers, null);
    expect(w.needs_you).toEqual([]);
    // Neither read wrote an audit row (the audit read itself writes one, after `before`).
    const rows = (await api(server.url, human, "bbs_audit", { after_seq: before }, asCli)).body.value.events;
    expect(rows.filter((e: any) => e.action === "admin_status")).toEqual([]);
  });

  it("is refused for an agent with a denied audit row, and is not offered on /mcp", async () => {
    const agent = await addUser("probe");
    const r = await api(server.url, agent, "bbs_admin_status", {});
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("forbidden");
    const audit = await api(server.url, human, "bbs_audit", { action: "admin_status", limit: 10 }, asCli);
    expect(audit.body.value.events.map((e: any) => [e.actor, e.result])).toEqual([["probe", "denied"]]);
    const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${agent}` } },
    });
    const c = new Client({ name: "bbs-e2e", version: "0.0.0" });
    await c.connect(transport);
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain("bbs_admin_status");
    expect((await c.callTool({ name: "bbs_admin_status", arguments: {} })).isError).toBe(true);
    await c.close();
  });

  it("shows a user added through /api, and the Board DO's open adapter sockets", async () => {
    const token = await addUser("alice", { harness: "claude-code", role: "builder" });
    expect(userIn(await status(), "alice")).toMatchObject({
      kind: "agent",
      harness: "claude-code",
      role: "builder",
      status: "active",
      session: null,
      open_sockets: 0,
    });
    const session = (await api(server.url, token, "bbs_join", {})).body.value.session as string;
    const sock = await ScriptedAdapter.connect(server.url, token);
    sockets.push(sock);
    sock.hello(session);
    const attached = await until("socket attached", async () => {
      const u = userIn(await status(), "alice");
      return u.open_sockets === 1 && u.session?.socket_recorded ? u : undefined;
    });
    expect(attached.session).toMatchObject({ state: "idle", machine: "workstation-1" });
    sock.close();
    await until("socket gone", async () => {
      const u = userIn(await status(), "alice");
      return u.open_sockets === 0 && u.session?.socket_recorded === false ? u : undefined;
    });
  });

  it("flags an agent whose last three ring results failed, and a started turn clears it", async () => {
    const token = await addUser("ringer");
    const session = (await api(server.url, token, "bbs_join", {})).body.value.session as string;
    const sock = await ScriptedAdapter.connect(server.url, token);
    sockets.push(sock);
    sock.hello(session);
    await until("attached", async () => ((userIn(await status(), "ringer").open_sockets === 1) ? true : undefined));
    for (let i = 0; i < 3; i++) sock.send({ type: "ring_result", id: `d_e2e${i}`, result: "failed" });
    const flagged = await until("rings_failing flag", async () => {
      const s = await status();
      return s.needs_you.find((f: any) => f.kind === "rings_failing" && f.handle === "ringer");
    });
    expect(flagged.todo).toMatch(/Likely causes/);
    expect(userIn(await status(), "ringer").rings.map((r: any) => r.result)).toEqual(["failed", "failed", "failed"]);
    sock.send({ type: "ring_result", id: "d_e2e3", result: "turn_started" });
    await until("flag cleared", async () => {
      const s = await status();
      return s.needs_you.some((f: any) => f.handle === "ringer") ? undefined : true;
    });
    sock.close();
  });

  it("flags a muted and then a kicked agent with what to do; bbs admin status prints it; reinstating clears it", async () => {
    const token = await addUser("flooder");
    expect((await api(server.url, token, "bbs_join", {})).status).toBe(200);
    expect((await flood(token, "one")).status).toBe(429);
    await sleep(WINDOW_MS + 200);
    expect((await flood(token, "two")).body.error.message).toMatch(/muted in the Lobby/);
    const muted = (await status()).needs_you.find((f: any) => f.handle === "flooder");
    expect(muted).toMatchObject({ kind: "muted" });
    expect(muted.what).toMatch(/left\.$/);
    // The mute lifts through the Durable Object alarm, and the flag goes with it.
    await until(
      "mute lifted",
      async () => ((await status()).needs_you.some((f: any) => f.handle === "flooder") ? undefined : true),
      15_000,
    );
    await sleep(WINDOW_MS + 200);
    expect((await flood(token, "three")).body.error.message).toMatch(/removed from the board/);
    const s = await status();
    expect(userIn(s, "flooder")).toMatchObject({ status: "kicked" });
    const kicked = s.needs_you.find((f: any) => f.handle === "flooder");
    expect(kicked).toMatchObject({ kind: "kicked", action: "reinstate" });
    expect(kicked.what).toMatch(/kicked by the auto-administrator/);

    // The CLI prints the same for a person, and the JSON with --json.
    const path = join(run.dir, "owner.json");
    writeFileSync(path, JSON.stringify({ url: server.url, token: human }), { mode: 0o600 });
    const text = await bbs(["admin", "status"], { BBS_CONFIG: path });
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^Needs you \(1\):/);
    expect(text.out).toContain("flooder: agent; KICKED");
    const json = await bbs(["admin", "status", "--json"], { BBS_CONFIG: path });
    expect(JSON.parse(json.out).needs_you[0].kind).toBe("kicked");

    const r = await api(server.url, human, "bbs_admin_reinstate", { handle: "flooder" }, asCli);
    expect(r.status).toBe(200);
    const after = await status();
    expect(after.needs_you).toEqual([]);
    expect(userIn(after, "flooder").status).toBe("active");
    expect((await bbs(["admin", "status"], { BBS_CONFIG: path })).out).toMatch(/^All clear/);
  });
});
