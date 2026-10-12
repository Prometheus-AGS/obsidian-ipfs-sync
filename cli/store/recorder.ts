/**
 * The EventBus side of the history store (mvp-08 task 3.2; design decision 5).
 * `attachHistoryRecorder` subscribes a store to the bus a command already
 * built: `publish.complete` appends a publish record and moves the
 * last-manifest pointer, `pull.complete` appends a pull record, `conflict`
 * appends a conflict record.
 *
 * The conflict root-CID problem: `ConflictEvent` carries no root CID, and the
 * decrypting pull emits its `conflict` events BEFORE the `pull.complete` of
 * the same operation (`emitPullEvents` in `src/sync/encrypted-pull-events.ts`
 * loops the conflicts, then emits `pull.complete`; the only `conflict`
 * emitter in `src/sync/`). One command run is one operation, so a conflict
 * waits here for the complete event that follows it and is stamped with that
 * event's root CID. A conflict no complete event claims (the engine threw
 * between the emit loop and `pull.complete`) is dropped at `detach` with a
 * stderr line — there is no root CID to record it under.
 *
 * Writes are best-effort: a store failure becomes one `io.err` line and never
 * reaches the command's exit path (the bus would isolate a throwing listener
 * anyway; the recorder catches its own errors so the message says what was
 * lost). Writes run one at a time in event order, so "ordering within one
 * operation is insertion order" holds even though the bus does not await
 * listeners. `detach` drains that queue; the caller closes the store after
 * it, so no write outlives the handle.
 */

import type { EnvMap } from "../../src/core/config";
import type { ConflictEvent, SyncEventBus } from "../../src/core/events";
import { mapConflictEvent, mapPublishEvent, mapPullEvent } from "../../src/core/store/map-event";
import type { MetadataStoreAdapter, SyncStateStoreAdapter } from "../../src/core/store/ports";
import type { CliIo } from "../io";
import { openUserHistoryStore, type PgliteHistoryStore } from "./pglite-store";

/** The two ports any history store adapter (in-memory, PGlite) already implements together. */
export type HistoryRecorderStore = MetadataStoreAdapter & SyncStateStoreAdapter;

/**
 * Open the per-user history store for one command run, best-effort like the
 * recorder itself: a store that will not open (no per-user state directory,
 * an unknown schema version, an unreadable database) becomes one stderr line
 * and `undefined` — the run then records nothing — never a failed command.
 */
export async function openRunHistoryStore(env: EnvMap, io: CliIo): Promise<PgliteHistoryStore | undefined> {
  try {
    return await openUserHistoryStore(env);
  } catch (error) {
    io.err(`warning: sync history is unavailable on this device: ${error instanceof Error ? error.message : String(error)}; this run is not recorded`);
    return undefined;
  }
}

export interface HistoryRecorder {
  /**
   * Unsubscribe and wait for every queued write. Call it when the engine has
   * returned, before the store handle is closed.
   */
  detach(): Promise<void>;
}

/** One conflict seen on the bus, waiting for its operation's root CID. */
interface PendingConflict {
  readonly event: ConflictEvent;
  readonly occurredAtMs: number;
}

export function attachHistoryRecorder(
  bus: SyncEventBus,
  store: HistoryRecorderStore,
  io: CliIo,
  now: () => number = Date.now,
): HistoryRecorder {
  let pending: readonly PendingConflict[] = [];
  let chain: Promise<void> = Promise.resolve();

  const report = (error: unknown): void => {
    io.err(`warning: sync history was not recorded: ${error instanceof Error ? error.message : String(error)}`);
  };

  const enqueue = (work: () => Promise<void>): void => {
    chain = chain.then(work).catch(report);
  };

  const appendConflictsOf = async (rootCid: string, conflicts: readonly PendingConflict[]): Promise<void> => {
    for (const { event, occurredAtMs } of conflicts) await store.append(mapConflictEvent(event, rootCid, occurredAtMs));
  };

  const offConflict = bus.on("conflict", (event) => {
    pending = [...pending, { event, occurredAtMs: now() }];
  });

  const offPublish = bus.on("publish.complete", (event) => {
    const occurredAtMs = now();
    const conflicts = pending;
    pending = [];
    enqueue(async () => {
      await appendConflictsOf(event.rootCid, conflicts);
      await store.append(mapPublishEvent(event, occurredAtMs));
      await store.setLastManifest({ manifestCid: event.manifestCid, rootCid: event.rootCid, updatedAtMs: occurredAtMs });
    });
  });

  const offPull = bus.on("pull.complete", (event) => {
    const occurredAtMs = now();
    const conflicts = pending;
    pending = [];
    enqueue(async () => {
      await appendConflictsOf(event.rootCid, conflicts);
      await store.append(mapPullEvent(event, occurredAtMs));
    });
  });

  return {
    async detach() {
      offConflict();
      offPublish();
      offPull();
      if (pending.length > 0) {
        io.err(`warning: ${pending.length} conflict record(s) had no completed operation to attach to and were not recorded`);
        pending = [];
      }
      await chain;
    },
  };
}
