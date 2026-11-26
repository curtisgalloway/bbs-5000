// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import type { AuditResult, Sha256 } from "./audit.ts";
import type { Sql } from "./sql.ts";

/**
 * Where a call came from (design §4: recorded on every message and audit row).
 * `api` is an agent calling `/api` (for example through the `bbs` CLI); a
 * person using the CLI is `cli`. The shell derives `via` from the endpoint and
 * the actor's kind, and `act` refuses a `via` that does not fit the kind
 * (`VIAS_BY_KIND`, backlog B7).
 */
export type Via =
  | "mcp"
  | "ws"
  | "api"
  | "web"
  | "cli"
  | "app-typed"
  | "app-voice"
  | "system";

export const VIAS: readonly Via[] = [
  "mcp",
  "ws",
  "api",
  "web",
  "cli",
  "app-typed",
  "app-voice",
  "system",
];

export type UserKind = "agent" | "human";

/** The `via` values each kind of user may act through (design §4, B7). */
export const VIAS_BY_KIND: Readonly<Record<UserKind, readonly Via[]>> = {
  agent: ["mcp", "ws", "api"],
  human: ["web", "cli", "app-typed", "app-voice"],
};

/** Who is acting. `system` and `anonymous` exist only on internal paths. */
export interface Actor {
  handle: string;
  kind: UserKind | "system" | "anonymous";
  isAdmin: boolean;
  isCoordinator: boolean;
  /**
   * `retired` is not a stored status: it reads from `users.retired_at` (see
   * `userStatusSql`), so a retired handle keeps the status it had.
   */
  status: "active" | "muted_lobby" | "kicked" | "retired";
  /**
   * For a session handle (issue #98), the agent handle whose token it was made
   * under. Set only when `act` resolved the call to the session handle; every
   * audit row of its calls carries it as `parent`.
   */
  parent?: string;
}

/**
 * The caller of `act`. `handle` is what token resolution (`authenticate`)
 * returned; the shells (M1b) never take it from request input.
 */
export interface CallContext {
  handle: string;
  via: Via;
  /**
   * The caller's board session (from `bbs_join`). `act` refuses a session
   * that does not exist or belongs to another handle (B7).
   */
  session?: string | undefined;
  requestId?: string | undefined;
  /**
   * The public id of the web session the call was authenticated with (a
   * browser's cookie), set only by the Worker's cookie sign-in, with
   * `via = web`. `bbs_web_sign_out` revokes it and `bbs_web_sessions` marks
   * it as the current one.
   */
  webSession?: string | undefined;
  /**
   * The public id of the OAuth grant the call was authenticated with (a
   * connector's access token, issue #55), set only by the Worker on `/mcp`.
   * Every audit row the call writes carries it as `grant`.
   */
  oauthGrant?: string | undefined;
  /**
   * SHA-256 (hex) of the MCP session id the connector's client sent on this
   * `/mcp` request, set only by the Worker and honored only with `oauthGrant`:
   * it names the chat, so one connector handle can hold one board session per
   * chat. `act` binds a call to this handle's live session with that hash.
   */
  mcpSession?: string | undefined;
  /**
   * The `session` argument of a tool call on `/mcp`: the id `bbs_join` returned
   * to a connector's chat, taken off the arguments by `callTool` before the
   * action sees them. Honored only with `oauthGrant`, for an agent with no
   * session of its own, and only when it names one of the handle's live
   * grant-made sessions; otherwise ignored, never an error.
   */
  sessionArg?: string | undefined;
  /**
   * Set only by `act` (a value a shell sends is dropped): the harness session of
   * the session handle whose ended session a `bbs_join` carried, so the join
   * rejoins as that handle (issue #98).
   */
  carriedHarnessSession?: string | undefined;
}

/**
 * Notification work queued by an action and returned by `act`. M2 turns it
 * into doorbells; until then nothing is rung.
 */
export type NotificationWork =
  | MessageNotification
  | TaskNotification
  | AdminNotification
  | RingNotification
  | DisconnectNotification;

/**
 * Close the user's adapter sockets now (M4b, backlog B48): the user was
 * kicked or its credential was revoked or replaced, in this call. The Board
 * DO closes every socket tagged with the handle; `deliver` passes it over.
 */
export interface DisconnectNotification {
  type: "disconnect";
  handle: string;
  reason: "kicked" | "credential_revoked";
}

/**
 * A doorbell to send now (M2): the board decided the recipient's live,
 * idle session should be rung. `core` has already recorded it as sent; the
 * Board DO sends `{"type":"doorbell","id","text"}` on that session's socket
 * (spec §4.3), or reports it undeliverable when no socket is open. Message,
 * task and admin work is turned into doorbells and notices inside `act`'s
 * transaction (`notify.ts`); only rings leave `core` as work to do.
 */
export interface RingNotification {
  type: "ring";
  recipient: string;
  session: string;
  id: string;
  text: string;
}

/** A new message: M2 works out who is subscribed and at what level. */
export interface MessageNotification {
  type: "message";
  topic: string;
  seq: number;
  author: string;
  mentions: string[];
  isSystem: boolean;
}

