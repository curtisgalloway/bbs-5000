// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkeys as approvers (issue #54, design §12 "Approving with a passkey").
 *
 * An agent with a shell on the person's machine can use the saved human CLI
 * credential, and the board cannot tell it from the person. So, on a board
 * deployed with approval required, three human-only actions do not run until a
 * passkey signs their exact scope: approving a web pairing code, approving a
 * connector, and removing a passkey that can approve. The passkey lives on a
 * device the agent cannot operate.
 *
 * Flow. A gated action validates its inputs as it always did, then, instead of
 * changing anything, `requestApproval` stores an approval request and answers
 * `{ status: "approval_required", approval, match_code, expires_at }`. The
 * browser (`/approve#<approval>`, or the pairing page itself) asks for the
 * challenge (`approvalStartOptions`, a read), the person's authenticator signs
 * it, and the finish (`checkApproval`, the one `await`, reads only; then the
 * synchronous write in `approval-finish.ts`) spends the request and runs the
 * action's change in one transaction.
 *
 * What is signed. The scope is a small JSON object the board builds and stores,
 * never the client: `{ action, handle, ...target }`, in a fixed key order. The
 * WebAuthn challenge is SHA-256(scope || "\n" || nonce), recomputed from the
 * stored row, so nothing the client sends decides what was approved, and an
 * assertion made for one request cannot finish another. The nonce is stored in
 * clear: it is not a secret (the security is the signature), and the challenge
 * has to be issued again after a page reload.
 *
 * Who may approve: a passkey of the same active human with user verification
 * whose backup-eligible flag is 0 (device-bound), or any of the person's
 * passkeys when the deploy-time `allowSynced` stopgap is on. When approval is
 * required and the person has none, a gated action is refused; it never falls
 * back to running unapproved.
 */

import type { Sql } from "../sql.ts";
import { asParams, reqString } from "../params.ts";
import type { Sha256 } from "../audit.ts";
import { denied, type ActionDef, type ActionOutcome, type ApprovalSettings, type BoardConfig, type Tx } from "../types.ts";
import { base64url } from "./common.ts";
import {
  assertionSignatureHolds,
  bytesField,
  objectField,
  parseAuthData,
  parseClientData,
  PasskeyError,
  type PasskeyAlg,
  type PasskeyPublicKey,
} from "./passkey-verify.ts";
import { armPrune, randomCode, requirePerson } from "./web-common.ts";

/** The actions an approval can gate. */
export type GatedAction = "web_pairing_approve" | "oauth_decide" | "passkey_remove";

/** Length of the match code shown beside a request and on the approving page. */
export const MATCH_CODE_LENGTH = 6;
/** Longest secret approval id the board reads. */
const MAX_SECRET_LENGTH = 128;

export const NO_APPROVER =
  "this board requires a passkey's approval for this, and you have no passkey that can approve. " +
  "Either register a device-bound passkey in the web view while approval is off, " +
  "or redeploy the board without --require-approval.";

/**
 * The one rule for who may approve, as a SQL condition on a `passkeys` row
 * (one `?`: the allow-synced setting as 0 or 1). A passkey registered while the
 * board required approval is barred for good, in every mode: a software
 * authenticator could claim to be device-bound, so only a key registered while
 * approval was off is trusted. Otherwise it must be device-bound (BE flag 0),
 * unless the synced stopgap is on. `mayApprove`, `approverPasskeys` and the
 * finish write all use this, so they cannot drift.
 */
export const APPROVER_CONDITION = "approver_barred = 0 AND (backup_eligible = 0 OR ? = 1)";

/** The same rule on a row already read (`mayApprove` mirrors `APPROVER_CONDITION`). */
export function mayApprove(
  p: { backup_eligible: number | boolean; approver_barred: number | boolean },
  settings: ApprovalSettings,
): boolean {
  return !p.approver_barred && (!p.backup_eligible || settings.allowSynced);
}

