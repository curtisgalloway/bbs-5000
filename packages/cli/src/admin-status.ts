// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * `bbs admin status` (G5): the human admin's board-health read, printed for a
 * person. `--json` prints the tool result unchanged instead.
 *
 * Same layout rules as the web view's Admin tab: what needs a person first
 * (or "All clear"), then one line per user in handle order with plain data;
 * elapsed time ("12 min ago", "40 min left") rather than timestamps; state as
 * words, never color.
 */

export interface StatusFlag {
  kind: string;
  handle?: string;
  what: string;
  todo: string;
}

export interface StatusUser {
  handle: string;
  kind: string;
  harness: string | null;
  role: string;
  coordinator: boolean;
  admin: boolean;
  status: string;
  muted_until: string | null;
  kicked_at: string | null;
  last_seen: string | null;
  session: { state: string; machine: string | null; os: string | null; model: string | null; attached_at: string; socket_recorded: boolean } | null;
  open_sockets: number | null;
  rings: { at: string; result: string }[];
  wake_budget: { used: number; limit: number; window_ends_at: string | null } | null;
}

/** " on workstation-1 (macOS, claude-opus-5-5)": where a session runs; empty when it reported nothing. */
function sessionWhere(s: { machine: string | null; os: string | null; model: string | null }): string {
  const detail = [s.os, s.model].filter((x) => x).join(", ");
  if (s.machine) return ` on ${s.machine}${detail ? ` (${detail})` : ""}`;
  return detail ? ` (${detail})` : "";
}

export interface AdminStatus {
  now: string;
  users: StatusUser[];
  audit_export: {
    configured: boolean | null;
    unexported_rows: number;
    oldest_unexported_at: string | null;
    last_ok_at: string | null;
    failing_since: string | null;
  };
  needs_you: StatusFlag[];
}

/** A span as words, like core's `formatSpan`. */
export function span(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} h`;
}

// Tool results carry times as ISO 8601 text; the arithmetic below is on milliseconds.
const epoch = (t: string): number => Date.parse(t);
const ago = (now: string, t: string | null): string => (t === null ? "never" : `${span(epoch(now) - epoch(t))} ago`);

function userLine(s: AdminStatus, u: StatusUser): string {
  const parts: string[] = [u.kind];
  if (u.harness) parts.push(u.harness);
  const flags = [u.admin ? "admin" : "", u.coordinator ? "coordinator" : ""].filter(Boolean);
  if (flags.length > 0) parts.push(flags.join(", "));
  // Only an abnormal status is named (a healthy board stays quiet).
  if (u.status === "kicked") parts.push(`KICKED ${ago(s.now, u.kicked_at)}`);
  else if (u.status === "muted") parts.push(`MUTED in Lobby${u.muted_until === null ? "" : `, ${span(epoch(u.muted_until) - epoch(s.now))} left`}`);
  else if (u.status === "retired") parts.push("retired (no credential)");
  if (u.kind === "agent") {
    if (u.session) {
      const sockets = u.open_sockets ?? (u.session.socket_recorded ? 1 : 0);
      parts.push(`${u.session.state}${sessionWhere(u.session)}, adapter ${sockets > 0 ? "attached" : "not attached"}`);
    } else {
      parts.push("no session");
    }
    const failed = u.rings.filter((r) => r.result === "failed").length;
    if (u.rings.length > 0) {
      parts.push(`last ring ${u.rings[0]?.result.replace("_", " ")} ${ago(s.now, u.rings[0]?.at ?? null)}${failed > 0 ? ` (${failed} of last ${u.rings.length} failed)` : ""}`);
    }
    if (u.wake_budget) parts.push(`wake budget ${u.wake_budget.used}/${u.wake_budget.limit}`);
  }
  parts.push(`last seen ${ago(s.now, u.last_seen)}`);
  return `  ${u.handle}: ${parts.join("; ")}${u.role ? ` — role: ${u.role}` : ""}`;
}

/** The text `bbs admin status` prints. */
export function formatAdminStatus(s: AdminStatus): string {
  const lines: string[] = [];
  if (s.needs_you.length === 0) {
    lines.push("All clear: nothing needs you.");
  } else {
    lines.push(`Needs you (${s.needs_you.length}):`);
    for (const f of s.needs_you) {
      lines.push(`  ! ${f.what}`);
      lines.push(`    What to do: ${f.todo}`);
    }
  }
  lines.push("");
  const agents = s.users.filter((u) => u.kind === "agent");
  const people = s.users.filter((u) => u.kind !== "agent");
  lines.push(`Agents (${agents.length}):`);
  for (const u of agents) lines.push(userLine(s, u));
  lines.push(`People (${people.length}):`);
  for (const u of people) lines.push(userLine(s, u));
  lines.push("");
  const e = s.audit_export;
  const exportState =
    e.configured === false
      ? "off (no sink configured; rows stay in the board)"
      : e.configured === null
        ? "unknown"
        : e.failing_since !== null
          ? `failing for ${span(epoch(s.now) - epoch(e.failing_since))}`
          : `last confirmed ${ago(s.now, e.last_ok_at)}`;
  lines.push(
    `Audit export: ${exportState}; ${e.unexported_rows} rows waiting` +
      (e.oldest_unexported_at === null ? "." : `, oldest ${ago(s.now, e.oldest_unexported_at)}.`),
  );
  return lines.join("\n");
}
