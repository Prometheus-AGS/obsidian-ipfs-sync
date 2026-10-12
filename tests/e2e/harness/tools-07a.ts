// Typed loader for the key-agnostic helpers of tools/feature-op-mvp-07a/ (design decision 3). The 07a modules are .mjs and
// outside the typecheck program, so they are imported dynamically by file URL and cast to these interfaces — the same pattern
// as tests/unit/feature-op-mvp-07a-helpers.test.ts. Nothing here talks to a node; workspace.mjs/policy.mjs/constants.mjs only
// touch the filesystem and node: builtins.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface ConstantsModule {
  readonly REPO: string;
  readonly CONFIG_FILE: string;
  readonly LOCK_FILE: string;
  readonly RUN_ID_PATTERN: RegExp;
}

/** One plaintext needle: the bytes scanned for, under a human label. */
export interface Needle {
  readonly label: string;
  readonly bytes: Uint8Array;
}

/** 07a's vetRequestUrl result: on refusal the url/forwardPath fields are undefined. */
export interface VettedUrl {
  readonly ok: boolean;
  readonly reason: string;
  readonly url?: URL;
  readonly forwardPath?: string;
}

/** One file of a vault walk (07a workspace.mjs walkFiles): vault-relative path, size, sha256, and the text of .md files. */
export interface WalkedFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly text?: string;
}

/** 07a parsePublishOutput: the counts, sequence and root CID lines of a completed publish. */
export interface PublishSummary {
  readonly written?: number;
  readonly removed?: number;
  readonly sequence?: number;
  readonly rootCid?: string;
}

/** 07a parsePullOutput: the eight-count summary line, sequence, root CID and conflict pairs of a completed pull. */
export interface PullSummary {
  readonly fetched?: number;
  readonly unchanged?: number;
  readonly conflicts?: number;
  readonly integrityFailed?: number;
  readonly unfetched?: number;
  readonly skipped?: number;
  readonly remoteDeleted?: number;
  readonly locallyModified?: number;
  readonly sequence?: number;
  readonly rootCid?: string;
  readonly conflictPairs: readonly { readonly path: string; readonly copy: string }[];
}

/** 07a parseInitOutput: the vault id line of a completed init. */
export interface InitSummary {
  readonly vaultId?: string;
}

/** The fields of a proxy log entry the 07a pull-read audit reads (the suite's ProxyEntry is a superset). */
export interface PullTraceEntry {
  readonly command: string;
  readonly arg?: string;
  readonly mutating: boolean;
  readonly allowed: boolean;
}

/** 07a bestEffortPostRun result: never rejects. */
export interface BestEffortResult {
  readonly ok: boolean;
  readonly reason?: string;
}

interface PolicyModule {
  isValidRunId(id: unknown): boolean;
  newRunId(): string;
  isOutsideRepo(path: string): boolean;
  firstLine(text: unknown): string;
  isWithin(path: unknown, root: unknown, options?: { allowEqual?: boolean }): boolean;
  normalizeMfsPath(path: unknown): string | undefined;
  childEnv(base: Record<string, string | undefined>, extra: Record<string, string>, options?: { localStub?: boolean }): Record<string, string>;
  redact(text: string, secrets: readonly string[]): string;
  scrubbedDetail(result: { stdout?: string; stderr?: string }, secrets: readonly string[]): string;
  stripControl(text: unknown): string;
  decodeSafe(text: string): string;
  vetRequestUrl(rawUrl: unknown): VettedUrl;
  findNeedle(haystack: Uint8Array, needles: readonly Needle[]): string | undefined;
  createNeedleScanner(needles: readonly Needle[]): { push(chunk: Buffer): string | undefined };
  parsePublishOutput(text: string): PublishSummary;
  parsePullOutput(text: string): PullSummary;
  parseInitOutput(text: string): InitSummary;
  plaintextNeedles(files: readonly { path: string; text?: string }[]): Needle[];
  pullTraceProblems(trace: readonly PullTraceEntry[]): string[];
  withPassphraseSpellings(known: readonly string[], fileText: string): string[];
  sha256(data: Uint8Array | string): string;
  bestEffortPostRun(record: () => Promise<unknown>, options: { timeoutMs: number }): Promise<BestEffortResult>;
}

interface WorkspaceModule {
  acquireLock(): Promise<void>;
  readOwnedKeys(configFile: string): Promise<string[]>;
  ensureConfig(configFile: string): Promise<void>;
  generateVault(dir: string): Promise<{ code: number | null; text: string }>;
  walkFiles(root: string): Promise<WalkedFile[]>;
}

