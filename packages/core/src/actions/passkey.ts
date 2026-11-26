// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Passkey sign-in for the web view (issue #54, design §12).
 *
 * A person who signed in to the web view by a pairing code can register a
 * passkey (a WebAuthn credential, kept by the device or a password manager);
 * later a new browser signs in with it, with no CLI nearby. The Worker derives
 * the relying party id (the web view's exact hostname) and the expected origin
 * from the request and passes them in; they are never taken from the page.
 *
 * The flow is two calls each way. A start makes a challenge (32 random bytes,
 * single use, five minutes, only its SHA-256 stored) and returns the options
 * for the browser. A finish carries the browser's answer: the checks that need
 * Web Crypto run first (`checkRegistration`, `checkSignin`, the one `await`,
 * reads only), then one synchronous write does everything that must hold at the
 * moment of writing, each as a condition of its statement judged by rows
 * changed: the challenge is spent by an UPDATE, a registration's per-person cap
 * and the credential's uniqueness are conditions of its INSERT, and the sign
 * count's rule is a condition of the UPDATE that moves it.
 *
 * Who may do what:
 * - register start and finish: a person in a web session made by a pairing
 *   code. A session made by a passkey is refused, so a stolen passkey session
 *   cannot add another passkey.
 * - sign-in start and finish: anyone, with no credential (the Worker calls the
 *   `Board` methods; they are not tools). Their refusals go through the failed
 *   sign-in guards, never a row per refused request.
 * - list: a person, from the CLI or the web view. Remove: the same, except that
 *   the last passkey is removed only from the CLI.
 */

import type { Sql } from "../sql.ts";
import { asParams, reqString, UNSAFE_LABEL_RE } from "../params.ts";
import type { Sha256 } from "../audit.ts";
import { BbsError, denied, type ActionDef, type ActionOutcome, type ApprovalSettings, type BoardConfig, type CallContext, type Tx, type Via } from "../types.ts";
import { b64uDecode } from "./client-auth.ts";
import { base64url } from "./common.ts";
import { APPROVER_CONDITION, mayApprove, requestApproval } from "./approval.ts";
import {
  assertionSignatureHolds,
  attestationAuthData,
  bytesField,
  coseToPublicKey,
  importPasskeyKey,
  objectField,
  parseAuthData,
  parseClientData,
  PasskeyError,
  type PasskeyAlg,
  type PasskeyPublicKey,
} from "./passkey-verify.ts";
import { armPrune, createWebSession, requirePerson, revokePasskeySessions } from "./web-session.ts";

/** Longest passkey label kept. */
export const MAX_PASSKEY_LABEL = 80;
const UNSAFE_LABEL_CHARS = new RegExp(UNSAFE_LABEL_RE.source, "g");
const KNOWN_TRANSPORT = /^[a-z][a-z-]{0,15}$/;
const MAX_TRANSPORTS = 8;

const NEEDS_PAIRING =
  "this browser signed in with a passkey; to add a passkey, sign in with a pairing code (bbs web-login) first";
const LAST_PASSKEY_CLI_ONLY = "removing your last passkey is only available from the bbs CLI";

/** A passkey label: control, line-separator and bidirectional characters removed, cut short; empty becomes "passkey". */
export function passkeyLabel(raw: unknown): string {
  const text = typeof raw === "string" ? raw.replace(UNSAFE_LABEL_CHARS, "").trim().slice(0, MAX_PASSKEY_LABEL) : "";
  return text === "" ? "passkey" : text;
}

/** What the read-only checks need from the board. */
export interface CheckEnv {
  sql: Sql;
  sha256: Sha256;
  now: number;
  config: BoardConfig;
}

// ---------------------------------------------------------------------------
// Challenges.

/**
 * Whether a new sign-in challenge from `source` fits the limits: `busy` when
 * the board already holds `passkeySigninMaxPending` live ones, `source` when
 * this source holds `passkeySigninMaxPerSource`. The start action enforces the
 * same limits inside its INSERT; this read lets the Board refuse a flood
 * without writing a row per refused request.
 */
export function signinRoom(sql: Sql, config: BoardConfig, now: number, source: string): "ok" | "busy" | "source" {
  const row = sql.one<{ n: number; s: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(source = ?), 0) AS s FROM passkey_challenges
     WHERE purpose = 'signin' AND consumed_at IS NULL AND expires_at > ?`,
    source,
    now,
  );
  if (Number(row?.n ?? 0) >= config.passkeySigninMaxPending) return "busy";
  if (Number(row?.s ?? 0) >= config.passkeySigninMaxPerSource) return "source";
  return "ok";
}

interface ChallengeRow {
  purpose: string;
  handle: string | null;
  web_session: string | null;
  rp_id: string;
  origin: string;
}

/** The live (unspent, unexpired) challenge with this hash, if any. */
function liveChallenge(env: CheckEnv, hash: string): ChallengeRow | undefined {
  return env.sql.one<ChallengeRow>(
    `SELECT purpose, handle, web_session, rp_id, origin FROM passkey_challenges
     WHERE hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    hash,
    env.now,
  );
}

