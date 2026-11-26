// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Web sign-in by pairing code (issue #47, design §4 and §12).
 *
 * A browser with no session asks the board for a pairing: a short code and a
 * poll secret. The person runs `bbs web-login <code>` on a machine where the
 * human credential lives, which approves that one pairing; the browser's next
 * poll then claims it and gets a web session, a cookie the Worker sets. Only
 * SHA-256 hashes of the code, the poll secret and the cookie value are stored.
 *
 * Who may do what:
 * - start and claim: anyone, with no credential (the Worker calls the `Board`
 *   methods; they are not tools). Start is limited per source and board-wide;
 *   claim needs the poll secret.
 * - show and approve: a person acting through the CLI only. Not on `/mcp`, not
 *   from a web session, never an agent. Wrong codes count against a limit.
 * - sessions, revoke, sign out: a person; revoke from the CLI, sign out from
 *   the web session itself.
 */

import type { Sql } from "../sql.ts";
import { asParams, optBool, optString, reqString, UNSAFE_LABEL_RE } from "../params.ts";
import { BbsError, denied, type ActionDef, type ActionOutcome, type BoardConfig, type Tx } from "../types.ts";
import { pollApprovalId, requestApproval } from "./approval.ts";
import { base64url } from "./common.ts";
import { armPrune, CODE_ALPHABET, CODE_LENGTH, randomCode, requirePerson } from "./web-common.ts";

export { armPrune, requirePerson };

/** Longest requester label kept. */
export const MAX_REQUESTER_LABEL = 80;

/** The label sanitizer's unsafe characters (`optLabel` refuses them), as a global pattern to remove them. */
const UNSAFE_LABEL_CHARS = new RegExp(UNSAFE_LABEL_RE.source, "g");

/** `XXXX-XXXX`, as shown to the person. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * The code as stored and compared: upper case, without hyphens and spaces.
 * Undefined when what is left cannot be a code.
 */
export function normalizeCode(raw: string): string | undefined {
  const code = raw.replace(/[\s-]+/g, "").toUpperCase();
  if (code.length !== CODE_LENGTH) return undefined;
  for (const c of code) if (!CODE_ALPHABET.includes(c)) return undefined;
  return code;
}

/** A requester label: control, line-separator and bidirectional characters removed, cut short. */
export function cleanLabel(raw: string): string {
  const label = raw.replace(UNSAFE_LABEL_CHARS, "").trim().slice(0, MAX_REQUESTER_LABEL);
  return label === "" ? "unknown browser" : label;
}

/**
 * Whether a new pairing from `source` fits the limits: `busy` when the board
 * already holds `webPairingMaxPending` live ones, `source` when this source
 * holds `webPairingMaxPerSource`. The start action enforces the same limits
 * inside its INSERT; this read lets the Board refuse a flood without writing
 * a row per refused request.
 */
export function pairingRoom(
  sql: Sql,
  config: BoardConfig,
  now: number,
  source: string,
): "ok" | "busy" | "source" {
  const row = sql.one<{ n: number; s: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(source = ?), 0) AS s FROM web_pairings
     WHERE state <> 'consumed' AND expires_at > ?`,
    source,
    now,
  );
  if (Number(row?.n ?? 0) >= config.webPairingMaxPending) return "busy";
  if (Number(row?.s ?? 0) >= config.webPairingMaxPerSource) return "source";
  return "ok";
}

/**
 * Make a web session for the acting person and drop the oldest ones past
 * `webSessionMaxPerUser`. The one place a session row is made, for a claimed
 * pairing and for a passkey sign-in alike, so both have the same cookie value
 * shape, lifetime and cap. `cookie` is the value for the Worker's Set-Cookie
 * only; the row keeps its SHA-256.
 */
export function createWebSession(
  tx: Tx,
  label: string,
  method: "pairing" | "passkey",
  /** The public id of the passkey that made a `passkey` session, so removing it can end the session. */
  passkey?: string,
): { cookie: string; id: string; expiresAt: number; dropped: string[] } {
  const cookie = base64url(tx.randomBytes(32));
  const id = `ws_${base64url(tx.randomBytes(9))}`;
  const expiresAt = tx.now + tx.config.webSessionTtlMs;
  tx.sql.exec(
    `INSERT INTO web_sessions (id, handle, token_hash, label, created_at, renewed_at, expires_at, method, passkey)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    tx.actor.handle,
    tx.sha256(cookie),
    label,
    tx.now,
    tx.now,
    expiresAt,
    method,
    passkey ?? null,
  );
  // Past the cap, the oldest sessions go.
  const dropped = tx.sql
    .all<{ id: string }>(
      `DELETE FROM web_sessions WHERE handle = ? AND id NOT IN (
         SELECT id FROM web_sessions WHERE handle = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)
       RETURNING id`,
      tx.actor.handle,
      tx.actor.handle,
      tx.config.webSessionMaxPerUser,
    )
    .map((r) => r.id);
  armPrune(tx);
  return { cookie, id, expiresAt, dropped };
}

