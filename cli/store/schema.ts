/**
 * DDL of the device-local history database (design decisions 3 and 8).
 *
 * `sync_operations` is the append-only operation log. Its columns carry the
 * operation kind, the finish timestamp, the root and manifest CIDs, the
 * per-kind counts, the duration, the conflict sha256 pair and the optional
 * mvp-07a pull counters. Columns that do not apply to a row's kind stay NULL.
 * There is deliberately no column that could hold a vault path, a vault
 * directory or a file name — the no-plaintext rule is structural.
 *
 * `sync_state` is the single-row last-manifest pointer (`id` pinned to 1).
 *
 * `schema_version` carries exactly one row. The adapter refuses to open a
 * database whose version it does not know (fail-closed); migration machinery
 * is not built in MVP.
 */

export const SCHEMA_VERSION = 1;

export const HISTORY_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_operations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('publish', 'pull', 'conflict')),
  occurred_at_ms BIGINT NOT NULL,
  root_cid TEXT NOT NULL,
  manifest_cid TEXT,
  written INTEGER,
  removed INTEGER,
  fetched INTEGER,
  unchanged INTEGER,
  conflicted INTEGER,
  failed INTEGER,
  remote_deleted INTEGER,
  locally_modified INTEGER,
  duration_ms BIGINT,
  local_sha256 TEXT,
  remote_sha256 TEXT,
  sequence INTEGER,
  complete BOOLEAN,
  integrity_failed INTEGER,
  unfetched INTEGER,
  policy_skipped INTEGER,
  restored INTEGER
);
CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  manifest_cid TEXT NOT NULL,
  root_cid TEXT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
`;
