// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * The cold store (design §14) over an R2 binding. Under `wrangler dev` the
 * binding is R2 simulated on local disk (spec §0.2: no cloud resources).
 *
 * `put` never overwrites: it looks first, and an object already at the key is
 * accepted only when its SHA-256 matches (an earlier attempt whose
 * confirmation was lost); otherwise it throws `ColdConflictError`. The upload
 * is also conditional, `If-None-Match: *` passed as `onlyIf` headers: R2's
 * Workers API reference (https://developers.cloudflare.com/r2/api/workers/workers-api-reference/,
 * read 2026-11-20) says `onlyIf` accepts conditional Headers ("All
 * conditional headers aside from If-Range are supported") and that a failed
 * precondition makes `put()` return null and store nothing; it documents no
 * create-only `R2Conditional` field. So a write racing another lands at most
 * once. The upload carries the SHA-256, which R2 uses to check the received
 * object, and the object R2 returns must report the same SHA-256 and size
 * before the write counts as confirmed. Only then does `core` delete the
 * topic's rows. The body is passed as the string (no encoded copy).
 */

import { ColdConflictError, utf8Bytes, type ColdStore } from "@bbs-5000/core";

/** Lowercase hex of an ArrayBuffer. */
export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What this store reads of an R2 object's metadata. */
interface ColdObjectMeta {
  size: number;
  checksums: { sha256?: ArrayBuffer };
}

/**
 * The part of the R2 binding this store uses (structurally a subset of
 * `R2Bucket`, so tests can pass a fake and Node type-checks it).
 */
export interface ColdBucket {
  head(key: string): Promise<ColdObjectMeta | null>;
  put(
    key: string,
    value: string,
    options: { sha256: string; httpMetadata: { contentType: string }; onlyIf: Headers },
  ): Promise<ColdObjectMeta | null>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export class R2ColdStore implements ColdStore {
  readonly #bucket: ColdBucket;

  constructor(bucket: ColdBucket) {
    this.#bucket = bucket;
  }

  async put(key: string, body: string, sha256: string): Promise<"created" | "exists"> {
    const already = async (): Promise<"exists" | undefined> => {
      const existing = await this.#bucket.head(key);
      if (!existing) return undefined;
      const have = existing.checksums.sha256 ? hex(existing.checksums.sha256) : undefined;
      if (have === sha256) return "exists";
      throw new ColdConflictError(key);
    };
    if ((await already()) === "exists") return "exists";
    const bytes = utf8Bytes(body);
    const obj = await this.#bucket.put(key, body, {
      sha256,
      httpMetadata: { contentType: "application/x-ndjson" },
      onlyIf: new Headers({ "if-none-match": "*" }),
    });
    if (!obj) {
      // The precondition failed: something appeared at the key meanwhile.
      if ((await already()) === "exists") return "exists";
      throw new Error(`R2 refused the write of ${key}`);
    }
    const got = obj.checksums.sha256 ? hex(obj.checksums.sha256) : undefined;
    if (got !== sha256 || obj.size !== bytes) {
      throw new Error(`R2 reported ${obj.size} bytes, SHA-256 ${got ?? "none"} for ${key}; expected ${bytes}, ${sha256}`);
    }
    return "created";
  }

  async get(key: string): Promise<string | null> {
    const obj = await this.#bucket.get(key);
    return obj ? await obj.text() : null;
  }
}
