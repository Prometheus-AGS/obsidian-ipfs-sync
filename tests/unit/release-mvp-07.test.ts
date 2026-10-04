import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeTerminal, type FakeTerminal } from "../helpers/fake-terminal.ts";
import {
  BUILD_SHA,
  REVIEWED_COMMIT,
  SIGNER_FINGERPRINT,
  T8,
  TEST_ONLY_SENTINEL,
  TREE_SHA,
  builtFiles,
  buildRelease2Fixture,
  sha256,
  writeGuardState,
  type CheckerResult,
  type Json,
  type Release2Fixture,
  type Release2Options,
} from "../helpers/release2-fixture.ts";

/**
 * Task 4.8 of mvp-07b: tools/release-mvp-07.mjs, the Release 2 plan and local record. Every project root here is a
 * temporary directory, the guard checker is a prepared result (the real checker builds the project twice and runs the
 * checklist tests, which this file does not), and the terminal is an in-memory stream. Nothing contacts GitHub and
 * nothing spawns git, gh or pnpm. The four child processes below only refuse a bad command line.
 */
interface ReleaseModule {
  readonly runRelease2: (input: {
    mode: "plan" | "record";
    root: string;
    out: (text: string) => void;
    err: (text: string) => void;
    environment?: Record<string, string | undefined>;
    terminal?: unknown;
    runChecker?: Fixture["runChecker"];
    check?: boolean;
  }) => Promise<number>;
  readonly acknowledgementPhrase: (t8: string) => string;
}
type Fixture = Release2Fixture;
interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const ROOT = resolve(__dirname, "..", "..");
const TOOL = join(ROOT, "tools", "release-mvp-07.mjs");
const fixtures: Fixture[] = [];
let tool: ReleaseModule;
let descriptors: {
  RELEASE_2: Record<string, unknown>;
  makeRelease2(guard: unknown): Record<string, any> & { buildNotes(input: Record<string, unknown>): string };
};
let release2: { summarizeGuard(doc: Json): unknown; buildRelease2Notes(input: Record<string, unknown>): string };

beforeAll(async () => {
  const load = async (rel: string): Promise<any> => import(/* @vite-ignore */ pathToFileURL(join(ROOT, rel)).href);
  tool = await load("tools/release-mvp-07.mjs");
  descriptors = await load("tools/release/descriptors.mjs");
  release2 = await load("tools/release/release2.mjs");
});
afterAll(() => {
  for (const fixture of fixtures) {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.perUser, { recursive: true, force: true });
  }
});

const fresh = (options: Release2Options = {}): Fixture => {
  const fixture = buildRelease2Fixture(options);
  fixtures.push(fixture);
  return fixture;
};
const phrase = (): string => `I accept an unsigned review record for ${T8}`;
const outDir = (fx: Fixture): string => join(fx.root, "dist", "release", "v0.3.0");

async function run(fx: Fixture, mode: "plan" | "record", extra: { terminal?: FakeTerminal; environment?: Record<string, string | undefined>; check?: boolean; runChecker?: Fixture["runChecker"] } = {}): Promise<Run> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await tool.runRelease2({
    mode,
    root: fx.root,
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    environment: extra.environment ?? {},
    terminal: extra.terminal,
    runChecker: extra.runChecker ?? fx.runChecker,
    check: extra.check,
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}
const typing = (...lines: string[]): FakeTerminal => createFakeTerminal({ answers: lines.map((line) => `${line}\n`) });

/** Every file under `root` except dist/release/, keyed by relative path, valued by sha256. */
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).split("\\").join("/");
      if (rel === "dist/release") continue;
      if (entry.isDirectory()) walk(path);
      else result[rel] = sha256(readFileSync(path));
    }
  };
  walk(root);
  return result;
}
const failItem = (item: string): ((doc: Json) => void) => (doc) => {
  doc.pass = false;
  doc.items[item].status = "fail";
  doc.items[item].failures = [{ code: `broken-${item.toLowerCase()}`, detail: `item ${item} failed in the fixture` }];
};

