import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasExpect } from "../helpers/expect-smoke.ts";
import { createFakeTerminal } from "../helpers/fake-terminal.ts";
import { REPO_ROOT, captureIo, createRepo, removeRepos, tempDir } from "../helpers/guard-repo.ts";
import { MAIN_JS_PATH, NOW, loadPhoneChecker, type PhoneChecker } from "../helpers/guard-phone.ts";
import { isolatedEnvironment, makeSigningKey, okTree, reviewFixture, sha256, signWith, writeTrust, type OkTree } from "../helpers/guard-review.ts";

// mvp-07b task 4.5: tools/record-phone-timing.mjs. The terminal is the fake of tests/helpers/fake-terminal.ts; every per-user
// directory is a temporary HOME; the repository is the small git fixture of the checker tests. What the recorder writes must
// pass the checker's own item C (round trip), so every expectation about a record is the checker's verdict.

const RECORDER_PATH = join(REPO_ROOT, "tools/record-phone-timing.mjs");
const NONCE = "0a1b2c3d4e5f";
const MAIN_BYTES = "plugin main.js bytes for the recorder tests";
const MAIN_SHA = sha256(MAIN_BYTES);
const PREFIX = MAIN_SHA.slice(0, 16);

interface RecorderContext {
  root: string;
  environment: Record<string, string | undefined>;
  terminal: ReturnType<typeof createFakeTerminal>;
  out: (text: string) => void;
  err: (text: string) => void;
  now: number;
  nonce: () => string;
}
interface Recorder {
  readonly runRecorder: (argv: readonly string[], context: RecorderContext) => Promise<number>;
}

let checker: PhoneChecker;
let recorder: Recorder;
let root: string;
let tree: OkTree;

beforeAll(async () => {
  checker = await loadPhoneChecker();
  recorder = (await import(pathToFileURL(RECORDER_PATH).href)) as Recorder;
  root = reviewFixture();
  tree = okTree(checker, root);
});
afterAll(removeRepos);

/** dist/plugin/main.js and dist/.guard-build.json the way `--build` leaves them for `tree`. */
function installDist(options: { main?: string; state?: Record<string, unknown> | null } = {}): void {
  mkdirSync(join(root, "dist/plugin"), { recursive: true });
  writeFileSync(join(root, MAIN_JS_PATH), options.main ?? MAIN_BYTES);
  const state = { schema: 1, commit: tree.commit, treeSha256: tree.treeSha256, t8: tree.t8, buildSha256: "b".repeat(64), files: { [MAIN_JS_PATH]: MAIN_SHA }, node: "v24", pnpm: "12" };
  if (options.state === null) return void writeFileSync(join(root, "dist/.guard-build.json"), "");
  writeFileSync(join(root, "dist/.guard-build.json"), `${JSON.stringify({ ...state, ...options.state })}\n`);
}

interface Session {
  readonly env: Record<string, string | undefined>;
  readonly code: number;
  readonly written: string;
  readonly err: string;
  readonly terminal: ReturnType<typeof createFakeTerminal>;
}

async function record(argv: readonly string[], answers: readonly string[], options: { env?: Record<string, string | undefined>; inputIsTty?: boolean; outputIsTty?: boolean } = {}): Promise<Session> {
  const env = options.env ?? isolatedEnvironment().env;
  const terminal = createFakeTerminal({ answers, ...(options.inputIsTty === undefined ? {} : { inputIsTty: options.inputIsTty }), ...(options.outputIsTty === undefined ? {} : { outputIsTty: options.outputIsTty }) });
  const io = captureIo();
  const code = await recorder.runRecorder(argv, { root, environment: env, terminal, nonce: () => NONCE, now: NOW, ...io.io });
  return { env, code, written: terminal.written.join("") + io.out(), err: io.err(), terminal };
}

const measuredAnswers = (change: Partial<Record<"device" | "os" | "seconds" | "gap" | "completed" | "hash" | "nonce", string>> = {}): string[] => {
  const all = { device: "iPhone", os: "iOS 26.0", seconds: "1.14", gap: "21 ms", completed: "yes", hash: PREFIX.replace(/(.{4})(?=.)/g, "$1 "), nonce: NONCE, ...change };
  return [all.device, all.os, all.seconds, all.gap, all.completed, all.hash, all.nonce].map((line) => `${line}\n`);
};

