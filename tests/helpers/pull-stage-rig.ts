import { createSyncEventBus } from "../../src/core/events";
import type { KuboClient } from "../../src/kubo";
import { gatewayBlobSource } from "../../src/sync/blob-source";
import type { BlobSources } from "../../src/sync/encrypted-pull-fetch";
import type { EncryptedPullOutcome, VerifiedPull } from "../../src/sync/encrypted-pull";
import { pullEncryptedVault, type PullStageResult, type PullVaultDeps, type PullVaultOptions } from "../../src/sync/encrypted-pull-stage";
import { publishVault, type PublishResult } from "../../src/sync/publish";
import { readRootState, type RootState } from "../../src/sync/root-state";
import { KEY, ROOT, decodeText, type Rig } from "./publish-rig";
import { NOW, type Puller } from "./encrypted-pull-rig";
import type { MemoryHost } from "./memory-host";

/** Test helpers for the decrypting pull's stage (mvp-07a 4.6b): a full pull of the rig's node into a second device's directory. */

/** The CLI's source: one streaming request per blob. */
export function streamingSources(client: Pick<KuboClient, "gatewayStream">): BlobSources {
  return { source: (location) => gatewayBlobSource(client, location) };
}

/** Part-file and copy names that do not depend on randomness. */
export function counterIds(prefix = "id"): () => string {
  let next = 0;
  return () => `${prefix}-${(next += 1)}`;
}

export interface StageOverrides {
  readonly options?: Partial<PullVaultOptions>;
  readonly deps?: Partial<PullVaultDeps>;
}

/** One complete pull of `rig`'s node by `puller`. By default: the name target, the reference passphrase, `--accept-first-pull`, streamed blobs. */
export function runVaultPull(rig: Rig, puller: Puller, overrides: StageOverrides = {}): Promise<EncryptedPullOutcome<PullStageResult>> {
  const client = overrides.deps?.client ?? rig.node.client;
  return pullEncryptedVault(
    {
      client,
      host: puller.host,
      deviceStore: puller.store,
      lockFile: puller.locks.file,
      lockContext: puller.locks.ctx,
      now: () => NOW,
      sources: streamingSources(client),
      newId: counterIds("part"),
      ...overrides.deps,
    },
    {
      mfsRoot: ROOT,
      keyName: KEY,
      ownedKeys: rig.owned,
      target: { kind: "name" },
      flags: {},
      passphrase: rig.passphrase,
      acceptFirstPull: true,
      ...overrides.options,
    },
  );
}

export interface Pulled {
  readonly verified: VerifiedPull;
  readonly result: PullStageResult;
}

/** The completed pull, or a failure that prints the stop. */
export function pulledOf(outcome: EncryptedPullOutcome<PullStageResult>): Pulled {
  if (outcome.kind !== "completed") throw new Error(`expected the pull to complete, it stopped: ${outcome.stop.reason}: ${outcome.stop.message}`);
  return { verified: outcome.verified, result: outcome.result };
}

/** The vault files of a directory (every file that is not under `.ipfs-sync/` and not the marker), path to text. */
export function vaultTexts(host: MemoryHost): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const [path, file] of host.files) {
    if (path.startsWith(".ipfs-sync/") || path === ".ipfs-sync-fixture") continue;
    texts[path] = decodeText(file.data);
  }
  return texts;
}

/** Every file of the rig's own vault (the publisher's side), for byte-for-byte comparison. */
export function sourceTexts(rig: Rig): Record<string, string> {
  const texts: Record<string, string> = {};
  for (const [path, file] of rig.host.files) {
    if (path.startsWith(".ipfs-sync/") || path === ".ipfs-sync-fixture" || path.startsWith(".trash/") || path.startsWith(".obsidian/")) continue;
    texts[path] = decodeText(file.data);
  }
  return texts;
}

export async function stateOf(host: MemoryHost): Promise<RootState | undefined> {
  return readRootState(host.kv, ROOT);
}

/** Leftover temporary files of the pull. */
export function partFiles(host: MemoryHost): string[] {
  return [...host.files.keys()].filter((path) => path.startsWith(".ipfs-sync/tmp/"));
}

/** The pulled directory publishes as the second device: the marker is replaced by hand, as the documentation says. */
export function publishAsSecondDevice(rig: Rig, puller: Puller): Promise<PublishResult> {
  puller.host.put(".ipfs-sync-fixture", "fixture\n");
  return publishVault(
    { client: rig.node.client, host: puller.host, bus: createSyncEventBus() },
    { mfsRoot: ROOT, keyName: KEY, ownedKeys: rig.owned, recordOwnedKey: async () => undefined, passphrase: rig.passphrase },
  );
}
