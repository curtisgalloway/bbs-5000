// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * `LocalDirSink`: audit batches as files under a local directory (design
 * §13; spec §5 M6 "used by all tests"). Node only, so it is a separate entry
 * point (`@bbs-5000/core/local-dir-sink`) like `node-sqlite.ts`; the Worker
 * has no filesystem and uses `GcsSink`.
 *
 * Create-only like the bucket: each object is written to a temporary file,
 * flushed to disk (`fsync`), and then hard-linked to its name, which fails
 * if the name exists. So an object never appears partly written and is never
 * replaced. (The directory entry itself is not fsynced: after a power loss
 * the name may be missing, and the export writes it again.) `readAll` is for
 * tests and the verifier; the sink interface itself has no read.
 */

import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { AUDIT_PREFIX, type AuditSink } from "./audit-export.ts";

const SAFE_PATH = /^audit\/dt=\d{4}-\d{2}-\d{2}\/[0-9a-f]{16}-\d+-\d+\.ndjson$/;

export class LocalDirSink implements AuditSink {
  readonly dir: string;
  #tmp = 0;

  constructor(dir: string) {
    this.dir = dir;
  }

  async create(path: string, body: string): Promise<"created" | "exists"> {
    if (!SAFE_PATH.test(path)) throw new Error(`not an audit batch path: ${path}`);
    const target = join(this.dir, path);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${this.#tmp++}`;
    const fd = openSync(tmp, "wx");
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, target);
      return "created";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw err;
    } finally {
      unlinkSync(tmp);
    }
  }

  /** Every batch object under `audit/`, as `{ path, body }`. */
  readAll(): { path: string; body: string }[] {
    const root = join(this.dir, AUDIT_PREFIX);
    const out: { path: string; body: string }[] = [];
    const walk = (d: string): void => {
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ndjson")) {
          out.push({ path: relative(this.dir, p).split(sep).join("/"), body: readFileSync(p, "utf8") });
        }
      }
    };
    walk(root);
    // Numeric order, so 2-... sorts before 10-...
    return out.sort((a, b) => a.path.localeCompare(b.path, "en", { numeric: true }));
  }
}