const folderOf = (env: Record<string, string | undefined>): string => join(checker.perUserStateDir(env), "feature-ops");
const recordOf = (env: Record<string, string | undefined>): string => join(folderOf(env), checker.PHONE_TIMING_RECORD_FILE);
const modeOf = (path: string): number => statSync(path).mode & 0o777;
const verdict = (env: Record<string, string | undefined>) => checker.checkPhoneTiming({ root, tree, buildFiles: { [MAIN_JS_PATH]: MAIN_SHA }, environment: env, now: NOW });
const nothingWritten = (env: Record<string, string | undefined>): boolean => !existsSync(checker.perUserStateDir(env));

describe("measured record", () => {
  it("writes a record the checker passes, with longestGapMs, the full local hash, 0700 and 0600", async () => {
    installDist();
    const s = await record(["measured"], measuredAnswers());
    expect(s.code, s.err).toBe(0);
    const written = JSON.parse(readFileSync(recordOf(s.env), "utf8")) as Record<string, unknown>;
    expect(written).toMatchObject({
      schema: 1,
      kind: "measured",
      completed: true,
      parameters: checker.PHONE_TIMING_PARAMETERS,
      seconds: 1.14,
      longestGapMs: 21,
      device: "iPhone",
      os: "iOS 26.0",
      nonceVerified: true,
      pluginMainJsSha256: MAIN_SHA,
    });
    expect(new Date(written["finishedAt"] as string).getTime()).toBe(NOW);
    expect(modeOf(folderOf(s.env))).toBe(0o700);
    expect(modeOf(recordOf(s.env))).toBe(0o600);
    expect(readdirSync(folderOf(s.env))).toEqual([checker.PHONE_TIMING_RECORD_FILE]);
    const result = verdict(s.env);
    expect(result.failures).toEqual([]);
    expect(result.form).toBe("measured");
    expect(result.evidence.timingMeasured).toBe(true);
    expect(s.terminal.listeners()).toBe(0);
    expect(s.terminal.flowing()).toBe(false);
  });

  it("prints a nonce, and never prints the local hash prefix the operator has to read off the phone", async () => {
    installDist();
    const s = await record(["measured"], measuredAnswers());
    expect(s.written).toContain(NONCE);
    expect(s.written).not.toContain(PREFIX);
    expect(s.written).not.toContain(MAIN_SHA);
  });

  it("takes the prefix in capitals and with the spaces the phone shows", async () => {
    installDist();
    const s = await record(["measured"], measuredAnswers({ hash: PREFIX.toUpperCase().replace(/(.{4})(?=.)/g, "$1  ") }));
    expect(s.code, s.err).toBe(0);
    expect(verdict(s.env).ok).toBe(true);
  });

  it("writes nothing when the retyped nonce is wrong", async () => {
    installDist();
    const s = await record(["measured"], measuredAnswers({ nonce: "ffffffffffff" }));
    expect(s.code).toBe(1);
    expect(nothingWritten(s.env)).toBe(true);
  });

  it("writes nothing when the typed prefix is not the start of the local main.js hash, and does not reveal the right one", async () => {
    installDist();
    const wrong = `${PREFIX.slice(0, 15)}${PREFIX.endsWith("0") ? "1" : "0"}`;
    const s = await record(["measured"], measuredAnswers({ hash: wrong }));
    expect(s.code).toBe(1);
    expect(nothingWritten(s.env)).toBe(true);
    expect(s.err).toContain("dist/plugin/main.js");
    expect(s.err + s.written).not.toContain(PREFIX);
  });

  it.each([
    ["completed: no", { completed: "no" }, "completed"],
    ["completed neither yes nor no", { completed: "maybe" }, "completed"],
    ["seconds at the bound", { seconds: "3" }, "seconds"],
    ["seconds of zero", { seconds: "0" }, "seconds"],
    ["seconds not a plain decimal", { seconds: "1e0" }, "seconds"],
    ["a gap at the bound", { gap: "100" }, "gap"],
    ["no gap measured", { gap: "not measured" }, "gap"],
    ["a device with a control character", { device: "iPhone\u001b[2J" }, "device"],
    ["a device with a bidi override", { device: "iPhone\u202e" }, "device"],
    ["an empty OS", { os: "" }, "OS"],
  ] as const)("refuses %s and writes nothing", async (_name, change, word) => {
    installDist();
    const s = await record(["measured"], measuredAnswers(change));
    expect(s.code).toBe(1);
    expect(s.err).toContain(word);
    expect(nothingWritten(s.env)).toBe(true);
  });

  it("writes nothing when the terminal input ends before the nonce is retyped", async () => {
    installDist();
    const env = isolatedEnvironment().env;
    const terminal = createFakeTerminal({ answers: measuredAnswers().slice(0, 4) });
    const io = captureIo();
    const pending = recorder.runRecorder(["measured"], { root, environment: env, terminal, nonce: () => NONCE, now: NOW, ...io.io });
    await new Promise((resolve) => setTimeout(resolve, 20));
    terminal.close();
    expect(await pending).toBe(1);
    expect(nothingWritten(env)).toBe(true);
    expect(terminal.listeners()).toBe(0);
  });

  it("replaces an earlier record in place, leaving no temporary file", async () => {
    installDist();
    const first = await record(["measured"], measuredAnswers({ seconds: "2.5" }));
    expect(first.code).toBe(0);
    const second = await record(["measured"], measuredAnswers({ seconds: "1.2" }), { env: first.env });
    expect(second.code, second.err).toBe(0);
    expect((JSON.parse(readFileSync(recordOf(first.env), "utf8")) as { seconds: number }).seconds).toBe(1.2);
    expect(readdirSync(folderOf(first.env))).toEqual([checker.PHONE_TIMING_RECORD_FILE]);
  });
});

