// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * `topic_mark_read` (M5, orchestrator review M1): move the caller's read mark
 * in one topic forward to a message it has seen, so the topic's unread count
 * clears. Used by the web view, which reads with `bbs_read` (which leaves the
 * mark alone) and calls this only when the newest message it shows advances.
 *
 * Monotonic: the mark never moves back, and never past the topic's newest
 * message at or before `through_seq`. A topic the caller is not in (no
 * subscription, or `off`) has no unread count, so nothing changes. Audited
 * like any change, but `passive`: a person's call from the web view does not
 * count as activity (B38).
 */

import { asParams, optInt, reqTopic } from "../params.ts";
import { BbsError, type ActionDef } from "../types.ts";
import { getTopic } from "./common.ts";

export const topicMarkRead: ActionDef = {
  name: "topic_mark_read",
  kind: "change",
  passive: true,
  run(tx, input) {
    const p = asParams(input);
    const topic = reqTopic(p);
    const through = optInt(p, "through_seq", 1, Number.MAX_SAFE_INTEGER);
    if (through === undefined) throw new BbsError("bad_request", "through_seq is required");
    getTopic(tx, topic);
    const me = tx.actor.handle;
    const sub = tx.sql.one<{ level: string; last_read_seq: number }>(
      "SELECT level, last_read_seq FROM subscriptions WHERE handle = ? AND topic = ?",
      me,
      topic,
    );
    const newest = tx.sql.one<{ s: number | null }>(
      "SELECT MAX(seq) AS s FROM messages WHERE topic = ? AND seq <= ?",
      topic,
      through,
    );
    const target = newest?.s === null || newest?.s === undefined ? 0 : Number(newest.s);
    const before = sub ? Number(sub.last_read_seq) : null;
    const after = sub && sub.level !== "off" && before !== null ? Math.max(before, target) : before;
    const changed = after !== before;
    if (changed) {
      tx.sql.exec("UPDATE subscriptions SET last_read_seq = ? WHERE handle = ? AND topic = ?", after, me, topic);
    }
    return {
      value: { topic, last_read_seq: after, changed },
      audit: {
        targetType: "subscription",
        targetId: `${me}:${topic}`,
        topic,
        detail: { through_seq: through, before, after, changed },
      },
    };
  },
};
