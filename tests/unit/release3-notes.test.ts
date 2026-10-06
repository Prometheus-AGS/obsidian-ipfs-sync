import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture } from "../helpers/release-fixture.ts";

/**
 * Task 5.1 of mvp-10: the Release 3 (v0.4.0) descriptor, notes builder and plan/record tool. The notes tests pin
 * the spec-mandated opening: the can/cannot paragraph of spec release-3, with the AI-layer gate sentence inside it,
 * and no airplane-mode or on-device-AI claim anywhere else. The tool tests spawn the real CLI against fixture roots;
 * nothing contacts GitHub and nothing spawns git, gh or pnpm (the record tests stop at the refusals, before any
 * build or write).
 */
interface Descriptor {
  readonly version: string;
  readonly tag: string;
  readonly outDir: string;
  readonly cliTarball: string;
  readonly featureOpFile: string;
  readonly prerelease: boolean;
  readonly requiresFixtureStatement: boolean;
  readonly record: { readonly bumpVersions: boolean; readonly build: boolean };
  readonly limitations: readonly string[];
}
interface Demo {
  readonly recordPath: string;
  readonly mobileOutcome: string | null;
}
interface NotesInput {
  readonly descriptor: Descriptor;
  readonly sums: readonly { name: string; sha256: string }[];
  readonly unverified: readonly string[];
  readonly demo?: Demo | null;
}
interface Release3Module {
  readonly AI_GATE_SENTENCE: string;
  readonly RELEASE_3_LIMITATIONS: readonly string[];
  buildRelease3Notes(input: NotesInput): string;
  release3UnverifiedClaims(demo: Demo | null, facts: { featureOp: { verdict: string } }, options: Record<string, unknown>): string[];
}
interface DescriptorsModule {
  readonly RELEASE_3: Descriptor;
  makeRelease3(demo: Demo | null): Descriptor & { buildNotes(input: NotesInput): string; unverifiedClaims(facts: unknown, options: Record<string, unknown>): string[] };
}

const ROOT = resolve(__dirname, "..", "..");
const TOOL = join(ROOT, "tools", "release-mvp-10.mjs");
let release3: Release3Module;
let descriptors: DescriptorsModule;
const roots: string[] = [];
const freshRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "rel3-"));
  roots.push(root);
  buildFixture(root, {});
  return root;
};

