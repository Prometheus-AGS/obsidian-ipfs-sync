import type { Bytes, HostKv } from "../core/host-bridge";
import { MANIFEST_DEVICE_MAX_CHARS, type EncryptedManifest } from "./encrypted-manifest";
import { HEX32, HEX64, RootStateError, assertPersistableCid, isCidToken, parseJsonObject, parseManifestField, parseMtimes, requireText, type JsonRecord } from "./local-record";
import { manifestIdentity } from "./manifest-identity";
import { rootFileNames } from "./root-files";
import { stableStringify } from "./stable-json";

/**
 * Per-root local state of an encrypted publish or pull (format 3), kept as `.ipfs-sync/state.<h>.json`. It records
 * what the last completed publish or pull to one MFS root left behind. It is plaintext at rest (it holds vault
 * paths), so the `.ipfs-sync/` folder must stay out of third-party sync and backups. Format 1 (`state.json`, the pull
 * record) is a different file and is ignored here. Files written by earlier builds carry an `encryptedSeen` field; it is
 * neither required nor read, and the next write leaves it out (the sequence floor is the downgrade evidence now).
 *
 * Format 3 is read strictly: every field below the baseline is required and nothing is defaulted, so a build that
 * wrote half a state, or an edit by hand, is refused instead of being trusted with a guess. Only format 2 (no
 * released build wrote one) is upgraded on read, with the defaults listed at `upgradeV2`. A build that only knows
 * format 2 refuses a format 3 file ("state format 3 is not supported"), which is the fail-closed outcome.
 */

export const ROOT_STATE_VERSION = 3;
/** Format read only to upgrade it. */
const ROOT_STATE_VERSION_PREVIOUS = 2;
/** Most manifest `device` values kept in `devicesSeen`. */
export const DEVICES_SEEN_MAX = 16;

export interface RootState {
  readonly version: typeof ROOT_STATE_VERSION;
  readonly mfsRoot: string;
  /** IPNS key name the root was last published under. */
  readonly key: string;
  /** CID of `<mfsRoot>` last published to IPNS by this device; null until the first publish completes (or after adopting an interrupted one). */
  readonly rootCid: string | null;
  /** 32 lowercase hex characters. */
  readonly vaultId: string;
  /** Lowercase hex sha256 of the local key-slot copy this state was written under. */
  readonly keyslotsSha256: string;
  /** Sequence of `manifest`; equals `manifest.sequence`. */
  readonly sequence: number;
  /**
   * Plaintext manifest v2 including blob CIDs: the per-path baseline. For a path in `unmaterialized` it is the node's
   * entry, which a publish copies unchanged; a path that is excluded or has an unsafe shape is absent.
   */
  readonly manifest: EncryptedManifest;
  /** Lowercase hex sha256 of `serializeManifestV2` of the authenticated node manifest this baseline came from. Stored, not recomputed from `manifest` (which may be merged). */
  readonly manifestIdentity: string;
  /** Identity of the baseline this device built on when it last published; null for a first publish, after a pull and for an upgraded format 2 state. */
  readonly previousIdentity: string | null;
  /** The highest authenticated sequence this directory accepted. Never below `sequence`; never lowered by a restore. */
  readonly highestSequence: number;
  /** Identity of that manifest; equals `manifestIdentity` when the two sequences are equal. */
  readonly highestIdentity: string;
  /** False when the last pull had an integrity-failed or unfetched file. Informational: publish does not refuse on it. */
  readonly complete: boolean;
  /** Sorted, unique paths of `manifest.files` whose content this device does not hold at that version. */
  readonly unmaterialized: readonly string[];
  /** Manifest `device` values seen on authenticated manifests, unique, first-seen order, at most `DEVICES_SEEN_MAX`. */
  readonly devicesSeen: readonly string[];
  /** Lowest sequence a deliberate restore accepted since the last normal pull. Informational. */
  readonly restoredFrom?: number;
  /** Modification time of every published file, for the size/mtime pre-filter. */
  readonly mtimes: Readonly<Record<string, number>>;
}

export { RootStateError };

export type RootStateInput = Omit<RootState, "version">;

export function buildRootState(input: RootStateInput): RootState {
  return { version: ROOT_STATE_VERSION, ...input };
}