describe("refusals before anything is typed", () => {
  it.each([
    ["input is not a terminal", { inputIsTty: false }],
    ["output is not a terminal", { outputIsTty: false }],
  ] as const)("exits 2 and writes nothing when %s, without reading an answer", async (_name, options) => {
    installDist();
    const s = await record(["measured"], measuredAnswers(), options);
    expect(s.code).toBe(2);
    expect(nothingWritten(s.env)).toBe(true);
    expect(s.terminal.remaining()).toBe(7);
    expect(s.err).toContain("terminal");
  });

  it("exits 2 for an unknown or missing kind, and for extra arguments", async () => {
    installDist();
    for (const argv of [[], ["bogus"], ["measured", "extra"]]) {
      const s = await record(argv, measuredAnswers());
      expect(s.code).toBe(2);
      expect(s.err).toContain("usage");
      expect(nothingWritten(s.env)).toBe(true);
    }
  });

  const staleCases: ReadonlyArray<readonly [string, () => void]> = [
    ["main.js changed after the build", () => installDist({ main: "another build" })],
    ["the state file records another tree", () => installDist({ state: { treeSha256: "e".repeat(64) } })],
    ["the state file records another main.js hash", () => installDist({ state: { files: { [MAIN_JS_PATH]: "d".repeat(64) } } })],
    ["the state file is empty", () => installDist({ state: null })],
    ["the state file is not JSON", () => writeFileSync(join(root, "dist/.guard-build.json"), "{")],
  ];
  it.each(staleCases)("exits 2 and writes nothing when dist/ is stale: %s", async (_name, arrange) => {
    installDist();
    arrange();
    const s = await record(["measured"], measuredAnswers());
    expect(s.code).toBe(2);
    expect(s.err).toContain("--build");
    expect(nothingWritten(s.env)).toBe(true);
    expect(s.terminal.remaining()).toBe(7);
  });

  it("exits 2 when the feature-ops folder is group-readable, and writes nothing into it", async () => {
    installDist();
    const env = isolatedEnvironment().env;
    mkdirSync(folderOf(env), { recursive: true, mode: 0o755 });
    chmodSync(folderOf(env), 0o755);
    const s = await record(["measured"], measuredAnswers(), { env });
    expect(s.code).toBe(2);
    expect(readdirSync(folderOf(env))).toEqual([]);
  });

  it("exits 2 when the record path is a symbolic link, and leaves the link target alone", async () => {
    installDist();
    const env = isolatedEnvironment().env;
    mkdirSync(folderOf(env), { recursive: true, mode: 0o700 });
    chmodSync(folderOf(env), 0o700);
    const target = join(tempDir("phone-link-"), "elsewhere.json");
    writeFileSync(target, "untouched");
    symlinkSync(target, recordOf(env));
    const s = await record(["measured"], measuredAnswers(), { env });
    expect(s.code).toBe(2);
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(lstatSync(recordOf(env)).isSymbolicLink()).toBe(true);
  });
});

