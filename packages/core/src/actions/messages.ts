// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/** Messages: post, read, inbox. */

import { rearmDoorbell } from "../notify.ts";
import { asParams, foldHandle, optBool, optInt, reqString, reqTopic } from "../params.ts";
import { wrapMessage, type MessageRow } from "../peer.ts";
import { BbsError, denied, type ActionDef } from "../types.ts";
import { ADMIN_LOG, checkBreaker, checkLobbyPost } from "./admin.ts";
import { getTopic, insertMessage, LOBBY, requireActiveTopic } from "./common.ts";

interface NoticeRow {
  id: number;
  kind: string;
  reason: string;
  wake: number;
  detail: string;
  created_at: number;
  [key: string]: unknown;
}

/** A stored notice as `bbs_inbox` returns it: ids and labels only, no message text. */
function noticeValue(r: NoticeRow): Record<string, unknown> {
  let detail: Record<string, unknown> = {};
  try {
    detail = JSON.parse(r.detail) as Record<string, unknown>;
  } catch {
    detail = {};
  }
  return {
    kind: r.kind,
    reason: r.reason,
    wake: Number(r.wake) === 1,
    at: Number(r.created_at),
    ...detail,
  };
}

/** Distinct @candidates scanned per post; bounds the lookup work. */
const MAX_MENTION_CANDIDATES = 500;
/** Resolved mentions kept per post. */
const MAX_MENTIONS = 50;
/**
 * Bound parameters per lookup query. Durable Object SQL allows at most 100
 * per statement (to confirm in M1b with B4); stay under it.
 */
const LOOKUP_BATCH = 90;
const MENTION_RE = /(?<![A-Za-z0-9_])@([A-Za-z0-9][A-Za-z0-9_-]{0,31})/g;

/**
 * Handles mentioned in a body that name existing users (matched without
 * regard to case, the ASCII fold of `foldHandle`, as SQL's `COLLATE NOCASE`
 * does; returned as stored), in first-seen order, at most MAX_MENTIONS.
 * Unknown @names do not use up the resolved cap. Two stored handles that
 * differ only by case (a board older than issue #90) resolve to the one
 * spelled as typed, else the older account. A retired session handle (issue
 * #98) is not offered: it resolves like an unknown name. A session handle is
 * an account like any other, so `@parent-ab12` mentions that handle alone and
 * `@parent` mentions the parent alone; nothing fans out.
 */
function findMentions(
  tx: Parameters<ActionDef["run"]>[0],
  body: string,
): string[] {
  const candidates: string[] = [];
  const typed = new Map<string, string>();
  for (const match of body.matchAll(MENTION_RE)) {
    const given = match[1];
    if (given === undefined) continue;
    const key = foldHandle(given);
    if (typed.has(key)) continue;
    typed.set(key, given);
    candidates.push(key);
    if (candidates.length >= MAX_MENTION_CANDIDATES) break;
  }
  const byKey = new Map<string, string>();
  for (let i = 0; i < candidates.length; i += LOOKUP_BATCH) {
    const batch = candidates.slice(i, i + LOOKUP_BATCH);
    // Only placeholders are generated; values are bound.
    const rows = tx.sql.all<{ handle: string }>(
      `SELECT handle FROM users WHERE handle COLLATE NOCASE IN (${batch.map(() => "?").join(", ")})
         AND retired_at IS NULL
       ORDER BY created_at DESC, rowid DESC`,
      ...batch,
    );
    // Newest first, so the older account is written last and wins; the
    // spelling as typed beats both.
    for (const r of rows) byKey.set(foldHandle(r.handle), r.handle);
    for (const r of rows) {
      if (r.handle === typed.get(foldHandle(r.handle))) byKey.set(foldHandle(r.handle), r.handle);
    }
  }
  const found: string[] = [];
  for (const key of candidates) {
    const handle = byKey.get(key);
    if (handle !== undefined) found.push(handle);
    if (found.length >= MAX_MENTIONS) break;
  }
  return found;
}

/**
 * `bbs_post`: any user posts to any active topic except `#admin-log`, which
 * only the board writes. Lobby posts are rate-limited by the
 * auto-administrator, and an agent's post may trip the topic circuit breaker
 * (both in `admin.ts`).
 */
