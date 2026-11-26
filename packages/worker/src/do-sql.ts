// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * `core`'s `Sql` (plan P1) over a Durable Object's SQLite storage:
 * `ctx.storage.sql.exec` for statements and `ctx.storage.transactionSync`
 * for transactions (I0 row 1: `exec` cannot run `BEGIN` or `SAVEPOINT`).
 *
 * Typed against a small structural interface rather than the Workers types,
 * so the adapter can be unit-tested under Node with a stand-in storage.
 */

import type { Row, Sql, SqlValue } from "@bbs-5000/core";

/** The values the DO SQL API binds and returns (`SqlStorageValue`). */
export type DoSqlValue = ArrayBuffer | string | number | null;

/** The parts of `DurableObjectStorage` this adapter uses. */
export interface DoStorageLike {
  sql: {
    exec(query: string, ...bindings: DoSqlValue[]): { toArray(): Record<string, unknown>[] };
  };
  transactionSync<T>(closure: () => T): T;
}

/** Convert one of `core`'s parameter values to a DO SQL binding. */
export function toBinding(v: SqlValue): DoSqlValue {
  if (typeof v === "bigint") {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError("bigint parameter outside the safe integer range");
    }
    return Number(v);
  }
  if (v instanceof Uint8Array) {
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  }
  return v;
}

export class DoSql implements Sql {
  readonly #storage: DoStorageLike;
  #inTransaction = false;

  constructor(storage: DoStorageLike) {
    this.#storage = storage;
  }

  #run(sql: string, params: SqlValue[]): Record<string, unknown>[] {
    // Always drain the cursor so the statement runs to completion.
    return this.#storage.sql.exec(sql, ...params.map(toBinding)).toArray();
  }

  exec(sql: string, ...params: SqlValue[]): void {
    this.#run(sql, params);
  }

  one<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#run(sql, params)[0] as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.#run(sql, params) as T[];
  }

  transaction<T>(fn: () => T): T {
    if (this.#inTransaction) {
      throw new Error("nested transactions are not supported");
    }
    this.#inTransaction = true;
    try {
      return this.#storage.transactionSync(fn);
    } finally {
      this.#inTransaction = false;
    }
  }
}
