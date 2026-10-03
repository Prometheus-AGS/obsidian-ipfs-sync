import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describeAuth } from "../src/core/config";
import { createSyncEventBus } from "../src/core/events";
import { CryptoError } from "../src/crypto";
import { KuboError } from "../src/kubo";
import { DeviceStoreError } from "../src/sync/device-store";
import { HostNotImplementedError } from "../src/sync/host-errors";
import { ManifestError } from "../src/sync/manifest";
import { pullVault, type PullOptions, type PullResult } from "../src/sync/pull";
import { EncryptedVaultError, PlaintextV1RefusedError, PullGuardError, PullSourceError, PullTargetError } from "../src/sync/pull-errors";
import { assertPullDestination } from "../src/sync/pull-guard";
import { escapeForDisplay } from "../src/sync/path-policy";
import { rootIsEncrypted } from "../src/sync/pull-screen";
import { checkPullFlags } from "../src/sync/pull-sequence";
import type { ManifestSelector } from "../src/sync/pull-target";
import { PullUnlockError } from "../src/sync/pull-unlock";
import { PublishRefusedError } from "../src/sync/publish-refusals";
import { RootStateError } from "../src/sync/root-state";
import { SequenceFloorError } from "../src/sync/sequence-floor";
import { chooseIpnsName, isCid, isIpnsName, resolveRootCid } from "../src/sync/target-resolution";
import { StateError } from "../src/sync/state";
import { VaultKeysError } from "../src/sync/vault-keys";
import { UsageError, type PullFlags } from "./args";
import { EXIT_CHECK_FAILED, EXIT_OK, EXIT_USAGE, type CliIo } from "./io";
import { HostPathError, createNodeHostBridge } from "./node-host-bridge";
import { PassphraseInputError } from "./passphrase-errors";
import type { PullContext } from "./pull-context";
import { engineFlags, runEncryptedPull } from "./pull-encrypted-command";
import { runListVersions } from "./pull-versions";

export type { PullContext } from "./pull-context";

/**
 * Failures reported as a plain message with exit code 1 (a runtime problem, not a bad invocation). The second group is what the
 * decrypting reader and the version listing can raise outside the stops of `encryptedPull`: an unreadable passphrase source, a
 * per-user directory that cannot be located, and the unlock and record errors of `--list-versions`.
 */
const RUNTIME_FAILURES = [
  PullSourceError,
  ManifestError,
  StateError,
  HostPathError,
  HostNotImplementedError,
  KuboError,
  PassphraseInputError,
  DeviceStoreError,
  PullUnlockError,
  VaultKeysError,
  CryptoError,
  RootStateError,
  SequenceFloorError,
  PublishRefusedError,
] as const;

