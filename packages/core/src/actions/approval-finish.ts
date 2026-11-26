// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The write half of an approval's finish (issue #54, design §12): what runs,
 * synchronously and in one transaction, once `checkApproval` accepted the
 * passkey's signature. Called by `Board.approvalFinish` under the gated
 * action's own name, as the approving person, `via = web`.
 *
 * Each step is judged by the rows it changes, and any refusal rolls the whole
 * transaction back, so nothing is spent unless the gated change runs:
 *
 * 1. the request is spent (`UPDATE ... WHERE state = 'pending' AND expires_at > now`),
 *    so two finishes of one request make exactly one success;
 * 2. the passkey's sign count moves by sign-in's rule, and the passkey must
 *    still exist and still be allowed to approve;
 * 3. the gated action's change runs, re-checking its own conditions (the
 *    pairing still pending, the request still undecided, the passkey still
 *    present).
 */

import { asParams, reqString } from "../params.ts";
import { BbsError, denied, type ActionDef, type ActionOutcome, type Tx, type Via } from "../types.ts";
import { oauthApprove } from "./oauth.ts";
import { moveSignCount, removePasskey } from "./passkey.ts";
import { approvePairing } from "./web-session.ts";

interface SpentRow {
  action: string;
  ref: string;
  scope: string;
  requested_via: string;
}

/** The gated change an approval of `row` stands for. */
function applyGated(tx: Tx, row: SpentRow): ActionOutcome {
  const scope = JSON.parse(row.scope) as Record<string, unknown>;
  switch (row.action) {
    case "web_pairing_approve":
      return approvePairing(tx, Number(row.ref));
    case "oauth_decide":
      return oauthApprove(tx, row.ref, String(scope.agent), String(scope.client_name));
    case "passkey_remove":
      return removePasskey(tx, row.ref, row.requested_via as Via);
    default:
      throw new BbsError("internal", `unknown gated action ${row.action}`);
  }
}

/**
 * Internal: finish the approval `checkApproval` accepted. Refusals carry their
 * reason as the message (`approval_not_pending`, ...) or, for the gated change
 * itself, the change's own message; the board counts them through the failed
 * sign-in guards instead of writing a row each.
 */
export const approvalFinish: ActionDef = {
  name: "approval_finish",
  kind: "change",
  // Approving is not the person's activity (no last_seen, no lease renewal).
  passive: true,
  run(tx, input) {
    const p = asParams(input);
    if (tx.actor.kind !== "human" || tx.actor.status !== "active") throw denied("approval_account_not_active");
    const id = reqString(p, "approval", 64);
    const passkey = reqString(p, "passkey", 64);
    const spent = tx.sql.all<SpentRow>(
      `UPDATE approvals SET state = 'approved', decided_at = ?, passkey = ?
       WHERE id = ? AND handle = ? AND state = 'pending' AND expires_at > ?
       RETURNING action, ref, scope, requested_via`,
      tx.now,
      passkey,
      id,
      tx.actor.handle,
      tx.now,
    )[0];
    if (!spent) throw denied("approval_not_pending", "not_found");
    const count = Number(p.sign_count ?? 0);
    if (!moveSignCount(tx, passkey, count, p.backup_state === true, tx.approval)) {
      const there = tx.sql.one("SELECT 1 AS x FROM passkeys WHERE id = ? AND handle = ?", passkey, tx.actor.handle);
      throw denied(there ? "approval_sign_count_not_increasing" : "approval_unknown_credential");
    }
    let outcome: ActionOutcome;
    try {
      outcome = applyGated(tx, spent);
    } catch (err) {
      // Any refusal of the change is counted by the sign-in guards, not given a row of its own.
      if (err instanceof BbsError && err.code !== "internal") throw denied(err.message, err.code);
      throw err;
    }
    return {
      value: { action: spent.action, result: outcome.value },
      audit: {
        ...outcome.audit,
        detail: { ...outcome.audit.detail, approval: id, passkey },
      },
      ...(outcome.notifications ? { notifications: outcome.notifications } : {}),
    };
  },
};
