import type { Bytes, HostKv } from "../../src/core/host-bridge";
import { utf8, type VaultKeys } from "../../src/crypto";
import { serializeCanonical, type JsonValue } from "../../src/crypto/strict-json";
import { DEFAULT_IPNS_TTL } from "../../src/kubo";
import { decodeManifestFile } from "../../src/sync/encrypted-manifest";
import { historyFileName } from "../../src/sync/history-names";
import { sha256Hex } from "../../src/sync/hash";
import {
  buildPruneJournal,
  buildRewrapJournal,
  readMaintenanceJournal,
  writeMaintenanceJournal,
  type MaintenanceJournal,
  type PruneJournal,
  type RewrapJournal,
} from "../../src/sync/maintenance-journal";
import { createMaintenanceNode, type MaintenanceNode } from "../../src/sync/maintenance-node";
import { createSnapshotVerifier } from "../../src/sync/read-back";
import { beginMaintenance, driveMaintenance, type DriveOutcome, type RepublishDeps } from "../../src/sync/republish-root";
import { rootFileNames } from "../../src/sync/root-files";
import { buildRootState, readRootState, writeRootState, type RootState } from "../../src/sync/root-state";
import { rootDigest } from "../../src/sync/vault-keys";
import { createFakeNode } from "./fake-kubo";
import { KEY, ROOT, createRig, seedVault, type Rig } from "./publish-rig";

export const OWNED = "k51owned";
export const KEYSLOTS_PATH = `${ROOT}/keyslots.json`;
export const MANIFEST_PATH = `${ROOT}/manifest.enc`;
const NOW_ISO = "2026-10-03T10:00:00.000Z";

/** A node's mutating requests, by command. The reads (`stat`, `ls`, `GET`, `nameResolve`, `keyList`) are not listed. */
export const MUTATING = /^(write|rm|pin|publish|keyGen) /;
export const mutatingCalls = (rig: Rig): string[] => rig.node.calls.filter((call) => MUTATING.test(call));

/** A vault with two published sequences (two history files), the key recorded and the local state at sequence 2. */
export async function publishedRig(): Promise<Rig> {
  const rig = createRig({ node: createFakeNode([{ name: KEY, id: OWNED }]) });
  rig.owned.push(OWNED);
  seedVault(rig.host);
  await rig.init();
  await rig.publish();
  rig.host.put("notes/second.md", "second", 3000);
  await rig.publish();
  rig.node.calls.length = 0;
  rig.node.mutations = 0;
  return rig;
}

/**
 * A `keyslots.json` of the same vault that differs from `bytes` in the slot identifier. It parses (so it counts as a key-slot file of the
 * vault) and it does not unlock: a stand-in for a rewrapped file in the tests of the republish primitive, which never derives a key.
 */
export function variantKeySlots(bytes: Bytes, tag: string): Bytes {
  const document = JSON.parse(new TextDecoder().decode(bytes)) as { slots: { id: string }[] };
  const first = document.slots[0] as { id: string };
  const flipped = tag.repeat(32).slice(0, 4) + first.id.slice(4);
  return utf8(`${serializeCanonical({ ...document, slots: [{ ...first, id: flipped }, ...document.slots.slice(1)] } as unknown as JsonValue, 2)}\n`);
}

export const oldKeySlotsOf = (rig: Rig): Bytes => rig.node.files.get(KEYSLOTS_PATH) as Bytes;
export const historyNamesOf = (rig: Rig): string[] =>
  [...rig.node.files.keys()].filter((path) => path.startsWith(`${ROOT}/manifests/`)).map((path) => path.slice(`${ROOT}/manifests/`.length)).sort();

export function maintenanceNodeOf(rig: Rig, beforeWrite: () => void = () => undefined): MaintenanceNode {
  return createMaintenanceNode({ client: rig.node.client, mfsRoot: ROOT, key: KEY, ttl: DEFAULT_IPNS_TTL, keyId: () => OWNED, keyCreated: () => false, beforeWrite });
}

/** The deps of the primitive over a rig. `readBackKeySlots` is the `keyslots.json` the snapshot must hold (the new bytes for a rewrap). */
export function maintenanceDeps(rig: Rig, keys: VaultKeys, readBackKeySlots: Bytes, options: { readonly kv?: HostKv; readonly beforeWrite?: () => void } = {}): RepublishDeps {
  return {
    node: maintenanceNodeOf(rig, options.beforeWrite),
    kv: options.kv ?? rig.host.kv,
    decodeManifest: (bytes) => decodeManifestFile(keys, bytes),
    verifySnapshot: createSnapshotVerifier({ client: rig.node.client, keySlots: readBackKeySlots, written: new Map() }),
  };
}

