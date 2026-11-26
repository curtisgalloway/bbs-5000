// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The hooks that get an answer (issue #100): `SessionStart` and `Stop`, over
 * the real hook socket, and `PostToolBatch` telling the adapter about work.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HandBack } from "../src/hand-back.ts";
import { askHook, HookListener, messagingKey, notifyHook, type HookHandlers } from "../src/hooks.ts";
import { runHookCommand } from "../src/main.ts";
import { sessionStartOutput, sessionStartText, startSourceOf } from "../src/session-start.ts";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "bbs-adapter.js");
const tmp: string[] = [];
const open: HookListener[] = [];
afterEach(() => {
  for (const l of open.splice(0)) l.close();
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Run the adapter binary without blocking this process: the listener under test lives in it. */
function runBin(args: string[], input: string, env: Record<string, string>): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.on("close", (status) => resolve({ status, stdout }));
    child.stdin.end(input);
  });
}

async function listening(handlers: HookHandlers) {
  const base = mkdtempSync(join(tmpdir(), "bbs-ask-"));
  tmp.push(base);
  const dir = join(base, "s");
  const env = { BBS_ADAPTER_SOCKET_DIR: dir, CLAUDE_CODE_MESSAGING_SOCKET: join(base, "claude.sock") };
  const logs: { ev: string; detail?: Record<string, unknown> }[] = [];
  const l = new HookListener((ev, detail) => logs.push({ ev, ...(detail ? { detail } : {}) }), { handlers });
  open.push(l);
  await l.listen(dir, [messagingKey(env)!]);
  return { l, env, dir, logs };
}

