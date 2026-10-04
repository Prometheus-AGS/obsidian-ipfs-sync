import { assertMfsMutationPath, assertValidKeyName, validateMfsRoot } from "../core/config";
import type { HostKv } from "../core/host-bridge";
import { openVault, VaultKeysError, type OpenedVault, type UnlockedVault } from "./vault-keys";
import { DEFAULT_IPNS_TTL } from "../kubo";
import type { CommitDeps, FloorPort, PublishTarget } from "./commit-ports";
import { createCommitNode } from "./commit-node";
import { decodeManifestFile, encodeManifestFile } from "./encrypted-manifest";
import { assertPublishMarker } from "./publish-guard";
import { assertNoMaintenanceJournal } from "./maintenance-journal";
import { createRootInspector, type RootInspector } from "./node-reader";
import { noVault, passphraseRequired } from "./publish-refusals";
import { openPublicationKey, type PublicationKey } from "./publish-key";
import { resumeJournal } from "./publish-resume";
import type { PublishDeps, PublishOptions } from "./publish-types";
import { createSnapshotVerifier } from "./read-back";
import { RootStateError } from "./local-record";
import { readRootState, type RootState } from "./root-state";
import { raiseFloor } from "./sequence-floor";
import type { CanonicalPassphrase } from "../crypto";

/**
 * The first half of a publish: everything up to the point where the device knows the vault, the key, the node's
 * manifest and any interrupted publish. The order is the security property:
 *
 *   1. the fixture marker, then the passphrase check (a passphrase or an unlocked session is present), both before a single request;
 *   2. the keyless idle check (`idle-check.ts`, run by `publish.ts` before this session opens): it sends read-only requests
 *      (`files/stat`, `key/list`) and returns "unchanged" without a derivation, so on that path a WRONG passphrase is not
 *      detected before requests are sent, and not detected at all. It never writes and it never reads a file body;
 *   3. the local record (an unreadable one is treated as missing only with --repair);
 *   4. unlock: with a local copy of the key slots a wrong passphrase fails before any request, and the node's
 *      slots are compared with the copy before any derivation on node-supplied parameters;
 *   5. the publication key is looked up (an owned key only; a missing one is created later, just before the first
 *      write, so a refusal never leaves a new key behind);
 *   6. the journal of an interrupted publish is finished or reconciled.
 */

export interface CheckedTarget {
  readonly mfsRoot: string;
  readonly keyName: string;
  readonly passphrase?: CanonicalPassphrase;
  /** Keys a plugin session unlocked earlier; read once per run so a lock during the run cannot change the answer. */
  readonly unlocked?: UnlockedVault;
}

export interface PublishSession {
  readonly target: PublishTarget;
  readonly opened: OpenedVault;
  readonly key: PublicationKey;
  readonly inspector: RootInspector;
  /** The local record after any resume; undefined before the first publish to this root. */
  readonly state: RootState | undefined;
  readonly commit: CommitDeps;
  /** `--repair` deferred an interrupted publish that resume cannot reconcile; its journal is still there. */
  readonly journalDeferred: boolean;
  /** The sequence of the journal `--repair` set aside, when there was one. */
  readonly deferredSequence: number | undefined;
  /** Blobs written in this run (node name to CID), read back before the pin. Filled by the transfer step. */
  readonly written: Map<string, string>;
  readonly beforeWrite: () => void;
}

/** Marker, key name, MFS root and passphrase, in that order, with no request sent. */
export async function checkTarget(deps: PublishDeps, options: PublishOptions): Promise<CheckedTarget> {
  await assertPublishMarker(deps.host.fs);
  const keyName = assertValidKeyName(options.keyName);
  // Publishing the confinement base itself would announce every other folder under it.
  const mfsRoot = assertMfsMutationPath(validateMfsRoot(options.mfsRoot));
  const unlocked = options.unlocked?.();
  if (options.passphrase === undefined && unlocked === undefined) throw passphraseRequired();
  return { mfsRoot, keyName, passphrase: options.passphrase, unlocked };
}

/** The local record, or undefined. With --repair an unreadable record counts as missing (the node is then the baseline). */
async function loadState(kv: Pick<HostKv, "get">, mfsRoot: string, repair: boolean): Promise<RootState | undefined> {
  try {
    return await readRootState(kv, mfsRoot);
  } catch (error) {
    if (repair && error instanceof RootStateError) return undefined;
    throw error;
  }
}