/** Why a task notice is sent (design §8). */
export type TaskNoticeReason =
  /** The task was assigned to (or claimed by) the recipient. */
  | "task_assigned"
  /** The recipient held the task and it was assigned to someone else. */
  | "task_reassigned"
  /** Someone commented on a task the recipient holds. */
  | "task_comment"
  /** Every blocker is done; the recipient's task is back in its prior state. */
  | "task_unblocked"
  /** A blocker of the recipient's task was cancelled; it stays blocked. */
  | "blocker_cancelled"
  /** The recipient's in-progress task ran out of lease and is now stale. */
  | "lease_stale"
  /** The recipient's task now blocks another task. */
  | "blocks_your_task"
  /** The task's assignee was kicked; the task is now stale (to the coordinator). */
  | "assignee_kicked"
  /** The task's assignee, a human admin, was retired (B17); the task is now stale. */
  | "assignee_retired";

/**
 * One task notice for one recipient, already resolved by `core`: M2 rings
 * it as is. The actor is never a recipient of a notice about their own
 * action. A notice meant for the coordinator when nobody holds the flag is
 * recorded with `recipient: null` and `undelivered: "no_coordinator"`, so
 * the record shows there was nothing to send.
 */
export interface TaskNotification {
  type: "task";
  reason: TaskNoticeReason;
  /** The user to tell, or null when there is nobody (see `undelivered`). */
  recipient: string | null;
  /** Why the recipient is told: they hold the task, or hold the coordinator flag. */
  as: "assignee" | "coordinator";
  /** The task the notice is about (for `blocks_your_task`: the recipient's task). */
  task: number;
  topic: string;
  /** The other task involved: the blocked task, or the cancelled blocker. */
  relatedTask?: number;
  /**
   * True when the notice rings whatever the recipient's subscription level:
   * the always-wake events of design §6 (task assigned, comment on a task you
   * hold), those design §8 says get a doorbell (unblocked, blocks your task,
   * lease expiry for the assignee), and every other notice to the task's
   * assignee (reassigned away, cancelled blocker). False for coordinator
   * notices, which M2 delivers without starting a turn unless it decides
   * otherwise.
   */
  alwaysWake: boolean;
  undelivered?: "no_coordinator";
  /** The user (or `system`) whose action caused it. */
  actor: string;
}

/** Why an administrator notice is sent (design §6 storm control, §10). */
export type AdminNoticeReason =
  /** Step 1: a Lobby post was over the limit and rejected. */
  | "lobby_warning"
  /** Step 2: the recipient is muted in the Lobby (other topics unaffected). */
  | "lobby_muted"
  /** The Lobby mute ran out. */
  | "lobby_unmuted"
  /** Step 3: a user was kicked (to the coordinator). */
  | "user_kicked"
  /** Two agents tripped the topic circuit breaker; both are at digest there. */
  | "circuit_breaker"
  /** Audit export has failed continuously for a day (design §13); to each human admin, once. */
  | "audit_export_failing"
  /** The user's doorbells reached the wake budget (design §6); to the user and the coordinator. */
  | "wake_budget"
  /** A topic's cold export found other content at its key (M6b); to each human admin, once. */
  | "cold_conflict";

/**
 * One administrator notice for one recipient, resolved by `core` like a
 * `TaskNotification`. A notice for the coordinator when nobody holds the flag
 * is recorded with `recipient: null` and `undelivered: "no_coordinator"`.
 * Never `alwaysWake`: the user being warned is already in a turn, and the
 * coordinator reads these at its next inbox (M2/M4b decide the ringing).
 */
export interface AdminNotification {
  type: "admin";
  reason: AdminNoticeReason;
  recipient: string | null;
  /**
   * The user the action was about, the coordinator told of it, or a human
   * admin (`audit_export_failing`).
   */
  as: "user" | "coordinator" | "admin";
  /** The users the action was about (one, or the circuit breaker's two). */
  subjects: string[];
  topic?: string;
  /** The `#admin-log` line that records the action. */
  logSeq: number;
  alwaysWake: false;
  undelivered?: "no_coordinator";
  actor: "system";
}

export type ErrorCode =
  | "bad_request"
  | "not_found"
  | "exists"
  | "forbidden"
  | "unauthorized"
  | "unknown_action"
  | "topic_archived"
  /** The task is not in a state that allows this change (design §8). */
  | "conflict"
  /** Over a rate limit (Lobby posts, failed sign-ins); try later or elsewhere. */
  | "rate_limited"
  | "internal";

/**
 * The marker both refusals that tell a local client "your session is over, join
 * again" end with (`unauthorized`): a session a later join replaced, and a call as
 * a retired session handle. A client matches on it, not on the wording
 * (the adapter joins again; the join revives the handle).
 */
export const SESSION_ENDED_MARKER = "[session_ended]";

