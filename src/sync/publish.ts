import { assertFixtureVault, assertMfsMutationPath, assertValidKeyName, FIXTURE_MARKER, validateMfsRoot } from "../core/config";
import type { HostBridge } from "../core/host-bridge";
import type { SyncEventBus } from "../core/events";
import { isMissingPathError, type KuboClient } from "../kubo";
import { planDelta, type DeltaPlan, type SkippedFile } from "./diff";
import { createExclusionMatcher, excludesHash } from "./exclusions";
import { buildManifest, serializeManifest, type Manifest, type ManifestFile } from "./manifest";
import { EmptyVaultError } from "./publish-errors";
import { resolvePublicationKey } from "./publish-key";
import { transferRemovals, transferWrites, type TransferContext } from "./publish-transfer";
import { scanVault } from "./scan";
import { buildState, readState, writeState, type LocalState } from "./state";

/** The kubo operations a publish uses. Note what is absent: no key or pin removal. */
export type PublishClient = Pick<
  KuboClient,
  "filesWrite" | "filesStat" | "filesRm" | "keyList" | "keyGen" | "pinAdd" | "namePublish"
>;

export interface PublishDeps {
  readonly client: PublishClient;
  readonly host: HostBridge;
  readonly bus: SyncEventBus;
}

export interface PublishOptions {
  readonly mfsRoot: string;
  readonly keyName: string;
  /** IDs of keys this installation owns (config file plus `--owned-key` for this run). */
  readonly ownedKeys: readonly string[];
  /** Called with the ID of a key this run generated; it must persist it or throw. */
  readonly recordOwnedKey: (keyId: string) => Promise<void>;
  readonly extraExclusions?: readonly string[];
  readonly concurrency?: number;
}

export interface PublishResult {
  /** False when nothing changed: no manifest was created and no IPNS record was published. */
  readonly published: boolean;
  readonly written: number;
  readonly removed: number;
  /** Files left out because the host refused to read them (over its read cap). Empty on hosts without a cap. */
  readonly skipped: readonly SkippedFile[];
  readonly keyId: string;
  readonly keyCreated: boolean;
  /** CID of `<mfsRoot>` (the IPNS value). Present when published. */
  readonly rootCid?: string;
  /** CID of `<mfsRoot>/current` (the manifest's rootCID). Present when published. */
  readonly currentCid?: string;
}

const IPNS_TTL = "5m";
const DEVICE_ENV = "IPFS_SYNC_DEVICE";
const DEFAULT_DEVICE = "cli";

async function hasFixtureMarker(host: HostBridge): Promise<boolean> {
  return (await host.fs.stat(FIXTURE_MARKER))?.kind === "file";
}

/** The last-published record applies only to the destination it describes. */
function applicableState(state: LocalState | undefined, mfsRoot: string, keyName: string): LocalState | undefined {
  return state !== undefined && state.mfsRoot === mfsRoot && state.key === keyName ? state : undefined;
}

