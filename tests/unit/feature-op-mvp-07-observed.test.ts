import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeTerminal, type FakeTerminal } from "../helpers/fake-terminal.ts";

/**
 * mvp-07b task 4.7a: the scripted side of the steps the operator performs in real Obsidian (install check and the first-pull
 * confirmation). Fake terminals only: no Obsidian, no node, no shared node. Timers are real but at most tens of milliseconds.
 */
interface Entry {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}
interface Operator {
  readonly terminal: FakeTerminal;
  readonly nonce: () => string;
  readonly windowMs: number;
  readonly readyWaitMs: number;
}
interface Observed {
  observedStepsPhase(state: Record<string, unknown>, deps?: { runMachine(state: Record<string, unknown>): Promise<Entry[]> }): Promise<Entry[]>;
  assertOperatorTerminal(terminal: { input: { isTTY?: boolean }; output: { isTTY?: boolean } } | undefined): void;
  randomNonce(): string;
  readLine(terminal: FakeTerminal, label: string, options: { timeoutMs: number }): Promise<{ ok: boolean; line?: string; reason?: string }>;
}

const ROOT = resolve(__dirname, "..", "..");
const NONCE = "abc234";
const OBSERVED_IDS = ["ciphertext-only-on-node", "plaintext-restored-byte-equal", "wrong-passphrase-refused", "first-pull-confirm-shown", "sequence-recorded", "pull-no-node-mutation", "conflict-copy-kept", "multi-segment-blob-pulled-in-plugin"];
const temporary: string[] = [];
const temp = (): string => {
  const path = mkdtempSync(join(tmpdir(), "fop07-obs-"));
  temporary.push(path);
  return path;
};

let observed: Observed;
beforeAll(async () => {
  observed = (await import(/* @vite-ignore */ pathToFileURL(join(ROOT, "tools", "feature-op-mvp-07", "observed-phase.mjs")).href)) as Observed;
});
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function state(answers: readonly string[], extra: Partial<Operator> = {}, opts: Record<string, unknown> = {}) {
  const terminal = createFakeTerminal({ answers });
  const lines: string[] = [];
  const operator: Operator = { terminal, nonce: () => NONCE, windowMs: 500, readyWaitMs: 30, ...extra };
  return { terminal, lines, S: { opts: { phases: "all", verifyOnly: false, ...opts }, t: { out: (line = "") => void lines.push(line) }, vaultsRoot: "/tmp/not-used/vaults", operator } };
}
const entry = (entries: readonly Entry[], id: string): Entry => entries.find((candidate) => candidate.id === id) as Entry;
/** The machine steps are replaced by results that pass: these tests are about the prompts (the machine steps have their own test file). */
const machineResults = async (): Promise<Entry[]> => OBSERVED_IDS.filter((id) => id !== "first-pull-confirm-shown").map((id) => ({ id, passed: true, detail: "machine ok" }));
const phase = (S: Record<string, unknown>, runMachine = machineResults): Promise<Entry[]> => observed.observedStepsPhase(S, { runMachine });
const FULL = ["ready\n", `${NONCE} installed\n`, "ready\n", `${NONCE} shown\n`, "ready\n", `${NONCE} range-honoured\n`];

