import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Bytes, HostKv } from "../core/host-bridge";
import { KEY_SLOTS_MAX_BYTES } from "../crypto";
import { isHistoryName } from "./history-names";
import { CID_TOKEN, HEX32, HEX64, RootStateError, parseJsonObject, requireText, type JsonRecord } from "./local-record";
import { maintenancePending, publishJournalPending } from "./publish-refusals";
import { rootFileNames } from "./root-files";
import { stableStringify } from "./stable-json";

/**
 * The journal of a key-management operation in flight, kept as `.ipfs-sync/maintenance.<h>.json`: a `rewrap` (new
 * `keyslots.json`) or a `prune` (history files removed). It is its own file with its own version, never
 * `journal.<h>.json`, so the publish journal's reader and the publish resume rules can never take one for the other:
 * a publish journal is not a damaged maintenance journal, and the reverse holds too.
 *
 * It is written BEFORE the first change to the shared MFS tree and removed as the last step of the operation (or by
 * `keys discard`, or by an accept of changed slots). The `phase` says how far the operation got; `republish-root.ts` reads it
 * to finish the operation or to refuse. Phases:
 *
 *   rewrap: journaled, file-written, snapshotted, published, local-updated
 *   prune:  journaled, removing,     snapshotted, published
 *
 * `snapshotRoot` is the root CID that was read back, pinned and published (null until `snapshotted`). `startRoot` is what the
 * publication name pointed at when the operation started; `nodeSequence` and `manifestSha256` identify the `manifest.enc` the
 * operation was based on, so a publisher that completed in between is seen.
 *
 * It holds public node data only (the old and new `keyslots.json` bytes, which are public by design; history file names), no
 * passphrase and no key. A rewrap's new bytes are kept so a rerun can write exactly them and can tell them from a foreign file.
 */

export const MAINTENANCE_JOURNAL_VERSION = 1;

export const REWRAP_PHASES = ["journaled", "file-written", "snapshotted", "published", "local-updated"] as const;
export const PRUNE_PHASES = ["journaled", "removing", "snapshotted", "published"] as const;
export type RewrapPhase = (typeof REWRAP_PHASES)[number];
export type PrunePhase = (typeof PRUNE_PHASES)[number];

/** History files per directory the publisher tolerates (`history-check.ts` stops at 1,999); a longer removal list is not a journal this tool wrote. */
const REMOVALS_MAX = 2_000;
const HEX_BYTES = /^(?:[0-9a-f]{2})+$/;

/** What both operations record when they start. */
export interface MaintenanceFacts {
  readonly mfsRoot: string;
  /** The IPNS key name the root is published under. */
  readonly key: string;
  readonly vaultId: string;
  /** sha256 of this device's local `keyslots` copy when the operation started. */
  readonly keyslotsSha256: string;
  /** What the publication name pointed at when the operation started; null for "no record". */
  readonly startRoot: string | null;
  /** Sequence of the node's `manifest.enc` the operation was based on. */
  readonly nodeSequence: number;
  /** sha256 of the exact `manifest.enc` bytes the operation was based on. */
  readonly manifestSha256: string;
  readonly startedAt: string;
}

interface MaintenanceCommon extends MaintenanceFacts {
  readonly version: typeof MAINTENANCE_JOURNAL_VERSION;
  /** The root that was read back, pinned and published; null until the `snapshotted` phase. */
  readonly snapshotRoot: string | null;
}

export interface RewrapJournal extends MaintenanceCommon {
  readonly type: "rewrap";
  readonly phase: RewrapPhase;
  /** Lowercase hex of the `keyslots.json` the node held when the rewrap started. */
  readonly oldKeySlotsHex: string;
  /** Lowercase hex of the `keyslots.json` this rewrap writes. */
  readonly newKeySlotsHex: string;
}

export interface PruneJournal extends MaintenanceCommon {
  readonly type: "prune";
  readonly phase: PrunePhase;
  /** Names under `manifests/` to remove, each a history file name. Removing a name that is already gone is a no-op. */
  readonly removals: readonly string[];
}

export type MaintenanceJournal = RewrapJournal | PruneJournal;
export type MaintenancePhase = RewrapPhase | PrunePhase;

