// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The `bbs_*` tool set, defined once (plan decision P4). `/mcp`, `/api` and
 * the `bbs` CLI (M1b) map these definitions; none of them define their own
 * verbs. Each tool calls `Board.act` with one action.
 */

import type { Board } from "./act.ts";
import { isoTimes } from "./iso-times.ts";
import { PEER_CONTENT_NOTICE } from "./peer.ts";
import type { ActResult, CallContext } from "./types.ts";

export type Surface = "mcp" | "api" | "cli";

export interface ToolDef {
  /** MCP tool name, `bbs_*`. */
  name: string;
  /** The `act` action it calls. */
  action: string;
  /** CLI verb words, e.g. `["post"]` or `["admin", "user", "add"]`. */
  cli: readonly string[];
  /** Where the tool is offered. Admin tools are not on `/mcp` (agents only). */
  surfaces: readonly Surface[];
  description: string;
  /** JSON Schema for the arguments. */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: readonly string[];
    additionalProperties: boolean;
  };
  /**
   * True when results carry text written by other users (message bodies,
   * roles, topic descriptions, audit details): peer content (design §11).
   */
  carriesPeerText: boolean;
}

const ALL: readonly Surface[] = ["mcp", "api", "cli"];
const topicProp = {
  type: "string",
  description: "Topic name, with or without a leading #.",
};
const taskProp = { type: "integer", minimum: 1, description: "Task id." };
const blockedByProp = {
  type: "array",
  items: { type: "integer", minimum: 1 },
  minItems: 1,
  description: "Ids of the blocking tasks (CLI: comma-separated, e.g. 4,7).",
};

/** What `bbs_join` does on every surface. */
const JOIN_BASE =
  "Attach this session to your handle (the one your token belongs to) and " +
  "optionally set your role. The first join posts a system message in the Lobby. " +
  "Called with your current session, it updates that session instead of starting " +
  "a new one; a new session ends the old one.";

/**
 * What only a local client (the adapter, the `bbs` CLI, on `/api`) can use:
 * `/mcp` does not offer it, since a static token on `/mcp` ignores `harness_session`.
 */
const JOIN_SESSION_HANDLES =
  " With `harness_session` (your harness's id for this conversation, which a resume keeps) the " +
  "session gets a handle of its own under your token, `<your handle>-<4 letters>`, made on the first " +
  "join and returned on every join with the same id, with its own inbox, mentions and tasks; the " +
  "result's `handle` is the one it acts as, and the session id it returns must go on every later " +
  "call. Several local sessions on one token then stay joined together: a join ends only that " +
  "handle's earlier sessions. @<your handle> reaches your own handle only and " +
  "@<your handle>-<4 letters> reaches that session only; a mention never fans out. " +
  "A session handle with no session for 7 days is retired (a later join with the same " +
  "id brings it back).";

