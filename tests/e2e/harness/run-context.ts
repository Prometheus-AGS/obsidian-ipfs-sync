// Run identity, the run root, the per-run temp directory with the passphrase file, and the per-machine lock (task 1.2,
// design decisions 2 and 4). Run generation delegates to the 07a key-agnostic helpers through ./tools-07a.ts.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools07a } from "./tools-07a";

/** The one key the suite owns on the shared node. It persists across runs and is never removed (key/rm is forbidden). */
export const SUITE_KEY = "obsidian-vault-e2e";
/** Every run roots at /obsidian-vault-sync/e2e-<runId>, directly under the base (phase plan; design decision 2). */
export const BASE_PATH = "/obsidian-vault-sync";
/**
 * Pinned to RUN_ID_PATTERN of tools/feature-op-mvp-07a/constants.mjs (the same rule). The unit tests compare the two
 * sources so a drift in either fails the default gate.
 */
export const RUN_ID_PATTERN = /^[a-z0-9-]{8,}$/;

/** A refusal fails the suite with a named reason; it is never a skip (design decision 5). */
export class SuiteRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuiteRefusal";
  }
}

export const isValidRunId = (id: unknown): id is string => typeof id === "string" && RUN_ID_PATTERN.test(id);

export function runRootFor(runId: string): string {
  if (!isValidRunId(runId)) throw new SuiteRefusal(`run identifier "${String(runId).slice(0, 40)}" does not match ${RUN_ID_PATTERN}`);
  return `${BASE_PATH}/e2e-${runId}`;
}

export interface RunContext {
  readonly runId: string;
  /** The MFS root of this run: /obsidian-vault-sync/e2e-<runId>. */
  readonly runRoot: string;
  /** Per-run temp directory in the OS tmpdir, outside the repository. Holds the passphrase file. */
  readonly tempDir: string;
  /** 0700 subdirectory of tempDir. */
  readonly secretsDir: string;
  /** Written 0600 by writePassphraseFile (or by `init --passphrase-file`); scrubbed from all output in both spellings. */
  readonly passphraseFile: string;
  /** The per-machine owned-keys config (shared with the feature operations). */
  readonly ownedKeysConfigFile: string;
  /** The per-machine lock file in tmpdir. */
  readonly lockFile: string;
}

export async function createRunContext(options: { runId?: string } = {}): Promise<RunContext> {
  const tools = await loadTools07a();
  const runId = options.runId ?? tools.newRunId();
  const runRoot = runRootFor(runId);
  const tempDir = await mkdtemp(join(tmpdir(), "ipfs-sync-e2e-"));
  const secretsDir = join(tempDir, "secrets");
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  return {
    runId,
    runRoot,
    tempDir,
    secretsDir,
    passphraseFile: join(secretsDir, "passphrase.txt"),
    ownedKeysConfigFile: tools.ownedKeysConfigFile,
    lockFile: tools.lockFile,
  };
}

/** Writes the run's passphrase 0600 into the 0700 secrets directory; refuses a path inside the repository. */
export async function writePassphraseFile(context: RunContext, text: string): Promise<void> {
  const tools = await loadTools07a();
  if (!tools.isOutsideRepo(context.passphraseFile)) throw new SuiteRefusal(`passphrase file ${context.passphraseFile} is inside the repository`);
  await writeFile(context.passphraseFile, text.endsWith("\n") ? text : `${text}\n`);
  await chmod(context.passphraseFile, 0o600);
}

/**
 * One suite run per machine at a time: delegates to the 07a acquireLock, so the suite also excludes a concurrently
 * running feature operation (both mutate the shared node). A stale lock of a dead process is replaced by 07a.
 */
export async function acquireRunLock(): Promise<void> {
  const tools = await loadTools07a();
  try {
    await tools.acquireLock();
  } catch (error) {
    throw new SuiteRefusal(`e2e suite lock refused: ${tools.firstLine(error instanceof Error ? error.message : String(error))}`);
  }
}

/** Removes the per-run temp directory (it holds the passphrase file). Idempotent. */
export async function removeRunDir(context: RunContext): Promise<void> {
  await rm(context.tempDir, { recursive: true, force: true });
}
