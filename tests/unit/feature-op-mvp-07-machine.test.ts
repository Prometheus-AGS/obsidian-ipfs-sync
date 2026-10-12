import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestDist } from "../helpers/built-cli.ts";

/**
 * mvp-07b task 4.7a, the machine side: the seven assertions of the Obsidian phase and the mass-removal stop, driven through the built CLI
 * as a child process against the script-hosted stub node, every request through the confinement proxy. Two runs are made once and shared.
 * The blob is small here (FOP07_BLOB_MIB, default 1); the 20 MiB floor itself is tested as a pure check below.
 */
interface Entry {
  readonly id: string;
  readonly kind: string;
  readonly passed: boolean;
  readonly detail: string;
}
interface Record_ {
  readonly assertions: readonly Entry[];
  readonly notRun: readonly { readonly id: string }[];
  readonly passed: boolean;
  readonly ownedKey: { readonly keyId: string | null };
  readonly proxy: { readonly requests: number; readonly mutating: number; readonly violations: number };
}
interface Harness {
  main(argv: readonly string[], overrides?: Record<string, unknown>): Promise<number>;
  recordNamesFor(mode: string): { record: string; transcript: string };
}
interface Checks {
  verdict(id: string, checks: readonly { label: string; ok: boolean; detail?: string }[]): { id: string; passed: boolean; detail: string };
  treeMismatches(expected: Map<string, string>, actual: Map<string, string>): string[];
  scanProblems(input: { log: readonly { needle?: string; command: string }[]; scan: { files: number; bytes: number; hit: string | null }; minFiles: number; minBytes: number }): string[];
  blobNamesFetched(trace: readonly { command: string; arg?: string }[]): string[];
  blobSizeProblem(bytes: number, minBytes: number): string | undefined;
  LARGE_BLOB_MIN_BYTES: number;
}

const ROOT = resolve(__dirname, "..", "..");
const BLOB_MIB = Number(process.env.FOP07_BLOB_MIB ?? "1");
/**
 * --verify-only spawns the built CLI for every machine step and every spawn boots the embedded PGlite history
 * store (~1.8 s measured per fresh boot, mvp-08): the shared verify-only run took 46 s measured, so 120 s with
 * headroom instead of the default 20 s.
 */
const RUN_TIMEOUT_MS = 120_000;
const MACHINE_IDS = ["ciphertext-only-on-node", "plaintext-restored-byte-equal", "wrong-passphrase-refused", "sequence-recorded", "pull-no-node-mutation", "conflict-copy-kept", "multi-segment-blob-pulled-in-plugin"];
const STUB_IDS = ["tamper-refused-nothing-written", "older-root-by-name-refused", "restore-older-version", "fork-resolved", "rewrap-and-accept", "increase-cost", "prune-history"];
const temporary: string[] = [];
const temp = (): string => {
  const path = mkdtempSync(join(tmpdir(), "fop07-mach-"));
  temporary.push(path);
  return path;
};

let h: Harness;
let checks: Checks;
let distDir: string;
const runs = new Map<string, Promise<{ code: number; err: string; record: Record_; transcript: string }>>();

beforeAll(async () => {
  h = (await import(/* @vite-ignore */ pathToFileURL(join(ROOT, "tools", "feature-op-mvp-07.mjs")).href)) as Harness;
  checks = (await import(/* @vite-ignore */ pathToFileURL(join(ROOT, "tools", "feature-op-mvp-07", "machine-checks.mjs")).href)) as Checks;
  distDir = await buildTestDist();
  temporary.push(distDir);
});
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function execute(key: string, argv: readonly string[], mode: string) {
  const existing = runs.get(key);
  if (existing !== undefined) return existing;
  const started = (async () => {
    const dir = temp();
    const sink = { out: "", err: "" };
    const blob = BLOB_MIB * 1024 * 1024;
    const context = { env: { HOME: dir, PATH: process.env.PATH }, platform: process.platform, lockFile: join(dir, "run.lock"), write: (text: string) => void (sink.out += text), writeError: (text: string) => void (sink.err += text), largeBlobBytes: blob, largeBlobMinBytes: blob, scenarios: ["mass"] };
    const code = await h.main([...argv, "--local-stub", "--dist-dir", distDir, "--out-dir", join(dir, "feature-ops")], context);
    const names = h.recordNamesFor(mode);
    const base = join(dir, "feature-ops");
    expect(readdirSync(base).sort()).toEqual([names.record, names.transcript].sort());
    return { code, err: sink.err, record: JSON.parse(readFileSync(join(base, names.record), "utf8")) as Record_, transcript: readFileSync(join(base, names.transcript), "utf8") };
  })();
  runs.set(key, started);
  return started;
}
const verifyOnly = () => execute("verify-only", ["--verify-only"], "verify-only");
const scriptOnly = () => execute("script-only", ["--phases", "script-only", "--owned-key", "k51-not-used"], "script-only");
const byId = (record: Record_, id: string): Entry => record.assertions.find((entry) => entry.id === id) as Entry;