describe("the operator-observed prompts", () => {
  it("passes first-pull-confirm-shown only when ready, the install check and the first-pull answer all carry the printed nonce", async () => {
    const { S, terminal, lines } = state(FULL);
    const entries = await phase(S);
    expect(entry(entries, "first-pull-confirm-shown").passed).toBe(true);
    expect(entry(entries, "first-pull-confirm-shown").detail).toContain(NONCE);
    expect(terminal.remaining()).toBe(0);
    expect(lines.join("\n")).toMatch(/countdown started/i);
    expect(terminal.rawModes).toEqual([]);
    expect(terminal.listeners()).toBe(0);
    expect(terminal.flowing()).toBe(false);
  });

  it("returns one result per id of its phase; a machine result that fails stays failed whatever the operator typed", async () => {
    const { S } = state(FULL);
    const failing = async (): Promise<Entry[]> => (await machineResults()).map((result) => (result.id === "conflict-copy-kept" ? { ...result, passed: false, detail: "machine said no" } : result));
    const entries = await phase(S, failing);
    expect(entries.map(({ id }) => id).sort()).toEqual([...OBSERVED_IDS].sort());
    expect(entry(entries, "conflict-copy-kept")).toMatchObject({ passed: false, detail: "machine said no" });
    expect(entry(entries, "first-pull-confirm-shown").passed).toBe(true);
  });

  it("a machine step that records nothing for an id fails that id", async () => {
    const { S } = state(FULL);
    const entries = await phase(S, async () => []);
    expect(entry(entries, "sequence-recorded")).toMatchObject({ passed: false });
    expect(entry(entries, "sequence-recorded").detail).toMatch(/no machine step/);
  });

  it("the large-blob assertion needs the machine result AND the operator's range-honoured or range-ignored-refused, bound to a nonce", async () => {
    const blob = "multi-segment-blob-pulled-in-plugin";
    for (const outcome of ["range-honoured", "range-ignored-refused"]) {
      const entries = await phase(state(["ready\n", `${NONCE} installed\n`, "ready\n", `${NONCE} shown\n`, "ready\n", `${NONCE} ${outcome}\n`]).S);
      expect(entry(entries, blob).passed, outcome).toBe(true);
      expect(entry(entries, blob).detail).toContain(outcome);
    }
    for (const typed of [`${NONCE} failed\n`, "zzz999 range-honoured\n", `${NONCE} range-honoured-ish\n`]) {
      const entries = await phase(state(["ready\n", `${NONCE} installed\n`, "ready\n", `${NONCE} shown\n`, "ready\n", typed]).S);
      expect(entry(entries, blob).passed, typed).toBe(false);
    }
    const noAnswer = await phase(state(["ready\n", `${NONCE} installed\n`, "ready\n", `${NONCE} shown\n`]).S);
    expect(entry(noAnswer, blob).passed).toBe(false);
    const machineFailed = await phase(state(FULL).S, async () => (await machineResults()).map((result) => (result.id === blob ? { ...result, passed: false, detail: "bytes differ" } : result)));
    expect(entry(machineFailed, blob).passed).toBe(false);
  });

  it("records passed:false for an answer bound to another nonce", async () => {
    const { S } = state(["ready\n", `${NONCE} installed\n`, "ready\n", "zzz999 shown\n"]);
    const first = entry(await phase(S), "first-pull-confirm-shown");
    expect(first.passed).toBe(false);
    expect(first.detail).toMatch(/nonce/i);
  });

  it("records passed:false when the operator saw no dialog (not-shown) and for an unrecognised verdict", async () => {
    const noDialog = entry(await phase(state(["ready\n", `${NONCE} installed\n`, "ready\n", `${NONCE} not-shown\n`]).S), "first-pull-confirm-shown");
    expect(noDialog.passed).toBe(false);
    expect(noDialog.detail).toMatch(/not-shown/);
    const odd = entry(await phase(state(["ready\n", `${NONCE} installed\n`, "ready\n", `${NONCE} yes-I-think\n`]).S), "first-pull-confirm-shown");
    expect(odd.passed).toBe(false);
  });

  it("records passed:false when the answer carries the verdict without a nonce, or an empty line", async () => {
    for (const typed of ["shown\n", "\n", `${NONCE}\n`, `${NONCE.toUpperCase()} shown\n`, `${NONCE} shown extra\n`]) {
      const entries = await phase(state(["ready\n", `${NONCE} installed\n`, "ready\n", typed]).S);
      expect(entry(entries, "first-pull-confirm-shown").passed, typed).toBe(false);
    }
  });

  it("records passed:false when the answer window passes with nothing typed (the countdown starts at ready)", async () => {
    const { S, terminal } = state(["ready\n", `${NONCE} installed\n`, "ready\n"], { windowMs: 20 });
    const first = entry(await phase(S), "first-pull-confirm-shown");
    expect(first.passed).toBe(false);
    expect(first.detail).toMatch(/no answer within/);
    expect(terminal.listeners()).toBe(0);
    expect(terminal.flowing()).toBe(false);
  });

  it("records passed:false when the operator never says ready, and asks nothing further", async () => {
    const { S, terminal } = state([], { readyWaitMs: 20 });
    const first = entry(await phase(S), "first-pull-confirm-shown");
    expect(first.passed).toBe(false);
    expect(first.detail).toMatch(/ready/);
    expect(terminal.remaining()).toBe(0);
  });

  it("does not take a typed word other than ready as ready, and does not go on to the next prompt", async () => {
    const { S, terminal } = state(["go\n", `${NONCE} installed\n`, "ready\n", `${NONCE} shown\n`]);
    const first = entry(await phase(S), "first-pull-confirm-shown");
    expect(first.passed).toBe(false);
    expect(terminal.remaining()).toBe(3);
  });

  it("fails the first-pull assertion, without asking about it, when the install check is not confirmed", async () => {
    const { S, terminal } = state(["ready\n", `${NONCE} not-installed\n`, "ready\n", `${NONCE} shown\n`]);
    const first = entry(await phase(S), "first-pull-confirm-shown");
    expect(first.passed).toBe(false);
    expect(first.detail).toMatch(/install check/);
    expect(terminal.remaining()).toBe(2);
  });

  it("records passed:false when the terminal goes away mid-prompt", async () => {
    const { S, terminal } = state(["ready\n", `${NONCE} installed\n`, "ready\n"], { windowMs: 5_000 });
    const pending = phase(S);
    setTimeout(() => terminal.close(), 10);
    const first = entry(await pending, "first-pull-confirm-shown");
    expect(first.passed).toBe(false);
    expect(first.detail).toMatch(/closed/);
    expect(terminal.listeners()).toBe(0);
  });

  it("strips control characters from, and bounds, what it records of a typed answer", async () => {
    const { S } = state(["ready\n", `${NONCE} installed\n`, "ready\n", `${NONCE} \u001b[31m${"x".repeat(500)}\n`]);
    const first = entry(await phase(S), "first-pull-confirm-shown");
    expect(first.passed).toBe(false);
    expect(first.detail).not.toContain("\u001b");
    expect(first.detail.length).toBeLessThan(400);
  });

  it("a verify-only or script-only call never reads the terminal and never passes the operator-observed assertion", async () => {
    for (const opts of [{ verifyOnly: true }, { phases: "script-only" }]) {
      const { S, terminal } = state(["ready\n", `${NONCE} installed\n`, "ready\n", `${NONCE} shown\n`], {}, opts);
      const entries = await phase(S);
      expect(terminal.remaining()).toBe(4);
      expect(terminal.written).toEqual([]);
      expect(entry(entries, "first-pull-confirm-shown").passed).toBe(false);
      expect(entry(entries, "first-pull-confirm-shown").detail).toMatch(/not asked/);
    }
  });
});

