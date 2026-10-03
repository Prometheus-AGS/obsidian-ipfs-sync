/**
 * Fork resolution (mvp-07a task 4.7; design decision 9; spec rollback-detection "Fork resolution"). WebView-safe: no Node imports.
 *
 * A fork is this device's sequence N+1 (identity X) against the node's sequence N+1 (identity Y): another device published at the
 * same time and the later `name/publish` won. `pull --resolve-fork` takes Y's files with this device's differing text kept as
 * dated conflict copies. This module decides the base `B` of that three-way plan and records the floor; the rest is the
 * ordinary pull stage (`encrypted-pull-stage.ts`).
 *
 * The base is the common ancestor, the manifest at sequence N that this device built X on, found in the node's history. A name is
 * only a claim, so an entry is the ancestor only when all of these hold: its name carries the prefix N; its file authenticates
 * under the vault key for the same vault and sequence N; and its identity equals the state's `previousIdentity`. Exactly one entry
 * may pass. The identity test is what makes a hostile node harmless here: a genuine sequence-N manifest that is not the one this
 * device built on would turn a local edit equal to it into a silent `replace`, so it is never used. Where there is no ancestor
 * (no record of what this device built on, no entry at the prefix, no or several matches), `B` is absent and every file that
 * differs from Y becomes a conflict copy: nothing local is lost. The local baseline (X) is never `B`, because `L == X` would make
 * `replace` overwrite this device's edit without a copy.
 *
 * Reads only: a listing of the immutable root the name resolved to, and the history entries at one prefix, each capped.
 * Messages are fixed text built from a sequence number; nothing here carries a path, a key or file bytes.
 */
import type { Bytes } from "../core/host-bridge";
import { CryptoError, OversizeInputError, type VaultKeys } from "../crypto";
import { KuboHttpError, type KuboClient, type MfsEntry } from "../kubo";
import type { DeviceStore } from "./device-store";
import { ManifestFormatError, decodeManifestFile, type EncryptedManifest } from "./encrypted-manifest";
import type { PullBase } from "./encrypted-pull-plan";
import { entriesAtSequence, prefixMatchesSequence } from "./history-names";
import { isUnreadableManifest } from "./manifest-auth";
import { manifestIdentity } from "./manifest-identity";
import { MANIFEST_READ_CAP, readRemoteFile } from "./node-reader";
import { PublishRefusedError } from "./publish-refusals";
import { raiseFloor } from "./sequence-floor";

/** Node reads of the ancestor lookup: the listing of the immutable root and its history folder, and the entries' bytes. */
export type ForkClient = Pick<KuboClient, "ipfsLs" | "gatewayStream">;

/** What the host reports about the base of a fork resolution. */
export interface ForkResolutionReport {
  /** The common ancestor was found and used as `B`. */
  readonly ancestorUsed: boolean;
  /** Why there is no ancestor; fixed text for the host to show. `undefined` when it was used. */
  readonly note: string | undefined;
}

export interface ForkBase {
  /** `B` for the plan: the ancestor's entries and no mtimes, or `undefined` when there is no ancestor. */
  readonly base: PullBase | undefined;
  readonly report: ForkResolutionReport;
}

const WITHOUT_ANCESTOR = "every file that differs from the node's was kept as a conflict copy and the node's text takes its path";

const NO_RECORD_NOTE = `this device has no record of the manifest it built on (it pulled, or its state predates the record), so there is no common ancestor; ${WITHOUT_ANCESTOR}`;
const noEntryNote = (sequence: number): string =>
  `no history entry carries the sequence prefix ${sequence} (the history was pruned, or it uses names without a sequence prefix), so there is no common ancestor; ${WITHOUT_ANCESTOR}`;
const noMatchNote = (sequence: number): string =>
  `the history entries at sequence ${sequence} do not identify the manifest this device built on (none authenticates for this vault, or none or several match it), so there is no common ancestor; ${WITHOUT_ANCESTOR}`;

