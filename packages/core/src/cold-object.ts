// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The cold object (design §14): one NDJSON object per cold topic, at
 * `topics/<name>/<archived_at>.ndjson` in the cold store (R2). Pure: builds
 * the body from SQLite and parses it back; the store and the transactions
 * are elsewhere (`cold.ts`, `actions/archive.ts`). Format in
 * docs/cold-storage.md.
 */

import type { Sql } from "./sql.ts";

export const COLD_PREFIX = "topics/";
/** The first line's `format`; a restore refuses any other. */
export const COLD_FORMAT = "bbs-5000-topic/1";

/**
 * The object key. Topic names are 1-64 letters, digits, `-` or `_`
 * (`reqTopic`), so the key needs no escaping; `archived_at` is ms since the
 * epoch, so archiving the same topic again gives a new key and nothing is
 * ever overwritten.
 */
export function coldKey(topic: string, archivedAt: number): string {
  return `${COLD_PREFIX}${topic}/${archivedAt}.ndjson`;
}

export interface ColdCounts {
  messages: number;
  tasks: number;
  comments: number;
  blocks: number;
}

export interface ColdHeader {
  type: "topic";
  format: string;
  board_id: string;
  name: string;
  description: string;
  created_by: string;
  keep: number;
  last_activity_at: number;
  archived_at: number;
  archived_by: string | null;
  archive_reason: string | null;
  counts: ColdCounts;
}

export interface ColdMessage {
  type: "message";
  seq: number;
  topic: string;
  author: string;
  author_kind: string;
  via: string;
  body: string;
  reply_to: number | null;
  mentions: string[];
  is_system: number;
  created_at: number;
}

