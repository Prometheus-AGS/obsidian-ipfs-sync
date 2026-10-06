/**
 * In-memory implementation of `MetadataStoreAdapter` and
 * `SyncStateStoreAdapter`. It is the contract proof for the ports: anything
 * a later adapter (the CLI's PGlite store, a future plugin store) must honour
 * is exercised against this implementation first.
 *
 * WebView-safe by construction: no Node built-ins, no `@electric-sql/pglite`
 * import, synchronous in-memory state behind the async port signatures.
 */

import type { MetadataStoreAdapter, SyncStateStoreAdapter } from "./ports";
import type { HistoryRecord, LastManifestPointer } from "./types";

export interface InMemoryStore extends MetadataStoreAdapter, SyncStateStoreAdapter {}

interface StampedRecord {
  readonly record: HistoryRecord;
  /** Append order, used to break `occurredAtMs` ties newest-first. */
  readonly insertionIndex: number;
}

export function createInMemoryStore(): InMemoryStore {
  const records: StampedRecord[] = [];
  let lastManifest: LastManifestPointer | undefined;

  return {
    append(record: HistoryRecord): Promise<void> {
      records.push({ record, insertionIndex: records.length });
      return Promise.resolve();
    },

    list(limit: number): Promise<readonly HistoryRecord[]> {
      const newestFirst = [...records].sort(
        (a, b) => b.record.occurredAtMs - a.record.occurredAtMs || b.insertionIndex - a.insertionIndex,
      );
      const rows = limit === 0 ? newestFirst : newestFirst.slice(0, limit);
      return Promise.resolve(rows.map((row) => row.record));
    },

    getLastManifest(): Promise<LastManifestPointer | undefined> {
      return Promise.resolve(lastManifest);
    },

    setLastManifest(pointer: LastManifestPointer): Promise<void> {
      lastManifest = pointer;
      return Promise.resolve();
    },
  };
}
