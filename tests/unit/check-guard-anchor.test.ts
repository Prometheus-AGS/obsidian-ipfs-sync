import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceStoreDirectory } from "../../cli/device-store-node";
import { enrolUnderPty, hasExpect } from "../helpers/expect-smoke.ts";
import { createFakeTerminal } from "../helpers/fake-terminal.ts";
import { CHECKER_PATH, captureIo, commitAll, loadChecker, removeRepos, tempDir, writeRepoFile, type CheckerModule, type ReviewCheckResult } from "../helpers/guard-repo.ts";
import {
  BUILD_SHA,
  allowedSignersLine,
  commitReview,
  commitSignature,
  fingerprintByTool,
  isolatedEnvironment,
  makeSigningKey,
  okTree,
  reviewFixture,
  trustDirectoryOf,
  writeTrust,
  type SigningKey,
} from "../helpers/guard-review.ts";

// mvp-07b task 4.3c: the signature form of item A, the operator-owned trust anchor and the enrolment step (design 9
// "Review record (b)", spec guard-evidence "The trust anchor for the signature form is operator-owned"). Keys are
// throwaway ed25519 keys made in temporary directories; every per-user directory is a temporary HOME. The terminal-only
// logic runs over injected streams; one test drives the real tool under a pty with expect(1), one with piped stdio.

let checker: CheckerModule;
beforeAll(async () => {
  checker = await loadChecker();
});
afterAll(removeRepos);

const NONCE = "0123456789ab";
const codes = (result: ReviewCheckResult): string[] => result.failures.map((failure) => failure.code);
const modeOf = (path: string): number => statSync(path).mode & 0o777;

interface Signed {
  readonly root: string;
  readonly key: SigningKey;
  readonly env: Record<string, string | undefined>;
  readonly check: () => ReviewCheckResult;
}

/** A repository with a committed record and a committed signature, and an environment whose trust directory holds the key. */
function signed(options: { namespace?: string; trust?: boolean; signKey?: SigningKey; trustKey?: SigningKey } = {}): Signed {
  const root = reviewFixture();
  const review = commitReview(checker, root);
  const key = options.trustKey ?? makeSigningKey();
  const { env } = isolatedEnvironment();
  if (options.trust !== false) writeTrust(checker, env, key);
  commitSignature(root, review, options.signKey ?? key, options.namespace);
  return { root, key, env, check: () => checker.checkReviewRecord({ root, tree: okTree(checker, root), buildSha256: BUILD_SHA, environment: env }) };
}

