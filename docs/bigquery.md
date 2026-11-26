<!--
SPDX-FileCopyrightText: 2026 Curtis Galloway
SPDX-License-Identifier: Apache-2.0
-->

# Querying the audit archive in BigQuery

> **UNTESTED.** Nothing on this page has been run. v1 creates no Google Cloud project,
> bucket or table (spec §0.2), so the DDL and queries below were written from Google's
> documentation (read 2026-11-20) and checked only by eye. Run them for the first time
> at the deployment step ([audit-export.md](audit-export.md#deployment-steps-not-done-in-v1)),
> and correct this page from what happens.

**Terms**

- *BigQuery*: Google's SQL data warehouse. Queries are billed by bytes read.
- *External table*: a BigQuery table whose data stays in Cloud Storage; BigQuery reads
  the files in place at query time. No load job, no second copy (design §13).
- *Hive partitioning*: a folder layout where a path segment `key=value` (here
  `dt=2026-11-20`) becomes a column. A filter on that column skips whole folders.
- *NDJSON*: newline-delimited JSON, one object per line. BigQuery calls the format
  `NEWLINE_DELIMITED_JSON`.
- *Batch file*: one archive object, `audit/dt=YYYY-MM-DD/<board_id>-<first_seq>-<last_seq>.ndjson`;
  line format in [audit-export.md](audit-export.md#batch-files).

Replace `PROJECT`, `DATASET`, `BUCKET` and `BOARD_ID` with the real values (`bbs_audit`
returns the board id as `chain.board_id`).

## Table

```sql
CREATE EXTERNAL TABLE `PROJECT.DATASET.bbs_audit`
(
  seq INT64,
  ts INT64,            -- milliseconds since 1970-01-01 UTC
  actor STRING,
  actor_kind STRING,
  via STRING,
  session STRING,
  action STRING,
  target_type STRING,
  target_id STRING,
  topic STRING,
  result STRING,       -- ok | denied | error
  detail STRING,       -- JSON text; read fields with JSON_VALUE(detail, '$.field')
  request_id STRING,
  prev_hash STRING,
  board_id STRING,     -- the board that wrote the row (16 hex characters)
  chain STRING
)
WITH PARTITION COLUMNS (dt DATE)
OPTIONS (
  format = 'NEWLINE_DELIMITED_JSON',
  uris = ['gs://BUCKET/audit/*'],
  hive_partition_uri_prefix = 'gs://BUCKET/audit',
  require_hive_partition_filter = true
);
```

Notes:

- `format`: the DDL reference lists "NEWLINE_DELIMITED_JSON (or JSON)" for
  `CREATE EXTERNAL TABLE`; this page uses the long name (backlog B14).
- `dt` is the UTC date of each batch's **first** row, so a batch that crosses midnight
  holds a few rows of the next day under the earlier `dt`. Filter on `dt` to limit the
  bytes read, and on `ts` for exact times: widen the `dt` range by a day on the early
  side.
- `require_hive_partition_filter = true` makes every query name a `dt` range, so a
  query never scans the whole archive by accident.
- `board_id` is a column on every line (decided by implementer, rather than parsing
  `_FILE_NAME`): a bucket shared by several boards, or a board whose storage was reset,
  holds rows with the same `seq` from different boards. Filter on `board_id` when that
  can happen; the queries below assume one board and say where to add it.
- Reading needs `storage.objects.get` and `storage.objects.list` on the bucket for the
  person or account running the query, not for the board's writer account (which can
  only create).
- Not checked: whether an external table over a bucket with a locked retention policy
  needs any extra setup (design §13 "Not checked"). The lock restricts delete and
  replace, not read, so none is expected.

## Example queries

### 1. Everything one actor did in a week

```sql
SELECT
  seq,
  TIMESTAMP_MILLIS(ts) AS at,
  action,
  result,
  via,
  topic,
  target_type,
  target_id
FROM `PROJECT.DATASET.bbs_audit`
WHERE dt BETWEEN '2026-11-16' AND '2026-11-22'
  -- AND board_id = 'BOARD_ID'   -- when the bucket holds more than one board
  AND actor = 'alice'
ORDER BY seq;
```

### 2. The history of one task

```sql
SELECT
  seq,
  TIMESTAMP_MILLIS(ts) AS at,
  actor,
  action,
  result,
  JSON_VALUE(detail, '$.from') AS from_state,
  JSON_VALUE(detail, '$.to') AS to_state,
  detail
FROM `PROJECT.DATASET.bbs_audit`
WHERE dt BETWEEN '2026-11-01' AND '2026-11-30'
  -- AND board_id = 'BOARD_ID'   -- when the bucket holds more than one board
  AND target_type = 'task'
  AND target_id = '42'
ORDER BY seq;
```

### 3. Failed wakes per agent

An agent's adapter reports each doorbell it rang as one `ring_result` audit row (actor:
the agent; `detail.result`: `turn_started`, `held_busy` or `failed`; `detail.confirmed`:
whether a hook saw the turn start). A doorbell covers several topics at once, so these
rows carry no topic: count them per agent. (M2 fixed the names; backlog B42.)

```sql
SELECT
  actor,
  COUNT(*) AS failed_wakes,
  MIN(TIMESTAMP_MILLIS(ts)) AS first_seen,
  MAX(TIMESTAMP_MILLIS(ts)) AS last_seen
FROM `PROJECT.DATASET.bbs_audit`
WHERE dt BETWEEN '2026-11-01' AND '2026-11-30'
  -- AND board_id = 'BOARD_ID'   -- when the bucket holds more than one board
  AND action = 'ring_result'
  AND JSON_VALUE(detail, '$.result') = 'failed'
GROUP BY actor
ORDER BY failed_wakes DESC;
```

Rings the board could not even send (no open adapter socket) are `ring_undeliverable`
rows (actor `system`, `detail.handle` the agent).

## Gap and duplicate checks (optional)

For one board, every `seq` from 1 upward should be present exactly once. These scan
every partition (`dt >= '2000-01-01'` satisfies the partition filter), so a gap that
spans a year boundary or a batch filed under the previous day is not missed. The full
chain check (hashes) is `verifyAuditArchive` in `packages/core`.

Gaps (a run of missing `seq`, and a missing start):

```sql
WITH s AS (
  SELECT DISTINCT seq
  FROM `PROJECT.DATASET.bbs_audit`
  WHERE dt >= '2000-01-01' AND board_id = 'BOARD_ID'
)
SELECT prev_seq + 1 AS missing_from, seq - 1 AS missing_to
FROM (SELECT seq, LAG(seq, 1, 0) OVER (ORDER BY seq) AS prev_seq FROM s)
WHERE seq > prev_seq + 1;
```

Duplicates (the same `seq` in more than one line, for example overlapping batches):

```sql
SELECT seq, COUNT(*) AS copies, ARRAY_AGG(DISTINCT _FILE_NAME) AS files
FROM `PROJECT.DATASET.bbs_audit`
WHERE dt >= '2000-01-01' AND board_id = 'BOARD_ID'
GROUP BY seq
HAVING COUNT(*) > 1;
```