describe("plan: read-only, prints the checker result", () => {
  it("prints a passing checker result for a git-history record and writes nothing", async () => {
    const fx = fresh();
    const before = snapshot(fx.root);
    const result = await run(fx, "plan");
    expect(result.code).toBe(0);
    expect(fx.checker.calls).toBe(1);
    expect(result.stdout).toContain("RELEASE PLAN v0.3.0");
    expect(result.stdout).toMatch(/guard checker: pass/i);
    expect(result.stdout).toContain(`tree ${T8}`);
    expect(result.stdout).toMatch(/item A: pass.*git-history/);
    expect(result.stdout).toContain("NOT RUN");
    expect(snapshot(fx.root)).toEqual(before);
    expect(existsSync(join(fx.root, "dist", "release"))).toBe(false);
  });

  it("prints a signature record and a timing acceptance as unverified timing", async () => {
    const fx = fresh({ form: "signature", timing: "acceptance" });
    const result = await run(fx, "plan");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/item A: pass.*signature/);
    expect(result.stdout).toContain(SIGNER_FINGERPRINT);
    expect(result.stdout).toMatch(/item C: pass.*timing unverified/);
  });

  it("prints each failing item and, with --check, exits 1; without it exits 0 and still writes nothing", async () => {
    const fx = fresh();
    fx.setDoc(failItem("A"));
    const before = snapshot(fx.root);
    const plain = await run(fx, "plan");
    expect(plain.code).toBe(0);
    expect(plain.stdout).toMatch(/guard checker: FAIL/);
    expect(plain.stdout).toContain("broken-a");
    expect(plain.stdout).toMatch(/item A: FAIL/);
    expect(plain.stdout).toMatch(/item B: pass/);
    expect((await run(fx, "plan", { check: true })).code).toBe(1);
    expect(snapshot(fx.root)).toEqual(before);
  });

  it("prints a checker that stopped before the items (tree or build failure) and one that could not run", async () => {
    const fx = fresh();
    fx.checker.result = { status: 1, stdout: `${JSON.stringify({ schema: 1, pass: false, complete: false, failures: [{ code: "tree-dirty", detail: "untracked file in scope" }] })}\n`, stderr: "" };
    const stopped = await run(fx, "plan");
    expect(stopped.stdout).toMatch(/guard checker: FAIL/);
    expect(stopped.stdout).toContain("tree-dirty");
    fx.checker.result = { status: 2, stdout: "", stderr: "checker error: not a repository\n" };
    const crashed = await run(fx, "plan");
    expect(crashed.stdout).toMatch(/guard checker: FAIL/);
    expect(crashed.stdout).toContain("not a repository");
    expect(crashed.code).toBe(0);
  });
});

