import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { describeKdfCost, generatePassphrase, wipe, type GeneratedPassphrase, type RewrapSecret } from "../src/crypto";
import { COST_PRESETS, executeRewrap, planRewrapCost, prepareRewrap, resumeRewrap, type KeyManagementInput } from "../src/sync/key-management";
import { rewrapStatements, type RewrapKind } from "../src/sync/key-management-text";
import { reached, readMaintenanceJournal, type MaintenanceJournal } from "../src/sync/maintenance-journal";
import { escapeForDisplay } from "../src/sync/path-policy";
import { passphraseRequired } from "../src/sync/publish-refusals";
import { UsageError } from "./args";
import { EXIT_CHECK_FAILED, EXIT_OK } from "./io";
import { askingCostPolicy, confirmDowngrade, confirmRevocation, openKeyPorts, type KeysContext, type KeysSession, type KeysSubcommand } from "./keys-session";
import { assertPassphraseFileCreatable, createPassphraseFile, hasPosixModes } from "./passphrase-file";
import { NO_POSIX_CHECK_TEXT, NO_RECOVERY_TEXT, passphraseFileContent, showAndConfirm, type ShowWords } from "./passphrase-show";

/**
 * `keys change-passphrase` and `keys increase-cost` after the lock is held and the pending-journal question is answered (`keys-command.ts`). The
 * order of the questions is the point: the statements come before either confirmation works, the lower-cost question before the revocation one, and the
 * new passphrase is shown and retyped before the first derivation of the rewrap, so a person has seen and saved it before anything can change.
 */

const KEYS_WORDS: ShowWords = {
  heading: "Your NEW vault passphrase (shown once, never stored by this program):",
  nothingDone: "nothing was changed and nothing was written to the node",
};

const DERIVATION_NOTE = "deriving keys: four derivations, each takes a few seconds and as much memory as the cost shown above";

/** The two subcommands that rewrap; `accept-slots` and `discard` never reach this file. */
function rewrapKindOf(subcommand: KeysSubcommand): RewrapKind {
  if (subcommand === "change-passphrase" || subcommand === "increase-cost") return subcommand;
  throw new Error(`keys ${subcommand} is not a rewrap`);
}

/** Usage errors that depend on whether this run starts a rewrap: refused before any request, with the lock already held. */
async function checkFreshInvocation(ctx: KeysContext): Promise<void> {
  if (ctx.subcommand === "change-passphrase") {
    if (ctx.passphraseFile === undefined && ctx.terminal?.input.isTTY !== true) {
      throw new UsageError("change-passphrase needs a terminal to show the new passphrase, or --passphrase-file <path> to write it to a new file; nothing was sent");
    }
    if (ctx.passphraseFile !== undefined) await assertPassphraseFileCreatable(resolve(ctx.passphraseFile), ctx.file);
  }
  if (!ctx.flags.acceptNoRevocation && ctx.io.confirm === undefined) {
    throw new UsageError(`${ctx.subcommand} needs a terminal to confirm, or --accept-no-revocation to confirm without one; nothing was sent`);
  }
}

/** Show the new passphrase once on the terminal (returns undefined), or write it to a new 0600 file (returns the path). */
async function showOrSave(ctx: KeysContext, generated: GeneratedPassphrase): Promise<string | undefined> {
  if (ctx.passphraseFile === undefined) {
    await showAndConfirm(ctx.terminal as NonNullable<KeysContext["terminal"]>, generated, KEYS_WORDS);
    return undefined;
  }
  if (!hasPosixModes(ctx.file)) ctx.io.err(NO_POSIX_CHECK_TEXT);
  const content = passphraseFileContent(generated);
  try {
    return await createPassphraseFile(resolve(ctx.passphraseFile), content, ctx.file);
  } finally {
    wipe(content);
  }
}

const journalExists = async (session: KeysSession): Promise<boolean> => (await readMaintenanceJournal(session.host.kv, session.mfsRoot)).kind !== "none";

function inputFor(session: KeysSession, key: KeyManagementInput["key"], passphrase: KeyManagementInput["passphrase"]): KeyManagementInput {
  const { ctx } = session;
  const costPolicy = askingCostPolicy(ctx.io);
  return { mfsRoot: session.mfsRoot, keyName: ctx.config.publicationKey, passphrase, key, ...(costPolicy === undefined ? {} : { costPolicy }) };
}