/** Spend a challenge: one UPDATE judged by the rows it changes. False when it was not live, or not this one's to spend. */
function spendChallenge(
  tx: Tx,
  hash: string,
  purpose: "register" | "signin",
  rpId: string,
  origin: string,
  binding: { handle: string; webSession: string } | undefined,
): boolean {
  const rows = tx.sql.all<{ hash: string }>(
    `UPDATE passkey_challenges SET consumed_at = ?
     WHERE hash = ? AND purpose = ? AND rp_id = ? AND origin = ?
       AND consumed_at IS NULL AND expires_at > ?
       AND (? = 0 OR (handle = ? AND web_session = ?))
     RETURNING hash`,
    tx.now,
    hash,
    purpose,
    rpId,
    origin,
    tx.now,
    binding === undefined ? 0 : 1,
    binding?.handle ?? "",
    binding?.webSession ?? "",
  );
  return rows.length === 1;
}

const CHALLENGE_NOT_PENDING = "that challenge is not pending (unknown, expired or already used)";

// ---------------------------------------------------------------------------
// Registration.

/** The session row of a person's web session, if it is live. */
function sessionMethod(tx: Tx): "pairing" | "passkey" | undefined {
  const id = tx.ctx.webSession;
  if (id === undefined) return undefined;
  const row = tx.sql.one<{ method: "pairing" | "passkey" }>(
    "SELECT method FROM web_sessions WHERE id = ? AND handle = ? AND expires_at > ?",
    id,
    tx.actor.handle,
    tx.now,
  );
  return row?.method;
}

/** Refuse unless the calling web session was made by a pairing code; returns its id. */
function requirePairingSession(tx: Tx): string {
  const method = sessionMethod(tx);
  if (method === undefined) throw denied("this call is not from a live web session");
  if (method !== "pairing") throw denied(NEEDS_PAIRING);
  return tx.ctx.webSession as string;
}

