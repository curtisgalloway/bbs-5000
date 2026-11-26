// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/** Users, sessions and roles: join, role_set, who, admin_user_add. */

import {
  asParams,
  foldHandle,
  optBool,
  optEnum,
  optLabel,
  optString,
  optTopic,
  reqHandle,
  reqLabel,
  reqString,
  UNSAFE_LABEL_RE,
} from "../params.ts";
import {
  BbsError,
  denied,
  type ActionDef,
  type NotificationWork,
  type Tx,
  type UserKind,
} from "../types.ts";
import { formatSpan } from "./admin-status.ts";
import { staleHeldTasks } from "./admin.ts";
import { revokePasskeys, revokeWebSessions } from "./web-session.ts";
import { userStatusSql } from "../schema.ts";
import { armSessionHandleRetire, resolveSessionHandle, type ResolvedSessionHandle } from "./session-handles.ts";
import {
  base64url,
  canonicalHandle,
  checkSubscriptionRoom,
  getTopic,
  insertMessage,
  insertUserOnce,
  LOBBY,
  topicMaxSeq,
} from "./common.ts";

interface UserRow {
  handle: string;
  kind: UserKind;
  harness: string | null;
  role: string;
  role_set_by: string | null;
  is_coordinator: number;
  is_admin: number;
  status: string;
  last_seen: number | null;
  parent: string | null;
  [key: string]: unknown;
}

/** The columns of a user read for `join` and `who`, as a SELECT list; `prefix` is a table alias such as `u.`. */
function userColumns(prefix = ""): string {
  const plain = ["handle", "kind", "harness", "role", "role_set_by", "is_coordinator", "is_admin", "last_seen", "parent"];
  return [...plain.map((c) => `${prefix}${c}`), `${userStatusSql(prefix === "" ? undefined : prefix)} AS status`].join(", ");
}

/**
 * The client name of an OAuth grant as a harness label, or undefined when the
 * grant is gone or its name would not pass the label checks (the name comes
 * from the client's own metadata document).
 */
function grantClientLabel(tx: Tx, grant: string): string | undefined {
  const row = tx.sql.one<{ client_name: string }>(
    "SELECT client_name FROM oauth_grants WHERE id = ?",
    grant,
  );
  const name = row?.client_name;
  if (name === undefined || name === "" || name.length > 64 || UNSAFE_LABEL_RE.test(name)) {
    return undefined;
  }
  return name;
}

/** Start the connector idle timer when there is none (an INSERT judged by its own condition). */
function armConnectorIdle(tx: Tx, due: number): void {
  tx.sql.exec(
    `INSERT INTO timers (due_at, kind, ref)
     SELECT ?, 'connector_idle', 'board'
     WHERE NOT EXISTS (SELECT 1 FROM timers WHERE kind = 'connector_idle')`,
    due,
  );
}

/**
 * The idle timer for connector sessions: a session made through an OAuth grant
 * (bound to an MCP session id or not) with no audited call for
 * `connectorSessionIdleMs` is ended, measured from its newest audit row, or from
 * `attached_at` when it has none. Reads the audit table, so it adds no unaudited
 * write. Re-arms for the earliest remaining expiry, and stays off while no
 * connector session is live (the next grant join arms it).
 */
export const connectorIdle: ActionDef = {
  name: "connector_idle",
  kind: "change",
  run(tx) {
    tx.sql.exec("DELETE FROM timers WHERE kind = 'connector_idle'");
    const live = tx.sql.all<{ id: string; last: number }>(
      `SELECT s.id AS id,
              COALESCE((SELECT MAX(ts) FROM audit WHERE session = s.id), s.attached_at) AS last
       FROM sessions s
       WHERE s.state <> 'gone' AND (s.via_grant = 1 OR s.mcp_session_hash IS NOT NULL)`,
    );
    const ended: string[] = [];
    let next: number | null = null;
    for (const row of live) {
      const expires = Number(row.last) + tx.config.connectorSessionIdleMs;
      if (expires <= tx.now) {
        tx.sql.exec("UPDATE sessions SET state = 'gone', ws_open = 0, detached_at = ? WHERE id = ?", tx.now, row.id);
        ended.push(row.id);
      } else if (next === null || expires < next) {
        next = expires;
      }
    }
    if (next !== null) armConnectorIdle(tx, next);
    const detail = { ended, next };
    return { value: detail, audit: { targetType: "timer", detail } };
  },
};

