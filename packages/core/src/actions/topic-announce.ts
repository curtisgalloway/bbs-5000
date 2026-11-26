// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The board's Lobby announcement of new topics (issue #80, decided 2026-11-24).
 *
 * The first topic created while no window is open is announced at once, inside
 * `topic_create`'s own transaction like the join message, and opens a window of
 * `topicAnnounceWindowMs`. A topic created while a window is open is only marked
 * (`topics.announce_pending`). The window is the one `topic_announce` timer; its
 * action posts the marked topics that are still active as one line, and a post
 * opens a new window, so a steady stream makes at most one Lobby post per window.
 * With nothing to post the window just ends.
 */

import { userStatusSql } from "../schema.ts";
import type { ActionDef, MessageNotification, Tx } from "../types.ts";
import { insertMessage, LOBBY } from "./common.ts";

const ELLIPSIS = "…";

/**
 * The single-topic line. The description is a user's text inside a message the
 * board signs as `system`, so it goes in as one line (every run of white space
 * becomes one space, so it cannot start a paragraph of its own) and is cut with
 * an ellipsis at `topicAnnounceDescriptionMax`, and to fit `maxBodyLength`; it
 * is put in quotation marks, and left out unless the creator's account is active (not muted in the Lobby, not kicked).
 */
export function singleLine(tx: Tx, name: string, creator: string, raw: string): string {
  const head = `New topic #${name} by ${creator}`;
  const description = raw.replace(/\s+/g, " ").trim();
  if (description === "") return head;
  // Only an active creator's description is carried: one muted in the Lobby, or kicked before a
  // deferred line goes out, gets the bare line, so a description is no way around either.
  // Read through the token (issue #98): a session handle of a muted token is muted too.
  const status = tx.sql.one<{ status: string }>(`SELECT ${userStatusSql()} AS status FROM users WHERE handle = ?`, creator)?.status;
  if (status !== "active") return head;
  const prefix = `${head}: `;
  // Two characters of room go to the quotation marks that set the user's text off from the board's.
  const room = Math.min(tx.config.topicAnnounceDescriptionMax, tx.config.maxBodyLength - prefix.length - 2);
  const text =
    description.length <= room ? description : `${description.slice(0, Math.max(0, room - 1))}${ELLIPSIS}`;
  return `${prefix}"${text}"`;
}

/** The batch line for two or more topics: names and creators only, the rest counted. */
export function batchLine(tx: Tx, topics: readonly { name: string; created_by: string }[]): string {
  const listed = topics.slice(0, tx.config.topicAnnounceMaxListed);
  const more = topics.length - listed.length;
  const line =
    `${topics.length} new topics: ` + listed.map((t) => `#${t.name} (by ${t.created_by})`).join(", ");
  return more > 0 ? `${line} and ${more} more` : line;
}

function post(tx: Tx, body: string): { seq: number; notification: MessageNotification } {
  const seq = insertMessage(tx, {
    topic: LOBBY,
    author: "system",
    authorKind: "system",
    body,
    replyTo: null,
    mentions: [],
    isSystem: true,
  });
  return {
    seq,
    notification: { type: "message", topic: LOBBY, seq, author: "system", mentions: [], isSystem: true },
  };
}

/**
 * Called by `topic_create` after the topic row is written. Opens a window
 * and posts the announcement when none is open (an INSERT judged by the rows it
 * changes); otherwise marks the topic for the batch. Returns what `topic_create`
 * adds to its outcome.
 */
export function announceNewTopic(
  tx: Tx,
  topic: { name: string; description: string },
): { notifications: MessageNotification[]; detail: Record<string, unknown> } {
  const opened = tx.sql.all<{ id: number }>(
    `INSERT INTO timers (due_at, kind, ref)
     SELECT ?, 'topic_announce', 'board'
     WHERE NOT EXISTS (SELECT 1 FROM timers WHERE kind = 'topic_announce')
     RETURNING id`,
    tx.now + tx.config.topicAnnounceWindowMs,
  );
  if (opened.length === 0) {
    tx.sql.exec("UPDATE topics SET announce_pending = 1 WHERE name = ?", topic.name);
    return { notifications: [], detail: { announce: "deferred" } };
  }
  const { seq, notification } = post(tx, singleLine(tx, topic.name, tx.actor.handle, topic.description));
  return { notifications: [notification], detail: { announce: "posted", lobby_seq: seq } };
}

/**
 * Timer `topic_announce` (system): the window ended. Posts the topics created
 * during it that are still active (one topic in the single-topic wording, more
 * as one batch line) and opens a new window; with none left it posts nothing and
 * the window stays closed until the next new topic.
 */
export const topicAnnounce: ActionDef = {
  name: "topic_announce",
  kind: "change",
  run(tx) {
    tx.sql.exec("DELETE FROM timers WHERE kind = 'topic_announce'");
    const marked = tx.sql.all<{ name: string; description: string; created_by: string; state: string }>(
      `SELECT name, description, created_by, state FROM topics
       WHERE announce_pending = 1 ORDER BY rowid`,
    );
    tx.sql.exec("UPDATE topics SET announce_pending = 0 WHERE announce_pending = 1");
    const topics = marked.filter((t) => t.state === "active");
    const detail: Record<string, unknown> = { pending: marked.length, announced: topics.length };
    if (topics.length === 0) return { value: detail, audit: { targetType: "timer", detail } };
    const only = topics.length === 1 ? topics[0] : undefined;
    const body = only
      ? singleLine(tx, only.name, only.created_by, only.description)
      : batchLine(tx, topics);
    const { seq, notification } = post(tx, body);
    tx.sql.exec(
      "INSERT INTO timers (due_at, kind, ref) VALUES (?, 'topic_announce', 'board')",
      tx.now + tx.config.topicAnnounceWindowMs,
    );
    detail.lobby_seq = seq;
    return { value: detail, audit: { targetType: "timer", detail }, notifications: [notification] };
  },
};
