import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { HostFs } from "../src/core/host-bridge";
import { assertMfsMutationPath, validateMfsRoot, type EnvMap, type SyncConfig } from "../src/core/config";
import {
  CryptoError,
  PassphraseFormatError,
  canonicalizePassphrase,
  constantTimeEqual,
  formatPassphrase,
  generatePassphrase,
  wipe,
  type GeneratedPassphrase,
} from "../src/crypto";
import { KuboError, type KuboClient } from "../src/kubo";
import { writeKeySlotsFile } from "../src/sync/encrypted-transfer";
import { assertPublishMarker } from "../src/sync/fixture-marker";
import { createRootInspector, type RootInspector } from "../src/sync/node-reader";
import { acquirePublishLock, type PublishLock } from "../src/sync/publish-lock";
import { PublishRefusedError } from "../src/sync/publish-refusals";
import { RootStateError, readRootState, type RootState } from "../src/sync/root-state";
import { VaultKeysError, keySlotsCopyPath, openVault, type OpenedVault } from "../src/sync/vault-keys";
import { UsageError } from "./args";
import { EXIT_CHECK_FAILED, EXIT_OK, type CliIo } from "./io";
import { HostPathError, createNodeHostBridge } from "./node-host-bridge";
import { PassphraseInputError } from "./passphrase-errors";
import { assertPassphraseFileCreatable, createPassphraseFile, hasPosixModes, type FileHost } from "./passphrase-file";
import { PASSPHRASE_ENV, PASSPHRASE_FILE_ENV } from "./passphrase-input";
import { promptHidden, type PromptTerminal } from "./passphrase-prompt";
import { assertDirectory } from "./publish-command";
import { createNodeLockContext, createNodeLockFile } from "./publish-lock-file";

export interface InitContext {
  readonly config: SyncConfig;
  readonly client: KuboClient;
  readonly io: CliIo;
  readonly vaultPath: string;
  readonly env: EnvMap;
  readonly now: () => Date;
  /** `--passphrase-file <path>`: the non-interactive mode. Absent: the interactive mode, which needs `terminal`. */
  readonly passphraseFile: string | undefined;
  readonly terminal: PromptTerminal | undefined;
  readonly file: FileHost;
}

/** The root already holds a vault, so `init` has nothing to create. */
export class InitRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitRefusedError";
  }
}

const NO_RECOVERY_TEXT =
  "There is no recovery. If this passphrase is lost, the vault's data is lost permanently: nobody can reset it or decrypt the data without it. Keep a copy in a password manager.";
const CASE_TEXT = "Letters are not case-sensitive and the hyphens are optional when you type it.";
const GROUP_SIZE = 5;
const FILE_GROUP_SEPARATOR = 0x2d;
const LINE_FEED = 0x0a;

/** Failures `init` reports as a plain message with exit code 1. */
const REPORTED_FAILURES = [
  InitRefusedError,
  PassphraseInputError,
  VaultKeysError,
  PublishRefusedError,
  RootStateError,
  CryptoError,
  HostPathError,
  KuboError,
] as const;

/** The 25 symbols in five hyphen-separated groups with a line feed, as bytes (no string copy of the secret is made). */
function fileContent(generated: GeneratedPassphrase): Uint8Array {
  const groups = generated.length / GROUP_SIZE;
  const out = new Uint8Array(generated.length + groups);
  let at = 0;
  for (let group = 0; group < groups; group += 1) {
    out.set(generated.subarray(group * GROUP_SIZE, (group + 1) * GROUP_SIZE), at);
    at += GROUP_SIZE;
    out[at] = group === groups - 1 ? LINE_FEED : FILE_GROUP_SEPARATOR;
    at += 1;
  }
  return out;
}

/** Show the passphrase once, then require it again. A mismatch, or text that is not a valid passphrase, creates nothing. */
async function showAndConfirm(terminal: PromptTerminal, generated: GeneratedPassphrase): Promise<void> {
  if (terminal.output.isTTY !== true) {
    throw new PassphraseInputError("no-terminal", "the passphrase can only be shown on a terminal, and standard error is not one; use --passphrase-file <path>");
  }
  terminal.output.write(
    [
      "",
      "Your vault passphrase (shown once, never stored by this program):",
      "",
      `    ${formatPassphrase(generated)}`,
      "",
      "Save it in a password manager now. " + CASE_TEXT,
      NO_RECOVERY_TEXT,
      "",
      "",
    ].join("\n"),
  );
  const typed = await promptHidden(terminal, "Enter the passphrase again to confirm: ");
  try {
    const canonical = canonicalizePassphrase(typed);
    const same = constantTimeEqual(canonical, generated);
    wipe(canonical);
    if (!same) throw new PassphraseInputError("mismatch", "the passphrase entered again does not match; no vault was created and nothing was written to the node");
  } catch (error) {
    if (error instanceof PassphraseFormatError) {
      throw new PassphraseInputError("mismatch", `the passphrase entered again is not valid (${error.message}); no vault was created and nothing was written to the node`);
    }
    throw error;
  } finally {
    wipe(typed);
  }
}