/**
 * Told to a connector's chat with its new session id. A connector chat has no
 * adapter, so nothing rings it (design §7): it has to look.
 */
const SESSION_NOTE =
  "Pass this session id as `session` on every later call in this chat, so the board can tell chats apart. " +
  "This chat gets no doorbell: call `bbs_inbox` at the start of every turn that uses the board.";

/**
 * Told to a local session that was given a handle of its own (issue #98): what
 * the handle is, and that the session id is how the board tells its calls apart
 * from the token's other sessions.
 */
function sessionHandleNote(handle: string, parent: string): string {
  return (
    `This session acts as ${handle}, a handle of its own under ${parent}'s token, with its own inbox, ` +
    `mentions and tasks. Pass the session id on every later call (BBS_SESSION, --session); without it a call acts as ${parent}. ` +
    `@${handle} reaches this session only; @${parent} reaches ${parent} only. Joining again with the same harness_session gets this handle back.`
  );
}

/**
 * Whether a session can be rung: `adapter` while an adapter socket is open for
 * it (`sessions.ws_open`, the fact `liveSession` in `notify.ts` picks a ring's
 * target by), else `none`.
 */
function wakeOf(wsOpen: number | null | undefined): "adapter" | "none" {
  return Number(wsOpen) === 1 ? "adapter" : "none";
}

/**
 * `bbs_join`: attach a new session to the caller's own handle and set its
 * role. Never creates an account (Q1). On the handle's first join, posts the
 * Lobby system message and subscribes the handle to the Lobby at `digest`
 * (design §5).
 *
 * A join under an agent's own token that carries a `harness_session` (and no
 * session of its own to update) is a local session's join (issue #98): it gets
 * the session handle of `(token's handle, harness_session)`, made on the first
 * join, and everything below (the role, the new session, the sessions it ends)
 * is that handle's, so the token's other sessions are left alone. The audit row
 * is the session handle's own call. A join without a `harness_session`, and a
 * connector's join, act as the token's handle exactly as before.
 */