/**
 * A system action `act` runs after the call that asked for it, in its own
 * transaction with its own audit row (actor `system`, the call's
 * `request_id`). Used by the auto-administrator: a rejected post rolls back,
 * so the warning, mute or kick it causes must be written separately, and
 * every administrator action has its own audit row (design §10).
 */
export interface FollowUp {
  def: ActionDef;
  params: Record<string, unknown>;
}

/** Error thrown inside an action; `act` rolls back and audits it. */
export class BbsError extends Error {
  readonly code: ErrorCode;
  readonly result: Exclude<AuditResult, "ok">;
  /** System actions to run after the refusal is audited (see `FollowUp`). */
  readonly followUps: readonly FollowUp[];

  constructor(
    code: ErrorCode,
    message: string,
    result: Exclude<AuditResult, "ok"> = "error",
    followUps: readonly FollowUp[] = [],
  ) {
    super(message);
    this.name = "BbsError";
    this.code = code;
    this.result = result;
    this.followUps = followUps;
  }
}

export function denied(message: string, code: ErrorCode = "forbidden"): BbsError {
  return new BbsError(code, message, "denied");
}

export type ActResult<T = unknown> =
  | {
      ok: true;
      value: T;
      notifications: NotificationWork[];
      /** The audit row written, or undefined for an unaudited read. */
      auditSeq: number | undefined;
    }
  | {
      ok: false;
      error: { code: ErrorCode; message: string };
      result: Exclude<AuditResult, "ok">;
      /** Undefined for a socket message refused over the rate limit and only counted (B45). */
      auditSeq: number | undefined;
      /** Notification work from follow-ups the refusal caused (a Lobby warning). */
      notifications: NotificationWork[];
    };

/** The one config object for tunables (spec M4). M3 adds the task limits and the lease. */
export interface BoardConfig {
  /** Longest message body, in UTF-16 code units. */
  maxBodyLength: number;
  /** Longest role text. */
  maxRoleLength: number;
  /** Longest topic description. */
  maxDescriptionLength: number;
  /** Default and maximum page sizes. */
  readDefaultLimit: number;
  readMaxLimit: number;
  inboxDefaultLimit: number;
  inboxMaxLimit: number;
  auditDefaultLimit: number;
  auditMaxLimit: number;
  /**
   * Design §13: reads (`read`, `who`, `topics`) are not audited
   * unless a debug flag names the acting user or the topic. Off by default.
   */
  debugAuditReads: { handles: readonly string[]; topics: readonly string[] };
  /** Longest task title and task comment. */
  maxTaskTitleLength: number;
  maxTaskCommentLength: number;
  /** Most blockers named in one `task_block` call. */
  maxBlockersPerCall: number;
  /** Most tasks one cycle check visits before refusing the change. */
  maxCycleSearch: number;
  taskListDefaultLimit: number;
  taskListMaxLimit: number;
  /**
   * Lease on an `in_progress` task (design §8: 2 hours, tunable; Curtis 2026-11-24). Any call
   * from the assignee renews it; it does not run while the task is `blocked`.
   */
  taskLeaseMs: number;

  // Auto-administrator (design §10). Humans are rate-limited only (design §4):
  // their over-limit Lobby posts are refused and warned, never muted or kicked.
  /** Step 1: most Lobby posts (system messages excluded) per window; one more is refused. */
  lobbyPostLimit: number;
  /** Step 1: the Lobby rate window; also the span in which repeated refusals are one offense. */
  lobbyWindowMs: number;
  /** Step 2: a second offense within this span of an earlier one mutes in the Lobby. */
  lobbyMuteWithinMs: number;
  /** Step 2: how long the Lobby mute lasts. */
  lobbyMuteMs: number;
  /** Step 3: this many offenses within `lobbyKickWithinMs` kick the agent. */
  lobbyKickOffenses: number;
  lobbyKickWithinMs: number;

  // Topic circuit breaker (design §6).
  /** Trips when two agents alternate more than this many messages with no third party. */
  breakerMessages: number;
  /** The span those messages must fall in. */
  breakerWindowMs: number;
  /** Most recent messages one check reads. */
  breakerScanLimit: number;

  /**
   * Wake budget (design §6: 20 per hour, tunable): doorbells rung per user
   * per `wakeBudgetWindowMs` before events fall back to digest. The name
   * keeps the design's unit; the window is the hour (M4b).
   */
  wakeBudgetPerHour: number;
  /**
   * The wake budget's window (design §6: one hour). A fixed window that
   * starts at the user's first ring after the previous one ended (M4b).
   */
  wakeBudgetWindowMs: number;

  // Failed sign-ins (backlog B5).
  /** Failed sign-ins audited one row each per source per window; more are refused without a row. */
  authFailureLimit: number;
  authFailureWindowMs: number;
  /**
   * Board-wide cap on failed sign-in audit rows (B30): across all sources, at
   * most this many rows (`auth`, `sign_in_limited` and per-source summary
   * rows) per `authFailureBoardWindowMs`. Failures past it are counted and
   * written as one `sign_in_suppressed` row when the window ends.
   */
  authFailureBoardLimit: number;
  authFailureBoardWindowMs: number;