/**
 * Delete every passkey of `handle` and their pending passkey challenges (a
 * retired or kicked credential). The schema has no retired state, so without
 * this a retired person's passkeys would still sign them in. Returns the
 * removed passkeys' public ids.
 */
export function revokePasskeys(tx: Tx, handle: string): string[] {
  tx.sql.exec("DELETE FROM passkey_challenges WHERE handle = ?", handle);
  // A request waiting for one of these passkeys goes with them.
  tx.sql.exec("DELETE FROM approvals WHERE handle = ?", handle);
  return tx.sql.all<{ id: string }>("DELETE FROM passkeys WHERE handle = ? RETURNING id", handle).map((r) => r.id);
}

/** Delete the web sessions a passkey made (it was removed). Returns their ids. */
export function revokePasskeySessions(tx: Tx, passkey: string): string[] {
  return tx.sql
    .all<{ id: string }>("DELETE FROM web_sessions WHERE handle = ? AND passkey = ? RETURNING id", tx.actor.handle, passkey)
    .map((r) => r.id);
}

/**
 * Delete every web session of `handle` (a kick, a retired or a rotated credential), and the
 * pairings that handle approved which no browser has claimed yet, so an approval made with the
 * old credential cannot become a session afterwards. Returns how many sessions.
 */
export function revokeWebSessions(tx: Tx, handle: string): number {
  tx.sql.exec("DELETE FROM web_pairings WHERE approved_by = ? AND state = 'approved'", handle);
  return tx.sql.all<{ id: string }>("DELETE FROM web_sessions WHERE handle = ? RETURNING id", handle).length;
}

/**
 * Refuse once this person has tried too many wrong pairing codes (B-style
 * guess limit): counted from the audit rows of refused show and approve
 * calls, so it survives a restart and needs no state of its own.
 */
