import { resolve } from "node:path";
import { ConfigError, assertMfsMutationPath, describeAuth, validateMfsRoot, type EnvMap, type SyncConfig } from "../src/core/config";
import { wipe, type CanonicalPassphrase } from "../src/crypto";
import type { KuboClient } from "../src/kubo";
import type { DeviceStore } from "../src/sync/device-store";
import { ManifestFormatError } from "../src/sync/encrypted-manifest";
import { assertPublishMarker } from "../src/sync/publish-guard";
import { pendingMaintenance } from "../src/sync/key-management";
import { withTokenCheck } from "../src/sync/lock-token-check";
import { reached, readMaintenanceJournal, type MaintenanceJournal } from "../src/sync/maintenance-journal";
import { escapeForDisplay } from "../src/sync/path-policy";
import { PruneHistoryError, executePrune, preparePrune, resumePrune, type PreparedPrune, type PruneInput } from "../src/sync/prune-history";
import { PRUNE_QUESTION, nothingToPrune, pruneStatements } from "../src/sync/prune-history-text";
import { acquirePublishLock } from "../src/sync/publish-lock";
import { MAINTENANCE_WAYS_OUT, PublishRefusedError, maintenancePending, passphraseRequired } from "../src/sync/publish-refusals";
import { UsageError, type PruneFlags } from "./args";
import { EXIT_CHECK_FAILED, EXIT_OK, type CliIo } from "./io";
import { REPORTED_FAILURES } from "./keys-command";
import { askingCostPolicy, openKeyPorts, type PortsSession } from "./keys-session";
import { createNodeHostBridge } from "./node-host-bridge";
import { assertDirectory } from "./publish-command";
import { createNodeLockContext, createNodeLockFile } from "./publish-lock-file";

/**
 * `ipfs-sync prune-history <vault> --keep <n> [--dry-run] [--yes-prune]` (mvp-07b task 1.6). Order: the vault directory and the fixture marker (before the
 * lock file is created and before anything is sent), the publish lock with the token check of the 07a standard, then the pending-journal question (a rerun
 * finishes the pending prune), then the fresh run: open the vault, every refusal of `preparePrune` (all reads), the plan on the terminal, the confirmation, the
 * removal. The lock is released on every path.
 *
 * `--dry-run` goes as far as the plan and stops. It takes no lock and its node port refuses every write, so the plan it prints is the one a real run would
 * confirm, and it cannot change anything even by mistake. Exit codes: 0 done, nothing to do, or a dry run; 1 a check, a lock, a journal or the node refused, or
 * the confirmation was not given; 2 a usage error (no request was sent).
 */

export interface PruneContext {
  readonly config: SyncConfig;
  readonly client: KuboClient;
  readonly io: CliIo;
  readonly vaultPath: string;
  readonly flags: PruneFlags;
  readonly env: EnvMap;
  readonly now: () => Date;
  /** The vault passphrase from the sources `publish` uses (environment, 0600 file, prompt); undefined when none is available. */
  readonly passphrase: () => Promise<CanonicalPassphrase | undefined>;
  /** The device-local store (the sequence floor). Production leaves it out (the per-user directory); tests pass one. */
  readonly deviceStore?: DeviceStore;
}

interface PruneSession extends PortsSession {
  readonly ctx: PruneContext;
}

const THIS_COMMAND = "prune-history";

function printHeader(ctx: PruneContext, vault: string): void {
  ctx.io.out(`ipfs-sync ${THIS_COMMAND}`);
  ctx.io.out(`  vault     ${vault}`);
  ctx.io.out(`  rpc       ${ctx.config.rpc.baseUrl}  (auth: ${describeAuth(ctx.config.rpc.auth)})`);
  ctx.io.out(`  mfs root  ${ctx.config.mfsRoot}`);
  ctx.io.out(`  key       ${ctx.config.publicationKey}`);
}

function inputFor(session: PruneSession, key: PruneInput["key"], passphrase: PruneInput["passphrase"]): PruneInput {
  const { ctx } = session;
  const costPolicy = askingCostPolicy(ctx.io);
  const keep = ctx.flags.keep as number;
  return { mfsRoot: session.mfsRoot, keyName: ctx.config.publicationKey, passphrase, key, keep, ...(costPolicy === undefined ? {} : { costPolicy }) };
}

/** A rerun: the pending prune is finished, whatever the command line asked for. */
async function resume(session: PruneSession, journal: MaintenanceJournal): Promise<number> {
  const { ctx } = session;
  if (journal.type !== "prune") throw maintenancePending(journal.type);
  const needsPassphrase = !reached(journal, "published");
  const passphrase = needsPassphrase ? await ctx.passphrase() : undefined;
  try {
    if (needsPassphrase && passphrase === undefined) throw passphraseRequired();
    const { deps, key } = await openKeyPorts(session);
    ctx.io.out(`finishing the interrupted history prune of ${session.mfsRoot} (it had reached "${journal.phase}"); the request on the command line is not carried out in this run`);
    const outcome = await resumePrune(deps, journal, inputFor(session, key, passphrase));
    ctx.io.out(`finished         ${outcome.removed} history files were removed from the working tree and the result is published`);
    ctx.io.out(`root CID         ${escapeForDisplay(outcome.snapshotRoot)}  (IPNS value)`);
    return EXIT_OK;
  } finally {
    wipe(passphrase);
  }
}

function printRemovalSet(ctx: PruneContext, prepared: PreparedPrune): void {
  for (const name of prepared.plan.removals) ctx.io.out(`  would remove  ${escapeForDisplay(name)}`);
}