  // Adapter socket messages (backlog B45).
  /**
   * Adapter `state`, `ring_result` and `hello` messages accepted per session per
   * `socketMessageWindowMs`; more are refused without a row of their own.
   */
  socketMessageLimit: number;
  socketMessageWindowMs: number;

  // New sessions from `bbs_join` (backlog B-join, issue #43).
  /**
   * New sessions one handle may make per `joinWindowMs` (a sliding window, counted
   * from the sessions table); a join past it is refused. A join that updates the
   * caller's own live session is not a new session and is not counted. Sized so
   * that no real client meets it: an adapter joins once per start, and a connector
   * joins once per chat under its one handle.
   */
  joinMaxPerWindow: number;
  joinWindowMs: number;
  /** Most live sessions bound to an MCP session id (one per connector chat) one handle may hold. */
  connectorSessionsMaxPerHandle: number;
  /**
   * A connector session with no audited call for this long (from `attached_at`
   * when it has made none) is ended by the `connector_idle` timer.
   */
  connectorSessionIdleMs: number;
  /**
   * Most live session handles (issue #98: one per local session, made under an
   * agent's token) one agent may hold; counted over the ones neither retired
   * nor kicked, and a condition of the INSERT that makes one.
   */
  sessionHandlesMaxPerParent: number;
  /**
   * A session handle with no open adapter socket and nothing from it (a call, a
   * join, a socket close) for this long is retired by the `session_handle_retire`
   * timer (7 days).
   */
  sessionHandleRetireMs: number;

  /**
   * New-topic announcements in the Lobby (issue #80). The first new topic is
   * posted at once and opens a window of this length (10 minutes); topics made
   * during it go out as one line when it ends, and that post opens the next
   * window.
   */
  topicAnnounceWindowMs: number;
  /** Most topics a batch line names (10); the rest are counted ("and 2 more"). */
  topicAnnounceMaxListed: number;
  /** Most characters of a topic's description the single-topic line carries (200); the rest is cut with an ellipsis. */
  topicAnnounceDescriptionMax: number;

  // Audit export (design §13, M6a).
  /** Export when the oldest unexported row is this old (15 minutes); also the retry delay after a failure. */
  auditExportIntervalMs: number;
  /** Export at once when this many rows are unexported; also the most rows in one batch. */
  auditExportBatchRows: number;
  /** Exported rows stay in SQLite this long (30 days), then are deleted. */
  auditHotMs: number;
  /** Continuous export failure this long (1 day) posts one notice to human admins. */
  auditExportFailureNoticeMs: number;
  /**
   * Doorbell debounce (design §6: 5 s, tunable): a user's doorbell rings this
   * long after the first event that queued it, so a burst gives one ring.
   */
  doorbellDebounceMs: number;
  /**
   * Issue #104: when a `bbs_inbox` read answers `truncated` and wake items are
   * still unread, the session is rung again this long after the read (default
   * 5 s, like the debounce), through the ordinary doorbell and timer.
   */
  inboxTruncatedRingMs: number;
  /**
   * Retries after the adapter reports a ring `failed` (M2 independent review
   * M3): one timer each, these many ms after the failure; after the last the
   * doorbell waits for the next idle, attach or new event.
   */
  doorbellRetryMs: readonly number[];
  /**
   * A session reported busy for longer than this is treated as idle for
   * ringing (review M2): an interrupted turn fires no Stop hook, so busy can
   * be stale. The adapter has its own, shorter limit.
   */
  busyMaxMs: number;
  /**
   * Stored notices kept per user and per class, task and admin (review m10;
   * M2 security review): past it, older ones of the same class are deleted
   * when a new one is stored, those superseded by a later notice of their
   * task first (issue #105). A user holds at most twice this in total (1,000 by
   * default), so a task flood never evicts an administrator notice.
   */
  noticesMaxPerUser: number;
  /**
   * Most topics one user may subscribe to at `wake` or `digest` (M2 security
   * review): `bbs_inbox` reads each one, so this bounds what one call costs.
   */
  maxSubscriptionsPerUser: number;

  // Topic archiving and cold storage (design §14, M6b).
  /** Auto-archive after this long with no message and no task change (30 days). */
  archiveIdleMs: number;
  /** The auto-archive notice is posted this long before (3 days); less than `archiveIdleMs`. */
  archiveNoticeMs: number;
  /** How often the archive scan timer runs (1 hour). */
  archiveScanIntervalMs: number;
  /** Most topics one scan notices or archives; the rest wait for the next scan. */
  archiveScanMaxTopics: number;
  /** An archived topic goes cold (exported to the cold store, rows deleted) after this long (90 days). */
  coldAfterMs: number;
  /** After a failed cold export, the next try waits this long (1 hour). */
  coldRetryMs: number;
  /** Largest cold object written (32 MiB); a bigger topic stays archived and the failure is recorded. */
  coldMaxBytes: number;