function phaseIndex(journal: MaintenanceJournal): number {
  return (journal.type === "rewrap" ? REWRAP_PHASES : PRUNE_PHASES).indexOf(journal.phase as never);
}

/** Has the journal reached `phase` (or gone past it)? A phase the type does not have is never reached. */
export function reached(journal: MaintenanceJournal, phase: MaintenancePhase): boolean {
  const list: readonly string[] = journal.type === "rewrap" ? REWRAP_PHASES : PRUNE_PHASES;
  const wanted = list.indexOf(phase);
  return wanted >= 0 && phaseIndex(journal) >= wanted;
}

/** The same journal one phase on. `snapshotRoot` is given with `snapshotted` and kept afterwards. */
export function advance(journal: MaintenanceJournal, phase: MaintenancePhase, snapshotRoot?: string): MaintenanceJournal {
  return { ...journal, phase, snapshotRoot: snapshotRoot ?? journal.snapshotRoot } as MaintenanceJournal;
}

export function buildRewrapJournal(facts: MaintenanceFacts, bytes: { readonly oldKeySlots: Bytes; readonly newKeySlots: Bytes }): RewrapJournal {
  return {
    version: MAINTENANCE_JOURNAL_VERSION,
    ...facts,
    snapshotRoot: null,
    type: "rewrap",
    phase: "journaled",
    oldKeySlotsHex: bytesToHex(bytes.oldKeySlots),
    newKeySlotsHex: bytesToHex(bytes.newKeySlots),
  };
}

export function buildPruneJournal(facts: MaintenanceFacts, removals: readonly string[]): PruneJournal {
  return { version: MAINTENANCE_JOURNAL_VERSION, ...facts, snapshotRoot: null, type: "prune", phase: "journaled", removals: [...removals] };
}

export function encodeMaintenanceJournal(journal: MaintenanceJournal): Bytes {
  return new TextEncoder().encode(`${stableStringify(journal, 2)}\n`);
}

function parseHex(record: JsonRecord, key: string): string {
  const value = requireText(record, key, HEX_BYTES, "maintenance journal");
  if (value.length > KEY_SLOTS_MAX_BYTES * 2) throw new RootStateError(`maintenance journal field "${key}" is too large`);
  return value;
}

function parseRemovals(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > REMOVALS_MAX) throw new RootStateError('maintenance journal field "removals" is missing or malformed');
  const names = value.map((name: unknown) => {
    if (typeof name !== "string" || !isHistoryName(name)) throw new RootStateError('maintenance journal field "removals" holds a name that is not a history file');
    return name;
  });
  if (new Set(names).size !== names.length) throw new RootStateError('maintenance journal field "removals" lists a name twice');
  return names;
}

function parseStartRoot(record: JsonRecord, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value === "string" && CID_TOKEN.test(value)) return value;
  throw new RootStateError(`maintenance journal field "${key}" is missing or malformed`);
}

function parseFacts(record: JsonRecord): MaintenanceCommon {
  const nodeSequence = record["nodeSequence"];
  if (typeof nodeSequence !== "number" || !Number.isSafeInteger(nodeSequence) || nodeSequence < 1) throw new RootStateError('maintenance journal field "nodeSequence" is missing or malformed');
  return {
    version: MAINTENANCE_JOURNAL_VERSION,
    mfsRoot: requireText(record, "mfsRoot", undefined, "maintenance journal"),
    key: requireText(record, "key", undefined, "maintenance journal"),
    vaultId: requireText(record, "vaultId", HEX32, "maintenance journal"),
    keyslotsSha256: requireText(record, "keyslotsSha256", HEX64, "maintenance journal"),
    startRoot: parseStartRoot(record, "startRoot"),
    nodeSequence,
    manifestSha256: requireText(record, "manifestSha256", HEX64, "maintenance journal"),
    startedAt: requireText(record, "startedAt", undefined, "maintenance journal"),
    snapshotRoot: parseStartRoot(record, "snapshotRoot"),
  };
}

function phaseOf<T extends string>(record: JsonRecord, allowed: readonly T[]): T {
  const phase = record["phase"];
  const found = allowed.find((candidate) => candidate === phase);
  if (found === undefined) throw new RootStateError('maintenance journal field "phase" is missing or not a phase of this type');
  return found;
}

