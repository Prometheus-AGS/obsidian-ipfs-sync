import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { ConfigError, describeAuth, type EnvMap, type SyncConfig } from "../src/core/config";
import { createSyncEventBus } from "../src/core/events";
import type { HostBridge } from "../src/core/host-bridge";
import { CryptoError, describeKdfCost, wipe, type CanonicalPassphrase, type KdfParams } from "../src/crypto";
import { KuboError, type KuboClient } from "../src/kubo";
import { createDeviceIdProvider, DeviceStoreError, type DeviceStore } from "../src/sync/device-store";
import { BlobTransferError } from "../src/sync/encrypted-transfer";
import { assertPublishMarker } from "../src/sync/publish-guard";
import { ManifestFormatError } from "../src/sync/encrypted-manifest";
import { HostNotImplementedError } from "../src/sync/host-errors";
import { publishVault, type PublishOptions, type PublishResult } from "../src/sync/publish";
import { EmptyVaultError, OwnedKeyNotRecordedError, WriteVerificationError } from "../src/sync/publish-errors";
import { acquirePublishLock, breakPublishLock, type LockFile, type PublishLock } from "../src/sync/publish-lock";
import { lockHeld, PublishRefusedError, ReadBackError } from "../src/sync/publish-refusals";
import { RootStateError } from "../src/sync/root-state";
import { SequenceFloorError } from "../src/sync/sequence-floor";
import { VaultKeysError } from "../src/sync/vault-keys";
import { withTokenCheck } from "../src/sync/lock-token-check";
import { UsageError } from "./args";
import { createLazyDeviceStore } from "./device-store-node";
import { EXIT_CHECK_FAILED, EXIT_OK, stripControlCharacters, type CliIo } from "./io";
import { HostPathError, createNodeHostBridge } from "./node-host-bridge";
import { PassphraseInputError } from "./passphrase-errors";
import { recordOwnedKey } from "./owned-keys-store";
import { createNodeLockContext, createNodeLockFile } from "./publish-lock-file";
import { refuseLinkedStateFolder } from "./state-folder-link";
import { attachHistoryRecorder, openRunHistoryStore } from "./store/recorder";

export interface PublishFlags {
  /** `--break-lock`: remove the publish lock after a confirmation, then continue. */
  readonly breakLock: boolean;
  /** `--repair`: continue past a behind or ahead refusal, or an unreadable local record, under the repair conditions. */
  readonly repair: boolean;
  /** `--recover-slots`: unlock key slots this device knows nothing about, after showing their cost. */
  readonly recoverSlots: boolean;
  /** `--allow-full-reupload`: allow uploading again more than 256 MiB of files the node lost. */
  readonly allowFullReupload: boolean;
  /** `--allow-mass-removal`: let a publish that removes every remaining entry, or more than half of them, run without asking. */
  readonly allowMassRemoval: boolean;
}

export interface PublishContext {
  readonly config: SyncConfig;
  readonly client: KuboClient;
  readonly io: CliIo;
  readonly vaultPath: string;
  readonly configPath: string;
  readonly env: EnvMap;
  readonly now: () => Date;
  /** Yields the canonicalised vault passphrase, or undefined when none is available (publish then refuses, sending nothing). */
  readonly passphrase?: () => Promise<CanonicalPassphrase | undefined>;
  readonly flags: PublishFlags;
  /** The device-local store (device id, sequence floor). Defaults to the per-user directory computed from `env`. */
  readonly deviceStore?: DeviceStore;
}

/** Failures a publish reports as a plain message with exit code 1. */
const REPORTED_FAILURES = [
  BlobTransferError,
  WriteVerificationError,
  OwnedKeyNotRecordedError,
  EmptyVaultError,
  RootStateError,
  DeviceStoreError,
  SequenceFloorError,
  PublishRefusedError,
  ReadBackError,
  VaultKeysError,
  CryptoError,
  PassphraseInputError,
  HostPathError,
  HostNotImplementedError,
  KuboError,
] as const;

export async function assertDirectory(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) throw new UsageError(`vault "${path}" is not a directory`);
  // Every command that takes a vault passes here first, before any lock, state or request: none may reach its state through a link.
  await refuseLinkedStateFolder(path);
}

function printHeader(ctx: PublishContext, vault: string): void {
  const { config, io } = ctx;
  io.out("ipfs-sync publish");
  io.out(`  vault     ${vault}`);
  io.out(`  rpc       ${config.rpc.baseUrl}  (auth: ${describeAuth(config.rpc.auth)})`);
  io.out(`  mfs root  ${config.mfsRoot}`);
  io.out(`  key       ${config.publicationKey}`);
}

