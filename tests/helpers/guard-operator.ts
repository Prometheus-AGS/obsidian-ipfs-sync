import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadChecker, type CheckerModule, type Environment, type TreeFailure } from "./guard-repo.ts";
import { isolatedEnvironment, okTree, reviewFixture, sha256, type JsonRecord, type OkTree } from "./guard-review.ts";

/**
 * Fixtures for item B, the operator-run record (mvp-07b task 4.4a). Every per-user directory is a temporary HOME, so
 * nothing here reads or writes the real account. The record is written the way the operator-run script (task 4.6) will
 * write it: `<per-user dir>/feature-ops/feature-op-mvp-07.json` (0600) beside its transcript, in a 0700 directory.
 */
export interface RequiredAssertion {
  readonly id: string;
  readonly kind: "machine" | "operator-observed";
}

export interface OperatorResult {
  readonly ok: boolean;
  readonly failures: readonly TreeFailure[];
  readonly evidence: { readonly recordPath: string; readonly finishedAt?: string; readonly assertionCount?: number };
}

export interface OperatorChecker extends Omit<CheckerModule, "runCli"> {
  /** `runCli` with the `now` the checker accepts for tests (freshness of the operator-run record). */
  readonly runCli: (argv: readonly string[], context: Parameters<CheckerModule["runCli"]>[1] & { now?: number }) => number;
  readonly REQUIRED_ASSERTIONS: readonly RequiredAssertion[];
  readonly OPERATOR_RECORD_FILE: string;
  readonly OPERATOR_TRANSCRIPT_FILE: string;
  readonly OPERATOR_RECORD_MAX_AGE_MS: number;
  readonly checkOperatorRecord: (options: {
    tree: OkTree;
    buildFiles: Readonly<Record<string, string>>;
    environment?: Environment;
    now?: number;
  }) => OperatorResult;
}

export async function loadOperatorChecker(): Promise<OperatorChecker> {
  return (await loadChecker()) as OperatorChecker;
}

export const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
export const DAY_MS = 24 * 60 * 60 * 1000;
export const TRANSCRIPT_TEXT = "step 1 ok\nstep 2 ok\n";

/** Stand-ins for the hashes of a build: what B would hold. */
export const FAKE_BUILD_FILES: Readonly<Record<string, string>> = Object.freeze({
  "dist/plugin/main.js": sha256("main.js bytes"),
  "dist/plugin/manifest.json": sha256("manifest.json bytes"),
  "dist/plugin/styles.css": sha256("styles.css bytes"),
  "dist/cli/ipfs-sync.mjs": sha256("cli bytes"),
});

const installedVault = (name: string, buildFiles: Readonly<Record<string, string>>): JsonRecord => ({
  name,
  files: Object.fromEntries(
    [
      ["main.js", "dist/plugin/main.js"],
      ["manifest.json", "dist/plugin/manifest.json"],
      ["styles.css", "dist/plugin/styles.css"],
    ]
      .filter(([, path]) => buildFiles[path as string] !== undefined)
      .map(([file, path]) => [file, buildFiles[path as string]]),
  ),
});

/** The record a correct manual run writes: everything bound to `tree` and `buildFiles`, every required assertion passed. */
export function baseOperatorRecord(checker: OperatorChecker, tree: OkTree, buildFiles: Readonly<Record<string, string>>, transcript: string = TRANSCRIPT_TEXT): JsonRecord {
  return {
    schema: 1,
    mode: "manual",
    passed: true,
    startedAt: new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
    finishedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    treeSha256: tree.treeSha256,
    installed: { vaults: [installedVault("v1", buildFiles), installedVault("v2", buildFiles)], cli: buildFiles["dist/cli/ipfs-sync.mjs"] },
    ownedKey: { before: "k51-before", after: "k51-after" },
    assertions: checker.REQUIRED_ASSERTIONS.map((required) => ({ id: required.id, kind: required.kind, passed: true, detail: "ok" })),
    evidencePaths: [],
    transcriptSha256: sha256(transcript),
  };
}

export interface OperatorFixture {
  readonly tree: OkTree;
  readonly buildFiles: Readonly<Record<string, string>>;
  readonly env: Record<string, string | undefined>;
  readonly directory: string;
  readonly recordPath: string;
  readonly transcriptPath: string;
  readonly record: JsonRecord;
  readonly check: (now?: number) => OperatorResult;
}

export interface OperatorFixtureOptions {
  /** Changes the record (return a new object) before it is written. */
  readonly mutate?: (record: JsonRecord) => JsonRecord;
  /** The transcript written beside the record; the record's hash is of `TRANSCRIPT_TEXT` unless `mutate` changes it. */
  readonly transcript?: string;
  /** False leaves the transcript file out. */
  readonly writeTranscript?: boolean;
  /** False leaves the record file out. */
  readonly writeRecord?: boolean;
  readonly buildFiles?: Readonly<Record<string, string>>;
  /** Reuse a repository and an environment (for a command-line test that needs the same T and HOME). */
  readonly tree?: OkTree;
  readonly env?: Record<string, string | undefined>;
}

let cachedTree: OkTree | undefined;

/**
 * One tree for every case that does not need its own repository: item B reads only `treeSha256`, so a repository per case
 * only made the file's cleanup slow under load. The repository is removed by `removeRepos` like any other.
 */
function sharedTree(checker: OperatorChecker): OkTree {
  cachedTree ??= okTree(checker, reviewFixture());
  return cachedTree;
}

/** A tree, a temporary HOME and the three files of a correct operator run in `<HOME>/.../feature-ops/` (0700 / 0600). */
export function operatorFixture(checker: OperatorChecker, options: OperatorFixtureOptions = {}): OperatorFixture {
  const tree = options.tree ?? sharedTree(checker);
  const buildFiles = options.buildFiles ?? FAKE_BUILD_FILES;
  const env = options.env ?? isolatedEnvironment().env;
  const directory = join(checker.perUserStateDir(env), "feature-ops");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const base = baseOperatorRecord(checker, tree, buildFiles, options.transcript ?? TRANSCRIPT_TEXT);
  const record = (options.mutate ?? ((value: JsonRecord) => value))(base);
  const recordPath = join(directory, checker.OPERATOR_RECORD_FILE);
  const transcriptPath = join(directory, checker.OPERATOR_TRANSCRIPT_FILE);
  if (options.writeRecord !== false) {
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    chmodSync(recordPath, 0o600);
  }
  if (options.writeTranscript !== false) {
    writeFileSync(transcriptPath, options.transcript ?? TRANSCRIPT_TEXT, { mode: 0o600 });
    chmodSync(transcriptPath, 0o600);
  }
  return {
    tree,
    buildFiles,
    env,
    directory,
    recordPath,
    transcriptPath,
    record,
    check: (now = NOW) => checker.checkOperatorRecord({ tree, buildFiles, environment: env, now }),
  };
}
