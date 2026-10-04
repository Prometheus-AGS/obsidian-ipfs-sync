import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadOperatorChecker, type OperatorChecker } from "../helpers/guard-operator.ts";

/**
 * mvp-07b task 4.6: the pure parts of the operator-run harness tools/feature-op-mvp-07.mjs (arguments, policy, the stale-dist
 * guard, the plugin install and its hashes, the record and transcript files, the assertion plan against the checker's
 * REQUIRED_ASSERTIONS). Nothing here opens a socket or talks to a node. The run itself is in feature-op-mvp-07-run.test.ts.
 */
interface Assertion {
  readonly id: string;
  readonly kind: string;
}
interface Phase {
  readonly phase: string;
  readonly task: string;
  readonly group: string;
  readonly assertions: readonly string[];
}
interface Options {
  readonly phases: string;
  readonly verifyOnly: boolean;
  readonly tamperExpect: boolean;
  readonly localStub: boolean;
  readonly dryRun: boolean;
  readonly trigger: string;
  readonly ownedKey?: string;
  readonly acceptUnresolvedPointer: boolean;
  readonly distDir?: string;
  readonly outDir?: string;
  readonly evidence: readonly string[];
  readonly help: boolean;
}
interface GuardResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly state?: { readonly treeSha256: string; readonly files: Record<string, string> };
}
interface InstallResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly installed: { readonly cli: string; readonly vaults: readonly { readonly name: string; readonly files: Record<string, string> }[] };
}
interface Harness {
  readonly REQUIRED_ASSERTIONS: readonly Assertion[];
  readonly OPERATOR_RECORD_FILE: string;
  readonly OPERATOR_TRANSCRIPT_FILE: string;
  readonly OPERATOR_RECORD_MAX_AGE_MS: number;
  readonly DEMO_PARENT: string;
  readonly KEY: string;
  readonly PHASE_PLAN: readonly Phase[];
  exportedAssertionList(): readonly Assertion[];
  assertPlanMatchesChecker(): void;
  scopeFor(opts: Pick<Options, "phases" | "verifyOnly">): { run: readonly string[]; notRun: readonly { id: string; reason: string }[] };
  isValidRunId(id: unknown): boolean;
  demoRootFor(id: string): string;
  parseArguments(argv: readonly string[], context?: { env?: Record<string, string | undefined>; platform?: string }): Options;
  runMode(opts: Pick<Options, "phases" | "verifyOnly" | "localStub">): string;
  recordNamesFor(mode: string): { record: string; transcript: string };
  assertThrowawayPath(path: string, label: string): void;
  guardBuildRefusal(options: { root: string; readState: (root: string) => unknown; computeTree: (options: { root: string }) => unknown; hashFile: (path: string) => string | undefined }): GuardResult;
  installPlugin(options: { distDir: string; vaultsRoot: string; names: readonly string[]; expected?: Record<string, string>; tamperExpect?: boolean }): InstallResult;
  buildRecord(input: Record<string, unknown>): Record<string, unknown>;
  writeOperatorFiles(options: { dir: string; names: { record: string; transcript: string }; record: Record<string, unknown>; transcript: string }): { recordPath: string; transcriptPath: string };
  restoreInstruction(preRun: { keyId: string | null; previousPointer: string | null }): string;
  isOutsideRepo(path: string): boolean;
}

const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(ROOT, "tools", "feature-op-mvp-07.mjs");
const SPEC = join(ROOT, "openspec", "changes", "mvp-07b-keys-history-guard-release-2", "specs", "release-2", "spec.md");
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const sha = (data: string): string => createHash("sha256").update(data).digest("hex");

let h: Harness;
let checker: OperatorChecker;
const temporary: string[] = [];
const temp = (): string => {
  const path = mkdtempSync(join(tmpdir(), "fop07-helpers-"));
  temporary.push(path);
  return path;
};

beforeAll(async () => {
  h = (await import(/* @vite-ignore */ pathToFileURL(SCRIPT).href)) as Harness;
  checker = await loadOperatorChecker();
});
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