/** A journal needs a snapshot root exactly from the `snapshotted` phase on. */
function assertSnapshotRoot(journal: MaintenanceJournal): void {
  const needs = reached(journal, "snapshotted");
  if (needs !== (journal.snapshotRoot !== null)) throw new RootStateError('maintenance journal field "snapshotRoot" does not match its phase');
}

export function decodeMaintenanceJournal(bytes: Bytes): MaintenanceJournal {
  const record = parseJsonObject(bytes, "maintenance journal");
  if (record["version"] !== MAINTENANCE_JOURNAL_VERSION) throw new RootStateError(`maintenance journal format ${String(record["version"])} is not supported by this version`);
  const common = parseFacts(record);
  const type = record["type"];
  let journal: MaintenanceJournal;
  if (type === "rewrap") {
    journal = { ...common, type, phase: phaseOf(record, REWRAP_PHASES), oldKeySlotsHex: parseHex(record, "oldKeySlotsHex"), newKeySlotsHex: parseHex(record, "newKeySlotsHex") };
  } else if (type === "prune") {
    journal = { ...common, type, phase: phaseOf(record, PRUNE_PHASES), removals: parseRemovals(record["removals"]) };
  } else {
    throw new RootStateError('maintenance journal field "type" is missing or unknown');
  }
  assertSnapshotRoot(journal);
  return journal;
}

/** What the maintenance file holds: nothing, a usable journal, or a file that cannot be read (torn write, damage, a newer version). */
export type MaintenanceRead =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly journal: MaintenanceJournal }
  | { readonly kind: "damaged" };

export async function readMaintenanceJournal(kv: Pick<HostKv, "get">, mfsRoot: string): Promise<MaintenanceRead> {
  const bytes = await kv.get(rootFileNames(mfsRoot).maintenance);
  if (bytes === undefined) return { kind: "none" };
  try {
    return { kind: "ok", journal: decodeMaintenanceJournal(bytes) };
  } catch (error) {
    if (error instanceof RootStateError) return { kind: "damaged" };
    throw error;
  }
}

export async function writeMaintenanceJournal(kv: Pick<HostKv, "set">, journal: MaintenanceJournal): Promise<void> {
  await kv.set(rootFileNames(journal.mfsRoot).maintenance, encodeMaintenanceJournal(journal));
}

/**
 * Remove the maintenance journal of `mfsRoot` whatever it holds, readable or not. The helper behind `keys discard` and behind an accept of
 * changed slots. It touches this device's file only: whether the shared tree needs a withdrawal first is `withdrawMaintenanceWrite`'s question.
 */
export async function discardMaintenanceJournal(kv: Pick<HostKv, "get" | "delete">, mfsRoot: string): Promise<"removed" | "none"> {
  const name = rootFileNames(mfsRoot).maintenance;
  if ((await kv.get(name)) === undefined) return "none";
  await kv.delete(name);
  return "removed";
}

/** The old and new `keyslots.json` bytes a rewrap journal carries. */
export function rewrapBytes(journal: RewrapJournal): { readonly oldKeySlots: Bytes; readonly newKeySlots: Bytes } {
  return { oldKeySlots: hexToBytes(journal.oldKeySlotsHex), newKeySlots: hexToBytes(journal.newKeySlotsHex) };
}

/**
 * Publish and pull call this first. A maintenance journal in any state (readable or not) stops them with `maintenance-pending`, which
 * names `keys discard` and `keys accept-slots`. A read only: it writes nothing and derives nothing.
 */
export async function assertNoMaintenanceJournal(kv: Pick<HostKv, "get">, mfsRoot: string): Promise<void> {
  const read = await readMaintenanceJournal(kv, mfsRoot);
  if (read.kind === "none") return;
  throw maintenancePending(read.kind === "damaged" ? "damaged" : read.journal.type);
}

/**
 * Rewrap and prune call this first. The publish journal file is looked at for presence only (it is not decoded, not resumed, not deleted:
 * `resumeJournal` writes, and a damaged publish journal is the publisher's to handle). Any publish journal stops them with
 * `publish-journal-pending`.
 */
export async function assertNoPublishJournal(kv: Pick<HostKv, "get">, mfsRoot: string): Promise<void> {
  if ((await kv.get(rootFileNames(mfsRoot).journal)) !== undefined) throw publishJournalPending();
}