export const join: ActionDef = {
  name: "join",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const handle = optLabel(p, "handle", 64);
    // A session handle's calls arrive under its parent's token, so a handle naming either is the caller's own.
    const tokenHandle = tx.actor.parent ?? tx.actor.handle;
    if (
      handle !== undefined &&
      foldHandle(handle) !== foldHandle(tx.actor.handle) &&
      foldHandle(handle) !== foldHandle(tokenHandle)
    ) {
      throw denied(
        `this token belongs to ${tokenHandle}; it cannot join as ${handle}`,
      );
    }
    const role = optLabel(p, "role", tx.config.maxRoleLength);
    let harness = optLabel(p, "harness", 64);
    const machine = optLabel(p, "machine", 64);
    const os = optLabel(p, "os", 64);
    const model = optLabel(p, "model", 64);
    // A join that carried an ended session of a session handle and no id of its own rejoins as that handle
    // (`act` carries the ended session's harness session in the context).
    const harnessSession = optLabel(p, "harness_session", 128) ?? tx.ctx.carriedHarnessSession;

    // A local session's join under a token: find or make the handle it acts as.
    let sessionHandle: ResolvedSessionHandle | undefined;
    if (
      harnessSession !== undefined &&
      tx.ctx.session === undefined &&
      tx.ctx.oauthGrant === undefined &&
      // Only a local client (the adapter, the CLI) names a harness session, and they use /api: a
      // static token on /mcp acts as its own handle, as before (issue #98).
      tx.ctx.via === "api" &&
      tx.actor.kind === "agent" &&
      tx.actor.parent === undefined
    ) {
      const parentHarness = tx.sql.one<{ harness: string | null }>(
        "SELECT harness FROM users WHERE handle = ?",
        tx.actor.handle,
      )?.harness;
      sessionHandle = resolveSessionHandle(tx, tx.actor.handle, harnessSession, harness ?? parentHarness ?? null);
    }
    const me = sessionHandle?.handle ?? tx.actor.handle;
    const parent = sessionHandle !== undefined ? tx.actor.handle : tx.actor.parent;
    const callAs = parent !== undefined ? { actor: { handle: me, parent } } : {};

    const before = tx.sql.one<UserRow>(
      `SELECT ${userColumns()} FROM users WHERE handle = ?`,
      me,
    );
    if (!before) throw new BbsError("internal", "acting user vanished");
    // A session handle serves one harness session; a call that names another is refused, not retargeted.
    if (tx.actor.parent !== undefined && harnessSession !== undefined) {
      const mine = tx.sql.one<{ harness_session: string | null }>(
        "SELECT harness_session FROM users WHERE handle = ?",
        me,
      )?.harness_session;
      if (mine !== harnessSession) {
        throw denied(`${me} serves another harness session; join without a session to start a new one`);
      }
    }

    // A connector's chat has no way to name its harness; without one, and
    // with none stored yet, a join made through an OAuth grant takes the
    // grant's client name ("Claude", "ChatGPT"). An explicit harness wins.
    let harnessDefaulted = false;
    if (harness === undefined && before.harness === null && tx.ctx.oauthGrant !== undefined) {
      harness = grantClientLabel(tx, tx.ctx.oauthGrant);
      harnessDefaulted = harness !== undefined;
    }

    if (role !== undefined) {
      tx.sql.exec(
        "UPDATE users SET role = ?, role_set_by = ? WHERE handle = ?",
        role,
        me,
        me,
      );
    }
    if (harness !== undefined) {
      tx.sql.exec("UPDATE users SET harness = ? WHERE handle = ?", harness, me);
    }

    // Re-join (M2): a call made with the caller's own live session (checked
    // by `act`: owner, not gone) updates that session in place instead of
    // replacing it, so the adapter's socket session survives the agent
    // calling `bbs_join` to set its role.
    if (tx.ctx.session !== undefined) {
      const session = tx.ctx.session;
      tx.sql.exec(
        `UPDATE sessions SET machine = COALESCE(?, machine),
                os = COALESCE(?, os), model = COALESCE(?, model),
                harness_session = COALESCE(?, harness_session) WHERE id = ?`,
        machine ?? null,
        os ?? null,
        model ?? null,
        harnessSession ?? null,
        session,
      );
      const detail: Record<string, unknown> = { first_join: false, rejoined: true };
      if (role !== undefined) detail.role = { before: before.role, after: role };
      if (harness !== undefined) detail.harness = { before: before.harness, after: harness };
      if (harnessDefaulted) detail.harness_default = "oauth_client";
      return {
        value: {
          handle: me,
          ...(parent !== undefined ? { parent } : {}),
          kind: before.kind,
          role: role ?? before.role,
          session,
          first_join: false,
          wake: wakeOf(
            tx.sql.one<{ ws_open: number }>("SELECT ws_open FROM sessions WHERE id = ?", session)
              ?.ws_open,
          ),
          ...(tx.ctx.oauthGrant !== undefined ? { note: SESSION_NOTE } : {}),
        },
        audit: { targetType: "session", targetId: session, session, detail },
      };
    }

    const prior = tx.sql.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sessions WHERE handle = ?",
      me,
    );
    const firstJoin = Number(prior?.n ?? 0) === 0;
    // A join through an OAuth grant that is not bound to a session is a new
    // connector chat: it adds a session and ends none, with or without an MCP
    // session id. Every other join replaces all of the handle's live sessions.
    const viaGrant = tx.ctx.oauthGrant !== undefined;
    const mcp = viaGrant ? tx.ctx.mcpSession : undefined;
    const replaced = viaGrant
      ? []
      : tx.sql.all<{ id: string }>(
          "UPDATE sessions SET state = 'gone', ws_open = 0, detached_at = ? WHERE handle = ? AND state <> 'gone' RETURNING id",
          tx.now,
          me,
        );

    const session = `s_${base64url(tx.randomBytes(12))}`;
    // The limits are conditions of the INSERT, judged by the rows it changes: two
    // joins at a limit cannot both take the last place. A refusal rolls back
    // this call's other writes (the role, the ended sessions). `act` writes one
    // refusal row per handle per window and counts the rest (issue #43).
    // The join rate limit counts per token, not per handle: the sessions of the token's own handle
    // and of every session handle under it, so one token cannot multiply its budget (issue #98).
    const rateOwner = parent ?? me;
    const windowStart = tx.now - tx.config.joinWindowMs;
    const inserted = tx.sql.all<{ id: string }>(
      `INSERT INTO sessions (id, handle, machine, os, model, harness_session, state, attached_at,
                             mcp_session_hash, via_grant, grant_id)
       SELECT ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM sessions
              WHERE (handle = ? OR handle IN (SELECT handle FROM users WHERE parent = ?))
                AND attached_at > ?) < ?
         AND (? = 0 OR (SELECT COUNT(*) FROM sessions
                        WHERE handle = ? AND state <> 'gone' AND via_grant = 1) < ?)
       RETURNING id`,
      session,
      me,
      machine ?? null,
      os ?? null,
      model ?? null,
      harnessSession ?? null,
      tx.now,
      mcp ?? null,
      viaGrant ? 1 : 0,
      tx.ctx.oauthGrant ?? null,
      rateOwner,
      rateOwner,
      windowStart,
      tx.config.joinMaxPerWindow,
      viaGrant ? 1 : 0,
      me,
      tx.config.connectorSessionsMaxPerHandle,
    );
    if (inserted.length === 0) {
      if (viaGrant) {
        const live = tx.sql.one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM sessions WHERE handle = ? AND state <> 'gone' AND via_grant = 1",
          me,
        );
        if (Number(live?.n ?? 0) >= tx.config.connectorSessionsMaxPerHandle) {
          throw denied(
            `too many live connector sessions for ${me} (${tx.config.connectorSessionsMaxPerHandle}); ` +
              `one ends after ${formatSpan(tx.config.connectorSessionIdleMs)} without a call`,
            "rate_limited",
          );
        }
      }
      // The oldest session in the window leaves it first, which frees a place.
      const oldest = tx.sql.one<{ at: number | null }>(
        `SELECT MIN(attached_at) AS at FROM sessions
         WHERE (handle = ? OR handle IN (SELECT handle FROM users WHERE parent = ?)) AND attached_at > ?`,
        rateOwner,
        rateOwner,
        windowStart,
      );
      const retryAt = Number(oldest?.at ?? tx.now) + tx.config.joinWindowMs;
      throw denied(
        `too many new sessions for ${rateOwner} (${tx.config.joinMaxPerWindow} in ${formatSpan(tx.config.joinWindowMs)}); ` +
          `try again in ${formatSpan(retryAt - tx.now)}`,
        "rate_limited",
      );
    }
    if (viaGrant) armConnectorIdle(tx, tx.now + tx.config.connectorSessionIdleMs);
    if (sessionHandle !== undefined) {
      armSessionHandleRetire(tx, tx.now + tx.config.sessionHandleRetireMs);
      // The call counts as the session handle's own activity (act recorded the token's).
      tx.sql.exec("UPDATE users SET last_seen = ? WHERE handle = ?", tx.now, me);
    }

    const notifications = [];
    let lobbySeq: number | undefined;
    if (firstJoin) {
      const effectiveRole = role ?? before.role;
      const effectiveHarness = harness ?? before.harness ?? "unknown";
      // Role and harness are the user's own text; quote them so a system
      // message never carries unbounded user text as board-authored words.
      const body =
        `${me} joined (${before.kind}, harness: ${JSON.stringify(effectiveHarness)}` +
        (effectiveRole ? `, role: ${JSON.stringify(effectiveRole)}` : "") +
        ")";
      // A session handle's first join posts no Lobby line (issue #98): a token could fill the Lobby with
      // one per session, and a muted token's handles must not write there. It is still subscribed.
      if (sessionHandle === undefined) {
        lobbySeq = insertMessage(tx, {
        topic: LOBBY,
        author: "system",
        authorKind: "system",
        body,
        replyTo: null,
        mentions: [],
        isSystem: true,
        });
      }
      checkSubscriptionRoom(tx, me, LOBBY);
      tx.sql.exec(
        `INSERT INTO subscriptions (handle, topic, level, last_read_seq)
         VALUES (?, ?, 'digest', ?)
         ON CONFLICT (handle, topic) DO NOTHING`,
        me,
        LOBBY,
        lobbySeq ?? topicMaxSeq(tx, LOBBY),
      );
      if (lobbySeq !== undefined) {
        notifications.push({
          type: "message" as const,
          topic: LOBBY,
          seq: lobbySeq,
          author: "system",
          mentions: [],
          isSystem: true,
        });
      }
    }

    const detail: Record<string, unknown> = {
      first_join: firstJoin,
      replaced_sessions: replaced.map((r) => r.id),
    };
    if (role !== undefined) detail.role = { before: before.role, after: role };
    if (harness !== undefined) {
      detail.harness = { before: before.harness, after: harness };
    }
    if (harnessDefaulted) detail.harness_default = "oauth_client";
    if (lobbySeq !== undefined) detail.lobby_seq = lobbySeq;
    if (sessionHandle?.created) detail.session_handle_created = true;
    if (sessionHandle?.unretired) detail.unretired = true;

    return {
      value: {
        handle: me,
        ...(parent !== undefined ? { parent } : {}),
        kind: before.kind,
        role: role ?? before.role,
        session,
        first_join: firstJoin,
        wake: "none",
        ...(viaGrant ? { note: SESSION_NOTE } : {}),
        ...(sessionHandle !== undefined && parent !== undefined ? { note: sessionHandleNote(me, parent) } : {}),
      },
      audit: {
        targetType: "session",
        targetId: session,
        session,
        ...callAs,
        ...(lobbySeq !== undefined ? { topic: LOBBY } : {}),
        detail,
      },
      notifications,
    };
  },
};