async function confirmed(ctx: PruneContext): Promise<boolean> {
  if (ctx.flags.yesPrune) return true;
  return (await ctx.io.confirm?.(PRUNE_QUESTION)) === true;
}

/** The plan, the confirmation and the removal (or only the plan, for a dry run). */
async function fresh(session: PruneSession): Promise<number> {
  const { ctx } = session;
  if (!ctx.flags.dryRun && !ctx.flags.yesPrune && ctx.io.confirm === undefined) {
    throw new UsageError("prune-history needs a terminal to confirm, or --yes-prune to confirm without one, or --dry-run to only see the plan; nothing was sent");
  }
  const passphrase = await ctx.passphrase();
  if (passphrase === undefined) throw passphraseRequired();
  try {
    const { deps, key } = await openKeyPorts(session);
    ctx.io.err("opening the vault: deriving its key from the passphrase");
    const prepared = await preparePrune(deps, inputFor(session, key, passphrase));
    const { plan } = prepared;
    if (plan.removals.length === 0) {
      ctx.io.out(nothingToPrune(plan));
      return EXIT_OK;
    }
    for (const line of pruneStatements({ plan, checked: prepared.checked, sequence: prepared.start.manifest.sequence })) ctx.io.out(`  ${line}`);
    if (ctx.flags.dryRun) {
      printRemovalSet(ctx, prepared);
      ctx.io.out("dry run: nothing was removed, written or published, and no lock was taken");
      return EXIT_OK;
    }
    if (!(await confirmed(ctx))) {
      ctx.io.err("ipfs-sync: prune-history: the removal was not confirmed; nothing was changed");
      return EXIT_CHECK_FAILED;
    }
    const outcome = await executePrune(deps, prepared);
    ctx.io.out(`pruned           removed ${outcome.removed} history files; ${outcome.kept} stay`);
    ctx.io.out(`root CID         ${escapeForDisplay(outcome.snapshotRoot ?? "")}  (IPNS value)`);
    ctx.io.out(`sequence         ${prepared.start.manifest.sequence} (unchanged: manifest.enc was not touched)`);
    return EXIT_OK;
  } finally {
    // Success, refusal or throw: the secret does not outlive this call. Best effort; the runtime may hold copies.
    wipe(passphrase);
  }
}

async function runLocked(session: PruneSession): Promise<number> {
  // A journal on this device is answered first, with local reads only; a damaged one is refused here with both ways out.
  const pending = await pendingMaintenance(session.host, session.mfsRoot);
  return pending === undefined ? fresh(session) : resume(session, pending);
}

/** Failures a prune reports as a plain message with exit code 1: those of the keys commands, and its own refusals. */
const FAILURES = [...REPORTED_FAILURES, PruneHistoryError] as const;

/** Everything a prune reports without a stack: refusals and failures of the layers below, node text escaped. */
async function report(ctx: PruneContext, session: PruneSession | undefined, error: unknown): Promise<number> {
  if (error instanceof ConfigError || error instanceof UsageError) throw error;
  if (error instanceof ManifestFormatError) {
    // An authentic manifest whose content this build refuses to read: a newer version, or a path no honest writer produces. Fail closed.
    ctx.io.err(
      `ipfs-sync: ${THIS_COMMAND} failed: the vault manifest on the node holds something this build refuses to read (${escapeForDisplay(error.message)}). ` +
        "Pruning stays refused until that is fixed: a vault with even one path over the limits can neither change its passphrase nor prune its history. Nothing was changed.",
    );
    return EXIT_CHECK_FAILED;
  }
  if (!FAILURES.some((failure) => error instanceof failure)) throw error;
  ctx.io.err(`ipfs-sync: ${THIS_COMMAND} failed: ${escapeForDisplay((error as Error).message)}`);
  const namesWaysOut = error instanceof PublishRefusedError && (error.code === "maintenance-pending" || error.code === "maintenance-lost-race");
  const pending = session === undefined ? undefined : await readMaintenanceJournal(session.host.kv, session.mfsRoot).catch(() => undefined);
  if (!namesWaysOut && pending !== undefined && pending.kind !== "none") {
    ctx.io.err(`A key-management operation is pending on this device, so publish and pull are paused. ${MAINTENANCE_WAYS_OUT}`);
  }
  return EXIT_CHECK_FAILED;
}

/** The lock of a dry run: it holds nothing, and any write the ports attempt stops the run. */
const NO_LOCK: PortsSession["lock"] = {
  assertHeld: () => {
    throw new Error("a dry run holds no lock and writes nothing");
  },
};

export async function runPrune(ctx: PruneContext): Promise<number> {
  const vault = resolve(ctx.vaultPath);
  await assertDirectory(vault);
  const host = createNodeHostBridge({ root: vault, env: ctx.env, now: () => ctx.now().getTime() });
  await assertPublishMarker(host.fs);
  const mfsRoot = assertMfsMutationPath(validateMfsRoot(ctx.config.mfsRoot));
  printHeader(ctx, vault);
  let session: PruneSession | undefined;
  try {
    if (ctx.flags.dryRun) {
      session = { ctx, host, mfsRoot, lock: NO_LOCK, verifyHeld: async () => false };
      return await fresh(session);
    }
    const checked = withTokenCheck(createNodeLockFile(vault));
    const lock = await acquirePublishLock(checked.file, createNodeLockContext(() => ctx.now().getTime()));
    try {
      session = { ctx, host, mfsRoot, lock, verifyHeld: checked.verifyHeld };
      return await runLocked(session);
    } finally {
      await lock.release();
    }
  } catch (error) {
    return report(ctx, session, error);
  }
}