/** The person's passkeys that may approve, oldest first. */
export function approverPasskeys(
  sql: Sql,
  handle: string,
  settings: ApprovalSettings,
): { id: string; credential_id: string; transports: string | null }[] {
  return sql.all<{ id: string; credential_id: string; transports: string | null }>(
    `SELECT id, credential_id, transports FROM passkeys
     WHERE handle = ? AND (${APPROVER_CONDITION}) ORDER BY created_at, rowid`,
    handle,
    settings.allowSynced ? 1 : 0,
  );
}

/**
 * The WebAuthn challenge of an approval: SHA-256 of the stored scope text, a
 * newline and the stored nonce, as 32 bytes in base64url. Computed from the
 * row every time; the client's copy is only compared against it.
 */
export function approvalChallenge(sha256: Sha256, scope: string, nonce: string): string {
  const hex = sha256(`${scope}\n${nonce}`);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return base64url(bytes);
}

/**
 * The secret approval id a pairing's browser may open its approval with:
 * derived from the poll secret it already holds, so the browser can get it
 * again after a reload. The board stores only SHA-256 of it, written when the
 * pairing starts (`web_pairings.approval_hash`), so nothing stored lets a
 * database reader derive it: that takes the poll secret, of which only a hash
 * is kept. A different input from the poll secret itself, so the two secrets
 * are never the same value in two roles.
 */
export function pollApprovalId(sha256: Sha256, pollSecret: string): string {
  return sha256(`approval-poll\n${pollSecret}`);
}

export interface ApprovalRow {
  id: string;
  handle: string;
  action: GatedAction;
  ref: string;
  scope: string;
  nonce: string;
  match_code: string;
  state: "pending" | "approved" | "expired";
  requested_via: string;
  pairing: number | null;
  created_at: number;
  expires_at: number;
}

const APPROVAL_COLUMNS =
  "a.id, a.handle, a.action, a.ref, a.scope, a.nonce, a.match_code, a.state, a.requested_via, a.pairing, a.created_at, a.expires_at";

/**
 * The approval a secret id opens: the one whose stored hash it matches, or, for
 * a pairing, the one the pairing's poll-derived id matches (`pollApprovalId`).
 */
export function findApproval(sql: Sql, sha256: Sha256, secret: string): ApprovalRow | undefined {
  if (secret === "" || secret.length > MAX_SECRET_LENGTH) return undefined;
  const hash = sha256(secret);
  const row = sql.one<ApprovalRow>(
    `SELECT ${APPROVAL_COLUMNS} FROM approvals a
     WHERE a.id_hash = ?
        OR (a.pairing IS NOT NULL
            AND EXISTS (SELECT 1 FROM web_pairings w WHERE w.id = a.pairing AND w.approval_hash = ?))
     ORDER BY a.created_at DESC, a.rowid DESC LIMIT 1`,
    hash,
    hash,
  );
  return row ? { ...row, created_at: Number(row.created_at), expires_at: Number(row.expires_at) } : undefined;
}

/** A request is open while it is pending and unexpired. */
export function isOpen(row: ApprovalRow, now: number): boolean {
  return row.state === "pending" && row.expires_at > now;
}

export interface ApprovalSpec {
  action: GatedAction;
  /** What the action acts on: a pairing's row id, a request's id hash, a passkey's id. */
  ref: string;
  /** `{ action, handle, ...target }`, built by the action with its keys in a fixed order. */
  scope: Record<string, unknown>;
  /** The pairing's row id, for a pairing approval, so the browser's poll can find the request. */
  pairing?: number;
  /** The request cannot outlive what it approves. */
  notAfter?: number;
}

/**
 * Make the approval request for a gated action, instead of running it, and
 * answer `approval_required`. Refused when the person has no passkey that can
 * approve (the board fails closed). A new request for the same action and
 * target replaces that person's older pending one; the per-person cap is a
 * condition of the INSERT, judged by the rows it changes. The audit row is
 * `approval_request`, with the request's public id, the gated action and the
 * scope; never the secret id, the nonce or the challenge.
 */