/** `bbs_role_set`: your own role, or anyone's if you are a coordinator. */
export const roleSet: ActionDef = {
  name: "role_set",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const role = reqLabel(p, "role", tx.config.maxRoleLength);
    const given = optLabel(p, "user", 64);
    const user = given === undefined ? tx.actor.handle : (canonicalHandle(tx.sql, given) ?? given);
    if (user !== tx.actor.handle && !tx.actor.isCoordinator) {
      throw denied("only a coordinator can set another user's role");
    }
    const before = tx.sql.one<{ role: string; role_set_by: string | null }>(
      "SELECT role, role_set_by FROM users WHERE handle = ?",
      user,
    );
    if (!before) throw new BbsError("not_found", `no user named ${user}`);
    tx.sql.exec(
      "UPDATE users SET role = ?, role_set_by = ? WHERE handle = ?",
      role,
      tx.actor.handle,
      user,
    );
    return {
      value: { user, role, role_set_by: tx.actor.handle },
      audit: {
        targetType: "user",
        targetId: user,
        detail: {
          before: { role: before.role, role_set_by: before.role_set_by },
          after: { role, role_set_by: tx.actor.handle },
        },
      },
    };
  },
};

/**
 * `bbs_who`: users, roles and session state, optionally only those in a topic.
 * `session`, `machine`, `os` and `model` are those of the newest live session
 * (offline and null when there is none). `sessions` lists every live session
 * of the handle: a connector handle has one per chat, any other handle at most
 * one, because its join ends the others. Each carries `wake`: `adapter` when an
 * adapter socket is open for that session, else `none` (nothing will ring it).
 * Neither shows a session id. A session handle (issue #98) has `parent`, the
 * handle whose token it was made under, so a reader can group them; a retired
 * one (status `retired`) is left out unless `include_retired` is set.
 */