describe("terminal requirements", () => {
  it("assertOperatorTerminal refuses missing, non-tty input and non-tty output, and accepts a tty pair", () => {
    expect(() => observed.assertOperatorTerminal(undefined)).toThrow(/terminal/);
    expect(() => observed.assertOperatorTerminal(createFakeTerminal({ inputIsTty: false }))).toThrow(/terminal/);
    expect(() => observed.assertOperatorTerminal(createFakeTerminal({ outputIsTty: false }))).toThrow(/terminal/);
    expect(() => observed.assertOperatorTerminal(createFakeTerminal())).not.toThrow();
  });

  it("readLine refuses a non-tty input itself and reads nothing", async () => {
    const terminal = createFakeTerminal({ inputIsTty: false, answers: ["ready\n"] });
    await expect(observed.readLine(terminal, "> ", { timeoutMs: 50 })).rejects.toThrow(/terminal/);
    expect(terminal.remaining()).toBe(1);
  });

  it("nonces are 6 characters of an unambiguous alphabet and differ between calls", () => {
    const seen = new Set(Array.from({ length: 20 }, () => observed.randomNonce()));
    expect(seen.size).toBeGreaterThan(15);
    for (const value of seen) expect(value).toMatch(/^[a-hjkmnp-z2-9]{6}$/);
  });
});