describe("acceptance", () => {
  const answers = (phrase: string = checker.PHONE_ACCEPTANCE_PHRASE, nonce = NONCE): string[] => [`${phrase}\n`, `${nonce}\n`];

  it("needs the phrase and the nonce, records T and the full hash, and the checker passes it as unverified", async () => {
    installDist();
    const s = await record(["acceptance"], answers());
    expect(s.code, s.err).toBe(0);
    const written = JSON.parse(readFileSync(recordOf(s.env), "utf8")) as Record<string, unknown>;
    expect(written).toMatchObject({ schema: 1, kind: "acceptance", nonceVerified: true, phrase: checker.PHONE_ACCEPTANCE_PHRASE, treeSha256: tree.treeSha256, pluginMainJsSha256: MAIN_SHA });
    expect(typeof written["statement"]).toBe("string");
    expect(new Date(written["acceptedAt"] as string).getTime()).toBe(NOW);
    expect(modeOf(recordOf(s.env))).toBe(0o600);
    const result = verdict(s.env);
    expect(result.failures).toEqual([]);
    expect(result.form).toBe("acceptance");
    expect(result.evidence.timingMeasured).toBe(false);
    expect(s.written).toContain(tree.t8);
    expect(s.written).toContain("unverified");
  });

  it("writes nothing for a wrong phrase or a wrong nonce", async () => {
    installDist();
    const wrongPhrase = await record(["acceptance"], answers("I accept"));
    expect(wrongPhrase.code).toBe(1);
    expect(nothingWritten(wrongPhrase.env)).toBe(true);
    const wrongNonce = await record(["acceptance"], answers(undefined, "000000000000"));
    expect(wrongNonce.code).toBe(1);
    expect(nothingWritten(wrongNonce.env)).toBe(true);
  });
});

describe("signed statement", () => {
  it("writes the statement, then after signing fixes the signature mode and the checker passes the signed form", async () => {
    installDist();
    const { env } = isolatedEnvironment();
    const key = makeSigningKey();
    writeTrust(checker, env, key);
    const first = await record(["statement"], [`${NONCE}\n`], { env });
    expect(first.code, first.err).toBe(0);
    const statementPath = join(folderOf(env), checker.PHONE_TIMING_STATEMENT_FILE);
    expect(modeOf(statementPath)).toBe(0o600);
    const text = readFileSync(statementPath, "utf8");
    expect(text).toContain(tree.t8);
    expect(text).toContain(PREFIX);
    expect(first.written).toContain("ssh-keygen -Y sign -n ipfs-sync-review");
    expect(verdict(env).ok).toBe(false);

    signWith(key, statementPath);
    chmodSync(`${statementPath}.sig`, 0o644);
    expect(verdict(env).ok).toBe(false);
    const second = await record(["statement"], [`${NONCE}\n`], { env });
    expect(second.code, second.err).toBe(0);
    expect(modeOf(`${statementPath}.sig`)).toBe(0o600);
    const result = verdict(env);
    expect(result.failures).toEqual([]);
    expect(result.form).toBe("signed");
  });
});

