// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Tasks (design §8): task_create, task_assign, task_claim, task_update,
 * task_comment, task_list, task_block, task_unblock, and the lease timer.
 *
 *     open -> assigned -> in_progress -> in_review -> done
 *                             |  ^            |
 *                             v  |            v (rework)
 *                           blocked       in_progress
 *     any unfinished state -> cancelled
 *
 * Every state change writes a `task_comments` row with `state_change`
 * `from>to`. A task enters `blocked` only with at least one unfinished
 * blocking task (any topic), never itself and never closing a cycle; when
 * every blocker is `done` it returns to `prior_state`. A cancelled blocker
 * leaves it `blocked`.
 *
 * Leases: entering `in_progress` sets `lease_expires_at` and arms one
 * `lease` timer. `act` renews the lease on every call by the assignee
 * (`renewLeases`); the timer is not moved then. When it fires, the lease
 * check moves it to the renewed expiry, or marks the task stale. Leaving
 * `in_progress` (including to `blocked`) clears the lease and the timer, and
 * returning to `in_progress` starts a full lease again: the lease is paused
 * while blocked by being recomputed, not by storing the time left.
 */

import {
  asParams,
  foldHandle,
  optEnum,
  optInt,
  optString,
  reqHandle,
  reqLabel,
  reqString,
  optTopic,
  optBool,
  reqTopic,
  type Params,
} from "../params.ts";
import {
  BbsError,
  denied,
  type ActionDef,
  type TaskNoticeReason,
  type TaskNotification,
  type Tx,
} from "../types.ts";
import { ADMIN_LOG } from "../schema.ts";
import { getTopic, requireActiveTopic, resolveHandle } from "./common.ts";

export type TaskState =
  | "open"
  | "assigned"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "cancelled";

export const TASK_STATES: readonly TaskState[] = [
  "open",
  "assigned",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "cancelled",
];

const FINISHED: readonly TaskState[] = ["done", "cancelled"];

/**
 * State changes `task_update` makes directly. `blocked` goes through
 * `task_block` (or `task_update` with `blocked_by`), and leaves it only when
 * its blockers are done or removed. `cancelled` is allowed from every
 * unfinished state.
 */
const UPDATE_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  open: [],
  assigned: ["in_progress"],
  in_progress: ["in_review"],
  blocked: [],
  in_review: ["done", "in_progress"],
  done: [],
  cancelled: [],
};

export interface TaskRow {
  id: number;
  topic: string;
  title: string;
  description: string;
  state: TaskState;
  prior_state: TaskState | null;
  is_stale: number;
  assignee: string | null;
  created_by: string;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
  [key: string]: unknown;
}

const MAX_TASK_ID = Number.MAX_SAFE_INTEGER;

function reqTaskId(p: Params, key = "task"): number {
  const v = optInt(p, key, 1, MAX_TASK_ID);
  if (v === undefined) throw new BbsError("bad_request", `${key} is required (a task id)`);
  return v;
}

export function getTask(tx: Tx, id: number): TaskRow {
  const row = tx.sql.one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
  if (!row) {
    // A task of a cold topic (M6b, design §14): the archived text, not "no task".
    const cold = tx.sql.one<{ topic: string }>("SELECT topic FROM cold_tasks WHERE id = ?", id);
    if (cold) requireActiveTopic(getTopic(tx, cold.topic));
    throw new BbsError("not_found", `no task ${id}`);
  }
  return row;
}

/** Design §4: a user is "in" a topic when subscribed at any level but `off`. */
function inTopic(tx: Tx, handle: string, topic: string): boolean {
  return (
    tx.sql.one(
      "SELECT 1 AS x FROM subscriptions WHERE handle = ? AND topic = ? AND level <> 'off'",
      handle,
      topic,
    ) !== undefined
  );
}

function requireInTopic(tx: Tx, topic: string): void {
  if (!inTopic(tx, tx.actor.handle, topic)) {
    throw denied(`you are not in #${topic}; subscribe to it first`);
  }
}

function requireUnfinished(task: TaskRow): void {
  if (FINISHED.includes(task.state)) {
    throw new BbsError("conflict", `task ${task.id} is ${task.state}`);
  }
}

/**
 * Who may change a task's state or blockers: its assignee, its creator, a
 * coordinator, or a person. (Assigning, claiming and commenting are open to
 * anyone in the topic, per design §8.)
 */
function requireManager(tx: Tx, task: TaskRow): void {
  const a = tx.actor;
  if (
    a.handle === task.assignee ||
    a.handle === task.created_by ||
    a.isCoordinator ||
    a.kind === "human"
  ) {
    return;
  }
  throw denied(
    `only the assignee, the creator, a coordinator or a person can change task ${task.id}`,
  );
}