/** `init` creates a vault only in an empty root: any entry at all, a vault's or not, is refused. */
async function assertRootIsEmpty(inspector: RootInspector): Promise<void> {
  const { entries } = await inspector.view();
  if (entries.has("keyslots.json") || entries.has("manifest.enc")) {
    throw new InitRefusedError("this MFS root already holds a vault (key slots or a manifest are present); init creates a vault only in an empty root. Use a new --mfs-root. Nothing was written.");
  }
  if (entries.size > 0) {
    throw new InitRefusedError(`this MFS root is not empty (it holds ${entries.size} ${entries.size === 1 ? "entry" : "entries"}); init creates a vault only in an empty root. Use a new --mfs-root. Nothing was written.`);
  }
}

async function createVaultKeysAndCopy(
  ctx: InitContext,
  mfsRoot: string,
  generated: GeneratedPassphrase,
  inspector: RootInspector,
  state: RootState | undefined,
  fs: HostFs,
): Promise<OpenedVault> {
  ctx.io.err("creating the vault: deriving its key from the passphrase (a few seconds, 64 MiB of memory)");
  return openVault({
    fs,
    mfsRoot,
    passphrase: generated,
    local: { hasState: state !== undefined, vaultId: state?.vaultId, keyslotsSha256: state?.keyslotsSha256 },
    node: { fetchKeySlots: () => inspector.readKeySlots(), manifestPresent: async () => (await inspector.view()).entries.has("manifest.enc") },
    create: generated,
  });
}

function printFileConsequences(ctx: InitContext, path: string): void {
  ctx.io.out(`passphrase file  ${path}`);
  ctx.io.err(`The passphrase was generated and written to ${path}; it was not printed. Copy it into a password manager now.`);
  ctx.io.err(NO_RECOVERY_TEXT);
}

const NO_POSIX_CHECK_TEXT =
  "warning: Windows has no POSIX mode check, so nothing verifies that only you can read the passphrase file: it inherits the access list of its folder. Keep the folder private and copy the file somewhere safe.";

/**
 * Keep the passphrase file unless this device holds no key-slot copy. The copy is written before the vault is finished, so a
 * failure after that point leaves a copy only this passphrase opens; deleting the file would orphan the vault. Never throws:
 * the error that got us here is the one the user must see.
 */
async function discardUnusedPassphraseFile(ctx: InitContext, fs: HostFs, mfsRoot: string, path: string): Promise<void> {
  const copyExists = await keySlotsCopyPath(mfsRoot)
    .then(async (copyPath) => (await fs.stat(copyPath)) !== undefined)
    .catch(() => true);
  if (copyExists) {
    ctx.io.err(`the passphrase file ${path} was kept: this device holds the vault's key-slot copy and only that passphrase opens it; \`ipfs-sync publish\` with IPFS_SYNC_PASSPHRASE_FILE set to that file continues`);
    return;
  }
  await rm(path, { force: true }).catch(() => ctx.io.err(`warning: could not remove the unused passphrase file ${path}; delete it before running init again`));
}