describe("the assertion list the script records, against the checker and the release-2 spec", () => {
  it("is the checker's REQUIRED_ASSERTIONS (same object, imported not declared) and the names of the record files", () => {
    expect(h.REQUIRED_ASSERTIONS).toBe(checker.REQUIRED_ASSERTIONS);
    expect(h.OPERATOR_RECORD_FILE).toBe(checker.OPERATOR_RECORD_FILE);
    expect(h.OPERATOR_TRANSCRIPT_FILE).toBe(checker.OPERATOR_TRANSCRIPT_FILE);
    expect(h.OPERATOR_RECORD_MAX_AGE_MS).toBe(checker.OPERATOR_RECORD_MAX_AGE_MS);
  });

  it("exports an assertion list, built from the script's own phase plan, equal in ids, kinds and order to REQUIRED_ASSERTIONS", () => {
    expect(h.exportedAssertionList()).toEqual(checker.REQUIRED_ASSERTIONS.map(({ id, kind }) => ({ id, kind })));
    expect(() => h.assertPlanMatchesChecker()).not.toThrow();
  });

  it("equals the ids named in the release-2 spec text (completes the comparison test of 4.4a)", () => {
    const spec = readFileSync(SPEC, "utf8");
    const start = spec.indexOf("at least these assertion ids, each passed:");
    const end = spec.indexOf("A CLI-only or simulated result");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const sentence = spec.slice(start, end).replace(/\([^)]*\)/g, "");
    const ids = [...sentence.matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1]);
    expect(h.exportedAssertionList().map(({ id }) => id)).toEqual(ids);
  });

  it("puts every required id in exactly one phase, and names the task that must build each phase", () => {
    const all = h.PHASE_PLAN.flatMap((phase) => phase.assertions);
    expect([...all].sort()).toEqual(checker.REQUIRED_ASSERTIONS.map(({ id }) => id).sort());
    expect(new Set(all).size).toBe(all.length);
    expect(h.PHASE_PLAN.map(({ task }) => task).sort()).toEqual(["4.6", "4.6", "4.7a", "4.7b", "4.7b"]);
  });

  it("a plan that drifts from the checker is refused (a missing id, an extra id)", () => {
    const drifted = h.PHASE_PLAN.map((phase, index) => (index === 0 ? { ...phase, assertions: [...phase.assertions, "made-up-id"] } : phase));
    expect(() => (h as unknown as { assertPlanMatches(plan: readonly Phase[], required: readonly Assertion[]): void }).assertPlanMatches(drifted, checker.REQUIRED_ASSERTIONS)).toThrow(/made-up-id/);
    expect(() => (h as unknown as { assertPlanMatches(plan: readonly Phase[], required: readonly Assertion[]): void }).assertPlanMatches(h.PHASE_PLAN.slice(1), checker.REQUIRED_ASSERTIONS)).toThrow(/installed-files-hashed|only-demo-root/);
  });

  it("script-only runs no Obsidian-observed assertion (they are recorded as not run); verify-only and full runs evaluate all 18", () => {
    const scriptOnly = h.scopeFor({ phases: "script-only", verifyOnly: false });
    expect(scriptOnly.notRun.map(({ id }) => id)).toEqual(
      ["ciphertext-only-on-node", "plaintext-restored-byte-equal", "wrong-passphrase-refused", "first-pull-confirm-shown", "sequence-recorded", "pull-no-node-mutation", "conflict-copy-kept", "multi-segment-blob-pulled-in-plugin"],
    );
    expect(scriptOnly.run).toHaveLength(10);
    expect(scriptOnly.run).toContain("installed-files-hashed");
    expect(scriptOnly.run).toContain("mass-removal-stopped");
    for (const options of [{ phases: "all", verifyOnly: false }, { phases: "all", verifyOnly: true }]) {
      const scope = h.scopeFor(options);
      expect(scope.run).toHaveLength(18);
      expect(scope.notRun).toEqual([]);
    }
  });
});

