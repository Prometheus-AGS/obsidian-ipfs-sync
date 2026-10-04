import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FIXTURE_COMMIT, buildFixture } from "./release-fixture.ts";

/**
 * A synthetic project root for Release 2 (tools/release-mvp-07.mjs, mvp-07b task 4.8) and a stand-in for the guard
 * checker's `--json` result. Nothing here builds, runs git, runs pnpm or reads the real repository or the real per-user
 * directory: the checker is a function that returns a prepared document, and the per-user records live in a temporary
 * directory.
 */
export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export const TREE_SHA = sha256("release-2 fixture tree");
export const T8 = TREE_SHA.slice(0, 8);
export const BUILD_SHA = sha256("release-2 fixture build");
export const REVIEWED_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
export const SIGNER_FINGERPRINT = "SHA256:fixturesignerfingerprint";
export const REVIEW_DIR = "openspec/changes/mvp-07b-keys-history-guard-release-2";
export const TEST_ONLY_SENTINEL = "IPFS_SYNC_TEST_ONLY_SENTINEL_FIXTURE_ONE";

const MANIFEST_V3 = `{
  "id": "ipfs-sync",
  "name": "IPFS Sync",
  "version": "0.3.0",
  "minAppVersion": "1.12.3",
  "description": "fixture",
  "isDesktopOnly": false
}
`;
const PACKAGE_V3 = `{
  "name": "ipfs-sync",
  "version": "0.3.0",
  "license": "MIT",
  "scripts": {
    "build": "exit 9"
  }
}
`;

export interface Release2Options {
  readonly styles?: boolean;
  readonly form?: "git-history" | "signature";
  readonly timing?: "measured" | "acceptance" | "signed";
  readonly unread?: readonly string[];
}

export type Json = Record<string, any>;

export interface CheckerResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface Release2Fixture {
  readonly root: string;
  readonly perUser: string;
  readonly recordPath: string;
  readonly operatorPath: string;
  readonly transcriptPath: string;
  readonly timingPath: string;
  readonly options: Release2Options;
  /** The prepared checker result; tests change `result` (or call `setDoc`) before the run. */
  readonly checker: { result: CheckerResult; calls: number };
  readonly runChecker: (root: string, environment: Record<string, string | undefined>) => Promise<CheckerResult>;
  doc(): Json;
  setDoc(change: (doc: Json) => void): void;
}