function passkeyCount(tx: Tx): number {
  return Number(tx.sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM passkeys WHERE handle = ?", tx.actor.handle)?.n ?? 0);
}

/**
 * Internal: a person in a web session asks to register a passkey. Makes the
 * challenge, bound to the person and the session, and returns the browser's
 * creation options. Called by `Board.passkeyRegisterStart`.
 */
export const passkeyRegisterStart: ActionDef = {
  name: "passkey_register_start",
  kind: "change",
  passive: true,
  run(tx, input) {
    requirePerson(tx, "add a passkey", ["web"]);
    const p = asParams(input);
    const rpId = reqString(p, "rp_id", 253);
    const origin = reqString(p, "origin", 300);
    const source = reqString(p, "source", 64);
    const session = requirePairingSession(tx);
    if (passkeyCount(tx) >= tx.config.passkeysPerUser) {
      throw denied(`you already have ${tx.config.passkeysPerUser} passkeys; remove one first`);
    }
    // The random id the authenticator keeps for this person, never the handle; made once.
    tx.sql.exec(
      "INSERT INTO passkey_users (handle, user_id) VALUES (?, ?) ON CONFLICT (handle) DO NOTHING",
      tx.actor.handle,
      base64url(tx.randomBytes(32)),
    );
    const userId = tx.sql.one<{ user_id: string }>("SELECT user_id FROM passkey_users WHERE handle = ?", tx.actor.handle)?.user_id;
    if (userId === undefined) throw new BbsError("internal", "could not make a passkey user id");
    // A new start replaces the person's older pending ones, so abandoned tries never crowd the cap.
    tx.sql.exec("DELETE FROM passkey_challenges WHERE purpose = 'register' AND handle = ? AND consumed_at IS NULL", tx.actor.handle);
    const challenge = base64url(tx.randomBytes(32));
    const inserted = tx.sql.all<{ hash: string }>(
      `INSERT INTO passkey_challenges (hash, purpose, handle, web_session, rp_id, origin, source, created_at, expires_at)
       SELECT ?, 'register', ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM passkey_challenges
              WHERE purpose = 'register' AND handle = ? AND consumed_at IS NULL AND expires_at > ?) < ?
       RETURNING hash`,
      tx.sha256(challenge),
      tx.actor.handle,
      session,
      rpId,
      origin,
      source,
      tx.now,
      tx.now + tx.config.passkeyChallengeTtlMs,
      tx.actor.handle,
      tx.now,
      tx.config.passkeyRegisterMaxPending,
    );
    if (inserted.length === 0) throw denied("too many passkey registrations pending; try again in a few minutes", "rate_limited");
    armPrune(tx);
    const existing = tx.sql.all<{ credential_id: string; transports: string | null }>(
      "SELECT credential_id, transports FROM passkeys WHERE handle = ? ORDER BY created_at, rowid",
      tx.actor.handle,
    );
    return {
      value: {
        challenge,
        rp: { id: rpId, name: "BBS-5000" },
        user: { id: userId, name: tx.actor.handle, displayName: tx.actor.handle },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        timeout: tx.config.passkeyChallengeTtlMs,
        excludeCredentials: existing.map((c) => ({
          type: "public-key",
          id: c.credential_id,
          ...(c.transports !== null ? { transports: JSON.parse(c.transports) as string[] } : {}),
        })),
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        attestation: "none",
      },
      // Never the challenge.
      audit: { targetType: "user", targetId: tx.actor.handle, detail: { rp_id: rpId, expires_at: tx.now + tx.config.passkeyChallengeTtlMs } },
    };
  },
};

/** What `checkRegistration` found, for the write: the browser's answer reduced to checked facts. */
type Checked<W> = { ok: true; write: W } | { ok: false; reason: string };

function transportsOf(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const kept = v.filter((t): t is string => typeof t === "string" && KNOWN_TRANSPORT.test(t)).slice(0, MAX_TRANSPORTS);
  return kept.length === 0 ? null : JSON.stringify(kept);
}

/**
 * The checks of a registration that need Web Crypto, all reads: the answer's
 * shape, `clientDataJSON` (type `webauthn.create`, the challenge pending and
 * bound to this person and session, the exact origin), the authenticator data
 * (`rpIdHash`, user present and verified, an attested credential whose id is
 * the one named), the public key (parses, allowed algorithm, imports), and the
 * credential id not yet registered. The attestation statement is ignored.
 */
export async function checkRegistration(
  env: CheckEnv,
  ctx: CallContext,
  info: { rpId: string; origin: string; credential: unknown; label?: unknown },
): Promise<Checked<Record<string, unknown>>> {
  try {
    const max = env.config.passkeyMaxFieldBytes;
    const cred = objectField(info.credential);
    const response = objectField(cred.response);
    const credentialId = bytesField(cred.id, 1_023);
    const clientData = bytesField(response.clientDataJSON, max);
    const attestation = bytesField(response.attestationObject, max);
    const { challenge } = parseClientData(clientData, { type: "webauthn.create", origin: info.origin });
    const hash = env.sha256(challenge);
    const row = liveChallenge(env, hash);
    if (
      !row ||
      row.purpose !== "register" ||
      row.handle !== ctx.handle ||
      row.web_session !== (ctx.webSession ?? null) ||
      row.rp_id !== info.rpId ||
      row.origin !== info.origin
    ) {
      throw new PasskeyError("challenge_not_pending");
    }
    const auth = parseAuthData(attestationAuthData(attestation), true);
    if (auth.rpIdHashHex !== env.sha256(info.rpId)) throw new PasskeyError("wrong_rp_id");
    if (!auth.userPresent) throw new PasskeyError("user_not_present");
    if (!auth.userVerified) throw new PasskeyError("user_not_verified");
    const authId = auth.credentialId as Uint8Array;
    if (authId.length !== credentialId.length || authId.some((b, i) => b !== credentialId[i])) {
      throw new PasskeyError("credential_id_mismatch");
    }
    const key = coseToPublicKey(auth.coseKey);
    await importPasskeyKey(key);
    const credentialText = base64url(credentialId);
    if (env.sql.one("SELECT 1 AS x FROM passkeys WHERE credential_id = ?", credentialText)) {
      throw new PasskeyError("credential_already_registered");
    }
    return {
      ok: true,
      write: {
        challenge_hash: hash,
        rp_id: info.rpId,
        origin: info.origin,
        credential_id: credentialText,
        public_key: JSON.stringify(key.jwk),
        alg: key.alg,
        sign_count: auth.signCount,
        backup_eligible: auth.backupEligible,
        backup_state: auth.backupState,
        transports: transportsOf(response.transports) ?? undefined,
        label: passkeyLabel(info.label),
      },
    };
  } catch (err) {
    if (err instanceof PasskeyError) return { ok: false, reason: err.reason };
    throw err;
  }
}

/**
 * Internal: register the passkey `checkRegistration` accepted. Spends the
 * challenge and inserts the credential, each judged by the rows it changes;
 * the per-person cap and the credential's uniqueness are conditions of the
 * INSERT. Called by `Board.passkeyRegisterFinish`.
 */
export const passkeyRegisterFinish: ActionDef = {
  name: "passkey_register",
  kind: "change",
  run(tx, input) {
    requirePerson(tx, "add a passkey", ["web"]);
    const p = asParams(input);
    const session = requirePairingSession(tx);
    const hash = reqString(p, "challenge_hash", 64);
    if (!spendChallenge(tx, hash, "register", reqString(p, "rp_id", 253), reqString(p, "origin", 300), { handle: tx.actor.handle, webSession: session })) {
      throw denied(CHALLENGE_NOT_PENDING, "bad_request");
    }
    const id = `pk_${base64url(tx.randomBytes(9))}`;
    const credentialId = reqString(p, "credential_id", 1_400);
    const alg = reqString(p, "alg", 8) as PasskeyAlg;
    const eligible = p.backup_eligible === true ? 1 : 0;
    const label = reqString(p, "label", MAX_PASSKEY_LABEL);
    const canApprove = mayApprove({ backup_eligible: eligible, approver_barred: tx.approval.required ? 1 : 0 }, tx.approval);
    const inserted = tx.sql.all<{ id: string }>(
      `INSERT INTO passkeys (id, handle, credential_id, public_key, alg, sign_count, backup_eligible, backup_state, transports, label, created_at, approver_barred)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM passkeys WHERE handle = ?) < ?
       ON CONFLICT (credential_id) DO NOTHING
       RETURNING id`,
      id,
      tx.actor.handle,
      credentialId,
      reqString(p, "public_key", 2_048),
      alg,
      Number(p.sign_count ?? 0),
      eligible,
      p.backup_state === true ? 1 : 0,
      typeof p.transports === "string" ? p.transports : null,
      label,
      tx.now,
      // Registered while approval is required: this key can never approve (see APPROVER_CONDITION).
      tx.approval.required ? 1 : 0,
      tx.actor.handle,
      tx.config.passkeysPerUser,
    );
    if (inserted.length === 0) {
      if (tx.sql.one("SELECT 1 AS x FROM passkeys WHERE credential_id = ?", credentialId)) {
        throw new BbsError("exists", "that credential is already registered", "denied");
      }
      throw denied(`you already have ${tx.config.passkeysPerUser} passkeys; remove one first`);
    }
    return {
      value: { id, label, synced: eligible === 1, can_approve: canApprove },
      audit: { targetType: "passkey", targetId: id, detail: { label, alg, synced: eligible === 1, backed_up: p.backup_state === true, can_approve: canApprove } },
    };
  },
};

// ---------------------------------------------------------------------------
// Sign-in.

/**
 * Internal: a browser with no session asks to sign in with a passkey. Makes a
 * challenge and returns the request options with an empty `allowCredentials`
 * (the authenticator offers its own passkeys for this site). Both limits are
 * conditions of the INSERT. Called by `Board.passkeySigninStart`.
 */
export const passkeySigninStart: ActionDef = {
  name: "passkey_signin_start",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const rpId = reqString(p, "rp_id", 253);
    const origin = reqString(p, "origin", 300);
    const source = reqString(p, "source", 64);
    const challenge = base64url(tx.randomBytes(32));
    const inserted = tx.sql.all<{ hash: string }>(
      `INSERT INTO passkey_challenges (hash, purpose, handle, web_session, rp_id, origin, source, created_at, expires_at)
       SELECT ?, 'signin', NULL, NULL, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM passkey_challenges
              WHERE purpose = 'signin' AND consumed_at IS NULL AND expires_at > ?) < ?
         AND (SELECT COUNT(*) FROM passkey_challenges
              WHERE purpose = 'signin' AND source = ? AND consumed_at IS NULL AND expires_at > ?) < ?
       RETURNING hash`,
      tx.sha256(challenge),
      rpId,
      origin,
      source,
      tx.now,
      tx.now + tx.config.passkeyChallengeTtlMs,
      tx.now,
      tx.config.passkeySigninMaxPending,
      source,
      tx.now,
      tx.config.passkeySigninMaxPerSource,
    );
    if (inserted.length === 0) {
      throw denied("too many sign-in requests right now; try again in a few minutes", "rate_limited");
    }
    armPrune(tx);
    return {
      value: {
        challenge,
        rpId,
        allowCredentials: [],
        userVerification: "required",
        timeout: tx.config.passkeyChallengeTtlMs,
      },
      // Never the challenge.
      audit: { targetType: "passkey_challenge", detail: { rp_id: rpId, source, expires_at: tx.now + tx.config.passkeyChallengeTtlMs } },
    };
  },
};