describe("demo root and real-vault refusal", () => {
  it("builds the demo root only from a valid run identifier, under mvp07b-demo", () => {
    expect(h.DEMO_PARENT).toBe("/obsidian-vault-sync/mvp07b-demo");
    expect(h.KEY).toBe("obsidian-vault-sync");
    expect(h.demoRootFor("abcd1234")).toBe("/obsidian-vault-sync/mvp07b-demo/abcd1234");
    for (const bad of ["../x", "short", "ABCDEFGH", "abcd/1234"]) expect(() => h.demoRootFor(bad)).toThrow(/does not match/);
  });

  it("refuses a path inside the operator's real vault, inside the repository, or relative; accepts one in the OS temp directory", () => {
    expect(() => h.assertThrowawayPath("/Users/gqadonis/obsidian/notes", "vault")).toThrow(/real vault/);
    expect(() => h.assertThrowawayPath("/Users/gqadonis/obsidian", "vault")).toThrow(/real vault/);
    expect(() => h.assertThrowawayPath(join(ROOT, "dist", "x"), "vault")).toThrow(/repository/);
    expect(() => h.assertThrowawayPath("relative/dir", "vault")).toThrow(/absolute/);
    expect(() => h.assertThrowawayPath(join(temp(), "vault"), "vault")).not.toThrow();
  });

  it("holds the real vault path once in the whole script (the refusal guard), and builds no testing import", () => {
    const files = [SCRIPT, ...readdirSync(join(ROOT, "tools", "feature-op-mvp-07")).filter((name) => name.endsWith(".mjs")).map((name) => join(ROOT, "tools", "feature-op-mvp-07", name))];
    const hits = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/\/Users\/gqadonis/g)].map(() => file));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/feature-op-mvp-07\/policy\.mjs$/);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/crypto\/testing/);
      expect(text, file).not.toMatch(/\b(?:import|require)\s*\(/);
    }
  });
});