describe("source discipline and the real entry point", () => {
  it("imports the checker's file names, phrase and thresholds instead of declaring them, and uses no clipboard", () => {
    const source = readFileSync(RECORDER_PATH, "utf8");
    for (const literal of ["phone-timing.json", "phone-timing-statement.txt", "m=65536", "I accept the phone timing"]) expect(source).not.toContain(literal);
    for (const name of ["PHONE_TIMING_RECORD_FILE", "PHONE_TIMING_STATEMENT_FILE", "PHONE_TIMING_PARAMETERS", "PHONE_TIMING_MAX_SECONDS", "PHONE_TIMING_MAX_GAP_MS", "PHONE_ACCEPTANCE_PHRASE", "perUserStateDir"]) {
      expect(source).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\./check-guard-preconditions\\.mjs"`, "s"));
    }
    expect(source).not.toMatch(/pbcopy|pbpaste|clipboard|xclip|child_process/i);
  });

  it("exits 2 and writes nothing when run with piped standard input and output (no pseudo-terminal)", () => {
    const { env } = isolatedEnvironment();
    const run = spawnSync(process.execPath, [RECORDER_PATH, "measured"], { env: { ...env, PATH: process.env.PATH ?? "" } as Record<string, string>, input: "x\n", encoding: "utf8", timeout: 60_000 });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("terminal");
    expect(nothingWritten(env)).toBe(true);
  });

  // spawnSync blocks the event loop, so vitest's own timeout cannot fire during it: every wait below is bounded inside expect(1)
  // (which then exits, closing the pty and ending the recorder) and by a spawnSync timeout that stays under vitest's 20 s.
  const EXPECT_BOUND_SECONDS = 8;
  const EXPECT_EXIT_PROMPTING = 3;
  const SPAWN_BOUND_MS = 15_000;
  const ptyScript = (): string => {
    const script = join(tempDir("phone-expect-"), "run.exp");
    writeFileSync(
      script,
      `set timeout ${EXPECT_BOUND_SECONDS}\nspawn -noecho {*}$argv\nexpect {\n  eof {}\n  timeout { exit ${EXPECT_EXIT_PROMPTING} }\n}\ncatch wait result\nexit [lindex $result 3]\n`,
    );
    return script;
  };
  const underPty = (toolPath: string, env: Record<string, string | undefined>): SpawnSyncReturns<string> =>
    spawnSync("expect", [ptyScript(), process.execPath, toolPath, "measured"], { env: { ...env, PATH: process.env.PATH ?? "" } as Record<string, string>, encoding: "utf8", timeout: SPAWN_BOUND_MS, killSignal: "SIGKILL" });

  it.skipIf(!hasExpect)("under a real pseudo-terminal it passes the terminal gate and stops at a stale dist (expect(1) smoke test, independent of the repository's dist/)", () => {
    const { env } = isolatedEnvironment();
    // A git fixture holding a copy of the tool and no dist/: the recorder's root is the fixture, so the stale-dist refusal is deterministic.
    const files: Record<string, string> = { "esbuild.options.mjs": readFileSync(join(REPO_ROOT, "esbuild.options.mjs"), "utf8") };
    for (const name of ["record-phone-timing.mjs", "check-guard-preconditions.mjs", "hook-isolation.mjs"]) files[`tools/${name}`] = readFileSync(join(REPO_ROOT, "tools", name), "utf8");
    const copy = createRepo(files);
    symlinkSync(join(REPO_ROOT, "node_modules"), join(copy, "node_modules"), "dir");
    const run = underPty(join(copy, "tools/record-phone-timing.mjs"), env);
    expect(run.status).toBe(2);
    expect(run.stdout).toContain("--build");
    expect(run.stdout).not.toContain("needs a terminal");
    expect(nothingWritten(env)).toBe(true);
  });

  it.skipIf(!hasExpect)("under a real pseudo-terminal the repository's own tool passes the terminal gate whether dist/ is stale or current, and never hangs", () => {
    const { env } = isolatedEnvironment();
    const run = underPty(RECORDER_PATH, env);
    // Stale dist: exit 2 with --build. Current dist (the state right after `--build`): the recorder waits for its first answer, so expect(1) ends the wait.
    expect([2, EXPECT_EXIT_PROMPTING]).toContain(run.status);
    if (run.status === 2) expect(run.stdout).toContain("--build");
    expect(run.stdout).not.toContain("needs a terminal");
    expect(nothingWritten(env)).toBe(true);
  });
});