/** Failures reported with exit code 2: the invocation or configuration cannot be honoured, and nothing was written. */
const REFUSALS = [PullGuardError, PullTargetError, EncryptedVaultError, PlaintextV1RefusedError] as const;

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
  if (flags.rootCid !== undefined && (flags.manifest !== undefined || flags.manifestFile !== undefined)) {
    throw new UsageError("--root-cid and --manifest or --manifest-file are mutually exclusive: name one target");
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
  io.out(`  source    ${flags.rootCid !== undefined ? `root ${flags.rootCid}` : flags.name === undefined ? `key ${config.publicationKey}` : `name ${flags.name}`}`);
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

/** Paths and reasons come from the node's manifest or from errors that quote it: control characters are shown escaped. */
const shown = escapeForDisplay;

function printResult(io: CliIo, result: PullResult): void {
  for (const failure of result.failures) io.err(`  failed   ${shown(failure.path)}: ${shown(failure.reason)}`);
  for (const path of result.remoteDeletedPaths) io.out(`  remote-deleted ${shown(path)} (kept locally)`);
  for (const path of result.locallyModifiedPaths) io.out(`  locally modified ${shown(path)} (left as is)`);
  io.out(`root CID   ${result.rootCid}  (IPNS value)`);
  io.out(`snapshot  ${result.manifestCid}  (manifest rootCID)`);
  io.out(summaryLine(result));
}

function buildOptions(ctx: PullContext, selector: ManifestSelector): PullOptions {
  const { config, flags } = ctx;
  return {
    mfsRoot: config.mfsRoot,
    keyName: config.publicationKey,
    ownedKeys: config.ownedKeys,
    name: flags.name,
    selector,
    allowPlaintextV1: flags.allowPlaintextV1,
  };
}

async function pullWithHost(ctx: PullContext, vault: string, selector: ManifestSelector): Promise<PullResult> {
  const now = (): number => ctx.now().getTime();
  const host = createNodeHostBridge({ root: vault, env: ctx.env, now });
  const bus = createSyncEventBus();
  bus.on("file.changed", (event) => ctx.io.out(`  ${event.kind.padEnd(8)} ${shown(event.path)}`));
  bus.on("conflict", (event) => ctx.io.out(`  conflict ${shown(event.path)} -> ${shown(event.conflictPath)}`));
  bus.onListenerFailure((failure) => ctx.io.err(`warning: ${failure.event} listener failed`));
  return pullVault({ client: ctx.client, host, bus, warn: (message) => ctx.io.err(`warning: ${shown(message)}`) }, buildOptions(ctx, selector));
}

/** Flag combinations the sequence rule never accepts are refused here, before any request and before the passphrase is asked. */
function assertFlagsAllowed(flags: PullFlags): void {
  const target = flags.rootCid !== undefined ? "root-cid" : flags.manifest !== undefined ? "manifest" : "name";
  const refusal = checkPullFlags(target, engineFlags(flags));
  if (refusal !== undefined) throw new UsageError(refusal.message);
}

const FORK_QUESTION =
  "Resolve the fork? Where both this device and the node changed a file, this device's text is kept as a dated conflict copy and the node's text takes the path; files only this device changed stay and are published next, as the sequence after the node's. Continue?";

/** `--resolve-fork` states what it does and needs a yes on a terminal. Returns false when the answer is no. */
async function confirmFork(ctx: PullContext): Promise<boolean> {
  if (!ctx.flags.resolveFork) return true;
  if (ctx.io.confirm === undefined) throw new UsageError("--resolve-fork needs a terminal to confirm: it changes how this device's files and the node's are merged");
  return ctx.io.confirm(FORK_QUESTION);
}

type Route = "encrypted" | "plaintext";

/**
 * Which reader runs. `--manifest-file` is a plaintext-reader flag. `--root-cid` and `--list-versions` exist only for encrypted
 * vaults. Otherwise the root the name serves decides: key slots or an encrypted manifest there mean the decrypting reader.
 */
async function chooseRoute(ctx: PullContext): Promise<Route> {
  const { flags, client, config } = ctx;
  if (flags.manifestFile !== undefined) return "plaintext";
  if (flags.rootCid !== undefined) return "encrypted";
  const ipnsName = await chooseIpnsName(client, { name: flags.name, keyName: config.publicationKey, ownedKeys: config.ownedKeys });
  return (await rootIsEncrypted(client, await resolveRootCid(client, ipnsName))) ? "encrypted" : "plaintext";
}

/** A sequence expectation, a rollback or a fork on a plaintext root would be ignored in silence by a reader that has no sequence. */
function assertNoEncryptedOnlyFlags(flags: PullFlags): void {
  const given = Object.entries({
    "--allow-rollback": flags.allowRollback ? true : undefined,
    "--resolve-fork": flags.resolveFork ? true : undefined,
    "--expect-min-sequence": flags.expectMinSequence,
    "--expect-vault-id": flags.expectVaultId,
  }).find(([, value]) => value !== undefined);
  if (given !== undefined) throw new UsageError(`${given[0]} applies to encrypted vaults only, and this root holds a plaintext (version 1) manifest; nothing was written`);
}

/**
 * `ipfs-sync pull <vault>`. Configuration is already validated when this runs. Exit 0 when every file
 * that had to be written was written and verified, or was skipped as expected; 1 when any file failed
 * verification or was not fetched, a path was skipped as unsafe, or the source could not be read or
 * stopped the pull; 2 when the invocation or destination is refused before anything is written.
 */
export async function runPull(ctx: PullContext): Promise<number> {
  const { flags } = ctx;
  if (flags.name !== undefined && !isIpnsName(flags.name)) throw new UsageError(`--name needs an IPNS key ID, got "${flags.name}"`);
  if (flags.rootCid !== undefined && !isCid(flags.rootCid)) throw new UsageError(`--root-cid needs a CID, got "${flags.rootCid}"`);
  const selector = await chooseSelector(flags);
  assertFlagsAllowed(flags);
  if (!(await confirmFork(ctx))) {
    ctx.io.err("ipfs-sync: pull stopped: the fork resolution was declined; nothing was changed");
    return EXIT_CHECK_FAILED;
  }
  const vault = resolve(ctx.vaultPath);
  await assertDirectoryOrAbsent(vault);
  printHeader(ctx, vault);
  try {
    if (flags.listVersions) return await runListVersions(ctx, vault);
    await assertPullDestination(createNodeHostBridge({ root: vault, env: ctx.env, now: () => ctx.now().getTime() }).fs);
    if ((await chooseRoute(ctx)) === "encrypted") return await runEncryptedPull(ctx, vault);
    assertNoEncryptedOnlyFlags(flags);
    const result = await pullWithHost(ctx, vault, selector);
    printResult(ctx.io, result);
    return result.failed === 0 ? EXIT_OK : EXIT_CHECK_FAILED;
  } catch (error) {
    if (REFUSALS.some((refusal) => error instanceof refusal)) {
      ctx.io.err(`ipfs-sync: pull refused: ${shown((error as Error).message)}`);
      return EXIT_USAGE;
    }
    if (RUNTIME_FAILURES.some((failure) => error instanceof failure)) {
      // KuboHttpError messages embed the node's own error body: escaped here as well as where the error is built.
      ctx.io.err(`ipfs-sync: pull failed: ${shown((error as Error).message)}`);
      return EXIT_CHECK_FAILED;
    }
    throw error;
  }
}