/** Collects notices for one action; drops any addressed to the actor. */
export class Notices {
  readonly list: TaskNotification[] = [];
  readonly #tx: Tx;

  constructor(tx: Tx) {
    this.#tx = tx;
  }

  add(
    recipient: string | null,
    as: TaskNotification["as"],
    reason: TaskNoticeReason,
    task: TaskRow,
    alwaysWake: boolean,
    relatedTask?: number,
  ): void {
    if (recipient === null || recipient === this.#tx.actor.handle) return;
    if (this.list.some((n) => n.recipient === recipient && n.reason === reason && n.task === task.id)) {
      return;
    }
    this.list.push({
      type: "task",
      reason,
      recipient,
      as,
      task: task.id,
      topic: task.topic,
      ...(relatedTask !== undefined ? { relatedTask } : {}),
      alwaysWake,
      actor: this.#tx.actor.handle,
    });
  }

  /**
   * Tell every coordinator except the actor and `skip` (already told as
   * the assignee). With no coordinator at all, record that there was nobody
   * to tell.
   */
  coordinators(
    reason: TaskNoticeReason,
    task: TaskRow,
    skip: string | null,
    relatedTask?: number,
  ): void {
    const rows = this.#tx.sql.all<{ handle: string }>(
      "SELECT handle FROM users WHERE is_coordinator = 1 AND status <> 'kicked' ORDER BY handle",
    );
    if (rows.length === 0) {
      this.list.push({
        type: "task",
        reason,
        recipient: null,
        as: "coordinator",
        task: task.id,
        topic: task.topic,
        ...(relatedTask !== undefined ? { relatedTask } : {}),
        alwaysWake: false,
        undelivered: "no_coordinator",
        actor: this.#tx.actor.handle,
      });
      return;
    }
    for (const r of rows) {
      if (r.handle !== skip) this.add(r.handle, "coordinator", reason, task, false, relatedTask);
    }
  }

  /** A short form for the audit row's detail. */
  summary(): { to: string | null; reason: TaskNoticeReason; task: number }[] {
    return this.list.map((n) => ({ to: n.recipient, reason: n.reason, task: n.task }));
  }
}

