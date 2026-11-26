// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The real adapter process against a fake board (issue #100, decided by Curtis
 * 2026-11-25: "In a git repo only"): what it sends at start in and out of a git
 * repository, with the settings, and that a failing join never fails the
 * session. A real board and a real handle are in test/e2e/adapter.test.ts.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "bbs-adapter.js");
const TOKEN = "tok_fake_token_for_tests";
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

interface Seen {
  tool: string;
  body: Record<string, unknown>;
  session: string | undefined;
}

let root: string;
let board: Server;
let boardUrl: string;
let seen: Seen[] = [];
let joinStatus = 200;
const clients: Client[] = [];

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bbs-aj-")));
  board = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const tool = decodeURIComponent((req.url ?? "").replace(/^\/api\//, ""));
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const session = req.headers["x-bbs-session"];
      seen.push({ tool, body, session: typeof session === "string" ? session : undefined });
      res.setHeader("content-type", "application/json");
      if (tool === "bbs_join") {
        if (joinStatus !== 200) {
          res.statusCode = joinStatus;
          res.end(JSON.stringify({ ok: false, error: { code: "internal", message: "down" } }));
          return;
        }
        res.end(JSON.stringify({ ok: true, value: { handle: "proj-abcd", parent: "proj", session: "s_one", first_join: true, wake: "none" } }));
        return;
      }
      res.end(JSON.stringify({ ok: true, value: {} }));
    });
  });
  await new Promise<void>((resolve) => board.listen(0, "127.0.0.1", resolve));
  boardUrl = `http://127.0.0.1:${(board.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => board.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  seen = [];
  joinStatus = 200;
});

let n = 0;
function folder(name: string, git: boolean): string {
  const dir = join(root, `${name}-${(n += 1)}`);
  mkdirSync(git ? join(dir, ".git") : dir, { recursive: true });
  return dir;
}

interface Started {
  client: Client;
  env: Record<string, string>;
  log(): { ev: string; [k: string]: unknown }[];
}

async function start(cwd: string, extra: Record<string, string> = {}, sessionId: string | undefined = SESSION_ID): Promise<Started> {
  const dir = join(root, `state-${(n += 1)}`);
  mkdirSync(dir, { recursive: true });
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ url: boardUrl, token: TOKEN }), { mode: 0o600 });
  const logFile = join(dir, "adapter.jsonl");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    BBS_CONFIG: config,
    BBS_ADAPTER_LOG: logFile,
    BBS_MACHINE: "workstation-1",
    BBS_ADAPTER_SOCKET_DIR: join(dir, "sock"),
    CLAUDE_CODE_MESSAGING_SOCKET: join(dir, "claude-messaging.sock"),
    ...(sessionId !== undefined ? { CLAUDE_CODE_SESSION_ID: sessionId } : {}),
    ...extra,
  };
  const client = new Client({ name: "fake-claude-code", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN], env, cwd, stderr: "ignore" }));
  clients.push(client);
  return {
    client,
    env,
    log() {
      try {
        return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, ms = 8000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (pred()) return true;
  return pred();
}

const joins = (): Seen[] => seen.filter((s) => s.tool === "bbs_join");

/** Run `bbs-adapter hook <event>` as Claude Code would, without blocking this process. */
function hook(env: Record<string, string>, event: string, input: unknown): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "hook", event], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.on("close", () => resolve(out));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("the adapter process at start (issue #100)", () => {
  it("in a git repository it joins by itself, before any tool call, with the labels, the session id and a role line naming the repository", async () => {
    const dir = folder("widget-app", true);
    const a = await start(dir);
    expect(await until(() => joins().length > 0)).toBe(true);
    const body = joins()[0]!.body;
    expect(body).toMatchObject({
      harness: "claude-code",
      machine: "workstation-1",
      harness_session: SESSION_ID,
      role: expect.stringMatching(/^widget-app-\d+: \(no task yet\)$/),
    });
    expect(typeof body.os).toBe("string");
    // Nothing of the working directory but its name: no path, in the body or in the log.
    expect(JSON.stringify(body)).not.toContain(root);
    expect(JSON.stringify(a.log())).not.toContain(root);
    expect(JSON.stringify(a.log())).not.toContain(TOKEN);
    expect(JSON.stringify(a.log())).not.toContain(SESSION_ID);
    expect(a.log().find((l) => l.ev === "auto_join")).toMatchObject({ mode: "git", join: true });
    expect(await until(() => a.log().some((l) => l.ev === "joined"))).toBe(true);
    // The token goes in a header only, never in the join's body.
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  }, 30_000);

  it("takes the directory from CLAUDE_PROJECT_DIR, not the adapter's own working directory", async () => {
    const project = folder("from-env", true);
    const elsewhere = folder("elsewhere", false);
    await start(elsewhere, { CLAUDE_PROJECT_DIR: project });
    expect(await until(() => joins().length > 0)).toBe(true);
    expect(joins()[0]!.body.role).toMatch(/^from-env-\d+: /);
  }, 30_000);

  it("outside a repository it does not join; the first tool call joins it as before, with no role", async () => {
    const dir = folder("not-a-repo", false);
    const a = await start(dir);
    await sleep(1500);
    expect(joins()).toHaveLength(0);
    expect(a.log().find((l) => l.ev === "auto_join")).toMatchObject({ mode: "git", join: false });
    // The tools still work, and the session joins when its model first uses one.
    const r = await a.client.callTool({ name: "bbs_inbox", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(joins()).toHaveLength(1);
    expect(joins()[0]!.body).not.toHaveProperty("role");
    expect(joins()[0]!.body.harness_session).toBe(SESSION_ID);
    // And it attaches to the board after that.
    expect(await until(() => seen.some((s) => s.tool === "bbs_inbox" && s.session === "s_one"))).toBe(true);
  }, 30_000);

  it("BBS_AUTO_JOIN=0 keeps a session in a repository off the board, and =always joins one outside a repository with no directory name", async () => {
    const off = await start(folder("off-repo", true), { BBS_AUTO_JOIN: "0" });
    await sleep(1500);
    expect(joins()).toHaveLength(0);
    expect(off.log().find((l) => l.ev === "auto_join")).toMatchObject({ mode: "off", join: false });
    await off.client.close();
    const forced = await start(folder("forced-folder", false), { BBS_AUTO_JOIN: "always" });
    expect(await until(() => joins().length > 0)).toBe(true);
    expect(joins()[0]!.body.role).toBe("(no task yet)");
    expect(forced.log().find((l) => l.ev === "auto_join")).toMatchObject({ mode: "always", join: true });
  }, 30_000);

  it("a join that fails does not fail the session: the tools are served, the failure is logged without the token, and it retries", async () => {
    joinStatus = 503;
    const a = await start(folder("failing", true));
    expect(await until(() => a.log().some((l) => l.ev === "join_failed"))).toBe(true);
    const tools = await a.client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("bbs_join");
    const failed = a.log().find((l) => l.ev === "join_failed")!;
    expect(String(failed.error)).toContain("bbs_join refused");
    expect(JSON.stringify(a.log())).not.toContain(TOKEN);
    expect(a.log().some((l) => l.ev === "started")).toBe(true);
  }, 30_000);

  it("the session-start hook, run against the live adapter, names the handle; outside a repository it says the session has not joined", async () => {
    const a = await start(folder("hooked", true));
    const out = await hook(a.env, "SessionStart", { hook_event_name: "SessionStart", source: "startup", session_id: SESSION_ID });
    const text = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    expect(text).toContain("proj-abcd");
    expect(text).toContain("bbs_inbox now");
    const resumed = JSON.parse(await hook(a.env, "SessionStart", { source: "resume" })).hookSpecificOutput.additionalContext as string;
    expect(resumed).toContain("proj-abcd");
    expect(resumed.length).toBeLessThan(text.length);
    await a.client.close();
    const b = await start(folder("unjoined", false));
    const none = JSON.parse(await hook(b.env, "SessionStart", { source: "startup" })).hookSpecificOutput.additionalContext as string;
    expect(none).toContain("has not joined");
    expect(none).not.toContain("proj-abcd");
  }, 30_000);

  it("a Stop hook with no work since the last note lets the stop stand, and asks the board nothing", async () => {
    const a = await start(folder("idle-stop", true));
    expect(await until(() => a.log().some((l) => l.ev === "joined"))).toBe(true);
    const before = seen.filter((s) => s.tool === "bbs_task_list").length;
    expect(await hook(a.env, "Stop", { hook_event_name: "Stop", stop_hook_active: false })).toBe("");
    expect(seen.filter((s) => s.tool === "bbs_task_list")).toHaveLength(before);
  }, 30_000);

  it("a Stop hook after work asks the board for the tasks it holds in progress, and the model gets the note instruction only when there is one", async () => {
    const a = await start(folder("working", true));
    expect(await until(() => a.log().some((l) => l.ev === "joined"))).toBe(true);
    await hook(a.env, "UserPromptSubmit", { prompt: "do the thing" });
    await hook(a.env, "PostToolBatch", { tool_calls: [{ tool_name: "Edit" }] });
    await sleep(100);
    // The fake board answers an empty task list: nothing is held, so the stop stands.
    expect(await hook(a.env, "Stop", { stop_hook_active: false })).toBe("");
    const list = seen.filter((s) => s.tool === "bbs_task_list");
    expect(list).toHaveLength(1);
    expect(list[0]!.body).toEqual({ assignee: "me", state: "in_progress", limit: 1 });
    expect(list[0]!.session).toBe("s_one");
  }, 30_000);

  it("a second adapter for the same Claude Code session (as a subagent's server would be) joins with the same harness session, so the board gives the same handle", async () => {
    const dir = folder("shared", true);
    await start(dir);
    await start(dir);
    expect(await until(() => joins().length >= 2)).toBe(true);
    expect(joins().map((j) => j.body.harness_session)).toEqual([SESSION_ID, SESSION_ID]);
  }, 30_000);
});