export interface Tools07a {
  /** The repository root as 07a resolves it. */
  readonly repoRoot: string;
  /** 07a's RUN_ID_PATTERN; run-context pins its own copy against this in the unit tests. */
  readonly runIdPattern: RegExp;
  /** The per-machine owned-keys config shared with the feature operations (tmpdir, not the repository). */
  readonly ownedKeysConfigFile: string;
  /** The per-machine lock file in tmpdir (07a acquireLock). */
  readonly lockFile: string;
  isValidRunId(id: unknown): boolean;
  newRunId(): string;
  isOutsideRepo(path: string): boolean;
  firstLine(text: unknown): string;
  /** MFS path containment, key-agnostic (normalizes and refuses . / .. / control segments). */
  isWithin(path: unknown, root: unknown, options?: { allowEqual?: boolean }): boolean;
  normalizeMfsPath(path: unknown): string | undefined;
  /** The child environment allowlist (PATH, HOME, TMPDIR, LANG, LC_ALL plus IPFS_SYNC_* auth on the shared-node path). */
  childEnv(base: Record<string, string | undefined>, extra: Record<string, string>, options?: { localStub?: boolean }): Record<string, string>;
  redact(text: string, secrets: readonly string[]): string;
  /** First line of a child's output with every known secret redacted (re-scrub at print time). */
  scrubbedDetail(result: { stdout?: string; stderr?: string }, secrets: readonly string[]): string;
  stripControl(text: unknown): string;
  decodeSafe(text: string): string;
  /** Raw request-target vetting before the policy decides; refuses '//' and backslash tricks. */
  vetRequestUrl(rawUrl: unknown): VettedUrl;
  findNeedle(haystack: Uint8Array, needles: readonly Needle[]): string | undefined;
  /** Streaming needle scanner: chunk boundaries cannot hide a needle. */
  createNeedleScanner(needles: readonly Needle[]): { push(chunk: Buffer): string | undefined };
  /** The summary parsers of the CLI's own output lines (07a policy.mjs). */
  parsePublishOutput(text: string): PublishSummary;
  parsePullOutput(text: string): PullSummary;
  parseInitOutput(text: string): InitSummary;
  /** Plaintext needles for "nothing readable on the wire": paths, segments, stems, titles and the body words. */
  plaintextNeedles(files: readonly { path: string; text?: string }[]): Needle[];
  /** The pull read audit: one line per mutating, refused or out-of-read-set entry; empty means the pull was read-only. */
  pullTraceProblems(trace: readonly PullTraceEntry[]): string[];
  /** The known secrets plus both spellings of a passphrase file's text, once each. */
  withPassphraseSpellings(known: readonly string[], fileText: string): string[];
  sha256(data: Uint8Array | string): string;
  /** Runs a post-run record for at most timeoutMs; never rejects (07a signal-handler pattern). */
  bestEffortPostRun(record: () => Promise<unknown>, options: { timeoutMs: number }): Promise<BestEffortResult>;
  acquireLock(): Promise<void>;
  readOwnedKeys(configFile: string): Promise<string[]>;
  ensureConfig(configFile: string): Promise<void>;
  /** Spawns the fixture vault generator (fixtures/generate-fixture-vault.ts) as a plain node child. */
  generateVault(dir: string): Promise<{ code: number | null; text: string }>;
  /** Every file of a vault directory except the .ipfs-sync state folder, sorted by path. */
  walkFiles(root: string): Promise<WalkedFile[]>;
}

const toolsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tools", "feature-op-mvp-07a");

let cached: Promise<Tools07a> | undefined;

export function loadTools07a(): Promise<Tools07a> {
  cached ??= (async (): Promise<Tools07a> => {
    const at = (name: string): string => pathToFileURL(join(toolsDir, name)).href;
    const constants = (await import(/* @vite-ignore */ at("constants.mjs"))) as ConstantsModule;
    const policy = (await import(/* @vite-ignore */ at("policy.mjs"))) as PolicyModule;
    const workspace = (await import(/* @vite-ignore */ at("workspace.mjs"))) as WorkspaceModule;
    return {
      repoRoot: constants.REPO,
      runIdPattern: constants.RUN_ID_PATTERN,
      ownedKeysConfigFile: constants.CONFIG_FILE,
      lockFile: constants.LOCK_FILE,
      isValidRunId: (id) => policy.isValidRunId(id),
      newRunId: () => policy.newRunId(),
      isOutsideRepo: (path) => policy.isOutsideRepo(path),
      firstLine: (text) => policy.firstLine(text),
      isWithin: (path, root, options) => policy.isWithin(path, root, options),
      normalizeMfsPath: (path) => policy.normalizeMfsPath(path),
      childEnv: (base, extra, options) => policy.childEnv(base, extra, options),
      redact: (text, secrets) => policy.redact(text, secrets),
      scrubbedDetail: (result, secrets) => policy.scrubbedDetail(result, secrets),
      stripControl: (text) => policy.stripControl(text),
      decodeSafe: (text) => policy.decodeSafe(text),
      vetRequestUrl: (rawUrl) => policy.vetRequestUrl(rawUrl),
      findNeedle: (haystack, needles) => policy.findNeedle(haystack, needles),
      createNeedleScanner: (needles) => policy.createNeedleScanner(needles),
      acquireLock: () => workspace.acquireLock(),
      readOwnedKeys: (configFile) => workspace.readOwnedKeys(configFile),
      ensureConfig: (configFile) => workspace.ensureConfig(configFile),
      parsePublishOutput: (text) => policy.parsePublishOutput(text),
      parsePullOutput: (text) => policy.parsePullOutput(text),
      parseInitOutput: (text) => policy.parseInitOutput(text),
      plaintextNeedles: (files) => policy.plaintextNeedles(files),
      pullTraceProblems: (trace) => policy.pullTraceProblems(trace),
      withPassphraseSpellings: (known, fileText) => policy.withPassphraseSpellings(known, fileText),
      sha256: (data) => policy.sha256(data),
      bestEffortPostRun: (record, options) => policy.bestEffortPostRun(record, options),
      generateVault: (dir) => workspace.generateVault(dir),
      walkFiles: (root) => workspace.walkFiles(root),
    };
  })();
  return cached;
}
