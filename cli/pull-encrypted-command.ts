import { statfs } from "node:fs/promises";
import { createSyncEventBus } from "../src/core/events";
import { describeKdfCost, wipe, type KdfParams } from "../src/crypto";
import { gatewayBlobSource } from "../src/sync/blob-source";
import type { EncryptedPullOutcome, FirstPullDetails, PullTarget } from "../src/sync/encrypted-pull";
import type { FreeBytes } from "../src/sync/encrypted-pull-fetch";
import { pullEncryptedVault, type LargePullDetails, type PullStageResult, type PullVaultDeps, type PullVaultOptions } from "../src/sync/encrypted-pull-stage";
import { escapeForDisplay } from "../src/sync/path-policy";
import { PlaintextUnsupportedError } from "../src/sync/pull-errors";
import type { PullFlags as EnginePullFlags } from "../src/sync/pull-sequence";
import type { PullFlags } from "./args";
import { createLazyDeviceStore } from "./device-store-node";
import { EXIT_CHECK_FAILED, EXIT_OK, type CliIo } from "./io";
import { createNodeHostBridge } from "./node-host-bridge";
import type { PullContext } from "./pull-context";
import { createNodeLockContext, createNodeLockFile } from "./publish-lock-file";

const MIB = 1024 * 1024;

/** The target the flags name: `--root-cid`, `--manifest` (with `--name` to pick the name), or the name (`--name`, or the owned publication key). */
function encryptedTarget(flags: PullFlags): PullTarget {
  if (flags.rootCid !== undefined) return { kind: "root-cid", cid: flags.rootCid };
  if (flags.manifest !== undefined) return { kind: "manifest", cid: flags.manifest, ...(flags.name === undefined ? {} : { name: flags.name }) };
  return { kind: "name", ...(flags.name === undefined ? {} : { name: flags.name }) };
}

/** The sequence-rule flags of the engine. Only a flag that was given is set. */
export function engineFlags(flags: PullFlags): EnginePullFlags {
  return {
    allowRollback: flags.allowRollback,
    resolveFork: flags.resolveFork,
    ...(flags.expectMinSequence === undefined ? {} : { expectMinSequence: flags.expectMinSequence }),
    ...(flags.expectVaultId === undefined ? {} : { expectVaultId: flags.expectVaultId }),
  };
}

/** Free bytes of the volume the vault is on, from Node `statfs`. The engine asks only after the lock has created the directory. */
function nodeFreeBytes(directory: string): FreeBytes {
  return async () => {
    const info = await statfs(directory);
    return info.bavail * info.bsize;
  };
}

const shown = (text: string): string => escapeForDisplay(text);
/** `1234 bytes` below one MiB, `12.5 MiB` above. */
const size = (bytes: number): string => (bytes < MIB ? plural(bytes, "byte") : `${(bytes / MIB).toFixed(1)} MiB`);
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What a first pull shows before it asks. All of it is escaped by the engine or format-checked. */
function printFirstPull(io: CliIo, details: FirstPullDetails): void {
  io.out("first pull of this vault (all of it was chosen by whoever holds the vault key):");
  io.out(`  target     ${details.target}`);
  io.out(`  sequence   ${details.sequence}`);
  io.out(`  published  ${details.publishedAt}`);
  io.out(`  device     ${details.device}`);
  io.out(`  files      ${details.fileCount}`);
  if (details.pathsSummary !== undefined) io.out(`  skipped    ${details.pathsRefused}: ${details.pathsSummary}`);
  if (details.replacedLocalFiles > 0) io.out(`  replaces   ${plural(details.replacedLocalFiles, "existing local file")}; a dated copy of each is kept`);
  for (const statement of details.statements) io.out(`  ${statement}`);
}

export function costQuestion(costs: readonly KdfParams[]): string {
  return `Unlocking these key slots costs ${costs.map(describeKdfCost).join("; ")} of memory and time on this device. Continue?`;
}

/** The questions an interactive run may ask. A run that cannot ask passes none, and the engine then needs the matching flag. */
function questions(ctx: PullContext): Pick<PullVaultDeps, "confirmFirstPull" | "confirmCost" | "confirmLargePull"> {
  const { io } = ctx;
  const { confirm } = io;
  if (confirm === undefined) return {};
  return {
    confirmFirstPull: async (details) => {
      printFirstPull(io, details);
      return confirm("Pull this vault into this directory for the first time?");
    },
    confirmCost: (costs) => confirm(costQuestion(costs)),
    confirmLargePull: (details: LargePullDetails) =>
      confirm(`${plural(details.fileCount, "file")}, ${size(details.totalBytes)}, must be downloaded, above the ceiling of ${size(details.ceilingBytes)}. Continue?`),
  };
}

function printSkips(io: CliIo, result: PullStageResult): void {
  for (const skip of result.settlement.skipped) {
    if (skip.severity === "expected") io.out(`  skipped (expected) ${shown(skip.path)}: ${skip.reason}`);
    else io.err(`  skipped (unsafe, ${skip.class}) ${shown(skip.path)}: ${skip.reason}`);
  }
}

/** Each kind of path that needs attention, on its own: integrity failures, files that were not fetched, skipped paths. */
function printLists(io: CliIo, result: PullStageResult): void {
  const { settlement } = result;
  for (const problem of settlement.integrityFailed) io.err(`  integrity-failed ${shown(problem.path)}: ${shown(problem.reason)}`);
  for (const problem of settlement.unfetched) io.err(`  unfetched ${shown(problem.path)}: ${shown(problem.reason)}`);
  printSkips(io, result);
  for (const path of settlement.remoteDeleted) io.out(`  remote-deleted ${shown(path)} (kept locally)`);
  for (const path of settlement.locallyModified) io.out(`  locally modified ${shown(path)} (left as is)`);
}