/**
 * `devicesSeen` with `device` added: a value already present keeps its place, a new one goes last, and when the list
 * is over `DEVICES_SEEN_MAX` the earliest-seen values are dropped.
 */
export function addDeviceSeen(seen: readonly string[], device: string): readonly string[] {
  const next = seen.includes(device) ? seen : [...seen, device];
  return next.slice(-DEVICES_SEEN_MAX);
}

export type PublishedFields = Pick<
  RootStateInput,
  "manifestIdentity" | "previousIdentity" | "highestSequence" | "highestIdentity" | "complete" | "unmaterialized" | "devicesSeen"
>;

/**
 * The format 3 fields of a state that records `manifest` as this device's own publish (a completed one or an adopted
 * one), given the state it was built on (`baseline`, if any). `previousIdentity` is the baseline's identity;
 * `highest*` are raised to the manifest and never lowered; the publish is `complete`; `unmaterialized` is the carried
 * paths, sorted and unique; `devicesSeen` gains the manifest's device. `restoredFrom` is not carried: a publish
 * supersedes a restore. The floor is not touched here.
 */
export function publishedFields(baseline: RootState | undefined, manifest: EncryptedManifest, unmaterialized: readonly string[]): PublishedFields {
  const identity = manifestIdentity(manifest);
  const keepRecord = baseline !== undefined && baseline.highestSequence > manifest.sequence;
  return {
    manifestIdentity: identity,
    previousIdentity: baseline?.manifestIdentity ?? null,
    highestSequence: keepRecord ? baseline.highestSequence : manifest.sequence,
    highestIdentity: keepRecord ? baseline.highestIdentity : identity,
    complete: true,
    unmaterialized: [...new Set(unmaterialized)].sort(),
    devicesSeen: addDeviceSeen(baseline?.devicesSeen ?? [], manifest.device),
  };
}

export function encodeRootState(state: RootState): Bytes {
  return new TextEncoder().encode(`${stableStringify(state, 2)}\n`);
}

function refuse(what: string): never {
  throw new RootStateError(what);
}

function requireIdentity(record: JsonRecord, key: string): string {
  return requireText(record, key, HEX64, "state");
}

/** The fields format 2 and format 3 share; every check that does not depend on the format. */
interface Shared {
  readonly rootCid: string | null;
  readonly manifest: EncryptedManifest;
  readonly sequence: number;
  readonly vaultId: string;
}

function parseShared(record: JsonRecord): Shared {
  const rootCid = record["rootCid"];
  if (rootCid !== null && !isCidToken(rootCid)) refuse('state field "rootCid" is malformed');
  const manifest = parseManifestField(record["manifest"], "state");
  const sequence = record["sequence"];
  if (typeof sequence !== "number" || sequence !== manifest.sequence) refuse("state sequence does not match its manifest");
  const vaultId = requireText(record, "vaultId", HEX32, "state");
  if (vaultId !== manifest.vaultId) refuse("state vaultId does not match its manifest");
  return { rootCid, manifest, sequence, vaultId };
}

function baseInput(record: JsonRecord, shared: Shared): Pick<RootStateInput, "mfsRoot" | "key" | "rootCid" | "vaultId" | "keyslotsSha256" | "sequence" | "manifest" | "mtimes"> {
  return {
    mfsRoot: requireText(record, "mfsRoot", undefined, "state"),
    key: requireText(record, "key", undefined, "state"),
    rootCid: shared.rootCid,
    vaultId: shared.vaultId,
    keyslotsSha256: requireText(record, "keyslotsSha256", HEX64, "state"),
    sequence: shared.sequence,
    manifest: shared.manifest,
    mtimes: parseMtimes(record["mtimes"], "state"),
  };
}

/**
 * Format 2 held an unmerged node manifest and nothing else about the record, so the format 3 fields follow from
 * it: the identity is computed from the stored manifest, the highest accepted manifest is that manifest, the
 * pull was complete, nothing is unmaterialized, there is no previous identity, and the only device seen is the
 * one named in the manifest.
 */
function upgradeV2(record: JsonRecord): RootState {
  const shared = parseShared(record);
  const identity = manifestIdentity(shared.manifest);
  return buildRootState({
    ...baseInput(record, shared),
    manifestIdentity: identity,
    previousIdentity: null,
    highestSequence: shared.sequence,
    highestIdentity: identity,
    complete: true,
    unmaterialized: [],
    devicesSeen: [shared.manifest.device],
  });
}