export const who: ActionDef = {
  name: "who",
  kind: "read",
  run(tx, input) {
    const p = asParams(input);
    const topic = optTopic(p);
    const includeRetired = optBool(p, "include_retired") ?? false;
    if (topic !== undefined) getTopic(tx, topic);
    const rows =
      topic === undefined
        ? tx.sql.all<UserRow>(
            `SELECT ${userColumns()} FROM users
             ${includeRetired ? "" : "WHERE retired_at IS NULL"} ORDER BY handle`,
          )
        : tx.sql.all<UserRow & { level: string }>(
            `SELECT ${userColumns("u.")}, s.level
             FROM users u JOIN subscriptions s ON s.handle = u.handle
             WHERE s.topic = ? AND s.level <> 'off' ${includeRetired ? "" : "AND u.retired_at IS NULL"}
             ORDER BY u.handle`,
            topic,
          );
    const users = rows.map((u) => {
      const session = tx.sql.one<{
        state: string;
        machine: string | null;
        os: string | null;
        model: string | null;
      }>(
        `SELECT state, machine, os, model FROM sessions
         WHERE handle = ? AND state <> 'gone'
         ORDER BY attached_at DESC LIMIT 1`,
        u.handle,
      );
      const live = tx.sql.all<{
        state: string;
        machine: string | null;
        os: string | null;
        model: string | null;
        attached_at: number;
        ws_open: number;
        last_active_at: number | null;
      }>(
        `SELECT state, machine, os, model, attached_at, ws_open,
                (SELECT MAX(ts) FROM audit WHERE session = sessions.id) AS last_active_at
         FROM sessions WHERE handle = ? AND state <> 'gone'
         ORDER BY attached_at DESC, id`,
        u.handle,
      );
      return {
        handle: u.handle,
        kind: u.kind,
        harness: u.harness,
        role: u.role,
        role_set_by: u.role_set_by,
        coordinator: Number(u.is_coordinator) === 1,
        admin: Number(u.is_admin) === 1,
        status: u.status,
        ...(u.parent !== null ? { parent: u.parent } : {}),
        last_seen: u.last_seen === null ? null : Number(u.last_seen),
        session: session ? session.state : "offline",
        machine: session?.machine ?? null,
        os: session?.os ?? null,
        model: session?.model ?? null,
        sessions: live.map((r) => ({
          state: r.state,
          machine: r.machine,
          os: r.os,
          model: r.model,
          attached_at: Number(r.attached_at),
          wake: wakeOf(r.ws_open),
          ...(r.last_active_at === null ? {} : { last_active_at: Number(r.last_active_at) }),
        })),
        ...("level" in u ? { level: u.level } : {}),
      };
    });
    return {
      value: { topic: topic ?? null, users },
      audit: {
        targetType: "topic",
        ...(topic !== undefined ? { targetId: topic, topic } : {}),
        detail: { count: users.length },
      },
    };
  },
};

