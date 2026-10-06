/**
 * StoreAdapter ports. Later stores (the CLI's PGlite adapter, a future
 * plugin adapter, an AI-layer store) code against these interfaces; the
 * in-memory implementation in `memory.ts` is the contract proof.
 *
 * Nothing here imports `@electric-sql/pglite` or a Node built-in: these
 * ports must stay usable inside the Obsidian mobile WebView.
 */

import type { HistoryRecord, LastManifestPointer } from "./types";

/** Append-only log of sync operations on this device. */
export interface MetadataStoreAdapter {
  /** Persist one record. Ordering within one operation is insertion order. */
  append(record: HistoryRecord): Promise<void>;
  /**
   * List records newest-first (by `occurredAtMs`, ties by insertion order,
   * newest first). `limit` caps the returned rows; `0` means all.
   */
  list(limit: number): Promise<readonly HistoryRecord[]>;
}

/** Single-row pointer to the manifest this device last settled on. */
export interface SyncStateStoreAdapter {
  /** The last-manifest pointer, or `undefined` when no operation has been recorded. */
  getLastManifest(): Promise<LastManifestPointer | undefined>;
  /** Replace the pointer. */
  setLastManifest(pointer: LastManifestPointer): Promise<void>;
}

/**
 * DECLARED ONLY — no implementation exists.
 *
 * pgvector is absent from `@electric-sql/pglite` 0.5.8 (the pinned runtime
 * dependency, design decision 7), so no adapter can store or query vectors
 * through it. An implementation waits for a PGlite version that carries
 * pgvector or for a different engine; whoever implements this must re-check
 * the pin before writing code.
 *
 * The shape below is the agreed contract: an embedding store is device-local,
 * optional and rebuildable per device (the recorded decision of this change),
 * keyed by content hash — never by vault location. Vectors are raw dimension
 * arrays; the row count budget is dims × 4 bytes per vector.
 */
export interface VectorStoreAdapter {
  /** Insert or replace one vector under its content hash (lowercase hex). */
  upsert(contentHash: string, vector: readonly number[]): Promise<void>;
  /** Remove every vector whose content hash is not in `keep`. */
  prune(keep: readonly string[]): Promise<void>;
  /** Return up to `limit` content hashes nearest to `vector`, nearest first. */
  query(vector: readonly number[], limit: number): Promise<readonly string[]>;
}
