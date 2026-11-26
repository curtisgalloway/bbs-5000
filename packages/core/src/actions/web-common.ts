// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * What the web sign-in, passkey and approval actions share: the code alphabet
 * and its random source, the prune timer's arming, and the "only a person, only
 * from these surfaces" check. Kept apart so `approval.ts` and `web-session.ts`
 * can each use them without importing one another.
 */

import { denied, type Tx, type Via } from "../types.ts";

/** 31 characters: no I, L, O, 0 or 1, which look alike. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;
/** Largest multiple of the alphabet size under 256; bytes at or over it are skipped, so no character is likelier. */
const CODE_BYTE_LIMIT = 256 - (256 % CODE_ALPHABET.length);

/** A new code from the random source: `length` characters of the alphabet, none likelier than another. Eight for a pairing code (no hyphen), six for an approval's match code. */
export function randomCode(randomBytes: (n: number) => Uint8Array, length: number = CODE_LENGTH): string {
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(16)) {
      if (b >= CODE_BYTE_LIMIT) continue;
      out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Start the prune timer when there is none (an INSERT judged by its own condition). */
export function armPrune(tx: Tx): void {
  tx.sql.exec(
    `INSERT INTO timers (due_at, kind, ref)
     SELECT ?, 'web_prune', 'board'
     WHERE NOT EXISTS (SELECT 1 FROM timers WHERE kind = 'web_prune')`,
    tx.now + tx.config.webPruneIntervalMs,
  );
}

export function requirePerson(tx: Tx, what: string, vias: readonly Via[]): void {
  if (tx.actor.kind !== "human") throw denied(`only a person can ${what}`);
  if (!vias.includes(tx.ctx.via)) {
    throw denied(
      vias.length === 1 && vias[0] === "cli"
        ? `${what} is only available from the bbs CLI`
        : `${what} is not available here`,
    );
  }
}