function addComment(
  tx: Tx,
  task: number,
  author: string,
  body: string,
  stateChange: string | null,
): number {
  const row = tx.sql.one<{ id: number }>(
    `INSERT INTO task_comments (task, author, body, state_change, created_at)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
    task,
    author,
    body,
    stateChange,
    tx.now,
  );
  if (!row) throw new BbsError("internal", "comment insert returned no row");
  return Number(row.id);
}

function armLease(tx: Tx, task: number, due: number): void {
  clearLeaseTimer(tx, task);
  tx.sql.exec(
    "INSERT INTO timers (due_at, kind, ref) VALUES (?, 'lease', ?)",
    due,
    String(task),
  );
}

function clearLeaseTimer(tx: Tx, task: number): void {
  tx.sql.exec("DELETE FROM timers WHERE kind = 'lease' AND ref = ?", String(task));
}

/**
 * Move a task to a new state: comment `from>to`, clear `is_stale`, and keep
 * the lease in step (running only in `in_progress`). `extra` sets
 * `prior_state` and `assignee` when given.
 */
function setState(
  tx: Tx,
  task: TaskRow,
  to: TaskState,
  author: string,
  body: string,
  extra: { prior?: TaskState | null; assignee?: string | null } = {},
): TaskRow {
  const lease = to === "in_progress" ? tx.now + tx.config.taskLeaseMs : null;
  const prior = extra.prior === undefined ? task.prior_state : extra.prior;
  const assignee = extra.assignee === undefined ? task.assignee : extra.assignee;
  tx.sql.exec(
    `UPDATE tasks SET state = ?, prior_state = ?, assignee = ?, is_stale = 0,
       lease_expires_at = ?, updated_at = ?
     WHERE id = ?`,
    to,
    prior,
    assignee,
    lease,
    tx.now,
    task.id,
  );
  if (lease !== null) armLease(tx, task.id, lease);
  else clearLeaseTimer(tx, task.id);
  addComment(tx, task.id, author, body, `${task.state}>${to}`);
  return getTask(tx, task.id);
}

/** Ids of the tasks blocking `task`, unfinished first then by id. */
function blockersOf(tx: Tx, task: number): { id: number; state: TaskState }[] {
  return tx.sql
    .all<{ id: number; state: TaskState }>(
      `SELECT t.id, t.state FROM task_blocks b JOIN tasks t ON t.id = b.blocked_by
       WHERE b.task = ? ORDER BY t.id`,
      task,
    )
    .map((r) => ({ id: Number(r.id), state: r.state }));
}

/**
 * True when every blocker of `task` is `done` (or none is left). The
 * caller returns the task to `prior_state` then.
 */
function allBlockersDone(tx: Tx, task: number): boolean {
  return blockersOf(tx, task).every((b) => b.state === "done");
}

/** Return a blocked task to its prior state and tell its assignee. */
function release(tx: Tx, task: TaskRow, author: string, body: string, notices: Notices): void {
  let back: TaskState = task.prior_state ?? "open";
  // A task with an assignee is never `open` (claim and assign rely on it).
  if (back === "open" && task.assignee !== null) back = "assigned";
  const after = setState(tx, task, back, author, body, { prior: null });
  notices.add(after.assignee, "assignee", "task_unblocked", after, true);
}

/**
 * After `blocker` changed to `done` or `cancelled`: release the blocked
 * tasks whose blockers are now all done, or tell the assignee and the
 * coordinator that a blocker was cancelled (the task stays blocked).
 */
function afterFinished(tx: Tx, blocker: TaskRow, notices: Notices, skip?: ReadonlySet<number>): void {
  const waiting = tx.sql.all<TaskRow>(
    `SELECT t.* FROM task_blocks b JOIN tasks t ON t.id = b.task
     WHERE b.blocked_by = ? AND t.state = 'blocked' ORDER BY t.id`,
    blocker.id,
  );
  for (const t of waiting) {
    if (skip?.has(Number(t.id))) continue;
    if (blocker.state === "done") {
      if (allBlockersDone(tx, t.id)) {
        release(tx, t, "system", `every blocker is done (last: task ${blocker.id})`, notices);
      }
    } else {
      notices.add(t.assignee, "assignee", "blocker_cancelled", t, true, blocker.id);
      notices.coordinators("blocker_cancelled", t, t.assignee, blocker.id);
    }
  }
}

/**
 * Cancel an unfinished task for a human admin's force-archive (design §14,
 * B37), with the archive reason as the comment. As `bbs_task_update` does for
 * a cancel: the assignee is told (always wakes), and tasks it blocked are
 * handled by `afterFinished`. The coordinator is also told (decided in M6b:
 * the work was cancelled by someone other than its manager).
 */
export function cancelForArchive(
  tx: Tx,
  task: TaskRow,
  reason: string,
  notices: Notices,
  /** Tasks the same force-archive cancels: not told about a cancelled blocker (review n8). */
  cancelling?: ReadonlySet<number>,
): TaskRow {
  const after = setState(tx, task, "cancelled", tx.actor.handle, reason, { prior: task.prior_state });
  notices.add(after.assignee, "assignee", "task_comment", after, true);
  notices.coordinators("task_comment", after, after.assignee);
  afterFinished(tx, after, notices, cancelling);
  return after;
}

/** True when `from` can reach `target` by following blocked_by edges. */
function reaches(tx: Tx, from: number, target: number): boolean {
  const seen = new Set<number>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.shift() as number;
    if (node === target) return true;
    // A finished (done or cancelled) task waits on nothing: its old edges
    // cannot close a cycle, since it can never be blocked again.
    for (const r of tx.sql.all<{ blocked_by: number }>(
      `SELECT b.blocked_by FROM task_blocks b JOIN tasks t ON t.id = b.task
       WHERE b.task = ? AND t.state NOT IN ('done', 'cancelled')`,
      node,
    )) {
      const next = Number(r.blocked_by);
      if (seen.has(next)) continue;
      if (seen.size >= tx.config.maxCycleSearch) {
        throw new BbsError("conflict", "blocker graph too large to check for cycles");
      }
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}

function reqBlockerIds(tx: Tx, p: Params): number[] {
  const raw = p.blocked_by;
  const list = typeof raw === "number" ? [raw] : raw;
  if (!Array.isArray(list) || list.length === 0) {
    throw new BbsError(
      "bad_request",
      "blocked_by needs at least one blocking task id; if the blocker is not a task yet, create one",
    );
  }
  if (list.length > tx.config.maxBlockersPerCall) {
    throw new BbsError("bad_request", `at most ${tx.config.maxBlockersPerCall} blockers per call`);
  }
  const ids: number[] = [];
  for (const v of list) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) {
      throw new BbsError("bad_request", "blocked_by must be a list of task ids");
    }
    if (!ids.includes(v)) ids.push(v);
  }
  return ids;
}

/**
 * Add blockers to a task and move it to `blocked` if it is not already.
 * Shared by `task_block` and `task_update` with `state: blocked`.
 */
function block(tx: Tx, p: Params): { value: unknown; audit: ReturnType<ActionDef["run"]>["audit"]; notices: Notices } {
  const id = reqTaskId(p);
  const ids = reqBlockerIds(tx, p);
  const comment = optString(p, "comment", tx.config.maxTaskCommentLength) ?? "";
  const task = getTask(tx, id);
  requireUnfinished(task);
  requireActiveTopic(getTopic(tx, task.topic));
  requireManager(tx, task);
  const notices = new Notices(tx);
  const added: number[] = [];
  for (const b of ids) {
    if (b === id) throw new BbsError("bad_request", "a task cannot block itself");
    const blocker = tx.sql.one<TaskRow>("SELECT * FROM tasks WHERE id = ?", b);
    if (!blocker) throw new BbsError("not_found", `no task ${b} to block on`);
    if (FINISHED.includes(blocker.state)) {
      throw new BbsError("conflict", `task ${b} is ${blocker.state}; it cannot block anything`);
    }
    const exists = tx.sql.one(
      "SELECT 1 AS x FROM task_blocks WHERE task = ? AND blocked_by = ?",
      id,
      b,
    );
    if (exists) continue;
    if (reaches(tx, b, id)) {
      throw new BbsError("conflict", `task ${b} already waits on task ${id}; that would be a cycle`);
    }
    tx.sql.exec(
      "INSERT INTO task_blocks (task, blocked_by, created_by, created_at) VALUES (?, ?, ?, ?)",
      id,
      b,
      tx.actor.handle,
      tx.now,
    );
    added.push(b);
    notices.add(blocker.assignee, "assignee", "blocks_your_task", blocker, true, id);
  }
  const note = comment || `blocked by ${ids.map((b) => `task ${b}`).join(", ")}`;
  let after = task;
  if (task.state !== "blocked") {
    after = setState(tx, task, "blocked", tx.actor.handle, note, { prior: task.state });
  } else if (added.length > 0) {
    addComment(tx, id, tx.actor.handle, note, null);
    tx.sql.exec("UPDATE tasks SET updated_at = ? WHERE id = ?", tx.now, id);
  }
  return {
    value: { task: taskView(tx, after), added },
    audit: {
      targetType: "task",
      targetId: String(id),
      topic: task.topic,
      detail: {
        from: task.state,
        to: after.state,
        blocked_by: ids,
        added,
        notify: notices.summary(),
      },
    },
    notices,
  };
}

function taskView(tx: Tx, t: TaskRow): Record<string, unknown> {
  return {
    id: Number(t.id),
    topic: t.topic,
    title: t.title,
    description: t.description,
    state: t.state,
    prior_state: t.prior_state,
    stale: Number(t.is_stale) === 1,
    assignee: t.assignee,
    created_by: t.created_by,
    lease_expires_at: t.lease_expires_at === null ? null : Number(t.lease_expires_at),
    created_at: Number(t.created_at),
    updated_at: Number(t.updated_at),
    blocked_by: blockersOf(tx, Number(t.id)),
  };
}

function changed(
  tx: Tx,
  before: TaskRow,
  after: TaskRow,
  notices: Notices,
  extraValue: Record<string, unknown> = {},
  extraDetail: Record<string, unknown> = {},
): ReturnType<ActionDef["run"]> {
  return {
    value: { task: taskView(tx, after), ...extraValue },
    audit: {
      targetType: "task",
      targetId: String(after.id),
      topic: after.topic,
      detail: {
        from: before.state,
        to: after.state,
        ...extraDetail,
        notify: notices.summary(),
      },
    },
    notifications: notices.list,
  };
}

/** `bbs_task_create`: anyone in the topic creates an `open` task. */
export const taskCreate: ActionDef = {
  name: "task_create",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const topic = reqTopic(p);
    // A title is a short label shown in lists: no control, line-separator or
    // bidirectional characters (as handles and roles).
    const title = reqLabel(p, "title", tx.config.maxTaskTitleLength).trim();
    if (title === "") throw new BbsError("bad_request", "title is empty");
    const description = optString(p, "description", tx.config.maxTaskCommentLength) ?? "";
    if (topic === ADMIN_LOG) throw denied(`#${ADMIN_LOG} is written by the board only`);
    requireActiveTopic(getTopic(tx, topic));
    requireInTopic(tx, topic);
    const row = tx.sql.one<{ id: number }>(
      `INSERT INTO tasks (topic, title, description, state, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?) RETURNING id`,
      topic,
      title,
      description,
      tx.actor.handle,
      tx.now,
      tx.now,
    );
    if (!row) throw new BbsError("internal", "task insert returned no row");
    const task = getTask(tx, Number(row.id));
    return {
      value: { task: taskView(tx, task) },
      audit: {
        targetType: "task",
        targetId: String(task.id),
        topic,
        detail: { to: "open", title_length: title.length },
      },
    };
  },
};