interface Harness {
  main(argv: readonly string[], overrides?: Record<string, unknown>): Promise<number>;
  recordNamesFor(mode: string): { record: string; transcript: string };
}
describe("through main() against the local stub", () => {
  let h: Harness;
  let distDir: string;
  beforeAll(async () => {
    h = (await import(/* @vite-ignore */ pathToFileURL(join(ROOT, "tools", "feature-op-mvp-07.mjs")).href)) as Harness;
    distDir = temp();
    mkdirSync(join(distDir, "plugin"));
    mkdirSync(join(distDir, "cli"));
    writeFileSync(join(distDir, "plugin", "main.js"), "main bytes");
    writeFileSync(join(distDir, "plugin", "manifest.json"), JSON.stringify({ id: "obsidian-ipfs-sync", version: "0.3.0" }));
    writeFileSync(join(distDir, "cli", "ipfs-sync.mjs"), "cli bytes");
  });

  const base = (dir: string, sink: { out: string; err: string }, extra: Record<string, unknown>) => ({
    env: { HOME: dir, PATH: process.env.PATH },
    platform: "linux",
    lockFile: join(dir, "run.lock"),
    write: (text: string) => void (sink.out += text),
    writeError: (text: string) => void (sink.err += text),
    ...extra,
  });

  it("a full run records first-pull-confirm-shown as operator-observed and passed, bound to the nonce typed at the terminal", async () => {
    const dir = temp();
    const sink = { out: "", err: "" };
    const terminal = createFakeTerminal({ answers: FULL });
    const code = await h.main(["--local-stub", "--dist-dir", distDir, "--out-dir", join(dir, "feature-ops")], base(dir, sink, { terminal, nonce: () => NONCE }));
    expect(code).toBe(1);
    const names = h.recordNamesFor("local-stub");
    const record = JSON.parse(readFileSync(join(dir, "feature-ops", names.record), "utf8")) as { assertions: (Entry & { kind: string })[]; notRun: unknown[]; passed: boolean };
    const first = record.assertions.find((candidate) => candidate.id === "first-pull-confirm-shown");
    expect(first).toMatchObject({ kind: "operator-observed", passed: true });
    expect(first?.detail).toContain(NONCE);
    expect(record.passed).toBe(false);
    expect(terminal.remaining()).toBe(0);
    expect(readFileSync(join(dir, "feature-ops", names.transcript), "utf8")).toContain(NONCE);
  });

  it("a pipe or no terminal exits 2 before the lock, the work directory and the result are touched", async () => {
    for (const terminal of [undefined, createFakeTerminal({ inputIsTty: false }), createFakeTerminal({ outputIsTty: false })]) {
      const dir = temp();
      const sink = { out: "", err: "" };
      const code = await h.main(["--local-stub", "--dist-dir", distDir, "--out-dir", join(dir, "feature-ops")], base(dir, sink, { terminal }));
      expect(code).toBe(2);
      expect(sink.err).toMatch(/refused: .*terminal/);
      expect(existsSync(join(dir, "feature-ops"))).toBe(false);
      expect(existsSync(join(dir, "run.lock"))).toBe(false);
      expect(sink.out).toBe("");
    }
  });

  it("--phases script-only needs no terminal and never reads one", async () => {
    const dir = temp();
    const sink = { out: "", err: "" };
    const terminal = createFakeTerminal({ inputIsTty: false, answers: ["ready\n"] });
    const code = await h.main(["--local-stub", "--phases", "script-only", "--owned-key", "k51-not-used", "--dist-dir", distDir, "--out-dir", join(dir, "feature-ops")], base(dir, sink, { terminal }));
    expect(code).toBe(1);
    expect(sink.err).toBe("");
    expect(terminal.remaining()).toBe(1);
    expect(terminal.written).toEqual([]);
  });
});
