// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Human `admin` powers (design §4) and `whoami`.
 *
 * Only a human user with the `admin` flag may run the `admin_*` actions here.
 * Every agent is refused, a coordinator included, and so is a person without
 * the flag. The tools are offered on `/api` and the CLI, never on `/mcp`
 * (agents only), so an agent cannot even see them there.
 *
 * - `admin_reinstate`: a kicked user becomes active with a NEW token, shown
 *   once (B33); the old token stays revoked. The coordinator flag is cleared
 *   unless the admin passes `coordinator: true` (B35). The user's recorded
 *   Lobby offenses are cleared, so it starts again at a warning.
 * - `admin_coordinator_grant` / `admin_coordinator_remove`: set or clear the
 *   flag on any user (agent or person, design §4 "flags it can hold").
 *
 * Reading the full audit log is `bbs_audit`, open to people and coordinators
 * (design §13). Force-archive lands with archiving in M6b.
 *
 * Each change writes a line to `#admin-log`, like the auto-administrator's.
 * `kind` is never changed by any action: it is fixed when the account is made.
 */

import { asParams, optBool, reqHandle } from "../params.ts";
import { BbsError, denied, type ActionDef, type NotificationWork, type Tx } from "../types.ts";
import { adminLog } from "./admin.ts";
import { base64url, resolveHandle } from "./common.ts";

function requireHumanAdmin(tx: Tx, what: string): void {
  if (tx.actor.kind !== "human" || !tx.actor.isAdmin) {
    throw denied(`only a human admin can ${what}`);
  }
}

interface TargetRow {
  handle: string;
  kind: string;
  status: string;
  is_coordinator: number;
  parent: string | null;
}

function target(tx: Tx, handle: string): TargetRow {
  const row = tx.sql.one<TargetRow>(
    "SELECT handle, kind, status, is_coordinator, parent FROM users WHERE handle = ?",
    handle,
  );
  if (!row) throw new BbsError("not_found", `no user named ${handle}`);
  return row;
}

/** `bbs admin reinstate <handle> [--coordinator]`: undo a kick with a new token. */
export const adminReinstate: ActionDef = {
  name: "admin_reinstate",
  kind: "change",
  run(tx, input) {
    requireHumanAdmin(tx, "reinstate a user");
    const p = asParams(input);
    const handle = resolveHandle(tx.sql, reqHandle(p, "handle"));
    const keepCoordinator = optBool(p, "coordinator") ?? false;
    const user = target(tx, handle);
    // A session handle has no token to reissue, and it is kicked only with its token (issue #98): reinstate that.
    if (user.parent !== null) {
      throw new BbsError(
        "conflict",
        `${handle} is a session handle of ${user.parent}; it has no token and is not reinstated. ` +
          `A new session under ${user.parent}'s token gets a new handle`,
      );
    }
    if (user.status !== "kicked") {
      throw new BbsError("conflict", `${handle} is not kicked (status ${user.status})`);
    }
    // B33: always a fresh token; the kicked one stays in revoked_tokens.
    const token = `bbs_${base64url(tx.randomBytes(32))}`;
    tx.sql.exec(
      "UPDATE users SET status = 'active', token_hash = ?, is_coordinator = ? WHERE handle = ?",
      tx.sha256(token),
      keepCoordinator ? 1 : 0,
      handle,
    );
    const cleared = tx.sql.all<{ id: number }>(
      "DELETE FROM admin_events WHERE handle = ? AND kind = 'lobby_flood' RETURNING id",
      handle,
    ).length;
    const wasCoordinator = Number(user.is_coordinator) === 1;
    const flag = keepCoordinator
      ? "coordinator flag set"
      : wasCoordinator
        ? "coordinator flag cleared"
        : "not a coordinator";
    const log = adminLog(tx, `reinstate: ${handle} reinstated by ${tx.actor.handle} (new token issued; ${flag})`);
    return {
      value: { handle, token, coordinator: keepCoordinator, offenses_cleared: cleared },
      audit: {
        targetType: "user",
        targetId: handle,
        detail: {
          before: { status: user.status, coordinator: wasCoordinator },
          after: { status: "active", coordinator: keepCoordinator },
          new_token: true,
          offenses_cleared: cleared,
          log_seq: log.seq,
        },
      },
      // A kick already closed the user's sockets; any socket still bound to
      // the old token is closed too (M4b, B48).
      notifications: [log.notification, { type: "disconnect", handle, reason: "credential_revoked" }],
    };
  },
};

function coordinatorChange(grant: boolean): ActionDef {
  return {
    name: grant ? "admin_coordinator_grant" : "admin_coordinator_remove",
    kind: "change",
    run(tx, input) {
      requireHumanAdmin(tx, grant ? "grant coordinator" : "remove coordinator");
      const p = asParams(input);
      const handle = resolveHandle(tx.sql, reqHandle(p, "handle"));
      const user = target(tx, handle);
      if (grant && user.parent !== null) {
        throw denied(`${handle} is a session handle of ${user.parent}; a session handle cannot be a coordinator`);
      }
      if (grant && user.status === "kicked") {
        throw new BbsError("conflict", `${handle} is kicked; reinstate it with coordinator set instead`);
      }
      const before = Number(user.is_coordinator) === 1;
      const changed = before !== grant;
      let logSeq: number | undefined;
      const notifications: NotificationWork[] = [];
      if (changed) {
        tx.sql.exec("UPDATE users SET is_coordinator = ? WHERE handle = ?", grant ? 1 : 0, handle);
        const log = adminLog(
          tx,
          `coordinator: ${handle} ${grant ? "granted" : "removed"} by ${tx.actor.handle}`,
        );
        logSeq = log.seq;
        notifications.push(log.notification);
      }
      return {
        value: { handle, coordinator: grant, changed },
        audit: {
          targetType: "user",
          targetId: handle,
          detail: {
            before: { coordinator: before },
            after: { coordinator: grant },
            changed,
            ...(logSeq !== undefined ? { log_seq: logSeq } : {}),
          },
        },
        notifications,
      };
    },
  };
}

export const adminCoordinatorGrant = coordinatorChange(true);
export const adminCoordinatorRemove = coordinatorChange(false);

/** `bbs_whoami`: the caller's own handle, kind and flags, and the server's build. A read; not audited. */
export const whoami: ActionDef = {
  name: "whoami",
  kind: "read",
  run(tx) {
    const a = tx.actor;
    return {
      value: {
        handle: a.handle,
        kind: a.kind,
        admin: a.isAdmin,
        coordinator: a.isCoordinator,
        status: a.status,
        ...(a.parent !== undefined ? { parent: a.parent } : {}),
        via: tx.ctx.via,
        ...(tx.ctx.session !== undefined ? { session: tx.ctx.session } : {}),
        ...(tx.server ? { server: tx.server } : {}),
        // What the deploy says about passkey approval (it is never changed by a tool); a person's concern only.
        ...(a.kind === "human" ? { approval: { required: tx.approval.required, allow_synced: tx.approval.allowSynced } } : {}),
      },
      audit: { targetType: "user", targetId: a.handle },
    };
  },
};
