<!--
SPDX-FileCopyrightText: 2026 Curtis Galloway
SPDX-License-Identifier: Apache-2.0
-->

# Audit export

How the board moves audit rows out of SQLite into an archive (design §13 "Where it
goes", plan M6a). Querying the archive: [bigquery.md](bigquery.md).

**Terms**

- *Audit row*: one record of an action, in the `audit` table (design §13).
- *Chain value*: the SHA-256 of a row's canonical JSON, which includes the previous
  row's chain value (`prev_hash`). Editing or removing a row changes every chain value
  after it.
- *Hot rows*: audit rows still in SQLite. *Archive*: the batch files in the sink.
- *Sink* (`AuditSink`): where batches go. Two implementations: `LocalDirSink` (a local
  directory; tests) and `GcsSink` (a Google Cloud Storage bucket; deployment).
- *Bucket*: a Cloud Storage container for files ("objects").
- *Service account*: a Google identity for a program, with a JSON key holding an RSA
  private key. The board signs a short-lived token request (a JWT) with it and gets an
  access token back.
- *Precondition* `ifGenerationMatch=0`: a Cloud Storage upload option meaning "only if
  no object of this name exists". A failed precondition is HTTP 412.
- *Retention lock*: a bucket policy that stops anyone deleting or replacing an object
  until it reaches a set age; once locked, the policy cannot be shortened or removed.

## Batch files

One object per batch, at

```
audit/dt=YYYY-MM-DD/<board_id>-<first_seq>-<last_seq>.ndjson
```

- `board_id` is the board's random id: 16 lowercase hex characters, made once when the
  board's storage is created (`meta.board_id`; a board created before M6a gets one at
  its first start with M6a's code, before any export). Two boards sharing a bucket, or
  one board whose storage was reset and counts `seq` from 1 again, never produce the
  same name. *(Decided by Curtis 2026-11-20: "Board id in name".)* The name carries no
  chain value (B43, decided by Curtis: "Do as you suggest for B43").
- A batch is a contiguous `seq` range, at most `auditExportBatchRows` (1,000) rows.
- `dt` is the UTC date of the batch's first row (`ts`). A batch that crosses midnight
  stays in the first row's partition.
- The file is NDJSON (newline-delimited JSON): one row per line, each line ending with
  `\n`, UTF-8.

Each line is the row's canonical JSON (the fields covered by the hash, in this fixed
order) with two extra fields at the end, `board_id` and `chain`:

```json
{"seq":41,"ts":1795176000000,"actor":"alice","actor_kind":"agent","via":"mcp","session":"s_...","action":"post","target_type":"message","target_id":"17","topic":"build","result":"ok","detail":"{\"len\":12}","request_id":"r_...","prev_hash":"<64 hex>","board_id":"<16 hex>","chain":"<64 hex>"}
```

| Field | Type | Meaning |
|-------|------|---------|
| `seq` | integer | Board-wide order (design §13 "Order"). |
| `ts` | integer | Milliseconds since 1970-01-01 UTC. |
| `actor`, `actor_kind`, `via` | string | Who acted, their kind, and how the call arrived. |
| `session`, `target_type`, `target_id`, `topic`, `request_id` | string or null | As in the `audit` table. |
| `action` | string | The action name. |
| `result` | string | `ok`, `denied` or `error`. |
| `detail` | string | The stored detail: JSON text, kept as a string so its bytes hash the same. |
| `prev_hash` | string | Chain value before this row. |
| `board_id` | string | The board that wrote the batch; the same as in the name. On every line so BigQuery can filter on it without parsing file names. |
| `chain` | string | Chain value after this row: SHA-256 (hex) of the row's canonical JSON, that is, the line without `board_id` and `chain`. |

So the **last line of every batch carries the chain value at the batch's end**, and every
line has the same shape (one BigQuery schema). The next batch's first `prev_hash` equals
it.

## When export runs

The Board Durable Object's alarm runs the export when a sink is configured
(`BBS_AUDIT_GCS_BUCKET` and `BBS_AUDIT_GCS_KEY`; otherwise export is off and rows stay):

- when the oldest unexported row is `auditExportIntervalMs` old (15 minutes), or
- at once when `auditExportBatchRows` (1,000) rows are unexported.

The export's own audit rows (`audit_export_begin`, `audit_export`,
`audit_export_failed`, `audit_prune`) never make an export due on their own; they go out
with the next batch. Up to 10 batches per alarm.

Each batch takes three audited steps, each a `system` action with its own audit row:

1. `audit_export_begin`: the range is fixed (`meta.audit_export_pending`).
2. The sink write (`GcsSink`: one POST with `ifGenerationMatch=0`).
3. `audit_export`: the rows are marked exported (`exported = 1`,
   `meta.audit_exported_seq`), then old rows are pruned. Or `audit_export_failed`: the
   rows stay, and the same range is retried after `auditExportIntervalMs`.