beforeAll(async () => {
  const load = async (rel: string): Promise<unknown> => import(/* @vite-ignore */ pathToFileURL(join(ROOT, rel)).href);
  release3 = (await load("tools/release/release3.mjs")) as Release3Module;
  descriptors = (await load("tools/release/descriptors.mjs")) as DescriptorsModule;
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const SUMS = [
  { name: "main.js", sha256: "a".repeat(64) },
  { name: "manifest.json", sha256: "b".repeat(64) },
];
const DEMO: Demo = { recordPath: "docs/operator/mvp-10-demo-record.json", mobileOutcome: null };
const notes = (demo: Demo | null): string =>
  release3.buildRelease3Notes({ descriptor: descriptors.makeRelease3(demo), sums: SUMS, unverified: ["First unverified item."], demo });
const opening = (text: string): string => text.split("\n")[0];

describe("release 3 notes builder: the can/cannot opening", () => {
  it("opens with the can/cannot paragraph of spec release-3", () => {
    const first = opening(notes(DEMO));
    expect(first).toContain("Release 3 can: publish and pull a real encrypted vault between Obsidian desktop and the CLI");
    expect(first).toContain("demonstrated on the operator's own ~1.0 GB vault with 0 sha256 mismatches across the published set");
    expect(first).toContain("It cannot: hide file count, exact sizes, publish timing or access patterns");
    expect(first).toContain("claim mobile support (");
    expect(first).toContain("claim Android support (untested)");
    expect(first).toContain("cap or exclude files in the CLI");
    expect(first).toContain("recover a lost passphrase");
    expect(first).toContain("take back an old passphrase or old key-slot copy after a change");
    expect(first).toContain("remove deleted notes from old pinned roots");
  });

  it("carries the AI-layer gate sentence and no airplane-mode or on-device claim outside it", () => {
    for (const demo of [null, DEMO, { ...DEMO, mobileOutcome: "iPhone 15, iOS 26, Obsidian 1.12: pulled 4,824 files" }]) {
      const text = notes(demo);
      expect(text).toContain(release3.AI_GATE_SENTENCE);
      expect(release3.AI_GATE_SENTENCE).toMatch(/airplane-mode|on-device-AI/);
      const hits = text.split("\n").filter((line) => /airplane|on-device/i.test(line));
      expect(hits).toEqual([opening(text)]);
      expect(hits[0]).toContain(release3.AI_GATE_SENTENCE);
    }
  });

  it("states no demo result when no demo record was supplied", () => {
    const text = notes(null);
    expect(opening(text)).toContain("no demo record was supplied, so this notes build states no demo result");
    expect(text).not.toContain("demonstrated on the operator's own");
    expect(text).toContain("- No demo record was supplied to this notes build");
  });

  it("says mobile stays unverified when the optional attempt was not run, and only as recorded when it was", () => {
    expect(opening(notes(DEMO))).toContain("the optional mobile attempt was not run — mobile stays unverified (T3)");
    expect(opening(notes({ ...DEMO, mobileOutcome: "iPhone 15, iOS 26: pull completed" }))).toContain(
      "the optional mobile attempt was recorded as: iPhone 15, iOS 26: pull completed — one recorded attempt, not a verification",
    );
  });

  it("keeps Release 2's limitations and adds the CLI's missing read cap and exclusion option", () => {
    const text = notes(DEMO);
    expect(text).toContain("- The CLI has no per-file read cap and no exclusion option; both exist only in the Obsidian plugin.");
    expect(release3.RELEASE_3_LIMITATIONS.length).toBeGreaterThanOrEqual(5);
    expect(text).toContain("- Rewrap does not revoke the old passphrase or any old copy of the key slot.");
  });

  it("lists the unverified items, including the AI-layer run that has not happened", () => {
    const items = release3.release3UnverifiedClaims(DEMO, { featureOp: { verdict: "passing" } }, {});
    expect(items.some((item) => item.includes("Mobile stays unverified (T3)"))).toBe(true);
    expect(items.some((item) => item.includes("Android is untested"))).toBe(true);
    expect(items.some((item) => item.includes("has not happened"))).toBe(true);
    const withVerdictGap = release3.release3UnverifiedClaims(DEMO, { featureOp: { verdict: "indeterminate" } }, {});
    expect(withVerdictGap[0]).toContain("carries no pass verdict");
    const withoutDemo = release3.release3UnverifiedClaims(null, { featureOp: { verdict: "missing-or-unreadable" } }, {});
    expect(withoutDemo[0]).toContain("no demo record was supplied");
  });
});

describe("release 3 descriptor", () => {
  it("holds Release 3's values: v0.4.0, no fixture statement, bump and build at record time", () => {
    const d = descriptors.makeRelease3(null);
    expect(d).toMatchObject({
      version: "0.4.0",
      tag: "v0.4.0",
      outDir: "dist/release/v0.4.0",
      cliTarball: "ipfs-sync-cli-0.4.0.tgz",
      prerelease: true,
      requiresFixtureStatement: false,
      record: { bumpVersions: true, build: true },
    });
    expect(descriptors.RELEASE_3.tag).toBe("v0.4.0");
    expect(d.buildNotes({ descriptor: d, sums: SUMS, unverified: [] })).toContain("Release 3 can:");
  });
});

describe("release-mvp-10 tool", () => {
  const run = (args: string[]) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });

  it("plan is read-only and prints the outward steps as NOT RUN", () => {
    const root = freshRoot();
    const result = run(["plan", "--root", root]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RELEASE PLAN v0.4.0 (read-only)");
    expect(result.stdout).toContain("Outward steps");
    expect(result.stdout).toContain("NOT RUN  gh release create v0.4.0 --repo Prometheus-AGS/obsidian-ipfs-sync --verify-tag --prerelease --latest=false");
    expect(result.stdout).toContain("manifest.json  version 0.1.0 -> 0.4.0");
    expect(existsSync(join(root, "dist", "release"))).toBe(false);
  });

  it("record refuses without --demo-record and writes nothing", () => {
    const root = freshRoot();
    const result = run(["record", "--root", root]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--demo-record");
    expect(existsSync(join(root, "dist", "release"))).toBe(false);
  });

  it("record refuses a demo record that carries no pass verdict", () => {
    const root = freshRoot();
    writeFileSync(join(root, "demo-record.md"), "# demo record\n\na narrative record, no verdict the tool accepts\n");
    const result = run(["record", "--root", root, "--demo-record", "demo-record.md", "--no-build"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Feature operation is not passing");
    expect(existsSync(join(root, "dist", "release"))).toBe(false);
  });

  it("record refuses a demo record path that does not exist", () => {
    const root = freshRoot();
    const result = run(["record", "--root", root, "--demo-record", "no-such-file.json"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("the demo record does not exist");
  });
});