/**
 * The checks of a sign-in that need Web Crypto, all reads (see
 * `checkRegistration`): `clientDataJSON` (type `webauthn.get`, challenge
 * pending, exact origin), the credential known and its person an active human,
 * the authenticator data (`rpIdHash`, user present and verified), the user
 * handle when the authenticator sent one, and the signature over
 * `authenticatorData || SHA-256(clientDataJSON)` for the stored key. The
 * sign count is judged in the write.
 */
export async function checkSignin(
  env: CheckEnv,
  info: { rpId: string; origin: string; credential: unknown },
): Promise<Checked<Record<string, unknown>> & { handle?: string; extra?: Record<string, unknown> }> {
  let passkeyId: string | undefined;
  try {
    const max = env.config.passkeyMaxFieldBytes;
    const cred = objectField(info.credential);
    const response = objectField(cred.response);
    const credentialId = bytesField(cred.id, 1_023);
    const clientData = bytesField(response.clientDataJSON, max);
    const authenticatorData = bytesField(response.authenticatorData, max);
    const signature = bytesField(response.signature, max);
    const { challenge } = parseClientData(clientData, { type: "webauthn.get", origin: info.origin });
    const hash = env.sha256(challenge);
    const row = liveChallenge(env, hash);
    if (!row || row.purpose !== "signin" || row.rp_id !== info.rpId || row.origin !== info.origin) {
      throw new PasskeyError("challenge_not_pending");
    }
    const stored = env.sql.one<{
      id: string;
      handle: string;
      public_key: string;
      alg: PasskeyAlg;
      kind: string;
      status: string;
    }>(
      `SELECT p.id, p.handle, p.public_key, p.alg, u.kind, u.status FROM passkeys p
       JOIN users u ON u.handle = p.handle WHERE p.credential_id = ?`,
      base64url(credentialId),
    );
    if (!stored) throw new PasskeyError("unknown_credential");
    passkeyId = stored.id;
    if (stored.kind !== "human" || stored.status !== "active") throw new PasskeyError("account_not_active");
    const auth = parseAuthData(authenticatorData, false);
    if (auth.rpIdHashHex !== env.sha256(info.rpId)) throw new PasskeyError("wrong_rp_id");
    if (!auth.userPresent) throw new PasskeyError("user_not_present");
    if (!auth.userVerified) throw new PasskeyError("user_not_verified");
    if (typeof response.userHandle === "string" && response.userHandle !== "") {
      const owner = env.sql.one<{ user_id: string }>("SELECT user_id FROM passkey_users WHERE handle = ?", stored.handle);
      if (response.userHandle !== owner?.user_id) throw new PasskeyError("user_handle_mismatch");
    }
    const key: PasskeyPublicKey = { alg: stored.alg, jwk: JSON.parse(stored.public_key) as PasskeyPublicKey["jwk"] };
    if (!(await assertionSignatureHolds(key, authenticatorData, clientData, signature))) throw new PasskeyError("bad_signature");
    return {
      ok: true,
      handle: stored.handle,
      write: {
        challenge_hash: hash,
        rp_id: info.rpId,
        origin: info.origin,
        passkey: stored.id,
        sign_count: auth.signCount,
        backup_state: auth.backupState,
      },
    };
  } catch (err) {
    if (err instanceof PasskeyError) {
      return { ok: false, reason: err.reason, ...(passkeyId !== undefined ? { extra: { passkey: passkeyId } } : {}) };
    }
    throw err;
  }
}