function printResult(io: CliIo, result: PublishResult): void {
  if (result.keyCreated) io.out(`created key ${result.keyId} and recorded it in the config file`);
  if (!result.published) io.out("nothing changed: no new manifest, IPNS record not touched");
  if (result.rootCid !== undefined) io.out(`root CID   ${result.rootCid}  (IPNS value)`);
  if (result.currentCid !== undefined) io.out(`snapshot  ${result.currentCid}  (current/)`);
  if (result.sequence !== undefined) io.out(`sequence  ${result.sequence}`);
  for (const warning of result.warnings) io.err(`warning: ${warning}`);
  if (result.anomalies > 0) io.out(`note: ${result.anomalies} unexpected ${result.anomalies === 1 ? "entry" : "entries"} in current/ on the node were left in place`);
  io.out(`${result.written} written, ${result.removed} removed`);
  printPathLists(io, result);
}

const LISTED_PATHS = 3;

/** At most three names, control characters replaced (a carried name comes from the node), and the count of the rest. */
function namesText(paths: readonly string[]): string {
  const listed = paths.slice(0, LISTED_PATHS).map((path) => JSON.stringify(stripControlCharacters(path)));
  return `${listed.join(", ")}${paths.length > LISTED_PATHS ? ` and ${paths.length - LISTED_PATHS} more` : ""}`;
}

/** Paths left out of, or kept unchanged in, this publish: names only. */
export function printPathLists(io: CliIo, result: PublishResult): void {
  const lists: readonly (readonly [number, string, readonly string[]])[] = [
    [result.carried.length, "not published from this device (no current copy here; kept as the node has them)", result.carried],
    [result.dropped.length, "dropped from the manifest (excluded here or unsafe path)", result.dropped.map((entry) => entry.path)],
    [(result.exclusionRemoved ?? []).length, "removed because the exclusion list now matches them (not counted by the mass-removal check)", result.exclusionRemoved ?? []],
    [result.skipped.length, "skipped (over the host's read cap, or changed while being read)", result.skipped.map((file) => file.path)],
  ];
  for (const [count, what, paths] of lists) if (count > 0) io.out(`note: ${count} path${count === 1 ? "" : "s"} ${what}: ${namesText(paths)}`);
}

/** Answers for the questions the engine may ask. A run that cannot ask (no terminal) answers no. */
function askingOptions(ctx: PublishContext): Pick<PublishOptions, "confirmRepair" | "confirmRecover" | "confirmFullReupload" | "confirmMassRemoval" | "costPolicy"> {
  const { confirm } = ctx.io;
  if (confirm === undefined) return {};
  const costs = (params: readonly KdfParams[]): string => params.map(describeKdfCost).join("; ");
  return {
    confirmRepair: (warning) => confirm(`${warning} Continue?`),
    confirmRecover: (params) => confirm(`Unlocking these key slots costs ${costs(params)} of memory and time on this device. Continue?`),
    confirmFullReupload: (bytes) => confirm(`About ${Math.ceil(bytes / (1024 * 1024))} MiB of this vault's files must be uploaded again. Continue?`),
    confirmMassRemoval: (counts) =>
      confirm(
        `This publish would remove ${counts.removing} of ${counts.remaining} entries from the vault manifest` +
          `${counts.exclusionDriven > 0 ? ` (${counts.exclusionDriven} more are removed by the exclusion list and are not counted)` : ""}. ` +
          "An unmounted or emptied vault folder looks the same. Continue?",
      ),
    costPolicy: { approveCost: (params) => confirm(`A key slot on the node costs ${describeKdfCost(params)} to unlock, above the default. Continue?`) },
  };
}

/**
 * The device-local store (device id, sequence floor). The per-user directory is located and created only when the store is
 * first used: when a manifest is built, when the floor is raised, or when `--repair` reads the floor.
 */
function deviceStoreFor(ctx: PublishContext): DeviceStore {
  // The lazy node store carries `exclusive`: the floor raise must run under the cross-process lock (review-final A-08).
  return ctx.deviceStore ?? createLazyDeviceStore(ctx.env);
}