describe("arguments", () => {
  const env = { HOME: "/home/someone" };
  const parse = (...argv: string[]): Options => h.parseArguments(argv, { env, platform: "linux" });

  it("defaults to the full manual run on the shared node", () => {
    const opts = parse();
    expect(opts).toMatchObject({ phases: "all", verifyOnly: false, tamperExpect: false, localStub: false, dryRun: false, trigger: "manual", acceptUnresolvedPointer: false, help: false });
    expect(opts.evidence).toEqual([]);
    expect(h.runMode(opts)).toBe("manual");
  });

  it("accepts the cadence entry: --phases script-only --owned-key <id>", () => {
    const opts = parse("--phases", "script-only", "--owned-key", "k51abc");
    expect(opts).toMatchObject({ phases: "script-only", ownedKey: "k51abc" });
    expect(h.runMode(opts)).toBe("script-only");
    expect(parse("--phases=script-only").phases).toBe("script-only");
  });

  it("marks verify-only first, then script-only, then a local stub; only a bare run is manual", () => {
    expect(h.runMode({ phases: "all", verifyOnly: true, localStub: false })).toBe("verify-only");
    expect(h.runMode({ phases: "script-only", verifyOnly: true, localStub: true })).toBe("verify-only");
    expect(h.runMode({ phases: "script-only", verifyOnly: false, localStub: true })).toBe("script-only");
    expect(h.runMode({ phases: "all", verifyOnly: false, localStub: true })).toBe("local-stub");
    expect(h.runMode({ phases: "all", verifyOnly: false, localStub: false })).toBe("manual");
  });

  it("gives each mode its own file names; only manual gets the names item B reads", () => {
    expect(h.recordNamesFor("manual")).toEqual({ record: h.OPERATOR_RECORD_FILE, transcript: h.OPERATOR_TRANSCRIPT_FILE });
    const seen = new Set<string>([h.OPERATOR_RECORD_FILE, h.OPERATOR_TRANSCRIPT_FILE]);
    for (const mode of ["verify-only", "script-only", "local-stub"]) {
      const names = h.recordNamesFor(mode);
      expect(names.record).toMatch(/^feature-op-mvp-07\..+\.json$/);
      expect(names.transcript).toMatch(/^feature-op-mvp-07\..+\.transcript\.log$/);
      expect(names.record).toContain(mode);
      for (const name of [names.record, names.transcript]) {
        expect(seen.has(name)).toBe(false);
        seen.add(name);
      }
    }
  });

  it("refuses an unknown phases value, an unknown option, a missing value, and --trigger other than manual", () => {
    expect(() => parse("--phases", "obsidian-only")).toThrow(/--phases/);
    expect(() => parse("--bogus")).toThrow(/unknown option/);
    expect(() => parse("--owned-key")).toThrow(/needs a value/);
    expect(() => parse("--trigger=cli")).toThrow(/manual/);
    expect(parse("--trigger=manual").trigger).toBe("manual");
  });

  it("--tamper-expect needs --verify-only; --out-dir and --dist-dir need --local-stub; --accept-unresolved-pointer is shared-node only", () => {
    expect(() => parse("--tamper-expect")).toThrow(/--verify-only/);
    expect(parse("--verify-only", "--tamper-expect").tamperExpect).toBe(true);
    expect(() => parse("--out-dir", "/tmp/x")).toThrow(/--local-stub/);
    expect(() => parse("--dist-dir", "/tmp/x")).toThrow(/--local-stub/);
    expect(parse("--local-stub", "--out-dir", "/tmp/fop07-out", "--dist-dir", "/tmp/fop07-dist")).toMatchObject({ outDir: "/tmp/fop07-out", distDir: "/tmp/fop07-dist" });
    expect(() => parse("--local-stub", "--accept-unresolved-pointer")).toThrow(/shared-node/);
    expect(() => parse("--dry-run", "--accept-unresolved-pointer")).toThrow(/shared-node/);
    expect(parse("--accept-unresolved-pointer").acceptUnresolvedPointer).toBe(true);
  });

  it("refuses an output, dist or evidence directory inside the repository or the real vault", () => {
    expect(() => parse("--local-stub", "--out-dir", join(ROOT, "out"))).toThrow(/repository/);
    expect(() => parse("--local-stub", "--out-dir", "/Users/gqadonis/obsidian/out")).toThrow(/real vault/);
    expect(() => parse("--evidence", join(ROOT, "evidence"))).toThrow(/repository/);
    expect(() => parse("--evidence", "/Users/gqadonis/obsidian/evidence")).toThrow(/real vault/);
    expect(parse("--evidence", "/tmp/fop07-evidence-a", "--evidence=/tmp/fop07-evidence-b").evidence).toEqual(["/tmp/fop07-evidence-a", "/tmp/fop07-evidence-b"]);
  });
});

