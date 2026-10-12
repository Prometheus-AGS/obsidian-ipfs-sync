import { mkdir } from "node:fs/promises";
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import type { EnvMap } from "../../src/core/config";
import type { MetadataStoreAdapter, SyncStateStoreAdapter } from "../../src/core/store/ports";
import type { HistoryRecord, LastManifestPointer } from "../../src/core/store/types";
import { historyStoreDirectory } from "./location";
import { HISTORY_DDL, SCHEMA_VERSION } from "./schema";

/**
 * The PGlite (nodefs) side of the history store: one database per user in the
 * per-user state directory under `history/`. A plain `dataDir` path selects
 * the nodefs filesystem in Node; nothing from this module may be imported
 * under `src/` (the WebView bundle stays free of PGlite and Node built-ins).
 */

/**
 * Supplies the embedded PGlite runtime assets of the single-file CLI bundle (pglite-embedded-assets.ts). Only the
 * bundle's entry point (cli/main.ts) registers one: the shipped file cannot resolve pglite.data, pglite.wasm or
 * initdb.wasm from disk, so it carries them inline. Vitest and tsx on the sources never register one and keep
 * PGlite's own resolution from node_modules; harness bundles that start from cli/run.ts (the feature-op cli-yes)
 * register a provider that reads the assets from the host's node_modules at spawn time.
 */
let embeddedAssets: (() => Promise<PGliteOptions>) | undefined;

export function provideEmbeddedPgliteAssets(provider: () => Promise<PGliteOptions>): void {
  embeddedAssets = provider;
}

async function openPglite(directory: string): Promise<PGlite> {
  const provider = embeddedAssets;
  return provider === undefined ? new PGlite(directory) : new PGlite(directory, await provider());
}

export class HistoryStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryStoreError";
  }
}

export interface PgliteHistoryStore extends MetadataStoreAdapter, SyncStateStoreAdapter {
  close(): Promise<void>;
}

export interface PgliteHistoryStoreOptions {
  /** The `history/` directory itself; created when missing. */
  readonly directory: string;
}

const OPERATION_COLUMNS = [
  "kind",
  "occurred_at_ms",
  "root_cid",
  "manifest_cid",
  "written",
  "removed",
  "fetched",
  "unchanged",
  "conflicted",
  "failed",
  "remote_deleted",
  "locally_modified",
  "duration_ms",
  "local_sha256",
  "remote_sha256",
  "sequence",
  "complete",
  "integrity_failed",
  "unfetched",
  "policy_skipped",
  "restored",
] as const;

interface OperationRow {
  readonly kind: string;
  readonly occurred_at_ms: number;
  readonly root_cid: string;
  readonly manifest_cid: string | null;
  readonly written: number | null;
  readonly removed: number | null;
  readonly fetched: number | null;
  readonly unchanged: number | null;
  readonly conflicted: number | null;
  readonly failed: number | null;
  readonly remote_deleted: number | null;
  readonly locally_modified: number | null;
  readonly duration_ms: number | null;
  readonly local_sha256: string | null;
  readonly remote_sha256: string | null;
  readonly sequence: number | null;
  readonly complete: boolean | null;
  readonly integrity_failed: number | null;
  readonly unfetched: number | null;
  readonly policy_skipped: number | null;
  readonly restored: number | null;
}

function rowOf(record: HistoryRecord): readonly (string | number | boolean | null)[] {
  const base = {
    manifest_cid: null as string | null,
    written: null as number | null,
    removed: null as number | null,
    fetched: null as number | null,
    unchanged: null as number | null,
    conflicted: null as number | null,
    failed: null as number | null,
    remote_deleted: null as number | null,
    locally_modified: null as number | null,
    duration_ms: null as number | null,
    local_sha256: null as string | null,
    remote_sha256: null as string | null,
    sequence: null as number | null,
    complete: null as boolean | null,
    integrity_failed: null as number | null,
    unfetched: null as number | null,
    policy_skipped: null as number | null,
    restored: null as number | null,
  };
  const filled =
    record.kind === "publish"
      ? { ...base, manifest_cid: record.manifestCid, written: record.written, removed: record.removed, duration_ms: record.durationMs }
      : record.kind === "pull"
        ? {
            ...base,
            manifest_cid: record.manifestCid,
            fetched: record.fetched,
            unchanged: record.unchanged,
            conflicted: record.conflicted,
            failed: record.failed,
            remote_deleted: record.remoteDeleted,
            locally_modified: record.locallyModified,
            duration_ms: record.durationMs,
            sequence: record.sequence ?? null,
            complete: record.complete ?? null,
            integrity_failed: record.integrityFailed ?? null,
            unfetched: record.unfetched ?? null,
            policy_skipped: record.policySkipped ?? null,
            restored: record.restored ?? null,
          }
        : { ...base, local_sha256: record.localSha256, remote_sha256: record.remoteSha256 };
  return [
    record.kind,
    record.occurredAtMs,
    record.rootCid,
    filled.manifest_cid,
    filled.written,
    filled.removed,
    filled.fetched,
    filled.unchanged,
    filled.conflicted,
    filled.failed,
    filled.remote_deleted,
    filled.locally_modified,
    filled.duration_ms,
    filled.local_sha256,
    filled.remote_sha256,
    filled.sequence,
    filled.complete,
    filled.integrity_failed,
    filled.unfetched,
    filled.policy_skipped,
    filled.restored,
  ];
}

