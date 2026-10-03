import type { Bytes } from "../core/host-bridge";
import type { DeviceStore } from "./device-store";
import { stableStringify } from "./stable-json";

/**
 * The sequence floor: per `vaultId`, the highest manifest sequence (and its identity) this device has accepted in any
 * directory. It lives in the device-local store, not in the vault's `.ipfs-sync/` folder, so `abandon`, a deleted state
 * folder and a changed MFS root do not reset it. It does not survive deleting the per-user store, the plugin data or a
 * reinstall. Every write is read-merge-max, so a stale snapshot can never lower it.
 */

export const SEQUENCE_FLOOR_FILE = "sequence-floor.json";
export const SEQUENCE_FLOOR_VERSION = 1;
/** Vaults kept; beyond this the entry with the oldest `at` is dropped. */
export const FLOOR_VAULTS_MAX = 64;

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface FloorEntry {
  /** Highest accepted manifest sequence (at least 1). */
  readonly sequence: number;
  /** Manifest identity (64 lowercase hex) at that sequence. */
  readonly identity: string;
  /** Milliseconds since the epoch of the write that set this entry. */
  readonly at: number;
}

export interface SequenceFloor {
  readonly version: typeof SEQUENCE_FLOOR_VERSION;
  readonly floors: Readonly<Record<string, FloorEntry>>;
}

export class SequenceFloorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SequenceFloorError";
  }
}

const DAMAGED =
  "the sequence floor file is damaged; to recover, delete it (CLI: sequence-floor.json in the per-user store; plugin: the deviceStore section of the plugin data) and pull again as a first pull";

export function emptyFloor(): SequenceFloor {
  return { version: SEQUENCE_FLOOR_VERSION, floors: {} };
}

function parseEntry(value: unknown): FloorEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SequenceFloorError(DAMAGED);
  const { sequence, identity, at } = value as Record<string, unknown>;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) throw new SequenceFloorError(DAMAGED);
  if (typeof identity !== "string" || !HEX64.test(identity)) throw new SequenceFloorError(DAMAGED);
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) throw new SequenceFloorError(DAMAGED);
  return { sequence, identity, at };
}

/** Strict decoding: anything that is not exactly the documented shape is refused, never repaired. */
export function decodeFloor(bytes: Bytes): SequenceFloor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SequenceFloorError(DAMAGED);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SequenceFloorError(DAMAGED);
  const { version, floors } = parsed as Record<string, unknown>;
  if (version !== SEQUENCE_FLOOR_VERSION) throw new SequenceFloorError(`the sequence floor file has format ${String(version)}, which this build does not support`);
  if (typeof floors !== "object" || floors === null || Array.isArray(floors)) throw new SequenceFloorError(DAMAGED);
  const entries = Object.entries(floors as Record<string, unknown>);
  if (entries.length > FLOOR_VAULTS_MAX) throw new SequenceFloorError(DAMAGED);
  const decoded: Record<string, FloorEntry> = {};
  for (const [vaultId, entry] of entries) {
    if (!HEX32.test(vaultId)) throw new SequenceFloorError(DAMAGED);
    decoded[vaultId] = parseEntry(entry);
  }
  return { version: SEQUENCE_FLOOR_VERSION, floors: decoded };
}

export function encodeFloor(floor: SequenceFloor): Bytes {
  return new TextEncoder().encode(`${stableStringify(floor, 2)}\n`);
}

/** Newest `at` first; ties by vault id so the result does not depend on iteration order. */
function capped(floors: Readonly<Record<string, FloorEntry>>): Readonly<Record<string, FloorEntry>> {
  const kept = Object.entries(floors)
    .sort(([idA, a], [idB, b]) => b.at - a.at || (idA < idB ? -1 : idA > idB ? 1 : 0))
    .slice(0, FLOOR_VAULTS_MAX);
  return Object.fromEntries(kept);
}

/**
 * Per vault, the higher sequence wins. At an equal sequence `stored` wins (the first identity recorded stays), unless
 * `replaceAtEqual` is set: fork resolution is the only operation that changes the identity at a sequence.
 */
export function mergeFloors(stored: SequenceFloor, incoming: SequenceFloor, replaceAtEqual = false): SequenceFloor {
  const merged: Record<string, FloorEntry> = { ...stored.floors };
  for (const [vaultId, entry] of Object.entries(incoming.floors)) {
    const current = merged[vaultId];
    if (current === undefined || entry.sequence > current.sequence || (replaceAtEqual && entry.sequence === current.sequence)) merged[vaultId] = entry;
  }
  return { version: SEQUENCE_FLOOR_VERSION, floors: capped(merged) };
}

/**
 * The merge for two stored floor files (the plugin settings store applies it on every save). A side that is missing or
 * does not decode loses to the other one; this never throws, so a damaged entry cannot block saving the settings.
 */
export function mergeFloorBytes(stored: Bytes | undefined, incoming: Bytes | undefined): Bytes | undefined {
  const decode = (bytes: Bytes | undefined): SequenceFloor | undefined => {
    if (bytes === undefined) return undefined;
    try {
      return decodeFloor(bytes);
    } catch {
      return undefined;
    }
  };
  const a = decode(stored);
  const b = decode(incoming);
  if (a === undefined && b === undefined) return incoming ?? stored;
  if (a === undefined) return incoming;
  if (b === undefined) return stored;
  return encodeFloor(mergeFloors(a, b));
}

async function readStored(store: DeviceStore): Promise<SequenceFloor> {
  const bytes = await store.get(SEQUENCE_FLOOR_FILE);
  return bytes === undefined ? emptyFloor() : decodeFloor(bytes);
}

/** The floor entry for `vaultId`, or `undefined`. A damaged floor file throws `SequenceFloorError`. */
export async function readFloor(store: DeviceStore, vaultId: string): Promise<FloorEntry | undefined> {
  return (await readStored(store)).floors[vaultId];
}

export interface RaiseFloorOptions {
  /** Fork resolution: at an equal sequence the incoming identity replaces the stored one. */
  readonly forkResolution?: boolean;
}

/**
 * Raise the floor of `vaultId` to `entry`: re-read the stored file, take the higher sequence, write the result. A lower
 * sequence leaves the stored value in place. Returns the entry that is stored afterwards. The read-merge-write runs inside the
 * store's `exclusive` section when it has one: two processes (two CLI pulls of different vaults) that read the same old file
 * would otherwise each write a file without the other's raise, and the last rename would win (review-final A-08).
 */
export async function raiseFloor(store: DeviceStore, vaultId: string, entry: FloorEntry, options: RaiseFloorOptions = {}): Promise<FloorEntry> {
  if (!HEX32.test(vaultId)) throw new SequenceFloorError("the vault id for the sequence floor is not 32 lowercase hex characters");
  const incoming = parseEntry(entry);
  const readMergeWrite = async (): Promise<FloorEntry> => {
    const merged = mergeFloors(await readStored(store), { version: SEQUENCE_FLOOR_VERSION, floors: { [vaultId]: incoming } }, options.forkResolution === true);
    await store.set(SEQUENCE_FLOOR_FILE, encodeFloor(merged));
    return merged.floors[vaultId] ?? incoming;
  };
  return store.exclusive === undefined ? readMergeWrite() : store.exclusive(readMergeWrite);
}