/**
 * `bbs admin user add` (Q1): a human admin creates a user and receives its
 * token once. The board stores only the token's SHA-256.
 */
export const adminUserAdd: ActionDef = {
  name: "admin_user_add",
  kind: "change",
  run(tx, input) {
    if (tx.actor.kind !== "human" || !tx.actor.isAdmin) {
      throw denied("only a human admin can add users");
    }
    const p = asParams(input);
    const handle = reqHandle(p, "handle");
    const kind = optEnum<UserKind>(p, "kind", ["agent", "human"]) ?? "agent";
    const harness = optLabel(p, "harness", 64);
    const role = optLabel(p, "role", tx.config.maxRoleLength) ?? "";
    const token = `bbs_${base64url(tx.randomBytes(32))}`;
    insertUserOnce(
      tx,
      ["handle", "kind", "harness", "role", "role_set_by", "token_hash", "created_at"],
      [handle, kind, harness ?? null, role, role ? tx.actor.handle : null, tx.sha256(token), tx.now],
    );
    return {
      value: { handle, kind, token },
      audit: {
        targetType: "user",
        targetId: handle,
        detail: { kind, harness: harness ?? null, role },
      },
    };
  },
};

const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Internal: create or update the first human admin from the static local
 * human credential (spec §4.2). Called by `Board.bootstrapHuman` only.
 */