/** A rerun: the pending rewrap is finished, whatever the command line asked for. */
async function resume(session: KeysSession, journal: MaintenanceJournal): Promise<number> {
  const { ctx } = session;
  const needsPassphrase = journal.type === "rewrap" && !reached(journal, "published");
  const passphrase = needsPassphrase ? await ctx.passphrase() : undefined;
  try {
    if (needsPassphrase && passphrase === undefined) throw passphraseRequired();
    const { deps, key } = await openKeyPorts(session);
    ctx.io.out(`finishing the interrupted key-slot rewrap of ${session.mfsRoot} (it had reached "${journal.phase}"); the request on the command line is not carried out in this run`);
    const outcome = await resumeRewrap(deps, journal, inputFor(session, key, passphrase));
    ctx.io.out("finished         the key-slot copy and the record on this device now match the file on the node");
    ctx.io.out(`root CID         ${escapeForDisplay(outcome.snapshotRoot)}  (IPNS value)`);
    ctx.io.out("note: the new passphrase was not tested again in this run, because it is not stored; the key-slot file on the node was compared byte for byte with the one this rewrap wrote");
    return EXIT_OK;
  } finally {
    wipe(passphrase);
  }
}

async function fresh(session: KeysSession): Promise<number> {
  const { ctx } = session;
  await checkFreshInvocation(ctx);
  const passphrase = await ctx.passphrase();
  if (passphrase === undefined) throw passphraseRequired();
  let generated: GeneratedPassphrase | undefined;
  let written: string | undefined;
  try {
    const { deps, key } = await openKeyPorts(session);
    ctx.io.err("opening the vault: deriving its key from the passphrase");
    const prepared = await prepareRewrap(deps, inputFor(session, key, passphrase));
    const preset = ctx.flags.cost === undefined ? undefined : COST_PRESETS[ctx.flags.cost];
    const kind = rewrapKindOf(ctx.subcommand);
    const plan = planRewrapCost(prepared.vault.keySlots, { kind, cost: preset });
    for (const line of rewrapStatements(kind, plan)) ctx.io.out(`  ${line}`);
    if (!(await confirmDowngrade(ctx.io, plan, ctx.flags.allowDowngrade))) {
      ctx.io.err("ipfs-sync: keys: the lower cost was not confirmed (a run without a terminal needs --allow-downgrade); nothing was changed");
      return EXIT_CHECK_FAILED;
    }
    if (!(await confirmRevocation(ctx.io, ctx.flags))) {
      ctx.io.err("ipfs-sync: keys: the change was not confirmed; nothing was changed");
      return EXIT_CHECK_FAILED;
    }
    let next: RewrapSecret = { kind: "reuse" };
    if (ctx.subcommand === "change-passphrase") {
      generated = generatePassphrase();
      written = await showOrSave(ctx, generated);
      next = { kind: "generated", passphrase: generated };
    }
    ctx.io.err(`${DERIVATION_NOTE} (${describeKdfCost(plan.next)})`);
    const costPolicy = askingCostPolicy(ctx.io);
    const outcome = await executeRewrap(deps, prepared, {
      passphrase,
      next,
      params: plan.next,
      ...(plan.downgrade ? { allowDowngrade: true } : {}),
      ...(costPolicy === undefined ? {} : { costPolicy }),
    });
    ctx.io.out(ctx.subcommand === "change-passphrase" ? "rewrapped        passphrase changed" : `rewrapped        cost raised to ${describeKdfCost(outcome.params)}`);
    ctx.io.out(`new slot         ${outcome.slotId}  (public)`);
    ctx.io.out(`cost             ${describeKdfCost(outcome.params)}`);
    ctx.io.out(`root CID         ${escapeForDisplay(outcome.snapshotRoot)}  (IPNS value)`);
    ctx.io.out(`sequence         ${prepared.start.manifest.sequence} (unchanged: manifest.enc was not touched)`);
    ctx.io.out("test unlock      the new passphrase opened the published key-slot file, and manifest.enc of that root authenticated under it");
    if (written !== undefined) {
      ctx.io.out(`passphrase file  ${written}`);
      ctx.io.err(`The new passphrase was generated and written to ${written}; it was not printed. Copy it into a password manager now.`);
      ctx.io.err(NO_RECOVERY_TEXT);
    }
    return EXIT_OK;
  } catch (error) {
    if (written !== undefined) await settlePassphraseFile(session, written);
    throw error;
  } finally {
    // Success, refusal or throw: the secrets do not outlive this call. Best effort; the runtime may hold copies.
    wipe(passphrase, generated);
  }
}

/** A passphrase file written for a rewrap that never reached the node protects nothing and is removed; one the new slot may already depend on is kept. */
async function settlePassphraseFile(session: KeysSession, path: string): Promise<void> {
  const { io } = session.ctx;
  if (!(await journalExists(session))) {
    await rm(path, { force: true }).catch(() => io.err(`warning: could not remove the unused passphrase file ${path}; delete it`));
    return;
  }
  io.err(`the new passphrase file ${path} was kept: the new key slot may already be on the node and only that passphrase opens it`);
}

/** Run the rewrap the subcommand names, or finish the one that is pending. */
export function runRewrap(session: KeysSession, pending: MaintenanceJournal | undefined): Promise<number> {
  return pending === undefined ? fresh(session) : resume(session, pending);
}