/** Steps that change something: show or write the passphrase, create the vault locally, then put its key slots on the node. */
async function createVault(ctx: InitContext, lock: PublishLock, mfsRoot: string, generated: GeneratedPassphrase): Promise<void> {
  const host = createNodeHostBridge({ root: resolve(ctx.vaultPath), env: ctx.env, now: () => ctx.now().getTime() });
  // Read-only checks first, so a root that cannot take a vault is reported before the passphrase is shown or written.
  const inspector = createRootInspector(ctx.client, mfsRoot);
  await assertRootIsEmpty(inspector);
  const state = await readRootState(host.kv, mfsRoot);
  if (ctx.passphraseFile === undefined) {
    if (ctx.terminal === undefined) throw new PassphraseInputError("no-terminal", "init needs an interactive terminal");
    await showAndConfirm(ctx.terminal, generated);
  } else if (!hasPosixModes(ctx.file)) {
    ctx.io.err(NO_POSIX_CHECK_TEXT);
  }
  let written: string | undefined;
  if (ctx.passphraseFile !== undefined) {
    const content = fileContent(generated);
    try {
      written = await createPassphraseFile(ctx.passphraseFile, content, ctx.file);
    } finally {
      wipe(content);
    }
  }
  let opened: OpenedVault;
  try {
    opened = await createVaultKeysAndCopy(ctx, mfsRoot, generated, inspector, state, host.fs);
  } catch (error) {
    if (written !== undefined) await discardUnusedPassphraseFile(ctx, host.fs, mfsRoot, written);
    throw error;
  }
  if (written !== undefined) printFileConsequences(ctx, written);
  // The derivation above takes seconds: look at the root again just before writing. This narrows the window in which
  // another writer could have created a vault here; it cannot close it, because the write itself is not conditional.
  try {
    await assertRootIsEmpty(createRootInspector(ctx.client, mfsRoot));
  } catch (error) {
    if (error instanceof InitRefusedError) ctx.io.err("the MFS root changed while the key was derived; nothing was written to it. This device now holds a key-slot copy for the root, so use a new --mfs-root, or run `ipfs-sync abandon <vault>` for this root first.");
    throw error;
  }
  try {
    await writeKeySlotsFile({ client: ctx.client, mfsRoot, beforeWrite: () => lock.assertHeld() }, opened.keySlots);
  } catch (error) {
    ctx.io.err("the vault exists on this device, but its key slots did not reach the node; `ipfs-sync publish` writes them with the same passphrase");
    throw error;
  }
  ctx.io.out(`vault created    ${opened.vaultId}`);
  ctx.io.out(`key slots        ${mfsRoot}/keyslots.json`);
  ctx.io.out("next: run `ipfs-sync publish` with the passphrase from a prompt, or from IPFS_SYNC_PASSPHRASE_FILE");
}

/** Everything that can be refused without a request, in order: vault directory, marker, MFS root, source, file target, local copy. */
async function checkLocally(ctx: InitContext, vault: string): Promise<string> {
  await assertDirectory(vault);
  const host = createNodeHostBridge({ root: vault, env: ctx.env, now: () => ctx.now().getTime() });
  await assertPublishMarker(host.fs);
  const mfsRoot = assertMfsMutationPath(validateMfsRoot(ctx.config.mfsRoot));
  if (ctx.passphraseFile === undefined && ctx.terminal?.input.isTTY !== true) {
    throw new UsageError("init needs a terminal to show the generated passphrase, or --passphrase-file <path> to write it to a new file; nothing was sent");
  }
  if (ctx.passphraseFile !== undefined) await assertPassphraseFileCreatable(resolve(ctx.passphraseFile), ctx.file);
  if ((await host.fs.stat(await keySlotsCopyPath(mfsRoot))) !== undefined) {
    throw new InitRefusedError("this device already holds a key-slot copy for this MFS root, so a vault exists here; init creates a vault only once. Nothing was written.");
  }
  return mfsRoot;
}

/**
 * `ipfs-sync init <vault>`: the only way to create a vault. The passphrase is always generated here; a passphrase in the
 * environment is ignored. Interactive: shown once, entered again. With `--passphrase-file <path>`: written to a new
 * 0600 file and never printed. Every refusal that needs no request happens before the first one; the node is asked
 * only whether the root is empty, and written only after the vault exists on this device.
 */
export async function runInit(ctx: InitContext): Promise<number> {
  const vault = resolve(ctx.vaultPath);
  for (const name of [PASSPHRASE_ENV, PASSPHRASE_FILE_ENV]) {
    if (ctx.env[name] !== undefined) ctx.io.err(`note: ${name} is set and ignored; init generates the passphrase itself`);
  }
  try {
    const mfsRoot = await checkLocally(ctx, vault);
    ctx.io.out("ipfs-sync init");
    ctx.io.out(`  vault     ${vault}`);
    ctx.io.out(`  mfs root  ${mfsRoot}`);
    const lock = await acquirePublishLock(createNodeLockFile(vault), createNodeLockContext(() => ctx.now().getTime()));
    try {
      const generated = generatePassphrase();
      try {
        await createVault(ctx, lock, mfsRoot, generated);
      } finally {
        wipe(generated);
      }
      return EXIT_OK;
    } finally {
      await lock.release();
    }
  } catch (error) {
    if (REPORTED_FAILURES.some((failure) => error instanceof failure)) {
      ctx.io.err(`ipfs-sync: init failed: ${(error as Error).message}`);
      return EXIT_CHECK_FAILED;
    }
    throw error;
  }
}