async function beginOn(rig: Rig, deps: RepublishDeps) {
  const state = (await readRootState(rig.host.kv, ROOT)) as RootState;
  return beginMaintenance(deps, {
    target: { mfsRoot: ROOT, key: KEY, vaultId: state.vaultId, keyslotsSha256: state.keyslotsSha256 },
    state,
    floor: undefined,
    key: { absent: false },
    startedAt: NOW_ISO,
  });
}

/** The start of a rewrap as a command would make it: the guards, then the journal at `journaled`. Nothing on the node is changed. */
export async function startRewrap(rig: Rig, keys: VaultKeys, newKeySlots: Bytes, kv?: HostKv): Promise<{ readonly deps: RepublishDeps; readonly journal: RewrapJournal }> {
  const deps = maintenanceDeps(rig, keys, newKeySlots, { kv });
  const start = await beginOn(rig, deps);
  const journal = buildRewrapJournal(start.facts, { oldKeySlots: oldKeySlotsOf(rig), newKeySlots });
  await writeMaintenanceJournal(deps.kv, journal);
  return { deps, journal };
}

export async function startPrune(rig: Rig, keys: VaultKeys, removals: readonly string[], kv?: HostKv): Promise<{ readonly deps: RepublishDeps; readonly journal: PruneJournal }> {
  const deps = maintenanceDeps(rig, keys, oldKeySlotsOf(rig), { kv });
  const start = await beginOn(rig, deps);
  const journal = buildPruneJournal(start.facts, removals);
  await writeMaintenanceJournal(deps.kv, journal);
  return { deps, journal };
}

export async function rewrapOnce(rig: Rig, keys: VaultKeys, newKeySlots: Bytes, kv?: HostKv): Promise<DriveOutcome> {
  const { deps, journal } = await startRewrap(rig, keys, newKeySlots, kv);
  return driveMaintenance(deps, journal);
}

export async function pruneOnce(rig: Rig, keys: VaultKeys, removals: readonly string[], kv?: HostKv): Promise<DriveOutcome> {
  const { deps, journal } = await startPrune(rig, keys, removals, kv);
  return driveMaintenance(deps, journal);
}

/** What a rerun does after a kill: read the journal from the host and drive it on. `undefined` when the kill came before the journal existed. */
export async function resumeFromJournal(rig: Rig, keys: VaultKeys, readBackKeySlots: Bytes, kv?: HostKv): Promise<DriveOutcome | undefined> {
  const read = await readMaintenanceJournal(rig.host.kv, ROOT);
  if (read.kind === "none") return undefined;
  if (read.kind === "damaged") throw new Error("the maintenance journal is damaged");
  return driveMaintenance(maintenanceDeps(rig, keys, readBackKeySlots, { kv }), read.journal);
}

export async function journalOf(rig: Rig): Promise<MaintenanceJournal | undefined> {
  const read = await readMaintenanceJournal(rig.host.kv, ROOT);
  return read.kind === "ok" ? read.journal : undefined;
}

/** The root CID the publication name points at on the node. */
export const publishedRoot = (rig: Rig): string => (rig.node.published.get(OWNED) ?? "").replace("/ipfs/", "");

/** Copy a tree under another MFS path, with the given overrides, and return its root CID; the copy's files are removed again, its blocks stay readable. */
export function winnerRootOf(rig: Rig, overrides: ReadonlyMap<string, Bytes>): string {
  const copy = "/obsidian-vault-sync/winner-root";
  const added: string[] = [];
  for (const [path, data] of rig.node.files) {
    if (!path.startsWith(`${ROOT}/`)) continue;
    const target = `${copy}${path.slice(ROOT.length)}`;
    rig.node.files.set(target, overrides.get(path.slice(ROOT.length + 1)) ?? data);
    added.push(target);
  }
  rig.node.files.set(`${copy}/manifests/${historyFileName(99, "b".repeat(40))}`, new Uint8Array([9]));
  added.push(`${copy}/manifests/${historyFileName(99, "b".repeat(40))}`);
  const cid = rig.node.cidOf(copy) as string;
  for (const path of added) rig.node.files.delete(path);
  return cid;
}

/** Local copy of the key slots, the state's hash and the journal: what the command does after `published` (the tail of task 1.4). */
export async function finishRewrapLocally(rig: Rig, newKeySlots: Bytes): Promise<void> {
  const state = (await readRootState(rig.host.kv, ROOT)) as RootState;
  await rig.host.fs.write(`.ipfs-sync/keyslots.${await rootDigest(ROOT)}.json`, newKeySlots);
  await writeRootState(rig.host.kv, buildRootState({ ...state, keyslotsSha256: await sha256Hex(newKeySlots) }));
  await rig.host.kv.delete(rootFileNames(ROOT).maintenance);
}