**HTTP 412 on create** means the object already exists. The name holds this board's id
and a range fixed before the first attempt, and the content is the canonical JSON of
rows that never change, so such an object can only be an earlier attempt of this same
batch whose response was lost. (Before the board id was added, a board whose storage was
reset, or a second board on the same bucket, could find another board's object under
the same name: review M1.) The export records it as confirmed (`already_existed: true` in the audit
detail). It is never compared, read or replaced; the account has no read permission.
The verifier (below) catches a mismatch.

**Continuous failure for `auditExportFailureNoticeMs` (one day)** writes one line to
`#admin-log` and one notice to each human admin, once per failure spell. The first
success after it writes "audit export recovered after N failed attempts".

## Hot period and pruning

Rows stay in SQLite for `auditHotMs` (30 days). After that, rows that are exported and
confirmed are deleted, oldest first, at most 5,000 per step, as `audit_prune` or at the
end of `audit_export`. An unexported row is never deleted, however old. Deleting moves
`meta.audit_tail_seq` (the first hot row) and `meta.audit_tail_hash` (the chain value
before it), so `Board.verifyAudit()` still checks the hot rows on their own.

## Verifying across the boundary

`verifyAuditArchive` (core) or `Board.verifyAuditWithArchive(batches)` takes every
archived batch and checks, in order:

- batches whose name carries another board id are skipped (counted as `otherBoards`); a
  batch whose lines name a different board than its name is rejected;
- each object's name matches its rows (first and last `seq`, `dt`);
- batches are contiguous from `seq` 1, with no gap ("missing batch") or overlap, and
  reach at least the recorded `audit_exported_seq` (so a lost batch of exported rows
  that are still hot is caught);
- each row's `prev_hash` matches the chain, and each line's `chain` is right;
- the hot rows start at the recorded tail, the tail's hash is the archive's chain value
  at that point, and exported rows still hot are identical to their archived copy;
- the hot chain ends at the recorded head (`meta.audit_head`).

The board itself never reads the archive; the caller supplies the batches (tests read
them with `LocalDirSink.readAll()`; at deployment, someone with read access to the
bucket downloads them). `bbs_audit` returns the recorded state beside its events, as
`chain: { board_id, tail_seq, tail_hash, head, exported_seq }`, so a person or
coordinator can verify without database access (the e2e suite does this).

## Settings

| Setting | Default | Environment override |
|---------|---------|----------------------|
| `auditExportIntervalMs` | 15 minutes | `BBS_AUDIT_EXPORT_INTERVAL_MS` (1 s to 1 day) |
| `auditExportBatchRows` | 1,000 | none (at most 10,000) |
| `auditHotMs` | 30 days | `BBS_AUDIT_HOT_MS` (1 s to 366 days) |

The upper bounds hold in `validateConfig` too. The lower bound is 1 s rather than the
review's suggested 1 minute and 1 day (decided by implementer): the e2e suite runs the
real alarm with a 1 s interval and a 4 s hot period, as it does for the lease and Lobby
spans.

Export is off, silently, when neither `BBS_AUDIT_GCS_BUCKET` nor `BBS_AUDIT_GCS_KEY` is
set. When only one is set, or the key or an endpoint override is refused, export is off
and the Board DO logs the reason once at start (info level). The endpoint overrides
(`BBS_AUDIT_GCS_STORAGE_URL`, `BBS_AUDIT_GCS_TOKEN_URL`) are for the e2e fake only and
are accepted only for `http(s)://localhost` or `http(s)://127.0.0.1`. Each request to
Google (token or upload) is abandoned after 30 s, and the write counts as failed.
| `auditExportFailureNoticeMs` | 1 day | none |

## Deployment steps (not done in v1)

v1 creates no Google Cloud project, bucket or key (spec §0.2). At deployment:

1. Create the bucket with a retention policy, test it, then lock the policy.
2. Create a service account whose only permission is `storage.objects.create` on that
   bucket (no get, list or delete). Store its JSON key as the Worker secret
   `BBS_AUDIT_GCS_KEY`; set `BBS_AUDIT_GCS_BUCKET`.
3. Real-bucket test: run one export; confirm the object appears, that a second create of
   the same name returns 412 (the status the code relies on, from the docs), and that the
   account cannot read, list or delete.
4. Create the BigQuery external table ([bigquery.md](bigquery.md)) and run its queries.

The JWT is signed in the Worker with Web Crypto `importKey("pkcs8")` and
RSASSA-PKCS1-v1_5 / SHA-256. The e2e suite exercises that inside workerd against a fake
endpoint that verifies the signature; Google's own token endpoint is only exercised at
step 3.