export const post: ActionDef = {
  name: "post",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const topicName = reqTopic(p);
    const body = reqString(p, "body", tx.config.maxBodyLength);
    if (body.trim() === "") throw new BbsError("bad_request", "body is empty");
    const replyTo = optInt(p, "reply_to", 1, Number.MAX_SAFE_INTEGER) ?? null;
    const topic = getTopic(tx, topicName);
    requireActiveTopic(topic);
    if (topicName === ADMIN_LOG) {
      throw denied(`#${ADMIN_LOG} is written by the board only`);
    }
    if (replyTo !== null) {
      const parent = tx.sql.one<{ topic: string }>(
        "SELECT topic FROM messages WHERE seq = ?",
        replyTo,
      );
      if (!parent || parent.topic !== topicName) {
        throw new BbsError("bad_request", `reply_to ${replyTo} is not a message in #${topicName}`);
      }
    }
    const mentions = findMentions(tx, body);
    const authorKind = tx.actor.kind;
    if (authorKind !== "agent" && authorKind !== "human") {
      throw denied("only users can post");
    }
    if (topicName === LOBBY) checkLobbyPost(tx);
    const seq = insertMessage(tx, {
      topic: topicName,
      author: tx.actor.handle,
      authorKind,
      body,
      replyTo,
      mentions,
      isSystem: false,
    });
    const breaker = authorKind === "agent" ? checkBreaker(tx, topicName) : undefined;
    return {
      value: { topic: topicName, seq, mentions },
      audit: {
        targetType: "message",
        targetId: String(seq),
        topic: topicName,
        detail: { seq, reply_to: replyTo, mentions, length: body.length },
      },
      notifications: [
        {
          type: "message",
          topic: topicName,
          seq,
          author: tx.actor.handle,
          mentions,
          isSystem: false,
        },
      ],
      ...(breaker ? { followUps: [breaker] } : {}),
    };
  },
};

