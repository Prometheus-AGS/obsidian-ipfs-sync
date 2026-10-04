import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitAll, createBuildFixture, head, tempDir, type CheckerModule, type Environment, type FileContent, type TreeResult } from "./guard-repo.ts";

/**
 * Fixtures for the review record (item A), the trust anchor and the enrolment (mvp-07b task 4.3c). Every repository is a
 * temporary one from guard-repo.ts; every per-user directory is a temporary HOME, so nothing here reads or writes the
 * real account.
 */
export type OkTree = Extract<TreeResult, { ok: true }>;
export type JsonRecord = Record<string, unknown>;

export const BUILD_SHA = "b".repeat(64);
export const FIXTURE_CHECKER = "tools/check-guard-preconditions.mjs";
export const FIXTURE_TEST = "tests/unit/sample.test.ts";
export const FIXTURE_TEST_TEXT = "export {};\n";
export const REVIEW_NAMESPACE = "ipfs-sync-review";

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** A build fixture that also holds a stand-in checker (the scope names it) and one named checklist test file. */
export function reviewFixture(extra: Readonly<Record<string, FileContent | null>> = {}): string {
  return createBuildFixture({ [FIXTURE_CHECKER]: "// stand-in checker\n", [FIXTURE_TEST]: FIXTURE_TEST_TEXT, ...extra });
}

export function okTree(checker: CheckerModule, root: string): OkTree {
  const tree = checker.computeTreeHash({ root });
  if (!tree.ok) throw new Error(`expected a tree hash, got ${JSON.stringify(tree.failures)}`);
  return tree;
}

/** A temporary HOME and an environment that sees only it (no XDG_STATE_HOME, no signer override). */
export function isolatedEnvironment(extra: Environment = {}): { home: string; env: Record<string, string | undefined> } {
  const home = tempDir("guard-home-");
  return { home, env: { HOME: home, PATH: process.env.PATH, ...extra } };
}

export const trustDirectoryOf = (checker: CheckerModule, env: Environment): string => join(checker.perUserStateDir(env), "trust");

/** The record a reviewer would write for `tree`: everything consistent, nothing open. `mutate` changes it for one case. */
export function baseRecord(tree: OkTree, reviewedCommit: string): JsonRecord {
  return {
    reviewer: "security-reviewer",
    verdict: "approved",
    reviewedCommit,
    treeSha256: tree.treeSha256,
    treeFileCount: tree.fileCount,
    buildSha256: BUILD_SHA,
    checkerSha256: tree.entries.find((entry) => entry.path === FIXTURE_CHECKER)?.sha256,
    checklistTests: { [FIXTURE_TEST]: sha256(FIXTURE_TEST_TEXT) },
    coverage: tree.entries
      .map((entry) => entry.path)
      .filter((path) => path.startsWith("src/") || path.startsWith("cli/") || path.startsWith("tools/"))
      .map((path) => ({ path, read: true })),
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    findings: [],
  };
}

export const recordText = (record: JsonRecord, note = "Disposition: none."): string =>
  `# Review of the final tree\n\nProse the checker ignores.\n\n<!-- guard-review:v1 -->\n${JSON.stringify(record, null, 2)}\n<!-- /guard-review -->\n\n${note}\n`;

export interface CommittedReview {
  readonly path: string;
  readonly text: string;
  readonly record: JsonRecord;
  readonly tree: OkTree;
  readonly reviewed: string;
  readonly commit: string;
}

export interface ReviewOptions {
  /** Changes the record (return a new object) before it is written. */
  readonly mutate?: (record: JsonRecord) => JsonRecord;
  /** The name's T8; defaults to the tree's own. */
  readonly nameT8?: string;
  readonly reviewedCommit?: string;
}

/**
 * Writes `review-final-<T8>.md` for the current tree and commits it. `reviewedCommit` is the commit before the record, as
 * a reviewer would name it. The record file is outside the tree-hash scope, so T does not change.
 */
export function commitReview(checker: CheckerModule, root: string, options: ReviewOptions = {}): CommittedReview {
  const tree = okTree(checker, root);
  const reviewed = options.reviewedCommit ?? head(root);
  const record = (options.mutate ?? ((value: JsonRecord) => value))(baseRecord(tree, reviewed));
  const path = `${checker.REVIEW_RECORD_DIR}/review-final-${options.nameT8 ?? tree.t8}.md`;
  const text = recordText(record);
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
  const commit = commitAll(root, "review record");
  // Recomputed after the commit: the checker reads the record from the commit T was computed for.
  return { path, text, record, tree: okTree(checker, root), reviewed, commit };
}

export const sshEnvironment = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" });

export interface SigningKey {
  readonly privatePath: string;
  readonly publicPath: string;
  readonly publicLine: string;
}

/** A throwaway ed25519 key without a passphrase, in its own temporary directory. */
export function makeSigningKey(name = "key"): SigningKey {
  const dir = tempDir("guard-key-");
  const privatePath = join(dir, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "throwaway", "-f", privatePath], { env: sshEnvironment() });
  const publicPath = `${privatePath}.pub`;
  return { privatePath, publicPath, publicLine: readFileSync(publicPath, "utf8").trim() };
}

/** `ssh-keygen -Y sign` over the file's bytes; returns the signature file's text. */
export function signWith(key: SigningKey, file: string, namespace: string = REVIEW_NAMESPACE): string {
  execFileSync("ssh-keygen", ["-Y", "sign", "-q", "-f", key.privatePath, "-n", namespace, file], { env: sshEnvironment() });
  return readFileSync(`${file}.sig`, "utf8");
}

/** The fingerprint `ssh-keygen -l` prints for a public key line. */
export function fingerprintByTool(key: SigningKey): string {
  const line = execFileSync("ssh-keygen", ["-l", "-f", key.publicPath], { env: sshEnvironment(), encoding: "utf8" });
  const found = /(SHA256:\S+)/.exec(line);
  if (!found) throw new Error(`no fingerprint in ${line}`);
  return found[1] as string;
}

export const allowedSignersLine = (key: SigningKey): string => {
  const [type, body] = key.publicLine.split(" ");
  return `operator namespaces="${REVIEW_NAMESPACE}" ${type} ${body}\n`;
};

/** Writes the trust directory the way a correct enrolment leaves it (0700 / 0600), without the terminal step. */
export function writeTrust(checker: CheckerModule, env: Environment, key: SigningKey, overrides: { fingerprint?: string; allowedSigners?: string } = {}): string {
  const dir = trustDirectoryOf(checker, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const files: [string, string][] = [
    ["allowed-signers", overrides.allowedSigners ?? allowedSignersLine(key)],
    ["review-signer.json", `${JSON.stringify({ schema: 1, fingerprint: overrides.fingerprint ?? fingerprintByTool(key) })}\n`],
  ];
  for (const [name, text] of files) {
    writeFileSync(join(dir, name), text, { mode: 0o600 });
    chmodSync(join(dir, name), 0o600);
  }
  return dir;
}

/** Commits `review-final-<T8>.md.sig` beside an already committed record, signed by `key` in `namespace`. */
export function commitSignature(root: string, review: CommittedReview, key: SigningKey, namespace: string = REVIEW_NAMESPACE): string {
  const sigText = signWith(key, join(root, review.path), namespace);
  commitAll(root, "review signature");
  return sigText;
}