export interface ColdTask {
  type: "task";
  id: number;
  topic: string;
  title: string;
  description: string;
  state: string;
  prior_state: string | null;
  is_stale: number;
  assignee: string | null;
  created_by: string;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ColdComment {
  type: "comment";
  id: number;
  task: number;
  author: string;
  body: string;
  state_change: string | null;
  created_at: number;
}

/** A blocker row with at least one side in the topic (the other may be elsewhere). */
export interface ColdBlock {
  type: "block";
  task: number;
  blocked_by: number;
  created_by: string;
  created_at: number;
}

export interface ColdContent {
  header: ColdHeader;
  messages: ColdMessage[];
  tasks: ColdTask[];
  comments: ColdComment[];
  blocks: ColdBlock[];
}

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** The topic's rows as they go into the cold object, in a fixed order. */
export function readColdContent(sql: Sql, topic: string): ColdContent {
  const t = sql.one<Record<string, unknown>>("SELECT * FROM topics WHERE name = ?", topic);
  if (!t) throw new Error(`no topic ${topic}`);
  const boardId = sql.one<{ value: string }>("SELECT value FROM meta WHERE key = 'board_id'")?.value ?? "";
  const messages = sql
    .all<Record<string, unknown>>("SELECT * FROM messages WHERE topic = ? ORDER BY seq", topic)
    .map(
      (m): ColdMessage => ({
        type: "message",
        seq: num(m.seq),
        topic: String(m.topic),
        author: String(m.author),
        author_kind: String(m.author_kind),
        via: String(m.via),
        body: String(m.body),
        reply_to: numOrNull(m.reply_to),
        mentions: JSON.parse(String(m.mentions ?? "[]")) as string[],
        is_system: num(m.is_system),
        created_at: num(m.created_at),
      }),
    );
  const tasks = sql
    .all<Record<string, unknown>>("SELECT * FROM tasks WHERE topic = ? ORDER BY id", topic)
    .map(
      (r): ColdTask => ({
        type: "task",
        id: num(r.id),
        topic: String(r.topic),
        title: String(r.title),
        description: String(r.description),
        state: String(r.state),
        prior_state: strOrNull(r.prior_state),
        is_stale: num(r.is_stale),
        assignee: strOrNull(r.assignee),
        created_by: String(r.created_by),
        lease_expires_at: numOrNull(r.lease_expires_at),
        created_at: num(r.created_at),
        updated_at: num(r.updated_at),
      }),
    );
  const comments = sql
    .all<Record<string, unknown>>(
      `SELECT c.* FROM task_comments c JOIN tasks t ON t.id = c.task
       WHERE t.topic = ? ORDER BY c.id`,
      topic,
    )
    .map(
      (c): ColdComment => ({
        type: "comment",
        id: num(c.id),
        task: num(c.task),
        author: String(c.author),
        body: String(c.body),
        state_change: strOrNull(c.state_change),
        created_at: num(c.created_at),
      }),
    );
  const blocks = sql
    .all<Record<string, unknown>>(
      `SELECT b.* FROM task_blocks b
       WHERE b.task IN (SELECT id FROM tasks WHERE topic = ?)
          OR b.blocked_by IN (SELECT id FROM tasks WHERE topic = ?)
       ORDER BY b.task, b.blocked_by`,
      topic,
      topic,
    )
    .map(
      (b): ColdBlock => ({
        type: "block",
        task: num(b.task),
        blocked_by: num(b.blocked_by),
        created_by: String(b.created_by),
        created_at: num(b.created_at),
      }),
    );
  const header: ColdHeader = {
    type: "topic",
    format: COLD_FORMAT,
    board_id: boardId,
    name: String(t.name),
    description: String(t.description),
    created_by: String(t.created_by),
    keep: num(t.keep),
    last_activity_at: num(t.last_activity_at),
    archived_at: num(t.archived_at),
    archived_by: strOrNull(t.archived_by),
    archive_reason: strOrNull(t.archive_reason),
    counts: { messages: messages.length, tasks: tasks.length, comments: comments.length, blocks: blocks.length },
  };
  return { header, messages, tasks, comments, blocks };
}

/** The NDJSON body: the header line, then messages, tasks, comments, blocks; each line ends in `\n`. */
export function coldBody(c: ColdContent): string {
  const lines = [c.header, ...c.messages, ...c.tasks, ...c.comments, ...c.blocks].map((r) => JSON.stringify(r));
  return lines.join("\n") + "\n";
}

/** UTF-8 length of a string, counted without making an encoded copy. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i += 1;
    } else n += 3; // BMP, or a lone surrogate (encoded as U+FFFD, 3 bytes)
  }
  return n;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function need(cond: boolean, what: string, line: number): void {
  if (!cond) throw new Error(`cold object line ${line}: ${what}`);
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isIntOrNull = (v: unknown): boolean => v === null || isInt(v);
const isStrOrNull = (v: unknown): boolean => v === null || isStr(v);

/**
 * Parse a cold object back. Checks the shape of every line and that every
 * row belongs to the header's topic; throws an `Error` naming the first bad
 * line. (The caller has already checked the body's SHA-256 against the stub.)
 */
export function parseColdBody(body: string): ColdContent {
  const lines = body.split("\n");
  if (lines.at(-1) === "") lines.pop();
  need(lines.length > 0, "empty object", 1);
  const parsed = lines.map((l, i) => {
    try {
      return JSON.parse(l) as unknown;
    } catch {
      throw new Error(`cold object line ${i + 1}: not JSON`);
    }
  });
  const h = parsed[0];
  need(isObj(h) && h.type === "topic" && h.format === COLD_FORMAT, `first line must be a ${COLD_FORMAT} header`, 1);
  const header = h as unknown as ColdHeader;
  need(isStr(header.name) && isInt(header.archived_at) && isObj(header.counts), "header fields", 1);
  const out: ColdContent = { header, messages: [], tasks: [], comments: [], blocks: [] };
  const taskIds = new Set<number>();
  parsed.slice(1).forEach((r, i) => {
    const n = i + 2;
    need(isObj(r), "not an object", n);
    const o = r as Record<string, unknown>;
    switch (o.type) {
      case "message":
        need(
          isInt(o.seq) && o.topic === header.name && isStr(o.author) && isStr(o.author_kind) && isStr(o.via) &&
            isStr(o.body) && isIntOrNull(o.reply_to) && Array.isArray(o.mentions) && o.mentions.every(isStr) &&
            isInt(o.is_system) && isInt(o.created_at),
          "message fields",
          n,
        );
        out.messages.push(o as unknown as ColdMessage);
        break;
      case "task":
        need(
          isInt(o.id) && o.topic === header.name && isStr(o.title) && isStr(o.description) && isStr(o.state) &&
            isStrOrNull(o.prior_state) && isInt(o.is_stale) && isStrOrNull(o.assignee) && isStr(o.created_by) &&
            isIntOrNull(o.lease_expires_at) && isInt(o.created_at) && isInt(o.updated_at),
          "task fields",
          n,
        );
        taskIds.add(o.id as number);
        out.tasks.push(o as unknown as ColdTask);
        break;
      case "comment":
        need(
          isInt(o.id) && isInt(o.task) && isStr(o.author) && isStr(o.body) && isStrOrNull(o.state_change) &&
            isInt(o.created_at),
          "comment fields",
          n,
        );
        out.comments.push(o as unknown as ColdComment);
        break;
      case "block":
        need(isInt(o.task) && isInt(o.blocked_by) && isStr(o.created_by) && isInt(o.created_at), "block fields", n);
        out.blocks.push(o as unknown as ColdBlock);
        break;
      default:
        need(false, `unknown type ${JSON.stringify(o.type)}`, n);
    }
  });
  for (const c of out.comments) {
    need(taskIds.has(c.task), `comment ${c.id} is on task ${c.task}, not in this topic`, 0);
  }
  for (const b of out.blocks) {
    need(taskIds.has(b.task) || taskIds.has(b.blocked_by), `block ${b.task}<-${b.blocked_by} touches no task here`, 0);
  }
  const c = header.counts;
  need(
    c.messages === out.messages.length && c.tasks === out.tasks.length && c.comments === out.comments.length &&
      c.blocks === out.blocks.length,
    "row counts differ from the header",
    1,
  );
  return out;
}
