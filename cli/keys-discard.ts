import { discardMaintenance } from "../src/sync/key-management";
import { DISCARD_QUESTION, discardStatements } from "../src/sync/key-management-text";
import { reached, readMaintenanceJournal, type MaintenanceRead } from "../src/sync/maintenance-journal";
import { UsageError } from "./args";
import { EXIT_CHECK_FAILED, EXIT_OK } from "./io";
import { openKeyPorts, type KeysSession } from "./keys-session";

/**
 * `keys discard` after the lock is held (`keys-command.ts`): what dropping the pending operation costs is printed first, then the confirmation, then the
 * engine takes this device's key-slot file back out of the shared tree when it is still there (the only thing discard can do to the node) and removes the
 * journal. With nothing pending it says so and sends no request.
 */

/** A rewrap that did not reach `published` may have left its file in the shared tree, and taking it back out needs the publication key. */
function needsKey(read: MaintenanceRead): boolean {
  return read.kind === "ok" && read.journal.type === "rewrap" && !reached(read.journal, "published");
}

export async function runDiscard(session: KeysSession): Promise<number> {
  const { ctx } = session;
  const read = await readMaintenanceJournal(session.host.kv, session.mfsRoot);
  for (const line of discardStatements(read)) ctx.io.out(`  ${line}`);
  if (read.kind === "none") return EXIT_OK;
  if (!ctx.yesDiscard && ctx.io.confirm === undefined) {
    throw new UsageError("discard needs a terminal to confirm, or --yes-discard to confirm without one; nothing was changed");
  }
  if (!ctx.yesDiscard && (await ctx.io.confirm?.(DISCARD_QUESTION)) !== true) {
    ctx.io.err("ipfs-sync: keys: the discard was not confirmed; nothing was changed");
    return EXIT_CHECK_FAILED;
  }
  const { acceptDeps } = await openKeyPorts(session, { lenient: !needsKey(read) });
  const outcome = await discardMaintenance(acceptDeps, session.mfsRoot);
  if (outcome.kind === "none") {
    ctx.io.out("nothing to discard: the journal was already gone");
    return EXIT_OK;
  }
  ctx.io.out(`discarded        the ${outcome.type === "damaged" ? "unreadable key-management journal" : `${outcome.type} journal (phase ${outcome.phase})`}; publish and pull are no longer paused by it`);
  ctx.io.out(
    outcome.withdrawn
      ? "node             the key-slot file this device had written into the shared tree was taken back out; the published root was not changed"
      : "node             not touched: nothing of this device's was left in the shared tree to take back",
  );
  if (read.kind === "ok" && read.journal.type === "rewrap" && reached(read.journal, "published")) {
    ctx.io.out('next             this device still holds the old key-slot copy: run "ipfs-sync keys accept-slots" with the NEW passphrase');
  }
  return EXIT_OK;
}
