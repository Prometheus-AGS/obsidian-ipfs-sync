import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GOLDEN_DIR, buildFixture, normalizeText, snapshotDirectory } from "../helpers/release-fixture.ts";

/**
 * Task 4.1 of mvp-07b: the release tool is driven by a per-release descriptor. The first block is the Release 1
 * regression check. Its golden data (tests/golden/release-1/) was captured from the tool BEFORE the refactor, so a
 * descriptor holding Release 1's values must reproduce the old plan text, notes, steps and record byte for byte.
 * The second block covers what 4.8 relies on: derived fields, validation and the no-bump, no-build record mode.
 * Every fixture is a temporary directory; nothing contacts GitHub and nothing spawns git, gh or pnpm.
 */
interface Descriptor {
  readonly version: string;
  readonly tag: string;
  readonly repo: string;
  readonly minAppVersion: string;
  readonly cliTarball: string;
  readonly outDir: string;
  readonly featureOpFile: string;
  readonly commitMessage: string;
  readonly tagMessage: string;
  readonly releaseTitle: string;
  readonly prerelease: boolean;
  readonly requiresFixtureStatement: boolean;
  readonly record: { readonly bumpVersions: boolean; readonly build: boolean };
  buildNotes(input: { descriptor: Descriptor; sums: readonly { name: string; sha256: string }[]; unverified: readonly string[] }): string;
}
type Facts = Record<string, unknown>;
interface Step {
  readonly id: string;
  readonly title: string;
  readonly decision: string;
  readonly commands: readonly string[];
}
interface Modules {
  readonly descriptors: { RELEASE_1: Descriptor; makeDescriptor(spec: Record<string, unknown>): Descriptor };
  readonly facts: { gatherFacts(root: string, options: { featureOpPath?: string; descriptor: Descriptor }): Facts };
  readonly plan: { renderPlan(facts: Facts, options: { descriptor: Descriptor; outDir?: string }): { text: string; blockerCount: number } };
  readonly steps: { outwardSteps(input: { descriptor: Descriptor; facts: Facts; outDir?: string; assetNames: string[] }): Step[] };
  readonly record: {
    runRecord(input: { descriptor: Descriptor; root: string; outRel?: string; featureOpPath?: string; evidenceSpecs?: string[]; noBuild?: boolean; out: (text: string) => void }): number;
    Refusal: new (message: string) => Error;
  };
}

const TOOLS = resolve(__dirname, "..", "..", "tools", "release");
let m: Modules;
const roots: string[] = [];
const freshRoot = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};
const golden = (rel: string): string => readFileSync(join(GOLDEN_DIR, rel), "utf8");
const goldenBytes = (rel: string): Buffer => readFileSync(join(GOLDEN_DIR, rel));