  // Admin status (G5, `bbs_admin_status`).
  /** Most recent ring results shown per agent (5). */
  adminRingHistory: number;
  /**
   * An agent is flagged "rings keep failing" when this many of its most recent
   * ring results are all `failed` (3; Curtis 2026-11-21). At most `adminRingHistory`.
   */
  adminRingFailuresToFlag: number;
  /**
   * With export configured, audit export is flagged when the oldest unexported
   * row has waited longer than `auditExportIntervalMs` plus this (45 minutes,
   * so one hour in all by default), even with no failure recorded.
   */
  adminExportOverdueMs: number;

  // Web sign-in by pairing code (issue #47).
  /** How long a pairing code lives (5 minutes), approved or not. */
  webPairingTtlMs: number;
  /** Most live pairings board-wide; a start past it is refused as `rate_limited`. */
  webPairingMaxPending: number;
  /** Most live pairings from one sign-in source (the per-source limit on starts). */
  webPairingMaxPerSource: number;
  /**
   * Wrong pairing codes one person may try with `bbs_web_pairing_show` and
   * `bbs_web_pairing_approve` per window; past it both refuse, so the tools
   * cannot be used to guess a live code.
   */
  webPairingGuessLimit: number;
  webPairingGuessWindowMs: number;
  /** A web session lasts this long from its last renewal (30 days, sliding). */
  webSessionTtlMs: number;
  /** A session used after this long since its last renewal is renewed (24 hours): one audit row per session per day. */
  webSessionRenewAfterMs: number;
  /** Most web sessions per person; making one beyond it revokes the oldest. */
  webSessionMaxPerUser: number;
  /** While any pairing or session exists, expired ones are deleted this often (24 hours). */
  webPruneIntervalMs: number;

  // Passkey sign-in (issue #54).
  /** Most passkeys one person may register; a registration past it is refused (a condition of the write). */
  passkeysPerUser: number;
  /** A passkey challenge lives this long (5 minutes), and is single use. */
  passkeyChallengeTtlMs: number;
  /** Most live sign-in challenges board-wide; a start past it is refused as `rate_limited`. */
  passkeySigninMaxPending: number;
  /** Most live sign-in challenges from one sign-in source. */
  passkeySigninMaxPerSource: number;
  /** Most live registration challenges for one person (a new start replaces the person's older ones first). */
  passkeyRegisterMaxPending: number;
  /** Longest passkey attestation or assertion field the board reads, in bytes. */
  passkeyMaxFieldBytes: number;

  // Passkeys as approvers (issue #54, design §12).
  /** An approval request lives this long (5 minutes), and is single use. */
  approvalTtlMs: number;
  /** Most pending approval requests per person; a request past it is refused (a condition of the INSERT). */
  approvalsMaxPending: number;

  // OAuth on `/mcp` for remote connectors (issue #55, design §9).
  /** A client's metadata document is used from the board's copy for this long (24 hours). */
  oauthClientCacheMs: number;
  /** The Worker's fetch of a client metadata document gives up after this long (5 seconds). */
  oauthClientFetchTimeoutMs: number;
  /** The Worker reads at most this many bytes of a client metadata document (16 KB). */
  oauthClientMaxBytes: number;
  /** A pending authorization request waits this long for the person's decision (10 minutes). */
  oauthRequestTtlMs: number;
  /** An authorization code lives this long (2 minutes), and is single use. */
  oauthCodeTtlMs: number;
  /** An access token lives this long (1 hour). */
  oauthAccessTtlMs: number;
  /** A grant ends this long after its last renewal (30 days, sliding). */
  oauthGrantTtlMs: number;
  /** A refresh more than this long after the grant's last renewal renews it (24 hours). */
  oauthGrantRenewAfterMs: number;
  /** A refresh token stays usable this long after it is first presented (60 seconds), so a retry or two at once both work. */
  oauthRefreshGraceMs: number;
  /** Most pairs one refresh token may produce (5), counting its retries inside the grace; one past it is refused. */
  oauthRefreshMaxSuccessors: number;
  /** Most live grants per agent handle; an approval past it is refused. */
  oauthGrantMaxPerHandle: number;
  /** Most pending authorization requests board-wide; a request past it is refused. */
  oauthRequestMaxPending: number;
  /** While any OAuth row exists, expired ones are deleted this often (24 hours). */
  oauthPruneIntervalMs: number;
  /** The Worker reads at most this many bytes of a client's key set (64 KB); a stored key set is at most this size too. */
  oauthJwksMaxBytes: number;
  /** Most keys kept from a client's key set (10). */
  oauthJwksMaxKeys: number;
  /** A client's key set is fetched again for an unknown `kid` no more often than this (5 minutes). */
  oauthJwksRefetchMs: number;
  /** The longest client assertion accepted (8 KB). */
  oauthAssertionMaxBytes: number;
  /** Clock skew allowed on an assertion's `exp`, `nbf` and `iat` (60 seconds). */
  oauthAssertionSkewMs: number;
  /** An assertion's `exp` may be at most this far ahead (10 minutes). */
  oauthAssertionMaxLifetimeMs: number;
  /** Most unexpired assertion `jti` rows kept per client; one past it is refused (1000). */
  oauthJtiMaxPerClient: number;
}

