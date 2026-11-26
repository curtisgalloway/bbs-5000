// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

// M6b: the R2 cold store over a fake bucket (the real binding runs in the e2e
// suite under wrangler dev), and the archive span overrides.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { spansFromEnv } from "../src/env.ts";
import { ColdConflictError } from "@bbs-5000/core";
import { hex, R2ColdStore, type ColdBucket } from "../src/r2-cold-store.ts";

const sha = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");
const buf = (h: string): ArrayBuffer => new Uint8Array(Buffer.from(h, "hex")).buffer;

/**
 * A fake bucket keeping objects in memory; `reportSha`, `reportSize` and
 * `refuse` simulate R2 misbehaving; `raceWith` writes another object at the
 * key just before this put lands. Like R2, it overwrites an existing object
 * unless the put carries `onlyIf` with `If-None-Match: *` (F review N13).
 */
function fakeBucket(opts: { reportSha?: string; reportSize?: number; refuse?: boolean; raceWith?: string } = {}) {
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const conditions: (string | null)[] = [];
  const meta = (key: string, data: Uint8Array, sha256?: string) => ({
    key,
    size: data.length,
    checksums: { sha256: sha256 === undefined ? undefined : buf(sha256) },
  });
  const bucket = {
    async head(key: string) {
      calls.push(`head ${key}`);
      const d = objects.get(key);
      return d ? meta(key, d, sha(d)) : null;
    },
    async put(key: string, value: string, o?: { sha256?: string; onlyIf?: Headers }) {
      calls.push(`put ${key}`);
      conditions.push(o?.onlyIf?.get("if-none-match") ?? null);
      if (opts.refuse) return null;
      const data = new TextEncoder().encode(value);
      // R2 checks the received bytes against the given SHA-256.
      if (o?.sha256 !== undefined && o.sha256 !== sha(data)) throw new Error("bad digest");
      // If-None-Match: * — refuse (null) when something is there.
      if (opts.raceWith !== undefined) objects.set(key, new TextEncoder().encode(opts.raceWith));
      if (o?.onlyIf?.get("if-none-match") === "*" && objects.has(key)) return null;
      objects.set(key, data);
      const m = meta(key, data, opts.reportSha ?? o?.sha256);
      return opts.reportSize === undefined ? m : { ...m, size: opts.reportSize };
    },
    async get(key: string) {
      calls.push(`get ${key}`);
      const d = objects.get(key);
      return d ? { ...meta(key, d), text: async () => new TextDecoder().decode(d) } : null;
    },
  } as unknown as ColdBucket;
  return { bucket, objects, calls, conditions };
}

describe("R2ColdStore (M6b)", () => {
  it("creates the object with its SHA-256, after checking nothing is there; reads it back", async () => {
    const b = fakeBucket();
    const store = new R2ColdStore(b.bucket);
    const body = '{"type":"topic"}\nhé\n';
    expect(await store.put("topics/t/1.ndjson", body, sha(body))).toBe("created");
    expect(b.calls).toEqual(["head topics/t/1.ndjson", "put topics/t/1.ndjson"]);
    // The upload is create-only: If-None-Match: * (F review N13).
    expect(b.conditions).toEqual(["*"]);
    expect(await store.get("topics/t/1.ndjson")).toBe(body);
    expect(await store.get("topics/t/2.ndjson")).toBeNull();
  });

  it("an object already there: same SHA-256 is 'exists'; other content is never overwritten", async () => {
    const b = fakeBucket();
    const store = new R2ColdStore(b.bucket);
    await store.put("k", "a\n", sha("a\n"));
    expect(await store.put("k", "a\n", sha("a\n"))).toBe("exists");
    await expect(store.put("k", "b\n", sha("b\n"))).rejects.toBeInstanceOf(ColdConflictError);
    expect(new TextDecoder().decode(b.objects.get("k"))).toBe("a\n");
    expect(b.calls.filter((c) => c.startsWith("put"))).toHaveLength(1);
  });

  it("an object written by someone else between the check and the conditional put is not overwritten", async () => {
    const racing = fakeBucket({ raceWith: "other\n" });
    const other = new R2ColdStore(racing.bucket);
    await expect(other.put("k", "a\n", sha("a\n"))).rejects.toBeInstanceOf(ColdConflictError);
    expect(new TextDecoder().decode(racing.objects.get("k"))).toBe("other\n");
    const same = new R2ColdStore(fakeBucket({ raceWith: "a\n" }).bucket);
    expect(await same.put("k", "a\n", sha("a\n"))).toBe("exists");
  });

  it("a refused write, or R2 reporting another SHA-256, is not a confirmation", async () => {
    await expect(new R2ColdStore(fakeBucket({ refuse: true }).bucket).put("k", "a\n", sha("a\n"))).rejects.toThrow(/refused/);
    await expect(new R2ColdStore(fakeBucket({ reportSha: sha("x") }).bucket).put("k", "a\n", sha("a\n"))).rejects.toThrow(
      /expected 2/,
    );
    // Right SHA-256 but the wrong size (F review N14).
    await expect(new R2ColdStore(fakeBucket({ reportSize: 3 }).bucket).put("k", "a\n", sha("a\n"))).rejects.toThrow(
      /R2 reported 3 bytes/,
    );
  });

  it("hex", () => {
    expect(hex(new Uint8Array([0, 15, 255]).buffer)).toBe("000fff");
  });
});

describe("archive span overrides (M6b)", () => {
  it("maps the archive and cold spans; idle, notice and cold age may exceed 7 days", () => {
    expect(
      spansFromEnv({
        BBS_ARCHIVE_IDLE_MS: String(30 * 86_400_000),
        BBS_ARCHIVE_NOTICE_MS: "2000",
        BBS_ARCHIVE_SCAN_MS: "1000",
        BBS_COLD_AFTER_MS: String(90 * 86_400_000),
        BBS_COLD_RETRY_MS: "1000",
      }),
    ).toEqual({
      config: {
        archiveIdleMs: 30 * 86_400_000,
        archiveNoticeMs: 2000,
        archiveScanIntervalMs: 1000,
        coldAfterMs: 90 * 86_400_000,
        coldRetryMs: 1000,
      },
      ignored: [],
    });
    expect(spansFromEnv({ BBS_ARCHIVE_SCAN_MS: String(8 * 86_400_000), BBS_COLD_AFTER_MS: "999" }).ignored).toEqual([
      "BBS_ARCHIVE_SCAN_MS",
      "BBS_COLD_AFTER_MS",
    ]);
  });
});
