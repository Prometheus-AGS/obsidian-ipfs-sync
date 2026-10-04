import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { describeAuth } from "../src/core/config";
import { CryptoError } from "../src/crypto";
import { KuboError } from "../src/kubo";
import { DeviceStoreError } from "../src/sync/device-store";
import { HostNotImplementedError } from "../src/sync/host-errors";
import { PlaintextUnsupportedError, PullGuardError, PullSourceError, PullTargetError } from "../src/sync/pull-errors";
import { assertPullDestination } from "../src/sync/pull-guard";
import { escapeForDisplay } from "../src/sync/path-policy";
import { checkPullFlags } from "../src/sync/pull-sequence";
import { PullUnlockError } from "../src/sync/pull-unlock";
import { PublishRefusedError } from "../src/sync/publish-refusals";
import { RootStateError } from "../src/sync/root-state";
import { SequenceFloorError } from "../src/sync/sequence-floor";
import { chooseIpnsName, isCid, isIpnsName } from "../src/sync/target-resolution";
import { VaultKeysError } from "../src/sync/vault-keys";
import { UsageError, type PullFlags } from "./args";
import { EXIT_CHECK_FAILED, EXIT_USAGE } from "./io";
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
const REFUSALS = [PullGuardError, PullTargetError, PlaintextUnsupportedError] as const;

async function assertDirectoryOrAbsent(path: string): Promise<void> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info !== undefined && !info.isDirectory()) throw new UsageError(`vault "${path}" exists and is not a directory`);
}

/** One target at most, and a CID where a CID is needed: refused before any request. */
function assertTargetFlags(flags: PullFlags): void {
  if (flags.rootCid !== undefined && flags.manifest !== undefined) {
    throw new UsageError("--root-cid and --manifest are mutually exclusive: name one target");
  }
  if (flags.manifest !== undefined && !isCid(flags.manifest)) {
    throw new UsageError(`--manifest needs the tree CID of a history entry, got "${flags.manifest}"`);
  }
}

function describeSelector(flags: PullFlags): string {
  return flags.manifest === undefined ? "latest" : `snapshot ${flags.manifest}`;
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

/** Paths and reasons come from the node's manifest or from errors that quote it: control characters are shown escaped. */
const shown = escapeForDisplay;

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

/**
 * A pull by name needs a name: `--name`, or the ID of the owned publication key. A key that is not owned is reported here, as a
 * refusal, before the passphrase is asked for. `--root-cid` names its own target.
 */
async function assertNameKnown(ctx: PullContext): Promise<void> {
  const { flags, client, config } = ctx;
  if (flags.rootCid !== undefined) return;
  await chooseIpnsName(client, { name: flags.name, keyName: config.publicationKey, ownedKeys: config.ownedKeys });
}

/**
 * `ipfs-sync pull <vault>`. Configuration is already validated when this runs. Exit 0 when every file
 * that had to be written was written and verified, or was skipped as expected; 1 when any file failed
 * verification or was not fetched, a path was skipped as unsafe, or the source could not be read or
 * stopped the pull; 2 when the invocation or destination is refused before anything is written, or the
 * root is a plaintext publication (which this version does not read).
 */
export async function runPull(ctx: PullContext): Promise<number> {
  const { flags } = ctx;
  if (flags.name !== undefined && !isIpnsName(flags.name)) throw new UsageError(`--name needs an IPNS key ID, got "${flags.name}"`);
  if (flags.rootCid !== undefined && !isCid(flags.rootCid)) throw new UsageError(`--root-cid needs a CID, got "${flags.rootCid}"`);
  assertTargetFlags(flags);
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
    await assertNameKnown(ctx);
    return await runEncryptedPull(ctx, vault);
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