function requireColumn(row: OperationRow, column: keyof OperationRow): string | number | boolean {
  const value = row[column];
  if (value === null) throw new HistoryStoreError(`history row of kind ${row.kind} is missing ${column}; the database does not match the schema`);
  return value;
}

function recordOf(row: OperationRow): HistoryRecord {
  switch (row.kind) {
    case "publish":
      return {
        kind: "publish",
        occurredAtMs: row.occurred_at_ms,
        rootCid: row.root_cid,
        manifestCid: String(requireColumn(row, "manifest_cid")),
        written: Number(requireColumn(row, "written")),
        removed: Number(requireColumn(row, "removed")),
        durationMs: Number(requireColumn(row, "duration_ms")),
      };
    case "pull":
      return {
        kind: "pull",
        occurredAtMs: row.occurred_at_ms,
        rootCid: row.root_cid,
        manifestCid: String(requireColumn(row, "manifest_cid")),
        fetched: Number(requireColumn(row, "fetched")),
        unchanged: Number(requireColumn(row, "unchanged")),
        conflicted: Number(requireColumn(row, "conflicted")),
        failed: Number(requireColumn(row, "failed")),
        remoteDeleted: Number(requireColumn(row, "remote_deleted")),
        locallyModified: Number(requireColumn(row, "locally_modified")),
        durationMs: Number(requireColumn(row, "duration_ms")),
        ...(row.sequence !== null ? { sequence: row.sequence } : {}),
        ...(row.complete !== null ? { complete: row.complete } : {}),
        ...(row.integrity_failed !== null ? { integrityFailed: row.integrity_failed } : {}),
        ...(row.unfetched !== null ? { unfetched: row.unfetched } : {}),
        ...(row.policy_skipped !== null ? { policySkipped: row.policy_skipped } : {}),
        ...(row.restored !== null ? { restored: row.restored } : {}),
      };
    case "conflict":
      return {
        kind: "conflict",
        occurredAtMs: row.occurred_at_ms,
        rootCid: row.root_cid,
        localSha256: String(requireColumn(row, "local_sha256")),
        remoteSha256: String(requireColumn(row, "remote_sha256")),
      };
    default:
      throw new HistoryStoreError(`history row has an unknown kind "${row.kind}"; the database does not match the schema`);
  }
}

/** Create the tables when missing, then refuse any version this build does not know (fail-closed). */
async function settleSchema(db: PGlite, directory: string): Promise<void> {
  await db.exec(HISTORY_DDL);
  const found = await db.query<{ version: number }>("SELECT version FROM schema_version");
  if (found.rows.length === 0) {
    await db.query("INSERT INTO schema_version (version, applied_at_ms) VALUES ($1, $2)", [SCHEMA_VERSION, Date.now()]);
    return;
  }
  if (found.rows.length > 1 || found.rows[0]?.version !== SCHEMA_VERSION) {
    const seen = found.rows.map((row) => row.version).join(", ");
    throw new HistoryStoreError(
      `the history database at ${directory} has schema version ${seen}, which this build does not know (it knows ${SCHEMA_VERSION}); refusing to open it`,
    );
  }
}

export async function openHistoryStore(options: PgliteHistoryStoreOptions): Promise<PgliteHistoryStore> {
  const directory = options.directory;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const db = await openPglite(directory);
  try {
    await settleSchema(db, directory);
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }

  const insertSql = `INSERT INTO sync_operations (${OPERATION_COLUMNS.join(", ")}) VALUES (${OPERATION_COLUMNS.map((_, index) => `$${index + 1}`).join(", ")})`;

  return {
    append: async (record) => {
      await db.query(insertSql, [...rowOf(record)]);
    },
    list: async (limit) => {
      const order = "SELECT * FROM sync_operations ORDER BY occurred_at_ms DESC, id DESC";
      const result = limit === 0 ? await db.query<OperationRow>(order) : await db.query<OperationRow>(`${order} LIMIT $1`, [limit]);
      return result.rows.map(recordOf);
    },
    getLastManifest: async () => {
      const result = await db.query<{ manifest_cid: string; root_cid: string; updated_at_ms: number }>(
        "SELECT manifest_cid, root_cid, updated_at_ms FROM sync_state WHERE id = 1",
      );
      const row = result.rows[0];
      return row === undefined ? undefined : { manifestCid: row.manifest_cid, rootCid: row.root_cid, updatedAtMs: row.updated_at_ms };
    },
    setLastManifest: async (pointer: LastManifestPointer) => {
      await db.query(
        "INSERT INTO sync_state (id, manifest_cid, root_cid, updated_at_ms) VALUES (1, $1, $2, $3) " +
          "ON CONFLICT (id) DO UPDATE SET manifest_cid = $1, root_cid = $2, updated_at_ms = $3",
        [pointer.manifestCid, pointer.rootCid, pointer.updatedAtMs],
      );
    },
    close: () => db.close(),
  };
}

/** The history store of one run: the database in the per-user state directory under `history/`. */
export function openUserHistoryStore(env: EnvMap): Promise<PgliteHistoryStore> {
  return openHistoryStore({ directory: historyStoreDirectory(env) });
}
