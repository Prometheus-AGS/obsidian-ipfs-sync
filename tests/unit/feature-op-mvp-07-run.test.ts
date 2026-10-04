import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadOperatorChecker, type OperatorChecker } from "../helpers/guard-operator.ts";

/**
 * mvp-07b task 4.6: runs of tools/feature-op-mvp-07.mjs against its script-hosted stub node only (--local-stub). No shared node, no
 * kubectl, no Obsidian. Every file the runs write lies under a temporary directory. The two runs are made once and shared.
 */
interface Entry {
  readonly id: string;
  readonly kind: string;
  readonly passed: boolean;
  readonly detail: string;
}
interface Record_ {
  readonly mode: string;
  readonly phases: string;
  readonly verifyOnly: boolean;
  readonly tamperExpect: boolean;
  readonly passed: boolean;
  readonly treeSha256: string;
  readonly transcriptSha256: string;
  readonly installed: { readonly cli: string; readonly vaults: readonly { readonly name: string; readonly files: Record<string, string> }[] };
  readonly ownedKey: { readonly name: string; readonly keyId: string | null; readonly before: string | null; readonly after: string | null };
  readonly restore: string;
  readonly assertions: readonly Entry[];
  readonly notRun: readonly { readonly id: string }[];
  readonly proxy: { readonly requests: number; readonly mutating: number; readonly violations: number };
}
interface Harness {
  main(argv: readonly string[], overrides?: Record<string, unknown>): Promise<number>;
  recordNamesFor(mode: string): { record: string; transcript: string };
}
interface Outcome {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly dir: string;
  readonly record: Record_;
  readonly transcript: string;
}

const ROOT = resolve(__dirname, "..", "..");
const sha = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const temporary: string[] = [];
const temp = (): string => {
  const path = mkdtempSync(join(tmpdir(), "fop07-run-"));
  temporary.push(path);
  return path;
};

let h: Harness;
let checker: OperatorChecker;
let distDir: string;
const runs = new Map<string, Promise<Outcome>>();

beforeAll(async () => {
  h = (await import(/* @vite-ignore */ pathToFileURL(join(ROOT, "tools", "feature-op-mvp-07.mjs")).href)) as Harness;
  checker = await loadOperatorChecker();
  distDir = temp();
  mkdirSync(join(distDir, "plugin"));
  mkdirSync(join(distDir, "cli"));
  writeFileSync(join(distDir, "plugin", "main.js"), "main bytes");
  writeFileSync(join(distDir, "plugin", "manifest.json"), JSON.stringify({ id: "obsidian-ipfs-sync", version: "0.3.0" }));
  writeFileSync(join(distDir, "cli", "ipfs-sync.mjs"), "cli bytes");
});
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

const context = (dir: string, sink: { out: string; err: string }): Record<string, unknown> => ({
  env: { HOME: dir, PATH: process.env.PATH },
  platform: "linux",
  lockFile: join(dir, "run.lock"),
  write: (text: string) => void (sink.out += text),
  writeError: (text: string) => void (sink.err += text),
});

function execute(key: string, argv: readonly string[]): Promise<Outcome> {
  const existing = runs.get(key);
  if (existing !== undefined) return existing;
  const started = (async (): Promise<Outcome> => {
    const dir = temp();
    const sink = { out: "", err: "" };
    const mode = argv.includes("--verify-only") ? "verify-only" : "script-only";
    const code = await h.main([...argv, "--local-stub", "--dist-dir", distDir, "--out-dir", join(dir, "feature-ops")], context(dir, sink));
    const names = h.recordNamesFor(mode);
    const base = join(dir, "feature-ops");
    return { code, out: sink.out, err: sink.err, dir: base, record: JSON.parse(readFileSync(join(base, names.record), "utf8")) as Record_, transcript: readFileSync(join(base, names.transcript), "utf8") };
  })();
  runs.set(key, started);
  return started;
}
const scriptOnly = (): Promise<Outcome> => execute("script-only", ["--phases", "script-only", "--owned-key", "k51-not-used"]);
const verifyTamper = (): Promise<Outcome> => execute("verify-tamper", ["--verify-only", "--tamper-expect"]);
const byId = (record: Record_, id: string): Entry => record.assertions.find((entry) => entry.id === id) as Entry;

