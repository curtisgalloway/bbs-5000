// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The hand-back note decision (issue #100, decided by Curtis 2026-11-25: "Ask
 * the agent, rate-limited"): the table of when a stop asks the model for a
 * task comment, with no model and no board.
 */

import { describe, expect, it } from "vitest";
import { batchIsWork, HAND_BACK_MIN_INTERVAL_MS, HandBack, handBackInstruction } from "../src/hand-back.ts";

function fixture() {
  let t = 10_000_000;
  const calls = { board: 0 };
  let held: number | undefined = 12;
  let fail = false;
  const hb = new HandBack({ now: () => t });
  const stop = (over: { stopHookActive?: boolean; joined?: boolean } = {}) =>
    hb.atStop({
      stopHookActive: over.stopHookActive ?? false,
      joined: over.joined ?? true,
      async heldTask() {
        calls.board += 1;
        if (fail) throw new Error("board down");
        return held;
      },
    });
  return {
    hb,
    calls,
    stop,
    advance: (ms: number) => (t += ms),
    hold: (id: number | undefined) => (held = id),
    breakBoard: (b: boolean) => (fail = b),
  };
}

describe("the hand-back decision at Stop", () => {
  it("the interval is 15 minutes", () => {
    expect(HAND_BACK_MIN_INTERVAL_MS).toBe(15 * 60_000);
  });

  it("asks once when joined, holding a task in progress, with work since the last note and no recent ask", async () => {
    const f = fixture();
    f.hb.turnStarted();
    f.hb.worked();
    const text = await f.stop();
    expect(text).toBe(handBackInstruction(12));
    expect(text).toContain("bbs_task_comment");
    expect(text).toContain("task 12");
    expect(text).toMatch(/"done:" or "needs input:"/);
    expect(f.calls.board).toBe(1);
  });

  it("does not ask when the session is not joined, and never calls the board then", async () => {
    const f = fixture();
    f.hb.worked();
    expect(await f.stop({ joined: false })).toBeUndefined();
    expect(f.calls.board).toBe(0);
  });

  it("does not ask when the board says it holds no task in progress", async () => {
    const f = fixture();
    f.hold(undefined);
    f.hb.worked();
    expect(await f.stop()).toBeUndefined();
    expect(f.calls.board).toBe(1);
  });

  it("does not ask with no work since the last note, and never calls the board then", async () => {
    const f = fixture();
    expect(await f.stop()).toBeUndefined();
    expect(f.calls.board).toBe(0);
  });

  it("does not ask again inside the interval, and does again after it once there is new work", async () => {
    const f = fixture();
    f.hb.worked();
    expect(await f.stop()).toBeDefined();
    f.hb.turnStarted();
    f.hb.worked();
    f.advance(HAND_BACK_MIN_INTERVAL_MS - 1);
    expect(await f.stop()).toBeUndefined();
    f.advance(1);
    expect(await f.stop()).toBeDefined();
    // The ask reset the work: a stop with no new work after it does not ask even past the interval.
    f.advance(HAND_BACK_MIN_INTERVAL_MS * 2);
    f.hb.turnStarted();
    expect(await f.stop()).toBeUndefined();
  });

  it("never asks when Claude Code says a stop hook already continued this turn", async () => {
    const f = fixture();
    f.hb.worked();
    expect(await f.stop({ stopHookActive: true })).toBeUndefined();
    expect(f.calls.board).toBe(0);
    // The ask, then the stop that follows the note, which carries the flag.
    expect(await f.stop()).toBeDefined();
    f.hb.worked();
    f.advance(HAND_BACK_MIN_INTERVAL_MS * 2);
    expect(await f.stop({ stopHookActive: true })).toBeUndefined();
  });

  it("asks at most once per turn, whatever the interval and the flag", async () => {
    const f = fixture();
    f.hb.worked();
    expect(await f.stop()).toBeDefined();
    f.hb.worked();
    f.advance(HAND_BACK_MIN_INTERVAL_MS * 2);
    // Same turn: no turnStarted in between.
    expect(await f.stop()).toBeUndefined();
    f.hb.turnStarted();
    expect(await f.stop()).toBeDefined();
  });

  it("two stops at once make one ask", async () => {
    const f = fixture();
    f.hb.worked();
    const [a, b] = await Promise.all([f.stop(), f.stop()]);
    expect([a, b].filter((x) => x !== undefined)).toHaveLength(1);
  });

  it("a board error never asks and never throws, and the next stop may ask", async () => {
    const f = fixture();
    f.hb.worked();
    f.breakBoard(true);
    expect(await f.stop()).toBeUndefined();
    f.breakBoard(false);
    expect(await f.stop()).toBeDefined();
  });
});

describe("what counts as work", () => {
  const batch = (...names: string[]) => JSON.stringify({ tool_calls: names.map((tool_name) => ({ tool_name, tool_input: {} })) });

  it("is any tool batch with a tool that is not one of the board's own", () => {
    expect(batchIsWork(batch("Bash"))).toBe(true);
    expect(batchIsWork(batch("Edit", "mcp__plugin_bbs_bbs__bbs_task_comment"))).toBe(true);
    expect(batchIsWork(batch("mcp__other__query"))).toBe(true);
  });

  it("is not a batch of only the board's tools, from the plugin or a project server", () => {
    expect(batchIsWork(batch("mcp__plugin_bbs_bbs__bbs_task_comment"))).toBe(false);
    expect(batchIsWork(batch("mcp__bbs__bbs_inbox", "mcp__bbs__bbs_role_set"))).toBe(false);
  });

  it("counts a batch it cannot read, or one with no calls listed, as work (a batch ran)", () => {
    expect(batchIsWork("not json")).toBe(true);
    expect(batchIsWork("{}")).toBe(true);
    expect(batchIsWork(JSON.stringify({ tool_calls: [] }))).toBe(true);
    // A batch from inside a subagent is the session's work too.
    expect(batchIsWork(JSON.stringify({ agent_id: "agent-1", tool_calls: [{ tool_name: "Read" }] }))).toBe(true);
  });
});
