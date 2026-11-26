// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * A fake Google Cloud Storage endpoint for the e2e suite (M6a, decided by
 * orchestrator 2026-11-20): the Worker under `wrangler dev` has no
 * filesystem, so its `GcsSink` talks to this server, which stores objects
 * with `LocalDirSink` in the run's temporary directory.
 *
 * It implements only what the sink may use, and checks it:
 * - `POST /token`: a service-account JWT (RS256, verified with the public
 *   half of a key generated for this run), grant type jwt-bearer, `aud` this
 *   endpoint, `scope` devstorage.read_write, lifetime at most one hour.
 * - `POST /upload/storage/v1/b/<bucket>/o?uploadType=media&name=...` with a
 *   bearer token it issued and `ifGenerationMatch=0` (else 400): 200 when
 *   created, 412 when the object exists. `failUploads` makes the next N
 *   uploads answer 503.
 * Anything else answers 405 and is recorded in `violations`.
 *
 * The service-account key is generated per run and written only to the
 * run's env file (a temporary directory, mode 0600); never committed.
 */

import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { LocalDirSink } from "../../packages/core/src/local-dir-sink.ts";

export const FAKE_BUCKET = "bbs-audit-e2e";
const SCOPE = "https://www.googleapis.com/auth/devstorage.read_write";

export interface FakeGcs {
  url: string;
  bucket: string;
  /** The service-account JSON key the Worker gets (test-only, generated now). */
  keyJson: string;
  sink: LocalDirSink;
  /** Every upload request: its query and the status answered. */
  uploads: { name: string | null; ifGenerationMatch: string | null; uploadType: string | null; status: number }[];
  tokensIssued: number;
  violations: string[];
  failUploads: number;
  stop(): Promise<void>;
}

export async function startFakeGcs(dir: string): Promise<FakeGcs> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const clientEmail = "audit-writer@fake-project.iam.gserviceaccount.com";
  const tokens = new Set<string>();
  const sink = new LocalDirSink(dir);
  let url = "";

  const fake: FakeGcs = {
    url: "",
    bucket: FAKE_BUCKET,
    keyJson: JSON.stringify({
      type: "service_account",
      project_id: "fake-project",
      private_key: privateKey,
      client_email: clientEmail,
    }),
    sink,
    uploads: [],
    tokensIssued: 0,
    violations: [],
    failUploads: 0,
    stop: async () => {},
  };

  const send = (res: ServerResponse, status: number, json: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  };

  const token = (body: string, res: ServerResponse): void => {
    const form = new URLSearchParams(body);
    const fail = (why: string) => send(res, 400, { error: "invalid_grant", error_description: why });
    if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return fail("grant_type");
    const parts = (form.get("assertion") ?? "").split(".");
    if (parts.length !== 3) return fail("assertion");
    const [h, c, s] = parts as [string, string, string];
    const dec = (x: string) => JSON.parse(Buffer.from(x, "base64url").toString("utf8"));
    const header = dec(h);
    const claims = dec(c);
    const signed = verify("RSA-SHA256", Buffer.from(`${h}.${c}`), createPublicKey(publicKey), Buffer.from(s, "base64url"));
    if (header.alg !== "RS256" || !signed) return fail("signature");
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== clientEmail || claims.aud !== `${url}/token` || claims.scope !== SCOPE) return fail("claims");
    if (!(claims.exp > now && claims.exp - claims.iat <= 3600 && claims.iat <= now + 60)) return fail("lifetime");
    const at = `fake-at-${randomBytes(16).toString("hex")}`;
    tokens.add(at);
    fake.tokensIssued += 1;
    send(res, 200, { access_token: at, expires_in: 3600, token_type: "Bearer" });
  };

  const upload = async (req: IncomingMessage, u: URL, body: string, res: ServerResponse): Promise<void> => {
    const q = u.searchParams;
    const record = (status: number) =>
      fake.uploads.push({
        name: q.get("name"),
        ifGenerationMatch: q.get("ifGenerationMatch"),
        uploadType: q.get("uploadType"),
        status,
      });
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !tokens.has(auth.slice(7))) {
      record(401);
      return send(res, 401, { error: { code: 401, errors: [{ reason: "authError" }] } });
    }
    if (q.get("uploadType") !== "media" || q.get("ifGenerationMatch") !== "0" || !q.get("name")) {
      fake.violations.push(`upload without media/ifGenerationMatch=0/name: ${u.search}`);
      record(400);
      return send(res, 400, { error: { code: 400, errors: [{ reason: "required" }] } });
    }
    if (fake.failUploads > 0) {
      fake.failUploads -= 1;
      record(503);
      return send(res, 503, { error: { code: 503, errors: [{ reason: "backendError" }] } });
    }
    const outcome = await sink.create(q.get("name")!, body);
    if (outcome === "exists") {
      record(412);
      return send(res, 412, { error: { code: 412, errors: [{ reason: "conditionNotMet" }] } });
    }
    record(200);
    send(res, 200, { kind: "storage#object", bucket: FAKE_BUCKET, name: q.get("name"), generation: "1" });
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const u = new URL(req.url ?? "/", url);
      const handle = async () => {
        if (req.method === "POST" && u.pathname === "/token") return token(body, res);
        if (req.method === "POST" && u.pathname === `/upload/storage/v1/b/${FAKE_BUCKET}/o`) {
          return upload(req, u, body, res);
        }
        fake.violations.push(`${req.method} ${u.pathname}${u.search}`);
        send(res, 405, { error: { code: 405 } });
      };
      handle().catch((err: unknown) => send(res, 500, { error: String(err) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("fake GCS has no port");
  url = `http://127.0.0.1:${addr.port}`;
  fake.url = url;
  fake.stop = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return fake;
}