describe("record: refuses unless the checker passes in the same run", () => {
  it.each(["A", "B", "C", "D", "E"])("refuses when item %s fails alone, lists it and writes nothing", async (item) => {
    const fx = fresh();
    fx.setDoc(failItem(item));
    const before = snapshot(fx.root);
    const result = await run(fx, "record", { terminal: typing(phrase()) });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`broken-${item.toLowerCase()}`);
    expect(result.stderr).toContain(`item ${item}`);
    expect(existsSync(join(fx.root, "dist", "release"))).toBe(false);
    expect(snapshot(fx.root)).toEqual(before);
  });

  it.each<[string, (good: CheckerResult) => CheckerResult]>([
    ["a checker that exited 2", () => ({ status: 2, stdout: "", stderr: "checker error: git missing\n" })],
    ["output that is not JSON", () => ({ status: 0, stdout: "result: pass\n", stderr: "" })],
    ["a pass document with a failing exit code", (good) => ({ ...good, status: 1 })],
  ])("refuses %s", async (_name, make) => {
    const fx = fresh();
    fx.checker.result = make(fx.checker.result);
    const outcome = await run(fx, "record", { terminal: typing(phrase()) });
    expect(outcome.code).toBe(2);
    expect(existsSync(join(fx.root, "dist", "release"))).toBe(false);
  });

  it("refuses a failing document with exit 0 and a passing document that omits an item", async () => {
    const fx = fresh();
    fx.setDoc(failItem("D"));
    fx.checker.result = { ...fx.checker.result, status: 0 };
    expect((await run(fx, "record", { terminal: typing(phrase()) })).code).toBe(2);
    const missing = fresh();
    missing.setDoc((doc) => {
      delete doc.items.E;
    });
    missing.checker.result = { ...missing.checker.result, status: 0 };
    const outcome = await run(missing, "record", { terminal: typing(phrase()) });
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toMatch(/item E/);
    expect(existsSync(join(missing.root, "dist", "release"))).toBe(false);
  });

  it("stops before the checker when IPFS_SYNC_ALLOWED_SIGNERS is set, for plan and for record", async () => {
    const fx = fresh();
    const environment = { IPFS_SYNC_ALLOWED_SIGNERS: "/tmp/somewhere" };
    const record = await run(fx, "record", { environment, terminal: typing(phrase()) });
    const plan = await run(fx, "plan", { environment });
    expect([record.code, plan.code]).toEqual([2, 2]);
    expect(record.stderr).toContain("IPFS_SYNC_ALLOWED_SIGNERS");
    expect(fx.checker.calls).toBe(0);
    expect(existsSync(join(fx.root, "dist", "release"))).toBe(false);
  });
});

describe("record: the stale-dist check and the version assertion", () => {
  it("refuses when dist/.guard-build.json is absent", async () => {
    const fx = fresh();
    rmSync(join(fx.root, "dist", ".guard-build.json"));
    const result = await run(fx, "record", { terminal: typing(phrase()) });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--build");
    expect(existsSync(join(fx.root, "dist", "release"))).toBe(false);
  });

  it.each<[string, (fx: Fixture) => void]>([
    ["the state file names another tree", (fx) => void writeGuardState(fx.root, false, { treeSha256: "d".repeat(64) })],
    ["the state file names another build hash", (fx) => void writeGuardState(fx.root, false, { buildSha256: "e".repeat(64) })],
    ["main.js changed after the checker's build", (fx) => void writeFileSync(join(fx.root, "dist", "plugin", "main.js"), 'console.log("edited after the build");\n')],
    ["the CLI bundle changed after the checker's build", (fx) => void writeFileSync(join(fx.root, "dist", "cli", "ipfs-sync.mjs"), "// edited\n")],
    ["dist/plugin holds a file the build does not list", (fx) => void writeFileSync(join(fx.root, "dist", "plugin", "extra.js"), "// extra\n")],
    ["the state file lists another file hash than the checker", (fx) => void writeGuardState(fx.root, false, { files: { ...builtFiles(fx.root, false), "dist/plugin/main.js": "f".repeat(64) } })],
  ])("refuses a stale dist: %s", async (_name, change) => {
    const fx = fresh();
    change(fx);
    const result = await run(fx, "record", { terminal: typing(phrase()) });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/stale|differs|does not match/i);
    expect(result.stderr).toContain("--build");
    expect(existsSync(join(fx.root, "dist", "release"))).toBe(false);
  });

  it("refuses when the checker's build hash differs from the files even though the state file matches them", async () => {
    const fx = fresh();
    fx.setDoc((doc) => {
      doc.build.files["dist/plugin/main.js"] = "a".repeat(64);
    });
    const result = await run(fx, "record", { terminal: typing(phrase()) });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/main\.js/);
    expect(existsSync(join(fx.root, "dist", "release"))).toBe(false);
  });

  it.each<[string, string, string]>([
    ["manifest.json", "manifest.json", "0.2.0"],
    ["package.json", "package.json", "0.2.0"],
  ])("refuses when %s does not read 0.3.0 and does not edit it", async (_name, file, version) => {
    const fx = fresh();
    const path = join(fx.root, file);
    writeFileSync(path, readFileSync(path, "utf8").replace('"version": "0.3.0"', `"version": "${version}"`));
    const before = snapshot(fx.root);
    const result = await run(fx, "record", { terminal: typing(phrase()) });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("0.3.0");
    expect(snapshot(fx.root)).toEqual(before);
  });

  it("refuses a shipped bundle that holds a test-only sentinel, although the hashes agree", async () => {
    const fx = fresh();
    writeFileSync(join(fx.root, "dist", "plugin", "main.js"), `console.log("${TEST_ONLY_SENTINEL}");\n`);
    writeGuardState(fx.root, false);
    fx.setDoc((doc) => {
      doc.build.files = builtFiles(fx.root, false);
    });
    const result = await run(fx, "record", { terminal: typing(phrase()) });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/sentinel/i);
    expect(result.stderr).toContain("main.js");
    expect(existsSync(join(fx.root, "dist", "release"))).toBe(false);
  });

  it("refuses an existing tag and leaves an earlier record directory as it was", async () => {
    const fx = fresh();
    mkdirSync(join(outDir(fx)), { recursive: true });
    writeFileSync(join(outDir(fx), "main.js"), "earlier record\n");
    const nonEmpty = await run(fx, "record", { terminal: typing(phrase()) });
    expect(nonEmpty.code).toBe(2);
    expect(nonEmpty.stderr).toMatch(/not empty/);
    expect(readFileSync(join(outDir(fx), "main.js"), "utf8")).toBe("earlier record\n");
    rmSync(outDir(fx), { recursive: true });
    mkdirSync(join(fx.root, ".git", "refs", "tags"), { recursive: true });
    writeFileSync(join(fx.root, ".git", "refs", "tags", "v0.3.0"), "0123456789abcdef0123456789abcdef01234567\n");
    const tagged = await run(fx, "record", { terminal: typing(phrase()) });
    expect(tagged.code).toBe(2);
    expect(tagged.stderr).toContain("Tag v0.3.0 already exists");
  });
});

