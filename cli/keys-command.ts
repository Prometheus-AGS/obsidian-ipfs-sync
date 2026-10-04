import { resolve } from "node:path";
import { ConfigError, assertMfsMutationPath, describeAuth, validateMfsRoot } from "../src/core/config";
import { CryptoError } from "../src/crypto";
import { KuboError } from "../src/kubo";
import { DeviceStoreError } from "../src/sync/device-store";
import { ManifestFormatError } from "../src/sync/encrypted-manifest";
import { assertPublishMarker, PULLED_MARKER_VALUE, readMarkerState } from "../src/sync/publish-guard";
import { HostNotImplementedError } from "../src/sync/host-errors";
import { KeyManagementError, pendingMaintenance } from "../src/sync/key-management";
import { withTokenCheck } from "../src/sync/lock-token-check";
import type { MaintenanceJournal } from "../src/sync/maintenance-journal";
import { WriteVerificationError } from "../src/sync/publish-errors";
import { acquirePublishLock } from "../src/sync/publish-lock";
import { MAINTENANCE_WAYS_OUT, PublishRefusedError, ReadBackError } from "../src/sync/publish-refusals";
import { escapeForDisplay } from "../src/sync/path-policy";
import { PullSourceError, PullTargetError } from "../src/sync/pull-errors";
import { PullUnlockError } from "../src/sync/pull-unlock";
import { RootStateError } from "../src/sync/root-state";
import { SequenceFloorError } from "../src/sync/sequence-floor";
import { SlotAcceptanceError } from "../src/sync/slot-acceptance";
import { isCid, isIpnsName } from "../src/sync/target-resolution";
import { VaultKeysError } from "../src/sync/vault-keys";
import { UsageError } from "./args";
import { EXIT_CHECK_FAILED } from "./io";
import { runAccept } from "./keys-accept";
import { runDiscard } from "./keys-discard";
import { runRewrap } from "./keys-rewrap";
import { KEYS_SUBCOMMANDS, type KeysContext, type KeysSession, type KeysSubcommand } from "./keys-session";
import { HostPathError, createNodeHostBridge } from "./node-host-bridge";
import { PassphraseInputError } from "./passphrase-errors";
import { assertDirectory } from "./publish-command";
import { createNodeLockContext, createNodeLockFile } from "./publish-lock-file";

export { KEYS_SUBCOMMANDS, confirmAcceptDowngrade, confirmDowngrade, type KeysContext, type KeysSubcommand } from "./keys-session";

/**
 * `ipfs-sync keys <subcommand> <vault>`: `change-passphrase` and `increase-cost` (mvp-07b task 1.4), `accept-slots` and `discard` (task 1.5). Order: the
 * vault directory and the fixture marker (before the lock file is created and before anything is sent), the flags that belong to the subcommand, the
 * publish lock with the token check of the 07a standard, then the pending-journal question (a rerun finishes the pending operation), then the
 * subcommand. The lock is released on every path.
 *
 * `accept-slots` and `discard` are the ways OUT of a pending journal, so they do not ask the pending-journal question (a journal that cannot be read
 * would refuse them), and they run on a pulled directory too (marker `pulled-fixture`): the second device is exactly where accept is needed.
 */

type Handler = (session: KeysSession, pending: MaintenanceJournal | undefined) => Promise<number>;

const SUBCOMMANDS: Readonly<Record<KeysSubcommand, Handler>> = {
  "change-passphrase": runRewrap,
  "increase-cost": runRewrap,
  "accept-slots": runAccept,
  discard: runDiscard,
};

/** The two subcommands that read and clear the journal themselves. */
const JOURNAL_ESCAPES: ReadonlySet<KeysSubcommand> = new Set<KeysSubcommand>(["accept-slots", "discard"]);

/** Failures a keys command reports as a plain message with exit code 1. */
export const REPORTED_FAILURES = [
  KeyManagementError,
  PublishRefusedError,
  ReadBackError,
  WriteVerificationError,
  VaultKeysError,
  CryptoError,
  PassphraseInputError,
  RootStateError,
  DeviceStoreError,
  SequenceFloorError,
  HostPathError,
  HostNotImplementedError,
  KuboError,
  PullUnlockError,
  SlotAcceptanceError,
  PullTargetError,
  PullSourceError,
] as const;

function checkAcceptFlags(ctx: KeysContext): void {
  const { accept } = ctx;
  if (accept.allowRollback && accept.rootCid === undefined) {
    throw new UsageError("--allow-rollback needs --root-cid: an older sequence is only accepted for a root you name; nothing was sent");
  }
  if (accept.name !== undefined && accept.rootCid !== undefined) throw new UsageError("--name and --root-cid exclude each other; nothing was sent");
  if (accept.name !== undefined && !isIpnsName(accept.name)) throw new UsageError("--name needs an IPNS key ID; nothing was sent");
  if (accept.rootCid !== undefined && !isCid(accept.rootCid)) throw new UsageError("--root-cid needs a CID; nothing was sent");
}

/** Flags that belong to the other subcommands: refused before the lock is taken and before anything is sent. */
function checkNoRewrapFlags(ctx: KeysContext): void {
  const given = Object.entries({
    "--cost": ctx.flags.cost,
    "--accept-no-revocation": ctx.flags.acceptNoRevocation || undefined,
    "--passphrase-file": ctx.passphraseFile,
  }).find(([, value]) => value !== undefined);
  if (given !== undefined) throw new UsageError(`${given[0]} is not valid for keys ${ctx.subcommand}; nothing was sent`);
}