const put = (root: string, rel: string, content: string | Uint8Array): void => {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

/** Hashes of the build files as they are on disk under `root`. */
export function builtFiles(root: string, styles: boolean): Record<string, string> {
  const paths = ["dist/plugin/main.js", "dist/plugin/manifest.json", ...(styles ? ["dist/plugin/styles.css"] : []), "dist/cli/ipfs-sync.mjs"];
  return Object.fromEntries(paths.map((path) => [path, sha256(readFileSync(join(root, path)))]));
}

/** Writes dist/.guard-build.json for the files now under `root` (what the checker's `--build` would have written). */
export function writeGuardState(root: string, styles: boolean, overrides: Json = {}): Json {
  const state = {
    schema: 1,
    commit: FIXTURE_COMMIT,
    treeSha256: TREE_SHA,
    t8: T8,
    buildSha256: BUILD_SHA,
    files: builtFiles(root, styles),
    node: "v24.16.0",
    pnpm: "12.8.1",
    ...overrides,
  };
  put(root, "dist/.guard-build.json", `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function timingItem(options: Release2Options, timingPath: string): Json {
  const kind = options.timing ?? "acceptance";
  const base = { status: "pass", failures: [] as unknown[] };
  if (kind === "measured") {
    return { ...base, form: "measured", evidence: { recordPath: timingPath, timingMeasured: true, device: "iPhone 15", os: "iOS 26.0", seconds: 1.14, longestGapMs: 21, finishedAt: "2026-10-03T12:00:00.000Z" } };
  }
  if (kind === "signed") return { ...base, form: "signed", evidence: { recordPath: timingPath, timingMeasured: false, signerFingerprint: SIGNER_FINGERPRINT } };
  return { ...base, form: "acceptance", evidence: { recordPath: timingPath, timingMeasured: false, finishedAt: "2026-10-03T12:00:00.000Z" } };
}

export function buildRelease2Fixture(options: Release2Options = {}): Release2Fixture {
  const root = mkdtempSync(join(tmpdir(), "rel2-root-"));
  const perUser = mkdtempSync(join(tmpdir(), "rel2-user-"));
  buildFixture(root, { styles: options.styles ?? false });
  put(root, "manifest.json", MANIFEST_V3);
  put(root, "package.json", PACKAGE_V3);
  put(root, "dist/plugin/manifest.json", MANIFEST_V3);
  put(root, "src/crypto/testing/hook.ts", `export const SENTINEL = "${TEST_ONLY_SENTINEL}";\n`);
  writeGuardState(root, options.styles ?? false);

  const recordRel = `${REVIEW_DIR}/review-final-${T8}.md`;
  put(root, recordRel, "# review record fixture\n");
  const operatorPath = join(perUser, "feature-ops", "feature-op-mvp-07.json");
  const transcriptPath = join(perUser, "feature-ops", "feature-op-mvp-07.transcript.log");
  const timingPath = join(perUser, "feature-ops", "phone-timing.json");
  put(perUser, "feature-ops/feature-op-mvp-07.json", `${JSON.stringify({ mode: "manual", passed: true })}\n`);
  put(perUser, "feature-ops/feature-op-mvp-07.transcript.log", "operator run transcript fixture\n");
  put(perUser, "feature-ops/phone-timing.json", `${JSON.stringify({ kind: options.timing ?? "acceptance" })}\n`);

  const form = options.form ?? "git-history";
  const unread = [...(options.unread ?? [])];
  const buildDoc = (): Json => ({
    schema: 1,
    pass: true,
    complete: true,
    tree: { sha256: TREE_SHA, t8: T8, fileCount: 212, commit: FIXTURE_COMMIT },
    build: { sha256: BUILD_SHA, commit: FIXTURE_COMMIT, files: builtFiles(root, options.styles ?? false), node: "v24.16.0", pnpm: "12.8.1", notices: [] },
    items: {
      A: {
        status: "pass",
        form,
        evidence: form === "git-history" ? { recordPath: recordRel, commit: REVIEWED_COMMIT, commitCount: 2 } : { recordPath: recordRel, signerFingerprint: SIGNER_FINGERPRINT },
        failures: [],
        accepted: [{ id: "A-01", severity: "low", status: "accepted", acceptedBecause: "fixture reason" }],
        unread,
      },
      B: { status: "pass", evidence: { recordPath: operatorPath, finishedAt: "2026-10-03T11:00:00.000Z", assertionCount: 18 }, failures: [] },
      C: timingItem(options, timingPath),
      D: { status: "pass", evidence: { bundlesChecked: ["dist/plugin/main.js", "dist/cli/ipfs-sync.mjs"], sentinelModules: 1, allowlist: ["tools/feature-op-*.mjs"] }, failures: [] },
      E: {
        status: "pass",
        evidence: { testsRun: true, tests: [{ path: "tests/unit/sample.test.ts", passed: 4, min: 3 }], documents: { "README.md": sha256("readme"), "DESIGN.md": sha256("design") }, advisories: 0 },
        failures: [],
      },
    },
  });

  let current = buildDoc();
  const checker = { result: { status: 0, stdout: `${JSON.stringify(current, null, 2)}\n`, stderr: "" } as CheckerResult, calls: 0 };
  const fixture: Release2Fixture = {
    root,
    perUser,
    recordPath: join(root, recordRel),
    operatorPath,
    transcriptPath,
    timingPath,
    options,
    checker,
    runChecker: async () => {
      checker.calls += 1;
      return checker.result;
    },
    doc: () => structuredClone(current),
    setDoc: (change) => {
      const next = structuredClone(current);
      change(next);
      current = next;
      checker.result = { status: next.pass === true ? 0 : 1, stdout: `${JSON.stringify(next, null, 2)}\n`, stderr: "" };
    },
  };
  return fixture;
}