beforeAll(async () => {
  const load = async (name: string): Promise<unknown> => import(/* @vite-ignore */ pathToFileURL(join(TOOLS, `${name}.mjs`)).href);
  m = {
    descriptors: (await load("descriptors")) as Modules["descriptors"],
    facts: (await load("facts")) as Modules["facts"],
    plan: (await load("plan")) as Modules["plan"],
    steps: (await load("steps")) as Modules["steps"],
    record: (await load("record")) as Modules["record"],
  };
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("Release 1 regression: the descriptor reproduces the pre-refactor outputs", () => {
  it("prints the same plan, byte for byte", () => {
    const root = freshRoot("rel1-plan-");
    buildFixture(root, {});
    const d = m.descriptors.RELEASE_1;
    const { text, blockerCount } = m.plan.renderPlan(m.facts.gatherFacts(root, { descriptor: d }), { descriptor: d, outDir: d.outDir });
    expect(normalizeText(text, root)).toBe(golden("plan.txt"));
    expect(`${blockerCount}\n`).toBe(golden("plan-blocker-count.txt"));
  });

  it("prints the same outward steps", () => {
    const root = freshRoot("rel1-steps-");
    buildFixture(root, {});
    const d = m.descriptors.RELEASE_1;
    const steps = m.steps.outwardSteps({ descriptor: d, facts: m.facts.gatherFacts(root, { descriptor: d }), outDir: d.outDir, assetNames: ["main.js", "manifest.json", "ipfs-sync-cli-0.2.0.tgz", "SHA256SUMS"] });
    expect(`${JSON.stringify(steps, null, 2)}\n`).toBe(golden("steps.json"));
  });

  it("writes the same release notes", () => {
    const d = m.descriptors.RELEASE_1;
    const notes = d.buildNotes({ descriptor: d, sums: [{ name: "main.js", sha256: "a".repeat(64) }, { name: "manifest.json", sha256: "b".repeat(64) }], unverified: ["First unverified claim.", "Second unverified claim."] });
    expect(notes).toBe(golden("notes.md"));
  });

  it("writes the same record: stdout, version bump, every file of the output directory, tarball bytes included", () => {
    const root = freshRoot("rel1-rec-");
    buildFixture(root, { distBumped: true, styles: true });
    const d = m.descriptors.RELEASE_1;
    const lines: string[] = [];
    const code = m.record.runRecord({ descriptor: d, root, outRel: d.outDir, evidenceSpecs: ["evidence/demo.txt=pull with conflict shown"], noBuild: true, out: (text) => lines.push(text) });
    expect(`${code}\n`).toBe(golden("record/exit-code.txt"));
    expect(`${normalizeText(lines.join("\n"), root)}\n`).toBe(golden("record/stdout.txt"));
    expect(readFileSync(join(root, "manifest.json"), "utf8")).toBe(golden("record/root-manifest.json"));
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(golden("record/root-package.json"));
    const snapshot = snapshotDirectory(join(root, d.outDir), root);
    const names = Object.keys(snapshot).sort();
    expect(names).toEqual(readdirSync(join(GOLDEN_DIR, "record", "out")).sort());
    for (const name of names) {
      const actual = snapshot[name] as string | Uint8Array;
      if (typeof actual === "string") expect(actual, name).toBe(golden(`record/out/${name}`));
      else expect(Buffer.from(actual).equals(goldenBytes(`record/out/${name}`)), name).toBe(true);
    }
  });

  it("holds Release 1's values in the descriptor fields", () => {
    const d = m.descriptors.RELEASE_1;
    expect(d).toMatchObject({
      version: "0.2.0",
      tag: "v0.2.0",
      minAppVersion: "1.12.3",
      cliTarball: "ipfs-sync-cli-0.2.0.tgz",
      outDir: "dist/release/v0.2.0",
      featureOpFile: "feature-op-mvp-05.json",
      commitMessage: "release: v0.2.0 (fixture-only pre-release)",
      tagMessage: "IPFS Sync 0.2.0 (fixture-only pre-release)",
      releaseTitle: "IPFS Sync 0.2.0 (fixture-only)",
      prerelease: true,
      requiresFixtureStatement: true,
      record: { bumpVersions: true, build: true },
    });
  });
});

describe("descriptor construction and the Release 2 shape", () => {
  const spec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    version: "0.3.0",
    tag: "v0.3.0",
    featureOpFile: "feature-op-mvp-07.json",
    commitMessage: "release: v0.3.0",
    tagMessage: "IPFS Sync 0.3.0",
    releaseTitle: "IPFS Sync 0.3.0",
    prerelease: true,
    requiresFixtureStatement: false,
    record: { bumpVersions: false, build: false },
    buildNotes: () => "notes",
    unverifiedClaims: () => [],
    claims: () => [],
    ...over,
  });

  it("derives the tarball name and the output directory from the version and the single tag field", () => {
    const d = m.descriptors.makeDescriptor(spec());
    expect(d.cliTarball).toBe("ipfs-sync-cli-0.3.0.tgz");
    expect(d.outDir).toBe("dist/release/v0.3.0");
    expect(m.descriptors.makeDescriptor(spec({ tag: "0.3.0" })).outDir).toBe("dist/release/0.3.0");
  });

  it("refuses a descriptor whose tag does not contain its version, or that omits a field", () => {
    expect(() => m.descriptors.makeDescriptor(spec({ tag: "v0.4.0" }))).toThrow(/tag/);
    expect(() => m.descriptors.makeDescriptor(spec({ releaseTitle: undefined }))).toThrow(/releaseTitle/);
    expect(() => m.descriptors.makeDescriptor(spec({ outDir: "../outside" }))).toThrow(/outDir/);
  });

  it("changes the step text and the plan header when the tag and titles change, hard-coding nothing from Release 1", () => {
    const root = freshRoot("rel2-plan-");
    buildFixture(root, { distBumped: true });
    const d = m.descriptors.makeDescriptor(spec());
    const facts = m.facts.gatherFacts(root, { descriptor: d });
    const steps = m.steps.outwardSteps({ descriptor: d, facts, outDir: d.outDir, assetNames: ["main.js"] });
    const text = JSON.stringify(steps);
    expect(text).toContain("git tag -a v0.3.0 -m \\\"IPFS Sync 0.3.0\\\"");
    expect(text).toContain("git push origin v0.3.0");
    expect(text).not.toMatch(/0\.2\.0|fixture-only/);
    expect(m.plan.renderPlan(facts, { descriptor: d, outDir: d.outDir }).text).toContain("RELEASE PLAN v0.3.0");
  });

  it("records without editing manifest.json or package.json and without a build", () => {
    const root = freshRoot("rel2-rec-");
    buildFixture(root, {});
    const manifest = readFileSync(join(root, "manifest.json"), "utf8").replace("0.1.0", "0.3.0").replace("1.10.0", "1.12.3");
    const pkg = readFileSync(join(root, "package.json"), "utf8").replace("0.1.0", "0.3.0");
    writeFileSync(join(root, "manifest.json"), manifest);
    writeFileSync(join(root, "package.json"), pkg);
    mkdirSync(join(root, "dist", "plugin"), { recursive: true });
    writeFileSync(join(root, "dist", "plugin", "manifest.json"), manifest);
    writeFileSync(join(root, "feature-op-mvp-07.json"), '{"passed":true}\n');
    const d = m.descriptors.makeDescriptor(spec());
    const lines: string[] = [];
    // package.json in the fixture has a `build` script that would fail if it ran: the descriptor says it must not run.
    const code = m.record.runRecord({ descriptor: d, root, out: (text) => lines.push(text) });
    expect(code).toBe(0);
    expect(readFileSync(join(root, "manifest.json"), "utf8")).toBe(manifest);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(pkg);
    expect(lines.join("\n")).not.toMatch(/bumped|running: pnpm/);
    const written = readdirSync(join(root, "dist", "release", "v0.3.0")).sort();
    expect(written).toEqual(["SHA256SUMS", "evidence.json", "ipfs-sync-cli-0.3.0.tgz", "main.js", "manifest.json", "release-notes.md"]);
    expect(readFileSync(join(root, "dist", "release", "v0.3.0", "manifest.json"), "utf8")).toBe(manifest);
    expect(JSON.parse(readFileSync(join(root, "dist", "release", "v0.3.0", "evidence.json"), "utf8"))).toMatchObject({ version: "0.3.0", tag: "v0.3.0" });
  });

  it("refuses a no-bump record when the root manifest does not already read the descriptor version", () => {
    const root = freshRoot("rel2-refuse-");
    buildFixture(root, { distBumped: true });
    const d = m.descriptors.makeDescriptor(spec());
    expect(() => m.record.runRecord({ descriptor: d, root, out: () => undefined })).toThrow(m.record.Refusal);
    expect(readFileSync(join(root, "manifest.json"), "utf8")).toContain('"version": "0.1.0"');
  });
});