function checkGuessLimit(tx: Tx): void {
  const row = tx.sql.one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit
     WHERE actor = ? AND action IN ('web_pairing_show', 'web_pairing_approve')
       AND result = 'denied' AND ts > ?`,
    tx.actor.handle,
    tx.now - tx.config.webPairingGuessWindowMs,
  );
  if (Number(row?.n ?? 0) >= tx.config.webPairingGuessLimit) {
    throw denied("too many wrong pairing codes; try again later", "rate_limited");
  }
}

function codeParam(p: Record<string, unknown>): string {
  const code = normalizeCode(reqString(p, "code", 64));
  if (code === undefined) {
    throw new BbsError("bad_request", "code must be eight letters and digits, like ABCD-2345");
  }
  return code;
}

const NO_SUCH_CODE = "no live pairing code matches that code (unknown, expired or already used)";

/** Internal: a browser with no session asks for a pairing. Called by `Board.webPairStart`. */
export const webPairStart: ActionDef = {
  name: "web_pair_start",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const source = reqString(p, "source", 64);
    const label = cleanLabel(optString(p, "label", 1_000) ?? "");
    let code = "";
    let codeHash = "";
    for (let tries = 0; tries < 5 && code === ""; tries++) {
      const candidate = randomCode(tx.randomBytes);
      const hash = tx.sha256(candidate);
      // Unique among every pairing still in the table, live or not yet pruned.
      if (!tx.sql.one("SELECT 1 AS x FROM web_pairings WHERE code_hash = ?", hash)) {
        code = candidate;
        codeHash = hash;
      }
    }
    if (code === "") throw new BbsError("internal", "could not make a pairing code");
    const pollSecret = base64url(tx.randomBytes(32));
    const expiresAt = tx.now + tx.config.webPairingTtlMs;
    // Both limits are conditions of the INSERT itself: no row is judged by a
    // count read earlier, so two starts cannot both take the last place.
    const inserted = tx.sql.all<{ id: number }>(
      `INSERT INTO web_pairings (code_hash, poll_hash, approval_hash, label, source, created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM web_pairings WHERE state <> 'consumed' AND expires_at > ?) < ?
         AND (SELECT COUNT(*) FROM web_pairings
              WHERE source = ? AND state <> 'consumed' AND expires_at > ?) < ?
       RETURNING id`,
      codeHash,
      tx.sha256(pollSecret),
      // The browser re-derives this secret id from its poll secret when an approval is waiting.
      tx.sha256(pollApprovalId(tx.sha256, pollSecret)),
      label,
      source,
      tx.now,
      expiresAt,
      tx.now,
      tx.config.webPairingMaxPending,
      source,
      tx.now,
      tx.config.webPairingMaxPerSource,
    );
    const id = inserted[0]?.id;
    if (id === undefined) {
      throw denied("too many sign-in requests right now; try again in a few minutes", "rate_limited");
    }
    armPrune(tx);
    return {
      value: { code: formatCode(code), poll_secret: pollSecret, expires_in_ms: tx.config.webPairingTtlMs },
      // Never the code or the poll secret.
      audit: { targetType: "web_pairing", targetId: String(id), detail: { label, source, expires_at: expiresAt } },
    };
  },
};

/** `bbs_web_pairing_show`: who is asking for this code (a read). */
export const webPairingShow: ActionDef = {
  name: "web_pairing_show",
  kind: "read",
  run(tx, input) {
    requirePerson(tx, "look up a sign-in request", ["cli"]);
    const p = asParams(input);
    checkGuessLimit(tx);
    const code = codeParam(p);
    const row = tx.sql.one<{ id: number; label: string; created_at: number; expires_at: number }>(
      `SELECT id, label, created_at, expires_at FROM web_pairings
       WHERE code_hash = ? AND state = 'pending' AND expires_at > ?`,
      tx.sha256(code),
      tx.now,
    );
    if (!row) throw denied(NO_SUCH_CODE, "not_found");
    return {
      value: {
        label: row.label,
        created_at: Number(row.created_at),
        age_ms: tx.now - Number(row.created_at),
        expires_in_ms: Number(row.expires_at) - tx.now,
      },
      audit: { targetType: "web_pairing", targetId: String(row.id) },
    };
  },
};

/**
 * Approve one pairing by its row id, as the acting person: the change both the
 * ungated tool and an approved request run. The UPDATE repeats the conditions
 * and is judged by the rows it changes, so two approvals of one pairing cannot
 * both succeed.
 */
export function approvePairing(tx: Tx, id: number): ActionOutcome {
  const rows = tx.sql.all<{ id: number; label: string; source: string }>(
    `UPDATE web_pairings SET state = 'approved', approved_by = ?, approved_at = ?
     WHERE id = ? AND state = 'pending' AND expires_at > ?
     RETURNING id, label, source`,
    tx.actor.handle,
    tx.now,
    id,
    tx.now,
  );
  const row = rows[0];
  if (!row) throw denied(NO_SUCH_CODE, "not_found");
  return {
    value: { approved: true, label: row.label },
    audit: { targetType: "web_pairing", targetId: String(row.id), detail: { label: row.label, source: row.source } },
  };
}

/**
 * `bbs_web_pairing_approve`: approve one pairing, once, as the caller. When the
 * board requires approval, the code is checked as always (it must be live, and
 * the guess limit applies) and the call then asks for a passkey's approval
 * instead of approving; the pairing stays pending until the signature arrives.
 */
export const webPairingApprove: ActionDef = {
  name: "web_pairing_approve",
  kind: "change",
  run(tx, input) {
    requirePerson(tx, "approve a sign-in request", ["cli"]);
    const p = asParams(input);
    checkGuessLimit(tx);
    const code = codeParam(p);
    // Look before writing, so a wrong code changes nothing.
    const live = tx.sql.one<{ id: number; label: string; expires_at: number }>(
      "SELECT id, label, expires_at FROM web_pairings WHERE code_hash = ? AND state = 'pending' AND expires_at > ?",
      tx.sha256(code),
      tx.now,
    );
    if (!live) throw denied(NO_SUCH_CODE, "not_found");
    if (tx.approval.required) {
      return requestApproval(tx, {
        action: "web_pairing_approve",
        ref: String(live.id),
        scope: { action: "web_pairing_approve", handle: tx.actor.handle, pairing: Number(live.id), label: live.label },
        pairing: Number(live.id),
        notAfter: Number(live.expires_at),
      });
    }
    return approvePairing(tx, Number(live.id));
  },
};

/**
 * Internal: the browser claims its approved pairing and gets a session. The
 * actor is the person who approved it, `via = web`. The one UPDATE that marks
 * the pairing consumed is judged by the rows it changes, so two claims of one
 * pairing make exactly one session. Called by `Board.webPairClaim`.
 */
export const webPairClaim: ActionDef = {
  name: "web_pair_claim",
  kind: "change",
  // Signing in is not the person's activity (no last_seen, no lease renewal).
  passive: true,
  run(tx, input) {
    const p = asParams(input);
    const pollSecret = reqString(p, "poll_secret", 128);
    const pollHash = tx.sha256(pollSecret);
    // Look before writing, so a refused claim changes nothing.
    const ready = tx.sql.one(
      "SELECT 1 AS x FROM web_pairings WHERE poll_hash = ? AND state = 'approved' AND expires_at > ?",
      pollHash,
      tx.now,
    );
    if (!ready) throw new BbsError("conflict", "that pairing is not approved, or was already used", "denied");
    const claimed = tx.sql.all<{ id: number; label: string; approved_by: string }>(
      `UPDATE web_pairings SET state = 'consumed'
       WHERE poll_hash = ? AND state = 'approved' AND expires_at > ?
       RETURNING id, label, approved_by`,
      pollHash,
      tx.now,
    );
    const pairing = claimed[0];
    // The consuming UPDATE is the verdict: another claim got there first, or nothing is made.
    if (!pairing) throw new BbsError("conflict", "that pairing is not approved, or was already used", "denied");
    if (pairing.approved_by !== tx.actor.handle || tx.actor.kind !== "human" || tx.actor.status !== "active") {
      throw denied("the person who approved this pairing can no longer sign in");
    }
    const made = createWebSession(tx, pairing.label, "pairing");
    const { cookie, id, expiresAt, dropped } = made;
    return {
      // `session` is the cookie value: for the Worker's Set-Cookie only, never in the audit row.
      value: { session: cookie, id, handle: tx.actor.handle, expires_at: expiresAt, max_age_ms: tx.config.webSessionTtlMs },
      audit: {
        targetType: "web_session",
        targetId: id,
        detail: { pairing: pairing.id, label: pairing.label, expires_at: expiresAt, revoked_for_cap: dropped },
      },
    };
  },
};

/**
 * Internal: slide a session's expiry forward after a use more than
 * `webSessionRenewAfterMs` since its last renewal. The UPDATE repeats that
 * condition, so a session is renewed (and audited) at most once per period.
 */
export const webSessionRenew: ActionDef = {
  name: "web_session_renew",
  kind: "change",
  passive: true,
  run(tx, input) {
    const id = reqString(asParams(input), "id", 64);
    const expiresAt = tx.now + tx.config.webSessionTtlMs;
    const rows = tx.sql.all<{ id: string }>(
      `UPDATE web_sessions SET renewed_at = ?, expires_at = ?
       WHERE id = ? AND handle = ? AND renewed_at < ? AND expires_at > ?
       RETURNING id`,
      tx.now,
      expiresAt,
      id,
      tx.actor.handle,
      tx.now - tx.config.webSessionRenewAfterMs,
      tx.now,
    );
    if (rows.length === 0) throw new BbsError("conflict", "session not due for renewal");
    return { value: { id, expires_at: expiresAt }, audit: { targetType: "web_session", targetId: id, detail: { expires_at: expiresAt } } };
  },
};

/** `bbs_web_sessions`: the caller's own sessions (a read). */
export const webSessions: ActionDef = {
  name: "web_sessions",
  kind: "read",
  run(tx) {
    requirePerson(tx, "list web sessions", ["cli", "web"]);
    const rows = tx.sql.all<{ id: string; label: string; created_at: number; renewed_at: number; expires_at: number }>(
      `SELECT id, label, created_at, renewed_at, expires_at FROM web_sessions
       WHERE handle = ? AND expires_at > ? ORDER BY created_at, rowid`,
      tx.actor.handle,
      tx.now,
    );
    return {
      value: {
        sessions: rows.map((r) => ({
          id: r.id,
          label: r.label,
          created_at: Number(r.created_at),
          renewed_at: Number(r.renewed_at),
          expires_at: Number(r.expires_at),
          current: r.id === tx.ctx.webSession,
        })),
      },
      audit: { targetType: "user", targetId: tx.actor.handle },
    };
  },
};

/** `bbs_web_session_revoke`: one of the caller's sessions by id, or all of them. */
export const webSessionRevoke: ActionDef = {
  name: "web_session_revoke",
  kind: "change",
  run(tx, input) {
    requirePerson(tx, "revoke web sessions", ["cli"]);
    const p = asParams(input);
    const id = optString(p, "id", 64);
    const all = optBool(p, "all") ?? false;
    if ((id === undefined) === !all) throw new BbsError("bad_request", "give either id or all");
    const revoked = (
      id !== undefined
        ? tx.sql.all<{ id: string }>(
            "DELETE FROM web_sessions WHERE handle = ? AND id = ? RETURNING id",
            tx.actor.handle,
            id,
          )
        : tx.sql.all<{ id: string }>("DELETE FROM web_sessions WHERE handle = ? RETURNING id", tx.actor.handle)
    ).map((r) => r.id);
    if (id !== undefined && revoked.length === 0) throw new BbsError("not_found", "no such web session");
    return {
      value: { revoked },
      audit: { targetType: "user", targetId: tx.actor.handle, detail: { revoked } },
    };
  },
};

/** `bbs_web_sign_out`: the calling web session ends. The Worker clears the cookie. */
export const webSignOut: ActionDef = {
  name: "web_sign_out",
  kind: "change",
  passive: true,
  run(tx) {
    requirePerson(tx, "sign out", ["web"]);
    const id = tx.ctx.webSession;
    if (id === undefined) throw denied("this call is not from a web session");
    const rows = tx.sql.all<{ id: string }>(
      "DELETE FROM web_sessions WHERE id = ? AND handle = ? RETURNING id",
      id,
      tx.actor.handle,
    );
    if (rows.length === 0) throw new BbsError("not_found", "no such web session");
    return { value: { signed_out: true }, audit: { targetType: "web_session", targetId: id } };
  },
};

/**
 * The prune timer: delete expired pairings, sessions, passkey challenges and approval requests (they are already
 * refused when used; this only frees the rows), then run again after
 * `webPruneIntervalMs` while any row is left. With none left it stays off
 * until the next pairing or session arms it.
 */
export const webPrune: ActionDef = {
  name: "web_prune",
  kind: "change",
  run(tx) {
    tx.sql.exec("DELETE FROM timers WHERE kind = 'web_prune'");
    const pairings = tx.sql.all<{ id: number }>("DELETE FROM web_pairings WHERE expires_at <= ? RETURNING id", tx.now).length;
    const sessions = tx.sql.all<{ id: string }>("DELETE FROM web_sessions WHERE expires_at <= ? RETURNING id", tx.now).length;
    const challenges = tx.sql.all<{ hash: string }>("DELETE FROM passkey_challenges WHERE expires_at <= ? RETURNING hash", tx.now).length;
    const approvals = tx.sql.all<{ id: string }>("DELETE FROM approvals WHERE expires_at <= ? RETURNING id", tx.now).length;
    const left = tx.sql.one<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM web_pairings) + (SELECT COUNT(*) FROM web_sessions)
              + (SELECT COUNT(*) FROM passkey_challenges) + (SELECT COUNT(*) FROM approvals) AS n`,
    );
    const rearm = Number(left?.n ?? 0) > 0;
    if (rearm) armPrune(tx);
    return {
      // `approvals` is named only when some were deleted, so a board without approval keeps its old row shape.
      value: { pairings, sessions, challenges, ...(approvals > 0 ? { approvals } : {}), rearmed: rearm },
      audit: { targetType: "timer", detail: { pairings, sessions, challenges, ...(approvals > 0 ? { approvals } : {}), rearmed: rearm } },
    };
  },
};