export function requestApproval(tx: Tx, spec: ApprovalSpec): ActionOutcome {
  if (approverPasskeys(tx.sql, tx.actor.handle, tx.approval).length === 0) throw denied(NO_APPROVER);
  const secret = base64url(tx.randomBytes(32));
  const nonce = base64url(tx.randomBytes(32));
  const id = `ap_${base64url(tx.randomBytes(9))}`;
  const matchCode = randomCode(tx.randomBytes, MATCH_CODE_LENGTH);
  const expiresAt = Math.min(tx.now + tx.config.approvalTtlMs, spec.notAfter ?? Number.MAX_SAFE_INTEGER);
  const target = `${spec.action}:${spec.ref}`;
  // A repeat of the same request replaces the older one, so re-running a command never piles up.
  tx.sql.exec("DELETE FROM approvals WHERE handle = ? AND target = ? AND state = 'pending'", tx.actor.handle, target);
  const inserted = tx.sql.all<{ id: string }>(
    `INSERT INTO approvals
       (id, id_hash, handle, action, ref, target, scope, nonce, match_code, requested_via, pairing, created_at, expires_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM approvals WHERE handle = ? AND state = 'pending' AND expires_at > ?) < ?
     RETURNING id`,
    id,
    tx.sha256(secret),
    tx.actor.handle,
    spec.action,
    spec.ref,
    target,
    JSON.stringify(spec.scope),
    nonce,
    matchCode,
    tx.ctx.via,
    spec.pairing ?? null,
    tx.now,
    expiresAt,
    tx.actor.handle,
    tx.now,
    tx.config.approvalsMaxPending,
  );
  if (inserted.length === 0) {
    throw denied("too many approval requests are waiting; finish or let one expire first", "rate_limited");
  }
  armPrune(tx);
  return {
    // `approval` is the secret id for the person's own screen only, never in the audit row.
    value: { status: "approval_required", approval: secret, match_code: matchCode, expires_at: expiresAt },
    audit: { targetType: "approval", targetId: id, detail: { action: spec.action, scope: spec.scope, expires_at: expiresAt } },
    auditAction: "approval_request",
  };
}

/**
 * `bbs_approval_status`: whether the caller's approval request is pending,
 * approved or expired, from the secret id it was given. Never the result of
 * the approved action (the CLI polls this; only the browser that signed gets
 * the result). A person, from the CLI or the web view; never on `/mcp`.
 */
export const approvalStatus: ActionDef = {
  name: "approval_status",
  kind: "read",
  run(tx, input) {
    requirePerson(tx, "check an approval", ["cli", "web"]);
    const secret = reqString(asParams(input), "approval", MAX_SECRET_LENGTH);
    const row = findApproval(tx.sql, tx.sha256, secret);
    if (!row || row.handle !== tx.actor.handle) throw denied("no such approval request (unknown, replaced or already removed)", "not_found");
    const status = row.state === "pending" && row.expires_at <= tx.now ? "expired" : row.state;
    return {
      value: { status, action: row.action, match_code: row.match_code, expires_at: row.expires_at },
      audit: { targetType: "approval", targetId: row.id },
    };
  },
};

// ---------------------------------------------------------------------------
// The browser's two calls (no credential: the approval id and the passkey are the proof).

/** What the read-only checks need from the board. */
export interface ApprovalEnv {
  sql: Sql;
  sha256: Sha256;
  now: number;
  config: BoardConfig;
  approval: ApprovalSettings;
}

export type ApprovalStart =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * `POST /api/web/approval/start`: the request's scope and the WebAuthn request
 * options for the person's approving passkeys. A read, not audited unless
 * refused (then through the failed sign-in guards, by the caller).
 */
export function approvalStartOptions(env: ApprovalEnv, secret: string, rpId: string): ApprovalStart {
  const row = findApproval(env.sql, env.sha256, secret);
  if (!row || !isOpen(row, env.now)) return { ok: false, reason: "not_pending" };
  const keys = approverPasskeys(env.sql, row.handle, env.approval);
  if (keys.length === 0) return { ok: false, reason: "no_approver" };
  return {
    ok: true,
    value: {
      action: row.action,
      scope: JSON.parse(row.scope) as unknown,
      match_code: row.match_code,
      expires_at: row.expires_at,
      publicKey: {
        challenge: approvalChallenge(env.sha256, row.scope, row.nonce),
        rpId,
        allowCredentials: keys.map((k) => ({
          type: "public-key",
          id: k.credential_id,
          ...(k.transports !== null ? { transports: JSON.parse(k.transports) as string[] } : {}),
        })),
        userVerification: "required",
        timeout: row.expires_at - env.now,
      },
    },
  };
}

