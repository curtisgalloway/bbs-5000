// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only probe (e2e): runs the same checks against Durable Object SQL
 * through `DoSql` that `test/e2e/sql-probe.test.ts` runs against node:sqlite,
 * so the two can be compared. Backlog B4 (foreign keys) and B8
 * (`sqlite_master`, `json_each`, bound-parameter limit).
 */

import { DurableObject } from "cloudflare:workers";
import { migrate } from "@bbs-5000/core";
import { DoSql } from "../src/do-sql.ts";
import { sqlChecks } from "./checks.ts";

interface Env {
  PROBE: DurableObjectNamespace<SqlProbe>;
}

export class SqlProbe extends DurableObject<Env> {
  run(): Record<string, unknown> {
    const sql = new DoSql(this.ctx.storage);
    migrate(sql, Date.now());
    migrate(sql, Date.now());
    return sqlChecks(sql);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/health") {
      return Response.json({ ok: true, service: "bbs-5000-sql-probe" });
    }
    const stub = env.PROBE.get(env.PROBE.idFromName(crypto.randomUUID()));
    return Response.json(await stub.run());
  },
} satisfies ExportedHandler<Env>;
