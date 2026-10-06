import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestDist } from "../helpers/built-cli.ts";

/**
 * mvp-07b task 4.7b: the hostile preparer and the script-only CLI scenarios, through the built CLI as child processes against the script-hosted
 * stub node, every request through the confinement proxy. One run per scenario (the harness's test-only `scenarios` context option selects it), each
 * made once and shared by the assertions about it. The prune scenario needs 25 real publishes and is opt-in (FOP07_PRUNE_FULL=1).
 */
interface Entry {
  readonly id: string;
  readonly kind: string;
  readonly passed: boolean;
  readonly detail: string;
}
interface Record_ {
  readonly assertions: readonly Entry[];
  readonly proxy: { readonly requests: number; readonly mutating: number; readonly violations: number };
  readonly passed: boolean;
}
interface Harness {
  main(argv: readonly string[], overrides?: Record<string, unknown>): Promise<number>;
  recordNamesFor(mode: string): { record: string; transcript: string };
}
interface Checks {
  sameDigestMap(a: Map<string, string>, b: Map<string, string>): boolean;
}

const ROOT = resolve(__dirname, "..", "..");
const TOOLS = join(ROOT, "tools", "feature-op-mvp-07");
/**
 * One scenario run spawns the built CLI many times and every spawn boots the embedded PGlite history store
 * (~1.8 s measured per fresh boot, mvp-08): the heaviest scenario (replay) took 32 s measured, so 90 s with
 * headroom instead of the default 20 s.
 */
const SCENARIO_TIMEOUT_MS = 90_000;
const temporary: string[] = [];
const temp = (): string => {
  const path = mkdtempSync(join(tmpdir(), "fop07-cli-"));
  temporary.push(path);
  return path;
};

let h: Harness;
let checks: Checks;
let distDir: string;
const runs = new Map<string, Promise<{ code: number; err: string; record: Record_; transcript: string }>>();

beforeAll(async () => {
  h = (await import(/* @vite-ignore */ pathToFileURL(join(ROOT, "tools", "feature-op-mvp-07.mjs")).href)) as Harness;
  checks = (await import(/* @vite-ignore */ pathToFileURL(join(TOOLS, "machine-checks.mjs")).href)) as Checks;
  distDir = await buildTestDist();
  temporary.push(distDir);
});
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function scenario(names: readonly string[], extra: Record<string, unknown> = {}) {
  const key = `${names.join("+")}:${JSON.stringify(extra)}`;
  const existing = runs.get(key);
  if (existing !== undefined) return existing;
  const started = (async () => {
    const dir = temp();
    const sink = { out: "", err: "" };
    const context = { env: { HOME: dir, PATH: process.env.PATH }, platform: process.platform, lockFile: join(dir, "run.lock"), write: (text: string) => void (sink.out += text), writeError: (text: string) => void (sink.err += text), scenarios: names, ...extra };
    const code = await h.main(["--phases", "script-only", "--owned-key", "k51-not-used", "--local-stub", "--dist-dir", distDir, "--out-dir", join(dir, "feature-ops")], context);
    const files = readdirSync(join(dir, "feature-ops")).sort();
    const named = h.recordNamesFor("script-only");
    expect(files).toEqual([named.record, named.transcript].sort());
    return { code, err: sink.err, record: JSON.parse(readFileSync(join(dir, "feature-ops", named.record), "utf8")) as Record_, transcript: readFileSync(join(dir, "feature-ops", named.transcript), "utf8") };
  })();
  runs.set(key, started);
  return started;
}
const byId = (record: Record_, id: string): Entry => record.assertions.find((entry) => entry.id === id) as Entry;
const passes = async (names: readonly string[], ids: readonly string[], extra: Record<string, unknown> = {}) => {
  const run = await scenario(names, extra);
  expect(run.err).toBe("");
  for (const id of ids) expect(byId(run.record, id).passed, `${id}: ${byId(run.record, id).detail}`).toBe(true);
  expect(run.record.proxy.violations).toBe(0);
  return run;
};

