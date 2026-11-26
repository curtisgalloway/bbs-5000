// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The paragraph the `SessionStart` hook gives the model (issue #100, decided by
 * Curtis 2026-11-25: "Plugin, user-wide", "In a git repo only"). It is spent on
 * every session, so it is short: about 60 words when the session joined, fewer
 * on a resume. The topic and Lobby sentences are the agent guide's own
 * (`TOPIC_RULE`, `NO_WORK_IN_LOBBY` from `@bbs-5000/core`), so the two cannot
 * drift.
 */

import { NO_WORK_IN_LOBBY, TOPIC_RULE } from "@bbs-5000/core";

/** `source` of a `SessionStart` hook input: how the session began. */
export type StartSource = "startup" | "resume" | "clear" | "compact" | "fork";

const SOURCES: readonly string[] = ["startup", "resume", "clear", "compact", "fork"];

/** The source from the hook's input; an unknown or missing one is a fresh start. */
export function startSourceOf(v: unknown): StartSource {
  return typeof v === "string" && SOURCES.includes(v) ? (v as StartSource) : "startup";
}

export interface StartFacts {
  source: StartSource;
  /** Whether the adapter has a board session now. */
  joined: boolean;
  /** The handle the session acts as, when the join said. */
  handle?: string;
  /** The role line the adapter joined with. */
  role?: string;
}

/**
 * A resume, a fork and a compaction keep the conversation, so the model already
 * has the long text in its context or can read it again from its tools; a
 * startup or a `/clear` begins an empty one and gets the whole paragraph.
 */
function isContinuation(source: StartSource): boolean {
  return source === "resume" || source === "compact" || source === "fork";
}

/** The paragraph for this start. */
export function sessionStartText(f: StartFacts): string {
  const short = isContinuation(f.source);
  if (!f.joined) {
    return short
      ? "BBS-5000: the message board is available, but this session has not joined it. Call bbs_join with a one-line role to use it."
      : "BBS-5000: the message board is available, but this session has not joined it (it is not in a git repository, or auto-join is off). " +
          "To use it, call bbs_join with a one-line role, then bbs_inbox. Skip it when this work involves no other agents.";
  }
  const as = f.handle !== undefined ? `as ${f.handle}` : "(bbs_whoami names its handle)";
  if (short) {
    return `BBS-5000: this session is on the message board ${as}. Call bbs_inbox to catch up, and keep your role line on your current work.`;
  }
  return (
    `BBS-5000: this session is on the message board ${as}. Call bbs_inbox now. ` +
    "Before you start work, claim or create a task for it (bbs_task_claim, bbs_task_create) and set your role line to that work (bbs_role_set). " +
    `${TOPIC_RULE} ${NO_WORK_IN_LOBBY}`
  );
}

/** The hook output that adds `text` to the model's context at session start. */
export function sessionStartOutput(text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } });
}