export const bootstrapHuman: ActionDef = {
  name: "bootstrap_human",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const handle = reqHandle(p, "handle");
    const tokenHash = reqString(p, "token_hash", 64);
    if (!TOKEN_HASH_RE.test(tokenHash)) {
      throw new BbsError("bad_request", "token_hash must be 64 lowercase hex digits");
    }
    // Same case-insensitive uniqueness as admin_user_add: "OWNER" must not
    // become a second admin beside "owner". The lookup serves the update
    // path; a new account's uniqueness is the INSERT's own condition.
    const stored = canonicalHandle(tx.sql, handle);
    if (stored !== undefined && stored !== handle) {
      throw new BbsError("exists", `a user named ${stored} already exists`);
    }
    const existing = tx.sql.one<{
      handle: string;
      kind: string;
      is_admin: number;
      token_hash: string | null;
    }>("SELECT handle, kind, is_admin, token_hash FROM users WHERE handle = ?", handle);
    // Another human admin holding this credential is about to be retired
    // (B17: the same person under a new handle), so only other users clash.
    const other = tx.sql.one<{ handle: string }>(
      `SELECT handle FROM users WHERE token_hash = ? AND handle <> ?
       AND NOT (kind = 'human' AND is_admin = 1)`,
      tokenHash,
      handle,
    );
    if (other) {
      throw new BbsError("exists", "that credential already belongs to another user");
    }
    if (existing && existing.kind !== "human") {
      throw denied(`${handle} is an agent user and cannot become human`);
    }
    // B17: there is one bootstrap admin. Any other human admin was made by an
    // earlier BBS_HUMAN_HANDLE (no action grants `admin`), so it is retired:
    // the flag is cleared and its credential revoked, in this audited change.
    const retiring = retireOtherAdmins(tx, handle);
    const retired = retiring.retired;
    const retiredDetail =
      retired.length > 0
        ? {
            stale_tasks: retiring.staleTasks,
            ...(Object.keys(retiring.removedPasskeys).length > 0 ? { removed_passkeys: retiring.removedPasskeys } : {}),
          }
        : {};
    // A credential coming back (the handle was switched back) is valid again.
    tx.sql.exec("DELETE FROM revoked_tokens WHERE token_hash = ?", tokenHash);
    if (!existing) {
      insertUserOnce(tx, ["handle", "kind", "is_admin", "token_hash", "created_at"], [handle, "human", 1, tokenHash, tx.now]);
      return {
        value: { handle, created: true, changed: true, retired },
        audit: { targetType: "user", targetId: handle, detail: { created: true, retired, ...retiredDetail } },
        notifications: retiring.notifications,
      };
    }
    const rotated = existing.token_hash !== null && existing.token_hash !== tokenHash;
    const revoked: NotificationWork[] = rotated ? [revokeHash(tx, existing.token_hash as string, handle)] : [];
    // A rotated credential may have leaked: whoever held it could have paired a browser and
    // registered a passkey. Both go with it, so nothing made under the old credential outlives it.
    const endedWebSessions = rotated ? revokeWebSessions(tx, handle) : 0;
    const removedPasskeys = rotated ? revokePasskeys(tx, handle) : [];
    tx.sql.exec(
      "UPDATE users SET is_admin = 1, token_hash = ? WHERE handle = ?",
      tokenHash,
      handle,
    );
    return {
      value: { handle, created: false, changed: true, retired },
      audit: {
        targetType: "user",
        targetId: handle,
        detail: {
          created: false,
          credential_rotated: existing.token_hash !== tokenHash,
          ...(rotated ? { ended_web_sessions: endedWebSessions, own_removed_passkeys: removedPasskeys } : {}),
          admin_granted: Number(existing.is_admin) !== 1,
          retired,
          ...retiredDetail,
        },
      },
      notifications: [...revoked, ...retiring.notifications],
    };
  },
};