describe("record: the typed acknowledgement for an unsigned (git-history) review record", () => {
  it("exits 2 with a pipe on standard input and writes nothing", async () => {
    const fx = fresh();
    const piped = createFakeTerminal({ inputIsTty: false, outputIsTty: false, answers: [`${phrase()}\n`] });
    const result = await run(fx, "record", { terminal: piped });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/terminal/i);
    expect(piped.remaining()).toBe(1);
    expect(existsSync(join(fx.root, "dist", "release"))).toBe(false);
    expect((await run(fx, "record")).code).toBe(2);
  });

  it.each<[string, string]>([
    ["a truncated phrase", "I accept an unsigned review record"],
    ["another tree's phrase", "I accept an unsigned review record for 00000000"],
    ["the phrase with a trailing space", `${phrase()} `],
    ["the phrase in lower case", phrase().toLowerCase()],
  ])("exits 2 on %s and writes nothing", async (_name, typed) => {
    const fx = fresh();
    const terminal = typing(typed);
    const result = await run(fx, "record", { terminal });
    expect(result.code).toBe(2);
    expect(existsSync(join(fx.root, "dist", "release"))).toBe(false);
    expect(terminal.listeners()).toBe(0);
  });

  it("exits 2 when the terminal input ends before the phrase", async () => {
    const fx = fresh();
    const terminal = createFakeTerminal({ answers: [] });
    const pending = run(fx, "record", { terminal });
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    terminal.close();
    expect((await pending).code).toBe(2);
    expect(existsSync(join(fx.root, "dist", "release"))).toBe(false);
  });

  it("prints T8, the commit E and the number of commits before asking, and records on the exact phrase", async () => {
    const fx = fresh();
    const terminal = typing(phrase());
    const result = await run(fx, "record", { terminal });
    expect(result.code).toBe(0);
    const prompt = terminal.written.join("");
    expect(prompt).toContain(T8);
    expect(prompt).toContain(REVIEWED_COMMIT);
    expect(prompt).toMatch(/commits that touched the review record: 2/);
    expect(prompt).toContain(phrase());
    expect(terminal.listeners()).toBe(0);
    const evidence = JSON.parse(readFileSync(join(outDir(fx), "evidence.json"), "utf8"));
    expect(evidence.acknowledgement).toMatchObject({ typed: true, phrase: phrase(), t8: T8 });
  });

  it("needs no terminal and asks nothing for a signature-form record", async () => {
    const fx = fresh({ form: "signature" });
    const result = await run(fx, "record");
    expect(result.code).toBe(0);
    const evidence = JSON.parse(readFileSync(join(outDir(fx), "evidence.json"), "utf8"));
    expect(evidence.acknowledgement).toBeNull();
    expect(evidence.reviewRecord).toMatchObject({ form: "signature", signerFingerprint: SIGNER_FINGERPRINT });
  });
});

