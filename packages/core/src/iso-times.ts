// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Times in tool results (design §11): ISO 8601 UTC text, as
 * `new Date(ms).toISOString()`. Storage, audit rows, the audit hash chain,
 * archives, timers and socket frames keep epoch milliseconds; the conversion
 * happens once, in `toToolResult`, on a result as it leaves the board.
 *
 * The walk converts a value only when it is a finite number under a time
 * key. Durations (`*_ms`), sequence numbers and counts are never converted,
 * and strings (message bodies and other user text) are never touched.
 */

import { BbsError } from "./types.ts";

/**
 * Keys that hold a time but do not end in `_at`. Audited against every tool
 * result and every audit `detail` shape; each is epoch milliseconds.
 */
export const TIME_KEYS: ReadonlySet<string> = new Set([
  "ts", // an audit row's time
  "at", // a stored notice's time; a ring result's time in `bbs_admin_status`
  "now", // the board's clock in `bbs_admin_status`
  "last_seen",
  "busy_since",
  "failing_since",
  "rings_failing_since",
  "pending_since",
  "muted_until",
  "budget_until", // a ring held over the wake budget (audit detail)
  "until", // the end of a mute
  "next", // the next archive scan (audit detail)
  "due", // an archive scan's due time
  "window_start", // the start of a flood window (audit detail)
  "archive_after", // when a notified topic will be archived
  "last_activity", // a topic's last activity, in an archive notice's audit detail
]);

/**
 * Keys that are times only in one action's result. `since` is a time in
 * `bbs_admin_status` flags, but a sequence number in the audit detail of
 * `bbs_read` (which `bbs_audit` returns), so it is not in `TIME_KEYS`.
 */
export const ACTION_TIME_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  admin_status: new Set(["since"]),
};

function isTimeKey(key: string, extra: ReadonlySet<string> | undefined): boolean {
  return key.endsWith("_at") || TIME_KEYS.has(key) || (extra?.has(key) ?? false);
}

/** `new Date(ms).toISOString()`, or the number unchanged when it is no valid date. */
function iso(ms: number): number | string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? ms : d.toISOString();
}

/** A copy of `value` with every epoch-millisecond number under a time key as ISO text. */
export function isoTimes(value: unknown, action?: string): unknown {
  const extra = action === undefined ? undefined : ACTION_TIME_KEYS[action];
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = typeof x === "number" && Number.isFinite(x) && isTimeKey(k, extra) ? iso(x) : walk(x);
    }
    return out;
  };
  return walk(value);
}

const ISO_INPUT_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/;

/**
 * A time given as an input: an integer of epoch milliseconds, or an ISO 8601
 * string (a date alone is midnight UTC; a time needs `Z` or an offset).
 * Returns epoch milliseconds; anything else is a `bad_request`.
 */
export function parseTimeInput(value: unknown, key: string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BbsError("bad_request", `${key} must be epoch milliseconds or an ISO 8601 time`);
    }
    return value;
  }
  if (typeof value === "string" && value.length <= 40 && ISO_INPUT_RE.test(value)) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  throw new BbsError("bad_request", `${key} must be epoch milliseconds or an ISO 8601 time`);
}