describe("per-user state directory", () => {
  const fixtures: [string, Record<string, string>, NodeJS.Platform][] = [
    ["macOS", { HOME: "/Users/a" }, "darwin"],
    ["macOS with XDG_STATE_HOME", { HOME: "/Users/a", XDG_STATE_HOME: "/Users/a/state" }, "darwin"],
    ["Linux", { HOME: "/home/a" }, "linux"],
    ["Linux with XDG_STATE_HOME", { HOME: "/home/a", XDG_STATE_HOME: "/var/state" }, "linux"],
    ["Windows with LOCALAPPDATA", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32"],
    ["Windows without LOCALAPPDATA", {}, "win32"],
  ];
  it.each(fixtures)("equals the device store directory of the CLI: %s", (_name, env, platform) => {
    let expected: string | Error;
    try {
      expected = deviceStoreDirectory(env, platform);
    } catch (error) {
      expected = error as Error;
    }
    if (expected instanceof Error) expect(() => checker.perUserStateDir(env, platform)).toThrow();
    else expect(checker.perUserStateDir(env, platform)).toBe(expected);
  });
});

describe("SSH key fingerprints", () => {
  it("equals what ssh-keygen prints for the same public key", () => {
    const key = makeSigningKey();
    expect(checker.sshKeyFingerprint(key.publicLine)).toBe(fingerprintByTool(key));
  });

  it.each([
    ["a private key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["no body", "ssh-ed25519"],
    ["options in front", 'command="rm -rf /" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ["a body that is not base64", "ssh-ed25519 !!!!"],
    ["a body whose inner type differs", "ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQABAAABAQ=="],
  ])("refuses %s", (_name, line) => {
    expect(() => checker.sshKeyFingerprint(line)).toThrow();
  });
});

describe("item A by signature", () => {
  it("passes with a signature by the enrolled key, prints the form and the signer fingerprint", () => {
    const run = signed();
    const result = run.check();
    expect(result.failures).toEqual([]);
    expect(result.form).toBe("signature");
    expect(result.evidence.signerFingerprint).toBe(fingerprintByTool(run.key));
  });

  it("fails for a signature made in another namespace", () => {
    expect(codes(signed({ namespace: "other-namespace" }).check())).toEqual(["review-signature-invalid"]);
  });

  it("fails for a signature by a key that is not the enrolled one", () => {
    expect(codes(signed({ signKey: makeSigningKey("other") }).check())).toEqual(["review-signature-invalid"]);
  });

  it("does not fall back to the git-history form when a signature is present but invalid", () => {
    const result = signed({ signKey: makeSigningKey("other") }).check();
    expect(result.ok).toBe(false);
    expect(result.form).toBeUndefined();
  });

  it("fails when the record was edited after it was signed", () => {
    const run = signed();
    const tree = okTree(checker, run.root);
    const path = `${checker.REVIEW_RECORD_DIR}/review-final-${tree.t8}.md`;
    writeFileSync(join(run.root, path), `${readFileSync(join(run.root, path), "utf8")}One more line.\n`);
    commitAll(run.root, "edit after signing");
    expect(codes(run.check())).toEqual(["review-signature-invalid"]);
  });

  it("fails when no trust directory was enrolled", () => {
    expect(codes(signed({ trust: false }).check())).toEqual(["trust-missing"]);
  });

  it("fails when the enrolled fingerprint is not the allowed-signers key's fingerprint", () => {
    const root = reviewFixture();
    const review = commitReview(checker, root);
    const key = makeSigningKey();
    const { env } = isolatedEnvironment();
    writeTrust(checker, env, key, { fingerprint: fingerprintByTool(makeSigningKey("elsewhere")) });
    commitSignature(root, review, key);
    const result = checker.checkReviewRecord({ root, tree: okTree(checker, root), buildSha256: BUILD_SHA, environment: env });
    expect(codes(result)).toEqual(["trust-fingerprint-mismatch"]);
  });

  it("fails when the trust directory is group-writable, and when a trust file is readable by others", () => {
    const loose = signed();
    chmodSync(trustDirectoryOf(checker, loose.env), 0o770);
    expect(codes(loose.check())).toEqual(["trust-mode"]);
    const open = signed();
    chmodSync(join(trustDirectoryOf(checker, open.env), "allowed-signers"), 0o644);
    expect(codes(open.check())).toEqual(["trust-mode"]);
  });

  it("fails when the trust directory is a symbolic link", () => {
    const run = signed();
    const dir = trustDirectoryOf(checker, run.env);
    const moved = join(tempDir("guard-moved-"), "trust");
    renameSync(dir, moved);
    symlinkSync(moved, dir);
    expect(codes(run.check())).toEqual(["trust-symlink"]);
  });

  it("refuses a trust directory inside the repository (an agent-made key and allowed-signers file)", () => {
    const root = reviewFixture();
    const review = commitReview(checker, root);
    const key = makeSigningKey();
    const env = { HOME: join(root, "home"), PATH: process.env.PATH };
    mkdirSync(env.HOME, { recursive: true });
    writeTrust(checker, env, key);
    commitSignature(root, review, key);
    const result = checker.checkReviewRecord({ root, tree: okTree(checker, root), buildSha256: BUILD_SHA, environment: env });
    expect(codes(result)).toEqual(["trust-inside-repository"]);
  });

  it.each([
    ["another namespace", (key: SigningKey) => allowedSignersLine(key).replace("ipfs-sync-review", "somewhere-else")],
    ["a second entry", (key: SigningKey) => `${allowedSignersLine(key)}${allowedSignersLine(makeSigningKey("second"))}`],
    ["an option in front of the key", (key: SigningKey) => allowedSignersLine(key).replace(" ssh-ed25519", " cert-authority ssh-ed25519")],
    ["another principal", (key: SigningKey) => allowedSignersLine(key).replace("operator", "someone")],
  ])("fails when allowed-signers holds %s", (_name, text) => {
    const root = reviewFixture();
    const review = commitReview(checker, root);
    const key = makeSigningKey();
    const { env } = isolatedEnvironment();
    writeTrust(checker, env, key, { allowedSigners: text(key) });
    commitSignature(root, review, key);
    const result = checker.checkReviewRecord({ root, tree: okTree(checker, root), buildSha256: BUILD_SHA, environment: env });
    expect(codes(result)).toEqual(["trust-allowed-signers"]);
  });

  it("throws when IPFS_SYNC_ALLOWED_SIGNERS is set (no environment variable selects another allowed-signers file)", () => {
    const run = signed();
    expect(() =>
      checker.checkReviewRecord({ root: run.root, tree: okTree(checker, run.root), buildSha256: BUILD_SHA, environment: { ...run.env, IPFS_SYNC_ALLOWED_SIGNERS: "/x" } }),
    ).toThrow(/IPFS_SYNC_ALLOWED_SIGNERS/);
  });
});

describe("enrolment with injected terminal streams", () => {
  interface Session {
    readonly root: string;
    readonly key: SigningKey;
    readonly home: string;
    readonly env: Record<string, string | undefined>;
  }
  const session = (extraEnv: Record<string, string> = {}): Session => {
    const { home, env } = isolatedEnvironment(extraEnv);
    return { root: reviewFixture(), key: makeSigningKey(), home, env };
  };

  async function enrol(s: Session, answers: readonly string[], options: { inputIsTty?: boolean; outputIsTty?: boolean; keyFile?: string } = {}) {
    const terminal = createFakeTerminal({ answers, ...(options.inputIsTty === undefined ? {} : { inputIsTty: options.inputIsTty }), ...(options.outputIsTty === undefined ? {} : { outputIsTty: options.outputIsTty }) });
    const io = captureIo();
    const code = await checker.enrolSigner({ keyFile: options.keyFile ?? s.key.publicPath, root: s.root, environment: s.env, terminal, nonce: () => NONCE, ...io.io });
    return { code, terminal, io };
  }

  const fingerprintLine = (s: Session): string => `${fingerprintByTool(s.key)}\n`;
  const noTrustWritten = (s: Session): boolean => !existsSync(trustDirectoryOf(checker, s.env));

  it("writes both files, 0700 and 0600, only after the fingerprint and the nonce are retyped", async () => {
    const s = session();
    const { code, terminal, io } = await enrol(s, [fingerprintLine(s), `${NONCE}\n`]);
    expect(code, io.err()).toBe(0);
    const dir = trustDirectoryOf(checker, s.env);
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(join(dir, "allowed-signers"))).toBe(0o600);
    expect(modeOf(join(dir, "review-signer.json"))).toBe(0o600);
    expect(readFileSync(join(dir, "allowed-signers"), "utf8")).toBe(allowedSignersLine(s.key));
    expect(JSON.parse(readFileSync(join(dir, "review-signer.json"), "utf8"))).toEqual({ schema: 1, fingerprint: fingerprintByTool(s.key) });
    const shown = terminal.written.join("");
    expect(shown).toContain(`fingerprint: ${fingerprintByTool(s.key)}`);
    expect(shown).toContain(`nonce: ${NONCE}`);
    expect(shown).not.toContain("throwaway");
    expect(terminal.listeners()).toBe(0);
    expect(terminal.flowing()).toBe(false);
  });

  it("what enrolment writes is accepted by the checker for a record signed with that key", async () => {
    const s = session();
    expect((await enrol(s, [fingerprintLine(s), `${NONCE}\n`])).code).toBe(0);
    const review = commitReview(checker, s.root);
    commitSignature(s.root, review, s.key);
    const result = checker.checkReviewRecord({ root: s.root, tree: okTree(checker, s.root), buildSha256: BUILD_SHA, environment: s.env });
    expect(result.failures).toEqual([]);
    expect(result.form).toBe("signature");
  });

  it("writes nothing when the fingerprint is retyped wrongly", async () => {
    const s = session();
    const { code, io } = await enrol(s, ["SHA256:wrong\n", `${NONCE}\n`]);
    expect(code).toBe(1);
    expect(io.err()).toContain("fingerprint");
    expect(noTrustWritten(s)).toBe(true);
  });

  it("writes nothing when the nonce is retyped wrongly", async () => {
    const s = session();
    const { code, io } = await enrol(s, [fingerprintLine(s), "not-the-nonce\n"]);
    expect(code).toBe(1);
    expect(io.err()).toContain("nonce");
    expect(noTrustWritten(s)).toBe(true);
  });

  it("writes nothing when the terminal closes before the answers", async () => {
    const s = session();
    const terminal = createFakeTerminal({ answers: [] });
    const io = captureIo();
    const pending = checker.enrolSigner({ keyFile: s.key.publicPath, root: s.root, environment: s.env, terminal, nonce: () => NONCE, ...io.io });
    await new Promise((resolve) => setTimeout(resolve, 0));
    terminal.close();
    expect(await pending).toBe(1);
    expect(noTrustWritten(s)).toBe(true);
    expect(terminal.listeners()).toBe(0);
  });

  it("exits 2 and writes nothing when standard input or standard output is not a terminal", async () => {
    for (const options of [{ inputIsTty: false }, { outputIsTty: false }]) {
      const s = session();
      const { code, io, terminal } = await enrol(s, [fingerprintLine(s), `${NONCE}\n`], options);
      expect(code, JSON.stringify(options)).toBe(2);
      expect(io.err()).toContain("terminal");
      expect(noTrustWritten(s)).toBe(true);
      expect(terminal.remaining()).toBe(2);
    }
  });

  it("exits 2 when IPFS_SYNC_ALLOWED_SIGNERS is set", async () => {
    const s = session({ IPFS_SYNC_ALLOWED_SIGNERS: "/anything" });
    const { code, io } = await enrol(s, [fingerprintLine(s), `${NONCE}\n`]);
    expect(code).toBe(2);
    expect(io.err()).toContain("IPFS_SYNC_ALLOWED_SIGNERS");
    expect(noTrustWritten(s)).toBe(true);
  });

  it("refuses a key file inside the repository", async () => {
    const s = session();
    writeRepoFile(s.root, "planted.pub", `${s.key.publicLine}\n`);
    const { code, io } = await enrol(s, [fingerprintLine(s), `${NONCE}\n`], { keyFile: join(s.root, "planted.pub") });
    expect(code).toBe(2);
    expect(io.err()).toContain("repository");
    expect(noTrustWritten(s)).toBe(true);
  });

  it("refuses a trust directory inside the repository", async () => {
    const root = reviewFixture();
    const key = makeSigningKey();
    const env = { HOME: join(root, "home"), PATH: process.env.PATH };
    mkdirSync(env.HOME, { recursive: true });
    const s: Session = { root, key, home: env.HOME, env };
    const { code, io } = await enrol(s, [fingerprintLine(s), `${NONCE}\n`]);
    expect(code).toBe(2);
    expect(io.err()).toContain("repository");
    expect(noTrustWritten(s)).toBe(true);
  });

  it.each([
    ["a private key", (key: SigningKey) => readFileSync(key.privatePath, "utf8")],
    ["two lines", (key: SigningKey) => `${key.publicLine}\n${key.publicLine}\n`],
    ["an option in front of the key", (key: SigningKey) => `command="x" ${key.publicLine}\n`],
    ["an empty file", () => ""],
  ])("refuses a key file that holds %s", async (_name, content) => {
    const s = session();
    const file = join(tempDir("guard-keyfile-"), "bad.pub");
    writeFileSync(file, content(s.key));
    const { code } = await enrol(s, [fingerprintLine(s), `${NONCE}\n`], { keyFile: file });
    expect(code).toBe(2);
    expect(noTrustWritten(s)).toBe(true);
  });

  it("refuses an existing trust directory that is group-writable", async () => {
    const s = session();
    writeTrust(checker, s.env, s.key);
    chmodSync(trustDirectoryOf(checker, s.env), 0o770);
    const { code } = await enrol(s, [fingerprintLine(s), `${NONCE}\n`]);
    expect(code).toBe(2);
  });

  it("replaces an enrolled key after the same retyping and says which fingerprint it replaced", async () => {
    const s = session();
    expect((await enrol(s, [fingerprintLine(s), `${NONCE}\n`])).code).toBe(0);
    const second: Session = { ...s, key: makeSigningKey("second") };
    const { code, terminal } = await enrol(second, [fingerprintLine(second), `${NONCE}\n`]);
    expect(code).toBe(0);
    expect(terminal.written.join("")).toContain(`replaces ${fingerprintByTool(s.key)}`);
    const dir = trustDirectoryOf(checker, s.env);
    expect(JSON.parse(readFileSync(join(dir, "review-signer.json"), "utf8")).fingerprint).toBe(fingerprintByTool(second.key));
  });
});

describe("the real tool", () => {
  it("with piped stdio exits 2 and writes nothing (no pty test)", () => {
    const key = makeSigningKey();
    const { home } = isolatedEnvironment();
    const run = spawnSync(process.execPath, [CHECKER_PATH, "--enrol-signer", key.publicPath], {
      env: { PATH: process.env.PATH ?? "", HOME: home },
      input: `${fingerprintByTool(key)}\n${NONCE}\n`,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("terminal");
    expect(existsSync(join(home, "Library"))).toBe(false);
    expect(existsSync(join(home, ".local"))).toBe(false);
  });

  it("rejects --enrol-signer without exactly one key file argument", () => {
    for (const argv of [["--enrol-signer"], ["--enrol-signer", "a", "b"], ["--enrol-signer", "--build"]]) {
      const run = spawnSync(process.execPath, [CHECKER_PATH, ...argv], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 15_000 });
      expect(run.status, argv.join(" ")).toBe(2);
    }
  });

  it.skipIf(!hasExpect)("under a real pty (expect) the same retyping writes both files", () => {
    const key = makeSigningKey();
    const { home, env } = isolatedEnvironment();
    const run = enrolUnderPty({ keyFile: key.publicPath, home });
    expect(run.status, run.output).toBe(0);
    const dir = trustDirectoryOf(checker, env);
    expect(modeOf(dir)).toBe(0o700);
    expect(readFileSync(join(dir, "allowed-signers"), "utf8")).toBe(allowedSignersLine(key));
    expect(JSON.parse(readFileSync(join(dir, "review-signer.json"), "utf8")).fingerprint).toBe(fingerprintByTool(key));
  });
});