describe("--phases script-only against the stub node", () => {
  it("evaluates the 10 script-applicable assertions, passes the two harness ones, fails the stubs by name, and exits 1", async () => {
    const run = await scriptOnly();
    expect(run.err).toBe("");
    expect(run.code).toBe(1);
    expect(run.record.assertions).toHaveLength(10);
    expect(byId(run.record, "installed-files-hashed").passed).toBe(true);
    expect(byId(run.record, "only-demo-root-and-owned-key-changed").passed).toBe(true);
    // This build directory holds stand-in bytes for the CLI, so every scenario (tasks 4.7a and 4.7b) fails at its setup and says it did not run to
    // completion; the scenarios have their own test files with the real CLI (feature-op-mvp-07-machine and -cli-phases).
    const scenarios = run.record.assertions.filter((entry) => !["installed-files-hashed", "only-demo-root-and-owned-key-changed"].includes(entry.id));
    expect(scenarios).toHaveLength(8);
    for (const entry of scenarios) {
      expect(entry.passed, entry.id).toBe(false);
      expect(entry.detail, entry.id).toMatch(/ran to completion/);
      expect(entry.detail, entry.id).not.toMatch(/NOT IMPLEMENTED/);
    }
    expect(run.record.passed).toBe(false);
  });

  it("records the eight Obsidian-observed assertions as not run, not as passed", async () => {
    const run = await scriptOnly();
    expect(run.record.notRun.map(({ id }) => id)).toEqual(["ciphertext-only-on-node", "plaintext-restored-byte-equal", "wrong-passphrase-refused", "first-pull-confirm-shown", "sequence-recorded", "pull-no-node-mutation", "conflict-copy-kept", "multi-segment-blob-pulled-in-plugin"]);
    expect(run.record.assertions.map(({ id }) => id)).not.toContain("first-pull-confirm-shown");
  });

  it("marks the record script-only and writes it beside, not over, the file item B reads", async () => {
    const run = await scriptOnly();
    expect(run.record).toMatchObject({ mode: "script-only", phases: "script-only", verifyOnly: false });
    expect(readdirSync(run.dir).sort()).toEqual([h.recordNamesFor("script-only").record, h.recordNamesFor("script-only").transcript].sort());
    expect(existsSync(join(run.dir, checker.OPERATOR_RECORD_FILE))).toBe(false);
  });

  it("writes private files whose transcript hash matches, the pointer lines and the 4.9 restore wording", async () => {
    const run = await scriptOnly();
    const names = h.recordNamesFor("script-only");
    expect(statSync(run.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(run.dir, names.record)).mode & 0o777).toBe(0o600);
    expect(statSync(join(run.dir, names.transcript)).mode & 0o777).toBe(0o600);
    expect(run.record.transcriptSha256).toBe(sha(run.transcript));
    expect(run.transcript).toContain("previous IPNS pointer of obsidian-vault-sync: key absent -> none");
    expect(run.transcript).toContain("IPNS pointer of obsidian-vault-sync after the run: key absent -> none");
    expect(run.transcript).toMatch(/nothing to restore: the key did not exist before this run/);
    expect(run.record.restore).toMatch(/nothing to restore/);
    expect(run.record.ownedKey).toMatchObject({ name: "obsidian-vault-sync", keyId: null, before: null, after: null });
    expect(run.transcript).not.toMatch(/unverified: test this form/);
  });

  it("installs the build into two vaults and records the hashes; the proxy saw no mutation and no violation", async () => {
    const run = await scriptOnly();
    expect(run.record.installed.cli).toBe(sha("cli bytes"));
    expect(run.record.installed.vaults.map(({ name }) => name)).toEqual(["v1", "v2"]);
    for (const vault of run.record.installed.vaults) expect(vault.files["main.js"]).toBe(sha("main bytes"));
    expect(run.record.proxy.mutating).toBe(0);
    expect(run.record.proxy.violations).toBe(0);
    expect(run.record.treeSha256).toMatch(/^none \(script-only/);
  });

  it("is refused by item B as operator-simulated when placed where the checker reads (the record carries phases: script-only)", async () => {
    const run = await scriptOnly();
    const env = { HOME: temp() };
    const directory = join(checker.perUserStateDir(env), "feature-ops");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, checker.OPERATOR_RECORD_FILE), JSON.stringify({ ...run.record, passed: true }), { mode: 0o600 });
    writeFileSync(join(directory, checker.OPERATOR_TRANSCRIPT_FILE), run.transcript, { mode: 0o600 });
    const result = checker.checkOperatorRecord({ tree: { treeSha256: "a".repeat(64) } as never, buildFiles: {}, environment: env, now: Date.now() });
    expect(result.failures.map((failure) => failure.code)).toContain("operator-simulated");
  });
});