const BUILD_ID_SHAPE = /^[0-9a-f]{16}$/;
const COMMIT_SHAPE = /^[0-9a-f]+(-dirty)?$/;
const SERVER_LABEL_MAX = 64;

/**
 * The server facts `bbs_whoami` reports, from what the shell passed: `build` is
 * a 16-hex deploy build id and `commit` a hex hash with an optional `-dirty`,
 * each at most 64 characters. A value that does not match is dropped; with no
 * valid build there is no result (a commit alone says nothing the build id does not).
 */
export function serverInfo(raw: BoardOptions["server"]): ServerInfo | undefined {
  const build = raw?.build;
  if (typeof build !== "string" || build.length > SERVER_LABEL_MAX || !BUILD_ID_SHAPE.test(build)) return undefined;
  const commit = raw?.commit;
  const okCommit = typeof commit === "string" && commit.length <= SERVER_LABEL_MAX && COMMIT_SHAPE.test(commit);
  return okCommit ? { build, commit } : { build };
}

/** Upper bounds on the audit export settings (M6a review n1). */
export const MAX_AUDIT_EXPORT_BATCH_ROWS = 10_000;
export const MAX_AUDIT_EXPORT_INTERVAL_MS = 24 * 60 * 60_000;
export const MAX_AUDIT_HOT_MS = 366 * 24 * 60 * 60_000;
/** Upper bounds on the wake budget (M4b). */
export const MAX_WAKE_BUDGET_WINDOW_MS = 24 * 60 * 60_000;
export const MAX_WAKE_BUDGET = 10_000;
export const MAX_APPROVAL_TTL_MS = 60 * 60_000;
export const MAX_APPROVALS_PENDING = 20;
export const MAX_TOPIC_ANNOUNCE_WINDOW_MS = 24 * 60 * 60_000;
export const MAX_TOPIC_ANNOUNCE_LISTED = 100;

export const DEFAULT_CONFIG: BoardConfig = {
  maxBodyLength: 32_000,
  maxRoleLength: 200,
  maxDescriptionLength: 1_000,
  readDefaultLimit: 50,
  readMaxLimit: 200,
  inboxDefaultLimit: 100,
  inboxMaxLimit: 500,
  auditDefaultLimit: 100,
  auditMaxLimit: 1_000,
  debugAuditReads: { handles: [], topics: [] },
  maxTaskTitleLength: 200,
  maxTaskCommentLength: 8_000,
  maxBlockersPerCall: 20,
  maxCycleSearch: 10_000,
  taskListDefaultLimit: 100,
  taskListMaxLimit: 500,
  taskLeaseMs: 2 * 60 * 60_000,
  lobbyPostLimit: 5,
  lobbyWindowMs: 10 * 60_000,
  lobbyMuteWithinMs: 60 * 60_000,
  lobbyMuteMs: 60 * 60_000,
  lobbyKickOffenses: 3,
  lobbyKickWithinMs: 24 * 60 * 60_000,
  breakerMessages: 10,
  breakerWindowMs: 5 * 60_000,
  breakerScanLimit: 200,
  wakeBudgetPerHour: 20,
  wakeBudgetWindowMs: 60 * 60_000,
  authFailureLimit: 20,
  authFailureWindowMs: 60_000,
  authFailureBoardLimit: 100,
  authFailureBoardWindowMs: 10 * 60_000,
  socketMessageLimit: 60,
  socketMessageWindowMs: 60_000,
  joinMaxPerWindow: 20,
  joinWindowMs: 10 * 60_000,
  connectorSessionsMaxPerHandle: 20,
  connectorSessionIdleMs: 24 * 60 * 60_000,
  sessionHandlesMaxPerParent: 50,
  sessionHandleRetireMs: 7 * 24 * 60 * 60_000,
  topicAnnounceWindowMs: 10 * 60_000,
  topicAnnounceMaxListed: 10,
  topicAnnounceDescriptionMax: 200,
  auditExportIntervalMs: 15 * 60_000,
  auditExportBatchRows: 1_000,
  auditHotMs: 30 * 24 * 60 * 60_000,
  auditExportFailureNoticeMs: 24 * 60 * 60_000,
  doorbellDebounceMs: 5_000,
  inboxTruncatedRingMs: 5_000,
  doorbellRetryMs: [30_000, 2 * 60_000, 10 * 60_000],
  busyMaxMs: 15 * 60_000,
  noticesMaxPerUser: 500,
  maxSubscriptionsPerUser: 200,
  archiveIdleMs: 30 * 24 * 60 * 60_000,
  archiveNoticeMs: 3 * 24 * 60 * 60_000,
  archiveScanIntervalMs: 60 * 60_000,
  archiveScanMaxTopics: 50,
  coldAfterMs: 90 * 24 * 60 * 60_000,
  coldRetryMs: 60 * 60_000,
  coldMaxBytes: 32 * 1024 * 1024,
  adminRingHistory: 5,
  adminRingFailuresToFlag: 3,
  adminExportOverdueMs: 45 * 60_000,
  webPairingTtlMs: 5 * 60_000,
  webPairingMaxPending: 20,
  webPairingMaxPerSource: 5,
  webPairingGuessLimit: 10,
  webPairingGuessWindowMs: 10 * 60_000,
  webSessionTtlMs: 30 * 24 * 60 * 60_000,
  webSessionRenewAfterMs: 24 * 60 * 60_000,
  webSessionMaxPerUser: 10,
  webPruneIntervalMs: 24 * 60 * 60_000,
  passkeysPerUser: 10,
  passkeyChallengeTtlMs: 5 * 60_000,
  passkeySigninMaxPending: 50,
  passkeySigninMaxPerSource: 5,
  passkeyRegisterMaxPending: 3,
  passkeyMaxFieldBytes: 16 * 1024,
  approvalTtlMs: 5 * 60_000,
  approvalsMaxPending: 3,
  oauthClientCacheMs: 24 * 60 * 60_000,
  oauthClientFetchTimeoutMs: 5_000,
  oauthClientMaxBytes: 16 * 1024,
  oauthRequestTtlMs: 10 * 60_000,
  oauthCodeTtlMs: 2 * 60_000,
  oauthAccessTtlMs: 60 * 60_000,
  oauthGrantTtlMs: 30 * 24 * 60 * 60_000,
  oauthGrantRenewAfterMs: 24 * 60 * 60_000,
  oauthRefreshGraceMs: 60_000,
  oauthRefreshMaxSuccessors: 5,
  oauthGrantMaxPerHandle: 10,
  oauthRequestMaxPending: 20,
  oauthPruneIntervalMs: 24 * 60 * 60_000,
  oauthJwksMaxBytes: 64 * 1024,
  oauthJwksMaxKeys: 10,
  oauthJwksRefetchMs: 5 * 60_000,
  oauthAssertionMaxBytes: 8 * 1024,
  oauthAssertionSkewMs: 60_000,
  oauthAssertionMaxLifetimeMs: 10 * 60_000,
  oauthJtiMaxPerClient: 1_000,
};

