// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The board and its single write path (spec §3 "Rule for core").
 *
 * `act` opens a transaction, resolves and checks the actor, runs the action,
 * writes the audit row (chained to the previous one), returns the queued
 * notification work, and commits. When the action throws, the transaction
 * rolls back and a second transaction writes only the `denied` or `error`
 * audit row, so a failed action leaves no change but always leaves a record.
 *
 * Nothing else in `core` writes to the board tables. `migrate` writes DDL,
 * the `meta` rows and the Lobby topic before the first `act`.
 */

import {
  chainValueAfter,
  GENESIS_HASH,
  verifyChain,
  type AuditResult,
  type AuditRow,
  type ChainCheck,
  type Sha256,
} from "./audit.ts";
import { lobbyUnmute } from "./actions/admin.ts";
import {
  archiveScan,
  archiveScanSchedule,
  buildColdObject,
  COLD_DUE_SQL,
  COLD_ELIGIBLE_SQL,
  coldRestoreKey,
  coldSizeEstimate,
  topicColdBegin,
  topicArchive,
  topicCold,
  topicColdFailed,
  topicDescribe,
  topicKeep,
  topicRestore,
  topicUnarchive,
} from "./actions/archive.ts";
import type { TopicRow } from "./actions/common.ts";
import type { ColdExporter, ColdJob } from "./cold.ts";
import { coldKey } from "./cold-object.ts";
import {
  auditExportBegin,
  auditExportConfirm,
  auditExportFailed,
  auditPrune,
  chainState,
  exportDue,
  exportState,
  pruneDue,
  readAuditRows,
  type ChainState,
} from "./actions/audit-export.ts";
import {
  buildBatch,
  verifyAuditArchive,
  type ArchiveCheck,
  type AuditBatch,
  type AuditExporter,
} from "./audit-export.ts";
import { auditRead } from "./actions/audit-read.ts";
import {
  adminCoordinatorGrant,
  adminCoordinatorRemove,
  adminReinstate,
  whoami,
} from "./actions/human-admin.ts";
import { adminStatus } from "./actions/admin-status.ts";
import { approvalStartOptions, approvalStatus, checkApproval, pollApprovalId } from "./actions/approval.ts";
import { approvalFinish } from "./actions/approval-finish.ts";
import { inbox, post, read } from "./actions/messages.ts";
import {
  cachedClient,
  checkCode,
  checkRefresh,
  noteGrantUse,
  oauthCodeExchange,
  oauthDecide,
  oauthGrantEnded,
  oauthGrantRevoke,
  oauthGrants,
  oauthPrune,
  oauthCodeUnused,
  oauthAssertionUse,
  oauthKeyRefetch,
  oauthKeysStore,
  oauthRefresh,
  oauthRequest,
  storedClientAuth,
  type TokenValue,
} from "./actions/oauth.ts";
import { ASSERTION_TYPE, peekIssuer, verifyAssertion, type AuthMethod, type SigningAlg } from "./actions/client-auth.ts";
import { topicMarkRead } from "./actions/read-mark.ts";
import {
  leaseCheck,
  renewLeases,
  taskAssign,
  taskBlock,
  taskClaim,
  taskComment,
  taskCreate,
  taskList,
  taskUnblock,
  taskUpdate,
} from "./actions/tasks.ts";
import { topicAnnounce } from "./actions/topic-announce.ts";
import { subscribe, topicCreate, topics } from "./actions/topics.ts";
import {
  adminUserAdd,
  authDenied,
  bootstrapHuman,
  connectorIdle,
  join,
  otherAdminExists,
  roleSet,
  who,
} from "./actions/users.ts";
import {
  doorbellDue,
  ringResult,
  ringUndeliverable,
  socketClose,
  socketHello,
  socketOpen,
  socketsClosed,
  socketState,
} from "./actions/wake.ts";
import {
  checkRegistration,
  checkSignin,
  passkeyRegisterFinish,
  passkeyRegisterStart,
  passkeyRemove,
  passkeys,
  passkeySignin,
  passkeySigninStart,
  signinRoom,
} from "./actions/passkey.ts";
import {
  cleanLabel,
  pairingRoom,
  webPairClaim,
  webPairingApprove,
  webPairingShow,
  webPairStart,
  webPrune,
  webSessionRenew,
  webSessionRevoke,
  webSessions,
  webSignOut,
} from "./actions/web-session.ts";
import { deliver, deliveryDetail } from "./notify.ts";
import { validHandle } from "./params.ts";
import { adminSessionHandleRetire, sessionHandleRetire } from "./actions/session-handles.ts";
import { migrate, userStatusSql } from "./schema.ts";
import type { Sql } from "./sql.ts";
import {
  BbsError,
  DEFAULT_CONFIG,
  serverInfo,
  SESSION_ENDED_MARKER,
  denied,
  validateConfig,
  VIAS,
  VIAS_BY_KIND,
  type ActionDef,
  type ActionOutcome,
  type ActResult,
  type Actor,
  type ApprovalSettings,
  type AuditTarget,
  type BoardConfig,
  type BoardOptions,
  type CallContext,
  type DisconnectNotification,
  type ErrorCode,
  type FollowUp,
  type NotificationWork,
  type RuntimeFacts,
  type ServerInfo,
  type UserKind,
  type Via,
} from "./types.ts";

/** Actions callable through `act`. */
export const PUBLIC_ACTIONS: Readonly<Record<string, ActionDef>> = Object.freeze({
  join,
  topic_create: topicCreate,
  topics,
  post,
  read,
  subscribe,
  who,
  role_set: roleSet,
  inbox,
  audit: auditRead,
  admin_user_add: adminUserAdd,
  task_create: taskCreate,
  task_assign: taskAssign,
  task_claim: taskClaim,
  task_update: taskUpdate,
  task_comment: taskComment,
  task_list: taskList,
  task_block: taskBlock,
  task_unblock: taskUnblock,
  whoami,
  admin_reinstate: adminReinstate,
  admin_session_handle_retire: adminSessionHandleRetire,
  admin_coordinator_grant: adminCoordinatorGrant,
  admin_coordinator_remove: adminCoordinatorRemove,
  topic_mark_read: topicMarkRead,
  topic_archive: topicArchive,
  topic_unarchive: topicUnarchive,
  topic_keep: topicKeep,
  topic_describe: topicDescribe,
  admin_status: adminStatus,
  web_pairing_show: webPairingShow,
  web_pairing_approve: webPairingApprove,
  web_sessions: webSessions,
  web_session_revoke: webSessionRevoke,
  web_sign_out: webSignOut,
  approval_status: approvalStatus,
  passkeys,
  passkey_remove: passkeyRemove,
  oauth_grants: oauthGrants,
  oauth_grant_revoke: oauthGrantRevoke,
});

/** Timer kinds `runDueTimers` knows, and the system action each one runs. */
const TIMER_ACTIONS: Readonly<Record<string, ActionDef>> = Object.freeze({
  lease: leaseCheck,
  lobby_unmute: lobbyUnmute,
  doorbell: doorbellDue,
  archive_scan: archiveScan,
  web_prune: webPrune,
  oauth_prune: oauthPrune,
  oauth_code_unused: oauthCodeUnused,
  connector_idle: connectorIdle,
  session_handle_retire: sessionHandleRetire,
  topic_announce: topicAnnounce,
});

/**
 * Adapter socket actions (spec §4.3), called by the Board DO for `/ws`
 * events only; not tools, so not reachable through `/api` or `/mcp`.
 */
export const SOCKET_ACTIONS: Readonly<Record<string, ActionDef>> = Object.freeze({
  socket_open: socketOpen,
  socket_hello: socketHello,
  session_state: socketState,
  ring_result: ringResult,
  socket_close: socketClose,
});

/** Most timers one `runDueTimers` call runs; the rest wait for the next alarm. */
export const MAX_TIMERS_PER_RUN = 100;

export type PublicAction = keyof typeof PUBLIC_ACTIONS;

const SYSTEM_ACTOR: Actor = {
  handle: "system",
  kind: "system",
  isAdmin: false,
  isCoordinator: false,
  status: "active",
};

const SYSTEM_CTX: CallContext = { handle: "system", via: "system" };

const ANONYMOUS_ACTOR: Actor = {
  handle: "anonymous",
  kind: "anonymous",
  isAdmin: false,
  isCoordinator: false,
  status: "active",
};

/** Longest bearer token `authenticate` will look up; longer ones are refused. */
export const MAX_TOKEN_LENGTH = 512;

/** Longest sign-in source key kept (B5); longer ones are cut. */
export const MAX_SOURCE_LENGTH = 64;
/** Most sign-in sources whose failure windows are held in memory (B5). */
export const MAX_AUTH_SOURCES = 1_000;
/** Most sessions whose socket message windows are held in memory (B45). */
export const MAX_SOCKET_WINDOWS = 1_000;
/** Most handles whose refused-join windows are held in memory (issue #43). */
export const MAX_JOIN_WINDOWS = 1_000;

export type AuthResult =
  | {
      ok: true;
      handle: string;
      kind: UserKind;
      /** For a web session sign-in: the session's public id (see `authenticateWebSession`). */
      webSession?: string;
      /** For a connector's access token on `/mcp` (issue #55): the grant's public id. */
      oauthGrant?: string;
      /**
       * Set on the one sign-in that slid the session's expiry (`authenticateWebSession`):
       * the shell sends the cookie again with `maxAgeMs` (from the board's config),
       * so the browser's copy lasts as long as the board's.
       */
      renewed?: true;
      maxAgeMs?: number;
    }
  | {
      ok: false;
      reason: string;
      /**
       * Undefined for a refusal over the failed sign-in limit that was
       * counted rather than written as its own row (see `authenticate`).
       */
      auditSeq: number | undefined;
      /** For `rate_limited`: when the source's window ends, in ms from now. */
      retryAfterMs?: number;
    };

/** The form fields `POST /oauth/token` reads, as strings (a missing field is undefined). */
export interface OAuthTokenParams {
  grant_type?: string | undefined;
  code?: string | undefined;
  code_verifier?: string | undefined;
  redirect_uri?: string | undefined;
  client_id?: string | undefined;
  resource?: string | undefined;
  refresh_token?: string | undefined;
  client_assertion_type?: string | undefined;
  client_assertion?: string | undefined;
}

/** The OAuth error codes the token and revoke routes answer with. */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_grant"
  | "invalid_client"
  | "invalid_target"
  | "unsupported_grant_type"
  | "temporarily_unavailable";

/**
 * A refused OAuth request. `refetchKeys` names a client whose key set may have
 * rotated (the assertion's `kid` is not in the stored set): the shell may fetch
 * it again (`oauthClaimKeyRefetch`, `oauthStoreKeys`) and ask once more with
 * `keysRefetched`. A refusal carrying it was not counted as a failed sign-in.
 */
export type OAuthFailure = { ok: false; error: OAuthErrorCode; description: string; retryAfterMs?: number; refetchKeys?: string };

export type OAuthTokenResult = { ok: true; value: TokenValue } | OAuthFailure;

/** A client that passed authentication at `/oauth/token` or `/oauth/revoke` (see `Board.authenticateOAuthClient`). */
export interface OAuthClientAuth {
  clientId: string;
  method: AuthMethod;
  /** Set for a signed request: the assertion's `jti` (hashed) to spend in the write. */
  jti?: { hash: string; expiresAt: number; alg: SigningAlg; kid: string | null };
}

export type OAuthClientAuthResult = { ok: true; auth: OAuthClientAuth } | OAuthFailure;

/** Failed sign-ins from one source in the current window (B5). */
interface AuthWindow {
  start: number;
  /** Failures audited in this window, one `auth` row each. */
  audited: number;
  /** Whether the `sign_in_limited` row for this window was written. */
  limited: boolean;
  /** Failures refused without a row, by reason; flushed when the window ends. */
  suppressed: Record<string, number>;
  total: number;
}

/** The board-wide failed sign-in window (B30), with who the counted failures came from. */
interface BoardAuthWindow extends AuthWindow {
  /** Counted failures by source and by (non-anonymous) handle; bounded, the rest in `other`. */
  bySource: Map<string, number>;
  byHandle: Map<string, number>;
  otherSources: number;
  otherHandles: number;
}

/** Most keys kept live in each attribution map of the board window (B30). */
const MAX_ATTRIBUTION_KEYS = 1_000;
/** Most keys written out per attribution map in the board summary row; the rest are summed as `other`. */
const SUMMARY_ATTRIBUTION_KEYS = 50;

/** Adapter `state`, `ring_result` and `hello` messages from one session in the current window (B45). */
interface SocketWindow {
  start: number;
  handle: string;
  session: string;
  /** Messages accepted in this window. */
  accepted: number;
  /** Whether the `socket_rate_limited` row for this window was written. */
  limited: boolean;
  /** Messages refused without a row, by action; flushed when the window ends. */
  suppressed: Record<string, number>;
  total: number;
}

/** Refused `bbs_join`s from one handle in the current window (issue #43). */
interface JoinWindow {
  start: number;
  /** Whether the first refusal's own `denied` row was written. */
  limited: boolean;
  /** Refusals counted instead of written. */
  total: number;
}

function defaultRandomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export class Board implements AuditExporter, ColdExporter {
  readonly #sql: Sql;
  readonly #now: () => number;
  readonly #sha256: Sha256;
  readonly #randomBytes: (n: number) => Uint8Array;
  readonly config: BoardConfig;
  /**
   * Failed sign-in windows by source (B5), oldest first (a window is
   * re-inserted when it starts). In memory on purpose: writing a count per
   * failed request would be the row-per-request this limit exists to bound.
   * Counts not yet flushed are lost if the Durable Object is evicted or
   * restarts (backlog B31).
   */
  readonly #authWindows = new Map<string, AuthWindow>();
  /**
   * The board-wide failed sign-in window (B30): how many failure rows the
   * board wrote across all sources, and the failures counted instead. In
   * memory like the per-source windows; the Durable Object runs one call at
   * a time, so reading and incrementing it cannot race.
   */
  #authBoard: BoardAuthWindow | undefined;
  /**
   * Adapter socket message windows by session (B45), oldest first. In memory
   * on purpose, like `#authWindows`; counts not yet flushed are lost if the
   * Durable Object is evicted.
   */
  readonly #socketWindows = new Map<string, SocketWindow>();
  /**
   * Refused `bbs_join` windows by handle (issue #43), oldest first. The limit
   * itself is a condition of the session insert; this only keeps the refusals
   * from writing a row each. In memory like the others.
   */
  readonly #joinWindows = new Map<string, JoinWindow>();
  /**
   * Socket closings asked for by committed calls (M4b, B48), by handle, until
   * the shell takes them with `takeDisconnects` after the call.
   */
  readonly #disconnects = new Map<string, DisconnectNotification["reason"]>();

  /** The shell's runtime facts (G5), read only by `bbs_admin_status`. */
  readonly #runtime: RuntimeFacts | undefined;
  /** The build the shell reported, already validated (`bbs_whoami`). */
  readonly #server: ServerInfo | undefined;
  /** The deploy-time approval settings: fixed for the life of the Board, changed by no tool. */
  readonly #approval: ApprovalSettings;

  constructor(options: BoardOptions) {
    this.#sql = options.sql;
    this.#now = options.now;
    this.#sha256 = options.sha256;
    this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.#runtime = options.runtime;
    this.#server = serverInfo(options.server);
    this.#approval = { required: options.approval?.required === true, allowSynced: options.approval?.allowSynced === true };
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    const problem = validateConfig(this.config);
    if (problem) throw new RangeError(`invalid board config: ${problem}`);
    migrate(this.#sql, this.#now(), this.#randomBytes);
  }

  /**
   * The one entry point for user actions. `ctx.handle` must come from
   * `authenticate`, never from request input.
   */
  act<T = unknown>(ctx: CallContext, action: string, params?: unknown): ActResult<T> {
    const def = Object.hasOwn(PUBLIC_ACTIONS, action) ? PUBLIC_ACTIONS[action] : undefined;
    if (action === "join") this.#flushJoinWindows();
    return this.#run(ctx, action, def, params, () => this.#loadActor(ctx), {
      userCall: true,
      ...(action === "join" ? { countRefusal: (e: BbsError) => e.code === "rate_limited" && this.#joinRefusalCounted(ctx.handle) } : {}),
    }) as ActResult<T>;
  }

  /**
   * An adapter socket event (`/ws`, spec §4.3): one of `SOCKET_ACTIONS`, as
   * the authenticated agent, `via = ws`. Same checks and audit as `act`.
   */
  socketAct(ctx: CallContext, action: string, params?: unknown): ActResult {
    this.#flushSocketWindows();
    if (
      ctx.session !== undefined &&
      (action === "session_state" || action === "ring_result" || action === "socket_hello")
    ) {
      const refused = this.#socketRateLimit(ctx, action);
      if (refused) return refused;
    }
    const def = Object.hasOwn(SOCKET_ACTIONS, action) ? SOCKET_ACTIONS[action] : undefined;
    return this.#run(ctx, action, def, params, () => this.#loadActor(ctx), { userCall: true });
  }

  /**
   * Whether a session exists and has not ended (read-only). The Board DO
   * uses it to close adapter sockets whose session a later `bbs_join`
   * replaced.
   */
  sessionLive(id: string): boolean {
    const row = this.#sql.one<{ state: string }>("SELECT state FROM sessions WHERE id = ?", id);
    return row !== undefined && row.state !== "gone";
  }

  /**
   * The agent whose token a session handle (issue #98) was made under, or
   * undefined for any other handle (read-only). Adapter sockets are tagged with
   * the token's handle, so the Board DO uses it to find a session handle's.
   */
  parentOf(handle: string): string | undefined {
    return this.#sql.one<{ parent: string | null }>("SELECT parent FROM users WHERE handle = ?", handle)?.parent ?? undefined;
  }

  /** The handle a session belongs to, or undefined when there is no such session (read-only). */
  sessionOwner(id: string): string | undefined {
    return this.#sql.one<{ handle: string }>("SELECT handle FROM sessions WHERE id = ?", id)?.handle;
  }

  /**
   * The users whose adapter sockets must close now (M4b, B48), gathered from
   * every committed call and follow-up since the last take: a kick, or a
   * revoked or replaced credential. The Board DO calls this after each call
   * and closes those sockets in the same request. A kick wins over a plain
   * revocation for the same user.
   */
  takeDisconnects(): { handle: string; reason: DisconnectNotification["reason"] }[] {
    const out = [...this.#disconnects].map(([handle, reason]) => ({ handle, reason }));
    this.#disconnects.clear();
    return out;
  }

  /**
   * Whether an adapter socket's credential still holds (B48), read-only and
   * one primary-key lookup: `kicked` when the user is kicked, `revoked` when
   * the user is gone or its token hash is no longer `tokenHash` (revoked,
   * rotated, or reissued), else `ok`. The Board DO runs it on every socket
   * message.
   */
  socketCredential(handle: string, tokenHash: string): "ok" | "kicked" | "revoked" {
    const row = this.#sql.one<{ status: string; token_hash: string | null }>(
      "SELECT status, token_hash FROM users WHERE handle = ?",
      handle,
    );
    if (!row) return "revoked";
    if (row.status === "kicked") return "kicked";
    return row.token_hash !== null && row.token_hash === tokenHash ? "ok" : "revoked";
  }

  /**
   * The Board DO closed `closed` adapter sockets of `handle` for `reason`
   * (M4b, B48): audited as a system action that detaches their sessions
   * (only `session`'s when one socket closed on its own message).
   */
  socketsClosed(
    handle: string,
    reason: string,
    closed: number,
    code: number,
    requestId?: string,
    /** The one socket's session when a single socket closed on its own message; null: none attached. */
    session?: string | null,
  ): ActResult {
    return this.#run(
      { handle: "system", via: "system", requestId },
      "sockets_closed",
      socketsClosed,
      { handle, reason, closed, code, ...(session !== undefined ? { session, one: true } : {}) },
      () => SYSTEM_ACTOR,
    );
  }

  /**
   * A ring the shell could not send (no open socket for the session): the
   * doorbell goes back to unsent. System actor, audited.
   */
  ringUndeliverable(handle: string, id: string, session: string, requestId?: string): ActResult {
    return this.#run(
      { handle: "system", via: "system", requestId },
      "ring_undeliverable",
      ringUndeliverable,
      { handle, id, session },
      () => SYSTEM_ACTOR,
    );
  }

  /**
   * Refuse an action without running it, with a `denied` audit row: used by
   * a shell when a caller asks for something its surface does not offer
   * (an admin tool on `/mcp`).
   */
  refuse(
    ctx: CallContext,
    action: string,
    reason: string,
    detail: Record<string, unknown> = {},
    code: ErrorCode = "forbidden",
  ): ActResult {
    const def: ActionDef = {
      name: action,
      kind: "change",
      run() {
        throw denied(reason, code);
      },
    };
    return this.#run(ctx, action.slice(0, 64), def, {}, () => this.#loadActor(ctx), {
      userCall: true,
      extraDetail: detail,
    });
  }

  /**
   * Resolve a bearer token to its user (Q1). A missing, unknown or revoked
   * token is refused, and the refusal is audited as `denied` with actor
   * `anonymous` (or the kicked handle). The token itself is never stored or
   * logged; only its SHA-256 is compared.
   */
  authenticate(
    token: string | undefined | null,
    info: {
      via: Via;
      requestId?: string | undefined;
      endpoint?: string | undefined;
      /** Extra facts for a refusal's audit row (e.g. the client the caller claimed). */
      detail?: Record<string, unknown> | undefined;
      /**
       * Where the request came from, as the shell sees it (the Worker: the
       * client address Cloudflare reports, or a fixed key locally). Failed
       * sign-ins are limited per source (B5).
       */
      source?: string | undefined;
      /**
       * Also accept a connector's OAuth access token (issue #55): only the
       * Worker's `/mcp` sets it, so an access token is refused everywhere else.
       */
      accessToken?: boolean | undefined;
    },
  ): AuthResult {
    const source = (info.source ?? "unknown").slice(0, MAX_SOURCE_LENGTH);
    // Every sign-in (from any source) first writes out windows that ended.
    this.flushAuthWindows();
    const deny = (reason: string, actor: Actor, extra: Record<string, unknown> = {}): AuthResult =>
      this.#denySignIn(source, info, reason, actor, extra);
    if (!token) return deny("missing_token", ANONYMOUS_ACTOR);
    // Refused, not truncated: a cut token could match a different user's.
    if (token.length > MAX_TOKEN_LENGTH) return deny("token_too_long", ANONYMOUS_ACTOR);
    const hash = this.#sha256(token);
    const row = this.#sql.one<{ handle: string; kind: UserKind; status: string }>(
      "SELECT handle, kind, status FROM users WHERE token_hash = ?",
      hash,
    );
    const revokedUse = (
      handle: string,
      kind: UserKind,
      status: Actor["status"],
      revoked: "kicked" | "retired" | "replaced",
    ): AuthResult =>
      deny("revoked_token", { handle, kind, isAdmin: false, isCoordinator: false, status }, { revoked });
    if (!row) {
      // Revoked credentials (M4a kick, M5 reinstate, B17 retire and rotation).
      // The detail says why, so a person's is never recorded as a kick.
      const revoked = this.#sql.one<{ handle: string; kind: UserKind; status: Actor["status"]; is_admin: number }>(
        `SELECT r.handle, u.kind, u.status, u.is_admin FROM revoked_tokens r
         JOIN users u ON u.handle = r.handle WHERE r.token_hash = ?`,
        hash,
      );
      if (revoked) {
        const why =
          revoked.status === "kicked"
            ? "kicked"
            : revoked.kind === "human" && Number(revoked.is_admin) !== 1
              ? "retired"
              : "replaced";
        return revokedUse(revoked.handle, revoked.kind, revoked.status, why);
      }
      if (info.accessToken === true) {
        const a = this.#sql.one<{
          grant_id: string;
          access_expires_at: number;
          expires_at: number;
          handle: string;
          kind: UserKind;
          status: Actor["status"];
        }>(
          `SELECT t.grant_id, t.access_expires_at, g.expires_at, g.handle, u.kind, u.status
           FROM oauth_tokens t
           JOIN oauth_grants g ON g.id = t.grant_id
           JOIN users u ON u.handle = g.handle
           WHERE t.access_hash = ?`,
          hash,
        );
        if (a) {
          const now = this.#now();
          const grant = { grant: a.grant_id };
          if (Number(a.access_expires_at) <= now) return deny("expired_token", ANONYMOUS_ACTOR, grant);
          if (Number(a.expires_at) <= now) return deny("expired_grant", ANONYMOUS_ACTOR, grant);
          if (a.status === "kicked" || a.kind !== "agent") {
            return deny("revoked_token", { handle: a.handle, kind: a.kind, isAdmin: false, isCoordinator: false, status: a.status }, {
              ...grant,
              revoked: "kicked",
            });
          }
          return { ok: true, handle: a.handle, kind: "agent", oauthGrant: a.grant_id };
        }
      }
      return deny("unknown_token", ANONYMOUS_ACTOR);
    }
    if (row.status === "kicked") return revokedUse(row.handle, row.kind, "kicked", "kicked");
    return { ok: true, handle: row.handle, kind: row.kind };
  }

  /**
   * A browser with no session asks to sign in (`POST /api/web/pair/start`,
   * issue #47): makes a pairing and returns `{ code, poll_secret,
   * expires_in_ms }`. Anyone can call it, so a request over the limits (the
   * board's live pairings, or this source's) is refused as `rate_limited`
   * through the failed sign-in guards, which write a row for the first few
   * and then count and summarize, never one row per request. Allowed
   * starts are audited (actor `anonymous`, `via = web`); the code and poll
   * secret are never written down.
   */
  webPairStart(info: {
    source?: string | undefined;
    /** A short summary of the browser; cleaned and cut here. */
    label?: string | undefined;
    requestId?: string | undefined;
  }): ActResult<{ code: string; poll_secret: string; expires_in_ms: number }> {
    const source = (info.source ?? "unknown").slice(0, MAX_SOURCE_LENGTH);
    this.flushAuthWindows();
    const room = pairingRoom(this.#sql, this.config, this.#now(), source);
    if (room !== "ok") {
      const refused = this.#denySignIn(
        source,
        { via: "web", requestId: info.requestId, endpoint: "/api/web/pair/start" },
        room === "busy" ? "pairing_board_full" : "pairing_source_full",
        ANONYMOUS_ACTOR,
      );
      return refusal("rate_limited", "too many sign-in requests right now; try again in a few minutes", refused);
    }
    return this.#run(
      { handle: ANONYMOUS_ACTOR.handle, via: "web", requestId: info.requestId },
      "web_pair_start",
      webPairStart,
      { source, label: info.label ?? "" },
      () => ANONYMOUS_ACTOR,
    ) as ActResult<{ code: string; poll_secret: string; expires_in_ms: number }>;
  }

  /**
   * The browser polls with its poll secret (`POST /api/web/pair/claim`).
   * `{ status: "pending" }` while nobody approved (not audited),
   * `{ status: "expired" }` once the code ran out, and, once a person approved
   * it, one audited claim that makes the web session: `{ status: "approved",
   * session, id, handle, expires_at, max_age_ms }`, where `session` is the
   * cookie value for the shell to set (never audited). An unknown or
   * already-used poll secret is refused and counts as a failed sign-in for
   * the source.
   */
  webPairClaim(info: {
    pollSecret: string | undefined | null;
    source?: string | undefined;
    requestId?: string | undefined;
  }): ActResult<Record<string, unknown>> {
    const source = (info.source ?? "unknown").slice(0, MAX_SOURCE_LENGTH);
    this.flushAuthWindows();
    const deny = (reason: string): ActResult<Record<string, unknown>> =>
      refusal(
        "unauthorized",
        `authentication failed: ${reason}`,
        this.#denySignIn(source, { via: "web", requestId: info.requestId, endpoint: "/api/web/pair/claim" }, reason, ANONYMOUS_ACTOR),
      );
    const secret = info.pollSecret;
    if (!secret) return deny("missing_poll_secret");
    if (secret.length > MAX_TOKEN_LENGTH) return deny("poll_secret_too_long");
    const now = this.#now();
    const row = this.#sql.one<{ id: number; state: string; expires_at: number; approved_by: string | null; approval_hash: string | null }>(
      "SELECT id, state, expires_at, approved_by, approval_hash FROM web_pairings WHERE poll_hash = ?",
      this.#sha256(secret),
    );
    if (!row || row.state === "consumed") return deny("unknown_poll_secret");
    const ok = (value: Record<string, unknown>): ActResult<Record<string, unknown>> => ({
      ok: true,
      value,
      notifications: [],
      auditSeq: undefined,
    });
    if (Number(row.expires_at) <= now) return ok({ status: "expired" });
    if (row.state === "pending" || row.approved_by === null) {
      // When the person's CLI asked for a passkey's approval of this pairing, the browser that holds the
      // poll secret may open it: the secret id is derived from the poll secret (`pollApprovalId`).
      const waiting = this.#sql.one<{ match_code: string; expires_at: number }>(
        `SELECT match_code, expires_at FROM approvals
         WHERE pairing = ? AND state = 'pending' AND expires_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        row.id,
        now,
      );
      const approvalId = pollApprovalId(this.#sha256, secret);
      const approval =
        waiting && row.approval_hash === this.#sha256(approvalId)
          ? { approval: approvalId, match_code: waiting.match_code, approval_expires_in_ms: Number(waiting.expires_at) - now }
          : {};
      return ok({ status: "pending", expires_in_ms: Number(row.expires_at) - now, ...approval });
    }
    const ctx: CallContext = { handle: row.approved_by, via: "web", requestId: info.requestId };
    const r = this.#run(ctx, "web_pair_claim", webPairClaim, { poll_secret: secret }, () => this.#loadActor(ctx), {
      userCall: true,
    });
    return r.ok ? { ...r, value: { status: "approved", ...(r.value as Record<string, unknown>) } } : r;
  }

  // ---------------------------------------------------------------------
  // Passkey sign-in (issue #54, design §12). The Worker derives `rpId` (the
  // web view's hostname) and `origin` from the request and passes them in.

  /**
   * A person in a web session asks to register a passkey
   * (`POST /api/web/passkey/register/start`): returns the browser's creation
   * options. `ctx` is the session's person, from the cookie; a session made by
   * a passkey is refused. Audited as the person.
   */
  passkeyRegisterStart(ctx: CallContext, info: { rpId: string; origin: string; source?: string | undefined }): ActResult {
    const source = (info.source ?? "unknown").slice(0, MAX_SOURCE_LENGTH);
    return this.#run(ctx, "passkey_register_start", passkeyRegisterStart, { rp_id: info.rpId, origin: info.origin, source }, () => this.#loadActor(ctx), {
      userCall: true,
    });
  }

  /**
   * The browser's answer to the creation options
   * (`POST /api/web/passkey/register/finish`). The checks that need Web Crypto
   * run first (the one `await`, reads only); a failed one is a refusal audited
   * as the person. Then the synchronous `passkey_register` write, with no
   * `await` between.
   */
  async passkeyRegisterFinish(
    ctx: CallContext,
    info: { rpId: string; origin: string; credential: unknown; label?: unknown },
  ): Promise<ActResult> {
    const env = { sql: this.#sql, sha256: this.#sha256, now: this.#now(), config: this.config };
    const checked = await checkRegistration(env, ctx, info);
    if (!checked.ok) {
      return this.refuse(ctx, "passkey_register", "that passkey was not accepted", { why: checked.reason }, "bad_request");
    }
    return this.#run(ctx, "passkey_register", passkeyRegisterFinish, checked.write, () => this.#loadActor(ctx), { userCall: true });
  }

  /**
   * A browser with no session asks to sign in with a passkey
   * (`POST /api/web/passkey/signin/start`): returns the request options.
   * Anyone can call it, so a request over the limits is refused as
   * `rate_limited` through the failed sign-in guards (a row for the first few,
   * then counted), like a pairing start. Allowed starts are audited as
   * `anonymous`; the challenge is never written down.
   */
  passkeySigninStart(info: {
    rpId: string;
    origin: string;
    source?: string | undefined;
    requestId?: string | undefined;
  }): ActResult<Record<string, unknown>> {
    const source = (info.source ?? "unknown").slice(0, MAX_SOURCE_LENGTH);
    this.flushAuthWindows();
    const room = signinRoom(this.#sql, this.config, this.#now(), source);
    if (room !== "ok") {
      const refused = this.#denySignIn(
        source,
        { via: "web", requestId: info.requestId, endpoint: "/api/web/passkey/signin/start" },
        room === "busy" ? "passkey_board_full" : "passkey_source_full",
        ANONYMOUS_ACTOR,
      );
      return refusal("rate_limited", "too many sign-in requests right now; try again in a few minutes", refused);
    }
    return this.#run(
      { handle: ANONYMOUS_ACTOR.handle, via: "web", requestId: info.requestId },
      "passkey_signin_start",
      passkeySigninStart,
      { rp_id: info.rpId, origin: info.origin, source },
      () => ANONYMOUS_ACTOR,
    ) as ActResult<Record<string, unknown>>;
  }

  /**
   * The browser's answer to the request options
   * (`POST /api/web/passkey/signin/finish`): checks the assertion (see
   * `checkSignin`; the one `await`, reads only), then one synchronous write
   * spends the challenge, moves the sign count and makes a web session
   * (`method = passkey`), answering like a pairing claim: `{ status:
   * "approved", session, id, handle, expires_at, max_age_ms }`, where `session`
   * is the cookie value for the shell to set (never audited). Every refusal
   * (a bad signature, a spent challenge, a sign count that did not increase)
   * goes through the failed sign-in guards, never a row per request, and
   * removes nothing.
   */
  async passkeySigninFinish(info: {
    rpId: string;
    origin: string;
    credential: unknown;
    /** A short summary of the browser; cleaned and cut here. */
    label?: string | undefined;
    source?: string | undefined;
    requestId?: string | undefined;
  }): Promise<ActResult<Record<string, unknown>>> {
    const source = (info.source ?? "unknown").slice(0, MAX_SOURCE_LENGTH);
    this.flushAuthWindows();
    const deny = (reason: string, extra: Record<string, unknown> = {}): ActResult<Record<string, unknown>> =>
      refusal(
        "unauthorized",
        `authentication failed: ${reason}`,
        this.#denySignIn(source, { via: "web", requestId: info.requestId, endpoint: "/api/web/passkey/signin/finish" }, `passkey_${reason}`, ANONYMOUS_ACTOR, extra),
      );
    const env = { sql: this.#sql, sha256: this.#sha256, now: this.#now(), config: this.config };
    const checked = await checkSignin(env, info);
    if (!checked.ok || checked.handle === undefined) {
      return deny(checked.ok ? "unknown_credential" : checked.reason, checked.ok ? {} : (checked.extra ?? {}));
    }
    const ctx: CallContext = { handle: checked.handle, via: "web", requestId: info.requestId };
    const r = this.#run(
      ctx,
      "passkey_signin",
      passkeySignin,
      { ...checked.write, label: cleanLabel(info.label ?? "") },
      () => this.#loadActor(ctx),
      // A refusal here is counted by the guards below, not given a row of its own.
      { userCall: true, countRefusal: (e) => e.result === "denied" },
    );
    if (!r.ok) return deny(r.error.code === "internal" ? "internal" : r.error.message, { passkey: checked.write.passkey });
    return { ...r, value: { status: "approved", ...(r.value as Record<string, unknown>) } };
  }

  // ---------------------------------------------------------------------
  // Passkeys as approvers (issue #54, design §12). The Worker derives `rpId`
  // and `origin` from the request on the web host, as for sign-in.

  /**
   * A browser opens an approval request (`POST /api/web/approval/start`): its
   * scope, the match code and the WebAuthn request options for the person's
   * approving passkeys. A read: not audited, and the secret id is the only
   * proof the caller needs. A refusal (unknown, expired, decided, or no
   * passkey left that may approve) goes through the failed sign-in guards.
   */
  approvalStart(info: {
    approval: string | undefined;
    rpId: string;
    origin: string;
    source?: string | undefined;
    requestId?: string | undefined;
  }): ActResult<Record<string, unknown>> {
    const source = (info.source ?? "unknown").slice(0, MAX_SOURCE_LENGTH);
    this.flushAuthWindows();
    const env = { sql: this.#sql, sha256: this.#sha256, now: this.#now(), config: this.config, approval: this.#approval };
    const started = approvalStartOptions(env, info.approval ?? "", info.rpId);
    if (!started.ok) {
      const refused = this.#denySignIn(
        source,
        { via: "web", requestId: info.requestId, endpoint: "/api/web/approval/start" },
        `approval_${started.reason}`,
        ANONYMOUS_ACTOR,
      );
      return refusal(approvalRefusal(started.reason).code, approvalRefusal(started.reason).message, refused);
    }
    return { ok: true, value: started.value, notifications: [], auditSeq: undefined };
  }

  /**
   * The browser's assertion for an approval (`POST /api/web/approval/finish`).
   * The checks that need Web Crypto run first (see `checkApproval`; the one
   * `await`, reads only), then one synchronous write, with no `await` between,
   * spends the request, moves the sign count and runs the gated action's
   * change (`approvalFinish`), audited under that action's own name as the
   * person, `via = web`. Answers `{ status: "approved", action, result }`,
   * where `result` is the action's normal result (for a connector it holds the
   * authorization code, for the Worker's redirect only). Every refusal goes
   * through the failed sign-in guards, never a row per request, and changes
   * nothing: the request is spent only when the change ran.
   */
  async approvalFinish(info: {
    approval: string | undefined;
    rpId: string;
    origin: string;
    credential: unknown;
    source?: string | undefined;
    requestId?: string | undefined;
  }): Promise<ActResult<Record<string, unknown>>> {
    const source = (info.source ?? "unknown").slice(0, MAX_SOURCE_LENGTH);
    this.flushAuthWindows();
    const deny = (
      reason: string,
      message?: string,
      extra: Record<string, unknown> = {},
      code?: ErrorCode,
    ): ActResult<Record<string, unknown>> => {
      const known = approvalRefusal(reason);
      return refusal(
        code ?? known.code,
        message ?? known.message,
        this.#denySignIn(source, { via: "web", requestId: info.requestId, endpoint: "/api/web/approval/finish" }, `approval_${reason}`, ANONYMOUS_ACTOR, extra),
      );
    };
    const env = { sql: this.#sql, sha256: this.#sha256, now: this.#now(), config: this.config, approval: this.#approval };
    const checked = await checkApproval(env, { ...info, approval: info.approval ?? "" });
    if (!checked.ok) return deny(checked.reason, undefined, checked.extra);
    const ctx: CallContext = { handle: checked.handle, via: "web", requestId: info.requestId };
    const r = this.#run(ctx, checked.action, approvalFinish, checked.write, () => this.#loadActor(ctx), {
      userCall: true,
      // A refusal here is counted by the guards below, not given a row of its own.
      countRefusal: (e) => e.result === "denied",
    });
    if (!r.ok) {
      if (r.error.code === "internal") return deny("internal", "the approval could not be completed", { passkey: checked.write.passkey });
      const own = /^approval_[a-z_]+$/.test(r.error.message);
      return deny(
        own ? r.error.message.slice("approval_".length) : "change_refused",
        own ? undefined : r.error.message,
        { passkey: checked.write.passkey, ...(own ? {} : { why: r.error.message.slice(0, 200) }) },
        own ? undefined : r.error.code,
      );
    }
    return { ...r, value: { status: "approved", ...(r.value as Record<string, unknown>) } };
  }

  /**
   * Resolve a web session cookie value to its person (issue #47). Refusals go
   * through the failed sign-in guards like a bad token. A session works while
   * it has not expired and its person is a human and `active`; one used more
   * than `webSessionRenewAfterMs` after its last renewal is renewed through
   * `act` (`web_session_renew`, one audit row per session per period). The
   * result carries `webSession`, the session's public id, for the call's
   * context.
   */
  authenticateWebSession(
    cookie: string | undefined | null,
    info: { requestId?: string | undefined; endpoint?: string | undefined; source?: string | undefined },
  ): AuthResult {
    const source = (info.source ?? "unknown").slice(0, MAX_SOURCE_LENGTH);
    this.flushAuthWindows();
    const via: Via = "web";
    const deny = (reason: string, actor: Actor = ANONYMOUS_ACTOR): AuthResult =>
      this.#denySignIn(source, { via, requestId: info.requestId, endpoint: info.endpoint }, reason, actor);
    if (!cookie) return deny("missing_session");
    // Refused, not truncated, like a bearer token.
    if (cookie.length > MAX_TOKEN_LENGTH) return deny("session_too_long");
    const now = this.#now();
    const row = this.#sql.one<{
      id: string;
      handle: string;
      renewed_at: number;
      expires_at: number;
      kind: UserKind;
      status: Actor["status"];
    }>(
      `SELECT s.id, s.handle, s.renewed_at, s.expires_at, u.kind, u.status
       FROM web_sessions s JOIN users u ON u.handle = s.handle WHERE s.token_hash = ?`,
      this.#sha256(cookie),
    );
    if (!row) return deny("unknown_session");
    if (Number(row.expires_at) <= now) return deny("expired_session");
    if (row.kind !== "human" || row.status !== "active") {
      return deny("revoked_session", { handle: row.handle, kind: row.kind, isAdmin: false, isCoordinator: false, status: row.status });
    }
    if (now - Number(row.renewed_at) > this.config.webSessionRenewAfterMs) {
      const ctx: CallContext = { handle: row.handle, via, requestId: info.requestId, webSession: row.id };
      const r = this.#run(ctx, "web_session_renew", webSessionRenew, { id: row.id }, () => this.#loadActor(ctx));
      if (r.ok) {
        return { ok: true, handle: row.handle, kind: "human", webSession: row.id, renewed: true, maxAgeMs: this.config.webSessionTtlMs };
      }
    }
    return { ok: true, handle: row.handle, kind: "human", webSession: row.id };
  }

  // ---------------------------------------------------------------------
  // OAuth on `/mcp` (issue #55, design §9 "Connectors"). The Worker is the
  // HTTP layer; these are the board's side of each route.

  /**
   * Whether the board holds a copy of the client's metadata document newer
   * than `oauthClientCacheMs` (read-only, not audited), so the Worker knows
   * whether to fetch it before asking `oauthRequest`.
   */
  oauthClientFresh(clientId: string): boolean {
    return cachedClient(this.#sql, this.config, this.#now(), clientId) !== undefined;
  }

  /**
   * The consent page's first call (`POST /api/web/oauth/request`): validate
   * an authorization request and store it as pending. `ctx` is the signed-in
   * web session's person (the Worker took it from the cookie); only the human
   * admin is accepted. See `oauthRequest`.
   */
  oauthRequest(ctx: CallContext, params: unknown): ActResult {
    return this.#run(ctx, "oauth_request", oauthRequest, params, () => this.#loadActor(ctx), { userCall: true });
  }

  /** The consent page's second call (`POST /api/web/oauth/decide`): approve or deny a pending request. See `oauthDecide`. */
  oauthDecide(ctx: CallContext, params: unknown): ActResult {
    return this.#run(ctx, "oauth_decide", oauthDecide, params, () => this.#loadActor(ctx), { userCall: true });
  }

  /**
   * Authenticate the client of a `POST /oauth/token` or `POST /oauth/revoke`
   * request (design §9 "Client authentication"). A public client (stored
   * method `none`) sends its `client_id` and no assertion. A client whose
   * document asked for `private_key_jwt` must send a signed assertion, whose
   * rules and signature are checked here, before the write: Web Crypto's
   * verify is asynchronous and the board's actions are not, so this is the one
   * `await`, and everything after it (`oauthToken`, `oauthRevoke`) is
   * synchronous. The assertion's `jti` is spent by that write, not here. The
   * client is named by `client_id`, else by the assertion's `iss`; when both
   * are present they must match. A refusal is `invalid_client` and goes
   * through the failed sign-in guards. It never ends a grant: a bad or
   * replayed assertion is not evidence that a refresh token was stolen. The
   * one refusal that is not counted is an unknown `kid` for a client with a
   * `jwks_uri` (`refetchKeys`), asked again once with `keysRefetched`.
   */
  async authenticateOAuthClient(info: {
    clientId: string | undefined;
    assertionType?: string | undefined;
    assertion?: string | undefined;
    /** The addresses an assertion's `aud` may name: this board's issuer and the endpoint's URL. */
    audiences: readonly string[];
    endpoint: "/oauth/token" | "/oauth/revoke";
    keysRefetched?: boolean | undefined;
    source?: string | undefined;
    requestId?: string | undefined;
  }): Promise<OAuthClientAuthResult> {
    const source = (info.source ?? "unknown").slice(0, MAX_SOURCE_LENGTH);
    this.flushAuthWindows();
    const where = { via: "api" as const, requestId: info.requestId, endpoint: info.endpoint };
    const field = info.clientId || undefined;
    if (field !== undefined && field.length > MAX_TOKEN_LENGTH * 4) {
      return { ok: false, error: "invalid_request", description: "client_id is required" };
    }
    const assertion = info.assertion || undefined;
    const signed = assertion !== undefined || !!info.assertionType;
    const refuse = (why: string, extra: Record<string, unknown> = {}): OAuthClientAuthResult =>
      this.#oauthRefusal(source, where, "invalid_client", "client authentication failed", why, {
        client_auth: signed ? "private_key_jwt" : "none",
        ...(field !== undefined ? { client: field.slice(0, 200) } : {}),
        ...extra,
      });
    let clientId = field;
    if (signed) {
      if (assertion === undefined || info.assertionType !== ASSERTION_TYPE) return refuse("assertion_malformed");
      if (assertion.length > this.config.oauthAssertionMaxBytes) return refuse("assertion_too_long");
      const iss = peekIssuer(assertion);
      if (iss === undefined) return refuse("assertion_malformed");
      if (field !== undefined && field !== iss) return refuse("assertion_client_mismatch");
      clientId = iss;
    }
    if (clientId === undefined) return { ok: false, error: "invalid_request", description: "client_id or client_assertion is required" };
    const stored = storedClientAuth(this.#sql, clientId);
    if (!signed) {
      // A signing client must sign: its row is kept while it has a live grant, so it cannot be missing here.
      if (stored !== undefined && stored.method !== "none") return refuse("assertion_missing");
      return { ok: true, auth: { clientId, method: "none" } };
    }
    if (stored === undefined) return refuse("assertion_unknown_client", { client: clientId.slice(0, 200) });
    if (stored.method !== "private_key_jwt") return refuse("assertion_from_public_client", { client: clientId.slice(0, 200) });
    const v = await verifyAssertion({
      assertion: assertion as string,
      clientId,
      keys: stored.keys,
      declaredAlg: stored.alg,
      audiences: info.audiences,
      now: this.#now(),
      config: this.config,
    });
    if (!v.ok) {
      if (v.unknownKid === true && stored.hasJwksUri && info.keysRefetched !== true) {
        return { ok: false, error: "invalid_client", description: "client authentication failed", refetchKeys: clientId };
      }
      return refuse("assertion_invalid", { client: clientId.slice(0, 200), why: v.reason });
    }
    return {
      ok: true,
      auth: { clientId, method: "private_key_jwt", jti: { hash: this.#sha256(v.jti), expiresAt: v.expiresAt, alg: v.alg, kid: v.kid } },
    };
  }

  /**
   * Whether the shell may fetch a client's key set again, and from where: the
   * claim is a write (`oauthKeyRefetch`) that succeeds at most once per
   * `oauthJwksRefetchMs` per client, however many requests ask. Returns the
   * address, or null when the client has none or its set was fetched too
   * recently. A refusal writes nothing (no row per request).
   */
  oauthClaimKeyRefetch(clientId: string, requestId?: string): string | null {
    const row = this.#sql.one<{ jwks_uri: string | null; jwks_fetched_at: number; auth_method: string }>(
      "SELECT jwks_uri, jwks_fetched_at, auth_method FROM oauth_clients WHERE client_id = ?",
      clientId,
    );
    if (!row || row.auth_method !== "private_key_jwt" || row.jwks_uri === null) return null;
    if (Number(row.jwks_fetched_at) > this.#now() - this.config.oauthJwksRefetchMs) return null;
    const r = this.#run({ handle: "system", via: "system", requestId }, "oauth_key_refetch", oauthKeyRefetch, { client_id: clientId }, () => SYSTEM_ACTOR);
    return r.ok ? (r.value as { uri: string }).uri : null;
  }

  /** Store a client's key set the shell fetched after `oauthClaimKeyRefetch`; false when the board refused it (it is audited). */
  oauthStoreKeys(clientId: string, jwks: unknown, requestId?: string): boolean {
    const r = this.#run({ handle: "system", via: "system", requestId }, "oauth_keys_store", oauthKeysStore, { client_id: clientId, jwks }, () => SYSTEM_ACTOR);
    return r.ok;
  }

  /**
   * `POST /oauth/token`: an authorization code or a refresh token for a new
   * token pair. The client was authenticated first (`authenticateOAuthClient`,
   * passed as `clientAuth`); without it only a public client is accepted. The
   * secrets are the credential, and every refusal goes through the failed
   * sign-in guards (a row for the first few, then counted). `resource` is this
   * board's `/mcp`, from the Worker. A second use of a code, or a use of a
   * refresh token older than the previous one, also ends the grant.
   */
  oauthToken(info: {
    params: OAuthTokenParams;
    resource: string;
    clientAuth?: OAuthClientAuth | undefined;
    source?: string | undefined;
    requestId?: string | undefined;
  }): OAuthTokenResult {
    const source = (info.source ?? "unknown").slice(0, MAX_SOURCE_LENGTH);
    this.flushAuthWindows();
    const where = { via: "api" as const, requestId: info.requestId, endpoint: "/oauth/token" };
    const fail = (error: OAuthErrorCode, description: string, reason: string): OAuthTokenResult =>
      this.#oauthRefusal(source, where, error, description, reason);
    const p = info.params;
    const clientId = info.clientAuth?.clientId ?? p.client_id;
    if (!clientId || clientId.length > MAX_TOKEN_LENGTH * 4) {
      return { ok: false, error: "invalid_request", description: "client_id is required" };
    }
    const method = info.clientAuth?.method ?? "none";
    if (info.clientAuth === undefined && storedClientAuth(this.#sql, clientId)?.method === "private_key_jwt") {
      return fail("invalid_client", "client authentication failed", "assertion_missing");
    }
    const ctx: CallContext = { handle: "system", via: "system", requestId: info.requestId };
    const now = this.#now();
    const extraDetail = { client_auth: method };
    const spent = this.#spendAssertion(ctx, clientId, info.clientAuth);
    if (!spent) return fail("invalid_client", "client authentication failed", "assertion_replay");
    if (p.grant_type === "authorization_code") {
      const { code, code_verifier: verifier, redirect_uri: redirectUri, resource } = p;
      if (!code || !verifier || !redirectUri || !resource) {
        return { ok: false, error: "invalid_request", description: "code, code_verifier, client_id, redirect_uri and resource are required" };
      }
      if (code.length > MAX_TOKEN_LENGTH || verifier.length > MAX_TOKEN_LENGTH) return fail("invalid_grant", "invalid code", "code_too_long");
      if (resource !== info.resource) return fail("invalid_target", "resource must be this board's /mcp address", "resource_mismatch");
      const params = { code, clientId, redirectUri, resource, codeVerifier: verifier };
      const c = checkCode(this.#sql, this.#sha256, now, params);
      if (c.kind === "used") {
        // A second use of a code: whoever holds the grant's tokens may be the thief, so it ends.
        this.#run(ctx, "oauth_grant_ended", oauthGrantEnded, { grant: c.grantId, reason: "code_replay" }, () => SYSTEM_ACTOR, { extraDetail });
        return fail("invalid_grant", "that code was already used; the approval it made has been ended", "code_replay");
      }
      if (c.kind !== "ok") return fail("invalid_grant", "that code is not valid", `${c.kind}_code`);
      const r = this.#run(
        ctx,
        "oauth_code_exchange",
        oauthCodeExchange,
        { code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri, resource },
        () => SYSTEM_ACTOR,
        { extraDetail },
      );
      return r.ok ? { ok: true, value: r.value as TokenValue } : fail("invalid_grant", "that code is not valid", "exchange_refused");
    }
    if (p.grant_type === "refresh_token") {
      const { refresh_token: token, resource } = p;
      if (!token || !resource) return { ok: false, error: "invalid_request", description: "refresh_token, client_id and resource are required" };
      if (token.length > MAX_TOKEN_LENGTH) return fail("invalid_grant", "invalid refresh token", "token_too_long");
      const c = checkRefresh(this.#sql, this.config, this.#sha256, now, token, clientId, resource, info.resource);
      if (c.kind === "replay") {
        this.#run(ctx, "oauth_grant_ended", oauthGrantEnded, { grant: c.grantId, reason: "refresh_replay" }, () => SYSTEM_ACTOR, { extraDetail });
        return fail("invalid_grant", "that refresh token was already replaced; the approval has been ended", "refresh_replay");
      }
      if (c.kind !== "ok") return fail("invalid_grant", "that refresh token is not valid", `${c.kind}_refresh`);
      const r = this.#run(ctx, "oauth_refresh", oauthRefresh, { refresh_token: token, grant: c.grantId }, () => SYSTEM_ACTOR, { extraDetail });
      return r.ok ? { ok: true, value: r.value as TokenValue } : fail("invalid_grant", "that refresh token is not valid", "refresh_refused");
    }
    return fail("unsupported_grant_type", "grant_type must be authorization_code or refresh_token", "unsupported_grant_type");
  }

  /**
   * Spend a verified assertion's `jti` (`oauthAssertionUse`): true when there
   * is nothing to spend (a public client) or the write took it, false when the
   * `jti` was already used or the client is at its cap.
   */
  #spendAssertion(ctx: CallContext, clientId: string, auth: OAuthClientAuth | undefined): boolean {
    const jti = auth?.jti;
    if (jti === undefined) return true;
    const r = this.#run(
      ctx,
      "oauth_assertion_use",
      oauthAssertionUse,
      { client_id: clientId, jti_hash: jti.hash, expires_at: jti.expiresAt, alg: jti.alg, kid: jti.kid ?? undefined },
      () => SYSTEM_ACTOR,
    );
    return r.ok;
  }

  /** A refused OAuth request, counted by the failed sign-in guards; past the limit it is `temporarily_unavailable`. */
  #oauthRefusal(
    source: string,
    where: { via: Via; requestId: string | undefined; endpoint: string },
    error: OAuthErrorCode,
    description: string,
    reason: string,
    detail?: Record<string, unknown>,
  ): OAuthFailure {
    const r = this.#denySignIn(source, { ...where, ...(detail ? { detail } : {}) }, reason, ANONYMOUS_ACTOR);
    if (!r.ok && r.reason === "rate_limited") {
      return {
        ok: false,
        error: "temporarily_unavailable",
        description: "too many failed requests; try again later",
        ...(r.retryAfterMs !== undefined ? { retryAfterMs: r.retryAfterMs } : {}),
      };
    }
    return { ok: false, error, description };
  }

  /**
   * `POST /oauth/revoke`: a client gives up one of its tokens, which ends the
   * grant the token belongs to. The client is authenticated first, as for the
   * token endpoint (`authenticateOAuthClient`, passed as `clientAuth`). A
   * token the board does not know is answered as success (RFC 7009) but
   * counted as a failed sign-in; another client's token is refused.
   */
  oauthRevoke(info: {
    token: string | undefined;
    clientId: string | undefined;
    clientAuth?: OAuthClientAuth | undefined;
    source?: string | undefined;
    requestId?: string | undefined;
  }): { ok: true } | OAuthFailure {
    const source = (info.source ?? "unknown").slice(0, MAX_SOURCE_LENGTH);
    this.flushAuthWindows();
    const where = { via: "api" as const, requestId: info.requestId, endpoint: "/oauth/revoke" };
    const counted = (reason: string): { retryAfterMs?: number } | undefined => {
      const r = this.#denySignIn(source, where, reason, ANONYMOUS_ACTOR);
      return !r.ok && r.reason === "rate_limited" ? { retryAfterMs: r.retryAfterMs ?? 1_000 } : undefined;
    };
    const clientId = info.clientAuth?.clientId ?? info.clientId;
    if (!info.token || !clientId) {
      return { ok: false, error: "invalid_request", description: "token and client_id are required" };
    }
    const method = info.clientAuth?.method ?? "none";
    if (info.clientAuth === undefined && storedClientAuth(this.#sql, clientId)?.method === "private_key_jwt") {
      return this.#oauthRefusal(source, where, "invalid_client", "client authentication failed", "assertion_missing");
    }
    const ctx: CallContext = { handle: "system", via: "system", requestId: info.requestId };
    if (!this.#spendAssertion(ctx, clientId, info.clientAuth)) {
      return this.#oauthRefusal(source, where, "invalid_client", "client authentication failed", "assertion_replay");
    }
    if (info.token.length > MAX_TOKEN_LENGTH) {
      const limited = counted("token_too_long");
      return limited ? { ok: false, error: "temporarily_unavailable", description: "too many failed requests; try again later", ...limited } : { ok: true };
    }
    const hash = this.#sha256(info.token);
    const grant = this.#sql.one<{ id: string; client_id: string }>(
        `SELECT g.id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
         WHERE t.access_hash = ? OR t.refresh_hash = ?`,
      hash,
      hash,
    );
    if (!grant) {
      const limited = counted("unknown_token");
      return limited ? { ok: false, error: "temporarily_unavailable", description: "too many failed requests; try again later", ...limited } : { ok: true };
    }
    if (grant.client_id !== clientId) {
      const limited = counted("client_mismatch");
      return limited
        ? { ok: false, error: "temporarily_unavailable", description: "too many failed requests; try again later", ...limited }
        : { ok: false, error: "invalid_client", description: "that token belongs to another client" };
    }
    const r = this.#run(
      ctx,
      "oauth_grant_ended",
      oauthGrantEnded,
      { grant: grant.id, reason: "client_revoke" },
      () => SYSTEM_ACTOR,
      { extraDetail: { client_auth: method } },
    );
    return r.ok ? { ok: true } : { ok: false, error: "invalid_request", description: "could not end the approval" };
  }

  /**
   * A refused sign-in under the failed sign-in guards (B5, B30): the first
   * `authFailureLimit` per source and window get an `auth` row each, then one
   * `sign_in_limited` row, then the rest are counted and written as one
   * summary when the window ends; the board-wide cap bounds all sources
   * together. Used by `authenticate`, and by the web pairing and session
   * paths for their refusals, which an unauthenticated caller can repeat.
   */
  #denySignIn(
    source: string,
    info: {
      via: Via;
      requestId?: string | undefined;
      endpoint?: string | undefined;
      detail?: Record<string, unknown> | undefined;
    },
    reason: string,
    actor: Actor,
    extra: Record<string, unknown> = {},
  ): AuthResult {
    const now = this.#now();
    const w = this.#authWindow(source, now);
    const retryAfterMs = Math.max(0, w.start + this.config.authFailureWindowMs - now);
    const where = { ...info.detail, ...extra, endpoint: info.endpoint ?? null, source };
    if (w.audited < this.config.authFailureLimit) {
      // The source's own count advances whether or not the board admits the
      // row, so one source spending the board cap cannot switch off the
      // per-source limit (and its 429) for everyone.
      w.audited += 1;
      // Board-wide cap (B30): past it the failure is counted, not written.
      if (!this.#boardAdmits(now)) {
        return this.#boardCounted(reason, now, source, actor.handle === ANONYMOUS_ACTOR.handle ? undefined : actor.handle);
      }
      const r = this.#run(
        { handle: actor.handle, via: info.via, requestId: info.requestId },
        "auth",
        authDenied,
        { reason },
        () => actor,
        { extraDetail: { ...where, ...(w.audited === this.config.authFailureLimit ? { limit_reached: true } : {}) } },
      );
      return { ok: false, reason, auditSeq: r.auditSeq ?? 0 };
    }
    if (!w.limited && this.#boardAdmits(now)) {
      // The first refusal past the limit gets one row saying the source is limited.
      w.limited = true;
      const r = this.#run(
        { handle: actor.handle, via: info.via, requestId: info.requestId },
        "sign_in_limited",
        signInLimited,
        {},
        () => actor,
        // `failure`: why this sign-in failed; `reason` holds the refusal text.
        { extraDetail: { ...where, failure: reason, window_ms: this.config.authFailureWindowMs } },
      );
      return { ok: false, reason: "rate_limited", auditSeq: r.auditSeq ?? 0, retryAfterMs };
    }
    w.suppressed[reason] = (w.suppressed[reason] ?? 0) + 1;
    w.total += 1;
    return { ok: false, reason: "rate_limited", auditSeq: undefined, retryAfterMs };
  }

  /**
   * The current failed sign-in window for `source` (B5), starting a new one
   * when there is none. Ended windows were flushed by `flushAuthWindows`.
   */
  #authWindow(source: string, now: number): AuthWindow {
    const existing = this.#authWindows.get(source);
    if (existing && now - existing.start < this.config.authFailureWindowMs) return existing;
    if (existing) this.#flushWindow(source, existing, now, false);
    const w: AuthWindow = { start: now, audited: 0, limited: false, suppressed: {}, total: 0 };
    this.#authWindows.set(source, w);
    // Keep the map bounded: flush and drop the oldest windows first.
    for (const [key, old] of this.#authWindows) {
      if (this.#authWindows.size <= MAX_AUTH_SOURCES) break;
      this.#flushWindow(key, old, now, true);
    }
    return w;
  }

  /**
   * Write out every failed sign-in window that has ended (B5): one
   * `sign_in_suppressed` audit row (actor `system`) per window that refused
   * sign-ins without a row, with counts by reason, then forget the window.
   * Runs at the start of every `authenticate`, from any source, and from the
   * Board DO's alarm.
   */
  flushAuthWindows(): void {
    const now = this.#now();
    for (const [key, w] of this.#authWindows) {
      // Oldest first: stop at the first window still running.
      if (now - w.start < this.config.authFailureWindowMs) break;
      this.#flushWindow(key, w, now, false);
    }
    // After the per-source windows, which may add to the board-wide one.
    const b = this.#authBoard;
    if (b && now - b.start >= this.config.authFailureBoardWindowMs) this.#flushBoardWindow();
    this.#flushSocketWindows();
    this.#flushJoinWindows();
  }

  /**
   * A `bbs_join` was refused by the per-handle limit on new sessions (issue
   * #43). Returns false for the first refusal in a window, which `#run` audits
   * as `denied`, and true for the rest, which are counted here and written as
   * one `join_rate_suppressed` row when the window ends. So a join loop writes
   * at most the joins the limit allows, plus two rows per window.
   */
  #joinRefusalCounted(handle: string): boolean {
    const now = this.#now();
    let w = this.#joinWindows.get(handle);
    if (w && now - w.start >= this.config.joinWindowMs) {
      this.#flushJoinWindow(handle, w);
      w = undefined;
    }
    if (!w) {
      w = { start: now, limited: false, total: 0 };
      this.#joinWindows.set(handle, w);
      for (const [oldHandle, old] of this.#joinWindows) {
        if (this.#joinWindows.size <= MAX_JOIN_WINDOWS) break;
        this.#flushJoinWindow(oldHandle, old, true);
      }
    }
    if (!w.limited) {
      w.limited = true;
      return false;
    }
    w.total += 1;
    return true;
  }

  /** Write out every refused-join window that has ended (issue #43), oldest first. */
  #flushJoinWindows(): void {
    const now = this.#now();
    for (const [handle, w] of this.#joinWindows) {
      if (now - w.start < this.config.joinWindowMs) break;
      this.#flushJoinWindow(handle, w);
    }
  }

  #flushJoinWindow(handle: string, w: JoinWindow, early = false): void {
    this.#joinWindows.delete(handle);
    if (w.total === 0) return;
    this.#run({ handle: "system", via: "system" }, "join_rate_suppressed", joinRateSuppressed, {}, () => SYSTEM_ACTOR, {
      extraDetail: {
        handle,
        window_start: w.start,
        window_ms: this.config.joinWindowMs,
        total: w.total,
        ...(early ? { early: true } : {}),
      },
    });
  }

  /**
   * Whether the board may write one more failed sign-in row now (B30),
   * counting it against the board-wide window. One synchronous check and
   * increment: the caller writes the row only on `true`.
   */
  #boardAdmits(now: number): boolean {
    const b = this.#boardWindow(now);
    if (b.audited >= this.config.authFailureBoardLimit) return false;
    b.audited += 1;
    return true;
  }

  /** The current board-wide failed sign-in window, started when there is none. */
  #boardWindow(now: number): BoardAuthWindow {
    const existing = this.#authBoard;
    if (existing && now - existing.start < this.config.authFailureBoardWindowMs) return existing;
    if (existing) this.#flushBoardWindow();
    const w: BoardAuthWindow = {
      start: now,
      audited: 0,
      limited: false,
      suppressed: {},
      total: 0,
      bySource: new Map(),
      byHandle: new Map(),
      otherSources: 0,
      otherHandles: 0,
    };
    this.#authBoard = w;
    return w;
  }

  /**
   * A failed sign-in refused a row by the board-wide cap (B30): counted by
   * reason. The caller still gets the real reason, since the sign-in did fail
   * for it, and no retry time (the source's own limit is not what applies).
   */
  #boardCounted(reason: string, now: number, source: string, handle: string | undefined): AuthResult {
    const b = this.#boardWindow(now);
    b.suppressed[reason] = (b.suppressed[reason] ?? 0) + 1;
    b.total += 1;
    this.#attribute(b, source, handle, 1);
    return { ok: false, reason, auditSeq: undefined };
  }

  /** Add `n` counted failures to the board window's per-source and per-handle maps (bounded). */
  #attribute(b: BoardAuthWindow, source: string, handle: string | undefined, n: number): void {
    if (b.bySource.has(source) || b.bySource.size < MAX_ATTRIBUTION_KEYS) {
      b.bySource.set(source, (b.bySource.get(source) ?? 0) + n);
    } else {
      b.otherSources += n;
    }
    if (handle === undefined) return;
    if (b.byHandle.has(handle) || b.byHandle.size < MAX_ATTRIBUTION_KEYS) {
      b.byHandle.set(handle, (b.byHandle.get(handle) ?? 0) + n);
    } else {
      b.otherHandles += n;
    }
  }

  /**
   * Write the board-wide window's counts (B30) as one `sign_in_suppressed`
   * row with `scope: "board"`, then forget the window. This row is not itself
   * counted against the cap: there is one per window.
   */
  #flushBoardWindow(): void {
    const w = this.#authBoard;
    this.#authBoard = undefined;
    if (!w || w.total === 0) return;
    this.#run({ handle: "system", via: "system" }, "sign_in_suppressed", signInSuppressed, {}, () => SYSTEM_ACTOR, {
      extraDetail: {
        scope: "board",
        window_start: w.start,
        window_ms: this.config.authFailureBoardWindowMs,
        limit: this.config.authFailureBoardLimit,
        suppressed: { ...w.suppressed },
        total: w.total,
        // Who the counted failures came from, so a flood cannot hide which
        // sources and handles were tried: the top few, the rest summed.
        ...topCounts("sources", w.bySource, w.otherSources),
        ...topCounts("handles", w.byHandle, w.otherHandles),
      },
    });
  }

  #flushWindow(source: string, w: AuthWindow, now: number, early: boolean): void {
    this.#authWindows.delete(source);
    if (w.total === 0) return;
    // The summary row counts against the board-wide cap (B30); when that is
    // spent, its counts join the board-wide window's instead.
    if (!this.#boardAdmits(now)) {
      const b = this.#boardWindow(now);
      for (const [reason, n] of Object.entries(w.suppressed)) {
        b.suppressed[reason] = (b.suppressed[reason] ?? 0) + n;
      }
      b.total += w.total;
      this.#attribute(b, source, undefined, w.total);
      return;
    }
    this.#run({ handle: "system", via: "system" }, "sign_in_suppressed", signInSuppressed, {}, () => SYSTEM_ACTOR, {
      extraDetail: {
        source,
        window_start: w.start,
        window_ms: this.config.authFailureWindowMs,
        suppressed: { ...w.suppressed },
        total: w.total,
        ...(early ? { early: true, flushed_at: now } : {}),
      },
    });
  }

  /**
   * The rate limit on adapter `state`, `ring_result` and `hello` messages (B45):
   * `socketMessageLimit` per session per `socketMessageWindowMs`. A message
   * over it is refused and not applied (so no unaudited write); the first
   * refusal in a window gets a `socket_rate_limited` row and the rest are
   * counted and written as one `socket_rate_suppressed` row when the window
   * ends. The Board DO closes the socket on a refusal, and the adapter's next
   * `hello` carries its state again. Returns undefined while under the limit.
   */
  #socketRateLimit(ctx: CallContext, action: string): ActResult | undefined {
    const now = this.#now();
    const session = ctx.session as string;
    const key = `${ctx.handle}\0${session}`;
    let w = this.#socketWindows.get(key);
    if (w && now - w.start >= this.config.socketMessageWindowMs) {
      this.#flushSocketWindow(key, w);
      w = undefined;
    }
    if (!w) {
      w = { start: now, handle: ctx.handle, session, accepted: 0, limited: false, suppressed: {}, total: 0 };
      this.#socketWindows.set(key, w);
      // Keep the map bounded: write out and drop the oldest windows first.
      for (const [oldKey, old] of this.#socketWindows) {
        if (this.#socketWindows.size <= MAX_SOCKET_WINDOWS) break;
        this.#flushSocketWindow(oldKey, old, true);
      }
    }
    if (w.accepted < this.config.socketMessageLimit) {
      w.accepted += 1;
      return undefined;
    }
    if (!w.limited) {
      w.limited = true;
      return this.#run(ctx, "socket_rate_limited", socketRateLimited, {}, () => this.#loadActor(ctx), {
        userCall: true,
        extraDetail: { limited_action: action, window_ms: this.config.socketMessageWindowMs },
      });
    }
    w.suppressed[action] = (w.suppressed[action] ?? 0) + 1;
    w.total += 1;
    return {
      ok: false,
      error: { code: "rate_limited", message: SOCKET_LIMITED_MESSAGE },
      result: "denied",
      auditSeq: undefined,
      notifications: [],
    };
  }

  /** Write out every socket message window that has ended (B45), oldest first. */
  #flushSocketWindows(): void {
    const now = this.#now();
    for (const [key, w] of this.#socketWindows) {
      if (now - w.start < this.config.socketMessageWindowMs) break;
      this.#flushSocketWindow(key, w);
    }
  }

  #flushSocketWindow(key: string, w: SocketWindow, early = false): void {
    this.#socketWindows.delete(key);
    if (w.total === 0) return;
    this.#run({ handle: "system", via: "system" }, "socket_rate_suppressed", socketRateSuppressed, {}, () => SYSTEM_ACTOR, {
      extraDetail: {
        handle: w.handle,
        session: w.session,
        window_start: w.start,
        window_ms: this.config.socketMessageWindowMs,
        suppressed: { ...w.suppressed },
        total: w.total,
        ...(early ? { early: true } : {}),
      },
    });
  }

  /**
   * Create or refresh the first human admin from the static local human
   * credential (spec §4.2, Q1). Idempotent: when the user already exists as
   * a human admin with this credential and no other human admin exists,
   * nothing is written and nothing is audited, so a Worker may call it on
   * every start. Otherwise any other human admin (left by an earlier
   * `BBS_HUMAN_HANDLE`) is retired in the same audited change (B17), and a
   * replaced credential of this user is revoked.
   */
  bootstrapHuman(handle: string, tokenHash: string): ActResult<{
    handle: string;
    created: boolean;
    changed: boolean;
  }> {
    const existing = this.#sql.one<{ kind: string; is_admin: number; token_hash: string | null }>(
      "SELECT kind, is_admin, token_hash FROM users WHERE handle = ?",
      handle,
    );
    if (
      existing &&
      existing.kind === "human" &&
      Number(existing.is_admin) === 1 &&
      existing.token_hash === tokenHash &&
      !otherAdminExists(this.#sql, handle)
    ) {
      return {
        ok: true,
        value: { handle, created: false, changed: false },
        notifications: [],
        auditSeq: undefined,
      };
    }
    return this.#run(
      { handle: "system", via: "system" },
      "bootstrap_human",
      bootstrapHuman,
      { handle, token_hash: tokenHash },
      () => SYSTEM_ACTOR,
    ) as ActResult<{ handle: string; created: boolean; changed: boolean }>;
  }

  /**
   * When the earliest timer is due (ms since the epoch), or null when there
   * is none. The Board DO keeps its one alarm set to this.
   */
  nextTimerDue(): number | null {
    const row = this.#sql.one<{ due: number | null }>("SELECT MIN(due_at) AS due FROM timers");
    return row?.due === null || row?.due === undefined ? null : Number(row.due);
  }

  /**
   * Run every timer that is due, oldest first, each in its own `act`
   * transaction as the `system` actor with its own audit row. Returns the
   * results (with their notification work) in order. A timer of an unknown
   * kind, or one whose action failed, is dropped with its own audit row.
   */
  runDueTimers(limit = MAX_TIMERS_PER_RUN): ActResult[] {
    const results: ActResult[] = [];
    const ctx: CallContext = { handle: "system", via: "system" };
    while (results.length < limit) {
      const timer = this.#sql.one<{ id: number; kind: string }>(
        "SELECT id, kind FROM timers WHERE due_at <= ? ORDER BY due_at, id LIMIT 1",
        this.#now(),
      );
      if (!timer) break;
      const id = Number(timer.id);
      const def = Object.hasOwn(TIMER_ACTIONS, timer.kind) ? TIMER_ACTIONS[timer.kind] : undefined;
      const r = def
        ? this.#run(ctx, def.name, def, { timer: id }, () => SYSTEM_ACTOR)
        : this.#run(ctx, "timer_dropped", dropTimer, { timer: id, kind: timer.kind }, () => SYSTEM_ACTOR);
      results.push(r);
      if (!r.ok) {
        // A failed timer action rolled back; drop the timer so it cannot
        // fail forever. The failure has its own audit row.
        this.#run(ctx, "timer_dropped", dropTimer, { timer: id, kind: timer.kind }, () => SYSTEM_ACTOR);
      }
    }
    return results;
  }

  // ---------------------------------------------------------------------
  // Audit export (design §13, M6a). The sink write is async and runs between
  // these synchronous steps (`exportAudit` in audit-export.ts); each step
  // that writes is a system action with its own audit row.

  /**
   * When audit export or pruning is next due (ms since the epoch), or null.
   * The Board DO arms its alarm for this when it has a sink.
   */
  nextAuditExportDue(): number | null {
    const times = [exportDue(this.#sql, this.config, this.#now()), pruneDue(this.#sql, this.config)].filter(
      (t): t is number => t !== null,
    );
    return times.length === 0 ? null : Math.min(...times);
  }

  /**
   * The batch to write now, or null when none is due. A pending batch (a
   * failed or interrupted attempt) is returned again, unchanged, once its
   * retry time comes; otherwise a due export fixes a new range first
   * (`audit_export_begin`, audited).
   */
  beginAuditExport(): AuditBatch | null {
    const now = this.#now();
    const s = exportState(this.#sql);
    let range = s.pending;
    if (range) {
      if (s.retryAt !== undefined && s.retryAt > now) return null;
    } else {
      const due = exportDue(this.#sql, this.config, now);
      if (due === null || due > now) return null;
      const r = this.#run(SYSTEM_CTX, "audit_export_begin", auditExportBegin, {}, () => SYSTEM_ACTOR);
      if (!r.ok) return null;
      range = r.value as { first: number; last: number };
    }
    const rows = readAuditRows(this.#sql, range.first, range.last);
    if (rows.length !== range.last - range.first + 1) {
      // Cannot happen without someone deleting rows by hand; record it as a
      // failed attempt so it is retried later, not in a tight loop.
      this.failAuditExport({ ...range, path: "", body: "", chain: "" }, "rows of the pending batch are missing");
      return null;
    }
    return buildBatch(rows, this.#sha256, chainState(this.#sql).board_id);
  }

  /** The sink confirmed `batch`: mark its rows exported, then prune (`audit_export`). */
  confirmAuditExport(batch: AuditBatch, outcome: "created" | "exists"): ActResult {
    return this.#run(
      SYSTEM_CTX,
      "audit_export",
      auditExportConfirm,
      { first: batch.first, last: batch.last, path: batch.path, chain: batch.chain, outcome },
      () => SYSTEM_ACTOR,
    );
  }

  /** Writing `batch` failed: keep the rows, retry later (`audit_export_failed`). */
  failAuditExport(batch: AuditBatch, error: string): ActResult {
    return this.#run(
      SYSTEM_CTX,
      "audit_export_failed",
      auditExportFailed,
      { first: batch.first, last: batch.last, error },
      () => SYSTEM_ACTOR,
    );
  }

  /** Delete exported rows past the hot period when due (`audit_prune`), or null. */
  pruneAudit(): ActResult | null {
    const due = pruneDue(this.#sql, this.config);
    if (due === null || due > this.#now()) return null;
    return this.#run(SYSTEM_CTX, "audit_prune", auditPrune, {}, () => SYSTEM_ACTOR);
  }

  // ---------------------------------------------------------------------
  // Topic archiving and cold storage (design §14, M6b).

  /**
   * Start the archive scan timer when there is none (audited, once per
   * board). The Board DO calls it at start; the scan re-arms itself.
   */
  ensureArchiveScan(): ActResult | null {
    if (this.#sql.one("SELECT 1 AS x FROM timers WHERE kind = 'archive_scan'")) return null;
    return this.#run(SYSTEM_CTX, "archive_scan_schedule", archiveScanSchedule, {}, () => SYSTEM_ACTOR);
  }

  /**
   * When an archived topic is next due to go cold (ms since the epoch), or
   * null. The Board DO arms its alarm for this when it has a cold store.
   */
  nextColdExportDue(): number | null {
    const row = this.#sql.one<{ due: number | null }>(
      `SELECT MIN(${COLD_DUE_SQL}) AS due FROM topics t WHERE ${COLD_ELIGIBLE_SQL}`,
      this.config.coldAfterMs,
      this.config.coldRetryMs,
    );
    return row?.due === null || row?.due === undefined ? null : Number(row.due);
  }

  /**
   * The next archived topic due to go cold, with its object built and the
   * attempt recorded (`topic_cold_begin`), or null. A topic whose size
   * estimate (SQL) or built object is over `coldMaxBytes` is recorded as a
   * failed export (`topic_cold_failed`) and skipped until its retry.
   */
  beginColdExport(): ColdJob | null {
    for (;;) {
      const t = this.#sql.one<TopicRow>(
        `SELECT t.* FROM topics t WHERE ${COLD_ELIGIBLE_SQL} AND ${COLD_DUE_SQL} <= ?
         ORDER BY t.archived_at, t.name LIMIT 1`,
        this.config.coldAfterMs,
        this.config.coldRetryMs,
        this.#now(),
      );
      if (!t) return null;
      const key = coldKey(t.name, Number(t.archived_at));
      const tooBig = (bytes: number, what: string): boolean => {
        if (bytes <= this.config.coldMaxBytes) return false;
        this.failColdExport({ topic: t.name, key }, `${what} ${bytes} bytes, over coldMaxBytes (${this.config.coldMaxBytes})`);
        return true;
      };
      // Refused from SQL first, without building the object (review M1).
      if (tooBig(coldSizeEstimate(this.#sql, t.name), "object estimated at")) continue;
      const obj = buildColdObject({ sql: this.#sql, sha256: this.#sha256 }, t);
      if (tooBig(obj.bytes, "object is")) continue;
      const r = this.#run(
        SYSTEM_CTX,
        "topic_cold_begin",
        topicColdBegin,
        { topic: t.name, key: obj.key, sha256: obj.sha256, bytes: obj.bytes, counts: obj.counts },
        () => SYSTEM_ACTOR,
      );
      if (!r.ok) return null;
      return { topic: t.name, ...obj };
    }
  }

  /** The store confirmed `job`: check the begin record and fingerprint, delete the rows (`topic_cold`). */
  confirmColdExport(job: Pick<ColdJob, "topic" | "key" | "sha256">, outcome: "created" | "exists"): ActResult {
    return this.#run(
      SYSTEM_CTX,
      "topic_cold",
      topicCold,
      { topic: job.topic, key: job.key, sha256: job.sha256, outcome },
      () => SYSTEM_ACTOR,
    );
  }

  /**
   * Writing `job` failed: keep everything, retry after `coldRetryMs`
   * (`topic_cold_failed`). `conflict`: other content is at the key; the topic
   * stops being tried and the human admins are told once.
   */
  failColdExport(job: Pick<ColdJob, "topic" | "key">, error: string, conflict = false): ActResult {
    return this.#run(
      SYSTEM_CTX,
      "topic_cold_failed",
      topicColdFailed,
      { topic: job.topic, key: job.key, error: error.slice(0, 500), ...(conflict ? { conflict: true } : {}) },
      () => SYSTEM_ACTOR,
    );
  }

  /**
   * For `bbs_topic_unarchive`: the cold topic named in `args` and its object
   * key, when the caller may restore it (read only); otherwise undefined.
   */
  coldRestoreTarget(ctx: CallContext, args: unknown): { topic: string; key: string } | undefined {
    if (!validHandle(ctx.handle)) return undefined;
    return coldRestoreKey(this.#sql, ctx.handle, args);
  }

  /**
   * Restore a cold topic from the object the shell read at `key` (or the
   * error reading it). Checked and audited like any user call
   * (`topic_restore`); the body is never written to the audit row.
   */
  restoreTopic(ctx: CallContext, topic: string, key: string, body: string | null, error?: string): ActResult {
    return this.#run(
      ctx,
      "topic_restore",
      topicRestore,
      { topic, key, ...(body !== null ? { body } : {}), ...(error !== undefined ? { error } : {}) },
      () => this.#loadActor(ctx),
      { userCall: true },
    );
  }

  /** The board id and recorded chain state (`meta`): see `chainState`. */
  auditChainState(): ChainState {
    return chainState(this.#sql);
  }

  /**
   * Verify the chain across archived batches (read back from the archive by
   * the caller; the board itself never reads the sink) and the hot rows.
   */
  verifyAuditWithArchive(batches: readonly { path: string; body: string }[]): ArchiveCheck {
    const c = chainState(this.#sql);
    return verifyAuditArchive({
      boardId: c.board_id,
      exportedSeq: c.exported_seq,
      batches,
      hot: readAuditRows(this.#sql, 0, Number.MAX_SAFE_INTEGER),
      tail: { seq: c.tail_seq, hash: c.tail_hash },
      head: c.head,
      sha256: this.#sha256,
    });
  }

  /** Verify the audit chain over every row still in SQLite. */
  verifyAudit(): ChainCheck {
    const rows = this.#sql.all<AuditRow>(
      `SELECT seq, ts, actor, actor_kind, via, session, action, target_type, target_id,
              topic, result, detail, request_id, prev_hash
       FROM audit ORDER BY seq`,
    );
    const meta = new Map(
      this.#sql
        .all<{ key: string; value: string }>(
          "SELECT key, value FROM meta WHERE key IN ('audit_head', 'audit_tail_seq', 'audit_tail_hash')",
        )
        .map((r) => [r.key, r.value]),
    );
    // The tail is where the hot rows must start: seq 1 and GENESIS_HASH
    // until M6a exports and deletes rows, which moves the tail forward. The
    // oldest hot row is checked against it, so deleting that row is caught.
    const tailSeq = Number(meta.get("audit_tail_seq") ?? 1);
    const tailHash = meta.get("audit_tail_hash") ?? GENESIS_HASH;
    const first = rows[0];
    if (first && Number(first.seq) !== tailSeq) {
      return {
        ok: false,
        seq: Number(first.seq),
        reason: `oldest row is seq ${Number(first.seq)}; expected seq ${tailSeq}`,
      };
    }
    return verifyChain(
      rows.map(normalizeAuditRow),
      this.#sha256,
      tailHash,
      meta.get("audit_head") ?? GENESIS_HASH,
    );
  }

  #loadActor(ctx: CallContext): Actor {
    if (!validHandle(ctx.handle)) {
      throw new BbsError("unauthorized", "no such user", "denied");
    }
    const row = this.#sql.one<{
      handle: string;
      kind: UserKind;
      is_admin: number;
      is_coordinator: number;
      status: Actor["status"];
    }>(
      `SELECT handle, kind, is_admin, is_coordinator, ${userStatusSql()} AS status FROM users WHERE handle = ?`,
      ctx.handle,
    );
    if (!row) throw new BbsError("unauthorized", "no such user", "denied");
    return {
      handle: row.handle,
      kind: row.kind,
      isAdmin: row.kind === "human" && Number(row.is_admin) === 1,
      isCoordinator: Number(row.is_coordinator) === 1,
      status: row.status,
    };
  }

  #run(
    ctx: CallContext,
    action: string,
    def: ActionDef | undefined,
    params: unknown,
    resolveActor: () => Actor,
    options: {
      userCall?: boolean;
      extraDetail?: Record<string, unknown>;
      /** Set when running a follow-up: its own follow-ups are not run. */
      followUp?: boolean;
      /** True when a refusal is to be counted and not given an audit row (issue #43). */
      countRefusal?: (e: BbsError) => boolean;
    } = {},
  ): ActResult {
    const extraDetail = options.extraDetail ?? {};
    let followUps: readonly FollowUp[] = [];
    if (!VIAS.includes(ctx.via)) {
      throw new TypeError(`unknown via: ${String(ctx.via)}`);
    }
    // A failed actor lookup is recorded under the claimed handle, which the
    // shells only ever take from `authenticate`.
    let actor: Actor = { ...ANONYMOUS_ACTOR, handle: ctx.handle, kind: "anonymous" };
    let result: ActResult;
    try {
      result = this.#sql.transaction(() => {
        const now = this.#now();
        actor = resolveActor();
        if (options.userCall) {
          ctx = this.#bindMcpSession(actor, ctx);
          const bound = this.#bindSessionHandle(actor, ctx, action);
          actor = bound.actor;
          ctx = bound.ctx;
        }
        if (options.userCall && this.#checkCaller(actor, ctx, action) === "gone_join") {
          // A bbs_join carrying its owner's ended session is a fresh join
          // (M2 independent review M1): the adapter or model that held it
          // gets a new session instead of a refusal.
          const { session: _gone, ...rest } = ctx;
          ctx = rest;
        }
        if (!def) throw new BbsError("unknown_action", `unknown action: ${action}`);
        if ((actor.kind === "agent" || actor.kind === "human") && countsAsActivity(actor, ctx, def)) {
          this.#sql.exec("UPDATE users SET last_seen = ? WHERE handle = ?", now, actor.handle);
          // Any call from an assignee renews its leases (design §8), except
          // adapter socket housekeeping (review m5).
          if (def.renewsLeases?.(asRecord(params)) ?? true) {
            renewLeases({ sql: this.#sql, now, config: this.config }, actor.handle);
          }
        }
        // A call made with a connector's access token marks its grant used (issue #55).
        if (ctx.oauthGrant !== undefined && actor.kind === "agent") noteGrantUse(this.#sql, now, ctx.oauthGrant);
        const tx = {
          sql: this.#sql,
          now,
          actor,
          ctx,
          config: this.config,
          sha256: this.#sha256,
          randomBytes: this.#randomBytes,
          ...(this.#runtime ? { runtime: this.#runtime } : {}),
          ...(this.#server ? { server: this.#server } : {}),
          approval: this.#approval,
        };
        const outcome: ActionOutcome = def.run(tx, params as Record<string, unknown>);
        // Doorbells and notices for this action's notification work, in the
        // same transaction, recorded on the same audit row (M2).
        const delivery = deliveryDetail(deliver(tx, outcome.notifications ?? []));
        const audited =
          def.kind !== "read" || this.#debugAudits(actor, outcome.audit) || Object.keys(delivery).length > 0;
        const auditSeq = audited
          ? this.#writeAudit(now, ctx, actor, outcome.auditAction ?? action, "ok", outcome.audit, { ...extraDetail, ...delivery })
          : undefined;
        followUps = outcome.followUps ?? [];
        return {
          ok: true as const,
          value: outcome.value,
          notifications: outcome.notifications ?? [],
          auditSeq,
        };
      });
    } catch (err) {
      const e =
        err instanceof BbsError
          ? err
          : new BbsError("internal", "internal error", "error");
      const detail: Record<string, unknown> = { ...extraDetail, code: e.code, reason: e.message };
      if (!(err instanceof BbsError)) {
        detail.internal = err instanceof Error ? err.message.slice(0, 500) : String(err);
      }
      const auditSeq = options.countRefusal?.(e)
        ? undefined
        : this.#sql.transaction(() => this.#writeAudit(this.#now(), ctx, actor, action, e.result, {}, detail));
      followUps = e.followUps;
      result = {
        ok: false,
        error: { code: e.code, message: e.message },
        result: e.result,
        auditSeq,
        notifications: [],
      };
    }
    // Outside the try: the call is already committed (or refused and
    // audited), and nothing a follow-up does can change that result.
    if (!options.followUp) {
      result.notifications.push(...this.#runFollowUps(ctx, followUps));
      // Committed work only: a failed call's own work was dropped above, and
      // its follow-ups (a kick after a refused Lobby post) ran committed.
      for (const n of result.notifications) {
        if (n.type !== "disconnect") continue;
        if (this.#disconnects.get(n.handle) !== "kicked") this.#disconnects.set(n.handle, n.reason);
      }
    }
    return result;
  }

  /**
   * Run follow-ups (system actions an action asked for) after the call's own
   * transaction, each in its own transaction with its own audit row and the
   * call's `request_id`. Returns their notification work. A failed follow-up
   * is audited like any failed action and does not stop the others.
   */
  #runFollowUps(ctx: CallContext, list: readonly FollowUp[]): NotificationWork[] {
    const out: NotificationWork[] = [];
    for (const f of list) {
      try {
        const r = this.#run(
          { handle: "system", via: "system", requestId: ctx.requestId },
          f.def.name,
          f.def,
          f.params,
          () => SYSTEM_ACTOR,
          { followUp: true },
        );
        if (r.ok) out.push(...r.notifications);
      } catch {
        // `#run` audits a failed action itself; this catches only a failure
        // to write even that row (storage), which must not undo the caller.
      }
    }
    return out;
  }

  /**
   * A connector chat names its board session in one of two ways: the `session`
   * argument of the call (the id `bbs_join` returned), or the hash of the MCP
   * session id its client sent back. For an agent signed in by an OAuth grant,
   * a call with no session of its own is bound to the handle's live grant-made
   * session the argument names, else to the live one with that hash, so its
   * audit rows carry the session and a `bbs_join` updates it in place. The
   * argument wins when both are present. One that names no such session (unknown,
   * ended, another handle's, malformed) is ignored: the call goes on unbound.
   * Anywhere else both are dropped.
   */
  #bindMcpSession(actor: Actor, ctx: CallContext): CallContext {
    const { sessionArg, ...rest } = ctx;
    if (rest.mcpSession === undefined && sessionArg === undefined) return ctx;
    if (rest.oauthGrant === undefined || actor.kind !== "agent") {
      const { mcpSession: _ignored, ...bare } = rest;
      return bare;
    }
    if (rest.session !== undefined) return rest;
    if (sessionArg !== undefined) {
      const named = this.#sql.one<{ id: string }>(
        "SELECT id FROM sessions WHERE id = ? AND handle = ? AND via_grant = 1 AND state <> 'gone'",
        sessionArg,
        actor.handle,
      );
      if (named) return { ...rest, session: named.id };
    }
    if (rest.mcpSession === undefined) return rest;
    const row = this.#sql.one<{ id: string }>(
      `SELECT id FROM sessions
       WHERE handle = ? AND mcp_session_hash = ? AND state <> 'gone'
       ORDER BY attached_at DESC LIMIT 1`,
      actor.handle,
      rest.mcpSession,
    );
    return row ? { ...rest, session: row.id } : rest;
  }

  /**
   * A local session's call arrives under its agent's token with the board
   * session `bbs_join` returned (`x-bbs-session`, `BBS_SESSION`, the adapter's
   * socket `hello`). When the token authenticated agent P and that session
   * belongs to a session handle whose `parent` is P (issue #98), the call acts
   * as the session handle: its inbox, mentions, tasks and audit rows. Nothing
   * else changes the actor. A session that is P's own, P's connector's, another
   * agent's, a session handle of another parent's, or unknown leaves the actor
   * as P, and `#checkCaller` then refuses it with the one message it gives for
   * any session that is not the caller's, so a refusal says nothing about
   * whether the session exists or whose it is. A connector call
   * (`ctx.oauthGrant`) never resolves to a session handle, and neither does
   * one made by a session handle's own resolution (no nesting).
   *
   * A `bbs_join` that names an ended session of a session handle is a new join,
   * made as the token's own handle (which then finds or makes the handle for
   * its `harness_session`), as a join with its own ended session is.
   */
  #bindSessionHandle(actor: Actor, ctxIn: CallContext, action: string): { actor: Actor; ctx: CallContext } {
    // Nothing a shell sends is the carried harness session; only this method sets it.
    const { carriedHarnessSession: _dropped, ...ctx } = ctxIn;
    // Only local clients (`/api`, the adapter's `/ws`) name a session handle's session; a static token on `/mcp` acts as its own handle.
    if (
      ctx.session === undefined ||
      actor.kind !== "agent" ||
      actor.parent !== undefined ||
      ctx.oauthGrant !== undefined ||
      ctx.via === "mcp"
    ) {
      return { actor, ctx };
    }
    const row = this.#sql.one<{ handle: string; state: string; harness_session: string | null }>(
      `SELECT s.handle AS handle, s.state AS state, u.harness_session AS harness_session FROM sessions s
       JOIN users u ON u.handle = s.handle WHERE s.id = ? AND u.parent = ?`,
      ctx.session,
      actor.handle,
    );
    if (!row) return { actor, ctx };
    if (action === "join" && row.state === "gone") {
      const { session: _ended, ...rest } = ctx;
      return { actor, ctx: row.harness_session !== null ? { ...rest, carriedHarnessSession: row.harness_session } : rest };
    }
    return { actor: { ...this.#loadActor({ ...ctx, handle: row.handle }), parent: actor.handle }, ctx };
  }

  /**
   * Checks on every user call (`act`, `refuse`): the user is not kicked, the
   * `via` fits the user's kind, and a claimed session is the user's own (B7).
   */
  #checkCaller(actor: Actor, ctx: CallContext, action: string): "ok" | "gone_join" {
    if (actor.status === "kicked") {
      throw new BbsError("unauthorized", "this user has been removed", "denied");
    }
    if (actor.status === "retired") {
      throw new BbsError(
        "unauthorized",
        `this session has ended: ${actor.handle} was retired after a long time with no session; join again with its harness_session to bring it back ${SESSION_ENDED_MARKER}`,
        "denied",
      );
    }
    if (actor.kind === "agent" || actor.kind === "human") {
      if (!VIAS_BY_KIND[actor.kind].includes(ctx.via)) {
        throw denied(`${actor.kind} users cannot act via ${ctx.via}`);
      }
    }
    if (ctx.session !== undefined) {
      const owner = this.#sql.one<{ handle: string; state: string }>(
        "SELECT handle, state FROM sessions WHERE id = ?",
        ctx.session,
      );
      if (!owner || owner.handle !== actor.handle) {
        throw denied("that session does not belong to this user");
      }
      // B19 (decided in M2): a session a later `bbs_join` replaced (or a
      // kick ended) is refused, now that sessions carry live state and one
      // adapter socket each. Without a session, calls are still accepted.
      if (owner.state === "gone") {
        if (action === "join") return "gone_join";
        throw denied(`this session has ended (a later bbs_join replaced it); join again ${SESSION_ENDED_MARKER}`, "unauthorized");
      }
    }
    return "ok";
  }

  #debugAudits(actor: Actor, target: AuditTarget): boolean {
    const flags = this.config.debugAuditReads;
    return (
      flags.handles.includes(actor.handle) ||
      (target.topic !== undefined && flags.topics.includes(target.topic))
    );
  }

  /** Write one audit row chained to the previous head; returns its seq. */
  #writeAudit(
    now: number,
    ctx: CallContext,
    actor: Actor,
    action: string,
    result: AuditResult,
    target: AuditTarget,
    extraDetail: Record<string, unknown>,
  ): number {
    const headRow = this.#sql.one<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'audit_head'",
    );
    const prevHash = headRow?.value ?? GENESIS_HASH;
    // A call made with a connector's access token names its grant on every row.
    // A session handle's call (issue #98) names its parent on every row, as a connector's names its grant.
    const rowActor = target.actor ?? { handle: actor.handle, parent: actor.parent };
    const detail = JSON.stringify({
      ...target.detail,
      ...extraDetail,
      ...(ctx.oauthGrant !== undefined ? { grant: ctx.oauthGrant } : {}),
      ...(rowActor.parent !== undefined ? { parent: rowActor.parent } : {}),
    });
    const inserted = this.#sql.one<AuditRow>(
      `INSERT INTO audit (ts, actor, actor_kind, via, session, action, target_type,
                          target_id, topic, result, detail, request_id, prev_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING seq, ts, actor, actor_kind, via, session, action, target_type, target_id,
                 topic, result, detail, request_id, prev_hash`,
      now,
      rowActor.handle,
      actor.kind,
      ctx.via,
      target.session ?? ctx.session ?? null,
      action,
      target.targetType ?? null,
      target.targetId ?? null,
      target.topic ?? null,
      result,
      detail,
      ctx.requestId ?? null,
      prevHash,
    );
    if (!inserted) throw new Error("audit insert returned no row");
    const row = normalizeAuditRow(inserted);
    this.#sql.exec(
      `INSERT INTO meta (key, value) VALUES ('audit_head', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      chainValueAfter(row, this.#sha256),
    );
    return row.seq;
  }
}

/**
 * Whether a call counts as the user's activity: it updates `last_seen` and
 * renews the user's task leases (design §8). Decided by Curtis, 2026-11-20
 * (B38): "the web view's reads should not count as activity". So a person's
 * reads through the web view (`read` and `audited_read` actions, and
 * `passive` changes such as moving the read mark) do not count; their posts
 * and task changes there do. Every other call counts.
 */
export function countsAsActivity(actor: Actor, ctx: CallContext, def: ActionDef): boolean {
  if (actor.kind !== "human" || ctx.via !== "web") return true;
  return def.kind === "change" && def.passive !== true;
}

/** A refusal as an `ActResult`, carrying the audit row (if any) the sign-in guards wrote. */
function refusal<T>(code: ErrorCode, message: string, from: AuthResult): ActResult<T> {
  return {
    ok: false,
    error: { code: from.ok || from.reason !== "rate_limited" ? code : "rate_limited", message },
    result: "denied",
    auditSeq: from.ok ? undefined : from.auditSeq,
    notifications: [],
  };
}

/** What a refused approval call tells the browser, by the reason the guards record; the reasons stay for the audit row. */
function approvalRefusal(reason: string): { code: ErrorCode; message: string } {
  switch (reason) {
    case "not_pending":
      return { code: "not_found", message: "that approval request is not pending (unknown, expired or already decided)" };
    case "no_approver":
      return { code: "forbidden", message: "you have no passkey left that can approve this" };
    case "passkey_synced":
      return { code: "forbidden", message: "this board accepts only a device-bound passkey for approvals, and that passkey can sync between devices" };
    case "passkey_barred":
      return { code: "forbidden", message: "that passkey was registered while approval was required, so it cannot approve; register it again while approval is off" };
    default:
      return { code: "forbidden", message: "that passkey was not accepted for this approval" };
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function normalizeAuditRow(r: AuditRow): AuditRow {
  return {
    seq: Number(r.seq),
    ts: Number(r.ts),
    actor: r.actor,
    actor_kind: r.actor_kind,
    via: r.via,
    session: r.session ?? null,
    action: r.action,
    target_type: r.target_type ?? null,
    target_id: r.target_id ?? null,
    topic: r.topic ?? null,
    result: r.result,
    detail: r.detail,
    request_id: r.request_id ?? null,
    prev_hash: r.prev_hash,
  };
}

/** Drops a timer that cannot run (unknown kind, or its action failed). */
const dropTimer: ActionDef = {
  name: "timer_dropped",
  kind: "change",
  run(tx, input) {
    const p = input as { timer?: number; kind?: string };
    tx.sql.exec("DELETE FROM timers WHERE id = ?", Number(p.timer ?? 0));
    return {
      value: { dropped: p.timer },
      audit: { targetType: "timer", targetId: String(p.timer), detail: { kind: String(p.kind) } },
    };
  },
};

/** The first sign-in refused past the failed sign-in limit (B5); audited as denied. */
const signInLimited: ActionDef = {
  name: "sign_in_limited",
  kind: "change",
  run() {
    throw denied("too many failed sign-ins from this source; try again later", "rate_limited");
  },
};

/** A summary row for failed sign-ins refused without a row of their own (B5). */
const signInSuppressed: ActionDef = {
  name: "sign_in_suppressed",
  kind: "change",
  run() {
    return { value: {}, audit: { targetType: "sign_in_source" } };
  },
};

const SOCKET_LIMITED_MESSAGE = "too many messages from this session; try again later";

/** The first adapter message refused past the socket message limit (B45); audited as denied. */
const socketRateLimited: ActionDef = {
  name: "socket_rate_limited",
  kind: "change",
  run() {
    throw denied(SOCKET_LIMITED_MESSAGE, "rate_limited");
  },
};

/** A summary row for adapter messages refused without a row of their own (B45). */
const socketRateSuppressed: ActionDef = {
  name: "socket_rate_suppressed",
  kind: "change",
  run() {
    return { value: {}, audit: { targetType: "session" } };
  },
};

/** A summary row for `bbs_join`s refused past the first of a window, which got no row of their own (issue #43). */
const joinRateSuppressed: ActionDef = {
  name: "join_rate_suppressed",
  kind: "change",
  run() {
    return { value: {}, audit: { targetType: "user" } };
  },
};

/** The largest counts of `counts` as an object under `key`, with the rest summed as `other`. */
function topCounts(key: string, counts: Map<string, number>, other: number): Record<string, unknown> {
  if (counts.size === 0 && other === 0) return {};
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const top = Object.fromEntries(sorted.slice(0, SUMMARY_ATTRIBUTION_KEYS));
  const rest = sorted.slice(SUMMARY_ATTRIBUTION_KEYS).reduce((n, [, c]) => n + c, other);
  return { [key]: { ...top, ...(rest > 0 ? { other: rest } : {}) } };
}