describe("--verify-only replay through the built CLI against the stub node", () => {
  it("passes the seven machine assertions of the Obsidian steps and the mass-removal stop, each of kind machine", async () => {
    const run = await verifyOnly();
    expect(run.err).toBe("");
    for (const id of [...MACHINE_IDS, "mass-removal-stopped"]) {
      const entry = byId(run.record, id);
      expect(entry.kind, id).toBe("machine");
      expect(entry.passed, `${id}: ${entry.detail}`).toBe(true);
      expect(entry.detail.length, id).toBeGreaterThan(0);
    }
  }, RUN_TIMEOUT_MS);

  it("does not ask the operator: the operator-observed assertion fails as not asked; the scenarios of 4.7b are not selected in this run and fail by name (their own test file runs them)", async () => {
    const run = await verifyOnly();
    expect(byId(run.record, "first-pull-confirm-shown")).toMatchObject({ kind: "operator-observed", passed: false });
    expect(byId(run.record, "first-pull-confirm-shown").detail).toMatch(/not asked/);
    for (const id of STUB_IDS) {
      expect(byId(run.record, id).passed, id).toBe(false);
      expect(byId(run.record, id).detail, id).toMatch(/not selected/);
    }
    expect(run.code).toBe(1);
    expect(run.record.passed).toBe(false);
  }, RUN_TIMEOUT_MS);

  it("shows the proxy log inside the demo root and the owned key only, with real mutations, and the harness node audit passes", async () => {
    const run = await verifyOnly();
    expect(byId(run.record, "only-demo-root-and-owned-key-changed")).toMatchObject({ passed: true });
    expect(byId(run.record, "installed-files-hashed")).toMatchObject({ passed: true });
    expect(run.record.proxy.violations).toBe(0);
    expect(run.record.proxy.mutating).toBeGreaterThan(5);
    expect(run.record.ownedKey.keyId).toBeNull();
  }, RUN_TIMEOUT_MS);

  it("keeps passphrases and plaintext words out of the transcript", async () => {
    const run = await verifyOnly();
    expect(run.transcript).not.toMatch(/[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}/);
    expect(run.transcript).toMatch(/step 1|setup/i);
  }, RUN_TIMEOUT_MS);
});

describe("--phases script-only", () => {
  it("passes the mass-removal stop unattended (its own small vault); the other scenarios are not selected in this run", async () => {
    const run = await scriptOnly();
    expect(byId(run.record, "mass-removal-stopped").passed, byId(run.record, "mass-removal-stopped").detail).toBe(true);
    expect(run.record.assertions).toHaveLength(10);
    expect(run.record.notRun).toHaveLength(8);
    expect(STUB_IDS.filter((id) => byId(run.record, id).passed)).toEqual([]);
  }, RUN_TIMEOUT_MS);
});

describe("pure checks bite", () => {
  it("verdict fails when any check fails and names the failed ones", () => {
    expect(checks.verdict("x", [{ label: "a", ok: true }, { label: "b", ok: true }])).toMatchObject({ id: "x", passed: true });
    const failed = checks.verdict("x", [{ label: "a", ok: true }, { label: "b", ok: false, detail: "why" }]);
    expect(failed.passed).toBe(false);
    expect(failed.detail).toContain("b");
    expect(failed.detail).toContain("why");
    expect(checks.verdict("x", []).passed).toBe(false);
  });

  it("treeMismatches reports a different, a missing and an extra file", () => {
    const expected = new Map([["a.md", "1"], ["b.md", "2"], ["c.md", "3"]]);
    const actual = new Map([["a.md", "1"], ["b.md", "X"], ["d.md", "4"]]);
    const lines = checks.treeMismatches(expected, actual).join("|");
    expect(lines).toMatch(/b\.md/);
    expect(lines).toMatch(/c\.md/);
    expect(lines).toMatch(/d\.md/);
    expect(checks.treeMismatches(expected, new Map(expected))).toEqual([]);
  });

  it("scanProblems fails on a wire hit, a scan hit, and a scan that read nothing", () => {
    const good = { log: [{ command: "files/write" }], scan: { files: 12, bytes: 5000, hit: null }, minFiles: 10, minBytes: 1000 };
    expect(checks.scanProblems(good)).toEqual([]);
    expect(checks.scanProblems({ ...good, log: [{ command: "files/write", needle: 'body word "harbor"' }] }).join()).toMatch(/harbor/);
    expect(checks.scanProblems({ ...good, scan: { ...good.scan, hit: 'path "notes"' } }).join()).toMatch(/notes/);
    expect(checks.scanProblems({ ...good, scan: { files: 0, bytes: 0, hit: null } }).length).toBeGreaterThan(0);
  });

  it("blobNamesFetched counts distinct blob GETs only", () => {
    const name = "a".repeat(52);
    const other = "b".repeat(52);
    const trace = [
      { command: "gateway", arg: `/ipfs/bafyroot/current/aa/${name}` },
      { command: "gateway", arg: `/ipfs/bafyroot/current/aa/${name}` },
      { command: "gateway", arg: `/ipfs/bafycurrent/bb/${other}` },
      { command: "gateway", arg: "/ipfs/bafyroot/manifest.enc" },
      { command: "key/list" },
    ];
    expect(checks.blobNamesFetched(trace).sort()).toEqual([name, other].sort());
  });

  it("the large blob must reach 20 MiB for the multi-segment assertion", () => {
    expect(checks.LARGE_BLOB_MIN_BYTES).toBe(20 * 1024 * 1024);
    expect(checks.blobSizeProblem(20 * 1024 * 1024, checks.LARGE_BLOB_MIN_BYTES)).toBeUndefined();
    expect(checks.blobSizeProblem(20 * 1024 * 1024 - 1, checks.LARGE_BLOB_MIN_BYTES)).toMatch(/20/);
  });
});