/**
 * Check a whole config (orchestrator review m2): every numeric field a
 * positive safe integer, and the Lobby spans in order (window < mute-within
 * <= kick-within), so an offense window never outlasts the escalation it
 * feeds. Returns the first problem, or undefined when the config is sound.
 */
export function validateConfig(c: BoardConfig): string | undefined {
  for (const [key, value] of Object.entries(c)) {
    if (typeof value !== "number") continue;
    if (!Number.isSafeInteger(value) || value <= 0) return `${key} must be a positive integer`;
  }
  if (!c.doorbellRetryMs.every((v) => Number.isSafeInteger(v) && v > 0)) {
    return "doorbellRetryMs must hold positive integers";
  }
  if (!(c.lobbyWindowMs < c.lobbyMuteWithinMs)) return "lobbyWindowMs must be less than lobbyMuteWithinMs";
  if (!(c.lobbyMuteWithinMs <= c.lobbyKickWithinMs)) {
    return "lobbyMuteWithinMs must not exceed lobbyKickWithinMs";
  }
  // Audit export upper bounds (M6a review n1). The lower bounds stay at
  // "positive" so the e2e suite can run the real alarm with second-long spans.
  if (c.auditExportBatchRows > MAX_AUDIT_EXPORT_BATCH_ROWS) {
    return `auditExportBatchRows must be at most ${MAX_AUDIT_EXPORT_BATCH_ROWS}`;
  }
  if (c.auditExportIntervalMs > MAX_AUDIT_EXPORT_INTERVAL_MS) return "auditExportIntervalMs must be at most 1 day";
  if (c.auditHotMs > MAX_AUDIT_HOT_MS) return "auditHotMs must be at most 366 days";
  if (c.wakeBudgetWindowMs > MAX_WAKE_BUDGET_WINDOW_MS) return "wakeBudgetWindowMs must be at most 1 day";
  if (c.wakeBudgetPerHour > MAX_WAKE_BUDGET) return `wakeBudgetPerHour must be at most ${MAX_WAKE_BUDGET}`;
  if (c.topicAnnounceWindowMs > MAX_TOPIC_ANNOUNCE_WINDOW_MS) return "topicAnnounceWindowMs must be at most 1 day";
  if (c.topicAnnounceMaxListed > MAX_TOPIC_ANNOUNCE_LISTED) {
    return `topicAnnounceMaxListed must be at most ${MAX_TOPIC_ANNOUNCE_LISTED}`;
  }
  if (!(c.archiveNoticeMs < c.archiveIdleMs)) return "archiveNoticeMs must be less than archiveIdleMs";
  if (c.adminRingHistory > 100) return "adminRingHistory must be at most 100";
  if (!(c.adminRingFailuresToFlag <= c.adminRingHistory)) {
    return "adminRingFailuresToFlag must not exceed adminRingHistory";
  }
  if (c.approvalTtlMs > MAX_APPROVAL_TTL_MS) return "approvalTtlMs must be at most 1 hour";
  if (c.approvalsMaxPending > MAX_APPROVALS_PENDING) return `approvalsMaxPending must be at most ${MAX_APPROVALS_PENDING}`;
  if (!(c.oauthGrantRenewAfterMs < c.oauthGrantTtlMs)) {
    return "oauthGrantRenewAfterMs must be less than oauthGrantTtlMs";
  }
  return undefined;
}

