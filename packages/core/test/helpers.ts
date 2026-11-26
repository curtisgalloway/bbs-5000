// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { Board } from "../src/act.ts";
import { NodeSqliteSql } from "../src/node-sqlite.ts";
import type { Row, Sql, SqlValue } from "../src/sql.ts";
import type { BoardConfig, CallContext, RuntimeFacts, Via } from "../src/types.ts";

export const sha256 = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");

export const ADMIN = "owner";
export const ADMIN_TOKEN = "test-human-credential";

/** A clock tests move by hand. */
export class FakeClock {
  t = Date.UTC(2026, 10, 20, 12, 0, 0);
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Deterministic random bytes: a counter, so ids and tokens are stable. */
export function counterBytes(): (n: number) => Uint8Array {
  let c = 0;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (c + i) & 0xff;
    c += 1;
    return out;
  };
}

export interface Fixture {
  board: Board;
  sql: NodeSqliteSql;
  clock: FakeClock;
  /** Tokens returned by admin_user_add, by handle. */
  tokens: Map<string, string>;
  ctx(handle: string, via?: Via): CallContext;
  addUser(handle: string, kind?: "agent" | "human"): string;
  auditRows(): Row[];
}

export function makeBoard(
  opts: {
    wrap?: (raw: NodeSqliteSql) => Sql;
    config?: Partial<BoardConfig>;
    /** Random bytes (default: a counter, so ids are stable; the board id is its first 8 bytes). */
    randomBytes?: (n: number) => Uint8Array;
    /** The shell's runtime facts (G5); omitted by default, as in a Node entry point. */
    runtime?: RuntimeFacts;
    /** The shell's build facts (`bbs_whoami`); omitted by default. */
    server?: { build?: string | undefined; commit?: string | undefined };
    /** The deploy-time approval settings (passkeys as approvers); off by default. */
    approval?: { required?: boolean; allowSynced?: boolean };
  } = {},
): Fixture {
  const raw = new NodeSqliteSql();
  const clock = new FakeClock();
  const board = new Board({
    sql: opts.wrap ? opts.wrap(raw) : raw,
    now: clock.now,
    sha256,
    randomBytes: opts.randomBytes ?? counterBytes(),
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
    ...(opts.server ? { server: opts.server } : {}),
    ...(opts.approval ? { approval: opts.approval } : {}),
  });
  const boot = board.bootstrapHuman(ADMIN, sha256(ADMIN_TOKEN));
  if (!boot.ok) throw new Error("bootstrap failed");
  const tokens = new Map<string, string>();
  const humans = new Set<string>([ADMIN]);
  // Default via fits the user's kind (B7): agents `mcp`, people `cli`.
  const ctx = (handle: string, via?: Via): CallContext => ({
    handle,
    via: via ?? (humans.has(handle) ? "cli" : "mcp"),
  });
  return {
    board,
    sql: raw,
    clock,
    tokens,
    ctx,
    addUser(handle, kind = "agent") {
      const r = board.act<{ token: string }>(ctx(ADMIN, "cli"), "admin_user_add", {
        handle,
        kind,
        harness: kind === "agent" ? "claude-code" : undefined,
      });
      if (!r.ok) throw new Error(`addUser ${handle}: ${r.error.message}`);
      if (kind === "human") humans.add(handle);
      tokens.set(handle, r.value.token);
      return r.value.token;
    },
    auditRows() {
      return raw.all("SELECT * FROM audit ORDER BY seq");
    },
  };
}

const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;
/** A statement led by a CTE (`WITH ...`) that writes. */
const CTE_WRITE_RE = /^\s*WITH\b[\s\S]*\b(INSERT|UPDATE|DELETE|REPLACE)\b/i;

export function isWrite(sql: string): boolean {
  return WRITE_RE.test(sql) || CTE_WRITE_RE.test(sql);
}

export interface RecordedStatement {
  sql: string;
  write: boolean;
  inTransaction: boolean;
  transaction: number;
}

/** A `Sql` wrapper that records every statement and whether a transaction was open. */
export class RecordingSql implements Sql {
  readonly inner: Sql;
  readonly log: RecordedStatement[] = [];
  transactions = 0;
  #open = 0;

  constructor(inner: Sql) {
    this.inner = inner;
  }

  #record(sql: string): void {
    this.log.push({
      sql,
      write: isWrite(sql),
      inTransaction: this.#open > 0,
      transaction: this.#open > 0 ? this.transactions : 0,
    });
  }

  exec(sql: string, ...params: SqlValue[]): void {
    this.#record(sql);
    this.inner.exec(sql, ...params);
  }

  one<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    this.#record(sql);
    return this.inner.one<T>(sql, ...params);
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    this.#record(sql);
    return this.inner.all<T>(sql, ...params);
  }

  transaction<T>(fn: () => T): T {
    this.transactions += 1;
    this.#open += 1;
    try {
      return this.inner.transaction(fn);
    } finally {
      this.#open -= 1;
    }
  }
}
