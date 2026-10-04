import { describeKdfCost, wipe } from "../src/crypto";
import { commitAcceptance, prepareAcceptance, type AcceptTarget, type PreparedAcceptance } from "../src/sync/key-management";
import { acceptStatements, discardStatements } from "../src/sync/key-management-text";
import { reached } from "../src/sync/maintenance-journal";
import { escapeForDisplay } from "../src/sync/path-policy";
import { PullTargetError } from "../src/sync/pull-errors";
import { passphraseRequired } from "../src/sync/publish-refusals";
import { chooseIpnsName, isCid, resolveRootCid } from "../src/sync/target-resolution";
import { EXIT_CHECK_FAILED, EXIT_OK } from "./io";
import { askingCostConfirm, confirmAcceptDowngrade, openKeyPorts, type KeysSession } from "./keys-session";

/**
 * `keys accept-slots` after the lock is held (`keys-command.ts`). The statements come first; the passphrase is obtained before any request; the name is
 * resolved ONCE (or the root is the one named on the command line) and both files are read from that one root; a cheaper incoming slot is shown with both
 * costs and needs its own yes; only then is anything written. The order of the writes is the engine's (`commitAcceptance`).
 */

/** The one root of this run: `--root-cid`, or the root the name resolves to now. */
async function resolveTarget(session: KeysSession): Promise<AcceptTarget> {
  const { ctx } = session;
  const { accept } = ctx;
  if (accept.rootCid !== undefined) {
    if (!isCid(accept.rootCid)) throw new PullTargetError("--root-cid needs a CID");
    return { kind: "root-cid", rootCid: accept.rootCid };
  }
  const ipnsName = await chooseIpnsName(ctx.client, { name: accept.name, keyName: ctx.config.publicationKey, ownedKeys: ctx.config.ownedKeys });
  return { kind: "name", rootCid: await resolveRootCid(ctx.client, ipnsName) };
}

/** A journal of an unpublished rewrap may have written into the shared tree; taking that back out needs the publication key. */
function needsWithdrawal(prepared: PreparedAcceptance): boolean {
  const { maintenance } = prepared;
  return maintenance.kind === "ok" && maintenance.journal.type === "rewrap" && !reached(maintenance.journal, "published");
}

function printPlan(session: KeysSession, prepared: PreparedAcceptance): void {
  const { io } = session.ctx;
  const { acceptance } = prepared;
  io.out(`  vault id  ${acceptance.vaultId}  (public)`);
  io.out(`  manifest  sequence ${acceptance.manifest.sequence}, verdict "${acceptance.verdict.kind}"`);
  if (acceptance.downgrade !== undefined) {
    io.out(`  cost      the incoming slot costs ${describeKdfCost(acceptance.downgrade.incoming)}; this device's copy costs ${describeKdfCost(acceptance.downgrade.current)}`);
  }
  if (prepared.maintenance.kind !== "none") for (const line of discardStatements(prepared.maintenance)) io.out(`  pending   ${line}`);
}

function printOutcome(session: KeysSession, prepared: PreparedAcceptance, outcome: Awaited<ReturnType<typeof commitAcceptance>>): void {
  const { io } = session.ctx;
  const root = escapeForDisplay(prepared.target.rootCid);
  io.out(`accepted         this device's key-slot copy now is the file of root ${root}`);
  io.out(`copy             ${outcome.copyReplaced ? "replaced" : "already the same file"}`);
  io.out(`record           ${outcome.stateUpdated ? "keyslotsSha256 updated" : "already current"}${outcome.publishJournalUpdated ? "; the pending publish journal follows it" : ""}`);
  if (outcome.maintenanceCleared === "removed") {
    io.out(`pending          the unfinished key-management operation on this device was dropped${outcome.withdrawn ? "; its key-slot file was taken back out of the shared tree on the node" : ""}`);
  }
  io.out(`next             run "ipfs-sync pull" to bring the files up to date; the sequence floor was not changed`);
}

export async function runAccept(session: KeysSession): Promise<number> {
  const { ctx } = session;
  for (const line of acceptStatements(ctx.accept.rootCid === undefined ? "name" : "root-cid")) ctx.io.out(`  ${line}`);
  const passphrase = await ctx.passphrase();
  if (passphrase === undefined) throw passphraseRequired();
  try {
    const ports = await openKeyPorts(session, { lenient: true });
    const target = await resolveTarget(session);
    ctx.io.out(`  root      ${escapeForDisplay(target.rootCid)}  (${target.kind === "name" ? "the name, resolved once" : "named on the command line"})`);
    ctx.io.err("deriving keys: one derivation of the incoming key slot (about the cost of the slot)");
    const confirmCost = askingCostConfirm(ctx.io);
    const prepared = await prepareAcceptance(ports.acceptDeps, {
      mfsRoot: session.mfsRoot,
      passphrase,
      target,
      flags: { allowRollback: ctx.accept.allowRollback, expectVaultId: ctx.accept.expectVaultId, expectMinSequence: ctx.accept.expectMinSequence },
      ...(confirmCost === undefined ? {} : { confirmCost }),
    });
    printPlan(session, prepared);
    const { work } = prepared;
    if (!work.copy && !work.state && !work.publishJournal && !work.maintenance) {
      ctx.io.out("nothing to accept: this device's key-slot copy already is the file in this root, and nothing else is pending");
      return EXIT_OK;
    }
    if (needsWithdrawal(prepared) && ports.keyRefusal !== undefined) throw ports.keyRefusal;
    if (!(await confirmAcceptDowngrade(ctx.io, prepared.acceptance.downgrade, ctx.flags.allowDowngrade))) {
      ctx.io.err("ipfs-sync: keys: the cheaper key slot was not confirmed (a run without a terminal needs --allow-downgrade); nothing was changed");
      return EXIT_CHECK_FAILED;
    }
    const outcome = await commitAcceptance(ports.acceptDeps, prepared, { downgradeConfirmed: prepared.acceptance.downgrade !== undefined });
    printOutcome(session, prepared, outcome);
    return EXIT_OK;
  } finally {
    // Success, refusal or throw: the secret does not outlive this call. Best effort; the runtime may hold copies.
    wipe(passphrase);
  }
}