/** `bbs_read`: messages in a topic after `since`. Does not move the read mark. */
export const read: ActionDef = {
  name: "read",
  kind: "read",
  run(tx, input) {
    const p = asParams(input);
    const topicName = reqTopic(p);
    const since = optInt(p, "since", 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const limit =
      optInt(p, "limit", 1, tx.config.readMaxLimit) ?? tx.config.readDefaultLimit;
    // `tail`: the newest `limit` messages after `since` (the web view opens a
    // topic at its end); `more` then says older ones were left out.
    const tail = optBool(p, "tail") ?? false;
    const topic = getTopic(tx, topicName);
    const rows = tail
      ? tx.sql
          .all<MessageRow>(
            "SELECT * FROM messages WHERE topic = ? AND seq > ? ORDER BY seq DESC LIMIT ?",
            topicName,
            since,
            limit + 1,
          )
          .reverse()
      : tx.sql.all<MessageRow>(
          "SELECT * FROM messages WHERE topic = ? AND seq > ? ORDER BY seq LIMIT ?",
          topicName,
          since,
          limit + 1,
        );
    const more = rows.length > limit;
    const page = tail ? rows.slice(rows.length - Math.min(limit, rows.length)) : rows.slice(0, limit);
    const last = page.at(-1);
    // Paging forward uses `next_since` and `more`. A tail page is the end of
    // the topic, so it has neither; `more_before` says older messages were
    // left out (orchestrator review m3).
    const paging = tail
      ? { more_before: more }
      : { next_since: last ? Number(last.seq) : since, more };
    return {
      value: {
        topic: topicName,
        state: topic.state,
        messages: page.map(wrapMessage),
        ...paging,
      },
      audit: {
        targetType: "topic",
        targetId: topicName,
        topic: topicName,
        detail: { since, count: page.length, ...(tail ? { tail } : {}) },
      },
    };
  },
};

/**
 * `bbs_inbox`: unread messages in the caller's `wake` and `digest` topics.
 * Wake items come first: every unread message in a `wake` topic, and any
 * message in a `digest` topic that @mentions the caller (design §6). Digest
 * items fill the rest of the page. Each list is in seq order. The caller's
 * own messages are skipped.
 *
 * With a page limit, wake items are never pushed out by digest items. Each
 * subscription's `last_read_seq` moves only through messages actually
 * returned, so the next call continues where this one stopped. Also
 * returns the caller's stored task and administrator notices (B23). Clears
 * the pending doorbell and its debounce timer; a truncated read with wake
 * items left rings again after `inboxTruncatedRingMs` (issue #104).
 */
export const inbox: ActionDef = {
  name: "inbox",
  kind: "change",
  run(tx, input) {
    const p = asParams(input);
    const limit =
      optInt(p, "limit", 1, tx.config.inboxMaxLimit) ?? tx.config.inboxDefaultLimit;
    const me = tx.actor.handle;
    const cursorRow = tx.sql.one<{ seq: number }>(
      "SELECT seq FROM mention_cursors WHERE handle = ?",
      me,
    );
    const mentionCursor = Number(cursorRow?.seq ?? 0);
    // An index lookup on message_mentions (handle, seq); never a JSON scan.
    const mentionsMe = "EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.handle = ? AND mm.seq = m.seq)";
    // Wake items: everything unread in a `wake` topic, plus @mentions of the
    // caller not delivered before (after the mention cursor): in a `digest`
    // topic after its read mark, and in a topic the caller set `off` or never
    // subscribed to (an @mention always wakes, design §6; backlog B3).
    //
    // Every read is bounded by the page (M2 independent review M4): one
    // query per `wake` topic, each an index range on messages (topic, seq)
    // with LIMIT page + 1, and one query for the mentions, a range on the
    // caller's message_mentions (handle, seq) with LIMIT page + 1. They are
    // merged here by seq. So at most (wake topics + 1) × (page + 1) rows are
    // read, whatever the board's history; no query sorts messages in a
    // temporary table. Subscriptions are capped (`maxSubscriptionsPerUser`,
    // M2 security review), and at most that many are read here. A user past
    // the cap (subscriptions from before it) gets the ones read longest ago
    // first; only the topics read here have their read marks moved, so the
    // rest come first on the next call (`more_topics`), and nothing unread
    // is marked read.
    const subs = tx.sql.all<{ topic: string; level: string; last_read_seq: number }>(
      `SELECT topic, level, last_read_seq FROM subscriptions
       WHERE handle = ? AND level <> 'off' ORDER BY last_read_seq, topic LIMIT ?`,
      me,
      tx.config.maxSubscriptionsPerUser + 1,
    );
    const moreTopics = subs.length > tx.config.maxSubscriptionsPerUser;
    if (moreTopics) subs.pop();
    const readTopics = (level: string): string =>
      JSON.stringify(subs.filter((s) => s.level === level).map((s) => s.topic));
    const take = limit + 1;
    const wakeCandidates: MessageRow[] = [];
    for (const sub of subs) {
      if (sub.level !== "wake") continue;
      wakeCandidates.push(
        ...tx.sql.all<MessageRow>(
          `SELECT * FROM messages
           WHERE topic = ? AND seq > ? AND author <> ?
           ORDER BY seq
           LIMIT ?`,
          sub.topic,
          Number(sub.last_read_seq),
          me,
          take,
        ),
      );
    }
    // Mentions outside `wake` topics: `digest` after the read mark, `off`
    // or unsubscribed. This query does not depend on which subscriptions
    // were read above: it is a range on the caller's message_mentions with
    // its own page, so the mention cursor below never passes a mention it
    // did not return (a `wake` topic's mentions come with that topic). Rows skipped by the filter are mentions of the caller
    // in `wake` topics or already read: few, and the cursor passes them at
    // this inbox.
    wakeCandidates.push(
      ...tx.sql.all<MessageRow>(
        `SELECT m.*
         FROM message_mentions mm
         JOIN messages m ON m.seq = mm.seq
         LEFT JOIN subscriptions s ON s.topic = m.topic AND s.handle = ?
         WHERE mm.handle = ? AND mm.seq > ? AND m.author <> ?
           AND (s.level IS NULL OR s.level = 'off'
                OR (s.level = 'digest' AND m.seq > s.last_read_seq))
         ORDER BY mm.seq
         LIMIT ?`,
        me,
        me,
        mentionCursor,
        me,
        take,
      ),
    );
    const wakeRows = wakeCandidates.sort((x, y) => Number(x.seq) - Number(y.seq)).slice(0, take);
    // Each list returns up to its page size plus one look-ahead row: the
    // first item not returned. Every item of the same list before it was
    // returned, across all topics, because seq is one counter for the board.
    const wakePage = wakeRows.slice(0, limit);
    const wakeStop = wakeRows[limit];
    const room = limit - wakePage.length;
    // Digest items, per `digest` topic the same way (bounded by topics × page).
    const digestCandidates: MessageRow[] = [];
    for (const sub of subs) {
      if (sub.level !== "digest") continue;
      digestCandidates.push(
        ...tx.sql.all<MessageRow>(
          `SELECT m.* FROM messages m
           WHERE m.topic = ? AND m.seq > ? AND m.author <> ? AND NOT ${mentionsMe}
           ORDER BY m.seq
           LIMIT ?`,
          sub.topic,
          Number(sub.last_read_seq),
          me,
          me,
          room + 1,
        ),
      );
    }
    const digestRows = digestCandidates.sort((x, y) => Number(x.seq) - Number(y.seq)).slice(0, room + 1);
    const digestPage = digestRows.slice(0, room);
    const digestStop = digestRows[room];

    const maxRow = tx.sql.one<{ m: number | null }>("SELECT MAX(seq) AS m FROM messages");
    const max = Number(maxRow?.m ?? 0);
    const wakeThrough = wakeStop ? Number(wakeStop.seq) - 1 : max;
    const digestThrough = Math.min(
      wakeThrough,
      digestStop ? Number(digestStop.seq) - 1 : max,
    );
    // A `wake` topic holds only wake items. A `digest` topic's read mark
    // moves only through its digest items; its mentions are tracked by the
    // mention cursor, so they are neither repeated nor skipped.
    // Only the topics read above (M2 security review, second round).
    tx.sql.exec(
      `UPDATE subscriptions SET last_read_seq = ?
       WHERE handle = ? AND level = 'wake' AND last_read_seq < ?
         AND topic IN (SELECT value FROM json_each(?))`,
      wakeThrough,
      me,
      wakeThrough,
      readTopics("wake"),
    );
    tx.sql.exec(
      `UPDATE subscriptions SET last_read_seq = ?
       WHERE handle = ? AND level = 'digest' AND last_read_seq < ?
         AND topic IN (SELECT value FROM json_each(?))`,
      digestThrough,
      me,
      digestThrough,
      readTopics("digest"),
    );
    if (wakeThrough > mentionCursor) {
      tx.sql.exec(
        `INSERT INTO mention_cursors (handle, seq) VALUES (?, ?)
         ON CONFLICT (handle) DO UPDATE SET seq = excluded.seq`,
        me,
        wakeThrough,
      );
    }
    // Stored task and administrator notices (B23), oldest first, removed
    // once returned. Their own page of the same size.
    const noticeRows = tx.sql.all<NoticeRow>(
      "SELECT id, kind, reason, wake, detail, created_at FROM notices WHERE handle = ? ORDER BY id LIMIT ?",
      me,
      limit + 1,
    );
    const noticePage = noticeRows.slice(0, limit);
    const lastNotice = noticePage.at(-1);
    if (lastNotice) {
      tx.sql.exec("DELETE FROM notices WHERE handle = ? AND id <= ?", me, Number(lastNotice.id));
    }
    // Notices the per-user cap dropped since the last call (M2 security review).
    const drops = tx.sql.all<{ n: number }>("DELETE FROM notice_drops WHERE handle = ? RETURNING n", me);
    const droppedNotices = Number(drops[0]?.n ?? 0);
    const cleared = tx.sql.all<{ handle: string }>(
      "DELETE FROM doorbells WHERE handle = ? RETURNING handle",
      me,
    );
    tx.sql.exec("DELETE FROM timers WHERE kind = 'doorbell' AND ref = ?", me);
    const truncated =
      wakeStop !== undefined || digestStop !== undefined || noticeRows.length > limit || moreTopics;
    // A truncated read must not leave the unread rest without a ring (issue
    // #104). Ring again only for what rings: wake items not returned, or a
    // stored notice that rang (`wake = 1`) still waiting. A rest of digest
    // items or quiet notices only is not rung early, and a `moreTopics` rest
    // alone is not either (the cap stays true however little is unread, so it
    // would ring without end). Each such read returned at least one item, so
    // repeated reads drain the inbox and the last one clears the bell.
    const wakeRest =
      wakeStop !== undefined ||
      tx.sql.one("SELECT 1 AS x FROM notices WHERE handle = ? AND wake = 1 LIMIT 1", me) !== undefined;
    const rearmed = truncated && wakeRest && rearmDoorbell(tx, me, tx.config.inboxTruncatedRingMs);
    return {
      value: {
        wake: wakePage.map(wrapMessage),
        digest: digestPage.map(wrapMessage),
        notices: noticePage.map(noticeValue),
        dropped_notices: droppedNotices,
        truncated,
        ...(moreTopics ? { more_topics: true } : {}),
        wake_through_seq: wakeThrough,
        digest_through_seq: digestThrough,
      },
      audit: {
        targetType: "user",
        targetId: me,
        detail: {
          wake: wakePage.length,
          digest: digestPage.length,
          notices: noticePage.length,
          dropped_notices: droppedNotices,
          truncated,
          ...(moreTopics ? { more_topics: true } : {}),
          wake_through_seq: wakeThrough,
          digest_through_seq: digestThrough,
          doorbell_cleared: cleared.length > 0,
          ...(rearmed ? { doorbell_rearmed: true } : {}),
        },
      },
    };
  },
};