export interface BoardOptions {
  sql: Sql;
  /** Milliseconds since the epoch. Injected so tests control time (P2). */
  now: () => number;
  /** Synchronous SHA-256, lowercase hex of the UTF-8 input (P2). */
  sha256: Sha256;
  /** Random bytes for tokens and session ids. Defaults to Web Crypto. */
  randomBytes?: (n: number) => Uint8Array;
  config?: Partial<BoardConfig>;
  /**
   * What the shell running the board knows and `core` does not (G5): the
   * Board Durable Object passes its open adapter sockets and whether an audit
   * sink is configured. Read only by `bbs_admin_status`. Omitted (unit tests,
   * a Node entry point): those fields are reported as unknown (`null`).
   */
  runtime?: RuntimeFacts;
  /**
   * Which build the shell is running, for `bbs_whoami`: the deploy's build id
   * and the checkout's commit. Short labels; a value that is not one (see
   * `serverInfo`) is dropped, never refused. Omitted: `whoami` reports no `server`.
   */
  server?: { build?: string | undefined; commit?: string | undefined };
  /**
   * Whether the board requires a passkey's approval for the human-only actions
   * that are gated (design §12), set once at deploy time and never changed by
   * any tool. Omitted: approval is off, which is how every unit test starts.
   */
  approval?: Partial<ApprovalSettings>;
}

/**
 * Deploy-time approval settings. `required`: a gated action does not run until
 * a passkey signs its scope. `allowSynced`: a passkey that syncs between devices
 * may approve too (a stopgap; off by default, and meaningless unless `required`).
 */
export interface ApprovalSettings {
  required: boolean;
  allowSynced: boolean;
}

/** What `bbs_whoami` reports of the server; at least `build`. */
export interface ServerInfo {
  build: string;
  commit?: string;
}

/** Facts from the shell (see `BoardOptions.runtime`). Must not write anything. */
export interface RuntimeFacts {
  /** Adapter sockets open for this handle now, not already closed by the board. */
  openSockets(handle: string): number;
  /** Whether an audit sink is configured, so rows leave SQLite (design §13). */
  auditExportConfigured(): boolean;
}

/** What an action handler sees. It runs inside `act`'s transaction. */
export interface Tx {
  sql: Sql;
  now: number;
  actor: Actor;
  ctx: CallContext;
  config: BoardConfig;
  sha256: Sha256;
  randomBytes: (n: number) => Uint8Array;
  /** The shell's runtime facts, when it gave any (G5). */
  runtime?: RuntimeFacts;
  /** The server's build, when the shell gave a valid one; only `bbs_whoami` reads it. */
  server?: ServerInfo;
  /** The deploy-time approval settings (passkeys as approvers). */
  approval: ApprovalSettings;
}

export interface AuditTarget {
  targetType?: string;
  targetId?: string;
  topic?: string;
  detail?: Record<string, unknown>;
  /** Overrides the session recorded on the audit row (join creates one). */
  session?: string;
  /**
   * Overrides the actor recorded on the audit row: a join by an agent's token
   * that makes or returns a session handle is the session handle's own call
   * (issue #98), and the row carries its `parent`.
   */
  actor?: { handle: string; parent: string };
}

export interface ActionOutcome<T = unknown> {
  value: T;
  audit: AuditTarget;
  /**
   * Audit the row under this action name instead of the one called: a gated
   * action that only asked for an approval is `approval_request`.
   */
  auditAction?: string;
  notifications?: NotificationWork[];
  /** System actions to run after this one commits (see `FollowUp`). */
  followUps?: FollowUp[];
}

export interface ActionDef {
  name: string;
  /**
   * `change` and `audited_read` actions are always audited; `read` actions
   * only under the debug flag (design §13). Reading the audit log is an
   * `audited_read`: it is security-relevant.
   */
  kind: "change" | "read" | "audited_read";
  /**
   * A change that is not the user's activity (it moves only bookkeeping, like
   * the read mark), so a person's call through the web view does not update
   * `last_seen` or renew leases (B38, see `countsAsActivity`).
   */
  passive?: boolean;
  /**
   * Whether this call renews the caller's task leases (design §8: any call
   * from the assignee). Default yes. Adapter socket housekeeping (open,
   * hello, close, ring results, `idle`) is not the agent working, so it
   * returns false; `state: busy` is (M2 independent review m5).
   */
  renewsLeases?(params: Record<string, unknown>): boolean;
  run(tx: Tx, params: Record<string, unknown>): ActionOutcome;
}
