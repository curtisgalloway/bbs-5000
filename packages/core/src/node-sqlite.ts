// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * `Sql` over Node's built-in `node:sqlite` (Node 22.13 or later, no flag).
 * Used by unit tests; kept out of the package's main entry point so the
 * Worker bundle never imports `node:sqlite`.
 */

import { DatabaseSync } from "node:sqlite";
import type { Row, Sql, SqlValue } from "./sql.ts";

/**
 * Durable Object SQL binds at most 100 parameters per statement (measured
 * under wrangler dev in M1b: 101 fails with "too many SQL variables").
 * node:sqlite allows far more, so the test handle enforces the same limit
 * to keep the two in step (backlog B8).
 */
export const MAX_BOUND_PARAMETERS = 100;

function checkParams(params: SqlValue[]): void {
  if (params.length > MAX_BOUND_PARAMETERS) {
    throw new Error(
      `too many SQL variables: ${params.length} (Durable Object SQL allows ${MAX_BOUND_PARAMETERS})`,
    );
  }
}

export class NodeSqliteSql implements Sql {
  readonly db: DatabaseSync;
  #inTransaction = false;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  exec(sql: string, ...params: SqlValue[]): void {
    checkParams(params);
    this.db.prepare(sql).run(...params);
  }

  one<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    checkParams(params);
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    checkParams(params);
    return this.db.prepare(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T): T {
    if (this.#inTransaction) {
      throw new Error("nested transactions are not supported");
    }
    this.#inTransaction = true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.#inTransaction = false;
    }
  }

  close(): void {
    this.db.close();
  }
}
