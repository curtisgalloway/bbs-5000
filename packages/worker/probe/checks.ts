// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * SQL behavior core depends on, checked on any `Sql` (after `migrate`).
 * Shared by the DO probe and the node:sqlite side of the e2e comparison.
 */

import type { Sql } from "@bbs-5000/core";

function attempt(fn: () => unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Can one statement bind `n` parameters? */
function params(sql: Sql, n: number): { ok: boolean; error?: string } {
  const placeholders = Array.from({ length: n }, () => "?").join(", ");
  const values = Array.from({ length: n }, (_, i) => i);
  const r = attempt(() => sql.one(`SELECT 1 IN (${placeholders}) AS hit`, ...values));
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export function sqlChecks(sql: Sql): Record<string, unknown> {
  const fkPragma = attempt(() => sql.one("PRAGMA foreign_keys"));
  // A session for a user that does not exist: refused only if FKs are enforced.
  const orphan = attempt(() =>
    sql.transaction(() =>
      sql.exec(
        "INSERT INTO sessions (id, handle, state, attached_at) VALUES (?, ?, 'idle', 0)",
        "s_probe",
        "nobody-at-all",
      ),
    ),
  );
  if (orphan.ok) sql.exec("DELETE FROM sessions WHERE id = ?", "s_probe");
  const master = attempt(() =>
    sql.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'audit') ORDER BY name"),
  );
  const jsonEach = attempt(() =>
    sql.all("SELECT value FROM json_each(?) ORDER BY value", JSON.stringify(["b", "a"])),
  );
  return {
    foreign_keys_pragma: fkPragma.ok ? fkPragma.value : fkPragma.error,
    orphan_insert_refused: !orphan.ok,
    orphan_error: orphan.ok ? null : orphan.error,
    sqlite_master: master.ok ? master.value : master.error,
    json_each: jsonEach.ok ? jsonEach.value : jsonEach.error,
    params_90: params(sql, 90),
    params_100: params(sql, 100),
    params_101: params(sql, 101),
  };
}
