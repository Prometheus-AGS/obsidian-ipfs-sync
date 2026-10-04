import type { HostKv } from "../../src/core/host-bridge";
import type { VaultKeys } from "../../src/crypto";
import { decodeManifestFile, encodeManifestFile, type EncryptedManifest } from "../../src/sync/encrypted-manifest";
import { historyFileName } from "../../src/sync/history-names";
import { manifestIdentity } from "../../src/sync/manifest-identity";
import { buildRootState, readRootState, writeRootState } from "../../src/sync/root-state";
import type { FakeNode } from "./fake-kubo";

/**
 * A node whose `manifests/` folder holds a long history, without publishing that many times. The vault's current manifest is re-sequenced to
 * `total`; the newest `GENUINE_WINDOW` history files are genuine encrypted manifests of that vault (sequence `total - 19` to `total`, each named by its
 * own sequence), every older file is bytes that authenticate as nothing, as a node holding old history would still list them. `manifest.enc` and the
 * device's record are moved to `total` so the device is up to date. Names only claim a sequence; the engine under test must not rely on the older bytes.
 */

export const GENUINE_WINDOW = 20;

const junkCid = (index: number): string => `bafyjunk${String(index).padStart(40, "0")}`;
const legacyCid = (index: number): string => `bafylegacy${String(index).padStart(36, "0")}`;

export const junkHistoryName = (sequence: number): string => historyFileName(sequence, junkCid(sequence));
export const legacyHistoryName = (index: number): string => `${legacyCid(index)}.enc`;

export interface SeedHistoryInput {
  readonly node: FakeNode;
  readonly kv: HostKv;
  readonly mfsRoot: string;
  readonly keys: VaultKeys;
  /** The sequence of the current manifest and the number of prefixed history files. */
  readonly total: number;
  /** Legacy `<cid>.enc` names to add (bytes that authenticate as nothing). */
  readonly legacy?: number;
  /** Sequences that get a second genuine file with another device name (what a fork leaves). Only sequences inside the genuine window. */
  readonly forks?: readonly number[];
}

export interface SeededHistory {
  /** The current manifest (sequence `total`). */
  readonly manifest: EncryptedManifest;
  /** Every history name now on the node, sorted. */
  readonly names: readonly string[];
  /** The manifest at another sequence of the genuine window, as the history file at that sequence holds it. */
  readonly manifestAt: (sequence: number) => EncryptedManifest;
}

export async function seedHistory(input: SeedHistoryInput): Promise<SeededHistory> {
  const { node, kv, mfsRoot, keys, total } = input;
  const folder = `${mfsRoot}/manifests/`;
  for (const path of [...node.files.keys()]) if (path.startsWith(folder)) node.files.delete(path);
  const base = await decodeManifestFile(keys, node.files.get(`${mfsRoot}/manifest.enc`) as Uint8Array);
  const manifestAt = (sequence: number): EncryptedManifest => ({ ...base, sequence });
  const firstGenuine = Math.max(1, total - GENUINE_WINDOW + 1);
  for (let sequence = 1; sequence <= total; sequence += 1) {
    if (sequence < firstGenuine) {
      node.files.set(`${folder}${junkHistoryName(sequence)}`, new Uint8Array(48).fill(sequence % 251));
      continue;
    }
    const { file } = await encodeManifestFile(keys, manifestAt(sequence));
    node.files.set(`${folder}${historyFileName(sequence, base.rootCID)}`, file);
    if (sequence === total) node.files.set(`${mfsRoot}/manifest.enc`, file);
  }
  for (const sequence of input.forks ?? []) {
    const { file } = await encodeManifestFile(keys, { ...manifestAt(sequence), device: "fork-device" });
    node.files.set(`${folder}${historyFileName(sequence, "bafyfork0000000000000000000000000000000000000000")}`, file);
  }
  for (let index = 0; index < (input.legacy ?? 0); index += 1) node.files.set(`${folder}${legacyHistoryName(index)}`, new Uint8Array(40).fill(index % 251));
  const current = manifestAt(total);
  const state = await readRootState(kv, mfsRoot);
  if (state === undefined) throw new Error("the rig has no record to move");
  const identity = manifestIdentity(current);
  await writeRootState(kv, buildRootState({ ...state, sequence: total, manifest: current, manifestIdentity: identity, previousIdentity: manifestIdentity(manifestAt(total - 1)), highestSequence: total, highestIdentity: identity }));
  // The node derives blocks lazily from the paths it was given.
  node.cidOf(mfsRoot);
  const names = [...node.files.keys()].filter((path) => path.startsWith(folder)).map((path) => path.slice(folder.length)).sort();
  return { manifest: current, names, manifestAt };
}