async function publishWithHosts(ctx: PublishContext, host: HostBridge, lock: PublishLock, verifyHeld: () => Promise<boolean>): Promise<PublishResult> {
  const now = (): number => ctx.now().getTime();
  const configFile = resolve(ctx.configPath);
  const configHost = createNodeHostBridge({ root: dirname(configFile), env: ctx.env, now });
  const bus = createSyncEventBus();
  bus.on("file.changed", (event) => ctx.io.out(`  ${event.kind.padEnd(8)} ${event.path}`));
  bus.onListenerFailure((failure) => ctx.io.err(`warning: ${failure.event} listener failed`));
  // Best-effort history (mvp-08): a store that will not open only costs a stderr line; the publish decides its own exit code.
  const historyStore = await openRunHistoryStore(ctx.env, ctx.io);
  const recorder = historyStore === undefined ? undefined : attachHistoryRecorder(bus, historyStore, ctx.io);
  // The passphrase is asked for only now: after the marker check and the lock, and never held longer than this call.
  const passphrase = await ctx.passphrase?.();
  try {
    const deviceStore = deviceStoreFor(ctx);
    return await publishVault(
      {
        client: ctx.client,
        host,
        bus,
        deviceId: createDeviceIdProvider(deviceStore),
        deviceStore,
        // Re-reads the token over the lock file right before the engine's first request that can change the node.
        beforeFirstWrite: async () => {
          if (!(await verifyHeld())) throw lockHeld("the lock file no longer carries this run's token");
        },
      },
      {
        mfsRoot: ctx.config.mfsRoot,
        keyName: ctx.config.publicationKey,
        ownedKeys: ctx.config.ownedKeys,
        recordOwnedKey: (keyId) => recordOwnedKey(configHost, basename(configFile), keyId),
        passphrase,
        assertHeld: () => lock.assertHeld(),
        repair: ctx.flags.repair,
        recoverSlots: ctx.flags.recoverSlots,
        allowFullReupload: ctx.flags.allowFullReupload,
        allowMassRemoval: ctx.flags.allowMassRemoval,
        ...askingOptions(ctx),
      },
    );
  } finally {
    // Success, refusal or throw: the canonical bytes do not outlive this call. Best effort; the runtime may hold copies.
    wipe(passphrase);
    // Drain the recorder's queued writes before the store handle closes, so no append outlives it.
    await recorder?.detach();
    await historyStore?.close();
  }
}

/** `--break-lock`: describe the lock, remove it only on a yes. A run that cannot ask declines. */
async function breakLockIfAsked(ctx: PublishContext, file: LockFile): Promise<void> {
  if (!ctx.flags.breakLock) return;
  const ask = async (description: string): Promise<boolean> => (await ctx.io.confirm?.(`Remove the publish lock held by ${description}?`)) ?? false;
  const outcome = await breakPublishLock(file, () => ctx.now().getTime(), ask);
  ctx.io.out(outcome === "removed" ? "publish lock removed" : outcome === "declined" ? "publish lock left in place" : "no publish lock to remove");
}

/**
 * `ipfs-sync publish <vault>`. Configuration is already validated when this runs. Order: the fixture marker
 * (before the lock file is created and before anything is sent, so a real vault is never touched), the publish
 * lock in the vault's .ipfs-sync folder, then `publishVault`, which repeats the marker check, needs the
 * passphrase and runs the key checks before any write. The lock is released on every path.
 */
export async function runPublish(ctx: PublishContext): Promise<number> {
  const vault = resolve(ctx.vaultPath);
  await assertDirectory(vault);
  const host = createNodeHostBridge({ root: vault, env: ctx.env, now: () => ctx.now().getTime() });
  await assertPublishMarker(host.fs);
  printHeader(ctx, vault);
  const file = createNodeLockFile(vault);
  try {
    await breakLockIfAsked(ctx, file);
    const checked = withTokenCheck(file);
    const lock = await acquirePublishLock(checked.file, createNodeLockContext(() => ctx.now().getTime()));
    try {
      printResult(ctx.io, await publishWithHosts(ctx, host, lock, checked.verifyHeld));
      return EXIT_OK;
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if (error instanceof ManifestFormatError) {
      // An authentic manifest whose content this build does not recognise: another device runs a newer or incompatible version.
      ctx.io.err(`ipfs-sync: publish failed: the vault manifest on the node was written by a newer or incompatible version (${error.message}); update ipfs-sync`);
      return EXIT_CHECK_FAILED;
    }
    if (REPORTED_FAILURES.some((failure) => error instanceof failure)) {
      ctx.io.err(`ipfs-sync: publish failed: ${(error as Error).message}`);
      return EXIT_CHECK_FAILED;
    }
    throw error;
  }
}
