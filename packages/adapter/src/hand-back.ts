// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The hand-back note (issue #100, decided by Curtis 2026-11-25: "Ask the agent,
 * rate-limited"). When a Claude Code turn ends, the adapter decides, with no
 * model call, whether to have the agent leave one short comment on the task it
 * holds. The `Stop` hook asks the adapter; the adapter answers with the
 * instruction text or nothing.
 *
 * It asks only when all of these hold, cheapest check first:
 *
 * 1. the hook input does not say a stop hook already continued this turn
 *    (`stop_hook_active`), so a stop that follows the note is never blocked again;
 * 2. the session is joined;
 * 3. no ask was made in this turn yet (a hard guard beside 1);
 * 4. a turn with a tool use has finished since the last ask (`work`, from the
 *    `PostToolBatch` hook, not counting the board's own tools);
 * 5. at least `HAND_BACK_MIN_INTERVAL_MS` since the last ask;
 * 6. the board says this handle holds a task in `in_progress` (the one board call).
 *
 * A board error at 6 means no ask. State lives in the adapter process, never in
 * a file.
 */

/** At most one ask per this long (15 minutes). The one place the interval is set. */
export const HAND_BACK_MIN_INTERVAL_MS = 15 * 60_000;

/** What the board call returns: the id of a task the handle holds in progress, or undefined when it holds none. */
export type HeldTask = () => Promise<number | undefined>;

export interface HandBackOptions {
  now?: () => number;
  minIntervalMs?: number;
}

export interface StopFacts {
  /** The hook input's `stop_hook_active`: Claude Code is already continuing because of a stop hook. */
  stopHookActive: boolean;
  /** Whether this session has a board session. */
  joined: boolean;
  /** Asks the board; called only when every local condition holds. */
  heldTask: HeldTask;
}

/** The instruction the hook gives the model; `task` is the id of the task it holds. */
export function handBackInstruction(task: number): string {
  return (
    `BBS-5000 hand-back note: the board shows you hold task #${task} in progress, and you have worked since your last note on the board. ` +
    `Add one bbs_task_comment on task ${task} that starts with "done:" or "needs input:" and says where you stopped and the next step, in two or three sentences. ` +
    "Then stop. Do not add a second note, and do not start new work."
  );
}

/**
 * The hook output that makes the model go on with `text`: `additionalContext`
 * on `Stop` is the documented non-error way ("Stop hook feedback", not a hook
 * error), under the same loop guards as a block (`stop_hook_active`, and the
 * cap of 8 continuations in a row) (https://code.claude.com/docs/en/hooks,
 * read 2026-11-25).
 */
export function stopOutput(text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: text } });
}

export class HandBack {
  readonly #now: () => number;
  readonly #minIntervalMs: number;
  #work = false;
  #askedThisTurn = false;
  #lastAskAt: number | undefined;

  constructor(o: HandBackOptions = {}) {
    this.#now = o.now ?? Date.now;
    this.#minIntervalMs = o.minIntervalMs ?? HAND_BACK_MIN_INTERVAL_MS;
  }

  /** A new turn begins (the `UserPromptSubmit` hook): the one-ask-per-turn guard resets. */
  turnStarted(): void {
    this.#askedThisTurn = false;
  }

  /** A tool batch finished that was work (not only the board's own tools). */
  worked(): void {
    this.#work = true;
  }

  /** The instruction to give the model at this stop, or undefined to let the stop stand. Never throws. */
  async atStop(f: StopFacts): Promise<string | undefined> {
    if (f.stopHookActive) return undefined;
    if (!f.joined) return undefined;
    if (this.#askedThisTurn) return undefined;
    if (!this.#work) return undefined;
    const now = this.#now();
    if (this.#lastAskAt !== undefined && now - this.#lastAskAt < this.#minIntervalMs) return undefined;
    let task: number | undefined;
    try {
      task = await f.heldTask();
    } catch {
      return undefined;
    }
    if (task === undefined) return undefined;
    // Claim the ask before anything else can run: a second Stop in the same turn finds it taken.
    if (this.#askedThisTurn) return undefined;
    this.#askedThisTurn = true;
    this.#lastAskAt = now;
    this.#work = false;
    return handBackInstruction(task);
  }
}

/**
 * Whether a `PostToolBatch` hook input is work: at least one tool call that is
 * not one of the board's own tools (`mcp__<server>__bbs_*`, whichever name the
 * server has). An input that cannot be read counts as work, since a batch ran.
 */
export function batchIsWork(input: string): boolean {
  let calls: unknown;
  try {
    calls = (JSON.parse(input) as { tool_calls?: unknown }).tool_calls;
  } catch {
    return true;
  }
  if (!Array.isArray(calls) || calls.length === 0) return true;
  return calls.some((c) => {
    const name = (c as { tool_name?: unknown } | null)?.tool_name;
    return typeof name !== "string" || !/^mcp__.+__bbs_[a-z_]+$/.test(name);
  });
}