/**
 * Taking a task someone else holds (B26, decided by Curtis 2026-11-21:
 * "Coordinator or person"): reassigning an `assigned`, `in_progress`,
 * `blocked` or `in_review` task held by another user needs a coordinator or
 * a person. An agent may assign an open task, hand on a task it holds
 * itself, or take one marked stale (its lease ran out, or its holder was
 * removed).
 */
function requireMayTake(tx: Tx, task: TaskRow): void {
  if (task.assignee === null || task.assignee === tx.actor.handle) return;
  if (tx.actor.kind === "human" || tx.actor.isCoordinator) return;
  if (Number(task.is_stale) === 1) return;
  throw denied(
    `task ${task.id} is held by ${task.assignee} (${task.state}); only a coordinator or a person ` +
      "can reassign it. An agent can assign an open task, hand on a task it holds, or take a " +
      "task whose lease has gone stale.",
  );
}

/**
 * `bbs_task_assign`: anyone in the topic (or any person) assigns an
 * unfinished task to a user in the topic; a task someone else holds only by
 * a coordinator or a person, unless it is stale (`requireMayTake`, B26). `open` and `in_progress` become
 * `assigned` (the new assignee starts it); a `blocked` task stays blocked and
 * will return to `assigned` (whether blocked from `open` or `in_progress`);
 * `in_review` stays in review. A previous assignee is told (`task_reassigned`).
 */