describe("SessionStart: the hook gets the adapter's paragraph", () => {
  it("prints what the adapter answers for the source in the hook input", async () => {
    const seen: unknown[] = [];
    const { env } = await listening({
      async sessionStart(source) {
        seen.push(source);
        return sessionStartText({ source: startSourceOf(source), joined: true, handle: "dev-abcd" });
      },
    });
    const out = await runHookCommand("SessionStart", env, { text: JSON.stringify({ source: "resume", session_id: "abc" }), truncated: false });
    expect(seen).toEqual(["resume"]);
    const parsed = JSON.parse(out!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("dev-abcd");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("bbs_inbox");
  });

  it("waits for an adapter that starts listening a moment after the hook starts", async () => {
    const base = mkdtempSync(join(tmpdir(), "bbs-ask-"));
    tmp.push(base);
    const dir = join(base, "s");
    const env = { BBS_ADAPTER_SOCKET_DIR: dir, CLAUDE_CODE_MESSAGING_SOCKET: join(base, "claude.sock") };
    const l = new HookListener(() => undefined, { handlers: { sessionStart: async () => "late but here" } });
    open.push(l);
    setTimeout(() => void l.listen(dir, [messagingKey(env)!]), 400);
    const t0 = Date.now();
    expect(await askHook("SessionStart", { source: "startup" }, env, { waitMs: 3000 })).toBe("late but here");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
  });

  it("with no adapter prints nothing after the wait, and a Stop hook with none does not wait at all", async () => {
    const base = mkdtempSync(join(tmpdir(), "bbs-ask-"));
    tmp.push(base);
    const env = { BBS_ADAPTER_SOCKET_DIR: join(base, "s"), CLAUDE_CODE_MESSAGING_SOCKET: join(base, "none.sock") };
    const t0 = Date.now();
    expect(await askHook("SessionStart", {}, env, { waitMs: 300 })).toBeUndefined();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    const t1 = Date.now();
    expect(await runHookCommand("Stop", env, { text: "{}", truncated: false })).toBeUndefined();
    expect(Date.now() - t1).toBeLessThan(250);
  });

  it("a handler that throws or answers nothing means no output, never an error", async () => {
    const boom = await listening({
      async sessionStart() {
        throw new Error("boom");
      },
    });
    expect(await askHook("SessionStart", { source: "startup" }, boom.env)).toBeUndefined();
    const nothing = await listening({ async sessionStart() { return undefined; } });
    expect(await askHook("SessionStart", { source: "startup" }, nothing.env)).toBeUndefined();
  });

  it("the hook command prints the answer as one line and exits 0", async () => {
    const { env } = await listening({ async sessionStart() { return "BBS-5000: hello"; } });
    const r = await runBin(["hook", "SessionStart"], JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }), env);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${sessionStartOutput("BBS-5000: hello")}\n`);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toBe("BBS-5000: hello");
  });
});

describe("Stop: the hand-back note through the hook", () => {
  async function adapterSide(over: { joined?: boolean; held?: number | undefined; now?: () => number } = {}) {
    const hb = new HandBack(over.now ? { now: over.now } : {});
    const asked: boolean[] = [];
    const ctx = await listening({
      turnStarted: () => hb.turnStarted(),
      worked: () => hb.worked(),
      async stop(stopHookActive) {
        const text = await hb.atStop({
          stopHookActive,
          joined: over.joined ?? true,
          heldTask: async () => ("held" in over ? over.held : 7),
        });
        asked.push(text !== undefined);
        return text;
      },
    });
    return { ...ctx, hb, asked };
  }

  it("with work and a held task, the hook prints the instruction; the stop after it (stop_hook_active) prints nothing", async () => {
    const { env, l } = await adapterSide();
    await runHookCommand("UserPromptSubmit", env, { text: JSON.stringify({ prompt: "fix the parser" }), truncated: false });
    await runHookCommand("PostToolBatch", env, { text: JSON.stringify({ tool_calls: [{ tool_name: "Edit" }] }), truncated: false });
    await new Promise((r) => setTimeout(r, 50));
    const first = await runHookCommand("Stop", env, { text: JSON.stringify({ stop_hook_active: false }), truncated: false });
    expect(first).toContain("bbs_task_comment");
    expect(first).toContain("task 7");
    // The model goes on: the adapter stays busy rather than reporting idle in between.
    expect(l.current()).toBe("busy");
    const second = await runHookCommand("Stop", env, { text: JSON.stringify({ stop_hook_active: true }), truncated: false });
    expect(second).toBeUndefined();
    expect(l.current()).toBe("idle");
  });

  it("with no work since the last note the stop stands and the adapter reports idle", async () => {
    const { env, l } = await adapterSide();
    await runHookCommand("UserPromptSubmit", env, { text: JSON.stringify({ prompt: "hello" }), truncated: false });
    expect(await runHookCommand("Stop", env, { text: "{}", truncated: false })).toBeUndefined();
    expect(l.current()).toBe("idle");
  });

  it("a batch of only the board's own tools is not work", async () => {
    const { env, asked } = await adapterSide();
    await runHookCommand("PostToolBatch", env, {
      text: JSON.stringify({ tool_calls: [{ tool_name: "mcp__plugin_bbs_bbs__bbs_inbox" }] }),
      truncated: false,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await runHookCommand("Stop", env, { text: "{}", truncated: false })).toBeUndefined();
    expect(asked).toEqual([false]);
  });

  it("a batch too long to read counts as work", async () => {
    const { env } = await adapterSide();
    await runHookCommand("PostToolBatch", env, { text: "", truncated: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(await runHookCommand("Stop", env, { text: "{}", truncated: false })).toContain("task 7");
  });

  it("an unjoined session is never asked", async () => {
    const { env } = await adapterSide({ joined: false });
    await notifyHook("PostToolBatch", { work: true }, env);
    await new Promise((r) => setTimeout(r, 50));
    expect(await runHookCommand("Stop", env, { text: "{}", truncated: false })).toBeUndefined();
  });

  it("a Stop handler that never answers is cut off, and the stop stands", async () => {
    const { env, l } = await listening({
      stop: () => new Promise<string | undefined>(() => undefined),
    });
    // The listener's own limit is 8 s; shorten the wait on the hook side to see it end by itself.
    expect(await askHook("Stop", { stop_hook_active: false }, env, { answerMs: 300 })).toBeUndefined();
    expect(l.current()).toBe("idle");
  }, 15_000);

  it("the Stop output is Stop additionalContext JSON, and the adapter's log never holds the note or a session id", async () => {
    const { env, logs } = await adapterSide();
    await notifyHook("PostToolBatch", { work: true }, env);
    await new Promise((r) => setTimeout(r, 50));
    const out = await runHookCommand("Stop", env, { text: JSON.stringify({ session_id: "s-secret-id", stop_hook_active: false }), truncated: false });
    expect(JSON.parse(out!)).toEqual({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: expect.stringContaining("bbs_task_comment") } });
    expect(JSON.stringify(logs)).not.toContain("s-secret-id");
    expect(JSON.stringify(logs)).not.toContain("bbs_task_comment");
  });
});

describe("a subagent's hooks", () => {
  it("a tool batch from inside a subagent counts as the session's work", async () => {
    const worked: number[] = [];
    const { env } = await listening({ worked: () => worked.push(1) });
    await runHookCommand("PostToolBatch", env, {
      text: JSON.stringify({ agent_id: "agent-1", agent_type: "Explore", tool_calls: [{ tool_name: "Grep" }] }),
      truncated: false,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(worked).toEqual([1]);
  });
});