describe("--verify-only --tamper-expect against the stub node", () => {
  it("exits 1, marks the record verify-only, evaluates all 18 assertions, and fails the tampered installed-files-hashed", async () => {
    const run = await verifyTamper();
    const clean = await scriptOnly();
    expect(run.code).toBe(1);
    expect(run.record).toMatchObject({ mode: "verify-only", verifyOnly: true, tamperExpect: true, passed: false });
    expect(run.record.assertions).toHaveLength(18);
    expect(run.record.notRun).toEqual([]);
    expect(byId(clean.record, "installed-files-hashed").passed).toBe(true);
    expect(byId(run.record, "installed-files-hashed").passed).toBe(false);
    expect(byId(run.record, "installed-files-hashed").detail).toMatch(/ipfs-sync\.mjs has sha256/);
    expect(byId(run.record, "only-demo-root-and-owned-key-changed").passed).toBe(true);
  });

  it("keeps the kinds the checker requires, and every stub fails (the verify-only result passes only what it can)", async () => {
    const run = await verifyTamper();
    for (const required of checker.REQUIRED_ASSERTIONS) {
      const entry = byId(run.record, required.id);
      expect(entry.kind).toBe(required.kind);
      if (!["installed-files-hashed", "only-demo-root-and-owned-key-changed"].includes(required.id)) expect(entry.passed).toBe(false);
    }
  });

  it("is refused by item B as operator-simulated when placed where the checker reads", async () => {
    const run = await verifyTamper();
    const env = { HOME: temp() };
    const directory = join(checker.perUserStateDir(env), "feature-ops");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, checker.OPERATOR_RECORD_FILE), JSON.stringify({ ...run.record, passed: true }), { mode: 0o600 });
    writeFileSync(join(directory, checker.OPERATOR_TRANSCRIPT_FILE), run.transcript, { mode: 0o600 });
    const result = checker.checkOperatorRecord({ tree: { treeSha256: "a".repeat(64) } as never, buildFiles: {}, environment: env, now: Date.now() });
    expect(result.failures.map((failure) => failure.code)).toContain("operator-simulated");
  });
});

describe("refusals before any request", () => {
  const sink = () => ({ out: "", err: "" });
  const ctx = (dir: string, s: { out: string; err: string }, extra: Record<string, unknown> = {}) => ({ ...context(dir, s), ...extra });

  it("a stale or missing dist/ build state exits 2 before the node is contacted (a listener on the configured RPC URL sees no connection)", async () => {
    let connections = 0;
    const server: Server = createServer((_, response) => response.end("{}"));
    server.on("connection", () => void (connections += 1));
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
    try {
      const dir = temp();
      const s = sink();
      const code = await h.main(["--phases", "script-only", "--owned-key", "k51-not-used"], ctx(dir, s, { env: { HOME: dir, PATH: process.env.PATH, IPFS_SYNC_RPC_URL: url, IPFS_SYNC_GATEWAY_URL: url }, readGuardBuild: () => ({ ok: false, reason: "dist/.guard-build.json is missing or not a regular file" }) }));
      expect(code).toBe(2);
      expect(s.err).toMatch(/refused: .*guard-build.*--build/s);
      expect(connections).toBe(0);
      expect(existsSync(join(dir, ".local"))).toBe(false);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it("a build state for another tree exits 2 as well", async () => {
    const dir = temp();
    const s = sink();
    const code = await h.main(["--phases", "script-only"], ctx(dir, s, { readGuardBuild: () => ({ ok: true, state: { treeSha256: "a".repeat(64), files: {} } }), computeTree: () => ({ ok: true, treeSha256: "b".repeat(64) }) }));
    expect(code).toBe(2);
    expect(s.err).toMatch(/tree changed/);
  });

  it("usage errors exit 2: --tamper-expect alone, --trigger=cli, --out-dir without --local-stub", async () => {
    for (const argv of [["--tamper-expect"], ["--trigger=cli"], ["--out-dir", "/tmp/x"]]) {
      const s = sink();
      expect(await h.main(argv, ctx(temp(), s))).toBe(2);
      expect(s.err).toMatch(/usage:/);
    }
  });

  it("a held lock exits 2 without writing a result", async () => {
    const dir = temp();
    writeFileSync(join(dir, "run.lock"), String(process.pid));
    const s = sink();
    const code = await h.main(["--local-stub", "--phases", "script-only", "--dist-dir", distDir, "--out-dir", join(dir, "out")], ctx(dir, s));
    expect(code).toBe(2);
    expect(s.err).toMatch(/in progress/);
    expect(existsSync(join(dir, "out", h.recordNamesFor("script-only").record))).toBe(false);
  });
});

describe("--dry-run", () => {
  it("prints the plan with every phase and its task, runs offline self-checks that pass, and writes nothing", async () => {
    const dir = temp();
    const s = { out: "", err: "" };
    const code = await h.main(["--dry-run"], context(dir, s));
    expect(code).toBe(0);
    expect(s.out).toMatch(/DRY RUN/);
    for (const phase of ["harness-install", "harness-node-audit", "obsidian-observed-steps", "hostile-preparer", "script-only-cli-phases"]) expect(s.out).toContain(phase);
    for (const required of checker.REQUIRED_ASSERTIONS) expect(s.out).toContain(required.id);
    expect(s.out).toContain("/obsidian-vault-sync/mvp07b-demo/<runid>");
    expect(s.out).not.toMatch(/FAIL/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