export type ApprovalChecked =
  | { ok: true; handle: string; action: GatedAction; write: Record<string, unknown> }
  | { ok: false; reason: string; extra?: Record<string, unknown> };

/**
 * The checks of an approval's finish that need Web Crypto, all reads (the one
 * `await`, like `checkSignin`): the request open; `clientDataJSON` of type
 * `webauthn.get` carrying the challenge recomputed from the stored scope and
 * nonce, and the exact origin; the credential known and belonging to the
 * request's person, an active human; the passkey allowed to approve (device
 * bound unless `allowSynced`, by the stored flag and by the flag this
 * assertion carries); `rpIdHash`; user present and verified; and the signature
 * over `authenticatorData || SHA-256(clientDataJSON)` for the stored key. The
 * sign count and everything else that must hold at the moment of writing is
 * judged in the write.
 */
export async function checkApproval(
  env: ApprovalEnv,
  info: { approval: string; rpId: string; origin: string; credential: unknown },
): Promise<ApprovalChecked> {
  let passkeyId: string | undefined;
  try {
    const max = env.config.passkeyMaxFieldBytes;
    const cred = objectField(info.credential);
    const response = objectField(cred.response);
    const credentialId = bytesField(cred.id, 1_023);
    const clientData = bytesField(response.clientDataJSON, max);
    const authenticatorData = bytesField(response.authenticatorData, max);
    const signature = bytesField(response.signature, max);
    const row = findApproval(env.sql, env.sha256, info.approval);
    if (!row || !isOpen(row, env.now)) throw new PasskeyError("not_pending");
    const { challenge } = parseClientData(clientData, { type: "webauthn.get", origin: info.origin });
    if (challenge !== approvalChallenge(env.sha256, row.scope, row.nonce)) throw new PasskeyError("wrong_challenge");
    const stored = env.sql.one<{
      id: string;
      handle: string;
      public_key: string;
      alg: PasskeyAlg;
      backup_eligible: number;
      approver_barred: number;
      kind: string;
      status: string;
    }>(
      `SELECT p.id, p.handle, p.public_key, p.alg, p.backup_eligible, p.approver_barred, u.kind, u.status FROM passkeys p
       JOIN users u ON u.handle = p.handle WHERE p.credential_id = ?`,
      base64url(credentialId),
    );
    if (!stored) throw new PasskeyError("unknown_credential");
    passkeyId = stored.id;
    if (stored.handle !== row.handle) throw new PasskeyError("wrong_person");
    if (stored.kind !== "human" || stored.status !== "active") throw new PasskeyError("account_not_active");
    if (stored.approver_barred) throw new PasskeyError("passkey_barred");
    if (!mayApprove(stored, env.approval)) throw new PasskeyError("passkey_synced");
    const auth = parseAuthData(authenticatorData, false);
    if (auth.rpIdHashHex !== env.sha256(info.rpId)) throw new PasskeyError("wrong_rp_id");
    if (!auth.userPresent) throw new PasskeyError("user_not_present");
    if (!auth.userVerified) throw new PasskeyError("user_not_verified");
    // A credential stored as device-bound that now says it may sync is not trusted to approve.
    if (auth.backupEligible && !env.approval.allowSynced) throw new PasskeyError("passkey_synced");
    const key: PasskeyPublicKey = { alg: stored.alg, jwk: JSON.parse(stored.public_key) as PasskeyPublicKey["jwk"] };
    if (!(await assertionSignatureHolds(key, authenticatorData, clientData, signature))) throw new PasskeyError("bad_signature");
    return {
      ok: true,
      handle: row.handle,
      action: row.action,
      write: { approval: row.id, passkey: stored.id, sign_count: auth.signCount, backup_state: auth.backupState },
    };
  } catch (err) {
    if (err instanceof PasskeyError) {
      return { ok: false, reason: err.reason, ...(passkeyId !== undefined ? { extra: { passkey: passkeyId } } : {}) };
    }
    throw err;
  }
}