/**
 * Move a token hash to `revoked_tokens`, so a later use is refused as
 * `revoked_token`. Returns the work that closes the user's sockets opened
 * with it (M4b, B48; people have none on `/ws`, so it is for completeness).
 */
function revokeHash(tx: Tx, tokenHash: string, handle: string): NotificationWork {
  tx.sql.exec(
    `INSERT INTO revoked_tokens (token_hash, handle, revoked_at) VALUES (?, ?, ?)
     ON CONFLICT (token_hash) DO NOTHING`,
    tokenHash,
    handle,
    tx.now,
  );
  return { type: "disconnect", handle, reason: "credential_revoked" };
}

/**
 * B17: retire every human admin other than `keep`: clear `admin` and
 * `coordinator`, revoke its credential, and mark its unfinished tasks stale
 * with the coordinator notice (as for a kick). The account stays (its
 * messages and history are the person's) and can no longer sign in. Its
 * status stays `active`: the schema has no retired state (backlog B41); a
 * use of the revoked credential is audited with `revoked: "retired"`.
 */
function retireOtherAdmins(
  tx: Tx,
  keep: string,
): { retired: string[]; staleTasks: number[]; notifications: NotificationWork[]; removedPasskeys: Record<string, string[]> } {
  const others = tx.sql.all<{ handle: string; token_hash: string | null }>(
    "SELECT handle, token_hash FROM users WHERE kind = 'human' AND is_admin = 1 AND handle <> ? ORDER BY handle",
    keep,
  );
  const staleTasks: number[] = [];
  const notifications: NotificationWork[] = [];
  const removedPasskeys: Record<string, string[]> = {};
  for (const o of others) {
    if (o.token_hash !== null) notifications.push(revokeHash(tx, o.token_hash, o.handle));
    // The flags go first, so a retired coordinator is not told about its own tasks.
    tx.sql.exec(
      "UPDATE users SET is_admin = 0, is_coordinator = 0, token_hash = NULL WHERE handle = ?",
      o.handle,
    );
    // A retired person's browser sessions end with their credential.
    revokeWebSessions(tx, o.handle);
    // Their passkeys too (issue #54): the status stays active, so a passkey would still sign them in.
    const passkeys = revokePasskeys(tx, o.handle);
    if (passkeys.length > 0) removedPasskeys[o.handle] = passkeys;
    const stale = staleHeldTasks(tx, o.handle, "assignee_retired");
    staleTasks.push(...stale.staleTasks);
    notifications.push(...stale.notifications);
  }
  return { retired: others.map((o) => o.handle), staleTasks: staleTasks.sort((a, b) => a - b), notifications, removedPasskeys };
}

/** Human admins who are not kicked, by handle (read-only; for notices such as M6a's export failure). */
export function humanAdmins(sql: Tx["sql"]): string[] {
  return sql
    .all<{ handle: string }>(
      "SELECT handle FROM users WHERE kind = 'human' AND is_admin = 1 AND status <> 'kicked' ORDER BY handle",
    )
    .map((r) => r.handle);
}

/** True when some human admin other than `handle` exists (B17: bootstrap must run). */
export function otherAdminExists(sql: Tx["sql"], handle: string): boolean {
  return (
    sql.one("SELECT handle FROM users WHERE kind = 'human' AND is_admin = 1 AND handle <> ? LIMIT 1", handle) !==
    undefined
  );
}

/** Internal: a rejected sign-in. Always fails, so `act` audits it as denied. */
export const authDenied: ActionDef = {
  name: "auth",
  kind: "change",
  run(_tx, input) {
    const p = asParams(input);
    const reason = optString(p, "reason", 64) ?? "unknown";
    throw denied(`authentication failed: ${reason}`, "unauthorized");
  },
};

