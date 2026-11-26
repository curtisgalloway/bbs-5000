// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/** Reading tunables from the Worker's environment (plain functions, testable in Node). */

import { gcsSinkFromServiceAccount, type AuditSink } from "@bbs-5000/core";

/** Smallest lease the board accepts from the environment. */
export const MIN_LEASE_MS = 1_000;

/** Largest lease the board accepts from the environment: 7 days. */
export const MAX_LEASE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Parse a span in milliseconds from the environment (`BBS_TASK_LEASE_MS`,
 * `BBS_LOBBY_WINDOW_MS`, `BBS_LOBBY_MUTE_MS`); undefined (use the default)
 * when unset, not an integer, or outside MIN_LEASE_MS..MAX_LEASE_MS.
 */
export function leaseFromEnv(value: string | undefined, max = MAX_LEASE_MS): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value.trim())) return undefined;
  const ms = Number(value.trim());
  return Number.isSafeInteger(ms) && ms >= MIN_LEASE_MS && ms <= max ? ms : undefined;
}

/** Span overrides the Board DO reads, and the config key each one sets. */
export const SPAN_OVERRIDES = {
  BBS_TASK_LEASE_MS: "taskLeaseMs",
  BBS_LOBBY_WINDOW_MS: "lobbyWindowMs",
  BBS_LOBBY_MUTE_MS: "lobbyMuteMs",
  // Audit export (M6a): how old the oldest unexported row may get, and how
  // long exported rows stay in SQLite.
  BBS_AUDIT_EXPORT_INTERVAL_MS: "auditExportIntervalMs",
  BBS_AUDIT_HOT_MS: "auditHotMs",
  BBS_DOORBELL_DEBOUNCE_MS: "doorbellDebounceMs",
  // Wake budget window (design §6: one hour; M4b).
  BBS_WAKE_BUDGET_WINDOW_MS: "wakeBudgetWindowMs",
  // Topic archiving and cold storage (M6b, design §14).
  BBS_ARCHIVE_IDLE_MS: "archiveIdleMs",
  BBS_ARCHIVE_NOTICE_MS: "archiveNoticeMs",
  BBS_ARCHIVE_SCAN_MS: "archiveScanIntervalMs",
  BBS_COLD_AFTER_MS: "coldAfterMs",
  BBS_COLD_RETRY_MS: "coldRetryMs",
  // A replaced refresh token's grace (issue #55; the e2e suite shortens it to watch a replay).
  BBS_OAUTH_REFRESH_GRACE_MS: "oauthRefreshGraceMs",
} as const;

/** Per-span upper bounds where they differ from 7 days (the same as `validateConfig`'s). */
const SPAN_MAX: Partial<Record<keyof typeof SPAN_OVERRIDES, number>> = {
  BBS_AUDIT_EXPORT_INTERVAL_MS: 24 * 60 * 60 * 1000,
  BBS_AUDIT_HOT_MS: 366 * 24 * 60 * 60 * 1000,
  BBS_WAKE_BUDGET_WINDOW_MS: 24 * 60 * 60 * 1000,
  BBS_ARCHIVE_IDLE_MS: 366 * 24 * 60 * 60 * 1000,
  BBS_ARCHIVE_NOTICE_MS: 366 * 24 * 60 * 60 * 1000,
  BBS_COLD_AFTER_MS: 366 * 24 * 60 * 60 * 1000,
};

/** Count overrides (not spans): name, config key, and bounds. */
export const COUNT_OVERRIDES = {
  // Doorbells per wake budget window (design §6: 20; M4b).
  BBS_WAKE_BUDGET: { key: "wakeBudgetPerHour", min: 1, max: 10_000 },
  // Unexported audit rows that trigger an export at once (design §13; B44's
  // e2e lowers it; the default is 1000).
  BBS_AUDIT_EXPORT_BATCH_ROWS: { key: "auditExportBatchRows", min: 1, max: 1_000 },
  // Pairs one refresh token may produce inside its grace (design §9 step 8: 5; issue #55).
  BBS_OAUTH_REFRESH_MAX_SUCCESSORS: { key: "oauthRefreshMaxSuccessors", min: 1, max: 100 },
} as const;

export type CountEnv = Partial<Record<keyof typeof COUNT_OVERRIDES, string>>;

/** Parse a whole number in `min..max` from the environment; undefined when unset or invalid. */
export function countFromEnv(value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : undefined;
}

export type SpanEnv = Partial<Record<keyof typeof SPAN_OVERRIDES, string>>;

/**
 * Config overrides from the environment: each valid span, and the names of
 * the ones that were set but ignored (to warn about).
 */
type OverrideKey =
  | (typeof SPAN_OVERRIDES)[keyof typeof SPAN_OVERRIDES]
  | (typeof COUNT_OVERRIDES)[keyof typeof COUNT_OVERRIDES]["key"];

export function spansFromEnv(env: SpanEnv & CountEnv): {
  config: Partial<Record<OverrideKey, number>>;
  ignored: string[];
} {
  const config: Partial<Record<OverrideKey, number>> = {};
  const ignored: string[] = [];
  for (const [name, key] of Object.entries(SPAN_OVERRIDES) as [keyof SpanEnv, (typeof SPAN_OVERRIDES)[keyof SpanEnv]][]) {
    const raw = env[name];
    if (raw === undefined) continue;
    const ms = leaseFromEnv(raw, SPAN_MAX[name]);
    if (ms === undefined) ignored.push(name);
    else config[key] = ms;
  }
  for (const [name, o] of Object.entries(COUNT_OVERRIDES) as [keyof CountEnv, (typeof COUNT_OVERRIDES)[keyof CountEnv]][]) {
    const raw = env[name];
    if (raw === undefined) continue;
    const n = countFromEnv(raw, o.min, o.max);
    if (n === undefined) ignored.push(name);
    else config[o.key] = n;
  }
  return { config, ignored };
}

/** The audit export settings the Board DO reads (design §13, M6a). */
export interface AuditEnv {
  /** Cloud Storage bucket for audit batches. Export is off unless this and the key are set. */
  BBS_AUDIT_GCS_BUCKET?: string;
  /** The service account's JSON key (a secret). */
  BBS_AUDIT_GCS_KEY?: string;
  /** Test only: the e2e fake Cloud Storage endpoint (https, or http to this machine). */
  BBS_AUDIT_GCS_STORAGE_URL?: string;
  BBS_AUDIT_GCS_TOKEN_URL?: string;
}

/**
 * The audit sink from the environment: a `GcsSink`, or null (export off).
 * Nothing set: off, silently (deliberately unconfigured, review n2). Half
 * set, or a key or endpoint override that is refused: off, with the problem
 * to log once at start. A key that does not parse is reported without its
 * contents.
 */
export function auditSinkFromEnv(env: AuditEnv): { sink: AuditSink | null; problem?: string } {
  const bucket = env.BBS_AUDIT_GCS_BUCKET?.trim();
  const key = env.BBS_AUDIT_GCS_KEY?.trim();
  if (!bucket && !key) return { sink: null };
  if (!bucket || !key) return { sink: null, problem: "audit export off: set both BBS_AUDIT_GCS_BUCKET and BBS_AUDIT_GCS_KEY" };
  try {
    const sink = gcsSinkFromServiceAccount(key, bucket, {
      storageUrl: env.BBS_AUDIT_GCS_STORAGE_URL?.trim() || undefined,
      tokenUrl: env.BBS_AUDIT_GCS_TOKEN_URL?.trim() || undefined,
    });
    return { sink };
  } catch (err) {
    return { sink: null, problem: `audit export off: ${(err as Error).message}` };
  }
}
