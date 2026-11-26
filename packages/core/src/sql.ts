// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The small synchronous SQL handle `core` runs on (plan decision P1).
 *
 * Two implementations: Node's built-in `node:sqlite` for unit tests
 * (`node-sqlite.ts`), and the Durable Object's `ctx.storage.sql` with
 * `transactionSync` (M1b, in `packages/worker`).
 *
 * Every statement is parameterized with `?` placeholders. Callers never
 * interpolate values into SQL text.
 */

export type SqlValue = string | number | bigint | null | Uint8Array;

export type Row = Record<string, SqlValue>;

export interface Sql {
  /** Run one statement and discard any rows. */
  exec(sql: string, ...params: SqlValue[]): void;
  /** Run one statement and return its first row, or undefined. */
  one<T = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  /** Run one statement and return every row. */
  all<T = Row>(sql: string, ...params: SqlValue[]): T[];
  /**
   * Run `fn` in a transaction: commit when it returns, roll back when it
   * throws. Nesting is not supported; an implementation throws if called
   * while a transaction is open.
   */
  transaction<T>(fn: () => T): T;
}