describe("scenario selection (test-only) and the plan", () => {
  it("an unselected scenario fails its assertions by name and runs nothing: no mutation reaches the node", async () => {
    const run = await scenario([]);
    for (const id of ["tamper-refused-nothing-written", "older-root-by-name-refused", "restore-older-version", "fork-resolved", "rewrap-and-accept", "increase-cost", "prune-history", "mass-removal-stopped"]) {
      expect(byId(run.record, id).passed, id).toBe(false);
      expect(byId(run.record, id).detail, id).toMatch(/not selected/);
    }
    expect(run.record.proxy.mutating).toBe(0);
  });

  it("no NOT IMPLEMENTED stub is left in the harness", () => {
    for (const name of readdirSync(TOOLS).filter((file) => file.endsWith(".mjs"))) {
      const text = readFileSync(join(TOOLS, name), "utf8");
      expect(text, name).not.toMatch(/notImplemented|NOT IMPLEMENTED/);
    }
  });

  it("the harness text builds no import of the test-only hook, names its folder nowhere and uses no dynamic import", () => {
    for (const name of readdirSync(TOOLS).filter((file) => file.endsWith(".mjs"))) {
      const text = readFileSync(join(TOOLS, name), "utf8");
      expect(text, name).not.toMatch(/crypto\/testing/);
      expect(text, name).not.toMatch(/["'`/]testing["'`/]/);
      expect(text, name).not.toMatch(/\b(?:import|require)\s*\(/);
    }
  });

  it("sameDigestMap compares paths and hashes", () => {
    expect(checks.sameDigestMap(new Map([["a", "1"]]), new Map([["a", "1"]]))).toBe(true);
    expect(checks.sameDigestMap(new Map([["a", "1"]]), new Map([["a", "2"]]))).toBe(false);
    expect(checks.sameDigestMap(new Map([["a", "1"]]), new Map())).toBe(false);
  });
});

describe("hostile preparer", () => {
  it("prepares a tampered root only inside <DEMO_ROOT>/tamper and the pull of it is refused as integrity-failed with the device unchanged", async () => {
    const run = await passes(["tamper"], ["tamper-refused-nothing-written"]);
    const entry = byId(run.record, "tamper-refused-nothing-written");
    expect(entry.kind).toBe("machine");
    expect(entry.detail).toMatch(/\/tamper/);
    expect(run.transcript).toMatch(/hostile preparer/);
  }, SCENARIO_TIMEOUT_MS);
});

describe("script-only CLI scenarios", () => {
  it("older root by name is refused and a restore by --root-cid needs the flag, then publishes at sequence + 1", async () => {
    await passes(["replay"], ["older-root-by-name-refused", "restore-older-version"]);
  }, SCENARIO_TIMEOUT_MS);

  it("a fork is refused by name, resolved by --resolve-fork, and the next publish continues", async () => {
    await passes(["fork"], ["fork-resolved"]);
  }, SCENARIO_TIMEOUT_MS);

  it("a rewrap is refused on the other device until it accepts; the old passphrase fails on the current file and opens the previous root", async () => {
    await passes(["keys"], ["rewrap-and-accept"]);
  }, SCENARIO_TIMEOUT_MS);

  it("increase-cost raises the slot and an unattended publish then refuses the higher cost", async () => {
    await passes(["cost"], ["increase-cost"]);
  }, SCENARIO_TIMEOUT_MS);

  it.skipIf(process.env.FOP07_PRUNE_FULL === undefined)("prune-history removes the oldest history files after 25 publishes and changes nothing else", async () => {
    await passes(["prune"], ["prune-history"]);
  });

  it("mass-removal-stopped passes on the run's main vault", async () => {
    await passes(["mass"], ["mass-removal-stopped"]);
  }, SCENARIO_TIMEOUT_MS);
});

describe("the complete verify-only replay", () => {
  // About 90 CLI runs and the 25 publishes of the prune scenario: far beyond a unit test's budget. Opt-in: FOP07_FULL=1 with a long --testTimeout.
  it.skipIf(process.env.FOP07_FULL === undefined)("passes all 18 assertions except the operator-observed one, with every scenario, mass removal last", async () => {
    const dir = temp();
    const sink = { out: "", err: "" };
    const blob = 1024 * 1024;
    const context = { env: { HOME: dir, PATH: process.env.PATH }, platform: process.platform, lockFile: join(dir, "run.lock"), write: (text: string) => void (sink.out += text), writeError: (text: string) => void (sink.err += text), largeBlobBytes: blob, largeBlobMinBytes: blob };
    const code = await h.main(["--verify-only", "--local-stub", "--dist-dir", distDir, "--out-dir", join(dir, "feature-ops")], context);
    const record = JSON.parse(readFileSync(join(dir, "feature-ops", h.recordNamesFor("verify-only").record), "utf8")) as Record_;
    expect(record.assertions).toHaveLength(18);
    const failed = record.assertions.filter((entry) => !entry.passed).map((entry) => entry.id);
    expect(failed, sink.err).toEqual(["first-pull-confirm-shown"]);
    expect(code).toBe(1);
    expect(record.proxy.violations).toBe(0);
    expect(sink.out.lastIndexOf("step 7: mass-removal stop")).toBeGreaterThan(sink.out.lastIndexOf("prune-history after"));
  });
});