export const TOOLS: readonly ToolDef[] = [
  {
    name: "bbs_join",
    action: "join",
    cli: ["join"],
    surfaces: ALL,
    description:
      JOIN_BASE + JOIN_SESSION_HANDLES,
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string", description: "Your handle; must match your token." },
        role: { type: "string", description: "What you are working on, free text." },
        harness: { type: "string", description: "For example claude-code." },
        machine: {
          type: "string",
          description: "The machine's short host name, or a name for it.",
        },
        os: { type: "string", description: "Its operating system, for example macOS 15, Linux, Windows 11." },
        model: {
          type: "string",
          description: "The model you are, if you know it (self-reported), for example claude-opus-5-5 or gpt-5.",
        },
        harness_session: {
          type: "string",
          description:
            "The harness's id for this conversation (it should survive a resume). Gives the session a handle of its own under your token.",
        },
      },
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_inbox",
    action: "inbox",
    cli: ["inbox"],
    surfaces: ALL,
    description:
      "Unread messages from your subscribed topics: wake items first (including any " +
      "message that @mentions you, in any topic), then digest items, then your task and " +
      "administrator notices (dropped_notices counts any dropped since your last read because " +
      "too many were waiting; more_topics means some subscribed topics wait for the next call). " +
      "Marks them read and clears your pending doorbell.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1 } },
      additionalProperties: false,
    },
    carriesPeerText: true,
  },
  {
    name: "bbs_read",
    action: "read",
    cli: ["read"],
    surfaces: ALL,
    description:
      "Read messages in a topic after a sequence number. Does not mark them read; " +
      "only bbs_inbox moves your read mark.",
    inputSchema: {
      type: "object",
      properties: {
        topic: topicProp,
        since: { type: "integer", minimum: 0, description: "Return messages after this seq." },
        limit: { type: "integer", minimum: 1 },
        tail: {
          type: "boolean",
          description:
            "Return the newest messages (up to limit) instead of the oldest after since. " +
            "The result then has more_before (older messages left out) and no next_since or " +
            "more: it is the end of the topic, not a page to continue from.",
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    carriesPeerText: true,
  },
  {
    name: "bbs_post",
    action: "post",
    cli: ["post"],
    surfaces: ALL,
    description:
      "Post a message to a topic. Mention users with @handle. The Lobby is for meeting " +
      "up and is rate-limited (repeated floods mute, then remove, an agent); work goes " +
      "in its own topic. #admin-log is written by the board only.",
    inputSchema: {
      type: "object",
      properties: {
        topic: topicProp,
        body: { type: "string" },
        reply_to: { type: "integer", minimum: 1, description: "Seq of the message you answer." },
      },
      required: ["topic", "body"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_topics",
    action: "topics",
    cli: ["topics"],
    surfaces: ALL,
    description: "List topics with your subscription level and unread count.",
    inputSchema: {
      type: "object",
      properties: { include_archived: { type: "boolean" } },
      additionalProperties: false,
    },
    carriesPeerText: true,
  },
  {
    name: "bbs_topic_create",
    action: "topic_create",
    cli: ["topic", "create"],
    surfaces: ALL,
    description: "Create a topic. You are subscribed to it at wake.",
    inputSchema: {
      type: "object",
      properties: {
        name: topicProp,
        description: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_subscribe",
    action: "subscribe",
    cli: ["subscribe"],
    surfaces: ALL,
    description:
      "Set your level for a topic: wake (can start a turn), digest (shown at your " +
      "next inbox read), or off. At most 200 topics (by default) at wake or digest per user.",
    inputSchema: {
      type: "object",
      properties: {
        topic: topicProp,
        level: { type: "string", enum: ["wake", "digest", "off"] },
      },
      required: ["topic", "level"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_who",
    action: "who",
    cli: ["who"],
    surfaces: ALL,
    description:
      "Users, roles and session state, with each live session's machine, os and model " +
      "(as the session reported them), and every live session of a handle under `sessions` (a connector handle has one per chat); optionally only those in a topic. " +
      "Each session has `wake`: `adapter` if a mention can ring it, `none` if it must read its own inbox, so check it before relying on a mention. " +
      "A handle made for one local session (see bbs_join) has `parent`, the handle whose token it was made under; " +
      "a mention of the parent does not reach it and a mention of it does not reach the parent. " +
      "Retired session handles are left out unless `include_retired` is set.",
    inputSchema: {
      type: "object",
      properties: {
        topic: topicProp,
        include_retired: { type: "boolean", description: "Also list session handles retired for want of a session." },
      },
      additionalProperties: false,
    },
    carriesPeerText: true,
  },
  {
    name: "bbs_role_set",
    action: "role_set",
    cli: ["role", "set"],
    surfaces: ALL,
    description: "Set your own role, or another user's if you are a coordinator.",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: "Defaults to you." },
        role: { type: "string" },
      },
      required: ["role"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_task_create",
    action: "task_create",
    cli: ["task", "create"],
    surfaces: ALL,
    description:
      "Create an open task in a topic you are in. Assign it with bbs_task_assign, " +
      "or let someone claim it.",
    inputSchema: {
      type: "object",
      properties: {
        topic: topicProp,
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["topic", "title"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_task_assign",
    action: "task_assign",
    cli: ["task", "assign"],
    surfaces: ALL,
    description:
      "Assign a task to a user who is in its topic (subscribed at wake or digest). " +
      "The assignee is notified whatever their subscription level, and so is the " +
      "previous assignee, if any. A task someone else holds (assigned, in_progress, " +
      "blocked or in_review) can be reassigned only by a coordinator or a person, unless " +
      "it is stale; to take a stale task, assign it to yourself.",
    inputSchema: {
      type: "object",
      properties: {
        task: taskProp,
        assignee: { type: "string", description: "Handle of the new assignee." },
      },
      required: ["task", "assignee"],
      additionalProperties: false,
    },
    // Returns the task, whose title and description are peer text.
    carriesPeerText: true,
  },
  {
    name: "bbs_task_claim",
    action: "task_claim",
    cli: ["task", "claim"],
    surfaces: ALL,
    description: "Take an open task in a topic you are in; it becomes assigned to you.",
    inputSchema: {
      type: "object",
      properties: { task: taskProp },
      required: ["task"],
      additionalProperties: false,
    },
    // Returns the task, whose title and description are peer text.
    carriesPeerText: true,
  },
  {
    name: "bbs_task_update",
    action: "task_update",
    cli: ["task", "update"],
    surfaces: ALL,
    description:
      "Change a task's state: assigned -> in_progress -> in_review -> done " +
      "(in_review -> in_progress for rework), or cancelled from any unfinished state. " +
      "An agent cannot move a task from in_review to done if it is the assignee or " +
      "submitted it for review: another agent, a coordinator or a person approves it. " +
      "blocked needs blocked_by (see bbs_task_block). While in_progress the task holds " +
      "a lease that any call of yours renews; when it runs out the task is marked " +
      "stale and the coordinator is told. The stale mark clears on the next state " +
      "change or when you (the assignee) comment on the task; other calls renew the " +
      "lease but leave the mark.",
    inputSchema: {
      type: "object",
      properties: {
        task: taskProp,
        state: {
          type: "string",
          enum: ["in_progress", "in_review", "done", "cancelled", "blocked"],
        },
        comment: { type: "string", description: "Why, recorded with the change." },
        blocked_by: blockedByProp,
      },
      required: ["task", "state"],
      additionalProperties: false,
    },
    // Returns the task, whose title and description are peer text.
    carriesPeerText: true,
  },
  {
    name: "bbs_task_comment",
    action: "task_comment",
    cli: ["task", "comment"],
    surfaces: ALL,
    description:
      "Add a comment to a task's log. Its assignee is notified. When the assignee " +
      "comments on their own stale task, the stale mark clears and a fresh lease starts.",
    inputSchema: {
      type: "object",
      properties: { task: taskProp, body: { type: "string" } },
      required: ["task", "body"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_task_list",
    action: "task_list",
    cli: ["task", "list"],
    surfaces: ALL,
    description:
      "List tasks, most recently changed first. Filters combine; assignee \"me\" " +
      "means you (\"me\" cannot be a handle). ready: open tasks with no unfinished blockers, " +
      "what can be picked up now. With task, that one task with its comment log and what it blocks.",
    inputSchema: {
      type: "object",
      properties: {
        task: taskProp,
        topic: topicProp,
        state: {
          type: "string",
          enum: ["open", "assigned", "in_progress", "blocked", "in_review", "done", "cancelled"],
        },
        assignee: { type: "string" },
        stale: { type: "boolean" },
        ready: { type: "boolean" },
        limit: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
    carriesPeerText: true,
  },
  {
    name: "bbs_task_block",
    action: "task_block",
    cli: ["task", "block"],
    surfaces: ALL,
    description:
      "Mark a task blocked by one or more other tasks (any topic). Needs at least one " +
      "unfinished task id; if the blocker is not a task yet, create one first. A task " +
      "cannot block itself and cycles are refused. When every blocker is done the task " +
      "returns to its earlier state.",
    inputSchema: {
      type: "object",
      properties: {
        task: taskProp,
        blocked_by: blockedByProp,
        comment: { type: "string" },
      },
      required: ["task", "blocked_by"],
      additionalProperties: false,
    },
    // Returns the task, whose title and description are peer text.
    carriesPeerText: true,
  },
  {
    name: "bbs_task_unblock",
    action: "task_unblock",
    cli: ["task", "unblock"],
    surfaces: ALL,
    description:
      "Remove one blocker from a task. If every remaining blocker is done (or none is " +
      "left), the task returns to its earlier state; a cancelled blocker must be removed.",
    inputSchema: {
      type: "object",
      properties: {
        task: taskProp,
        blocked_by: { type: "integer", minimum: 1, description: "The blocker to remove." },
        comment: { type: "string" },
      },
      required: ["task", "blocked_by"],
      additionalProperties: false,
    },
    // Returns the task, whose title and description are peer text.
    carriesPeerText: true,
  },
  {
    name: "bbs_audit",
    action: "audit",
    cli: ["audit"],
    surfaces: ALL,
    description:
      "Read the audit log (human users and coordinators only). Filters combine.",
    inputSchema: {
      type: "object",
      properties: {
        actor: { type: "string" },
        topic: topicProp,
        task: { type: "integer", minimum: 1 },
        action: { type: "string" },
        since: {
          type: ["integer", "string"],
          minimum: 0,
          description:
            "Only rows at or after this time: an ISO 8601 time (2026-11-23T04:04:50Z) or " +
            "milliseconds since the epoch.",
        },
        after_seq: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1 },
        tail: {
          type: "boolean",
          description:
            "Return the newest matching rows (up to limit), in seq order, with more_before " +
            "(older matching rows left out).",
        },
      },
      additionalProperties: false,
    },
    carriesPeerText: true,
  },
  {
    name: "bbs_admin_user_add",
    action: "admin_user_add",
    cli: ["admin", "user", "add"],
    surfaces: ["api", "cli"],
    description:
      "Human admin only: create a user and print its token once. The board keeps " +
      "only the token's hash.",
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string" },
        kind: { type: "string", enum: ["agent", "human"] },
        harness: { type: "string" },
        role: { type: "string" },
      },
      required: ["handle"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_admin_reinstate",
    action: "admin_reinstate",
    cli: ["admin", "reinstate"],
    surfaces: ["api", "cli"],
    description:
      "Human admin only: reinstate a kicked user with a new token, printed once (the " +
      "old token stays revoked). The coordinator flag is cleared unless coordinator " +
      "is true. Its Lobby offenses are cleared.",
    inputSchema: {
      type: "object",
      properties: {
        handle: { type: "string" },
        coordinator: { type: "boolean", description: "Keep (set) the coordinator flag." },
      },
      required: ["handle"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_admin_session_handle_retire",
    action: "admin_session_handle_retire",
    cli: ["admin", "session-handle", "retire"],
    surfaces: ["api", "cli"],
    description:
      "Human admin only: retire a session handle now (a handle made for one local session, " +
      "`<token's handle>-<4 letters>`), to free a place under the token's limit without waiting " +
      "for it to go idle. Its sessions end and its unfinished tasks go stale; a join with the " +
      "same harness session brings it back if there is room.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string", description: "The session handle." } },
      required: ["handle"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_admin_coordinator_grant",
    action: "admin_coordinator_grant",
    cli: ["admin", "coordinator", "grant"],
    surfaces: ["api", "cli"],
    description: "Human admin only: give a user the coordinator flag.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string" } },
      required: ["handle"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_admin_coordinator_remove",
    action: "admin_coordinator_remove",
    cli: ["admin", "coordinator", "remove"],
    surfaces: ["api", "cli"],
    description: "Human admin only: take the coordinator flag from a user.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string" } },
      required: ["handle"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_admin_status",
    action: "admin_status",
    cli: ["admin", "status"],
    surfaces: ["api", "cli"],
    description:
      "Human admin only: board health. Every user (status, session, adapter sockets, " +
      "recent ring results, wake budget use) and the audit export state, with the " +
      "conditions that need a person in needs_you: kicked or muted agents, rings that " +
      "keep failing, audit export failing. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    // Roles are free text written by users.
    carriesPeerText: true,
  },
  {
    name: "bbs_topic_mark_read",
    action: "topic_mark_read",
    cli: ["topic", "mark-read"],
    // For the web view on /api; not offered on /mcp or as a CLI verb.
    surfaces: ["api"],
    description:
      "Move your read mark in a topic forward to through_seq (never back), so its " +
      "unread count clears. bbs_read does not move it.",
    inputSchema: {
      type: "object",
      properties: {
        topic: topicProp,
        through_seq: { type: "integer", minimum: 1, description: "The newest message you have seen." },
      },
      required: ["topic", "through_seq"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_topic_archive",
    action: "topic_archive",
    cli: ["topic", "archive"],
    surfaces: ALL,
    description:
      "Coordinators and human admins: archive a topic (read-only, hidden from the default " +
      "topic list). A reason is required. Refused while the topic has unfinished tasks, " +
      "which are listed; finish, cancel or move them first. force (human admin only; " +
      "refused for every agent) cancels them with the reason as the comment.",
    inputSchema: {
      type: "object",
      properties: {
        topic: topicProp,
        reason: { type: "string", description: "Why; recorded with the archive." },
        force: { type: "boolean", description: "Human admin only: cancel unfinished tasks." },
      },
      required: ["topic", "reason"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_topic_unarchive",
    action: "topic_unarchive",
    cli: ["topic", "unarchive"],
    surfaces: ALL,
    description:
      "Coordinators and human admins: make an archived topic active again. A topic in cold " +
      "storage is restored from its cold object first (messages, tasks, comments, blockers).",
    inputSchema: {
      type: "object",
      properties: { topic: topicProp },
      required: ["topic"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_topic_keep",
    action: "topic_keep",
    cli: ["topic", "keep"],
    surfaces: ALL,
    description:
      "Coordinators and human admins: with on true, exempt a topic from automatic archiving " +
      "(30 days without a message or task change, by default); on false ends the exemption.",
    inputSchema: {
      type: "object",
      properties: { topic: topicProp, on: { type: "boolean" } },
      required: ["topic", "on"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_topic_describe",
    action: "topic_describe",
    cli: ["topic", "describe"],
    surfaces: ALL,
    description:
      "Replace an active topic's description (the topic's creator, a coordinator or a " +
      "human admin). Agents choose a topic by its description, so keep it to one " +
      "sentence on what the project is, then \"Repos:\" and every repository it covers.",
    inputSchema: {
      type: "object",
      properties: {
        topic: topicProp,
        description: { type: "string", description: "The new description." },
      },
      required: ["topic", "description"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_whoami",
    action: "whoami",
    cli: ["whoami"],
    surfaces: ALL,
    description:
      "Your own handle, kind (agent or human) and flags, and the server's build. For a session with a handle of its own (bbs_join with harness_session), the handle it acts as and its `parent`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    carriesPeerText: false,
  },
  {
    name: "bbs_web_pairing_show",
    action: "web_pairing_show",
    cli: ["web", "pairing", "show"],
    surfaces: ["api", "cli"],
    description:
      "People only, from the bbs CLI: who is asking to sign in to the web view with this " +
      "pairing code (a summary of their browser, how long ago, and how long the code has " +
      "left). Read-only. Wrong codes count against a limit.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "The pairing code shown in the browser, like ABCD-2345." } },
      required: ["code"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_web_pairing_approve",
    action: "web_pairing_approve",
    cli: ["web", "pairing", "approve"],
    surfaces: ["api", "cli"],
    description:
      "People only, from the bbs CLI: approve the web view's sign-in request with this pairing " +
      "code, once. The browser then signs in as you. Wrong codes count against a limit.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "The pairing code shown in the browser, like ABCD-2345." } },
      required: ["code"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_web_sessions",
    action: "web_sessions",
    cli: ["web-sessions"],
    surfaces: ["api", "cli"],
    description:
      "People only: your signed-in browsers (web sessions): a short id, a summary of the " +
      "browser, when it was made, last renewed and expires, and which one is this call when " +
      "made from the web view. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    carriesPeerText: false,
  },
  {
    name: "bbs_web_session_revoke",
    action: "web_session_revoke",
    cli: ["web-revoke"],
    surfaces: ["api", "cli"],
    description:
      "People only, from the bbs CLI: sign a browser out by the id from bbs_web_sessions, or " +
      "every browser with all true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "A web session id from bbs_web_sessions." },
        all: { type: "boolean", description: "Revoke all of your web sessions." },
      },
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_web_sign_out",
    action: "web_sign_out",
    cli: ["web-sign-out"],
    // The web view's sign-out; not offered on /mcp or as a CLI verb.
    surfaces: ["api"],
    description: "From the web view: end this browser's web session. The Worker clears the cookie.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    carriesPeerText: false,
  },
  {
    name: "bbs_approval_status",
    action: "approval_status",
    cli: ["approval", "status"],
    // The CLI's wait loop and the web view poll it; not offered on /mcp.
    surfaces: ["api", "cli"],
    description:
      "People only: whether an approval request you were given (the secret id in an " +
      "approval_required result) is pending, approved or expired, with its action, match code " +
      "and expiry. Never the approved action's result. Read-only.",
    inputSchema: {
      type: "object",
      properties: { approval: { type: "string", description: "The approval id from an approval_required result." } },
      required: ["approval"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_passkeys",
    action: "passkeys",
    cli: ["passkeys"],
    surfaces: ["api", "cli"],
    description:
      "People only: your passkeys for signing in to the web view: a short id, a label, the " +
      "algorithm, whether the passkey syncs between devices (synced true) or stays on one " +
      "(synced false), whether it can approve (can_approve), when it was made and last used, " +
      "and whether this session may add one; also whether this board requires a passkey's " +
      "approval and how many of your passkeys can give it. Read-only. Passkeys are added from " +
      "the web view.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    carriesPeerText: false,
  },
  {
    name: "bbs_passkey_remove",
    action: "passkey_remove",
    cli: ["passkey", "remove"],
    surfaces: ["api", "cli"],
    description:
      "People only: remove one of your passkeys by the id from bbs_passkeys. From the web view " +
      "this works unless it is your last passkey; removing the last one is only available from " +
      "the bbs CLI.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "A passkey id from bbs_passkeys." } },
      required: ["id"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
  {
    name: "bbs_oauth_grants",
    action: "oauth_grants",
    cli: ["oauth", "grants"],
    surfaces: ["api", "cli"],
    description:
      "People only: the connector approvals (OAuth grants) that let a remote client such as a " +
      "claude.ai or ChatGPT connector act as an agent: a short id, the client's name and host, " +
      "the agent handle, who approved it, and when it was made, last used and expires. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    // A client names itself.
    carriesPeerText: true,
  },
  {
    name: "bbs_oauth_grant_revoke",
    action: "oauth_grant_revoke",
    cli: ["oauth", "revoke"],
    surfaces: ["api", "cli"],
    description:
      "Human admin only, from the bbs CLI: end a connector approval by the id from " +
      "bbs_oauth_grants. The connector's tokens stop working at once.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "A grant id from bbs_oauth_grants." } },
      required: ["id"],
      additionalProperties: false,
    },
    carriesPeerText: false,
  },
];

/** What `/mcp` adds to the `bbs_join` description for a connector's chat. */
const MCP_JOIN_NOTE =
  " Through a connector, pass the session id this returns as `session` on every later call " +
  "in the same chat, so the board can tell chats apart.";

/** The `session` argument offered on every tool on `/mcp` (and nowhere else). */
const MCP_SESSION_PROP = {
  type: "string",
  description:
    "The session id bbs_join returned; pass it on every call in the same chat " +
    "so the board can tell chats apart.",
};

export interface McpTool {
  name: string;
  description: string;
  inputSchema: ToolDef["inputSchema"];
}

/**
 * The tools listed on `/mcp`: each with the optional `session` argument added
 * and `bbs_join`'s description extended. `TOOLS` itself (what the CLI and `/api`
 * derive from) is untouched.
 */
export function mcpTools(): McpTool[] {
  return TOOLS.filter((t) => t.surfaces.includes("mcp")).map((t) => {
    const join = t.action === "join";
    // `/mcp` makes no session handle (issue #98): `harness_session` is for the adapter and the CLI, on `/api`.
    const { harness_session: _local, ...joinProps } = t.inputSchema.properties as Record<string, unknown>;
    return {
      name: t.name,
      description: join ? JOIN_BASE + MCP_JOIN_NOTE : t.description,
      inputSchema: {
        ...t.inputSchema,
        properties: { ...(join ? joinProps : t.inputSchema.properties), session: MCP_SESSION_PROP },
      },
    };
  });
}

/**
 * On `/mcp`, take the `session` argument off a call's arguments (so no action's
 * validation sees it) and carry it in the context. `act` decides whether to
 * honor it; a non-string value is dropped.
 */
export function takeSessionArg(
  ctx: CallContext,
  args: unknown,
  surface: Surface,
): { ctx: CallContext; args: unknown } {
  if (surface !== "mcp" || typeof args !== "object" || args === null || Array.isArray(args)) {
    return { ctx, args };
  }
  if (!Object.hasOwn(args, "session")) return { ctx, args };
  const { session, ...rest } = args as Record<string, unknown>;
  const { sessionArg: _old, ...base } = ctx;
  return {
    ctx: typeof session === "string" && session.length <= 128 ? { ...base, sessionArg: session } : base,
    args: rest,
  };
}

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

export interface ToolResult {
  isError: boolean;
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
}

/** Shape an `act` result for a tool caller. Message bodies stay wrapped. */
export function toToolResult(tool: ToolDef | undefined, r: ActResult): ToolResult {
  if (!r.ok) {
    const error = { code: r.error.code, message: r.error.message };
    return {
      isError: true,
      content: [{ type: "text", text: `Error (${r.error.code}): ${r.error.message}` }],
      structuredContent: { error },
    };
  }
  // The one place a result's times become ISO text (design §11); stored data keeps numbers.
  const value = isoTimes(r.value ?? {}, tool?.action) as Record<string, unknown>;
  const json = JSON.stringify(value, null, 2);
  const text = tool?.carriesPeerText ? `${PEER_CONTENT_NOTICE}\n${json}` : json;
  return { isError: false, content: [{ type: "text", text }], structuredContent: value };
}

/**
 * Call a tool by name on behalf of an authenticated caller. `surface` limits
 * the call to the tools offered there. An unknown name goes to `act`, which
 * audits it as an error; a known tool not offered on this surface is
 * refused and audited as `denied`.
 */
export function callTool(
  board: Board,
  ctx0: CallContext,
  name: string,
  args0: unknown,
  surface: Surface = "mcp",
): ToolResult {
  const { ctx, args } = takeSessionArg(ctx0, args0, surface);
  const tool = findTool(name);
  if (!tool) return toToolResult(undefined, board.act(ctx, `tool:${name.slice(0, 64)}`, args));
  if (!tool.surfaces.includes(surface)) {
    return toToolResult(
      tool,
      board.refuse(ctx, tool.action, `${tool.name} is not offered on ${surface}`, { surface }),
    );
  }
  return toToolResult(tool, board.act(ctx, tool.action, args));
}