describe("the stale dist/ guard (reads dist/.guard-build.json, builds nothing)", () => {
  const TREE = "a".repeat(64);
  const files = { "dist/plugin/main.js": sha("main"), "dist/plugin/manifest.json": sha("manifest"), "dist/cli/ipfs-sync.mjs": sha("cli") };
  const state = { schema: 1, treeSha256: TREE, files };
  const guard = (change: { state?: unknown; tree?: unknown; disk?: Record<string, string | undefined> } = {}): GuardResult =>
    h.guardBuildRefusal({
      root: "/repo",
      readState: () => ("state" in change ? change.state : { ok: true, state }),
      computeTree: () => ("tree" in change ? change.tree : { ok: true, treeSha256: TREE }),
      hashFile: (path) => ("disk" in change ? change.disk?.[path.replace("/repo/", "")] : (files as Record<string, string>)[path.replace("/repo/", "")]),
    });

  it("passes when the state, the current tree and every file on disk agree, and returns the state", () => {
    const result = guard();
    expect(result.ok).toBe(true);
    expect(result.state?.treeSha256).toBe(TREE);
  });

  it("refuses a missing state file, with the checker's --build named", () => {
    const result = guard({ state: { ok: false, reason: "dist/.guard-build.json is missing or not a regular file" } });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/guard-build/);
    expect(result.reason).toMatch(/--build/);
  });

  it("refuses a tree that changed since the build, and a tree that cannot be hashed (dirty)", () => {
    expect(guard({ tree: { ok: true, treeSha256: "b".repeat(64) } }).reason).toMatch(/tree.*changed|differs/i);
    expect(guard({ tree: { ok: false, failures: [{ code: "tree-dirty", detail: "tools/x.mjs differs from HEAD" }] } }).reason).toMatch(/tree-dirty|tools\/x\.mjs/);
  });

  it("refuses a file on disk that is not the file the state vouches for, or is absent", () => {
    expect(guard({ disk: { ...files, "dist/cli/ipfs-sync.mjs": sha("other") } }).reason).toMatch(/dist\/cli\/ipfs-sync\.mjs/);
    expect(guard({ disk: { "dist/plugin/main.js": files["dist/plugin/main.js"], "dist/plugin/manifest.json": files["dist/plugin/manifest.json"] } }).reason).toMatch(/dist\/cli\/ipfs-sync\.mjs/);
  });
});

describe("install into throwaway vaults and hash the installed files", () => {
  const dist = (extra: Record<string, string | null> = {}): string => {
    const root = temp();
    mkdirSync(join(root, "plugin"), { recursive: true });
    mkdirSync(join(root, "cli"), { recursive: true });
    const content: Record<string, string | null> = { "plugin/main.js": "main bytes", "plugin/manifest.json": JSON.stringify({ id: "obsidian-ipfs-sync", version: "0.3.0" }), "plugin/styles.css": "css bytes", "cli/ipfs-sync.mjs": "cli bytes", ...extra };
    for (const [path, text] of Object.entries(content)) if (text !== null) writeFileSync(join(root, path), text);
    return root;
  };

  it("copies dist/plugin into two vaults and records the sha256 of each installed file and the CLI bundle", () => {
    const result = h.installPlugin({ distDir: dist(), vaultsRoot: temp(), names: ["v1", "v2"] });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.installed.vaults.map(({ name }) => name)).toEqual(["v1", "v2"]);
    for (const vault of result.installed.vaults) expect(vault.files).toEqual({ "main.js": sha("main bytes"), "manifest.json": sha(JSON.stringify({ id: "obsidian-ipfs-sync", version: "0.3.0" })), "styles.css": sha("css bytes") });
    expect(result.installed.cli).toBe(sha("cli bytes"));
  });

  it("installs under .obsidian/plugins/<manifest id>/ and leaves styles.css out when the build has none", () => {
    const vaultsRoot = temp();
    const result = h.installPlugin({ distDir: dist({ "plugin/styles.css": null }), vaultsRoot, names: ["v1", "v2"] });
    expect(result.ok).toBe(true);
    expect(Object.keys(result.installed.vaults[0].files)).toEqual(["main.js", "manifest.json"]);
    expect(readdirSync(join(vaultsRoot, "v1", ".obsidian", "plugins", "obsidian-ipfs-sync")).sort()).toEqual(["main.js", "manifest.json"]);
  });

  it("fails (not crashes) when a required output is missing, and says which", () => {
    const result = h.installPlugin({ distDir: dist({ "plugin/manifest.json": null }), vaultsRoot: temp(), names: ["v1", "v2"] });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/manifest\.json/);
    expect(h.installPlugin({ distDir: dist({ "cli/ipfs-sync.mjs": null }), vaultsRoot: temp(), names: ["v1", "v2"] }).problems.join(" ")).toMatch(/ipfs-sync\.mjs/);
  });

  it("compares with the hashes B vouches for: equal passes, different fails, and --tamper-expect flips one so it fails", () => {
    const root = dist();
    const expected = { "dist/plugin/main.js": sha("main bytes"), "dist/plugin/manifest.json": sha(JSON.stringify({ id: "obsidian-ipfs-sync", version: "0.3.0" })), "dist/plugin/styles.css": sha("css bytes"), "dist/cli/ipfs-sync.mjs": sha("cli bytes") };
    expect(h.installPlugin({ distDir: root, vaultsRoot: temp(), names: ["v1", "v2"], expected }).ok).toBe(true);
    const wrong = h.installPlugin({ distDir: root, vaultsRoot: temp(), names: ["v1", "v2"], expected: { ...expected, "dist/plugin/main.js": sha("not main") } });
    expect(wrong.ok).toBe(false);
    expect(wrong.problems.join(" ")).toMatch(/main\.js/);
    const flipped = h.installPlugin({ distDir: root, vaultsRoot: temp(), names: ["v1", "v2"], expected, tamperExpect: true });
    expect(flipped.ok).toBe(false);
  });

  it("refuses to install into the real vault or the repository", () => {
    expect(() => h.installPlugin({ distDir: dist(), vaultsRoot: "/Users/gqadonis/obsidian/vaults", names: ["v1", "v2"] })).toThrow(/real vault/);
    expect(() => h.installPlugin({ distDir: dist(), vaultsRoot: join(ROOT, "vaults"), names: ["v1", "v2"] })).toThrow(/repository/);
  });
});

