/**
 * Maps the sync event payloads (`src/core/events/event-types.ts`) to the
 * persisted history records (`types.ts`). This module is the only place the
 * two shapes meet, and it is where the no-plaintext rule is enforced by
 * construction: the conflict mapping reads only the sha256 fields of
 * `ConflictEvent`, so `path` and `conflictPath` can never reach a record.
 *
 * Events carry no timestamp; the mapper supplies `occurredAtMs` itself, so
 * callers (and tests) decide the clock.
 */

import type {
  ConflictEvent,
  PublishCompleteEvent,
  PullCompleteEvent,
} from "../events/event-types";
import type { ConflictRecord, PublishRecord, PullRecord } from "./types";

/** Every field of the event is kept, plus the supplied timestamp. */
export function mapPublishEvent(event: PublishCompleteEvent, occurredAtMs: number): PublishRecord {
  return {
    kind: "publish",
    occurredAtMs,
    rootCid: event.rootCid,
    manifestCid: event.manifestCid,
    written: event.written,
    removed: event.removed,
    durationMs: event.durationMs,
  };
}

/**
 * `forcedReverify` is dropped (design decision 3: the persisted counters do
 * not include it). The mvp-07a counters are copied only when the event set
 * them, so a plaintext pull leaves them absent rather than `undefined`.
 */
export function mapPullEvent(event: PullCompleteEvent, occurredAtMs: number): PullRecord {
  return {
    kind: "pull",
    occurredAtMs,
    rootCid: event.rootCid,
    manifestCid: event.manifestCid,
    fetched: event.fetched,
    unchanged: event.unchanged,
    conflicted: event.conflicted,
    failed: event.failed,
    remoteDeleted: event.remoteDeleted,
    locallyModified: event.locallyModified,
    durationMs: event.durationMs,
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
    ...(event.complete !== undefined ? { complete: event.complete } : {}),
    ...(event.integrityFailed !== undefined ? { integrityFailed: event.integrityFailed } : {}),
    ...(event.unfetched !== undefined ? { unfetched: event.unfetched } : {}),
    ...(event.policySkipped !== undefined ? { policySkipped: event.policySkipped } : {}),
    ...(event.restored !== undefined ? { restored: event.restored } : {}),
  };
}

/**
 * The event does not say which operation the conflict belongs to, so the
 * caller passes the parent operation's `rootCid`. Only `localSha256` and
 * `remoteSha256` are read from the event; `path` and `conflictPath` are
 * dropped here, by construction.
 */
export function mapConflictEvent(
  event: ConflictEvent,
  rootCid: string,
  occurredAtMs: number,
): ConflictRecord {
  return {
    kind: "conflict",
    occurredAtMs,
    rootCid,
    localSha256: event.localSha256,
    remoteSha256: event.remoteSha256,
  };
}
