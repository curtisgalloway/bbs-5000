// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/** `bbs_audit`: read the hot audit window (design §13 "Reading it"). */

import { asParams, optBool, optInt, optString, optTime, optTopic } from "../params.ts";
import { denied, type ActionDef } from "../types.ts";
import { chainState } from "./audit-export.ts";

export const auditRead: ActionDef = {
  name: "audit",
  kind: "audited_read",
  run(tx, input) {
    if (tx.actor.kind !== "human" && !tx.actor.isCoordinator) {
      throw denied("only human users and coordinators can read the audit log");
    }
    const p = asParams(input);
    const actor = optString(p, "actor", 64);
    const topic = optTopic(p);
    const task = optInt(p, "task", 1, Number.MAX_SAFE_INTEGER);
    const action = optString(p, "action", 64);
    const since = optTime(p, "since");
    const afterSeq = optInt(p, "after_seq", 0, Number.MAX_SAFE_INTEGER);
    // `tail`: the newest matching rows (the web view lists newest first).
    const tail = optBool(p, "tail") ?? false;
    const limit =
      optInt(p, "limit", 1, tx.config.auditMaxLimit) ?? tx.config.auditDefaultLimit;

    // Column names are fixed strings; only values are bound.
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (actor !== undefined) {
      where.push("actor = ?");
      args.push(actor);
    }
    if (topic !== undefined) {
      where.push("topic = ?");
      args.push(topic);
    }
    if (task !== undefined) {
      where.push("target_type = 'task' AND target_id = ?");
      args.push(String(task));
    }
    if (action !== undefined) {
      where.push("action = ?");
      args.push(action);
    }
    if (since !== undefined) {
      where.push("ts >= ?");
      args.push(since);
    }
    if (afterSeq !== undefined) {
      where.push("seq > ?");
      args.push(afterSeq);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = tx.sql.all(
      `SELECT seq, ts, actor, actor_kind, via, session, action, target_type, target_id,
              topic, result, detail, request_id, prev_hash
       FROM audit ${clause} ORDER BY seq ${tail ? "DESC" : ""} LIMIT ?`,
      ...args,
      tail ? limit + 1 : limit,
    );
    // Tail: one extra row says whether older rows were left out (`more_before`).
    const moreBefore = tail && rows.length > limit;
    if (moreBefore) rows.pop();
    // Always returned in seq order.
    if (tail) rows.reverse();
    const events = rows.map((r) => {
      let detail: unknown = r.detail;
      try {
        detail = JSON.parse(String(r.detail));
      } catch {
        // Keep the stored text.
      }
      return { ...r, detail };
    });
    return {
      // The recorded chain state, so the archive can be verified against it (M6a review m3).
      value: { events, ...(tail ? { more_before: moreBefore } : {}), chain: chainState(tx.sql) },
      audit: {
        targetType: "audit",
        ...(topic !== undefined ? { topic } : {}),
        detail: { count: events.length, ...(tail ? { tail } : {}) },
      },
    };
  },
};
