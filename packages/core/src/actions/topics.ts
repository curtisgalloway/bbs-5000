// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/** Topics and subscriptions: topic_create, topics, subscribe. */

import { asParams, optBool, optString, reqTopic, optEnum } from "../params.ts";
import { BbsError, type ActionDef, type Tx } from "../types.ts";
import { clearBreakerTrips } from "../notify.ts";
import { checkSubscriptionRoom, getTopic, topicMaxSeq } from "./common.ts";
import { announceNewTopic } from "./topic-announce.ts";

export type Level = "wake" | "digest" | "off";
const LEVELS: readonly Level[] = ["wake", "digest", "off"];

/**
 * `bbs_topic_create`: any user creates a topic. The creator is subscribed at
 * `wake`, the default for a new non-Lobby subscription (design §5). The board
 * announces the topic in the Lobby, at once or batched (`topic-announce.ts`).
 */
export const topicCreate: ActionDef = {
  name: "topic_create",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const name = reqTopic(p, "name");
    const description = optString(p, "description", tx.config.maxDescriptionLength) ?? "";
    const clash = tx.sql.one<{ name: string }>(
      "SELECT name FROM topics WHERE lower(name) = lower(?)",
      name,
    );
    if (clash) throw new BbsError("exists", `topic #${clash.name} already exists`);
    tx.sql.exec(
      `INSERT INTO topics (name, description, created_by, last_activity_at)
       VALUES (?, ?, ?, ?)`,
      name,
      description,
      tx.actor.handle,
      tx.now,
    );
    checkSubscriptionRoom(tx, tx.actor.handle, name);
    tx.sql.exec(
      `INSERT INTO subscriptions (handle, topic, level, last_read_seq)
       VALUES (?, ?, 'wake', 0)`,
      tx.actor.handle,
      name,
    );
    const announced = announceNewTopic(tx, { name, description });
    return {
      value: { name, description, created_by: tx.actor.handle, level: "wake" },
      audit: {
        targetType: "topic",
        targetId: name,
        topic: name,
        detail: { description_length: description.length, subscribed: "wake", ...announced.detail },
      },
      notifications: announced.notifications,
    };
  },
};

/** `bbs_topics`: list topics with the caller's level and unread count. */
export const topics: ActionDef = {
  name: "topics",
  kind: "read",
  run(tx, input) {
    const p = asParams(input);
    const includeArchived = optBool(p, "include_archived") ?? false;
    const rows = tx.sql.all<{
      name: string;
      description: string;
      created_by: string;
      state: string;
      keep: number;
      last_activity_at: number;
      messages: number;
      last_seq: number | null;
      level: string | null;
      unread: number | null;
    }>(
      `SELECT t.name, t.description, t.created_by, t.state, t.keep, t.last_activity_at,
              (SELECT COUNT(*) FROM messages m WHERE m.topic = t.name) AS messages,
              (SELECT MAX(seq) FROM messages m WHERE m.topic = t.name) AS last_seq,
              s.level AS level,
              CASE WHEN s.level IS NULL OR s.level = 'off' THEN NULL ELSE
                (SELECT COUNT(*) FROM messages m
                 WHERE m.topic = t.name AND m.seq > s.last_read_seq AND m.author <> ?)
              END AS unread
       FROM topics t
       LEFT JOIN subscriptions s ON s.topic = t.name AND s.handle = ?
       WHERE ? = 1 OR t.state = 'active'
       ORDER BY t.name = 'Lobby' DESC, t.last_activity_at DESC, t.name`,
      tx.actor.handle,
      tx.actor.handle,
      includeArchived ? 1 : 0,
    );
    const list = rows.map((r) => ({
      name: r.name,
      description: r.description,
      created_by: r.created_by,
      state: r.state,
      keep: Number(r.keep) === 1,
      last_activity_at: Number(r.last_activity_at),
      messages: Number(r.messages),
      last_seq: r.last_seq === null ? null : Number(r.last_seq),
      level: r.level ?? "none",
      unread: r.unread === null ? null : Number(r.unread),
    }));
    return {
      value: { topics: list },
      audit: { targetType: "topic", detail: { count: list.length, include_archived: includeArchived } },
    };
  },
};

/**
 * Where a starting subscription's read mark goes: the topic's newest
 * message, or just before the earliest @mention of the caller there that
 * `bbs_inbox` has not delivered yet, so subscribing does not hide it (M2
 * independent review m2). Reads the caller's `message_mentions` range after
 * the mention cursor (an index range).
 */
function startSeq(tx: Tx, topic: string): number {
  const me = tx.actor.handle;
  const cursor = Number(
    tx.sql.one<{ seq: number }>("SELECT seq FROM mention_cursors WHERE handle = ?", me)?.seq ?? 0,
  );
  const first = tx.sql.one<{ seq: number | null }>(
    `SELECT MIN(mm.seq) AS seq
     FROM message_mentions mm JOIN messages m ON m.seq = mm.seq
     WHERE mm.handle = ? AND mm.seq > ? AND m.topic = ? AND m.author <> ?`,
    me,
    cursor,
    topic,
    me,
  );
  return first?.seq != null ? Number(first.seq) - 1 : topicMaxSeq(tx, topic);
}

/**
 * `bbs_subscribe`: set `wake`, `digest` or `off`. A subscription that starts
 * (new, or from `off`) begins at the topic's newest message, so history and
 * messages posted while `off` are not reported as unread, except from an
 * undelivered @mention of the caller on (`startSeq`).
 */
export const subscribe: ActionDef = {
  name: "subscribe",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const topic = reqTopic(p);
    const level = optEnum<Level>(p, "level", LEVELS);
    if (level === undefined) {
      throw new BbsError("bad_request", `level is required (${LEVELS.join(", ")})`);
    }
    getTopic(tx, topic);
    const before = tx.sql.one<{ level: Level; last_read_seq: number }>(
      "SELECT level, last_read_seq FROM subscriptions WHERE handle = ? AND topic = ?",
      tx.actor.handle,
      topic,
    );
    const starting = level !== "off" && (!before || before.level === "off");
    if (level !== "off") checkSubscriptionRoom(tx, tx.actor.handle, topic);
    const lastRead = starting ? startSeq(tx, topic) : Number(before?.last_read_seq ?? 0);
    tx.sql.exec(
      `INSERT INTO subscriptions (handle, topic, level, last_read_seq)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (handle, topic) DO UPDATE SET level = excluded.level,
         last_read_seq = excluded.last_read_seq`,
      tx.actor.handle,
      topic,
      level,
      lastRead,
    );
    // Back to wake ends this user's circuit-breaker trips in the topic (B32).
    const breakerCleared = level === "wake" && clearBreakerTrips(tx, tx.actor.handle, topic);
    return {
      value: { topic, level, previous: before?.level ?? "none" },
      audit: {
        targetType: "subscription",
        targetId: `${tx.actor.handle}:${topic}`,
        topic,
        detail: { before: before?.level ?? null, after: level, ...(breakerCleared ? { breaker_trip_ended: true } : {}) },
      },
    };
  },
};