export const taskAssign: ActionDef = {
  name: "task_assign",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const id = reqTaskId(p);
    const assignee = resolveHandle(tx.sql, reqHandle(p, "assignee"));
    const task = getTask(tx, id);
    requireUnfinished(task);
    requireActiveTopic(getTopic(tx, task.topic));
    // A person is the authority (design §4) and may assign without being
    // subscribed; an agent must be in the topic. The assignee always must be.
    if (tx.actor.kind !== "human") requireInTopic(tx, task.topic);
    const user = tx.sql.one<{ handle: string; status: string; retired_at: number | null }>(
      "SELECT handle, status, retired_at FROM users WHERE handle = ?",
      assignee,
    );
    if (!user) throw new BbsError("not_found", `no user named ${assignee}`);
    if (user.status === "kicked") throw new BbsError("conflict", `${assignee} has been removed`);
    if (user.retired_at !== null) throw new BbsError("conflict", `${assignee} has been retired (no session for a long while)`);
    if (!inTopic(tx, user.handle, task.topic)) {
      throw new BbsError(
        "conflict",
        `${user.handle} is not in #${task.topic}; tasks go only to users in the topic`,
      );
    }
    if (task.assignee === user.handle) {
      throw new BbsError("conflict", `task ${id} is already assigned to ${user.handle}`);
    }
    requireMayTake(tx, task);
    const notices = new Notices(tx);
    const body = `assigned to ${user.handle}`;
    let after: TaskRow;
    if (task.state === "open" || task.state === "assigned" || task.state === "in_progress") {
      after = setState(tx, task, "assigned", tx.actor.handle, body, { assignee: user.handle });
    } else {
      // A blocked task returns to `assigned` (the new assignee starts it),
      // whether it was blocked from `open` or from `in_progress`.
      const prior =
        task.prior_state === "in_progress" || task.prior_state === "open"
          ? "assigned"
          : task.prior_state;
      tx.sql.exec(
        "UPDATE tasks SET assignee = ?, prior_state = ?, is_stale = 0, updated_at = ? WHERE id = ?",
        user.handle,
        prior,
        tx.now,
        id,
      );
      addComment(tx, id, tx.actor.handle, body, null);
      after = getTask(tx, id);
    }
    notices.add(user.handle, "assignee", "task_assigned", after, true);
    // The previous holder loses the task: tell them, always-wake (unless they
    // are the one reassigning it).
    notices.add(task.assignee, "assignee", "task_reassigned", after, true);
    return changed(tx, task, after, notices, {}, {
      assignee: user.handle,
      previous_assignee: task.assignee,
    });
  },
};

/** `bbs_task_claim`: a user in the topic takes an `open` task. */
export const taskClaim: ActionDef = {
  name: "task_claim",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const id = reqTaskId(p);
    const task = getTask(tx, id);
    requireActiveTopic(getTopic(tx, task.topic));
    if (task.state !== "open" || task.assignee !== null) {
      throw new BbsError(
        "conflict",
        `task ${id} is ${task.state}${task.assignee !== null ? ` (assigned to ${task.assignee})` : ""}; ` +
          "only an open, unassigned task can be claimed",
      );
    }
    if (tx.actor.kind !== "agent" && tx.actor.kind !== "human") {
      throw denied("only users can claim tasks");
    }
    requireInTopic(tx, task.topic);
    const after = setState(tx, task, "assigned", tx.actor.handle, `claimed by ${tx.actor.handle}`, {
      assignee: tx.actor.handle,
    });
    return changed(tx, task, after, new Notices(tx), {}, { assignee: tx.actor.handle });
  },
};

