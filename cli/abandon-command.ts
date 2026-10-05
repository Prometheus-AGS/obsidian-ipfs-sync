import { resolve } from "node:path";
import { assertMfsMutationPath, validateMfsRoot, type EnvMap, type SyncConfig } from "../src/core/config";
import { acquirePublishLock } from "../src/sync/publish-lock";
import { PublishRefusedError } from "../src/sync/publish-refusals";
import { DeviceStoreError, type DeviceStore } from "../src/sync/device-store";
import { ABANDON_CONFIRMATION, STATE_DIR, VaultKeysError, abandonVault, describeAbandonFloor, rootDigest } from "../src/sync/vault-keys";
import { createLazyDeviceStore } from "./device-store-node";
import { UsageError } from "./args";
import { EXIT_CHECK_FAILED, EXIT_OK, type CliIo } from "./io";
import { HostPathError, createNodeHostBridge } from "./node-host-bridge";
import { assertDirectory } from "./publish-command";
import { createNodeLockContext, createNodeLockFile } from "./publish-lock-file";

export interface AbandonContext {
  readonly config: Pick<SyncConfig, "mfsRoot">;
  readonly io: CliIo;
  readonly vaultPath: string;
  readonly env: EnvMap;
  readonly now: () => Date;
  /** `--yes-abandon`: the only way to confirm without typing the word. */
  readonly yesAbandon: boolean;
  /** The device-local store the floor is read from. Production leaves it out (the per-user directory); tests pass one. */
  readonly deviceStore?: DeviceStore;
}

/** The word typed on a terminal. The plugin's dialog accepts the same word, compared the same way. */
export const ABANDON_WORD = "abandon";

/** The local files `abandon` moves, in the order `abandonVault` moves them: all four kinds it looks for (`maintenance` is a pending rewrap or prune). */
const LOCAL_KINDS = ["keyslots", "state", "journal", "maintenance"] as const;

/** Failures `abandon` reports as a plain message with exit code 1. */
const REPORTED_FAILURES = [VaultKeysError, PublishRefusedError, HostPathError, DeviceStoreError] as const;

const CONSEQUENCES: readonly string[] = [
  "This device keeps a backup of its local key-slot copy, sync state, journal and key-management journal for this MFS root (moved, not deleted).",
  "Nothing on the node is changed or deleted. This command sends no request to it.",
  "A pending key-slot rewrap or history prune is dropped from this device. Its write to the node is not withdrawn: a rewritten key-slot file may stay in the shared tree. To withdraw it, run `ipfs-sync keys discard` before you abandon.",
  "You can then create a new vault, with `ipfs-sync init`, in an empty MFS root (use a new --mfs-root).",
];

export function typedAbandonWord(text: string): boolean {
  return text.trim().toLowerCase() === ABANDON_WORD;
}

/** The local files present for this root: what the command would move. */
async function presentFiles(fs: ReturnType<typeof createNodeHostBridge>["fs"], digest: string): Promise<string[]> {
  const present: string[] = [];
  for (const kind of LOCAL_KINDS) {
    const path = `${STATE_DIR}/${kind}.${digest}.json`;
    if ((await fs.stat(path)) !== undefined) present.push(path);
  }
  return present;
}

/**
 * Show the consequences, then obtain the confirmation. Returns false when the user typed something else (nothing is
 * moved). Throws `UsageError` when there is no way to confirm: no terminal and no `--yes-abandon`.
 */
async function confirmAbandon(ctx: AbandonContext): Promise<boolean> {
  if (ctx.yesAbandon) return true;
  if (ctx.io.prompt === undefined) {
    throw new UsageError("abandon needs a terminal to type the word \"abandon\", or --yes-abandon to confirm without one; nothing was moved");
  }
  const typed = await ctx.io.prompt(`Type "${ABANDON_WORD}" to confirm: `);
  return typed !== undefined && typedAbandonWord(typed);
}

/**
 * `ipfs-sync abandon <vault>`: move this MFS root's local key-slot copy, sync state, journal and key-management journal into a backup folder
 * under `<vault>/.ipfs-sync/abandoned-*`. It never sends a request to the node and never deletes anything (the spec's
 * "abandon this vault" action). The confirmation is the typed word on a terminal, or the explicit `--yes-abandon`.
 * The publish lock is held while files move, so a publish running on this vault cannot be writing them.
 */
export async function runAbandon(ctx: AbandonContext): Promise<number> {
  const vault = resolve(ctx.vaultPath);
  await assertDirectory(vault);
  const mfsRoot = assertMfsMutationPath(validateMfsRoot(ctx.config.mfsRoot));
  const host = createNodeHostBridge({ root: vault, env: ctx.env, now: () => ctx.now().getTime() });
  try {
    const found = await presentFiles(host.fs, await rootDigest(mfsRoot));
    ctx.io.out("ipfs-sync abandon");
    ctx.io.out(`  vault     ${vault}`);
    ctx.io.out(`  mfs root  ${mfsRoot}`);
    if (found.length === 0) {
      ctx.io.err("ipfs-sync: abandon: this device holds no key-slot copy, state, journal or key-management journal for this MFS root (check --mfs-root); nothing was moved");
      return EXIT_CHECK_FAILED;
    }
    for (const line of CONSEQUENCES) ctx.io.out(`  - ${line}`);
    for (const path of found) ctx.io.out(`  will move ${path}`);
    if (!(await confirmAbandon(ctx))) {
      ctx.io.err(`ipfs-sync: abandon: the word "${ABANDON_WORD}" was not typed; nothing was moved`);
      return EXIT_CHECK_FAILED;
    }
    const lock = await acquirePublishLock(createNodeLockFile(vault), createNodeLockContext(() => ctx.now().getTime()));
    try {
      // The per-user directory is located only when the floor is read, so a root with no resolvable vault never needs it.
      const deviceStore: DeviceStore = ctx.deviceStore ?? createLazyDeviceStore(ctx.env);
      const { backupDir, moved, floor } = await abandonVault({ fs: host.fs, mfsRoot, confirmation: ABANDON_CONFIRMATION, nowMs: ctx.now().getTime(), deviceStore });
      ctx.io.out(`abandoned        ${moved.length} file${moved.length === 1 ? "" : "s"} moved to ${backupDir}`);
      ctx.io.out("node             not contacted; nothing on it was changed");
      ctx.io.out(describeAbandonFloor(floor));
      ctx.io.out("next: run `ipfs-sync init <vault> --mfs-root <new root>` to create a new vault in an empty MFS root");
      return EXIT_OK;
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (REPORTED_FAILURES.some((failure) => error instanceof failure)) {
      ctx.io.err(`ipfs-sync: abandon failed: ${(error as Error).message}`);
      return EXIT_CHECK_FAILED;
    }
    throw error;
  }
}