async function manifestExists(client: PublishClient, path: string): Promise<boolean> {
  try {
    await client.filesStat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

/** `manifest.json` is the latest; `manifests/<currentCID>.json` is history and is never overwritten. */
async function storeManifest(client: PublishClient, mfsRoot: string, manifest: Manifest): Promise<void> {
  const bytes = new TextEncoder().encode(serializeManifest(manifest));
  await client.filesWrite(assertMfsMutationPath(`${mfsRoot}/manifest.json`), bytes);
  const archived = assertMfsMutationPath(`${mfsRoot}/manifests/${manifest.rootCID}.json`);
  if (!(await manifestExists(client, archived))) await client.filesWrite(archived, bytes);
}

async function buildNextManifest(
  deps: PublishDeps,
  plan: DeltaPlan,
  written: Readonly<Record<string, ManifestFile>>,
  currentCid: string,
  extra: readonly string[],
): Promise<Manifest> {
  return buildManifest({
    rootCid: currentCid,
    publishedAt: new Date(deps.host.timeNow()).toISOString(),
    device: deps.host.envRead(DEVICE_ENV) ?? DEFAULT_DEVICE,
    files: { ...plan.unchanged, ...written },
    excludesHash: await excludesHash(extra),
  });
}

function emitChanges(bus: SyncEventBus, plan: DeltaPlan): void {
  for (const write of plan.writes) bus.emit("file.changed", { path: write.path, kind: write.kind, sha256: write.sha256 });
  for (const path of plan.removed) bus.emit("file.changed", { path, kind: "removed" });
}

interface Preparation {
  readonly mfsRoot: string;
  readonly keyName: string;
  readonly previous: LocalState | undefined;
}

async function prepare(deps: PublishDeps, options: PublishOptions): Promise<Preparation> {
  assertFixtureVault(await hasFixtureMarker(deps.host));
  const keyName = assertValidKeyName(options.keyName);
  // Publishing the confinement base itself would announce every other folder under it.
  const mfsRoot = assertMfsMutationPath(validateMfsRoot(options.mfsRoot));
  const previous = applicableState(await readState(deps.host.kv), mfsRoot, keyName);
  return { mfsRoot, keyName, previous };
}

/** Send the changes, then build, store, pin and publish the snapshot. Returns the published CIDs. */
async function publishSnapshot(
  deps: PublishDeps,
  options: PublishOptions,
  prep: Preparation,
  plan: DeltaPlan,
): Promise<{ readonly manifest: Manifest; readonly rootCid: string }> {
  const { client } = deps;
  const currentPath = `${prep.mfsRoot}/current`;
  const ctx: TransferContext = { client, fs: deps.host.fs, currentPath, concurrency: options.concurrency };
  const written = await transferWrites(ctx, plan.writes);
  await transferRemovals(ctx, plan.removed);
  const currentCid = (await client.filesStat(currentPath)).cid;
  const manifest = await buildNextManifest(deps, plan, written, currentCid, options.extraExclusions ?? []);
  await storeManifest(client, prep.mfsRoot, manifest);
  const rootCid = (await client.filesStat(prep.mfsRoot)).cid;
  await client.pinAdd(rootCid);
  await client.namePublish(prep.keyName, rootCid, IPNS_TTL);
  return { manifest, rootCid };
}

/**
 * Delta publish of the vault behind `deps.host`. Order: fixture guard, key, scan and diff,
 * writes (verified), removals, snapshot CID, manifest, root CID, pin, `name/publish`, local
 * state, events. Any failure before `name/publish` leaves the IPNS record and the local state
 * as they were, so a rerun converges.
 */
export async function publishVault(deps: PublishDeps, options: PublishOptions): Promise<PublishResult> {
  const startedAt = deps.host.timeNow();
  const prep = await prepare(deps, options);
  const key = await resolvePublicationKey(deps.client, prep.keyName, options.ownedKeys, options.recordOwnedKey);
  const scanned = await scanVault(deps.host.fs, createExclusionMatcher(options.extraExclusions));
  const { previous } = prep;
  const plan = await planDelta(deps.host.fs, scanned, previous);

  const base = { keyId: key.id, keyCreated: key.created, written: plan.writes.length, removed: plan.removed.length, skipped: plan.skipped };
  if (previous !== undefined && plan.writes.length === 0 && plan.removed.length === 0 && !key.created) {
    // Nothing to send. Remember new mtimes of touched-but-identical files so the next run skips hashing them.
    if (plan.hashed > 0) await writeState(deps.host.kv, buildState({ ...previous, mtimes: plan.mtimes }));
    return { ...base, published: false };
  }
  if (previous === undefined && Object.keys(plan.unchanged).length + plan.writes.length === 0) throw new EmptyVaultError();

  const { manifest, rootCid } = await publishSnapshot(deps, options, prep, plan);
  await writeState(
    deps.host.kv,
    buildState({ mfsRoot: prep.mfsRoot, key: prep.keyName, rootCid, manifest, mtimes: plan.mtimes }),
  );
  emitChanges(deps.bus, plan);
  deps.bus.emit("publish.complete", {
    rootCid,
    manifestCid: manifest.rootCID,
    written: plan.writes.length,
    removed: plan.removed.length,
    durationMs: deps.host.timeNow() - startedAt,
  });
  return { ...base, published: true, rootCid, currentCid: manifest.rootCID };
}