async function unlock(deps: PublishDeps, options: PublishOptions, checked: CheckedTarget, state: RootState | undefined, inspector: RootInspector): Promise<OpenedVault> {
  try {
    return await openVault({
      fs: deps.host.fs,
      mfsRoot: checked.mfsRoot,
      passphrase: checked.passphrase,
      unlocked: checked.unlocked,
      local: { hasState: state !== undefined, vaultId: state?.vaultId, keyslotsSha256: state?.keyslotsSha256 },
      node: {
        fetchKeySlots: () => inspector.readKeySlots(),
        manifestPresent: async () => (await inspector.view()).entries.has("manifest.enc"),
      },
      recoverSlots: options.recoverSlots,
      confirmRecover: options.confirmRecover,
      costPolicy: options.costPolicy,
      onProgress: options.onUnlockProgress,
    });
  } catch (error) {
    // `create` is never passed, so this is "no vault here": the way to make one is `ipfs-sync init`.
    if (error instanceof VaultKeysError && error.code === "creation-not-requested") throw noVault();
    throw error;
  }
}

/** The sequence floor as the commit protocol sees it: `finishPublish` raises it right before it writes the state. */
function floorPort(deps: PublishDeps): FloorPort | undefined {
  const store = deps.deviceStore;
  if (store === undefined) return undefined;
  return { raise: async (vaultId, sequence, identity) => void (await raiseFloor(store, vaultId, { sequence, identity, at: deps.host.timeNow() })) };
}

function commitDeps(deps: PublishDeps, checked: CheckedTarget, opened: OpenedVault, written: ReadonlyMap<string, string>, key: PublicationKey, beforeWrite: () => void): CommitDeps {
  const floor = floorPort(deps);
  return {
    node: createCommitNode({
      client: deps.client,
      mfsRoot: checked.mfsRoot,
      key: checked.keyName,
      ttl: DEFAULT_IPNS_TTL,
      keyId: () => key.id(),
      keyCreated: () => key.created(),
      beforeWrite,
    }),
    kv: deps.host.kv,
    decodeManifest: (bytes) => decodeManifestFile(opened.keys, bytes),
    encodeManifest: async (manifest) => (await encodeManifestFile(opened.keys, manifest)).file,
    verifySnapshot: createSnapshotVerifier({ client: deps.client, keySlots: opened.keySlots, written }),
    now: () => deps.host.timeNow(),
    ...(floor === undefined ? {} : { floor }),
  };
}

export async function openSession(deps: PublishDeps, options: PublishOptions, checked: CheckedTarget): Promise<PublishSession> {
  // A key-management operation in flight (maintenance.<h>.json) pauses publish: refused before the record is read and before any derivation.
  await assertNoMaintenanceJournal(deps.host.kv, checked.mfsRoot);
  const state = await loadState(deps.host.kv, checked.mfsRoot, options.repair === true);
  const inspector = createRootInspector(deps.client, checked.mfsRoot);
  const opened = await unlock(deps, options, checked, state, inspector);
  const key = await openPublicationKey(deps.client, checked.keyName, options.ownedKeys, options.recordOwnedKey);
  const written = new Map<string, string>();
  const beforeWrite = options.assertHeld ?? ((): void => undefined);
  const target: PublishTarget = { mfsRoot: checked.mfsRoot, key: checked.keyName, vaultId: opened.vaultId, keyslotsSha256: opened.keySlotsSha256 };
  const commit = commitDeps(deps, checked, opened, written, key, beforeWrite);
  // The key is created only by the first write of a fresh publish (`transfer`), never here: a refused run leaves no key behind, and a
  // resume that needs the key finds it or stops at the check before `name/publish`.
  await deps.beforeFirstWrite?.();
  const resumed = await resumeJournal(commit, { target, state, repair: options.repair === true });
  const settled = resumed.kind === "settled" || resumed.kind === "completed" || resumed.kind === "adopted" ? resumed.state : state;
  // A resume that finished or reconciled a publish changed the node; what was listed before it is stale.
  const touchedNode = resumed.kind === "completed" || resumed.kind === "adopted" || resumed.kind === "settled";
  const journalDeferred = resumed.kind === "deferred";
  const deferredSequence = resumed.kind === "deferred" ? resumed.sequence : undefined;
  const nodeView = touchedNode ? createRootInspector(deps.client, checked.mfsRoot) : inspector;
  return { target, opened, key, inspector: nodeView, state: settled, commit, journalDeferred, deferredSequence, written, beforeWrite };
}