/**
 * Move a passkey's sign count and backup state after an accepted assertion, as
 * the acting person's. The UPDATE's condition is the rule: when both the stored
 * and the presented count are nonzero, the presented one must be greater, so a
 * regression changes no row. The count kept is the larger of the two. With
 * `approver` settings, a passkey that may not approve under them is refused
 * too, so an approval re-checks the rule in the same statement. Returns the
 * row, or undefined when none changed.
 */
export function moveSignCount(
  tx: Tx,
  passkey: string,
  count: number,
  backupState: boolean,
  approver: ApprovalSettings | undefined,
): { id: string; label: string } | undefined {
  return tx.sql.all<{ id: string; label: string }>(
    `UPDATE passkeys SET sign_count = MAX(sign_count, ?), backup_state = ?, last_used_at = ?
     WHERE id = ? AND handle = ? AND (sign_count = 0 OR ? = 0 OR ? > sign_count)
       AND (? = 0 OR (${APPROVER_CONDITION}))
     RETURNING id, label`,
    count,
    backupState ? 1 : 0,
    tx.now,
    passkey,
    tx.actor.handle,
    count,
    count,
    approver ? 1 : 0,
    approver?.allowSynced ? 1 : 0,
  )[0];
}

/**
 * Internal: sign in with the passkey `checkSignin` accepted. The actor is the
 * passkey's person, `via = web`. Spends the challenge (an UPDATE judged by the
 * rows it changes, so two finishes of one challenge make exactly one session),
 * then moves the sign count: the UPDATE's condition is the rule (when both the
 * stored and the presented count are nonzero, the presented one must be
 * greater), so a regression changes no row and the sign-in is refused. Then
 * the session, through the code a pairing claim uses. Refusals carry their
 * reason as the message, for the sign-in guards' audit row. Called by
 * `Board.passkeySigninFinish`.
 */