/**
 * The token a handle acts under: a session handle's parent, else the handle
 * itself (issue #98). Review is between credentials, not handles.
 */
function tokenOf(tx: Tx, handle: string | null | undefined): string | undefined {
  if (handle === null || handle === undefined) return undefined;
  const row = tx.sql.one<{ parent: string | null }>("SELECT parent FROM users WHERE handle = ?", handle);
  return row ? (row.parent ?? handle) : handle;
}

/**
 * Approving a review (issue #87, decided by Curtis 2026-11-25: "Anyone but
 * assignee"): `in_review -> done` is refused to an agent that is the task's
 * assignee or the agent that submitted it for review (the actor of its latest
 * `in_progress>in_review` move, read from the state-change comments), so
 * handing the task on cannot get round the rule. A coordinator agent gets no
 * exception. A past holder who did not submit it may approve. A person may
 * always approve, even their own task (decided by Curtis 2026-11-25: "a
 * person can close their own task, yes"). Compared by token (issue #98, the
 * coordinator's choice): two handles of one token, a token's own handle and
 * its session handles, count as one agent, so they cannot approve each
 * other's work.
 */
function requireNotOwnReview(tx: Tx, task: TaskRow): void {
  if (tx.actor.kind === "human") return;
  const me = tx.actor.parent ?? tx.actor.handle;
  const who = "Another agent, a coordinator or a person can move it to done.";
  if (tokenOf(tx, task.assignee) === me) {
    const holder = task.assignee === tx.actor.handle ? "yours" : "held by another handle of your token";
    throw denied(`task ${task.id} is ${holder} (${task.state}); you cannot approve your own review. ${who}`);
  }
  const submitter = tx.sql.one<{ author: string }>(
    `SELECT author FROM task_comments
     WHERE task = ? AND state_change = 'in_progress>in_review'
     ORDER BY id DESC LIMIT 1`,
    task.id,
  );
  if (tokenOf(tx, submitter?.author) === me) {
    const by = submitter?.author === tx.actor.handle ? "you" : "another handle of your token";
    throw denied(`${by} submitted task ${task.id} for review, so you cannot approve it. ${who}`);
  }
}

/**
 * `bbs_task_update`: change a task's state. `blocked` needs `blocked_by`
 * (as `bbs_task_block`). The assignee is told when someone else changes
 * their task (a comment on a task they hold, design §6).
 */
export const taskUpdate: ActionDef = {
  name: "task_update",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const to = optEnum<TaskState>(p, "state", TASK_STATES);
    if (to === undefined) {
      throw new BbsError("bad_request", `state is required (${TASK_STATES.join(", ")})`);
    }
    if (to === "blocked") {
      const r = block(tx, p);
      return { value: r.value, audit: r.audit, notifications: r.notices.list };
    }
    if (p.blocked_by !== undefined) {
      throw new BbsError("bad_request", "blocked_by goes only with state blocked");
    }
    const id = reqTaskId(p);
    const comment = optString(p, "comment", tx.config.maxTaskCommentLength) ?? "";
    const task = getTask(tx, id);
    requireUnfinished(task);
    requireActiveTopic(getTopic(tx, task.topic));
    requireManager(tx, task);
    if (to !== "cancelled" && !UPDATE_TRANSITIONS[task.state].includes(to)) {
      const hint =
        task.state === "blocked"
          ? "; a blocked task returns by itself when its blockers are done (or use bbs_task_unblock)"
          : to === "assigned" || task.state === "open"
            ? "; use bbs_task_assign or bbs_task_claim"
            : "";
      throw new BbsError("conflict", `task ${id} cannot go from ${task.state} to ${to}${hint}`);
    }
    if (to === "in_progress" && task.assignee === null) {
      throw new BbsError("conflict", `task ${id} has no assignee`);
    }
    if (to === "done") requireNotOwnReview(tx, task);
    const notices = new Notices(tx);
    const after = setState(tx, task, to, tx.actor.handle, comment, {
      prior: to === "cancelled" ? task.prior_state : null,
    });
    notices.add(after.assignee, "assignee", "task_comment", after, true);
    if (to === "done" || to === "cancelled") afterFinished(tx, after, notices);
    return changed(tx, task, after, notices);
  },
};