/** Flags whose meaning depends only on the subcommand: refused before the lock is taken and before anything is sent. */
function checkSubcommandFlags(ctx: KeysContext): void {
  if (ctx.subcommand === "increase-cost") {
    if (ctx.flags.cost === undefined) throw new UsageError("increase-cost needs the cost to raise to: --cost standard or --cost high; nothing was sent");
    if (ctx.passphraseFile !== undefined) throw new UsageError("--passphrase-file is only valid for init and keys change-passphrase; increase-cost keeps the passphrase and generates none");
    if (ctx.flags.allowDowngrade) throw new UsageError("--allow-downgrade is only valid for keys change-passphrase; increase-cost only raises the cost");
  }
  if (ctx.subcommand === "accept-slots") {
    checkNoRewrapFlags(ctx);
    checkAcceptFlags(ctx);
  }
  if (ctx.subcommand === "discard") {
    checkNoRewrapFlags(ctx);
    if (ctx.flags.allowDowngrade) throw new UsageError("--allow-downgrade is not valid for keys discard; nothing was sent");
  }
}

/** The publish gate (marker `fixture`), except that the two subcommands that never publish also run on a pulled copy (marker `pulled-fixture`). */
async function assertKeysMarker(subcommand: KeysSubcommand, fs: Parameters<typeof assertPublishMarker>[0]): Promise<void> {
  if (JOURNAL_ESCAPES.has(subcommand) && (await readMarkerState(fs)) === PULLED_MARKER_VALUE) return;
  await assertPublishMarker(fs);
}

function printHeader(ctx: KeysContext, vault: string): void {
  ctx.io.out(`ipfs-sync keys ${ctx.subcommand}`);
  ctx.io.out(`  vault     ${vault}`);
  ctx.io.out(`  rpc       ${ctx.config.rpc.baseUrl}  (auth: ${describeAuth(ctx.config.rpc.auth)})`);
  ctx.io.out(`  mfs root  ${ctx.config.mfsRoot}`);
  ctx.io.out(`  key       ${ctx.config.publicationKey}`);
}

async function runLocked(session: KeysSession): Promise<number> {
  // A journal on this device is answered first, with local reads only; a damaged one is refused here with both ways out.
  // accept-slots and discard are those ways out: they read the journal themselves, damaged or not.
  const { subcommand } = session.ctx;
  const pending = JOURNAL_ESCAPES.has(subcommand) ? undefined : await pendingMaintenance(session.host, session.mfsRoot);
  return SUBCOMMANDS[subcommand](session, pending);
}

/** Everything a keys command reports without a stack: refusals and failures of the layers below, node text escaped. */
async function report(ctx: KeysContext, session: KeysSession | undefined, error: unknown): Promise<number> {
  if (error instanceof ConfigError || error instanceof UsageError) throw error;
  if (error instanceof ManifestFormatError) {
    // An authentic manifest whose content this build refuses to read: a newer version, or a path no honest writer produces. Fail closed.
    ctx.io.err(
      `ipfs-sync: keys ${ctx.subcommand} failed: the vault manifest on the node holds something this build refuses to read (${escapeForDisplay(error.message)}). ` +
        "Key management stays refused until that is fixed: a vault with even one path over the limits can neither change its passphrase nor prune its history. Nothing was changed.",
    );
    return EXIT_CHECK_FAILED;
  }
  if (!REPORTED_FAILURES.some((failure) => error instanceof failure)) throw error;
  ctx.io.err(`ipfs-sync: keys ${ctx.subcommand} failed: ${escapeForDisplay((error as Error).message)}`);
  const namesWaysOut = error instanceof PublishRefusedError && (error.code === "maintenance-pending" || error.code === "maintenance-lost-race");
  if (!namesWaysOut && session !== undefined && (await pendingMaintenance(session.host, session.mfsRoot).catch(() => undefined)) !== undefined) {
    ctx.io.err(`A key-slot rewrap is pending on this device, so publish and pull are paused. ${MAINTENANCE_WAYS_OUT}`);
  }
  return EXIT_CHECK_FAILED;
}

export async function runKeys(ctx: KeysContext): Promise<number> {
  const vault = resolve(ctx.vaultPath);
  await assertDirectory(vault);
  const host = createNodeHostBridge({ root: vault, env: ctx.env, now: () => ctx.now().getTime() });
  await assertKeysMarker(ctx.subcommand, host.fs);
  const mfsRoot = assertMfsMutationPath(validateMfsRoot(ctx.config.mfsRoot));
  checkSubcommandFlags(ctx);
  printHeader(ctx, vault);
  let session: KeysSession | undefined;
  try {
    const checked = withTokenCheck(createNodeLockFile(vault));
    const lock = await acquirePublishLock(checked.file, createNodeLockContext(() => ctx.now().getTime()));
    try {
      session = { ctx, vault, host, mfsRoot, lock, verifyHeld: checked.verifyHeld };
      return await runLocked(session);
    } finally {
      await lock.release();
    }
  } catch (error) {
    return report(ctx, session, error);
  }
}