export const passkeySignin: ActionDef = {
  name: "passkey_signin",
  kind: "change",
  // Signing in is not the person's activity (no last_seen, no lease renewal).
  passive: true,
  run(tx, input) {
    const p = asParams(input);
    if (tx.actor.kind !== "human" || tx.actor.status !== "active") throw denied("account_not_active", "unauthorized");
    if (!spendChallenge(tx, reqString(p, "challenge_hash", 64), "signin", reqString(p, "rp_id", 253), reqString(p, "origin", 300), undefined)) {
      throw denied("challenge_not_pending", "unauthorized");
    }
    const passkey = reqString(p, "passkey", 64);
    const count = Number(p.sign_count ?? 0);
    const row = moveSignCount(tx, passkey, count, p.backup_state === true, undefined);
    if (!row) {
      const there = tx.sql.one("SELECT 1 AS x FROM passkeys WHERE id = ? AND handle = ?", passkey, tx.actor.handle);
      throw denied(there ? "sign_count_not_increasing" : "unknown_credential", "unauthorized");
    }
    const label = typeof p.label === "string" ? p.label : "unknown browser";
    const { cookie, id, expiresAt, dropped } = createWebSession(tx, label, "passkey", passkey);
    return {
      // `session` is the cookie value: for the Worker's Set-Cookie only, never in the audit row.
      value: { session: cookie, id, handle: tx.actor.handle, expires_at: expiresAt, max_age_ms: tx.config.webSessionTtlMs },
      audit: {
        targetType: "web_session",
        targetId: id,
        detail: { passkey: row.id, label, expires_at: expiresAt, revoked_for_cap: dropped, sign_count: count },
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Tools.

/** `bbs_passkeys`: the caller's passkeys, and whether this session may add one (a read). */
export const passkeys: ActionDef = {
  name: "passkeys",
  kind: "read",
  run(tx) {
    requirePerson(tx, "list passkeys", ["cli", "web"]);
    const rows = tx.sql.all<{
      id: string;
      label: string;
      alg: string;
      backup_eligible: number;
      approver_barred: number;
      backup_state: number;
      transports: string | null;
      created_at: number;
      last_used_at: number | null;
    }>(
      `SELECT id, label, alg, backup_eligible, approver_barred, backup_state, transports, created_at, last_used_at FROM passkeys
       WHERE handle = ? ORDER BY created_at, rowid`,
      tx.actor.handle,
    );
    let canRegister = false;
    let note = "Passkeys are added from the web view.";
    if (tx.ctx.via === "web") {
      const method = sessionMethod(tx);
      if (method === "pairing") {
        canRegister = rows.length < tx.config.passkeysPerUser;
        note = canRegister ? "" : `You already have ${tx.config.passkeysPerUser} passkeys; remove one to add another.`;
      } else {
        note = "To add a passkey, sign in with a pairing code (bbs web-login) first.";
      }
    }
    return {
      value: {
        passkeys: rows.map((r) => ({
          id: r.id,
          label: r.label,
          algorithm: r.alg,
          synced: Number(r.backup_eligible) === 1,
          can_approve: mayApprove(r, tx.approval),
          backed_up: Number(r.backup_state) === 1,
          transports: r.transports === null ? [] : (JSON.parse(r.transports) as string[]),
          created_at: Number(r.created_at),
          last_used_at: r.last_used_at === null ? null : Number(r.last_used_at),
        })),
        can_register: canRegister,
        note,
        // What the board's deploy-time settings say, and how many of these passkeys may approve under them.
        approval: {
          required: tx.approval.required,
          allow_synced: tx.approval.allowSynced,
          approvers: rows.filter((r) => mayApprove(r, tx.approval)).length,
        },
      },
      audit: { targetType: "user", targetId: tx.actor.handle },
    };
  },
};

/**
 * Remove one of a person's passkeys by id, and the web sessions it made. The
 * change both the ungated tool and an approved removal run (`via` is the
 * surface that asked: from the web view only while another passkey remains,
 * which is a condition of the DELETE, so two removals cannot both take the last
 * two).
 */
export function removePasskey(tx: Tx, id: string, via: Via): ActionOutcome {
  const removed = tx.sql.all<{ id: string; label: string }>(
    `DELETE FROM passkeys WHERE handle = ? AND id = ?
       AND (? = 'cli' OR (SELECT COUNT(*) FROM passkeys WHERE handle = ?) > 1)
     RETURNING id, label`,
    tx.actor.handle,
    id,
    via,
    tx.actor.handle,
  );
  const row = removed[0];
  if (!row) {
    if (tx.sql.one("SELECT 1 AS x FROM passkeys WHERE handle = ? AND id = ?", tx.actor.handle, id)) {
      throw denied(LAST_PASSKEY_CLI_ONLY);
    }
    throw new BbsError("not_found", "no such passkey");
  }
  // The sessions this passkey made go with it, in the same transaction: a lost or stolen passkey
  // must not leave its browsers signed in for the rest of their 30 days.
  const ended = revokePasskeySessions(tx, row.id);
  return {
    value: { removed: row.id, ended_sessions: ended, ended_current: tx.ctx.webSession !== undefined && ended.includes(tx.ctx.webSession) },
    audit: { targetType: "passkey", targetId: row.id, detail: { label: row.label, ended_sessions: ended } },
  };
}

/**
 * `bbs_passkey_remove`: one of the caller's passkeys by id (see `removePasskey`).
 * When the board requires approval, removing a passkey that can approve is a
 * gated action: it asks for an approval (any approver passkey of the person may
 * sign it, the one being removed included) and removes nothing yet. A passkey
 * that cannot approve keeps these rules.
 */
export const passkeyRemove: ActionDef = {
  name: "passkey_remove",
  kind: "change",
  run(tx, input) {
    requirePerson(tx, "remove a passkey", ["cli", "web"]);
    const id = reqString(asParams(input), "id", 64);
    if (tx.approval.required) {
      const target = tx.sql.one<{ id: string; label: string; backup_eligible: number; approver_barred: number }>(
        "SELECT id, label, backup_eligible, approver_barred FROM passkeys WHERE handle = ? AND id = ?",
        tx.actor.handle,
        id,
      );
      if (target && mayApprove(target, tx.approval)) {
        return requestApproval(tx, {
          action: "passkey_remove",
          ref: target.id,
          scope: { action: "passkey_remove", handle: tx.actor.handle, passkey: target.id, label: target.label },
        });
      }
    }
    return removePasskey(tx, id, tx.ctx.via);
  },
};