function parseUnmaterialized(value: unknown, manifest: EncryptedManifest): readonly string[] {
  if (!Array.isArray(value)) refuse('state field "unmaterialized" is missing or not a list');
  const paths: readonly unknown[] = value;
  paths.forEach((path, index) => {
    if (typeof path !== "string") refuse('state field "unmaterialized" holds a value that is not a path');
    if (index > 0 && !((paths[index - 1] as string) < path)) refuse('state field "unmaterialized" is not sorted and unique');
    if (!Object.prototype.hasOwnProperty.call(manifest.files, path)) refuse('state field "unmaterialized" names a path that is not in the manifest');
  });
  return paths as readonly string[];
}

function parseDevicesSeen(value: unknown): readonly string[] {
  if (!Array.isArray(value)) refuse('state field "devicesSeen" is missing or not a list');
  const devices: readonly unknown[] = value;
  if (devices.length > DEVICES_SEEN_MAX) refuse('state field "devicesSeen" holds too many devices');
  devices.forEach((device) => {
    if (typeof device !== "string" || device === "" || [...device].length > MANIFEST_DEVICE_MAX_CHARS) refuse('state field "devicesSeen" holds a malformed device');
  });
  if (new Set(devices).size !== devices.length) refuse('state field "devicesSeen" holds a device twice');
  return devices as readonly string[];
}

function parseRestoredFrom(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) refuse('state field "restoredFrom" is malformed');
  return value;
}

function strictV3(record: JsonRecord): RootState {
  const shared = parseShared(record);
  const identity = requireIdentity(record, "manifestIdentity");
  const previous = record["previousIdentity"];
  if (previous !== null && (typeof previous !== "string" || !HEX64.test(previous))) refuse('state field "previousIdentity" is missing or malformed');
  const highestSequence = record["highestSequence"];
  if (typeof highestSequence !== "number" || !Number.isSafeInteger(highestSequence) || highestSequence < shared.sequence) {
    refuse('state field "highestSequence" is missing, malformed or below the sequence');
  }
  const highestIdentity = requireIdentity(record, "highestIdentity");
  if (highestSequence === shared.sequence && highestIdentity !== identity) refuse("state highestIdentity does not match its manifestIdentity at an equal sequence");
  const complete = record["complete"];
  if (typeof complete !== "boolean") refuse('state field "complete" is missing or not a boolean');
  const restoredFrom = parseRestoredFrom(record["restoredFrom"]);
  return buildRootState({
    ...baseInput(record, shared),
    manifestIdentity: identity,
    previousIdentity: previous,
    highestSequence,
    highestIdentity,
    complete,
    unmaterialized: parseUnmaterialized(record["unmaterialized"], shared.manifest),
    devicesSeen: parseDevicesSeen(record["devicesSeen"]),
    ...(restoredFrom === undefined ? {} : { restoredFrom }),
  });
}

export function decodeRootState(bytes: Bytes): RootState {
  const record = parseJsonObject(bytes, "state");
  const version = record["version"];
  if (version === ROOT_STATE_VERSION_PREVIOUS) return upgradeV2(record);
  if (version === ROOT_STATE_VERSION) return strictV3(record);
  return refuse(`state format ${String(version)} is not supported by this version`);
}

/**
 * The state file for `mfsRoot`, or undefined when there is none. A file that names another root (copied by
 * hand) is refused rather than trusted.
 */
export async function readRootState(kv: Pick<HostKv, "get">, mfsRoot: string): Promise<RootState | undefined> {
  const bytes = await kv.get(rootFileNames(mfsRoot).state);
  if (bytes === undefined) return undefined;
  const state = decodeRootState(bytes);
  if (state.mfsRoot !== mfsRoot) throw new RootStateError("the state file names a different MFS root");
  return state;
}

export async function writeRootState(kv: Pick<HostKv, "set">, state: RootState): Promise<void> {
  assertPersistableCid(state.rootCid, "state rootCid");
  await kv.set(rootFileNames(state.mfsRoot).state, encodeRootState(state));
}
