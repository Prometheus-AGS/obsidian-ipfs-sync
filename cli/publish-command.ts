import { stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { ConfigError, describeAuth, type EnvMap, type SyncConfig } from "../src/core/config";
import { createSyncEventBus } from "../src/core/events";
import { KuboError, type KuboClient } from "../src/kubo";
import { HostNotImplementedError } from "../src/sync/host-errors";
import { ManifestError } from "../src/sync/manifest";
import { publishVault, type PublishResult } from "../src/sync/publish";
import {
  EmptyVaultError,
  OwnedKeyNotRecordedError,
  TransferFailedError,
  UnsafeTargetError,
  WriteVerificationError,
} from "../src/sync/publish-errors";
import { StateError } from "../src/sync/state";
import { UsageError } from "./args";
import { EXIT_CHECK_FAILED, EXIT_OK, type CliIo } from "./io";
import { HostPathError, createNodeHostBridge } from "./node-host-bridge";
import { recordOwnedKey } from "./owned-keys-store";

export interface PublishContext {
  readonly config: SyncConfig;
  readonly client: KuboClient;
  readonly io: CliIo;
  readonly vaultPath: string;
  readonly configPath: string;
  readonly env: EnvMap;
  readonly now: () => Date;
}

/** Failures a publish reports as a plain message with exit code 1. */
const REPORTED_FAILURES = [
  TransferFailedError,
  WriteVerificationError,
  UnsafeTargetError,
  OwnedKeyNotRecordedError,
  EmptyVaultError,
  StateError,
  ManifestError,
  HostPathError,
  HostNotImplementedError,
  KuboError,
] as const;

async function assertDirectory(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) throw new UsageError(`vault "${path}" is not a directory`);
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
  io.out(`${result.written} written, ${result.removed} removed`);
}

async function publishWithHosts(ctx: PublishContext, vault: string): Promise<PublishResult> {
  const now = (): number => ctx.now().getTime();
  const host = createNodeHostBridge({ root: vault, env: ctx.env, now });
  const configFile = resolve(ctx.configPath);
  const configHost = createNodeHostBridge({ root: dirname(configFile), env: ctx.env, now });
  const bus = createSyncEventBus();
  bus.on("file.changed", (event) => ctx.io.out(`  ${event.kind.padEnd(8)} ${event.path}`));
  bus.onListenerFailure((failure) => ctx.io.err(`warning: ${failure.event} listener failed`));
  return publishVault(
    { client: ctx.client, host, bus },
    {
      mfsRoot: ctx.config.mfsRoot,
      keyName: ctx.config.publicationKey,
      ownedKeys: ctx.config.ownedKeys,
      recordOwnedKey: (keyId) => recordOwnedKey(configHost, basename(configFile), keyId),
    },
  );
}

/**
 * `ipfs-sync publish <vault>`. Configuration is already validated when this runs. The
 * fixture guard and the key checks happen inside `publishVault` before any write.
 */
export async function runPublish(ctx: PublishContext): Promise<number> {
  const vault = resolve(ctx.vaultPath);
  await assertDirectory(vault);
  printHeader(ctx, vault);
  try {
    printResult(ctx.io, await publishWithHosts(ctx, vault));
    return EXIT_OK;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if (REPORTED_FAILURES.some((failure) => error instanceof failure)) {
      ctx.io.err(`ipfs-sync: publish failed: ${(error as Error).message}`);
      return EXIT_CHECK_FAILED;
    }
    throw error;
  }
}