describe("record and transcript files", () => {
  const input = (mode: string, transcript = "line 1\nline 2\n"): Record<string, unknown> => ({
    mode,
    phases: mode === "script-only" ? "script-only" : "all",
    verifyOnly: mode === "verify-only",
    passed: true,
    startedAt: "2026-10-04T10:00:00.000Z",
    finishedAt: "2026-10-04T10:05:00.000Z",
    treeSha256: "a".repeat(64),
    transcript,
    installed: { cli: "c".repeat(64), vaults: [{ name: "v1", files: { "main.js": "d".repeat(64) } }, { name: "v2", files: { "main.js": "d".repeat(64) } }] },
    ownedKey: { name: "obsidian-vault-sync", keyId: "k51abc", before: `/ipfs/${CID}`, after: "/ipfs/bafyother0000000000" },
    assertions: checker.REQUIRED_ASSERTIONS.map(({ id, kind }) => ({ id, kind, passed: true, detail: "ok" })),
    evidencePaths: [],
  });
  const fixtureEnv = (): { env: Record<string, string>; directory: string } => {
    const env = { HOME: temp() };
    return { env, directory: join(checker.perUserStateDir(env), "feature-ops") };
  };
  const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
  const tree = { treeSha256: "a".repeat(64) } as never;
  const buildFiles = {};

  it("writes a 0700 directory, a 0600 transcript and a 0600 record whose transcriptSha256 is the hash of the transcript", () => {
    const { directory } = fixtureEnv();
    const names = h.recordNamesFor("manual");
    const written = h.writeOperatorFiles({ dir: directory, names, record: h.buildRecord(input("manual")), transcript: "line 1\nline 2\n" });
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(written.recordPath).mode & 0o777).toBe(0o600);
    expect(statSync(written.transcriptPath).mode & 0o777).toBe(0o600);
    const record = JSON.parse(readFileSync(written.recordPath, "utf8"));
    expect(record.transcriptSha256).toBe(sha("line 1\nline 2\n"));
    expect(record.transcript).toBeUndefined();
    expect(record.installed.vaults).toHaveLength(2);
    expect(record.ownedKey).toMatchObject({ before: `/ipfs/${CID}`, after: "/ipfs/bafyother0000000000" });
  });

  it("carries the field shape the checker reads (mode, passed, finishedAt, treeSha256, installed.vaults[].files, assertions[{id,kind,passed,detail}])", () => {
    const { env, directory } = fixtureEnv();
    h.writeOperatorFiles({ dir: directory, names: h.recordNamesFor("manual"), record: h.buildRecord(input("manual")), transcript: "line 1\nline 2\n" });
    const result = checker.checkOperatorRecord({ tree, buildFiles: { "dist/cli/ipfs-sync.mjs": "c".repeat(64) }, environment: env, now: NOW });
    const codes = result.failures.map((failure) => failure.code);
    // Everything the record asserts about itself is accepted; what is left is only B's file list, which this fixture does not model.
    expect(codes.filter((code) => !code.startsWith("operator-install"))).toEqual([]);
  });

  for (const mode of ["script-only", "verify-only"]) {
    it(`a ${mode} record put where item B reads is refused as operator-simulated, even with every assertion passed`, () => {
      const { env, directory } = fixtureEnv();
      const record = h.buildRecord(input(mode));
      expect(record).toMatchObject({ mode, phases: mode === "script-only" ? "script-only" : "all", verifyOnly: mode === "verify-only" });
      h.writeOperatorFiles({ dir: directory, names: h.recordNamesFor("manual"), record, transcript: "line 1\nline 2\n" });
      const result = checker.checkOperatorRecord({ tree, buildFiles: { "dist/cli/ipfs-sync.mjs": "c".repeat(64) }, environment: env, now: NOW });
      expect(result.failures.map((failure) => failure.code)).toContain("operator-simulated");
    });
  }

  it("a local-stub record is refused as not manual", () => {
    const { env, directory } = fixtureEnv();
    h.writeOperatorFiles({ dir: directory, names: h.recordNamesFor("manual"), record: h.buildRecord(input("local-stub")), transcript: "line 1\nline 2\n" });
    const result = checker.checkOperatorRecord({ tree, buildFiles: { "dist/cli/ipfs-sync.mjs": "c".repeat(64) }, environment: env, now: NOW });
    expect(result.failures.map((failure) => failure.code)).toContain("operator-not-manual");
  });

  it("a non-manual run never writes the canonical file names (it cannot overwrite a real operator record)", () => {
    const { directory } = fixtureEnv();
    h.writeOperatorFiles({ dir: directory, names: h.recordNamesFor("script-only"), record: h.buildRecord(input("script-only")), transcript: "t\n" });
    expect(readdirSync(directory).sort()).toEqual([h.recordNamesFor("script-only").record, h.recordNamesFor("script-only").transcript].sort());
    expect(existsSync(join(directory, h.OPERATOR_RECORD_FILE))).toBe(false);
  });

  it("refuses an existing directory that is group-writable, a symbolic link, or not owned privately, before writing anything", () => {
    const base = temp();
    const loose = join(base, "loose");
    mkdirSync(loose);
    chmodSync(loose, 0o775);
    expect(() => h.writeOperatorFiles({ dir: loose, names: h.recordNamesFor("manual"), record: h.buildRecord(input("manual")), transcript: "t\n" })).toThrow(/0700|mode/);
    expect(readdirSync(loose)).toEqual([]);
    const real = join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(base, "link");
    symlinkSync(real, link);
    expect(() => h.writeOperatorFiles({ dir: link, names: h.recordNamesFor("manual"), record: h.buildRecord(input("manual")), transcript: "t\n" })).toThrow(/symbolic link/);
  });
});

describe("restore text (4.9 wording)", () => {
  it("is the 07a text: the verified-once sentence, the kubectl wrapper on the node, and not the old 'unverified' line", () => {
    const text = h.restoreInstruction({ keyId: "k51abc", previousPointer: `/ipfs/${CID}` });
    expect(text).toContain("verified on kubo v0.42.0: default lifetime and TTL, and explicit --ttl 5m --lifetime 24h on a throwaway key (accepted; the pointer resolved); the TTL a remote resolver sees was not checked");
    expect(text).not.toMatch(/options untested/);
    expect(text).toContain(`kubectl --context know-me -n ipfs exec ipfs-0 -c ipfs -- ipfs name publish --key=obsidian-vault-sync --ttl 5m /ipfs/${CID}`);
    expect(text).not.toMatch(/unverified: test this form/);
  });
});