/** `bbs_task_comment`: anyone comments on a task; the assignee is told. */
export const taskComment: ActionDef = {
  name: "task_comment",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const id = reqTaskId(p);
    const body = reqString(p, "body", tx.config.maxTaskCommentLength);
    if (body.trim() === "") throw new BbsError("bad_request", "body is empty");
    const task = getTask(tx, id);
    requireActiveTopic(getTopic(tx, task.topic));
    const commentId = addComment(tx, id, tx.actor.handle, body, null);
    tx.sql.exec("UPDATE tasks SET updated_at = ? WHERE id = ?", tx.now, id);
    // The assignee commenting on their own stale task is back at work: the
    // stale mark clears and a fresh lease starts (its renewal alone does not
    // clear the mark, since an unaudited read must not change it).
    const clearedStale =
      Number(task.is_stale) === 1 &&
      task.state === "in_progress" &&
      task.assignee === tx.actor.handle;
    if (clearedStale) {
      const lease = tx.now + tx.config.taskLeaseMs;
      tx.sql.exec(
        "UPDATE tasks SET is_stale = 0, lease_expires_at = ? WHERE id = ?",
        lease,
        id,
      );
      armLease(tx, id, lease);
    }
    const notices = new Notices(tx);
    notices.add(task.assignee, "assignee", "task_comment", task, true);
    return {
      value: { task: Number(task.id), comment: commentId, cleared_stale: clearedStale },
      audit: {
        targetType: "task",
        targetId: String(id),
        topic: task.topic,
        detail: {
          comment: commentId,
          length: body.length,
          cleared_stale: clearedStale,
          notify: notices.summary(),
        },
      },
      notifications: notices.list,
    };
  },
};

/** `bbs_task_block`: add blockers; the task becomes `blocked`. */
export const taskBlock: ActionDef = {
  name: "task_block",
  kind: "change",
  run(tx, input) {
    const r = block(tx, asParams(input));
    return { value: r.value, audit: r.audit, notifications: r.notices.list };
  },
};

/**
 * `bbs_task_unblock`: remove one blocker. If the task is blocked and every
 * remaining blocker is done (or none is left), it returns to `prior_state`.
 */
export const taskUnblock: ActionDef = {
  name: "task_unblock",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const id = reqTaskId(p);
    const blocker = reqTaskId(p, "blocked_by");
    const comment = optString(p, "comment", tx.config.maxTaskCommentLength) ?? "";
    const task = getTask(tx, id);
    requireUnfinished(task);
    requireActiveTopic(getTopic(tx, task.topic));
    requireManager(tx, task);
    const removed = tx.sql.all(
      "DELETE FROM task_blocks WHERE task = ? AND blocked_by = ? RETURNING task",
      id,
      blocker,
    );
    if (removed.length === 0) {
      throw new BbsError("not_found", `task ${blocker} does not block task ${id}`);
    }
    const notices = new Notices(tx);
    const note = comment || `task ${blocker} no longer blocks this task`;
    if (task.state === "blocked" && allBlockersDone(tx, id)) {
      release(tx, task, tx.actor.handle, note, notices);
    } else {
      addComment(tx, id, tx.actor.handle, note, null);
      tx.sql.exec("UPDATE tasks SET updated_at = ? WHERE id = ?", tx.now, id);
    }
    return changed(tx, task, getTask(tx, id), notices, { removed: blocker }, { removed: blocker });
  },
};

/**
 * `bbs_task_list`: tasks, newest change first, filtered by topic, state,
 * assignee, staleness or readiness. With `task`, that one task and its comment log.
 */