describe("record: what it writes", () => {
  it("copies the verified bytes, edits nothing outside dist/release/, and its checksums reproduce", async () => {
    const fx = fresh({ styles: true });
    const before = snapshot(fx.root);
    const result = await run(fx, "record", { terminal: typing(phrase()) });
    expect(result.code).toBe(0);
    expect(snapshot(fx.root)).toEqual(before);
    expect(readdirSync(outDir(fx)).sort()).toEqual(["SHA256SUMS", "evidence.json", "ipfs-sync-cli-0.3.0.tgz", "main.js", "manifest.json", "release-notes.md", "styles.css"]);
    const built = fx.doc().build.files as Record<string, string>;
    expect(sha256(readFileSync(join(outDir(fx), "main.js")))).toBe(built["dist/plugin/main.js"]);
    expect(sha256(readFileSync(join(outDir(fx), "manifest.json")))).toBe(built["dist/plugin/manifest.json"]);
    expect(sha256(readFileSync(join(outDir(fx), "styles.css")))).toBe(built["dist/plugin/styles.css"]);
    const sums = readFileSync(join(outDir(fx), "SHA256SUMS"), "utf8").trim().split("\n");
    expect(sums).toHaveLength(4);
    for (const line of sums) {
      const [sum, name] = line.split("  ");
      expect(sha256(readFileSync(join(outDir(fx), name as string))), name).toBe(sum);
    }
    expect(result.stdout).toMatch(/local only, not published; publication receipt not produced/);
  });

  it("gives the same checksums for a scratch copy of the project", async () => {
    const original = fresh();
    const copyRoot = `${original.root}-copy`;
    cpSync(original.root, copyRoot, { recursive: true });
    const copy = { ...original, root: copyRoot };
    fixtures.push(copy);
    expect((await run(original, "record", { terminal: typing(phrase()) })).code).toBe(0);
    expect((await run(copy, "record", { terminal: typing(phrase()) })).code).toBe(0);
    for (const name of ["SHA256SUMS", "ipfs-sync-cli-0.3.0.tgz", "main.js", "manifest.json"]) {
      expect(readFileSync(join(outDir(copy), name)).equals(readFileSync(join(outDir(original), name))), name).toBe(true);
    }
  });

  it("opens the notes with the can and cannot paragraph and carries the required lines", async () => {
    const fx = fresh({ unread: ["src/a.ts", "src/b.ts", "cli/c.ts"] });
    expect((await run(fx, "record", { terminal: typing(phrase()) })).code).toBe(0);
    const notes = readFileSync(join(outDir(fx), "release-notes.md"), "utf8");
    const first = notes.split("\n\n")[0] as string;
    for (const text of [
      "publish and pull encrypted vaults",
      "including real notes",
      "keep a local edit as a dated copy on conflict",
      "refuse tampered or older states on a device that has a recorded state",
      "change the passphrase and raise the cost",
      "prune history",
      "hide file count, exact sizes, publish timing or access patterns",
      "stop a node from showing a device with no recorded state an old copy",
      "take back an old passphrase or old key-slot copy after a change",
      "recover a lost passphrase",
      "detect silent corruption of unchanged files by someone who can write to the node",
      "prevent overlapping publishes",
      "remove deleted notes from old pinned roots",
      "sync Obsidian configuration or plugins",
      "keep `.ipfs-sync/`, including temporary files, encrypted at rest",
      "claim mobile support",
      "claim Android support",
    ]) {
      expect(first, text).toContain(text);
    }
    expect(notes).toMatch(/every vault write now creates directories with mode 0700 and files with 0600/i);
    expect(notes).toContain(".<name>.<pid>.<uuid>.tmp");
    expect(notes).toMatch(/review record is unsigned/i);
    expect(notes).toContain(REVIEWED_COMMIT);
    expect(notes).toMatch(/2 commits/);
    expect(notes).toMatch(/3 files? (the review record declares|declared) unread/i);
    expect(notes).toContain("v24.16.0");
    expect(notes).toContain("12.8.1");
    expect(notes).toContain("are attestations, not proofs");
    expect(notes).toContain("Obsidian 1.12.3");
    expect(notes).toMatch(/pre-release/);
    expect(notes).toContain(`${sha256(readFileSync(join(outDir(fx), "main.js")))}  main.js`);
    expect(notes).not.toMatch(/fixture-only|0\.2\.0/);
  });

  it("states a signature record by its fingerprint and not as unsigned", async () => {
    const fx = fresh({ form: "signature" });
    expect((await run(fx, "record")).code).toBe(0);
    const notes = readFileSync(join(outDir(fx), "release-notes.md"), "utf8");
    expect(notes).toContain(SIGNER_FINGERPRINT);
    expect(notes).not.toMatch(/review record is unsigned/i);
  });

  it.each<[string, Release2Options["timing"]]>([
    ["an acceptance", "acceptance"],
    ["a signed statement", "signed"],
  ])("lists the phone timing as unverified when item C is %s", async (_name, timing) => {
    const fx = fresh({ timing, form: "signature" });
    expect((await run(fx, "record")).code).toBe(0);
    const notes = readFileSync(join(outDir(fx), "release-notes.md"), "utf8");
    const notVerified = notes.split("## Not verified")[1]?.split("\n## ")[0] ?? "";
    expect(notVerified).toMatch(/phone key-derivation timing/i);
    expect(notes).not.toMatch(/timing (was )?measured/i);
    const evidence = JSON.parse(readFileSync(join(outDir(fx), "evidence.json"), "utf8"));
    expect(evidence.claims.find((claim: Json) => /phone/i.test(claim.claim))).toMatchObject({ status: "unverified" });
  });

  it("states a measured phone timing with its device, and still does not claim mobile support", async () => {
    const fx = fresh({ timing: "measured", form: "signature" });
    expect((await run(fx, "record")).code).toBe(0);
    const notes = readFileSync(join(outDir(fx), "release-notes.md"), "utf8");
    expect(notes).toContain("iPhone 15");
    expect(notes).toContain("1.14");
    const notVerified = notes.split("## Not verified")[1]?.split("\n## ")[0] ?? "";
    expect(notVerified).not.toMatch(/phone key-derivation timing/i);
    expect(notVerified).toMatch(/mobile/i);
  });

  it("writes evidence.json with the record hashes, the checker output hash, the documents and the tool versions", async () => {
    const fx = fresh();
    expect((await run(fx, "record", { terminal: typing(phrase()) })).code).toBe(0);
    const evidence = JSON.parse(readFileSync(join(outDir(fx), "evidence.json"), "utf8"));
    expect(evidence).toMatchObject({ version: "0.3.0", tag: "v0.3.0", repository: "Prometheus-AGS/obsidian-ipfs-sync" });
    expect(evidence.checker).toMatchObject({ pass: true, exitCode: 0, treeSha256: TREE_SHA, t8: T8, buildSha256: BUILD_SHA, outputSha256: sha256(fx.checker.result.stdout) });
    expect(evidence.reviewRecord).toMatchObject({ form: "git-history", commit: REVIEWED_COMMIT, commitCount: 2, sha256: sha256(readFileSync(fx.recordPath)), unreadCount: 0 });
    expect(evidence.operatorRecord).toMatchObject({ path: fx.operatorPath, sha256: sha256(readFileSync(fx.operatorPath)), transcriptSha256: sha256(readFileSync(fx.transcriptPath)) });
    expect(evidence.timingRecord).toMatchObject({ path: fx.timingPath, form: "acceptance", timingMeasured: false, sha256: sha256(readFileSync(fx.timingPath)) });
    expect(evidence.documents).toEqual({ "README.md": sha256("readme"), "DESIGN.md": sha256("design") });
    expect(evidence.toolVersions).toMatchObject({ checkerNode: "v24.16.0", checkerPnpm: "12.8.1" });
    expect(typeof evidence.toolVersions.releaseToolNode).toBe("string");
    expect(evidence.attestation).toContain("attestations, not proofs");
    expect(evidence.publication).toMatchObject({ status: "pending", receipt: null });
    expect(evidence.claims.find((claim: Json) => /published/i.test(claim.claim))).toMatchObject({ status: "unverified" });
  });
});