const NONE = (note: string): ForkBase => ({ base: undefined, report: { ancestorUsed: false, note } });

/** A history entry the node holds that cannot serve as an ancestor: it is gone, too large, not a file, or does not authenticate as a manifest this build reads. */
function isNotAnAncestor(error: unknown): boolean {
  if (error instanceof KuboHttpError) return error.status === 404;
  if (error instanceof PublishRefusedError) return error.code === "remote-object-too-large" || error.code === "remote-object-invalid";
  if (error instanceof ManifestFormatError || error instanceof OversizeInputError || isUnreadableManifest(error)) return true;
  return error instanceof CryptoError && (error.code === "unsupported-format" || error.code === "vault-mismatch");
}

/** The authenticated manifest of a history entry, or `undefined` when the entry is not a genuine manifest of this vault at this sequence. */
async function genuineEntry(client: ForkClient, keys: VaultKeys, entry: MfsEntry, sequence: number, vaultId: string): Promise<EncryptedManifest | undefined> {
  try {
    const bytes: Bytes = await readRemoteFile(client, entry, "a history entry", MANIFEST_READ_CAP);
    const manifest = await decodeManifestFile(keys, bytes);
    const named = { name: entry.name, cid: entry.cid, sequence };
    return manifest.vaultId === vaultId && prefixMatchesSequence(named, manifest.sequence) ? manifest : undefined;
  } catch (error) {
    if (isNotAnAncestor(error)) return undefined;
    throw error;
  }
}

/** The history entries (listing entries) of the immutable root whose name carries the prefix `sequence`. */
async function entriesAtPrefix(client: ForkClient, rootCid: string, sequence: number): Promise<readonly MfsEntry[]> {
  const folder = (await client.ipfsLs(`/ipfs/${rootCid}`)).filter((entry) => entry.name === "manifests");
  if (folder.length !== 1 || folder[0]?.type !== "directory") return [];
  const listed = await client.ipfsLs(`/ipfs/${rootCid}/manifests`);
  const wanted = new Set(entriesAtSequence(listed.map((entry) => entry.name), sequence).map((entry) => entry.name));
  return listed.filter((entry) => wanted.has(entry.name));
}

export interface ForkBaseInput {
  readonly client: ForkClient;
  readonly keys: VaultKeys;
  /** The authenticated node manifest (Y). */
  readonly node: EncryptedManifest;
  /** The immutable root the name resolved to. */
  readonly rootCid: string;
  /** The identity of the manifest this device built its own on; `null` for a first publish, after a pull, and for an upgraded state. */
  readonly previousIdentity: string | null;
}

/** Find the common ancestor and say what `B` is. Reads only. */
export async function resolveForkBase(input: ForkBaseInput): Promise<ForkBase> {
  const { client, keys, node, rootCid, previousIdentity } = input;
  if (previousIdentity === null) return NONE(NO_RECORD_NOTE);
  const sequence = node.sequence - 1;
  const entries = await entriesAtPrefix(client, rootCid, sequence);
  if (entries.length === 0) return NONE(noEntryNote(sequence));
  const matching: EncryptedManifest[] = [];
  for (const entry of entries) {
    const manifest = await genuineEntry(client, keys, entry, sequence, node.vaultId);
    if (manifest !== undefined && manifestIdentity(manifest) === previousIdentity) matching.push(manifest);
  }
  const [ancestor] = matching;
  if (matching.length !== 1 || ancestor === undefined) return NONE(noMatchNote(sequence));
  return { base: { files: ancestor.files, mtimes: {} }, report: { ancestorUsed: true, note: undefined } };
}

/**
 * Write the floor with the node manifest's identity. Fork resolution is the only operation that changes the identity at a
 * sequence, so it is the only caller of the floor's replace-at-equal write. Call it after the fetch and before the state.
 */
export async function raiseForkFloor(store: DeviceStore, node: EncryptedManifest, identity: string, at: number): Promise<void> {
  await raiseFloor(store, node.vaultId, { sequence: node.sequence, identity, at }, { forkResolution: true });
}