export const taskList: ActionDef = {
  name: "task_list",
  kind: "read",
  run(tx, input) {
    const p = asParams(input);
    const one = optInt(p, "task", 1, MAX_TASK_ID);
    const limit =
      optInt(p, "limit", 1, tx.config.taskListMaxLimit) ?? tx.config.taskListDefaultLimit;
    if (one !== undefined) {
      const task = getTask(tx, one);
      // Comments are other users' words: each one leaves wrapped as peer
      // content with its author's kind (fixed at account creation), so a
      // reader can tell a person's comment from an agent's (design §11).
      const comments = tx.sql
        .all<{
          id: number;
          author: string;
          kind: string | null;
          body: string;
          state_change: string | null;
          created_at: number;
        }>(
          `SELECT c.id, c.author, u.kind, c.body, c.state_change, c.created_at
           FROM task_comments c LEFT JOIN users u ON u.handle = c.author
           WHERE c.task = ? ORDER BY c.id DESC LIMIT ?`,
          one,
          limit,
        )
        .reverse()
        .map((c) => ({
          peer_content: true as const,
          id: Number(c.id),
          author: c.author,
          kind: c.kind ?? "system",
          state_change: c.state_change,
          created_at: Number(c.created_at),
          body: c.body,
        }));
      const blocks = tx.sql
        .all<{ task: number }>("SELECT task FROM task_blocks WHERE blocked_by = ? ORDER BY task", one)
        .map((r) => Number(r.task));
      return {
        value: { tasks: [{ ...taskView(tx, task), blocks, comments }] },
        audit: { targetType: "task", targetId: String(one), topic: task.topic, detail: {} },
      };
    }
    const topic = optTopic(p);
    const state = optEnum<TaskState>(p, "state", TASK_STATES);
    const assignee = optString(p, "assignee", 64);
    const stale = optBool(p, "stale");
    const ready = optBool(p, "ready");
    if (ready === true && state !== undefined && state !== "open") {
      throw new BbsError("bad_request", "ready means open tasks; drop state or use state open");
    }
    // Column names are fixed strings; only values are bound.
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (topic !== undefined) {
      where.push("topic = ?");
      args.push(topic);
    }
    if (state !== undefined) {
      where.push("state = ?");
      args.push(state);
    }
    if (assignee !== undefined) {
      where.push("assignee = ?");
      args.push(foldHandle(assignee) === "me" ? tx.actor.handle : resolveHandle(tx.sql, assignee));
    }
    if (stale !== undefined) {
      where.push("is_stale = ?");
      args.push(stale ? 1 : 0);
    }
    if (ready === true) {
      // The rule that releases a blocked task: only a `done` blocker is finished (a cancelled one is not).
      where.push(
        `state = 'open' AND NOT EXISTS (
           SELECT 1 FROM task_blocks b JOIN tasks bt ON bt.id = b.blocked_by
           WHERE b.task = tasks.id AND bt.state <> 'done')`,
      );
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = tx.sql.all<TaskRow>(
      `SELECT * FROM tasks ${clause} ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ...args,
      limit,
    );
    return {
      value: { tasks: rows.map((t) => taskView(tx, t)) },
      audit: {
        targetType: "task",
        ...(topic !== undefined ? { topic } : {}),
        detail: { count: rows.length },
      },
    };
  },
};

/**
 * Renew the leases on the actor's `in_progress` tasks (design §8: any BBS
 * call from the assignee). Runs inside `act`'s transaction for every user
 * call, beside `last_seen`; the lease timer is not moved here (the lease
 * check moves it when it fires).
 */
export function renewLeases(tx: Pick<Tx, "sql" | "now" | "config">, handle: string): void {
  tx.sql.exec(
    "UPDATE tasks SET lease_expires_at = ? WHERE assignee = ? AND state = 'in_progress'",
    tx.now + tx.config.taskLeaseMs,
    handle,
  );
}

/**
 * The `lease` timer (system actor, run by `Board.runDueTimers`). Outcomes:
 * `not_running` (the task left `in_progress` or is already stale; timer
 * dropped), `extended` (the assignee renewed it; timer moved to the new
 * expiry), `stale` (marked stale; the assignee and the coordinator are
 * told; never reassigned).
 */
export const leaseCheck: ActionDef = {
  name: "lease_check",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const timerId = optInt(p, "timer", 1, MAX_TASK_ID) ?? 0;
    const timer = tx.sql.one<{ id: number; ref: string }>(
      "SELECT id, ref FROM timers WHERE id = ? AND kind = 'lease'",
      timerId,
    );
    if (!timer) throw new BbsError("not_found", `no lease timer ${timerId}`);
    const taskId = Number(timer.ref);
    const task = tx.sql.one<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
    const base = { targetType: "task", targetId: String(taskId) };
    if (!task || task.state !== "in_progress" || Number(task.is_stale) === 1) {
      tx.sql.exec("DELETE FROM timers WHERE id = ?", timerId);
      return {
        value: { outcome: "not_running" },
        audit: { ...base, ...(task ? { topic: task.topic } : {}), detail: { timer: timerId, outcome: "not_running" } },
      };
    }
    const expires = Number(task.lease_expires_at ?? 0);
    if (expires > tx.now) {
      tx.sql.exec("UPDATE timers SET due_at = ? WHERE id = ?", expires, timerId);
      return {
        value: { outcome: "extended" },
        audit: { ...base, topic: task.topic, detail: { timer: timerId, outcome: "extended", due_at: expires } },
      };
    }
    tx.sql.exec("UPDATE tasks SET is_stale = 1, updated_at = ? WHERE id = ?", tx.now, taskId);
    tx.sql.exec("DELETE FROM timers WHERE id = ?", timerId);
    const notices = new Notices(tx);
    notices.add(task.assignee, "assignee", "lease_stale", task, true);
    notices.coordinators("lease_stale", task, task.assignee);
    return {
      value: { outcome: "stale" },
      audit: {
        ...base,
        topic: task.topic,
        detail: {
          timer: timerId,
          outcome: "stale",
          assignee: task.assignee,
          lease_expired_at: expires,
          notify: notices.summary(),
        },
      },
      notifications: notices.list,
    };
  },
};