describe("the descriptor and the command line", () => {
  it("holds Release 2's values and builds no notes of Release 1", () => {
    const d = descriptors.makeRelease2(null);
    expect(d).toMatchObject({
      version: "0.3.0",
      tag: "v0.3.0",
      cliTarball: "ipfs-sync-cli-0.3.0.tgz",
      outDir: "dist/release/v0.3.0",
      featureOpFile: "feature-op-mvp-07.json",
      prerelease: true,
      requiresFixtureStatement: false,
      record: { bumpVersions: false, build: false },
    });
    expect(descriptors.RELEASE_2).toMatchObject({ version: "0.3.0", tag: "v0.3.0" });
    expect(d.buildNotes({ descriptor: d, sums: [], unverified: [] }).split("\n\n")[0]).toContain("can: publish and pull encrypted vaults");
  });

  it("summarises only a passing document", () => {
    const fx = fresh();
    expect(release2.summarizeGuard(fx.doc())).toMatchObject({ t8: T8, itemA: { form: "git-history", commit: REVIEWED_COMMIT, commitCount: 2 }, itemC: { timingMeasured: false } });
    expect(() => release2.summarizeGuard({ schema: 1, pass: false, complete: false })).toThrow();
  });

  it.each([["--force"], ["--skip-checker"], ["--no-check"], ["record", "--check"]])("refuses the option set %s with exit 2", (...args) => {
    const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", cwd: ROOT });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage|unknown|applies to plan/i);
  });

  it("lists no option that skips, weakens or forces the checker", () => {
    const result = spawnSync(process.execPath, [TOOL, "--help"], { encoding: "utf8", cwd: ROOT });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("usage: node tools/release-mvp-07.mjs");
    expect(result.stdout).not.toMatch(/--(force|skip|no-check|no-tests|weak|ignore|override)/);
  });

  it("never spawns git or gh and spawns only the checker", () => {
    const source = readFileSync(TOOL, "utf8");
    expect(source).not.toMatch(/["'`](git|gh)["'`]/);
    expect(source.match(/spawnSync\(/g)?.length ?? 0).toBe(1);
    expect(source).toMatch(/spawnSync\(process\.execPath/);
    expect(source).not.toMatch(/\b(exec|execFile|execSync|spawn)\(/);
  });
});
