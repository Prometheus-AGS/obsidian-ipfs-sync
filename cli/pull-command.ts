import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describeAuth, type EnvMap, type SyncConfig } from "../src/core/config";
import { createSyncEventBus } from "../src/core/events";
import { KuboError, type KuboClient } from "../src/kubo";
import { HostNotImplementedError } from "../src/sync/host-errors";
import { ManifestError } from "../src/sync/manifest";
import { pullVault, type PullOptions, type PullResult } from "../src/sync/pull";
import { PullGuardError, PullSourceError, PullTargetError } from "../src/sync/pull-errors";
import { isCid, isIpnsName, type ManifestSelector } from "../src/sync/pull-target";
import { StateError } from "../src/sync/state";
import { UsageError, type PullFlags } from "./args";
import { EXIT_CHECK_FAILED, EXIT_OK, EXIT_USAGE, type CliIo } from "./io";
import { HostPathError, createNodeHostBridge } from "./node-host-bridge";

export interface PullContext {
  readonly config: SyncConfig;
  readonly client: KuboClient;
  readonly io: CliIo;
  readonly vaultPath: string;
  readonly flags: PullFlags;
  readonly env: EnvMap;
  readonly now: () => Date;
}

/** Failures reported as a plain message with exit code 1 (a runtime problem, not a bad invocation). */
const RUNTIME_FAILURES = [PullSourceError, ManifestError, StateError, HostPathError, HostNotImplementedError, KuboError] as const;

/** Failures reported with exit code 2: the invocation or configuration cannot be honoured, and nothing was written. */
const REFUSALS = [PullGuardError, PullTargetError] as const;

async function assertDirectoryOrAbsent(path: string): Promise<void> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info !== undefined && !info.isDirectory()) throw new UsageError(`vault "${path}" exists and is not a directory`);
}

async function chooseSelector(flags: PullFlags): Promise<ManifestSelector> {
  if (flags.manifest !== undefined && flags.manifestFile !== undefined) {
    throw new UsageError("--manifest and --manifest-file are mutually exclusive");
  }
  if (flags.manifest !== undefined) {
    if (!isCid(flags.manifest)) throw new UsageError(`--manifest needs the currentCID of a published snapshot, got "${flags.manifest}"`);
    return { kind: "historical", currentCid: flags.manifest };
  }
  if (flags.manifestFile !== undefined) {
    const text = await readFile(flags.manifestFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      throw new UsageError(`cannot read --manifest-file ${flags.manifestFile}: ${error.message}`);
    });
    return { kind: "text", text };
  }
  return { kind: "latest" };
}

function describeSelector(flags: PullFlags): string {
  if (flags.manifest !== undefined) return `snapshot ${flags.manifest}`;
  if (flags.manifestFile !== undefined) return `file ${flags.manifestFile}`;
  return "latest";
}

function printHeader(ctx: PullContext, vault: string): void {
  const { config, io, flags } = ctx;
  io.out("ipfs-sync pull");
  io.out(`  vault     ${vault}`);
  io.out(`  rpc       ${config.rpc.baseUrl}  (auth: ${describeAuth(config.rpc.auth)})`);
  io.out(`  gateway   ${config.gateway.baseUrl}  (auth: ${describeAuth(config.gateway.auth)})`);
  io.out(`  source    ${flags.name === undefined ? `key ${config.publicationKey}` : `name ${flags.name}`}`);
  io.out(`  manifest  ${describeSelector(flags)}`);
}

export function summaryLine(result: PullResult): string {
  return [
    `${result.fetched} fetched`,
    `${result.unchanged} unchanged`,
    `${result.conflicted} conflicts`,
    `${result.failed} failed`,
    `${result.remoteDeleted} remote-deleted`,
    `${result.locallyModified} locally modified`,
  ].join(", ");
}

function printResult(io: CliIo, result: PullResult): void {
  for (const failure of result.failures) io.err(`  failed   ${failure.path}: ${failure.reason}`);
  for (const path of result.remoteDeletedPaths) io.out(`  remote-deleted ${path} (kept locally)`);
  for (const path of result.locallyModifiedPaths) io.out(`  locally modified ${path} (left as is)`);
  io.out(`root CID   ${result.rootCid}  (IPNS value)`);
  io.out(`snapshot  ${result.manifestCid}  (manifest rootCID)`);
  io.out(summaryLine(result));
}

function buildOptions(ctx: PullContext, selector: ManifestSelector): PullOptions {
  const { config, flags } = ctx;
  return { mfsRoot: config.mfsRoot, keyName: config.publicationKey, ownedKeys: config.ownedKeys, name: flags.name, selector };
}

async function pullWithHost(ctx: PullContext, vault: string, selector: ManifestSelector): Promise<PullResult> {
  const now = (): number => ctx.now().getTime();
  const host = createNodeHostBridge({ root: vault, env: ctx.env, now });
  const bus = createSyncEventBus();
  bus.on("file.changed", (event) => ctx.io.out(`  ${event.kind.padEnd(8)} ${event.path}`));
  bus.on("conflict", (event) => ctx.io.out(`  conflict ${event.path} -> ${event.conflictPath}`));
  bus.onListenerFailure((failure) => ctx.io.err(`warning: ${failure.event} listener failed`));
  return pullVault({ client: ctx.client, host, bus, warn: (message) => ctx.io.err(`warning: ${message}`) }, buildOptions(ctx, selector));
}

/**
 * `ipfs-sync pull <vault>`. Configuration is already validated when this runs. Exit 0 when every file
 * that had to be written was written and verified, 1 when any file failed or the source could not be
 * read, 2 when the invocation or destination is refused before anything is written.
 */
export async function runPull(ctx: PullContext): Promise<number> {
  if (ctx.flags.name !== undefined && !isIpnsName(ctx.flags.name)) throw new UsageError(`--name needs an IPNS key ID, got "${ctx.flags.name}"`);
  const selector = await chooseSelector(ctx.flags);
  const vault = resolve(ctx.vaultPath);
  await assertDirectoryOrAbsent(vault);
  printHeader(ctx, vault);
  try {
    const result = await pullWithHost(ctx, vault, selector);
    printResult(ctx.io, result);
    return result.failed === 0 ? EXIT_OK : EXIT_CHECK_FAILED;
  } catch (error) {
    if (REFUSALS.some((refusal) => error instanceof refusal)) {
      ctx.io.err(`ipfs-sync: pull refused: ${(error as Error).message}`);
      return EXIT_USAGE;
    }
    if (RUNTIME_FAILURES.some((failure) => error instanceof failure)) {
      ctx.io.err(`ipfs-sync: pull failed: ${(error as Error).message}`);
      return EXIT_CHECK_FAILED;
    }
    throw error;
  }
}
