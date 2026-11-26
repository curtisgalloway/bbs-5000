// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Topic cold storage (design §14): the store interface, an in-memory store
 * for tests, the async export loop the Board DO's alarm runs, and the async
 * `bbs_topic_unarchive` path that restores a cold topic. Like the audit
 * export (M6a), the store calls are async and run between synchronous,
 * audited board steps; nothing is deleted from SQLite until the store has
 * confirmed the object.
 */

import type { ColdCounts } from "./cold-object.ts";
import { callTool, findTool, takeSessionArg, toToolResult, type Surface, type ToolResult } from "./tools.ts";
import type { ActResult, CallContext } from "./types.ts";
import type { Board } from "./act.ts";

/**
 * Where cold objects go. The Worker implements it over an R2 binding
 * (`packages/worker/src/r2-cold-store.ts`).
 */
export interface ColdStore {
  /**
   * Store `body` at `key`, which the store must check against `sha256`
   * (lowercase hex). Resolves `created`, or `exists` when an object with the
   * same SHA-256 is already there (an earlier attempt whose confirmation was
   * lost). Rejects on any failure, including an object of different content
   * at `key`: it is never overwritten.
   */
  put(key: string, body: string, sha256: string): Promise<"created" | "exists">;
  /** The object's body, or null when there is none. */
  get(key: string): Promise<string | null>;
}

/** One topic's cold object, built by `Board.beginColdExport`. */
export interface ColdJob {
  topic: string;
  key: string;
  body: string;
  sha256: string;
  bytes: number;
  counts: ColdCounts;
}

/** The board steps the export loop uses (implemented by `Board`). */
export interface ColdExporter {
  beginColdExport(): ColdJob | null;
  confirmColdExport(job: Pick<ColdJob, "topic" | "key" | "sha256">, outcome: "created" | "exists"): ActResult;
  failColdExport(job: Pick<ColdJob, "topic" | "key">, error: string, conflict?: boolean): ActResult;
}

/**
 * Thrown by a store when an object of other content is already at the key:
 * it is never overwritten, and retrying cannot help.
 */
export class ColdConflictError extends Error {
  constructor(key: string) {
    super(`an object with other content exists at ${key}; not overwritten`);
    this.name = "ColdConflictError";
  }
}

/** Most topics one alarm run exports; the rest wait for the next alarm. */
export const MAX_COLD_PER_RUN = 5;

export interface ColdRun {
  done: string[];
  failed: { topic: string; error: string }[];
}

/**
 * Export due archived topics: build (read only), write, then confirm (the
 * audited delete) or record the failure (audited; rows stay, retried after
 * `coldRetryMs`).
 */
export async function exportColdTopics(
  board: ColdExporter,
  store: ColdStore,
  max = MAX_COLD_PER_RUN,
): Promise<ColdRun> {
  const run: ColdRun = { done: [], failed: [] };
  for (let i = 0; i < max; i++) {
    let job: ColdJob | null = board.beginColdExport();
    if (!job) break;
    const { topic, key, sha256 } = job;
    let outcome: "created" | "exists";
    try {
      const write = store.put(key, job.body, sha256);
      // Drop this function's reference to the body while the store holds it.
      job = null;
      outcome = await write;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      board.failColdExport({ topic, key }, error, err instanceof ColdConflictError);
      run.failed.push({ topic, error });
      continue;
    }
    const r = board.confirmColdExport({ topic, key, sha256 }, outcome);
    if (r.ok) {
      run.done.push(topic);
    } else {
      // The re-check refused (the topic changed or was unarchived while the
      // object was written); recorded so it is not retried in a tight loop.
      board.failColdExport({ topic, key }, `confirm refused: ${r.error.message}`);
      run.failed.push({ topic, error: r.error.message });
    }
  }
  return run;
}

/**
 * `callTool`, plus the restore path: a `bbs_topic_unarchive` of a cold topic
 * by a caller who may restore it reads the object from `store` first, then
 * runs the audited `topic_restore` with it. Everything else (and every
 * caller who may not restore, or a board with no store) goes to `callTool`,
 * which refuses or answers as usual.
 */
export async function callToolWithCold(
  board: Board,
  store: ColdStore | null,
  ctx0: CallContext,
  name: string,
  args0: unknown,
  surface: Surface,
): Promise<ToolResult> {
  const { ctx, args } = takeSessionArg(ctx0, args0, surface);
  const tool = findTool(name);
  if (store && tool?.action === "topic_unarchive" && tool.surfaces.includes(surface)) {
    const target = board.coldRestoreTarget(ctx, args);
    if (target) {
      let body: string | null = null;
      let error: string | undefined;
      try {
        body = await store.get(target.key);
        if (body === null) error = `no object at ${target.key}`;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      return toToolResult(tool, board.restoreTopic(ctx, target.topic, target.key, body, error));
    }
  }
  return callTool(board, ctx, name, args, surface);
}

/** A `ColdStore` in memory (tests). `failNext` makes the next calls reject. */
export class MemoryColdStore implements ColdStore {
  readonly objects = new Map<string, { body: string; sha256: string }>();
  failPuts = 0;
  failGets = 0;
  readonly #sha256: (s: string) => string;

  constructor(sha256: (s: string) => string) {
    this.#sha256 = sha256;
  }

  async put(key: string, body: string, sha256: string): Promise<"created" | "exists"> {
    if (this.failPuts > 0) {
      this.failPuts -= 1;
      throw new Error("store unavailable");
    }
    if (this.#sha256(body) !== sha256) throw new Error("SHA-256 does not match the body");
    const have = this.objects.get(key);
    if (have) {
      if (have.sha256 === sha256) return "exists";
      throw new ColdConflictError(key);
    }
    this.objects.set(key, { body, sha256 });
    return "created";
  }

  async get(key: string): Promise<string | null> {
    if (this.failGets > 0) {
      this.failGets -= 1;
      throw new Error("store unavailable");
    }
    return this.objects.get(key)?.body ?? null;
  }
}
