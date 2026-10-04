import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TreeFailure } from "./guard-repo.ts";
import { DAY_MS, FAKE_BUILD_FILES, NOW, loadOperatorChecker, type OperatorChecker } from "./guard-operator.ts";
import { isolatedEnvironment, sha256, type JsonRecord, type OkTree } from "./guard-review.ts";

/**
 * Fixtures for item C, the phone-timing record (mvp-07b task 4.4b). Every per-user directory is a temporary HOME. The
 * record is written the way the recorder (task 4.5) will write it: `<per-user dir>/feature-ops/phone-timing.json` (0600)
 * in a 0700 directory, beside the operator-run files.
 */
export interface PhoneResult {
  readonly ok: boolean;
  readonly form?: "measured" | "acceptance" | "signed";
  readonly failures: readonly TreeFailure[];
  readonly evidence: {
    readonly recordPath: string;
    readonly timingMeasured?: boolean;
    readonly device?: string;
    readonly os?: string;
    readonly seconds?: number;
    readonly longestGapMs?: number;
    readonly finishedAt?: string;
    readonly signerFingerprint?: string;
  };
}

export interface PhoneChecker extends OperatorChecker {
  readonly PHONE_TIMING_RECORD_FILE: string;
  readonly PHONE_TIMING_STATEMENT_FILE: string;
  readonly PHONE_TIMING_PARAMETERS: string;
  readonly PHONE_TIMING_MAX_SECONDS: number;
  readonly PHONE_TIMING_MAX_GAP_MS: number;
  readonly PHONE_ACCEPTANCE_PHRASE: string;
  readonly checkPhoneTiming: (options: {
    root: string;
    tree: OkTree;
    buildFiles: Readonly<Record<string, string>>;
    environment?: Readonly<Record<string, string | undefined>>;
    now?: number;
  }) => PhoneResult;
}

export async function loadPhoneChecker(): Promise<PhoneChecker> {
  return (await loadOperatorChecker()) as PhoneChecker;
}

export const MAIN_JS_PATH = "dist/plugin/main.js";
/** The first 16 hex characters of B's main.js hash: what the plugin command shows and the signed statement names. */
export const mainPrefix = (buildFiles: Readonly<Record<string, string>> = FAKE_BUILD_FILES): string => (buildFiles[MAIN_JS_PATH] as string).slice(0, 16);

/** A completed measurement bound to the build: the shape the recorder writes for `kind: "measured"`. */
export function measuredRecord(checker: PhoneChecker, buildFiles: Readonly<Record<string, string>> = FAKE_BUILD_FILES): JsonRecord {
  return {
    schema: 1,
    kind: "measured",
    completed: true,
    parameters: checker.PHONE_TIMING_PARAMETERS,
    seconds: 1.14,
    longestGapMs: 21,
    device: "iPhone",
    os: "iOS 26.0",
    nonceVerified: true,
    finishedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    pluginMainJsSha256: buildFiles[MAIN_JS_PATH],
  };
}

/** The operator's recorded acceptance of an unmeasured phone timing, bound to the tree and the build. */
export function acceptanceRecord(checker: PhoneChecker, tree: OkTree, buildFiles: Readonly<Record<string, string>> = FAKE_BUILD_FILES): JsonRecord {
  return {
    schema: 1,
    kind: "acceptance",
    nonceVerified: true,
    phrase: checker.PHONE_ACCEPTANCE_PHRASE,
    acceptedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    statement: "Phone timing accepted without a measurement for this tree and build.",
    treeSha256: tree.treeSha256,
    pluginMainJsSha256: buildFiles[MAIN_JS_PATH],
  };
}

export interface PhoneFixtureOptions {
  readonly kind?: "measured" | "acceptance";
  /** Changes the record (return a new object) before it is written. */
  readonly mutate?: (record: JsonRecord) => JsonRecord;
  /** False leaves the record file out (the folder is still created). */
  readonly writeRecord?: boolean;
  readonly buildFiles?: Readonly<Record<string, string>>;
  readonly env?: Record<string, string | undefined>;
}

export interface PhoneFixture {
  readonly env: Record<string, string | undefined>;
  readonly directory: string;
  readonly recordPath: string;
  readonly record: JsonRecord;
  readonly buildFiles: Readonly<Record<string, string>>;
  readonly check: (now?: number) => PhoneResult;
}

/** The feature-ops folder of an environment, created 0700. */
export function featureOpsDirectory(checker: PhoneChecker, env: Record<string, string | undefined>): string {
  const directory = join(checker.perUserStateDir(env), "feature-ops");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

export function writeOwnerFile(path: string, data: string | Uint8Array): void {
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** A temporary HOME holding a phone-timing record for `tree` (or, with `writeRecord: false`, an empty feature-ops folder). */
export function phoneFixture(checker: PhoneChecker, root: string, tree: OkTree, options: PhoneFixtureOptions = {}): PhoneFixture {
  const buildFiles = options.buildFiles ?? FAKE_BUILD_FILES;
  const env = options.env ?? isolatedEnvironment().env;
  const directory = featureOpsDirectory(checker, env);
  const base = options.kind === "acceptance" ? acceptanceRecord(checker, tree, buildFiles) : measuredRecord(checker, buildFiles);
  const record = (options.mutate ?? ((value: JsonRecord) => value))(base);
  const recordPath = join(directory, checker.PHONE_TIMING_RECORD_FILE);
  if (options.writeRecord !== false) writeOwnerFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return { env, directory, recordPath, record, buildFiles, check: (now = NOW) => checker.checkPhoneTiming({ root, tree, buildFiles, environment: env, now }) };
}

/** The text an operator signs: names T8 and the first 16 hex characters of the plugin build hash. */
export const statementText = (t8: string, prefix: string): string => `Phone timing for tree ${t8}, plugin build ${prefix}, accepted by the operator.\n`;

export { DAY_MS, NOW, sha256 };