function printNotes(io: CliIo, result: PullStageResult): void {
  if (result.exclusionWarning !== undefined) io.err(`warning: ${result.exclusionWarning}`);
  if (result.large?.confirmed === false) {
    io.err(
      `note: this pull needs ${size(result.large.totalBytes)}, above the ceiling of ${size(result.large.ceilingBytes)}, and was not confirmed; nothing was fetched. Run it again with --accept-large, or raise the ceiling with --max-bytes.`,
    );
  }
  if (result.journalSetAside !== undefined) {
    io.out(`note: a pending publish of sequence ${result.journalSetAside.sequence} lost to the pulled manifest; its journal was moved to .ipfs-sync/${result.journalSetAside.name}`);
  }
  if (result.forkResolution !== undefined) {
    io.out(result.forkResolution.note === undefined ? "note: the fork was resolved with the common ancestor manifest as the base" : `note: ${result.forkResolution.note}`);
  }
  if (result.verdict === "restore") {
    io.out(
      `note: restore of sequence ${result.sequence}: files that exist only in later versions are not removed, local edits were kept as conflict copies, the recorded highest sequence is unchanged, and the next publish will make the result a new version`,
    );
  }
}

export function summaryLine(result: PullStageResult): string {
  const { settlement } = result;
  return [
    `${settlement.fetched.length} fetched`,
    `${settlement.unchanged.length} unchanged`,
    `${settlement.conflicts.length} conflicts`,
    `${settlement.integrityFailed.length} integrity-failed`,
    `${settlement.unfetched.length} unfetched`,
    `${settlement.skipped.length} skipped`,
    `${settlement.remoteDeleted.length} remote-deleted`,
    `${settlement.locallyModified.length} locally modified`,
  ].join(", ");
}

/**
 * Exit 1 for a stop (nothing was written), 1 when any path is integrity-failed, unfetched or an unsafe skip, else 0. A root that
 * lists a `manifest.json` and holds no key slots is refused with `PlaintextUnsupportedError` (exit 2 in `runPull`): it is a
 * plaintext publication, and no code path of this version reads one.
 */
function report(io: CliIo, outcome: EncryptedPullOutcome<PullStageResult>): number {
  if (outcome.kind === "stopped" && outcome.stop.reason === "plaintext-root") throw new PlaintextUnsupportedError();
  if (outcome.kind === "stopped") {
    io.err(`ipfs-sync: pull stopped: ${outcome.stop.message}`);
    return EXIT_CHECK_FAILED;
  }
  const { verified, result } = outcome;
  printNotes(io, result);
  printLists(io, result);
  io.out(`root CID   ${verified.target.rootCid}${verified.target.kind === "name" ? "  (IPNS value)" : ""}`);
  io.out(`snapshot  ${verified.manifest.rootCID}  (manifest rootCID)`);
  io.out(`sequence  ${result.sequence}`);
  io.out(summaryLine(result));
  return result.settlement.needsAttention ? EXIT_CHECK_FAILED : EXIT_OK;
}

function buildOptions(ctx: PullContext, passphrase: PullVaultOptions["passphrase"]): PullVaultOptions {
  const { config, flags } = ctx;
  return {
    mfsRoot: config.mfsRoot,
    keyName: config.publicationKey,
    ownedKeys: config.ownedKeys,
    target: encryptedTarget(flags),
    flags: engineFlags(flags),
    passphrase,
    acceptFirstPull: flags.acceptFirstPull,
    acceptLarge: flags.acceptLarge,
    ...(flags.maxBytes === undefined ? {} : { confirmAboveBytes: flags.maxBytes }),
  };
}

/**
 * The decrypting pull of `<vault>`: the engine with the Node host, the Node lock file, the per-user device store, streamed blobs
 * and the free-space port. The passphrase is asked for here, after the invocation and the destination were accepted, and is wiped
 * when the engine returns. The engine writes the first-pull confirmation, key-slot copy, floor, files and state; this function
 * prints what came back and chooses the exit code.
 */
export async function runEncryptedPull(ctx: PullContext, vault: string): Promise<number> {
  const now = (): number => ctx.now().getTime();
  const host = createNodeHostBridge({ root: vault, env: ctx.env, now });
  const bus = createSyncEventBus();
  bus.on("conflict", (event) => ctx.io.out(`  conflict ${shown(event.path)} -> ${shown(event.conflictPath)}`));
  bus.onListenerFailure((failure) => ctx.io.err(`warning: ${failure.event} listener failed`));
  const passphrase = await ctx.passphrase();
  try {
    const outcome = await pullEncryptedVault(
      {
        client: ctx.client,
        host,
        deviceStore: createLazyDeviceStore(ctx.env),
        lockFile: createNodeLockFile(vault),
        lockContext: createNodeLockContext(now),
        now,
        sources: { source: (location) => gatewayBlobSource(ctx.client, location) },
        freeBytes: ctx.freeBytes ?? nodeFreeBytes(vault),
        bus,
        ...questions(ctx),
      },
      buildOptions(ctx, passphrase),
    );
    return report(ctx.io, outcome);
  } finally {
    // Success, stop or throw: the canonical bytes do not outlive this call. Best effort; the runtime may hold copies.
    wipe(passphrase);
  }
}
