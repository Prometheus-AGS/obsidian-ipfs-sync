import { describe, expect, it } from "vitest";
import { CryptoError } from "../../src/crypto";
import { decodeManifestFile } from "../../src/sync/encrypted-manifest";
import { readJournal } from "../../src/sync/journal";
import { commitPublish } from "../../src/sync/publish-commit";
import { resumeJournal } from "../../src/sync/publish-resume";
import { PublishRefusedError } from "../../src/sync/publish-refusals";
import { rootFileNames } from "../../src/sync/root-files";
import { readRootState } from "../../src/sync/root-state";
import { classifySequence } from "../../src/sync/sequence-rules";
import { KEYSLOTS_SHA, Killed, MFS_ROOT, STEPS, cidFor, killAfter, scenario, type Scenario, type Step } from "../helpers/commit-scenario";

const PATHS_V2 = ["notes/a.md", "notes/b.md", "notes/c.md"] as const;

async function killedAt(step: Step): Promise<{ readonly s: Scenario; readonly file2: Uint8Array<ArrayBuffer> }> {
  const s = await scenario();
  const { manifest, file } = await s.next(2, PATHS_V2);
  const pending = { target: s.target, manifest, manifestFile: file, mtimes: { "notes/c.md": 5 }, previousRootCid: s.state1.rootCid };
  await expect(commitPublish(killAfter(s.deps, step), pending)).rejects.toBeInstanceOf(Killed);
  return { s, file2: file };
}

const journalPresent = async (s: Scenario): Promise<boolean> => (await s.host.kv.get(rootFileNames(MFS_ROOT).journal)) !== undefined;
const resume = async (s: Scenario) => resumeJournal(s.deps, { target: s.target, state: await readRootState(s.host.kv, MFS_ROOT) });

describe("commitPublish: the fixed write order", () => {
  it("runs journal, manifest.enc, history, root CID, read-back, pin, publish, state, journal removal and nothing else", async () => {
    const s = await scenario();
    const { manifest, file } = await s.next(2, PATHS_V2);
    const record = (event: string): void => void s.node.calls.push(event);
    const kv = {
      get: s.deps.kv.get,
      set: async (key: string, value: Uint8Array<ArrayBuffer>) => {
        await s.deps.kv.set(key, value);
        record(key.startsWith("journal.") ? "journal-write" : "state-write");
      },
      delete: async (key: string) => {
        await s.deps.kv.delete(key);
        record(key.startsWith("journal.") ? "journal-delete" : "other-delete");
      },
    };
    const state = await commitPublish({ ...s.deps, kv }, { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: null });
    expect(s.node.calls).toEqual([...STEPS]);
    expect(state.sequence).toBe(2);
    expect(s.node.pins).toEqual([state.rootCid]);
    expect(s.node.publishes).toEqual([state.rootCid]);
    expect(await journalPresent(s)).toBe(false);
    expect((await readRootState(s.host.kv, MFS_ROOT))?.sequence).toBe(2);
  });

  it("refuses before writing anything when the history file already holds different bytes", async () => {
    const s = await scenario();
    const { manifest, file } = await s.next(2, PATHS_V2);
    s.node.history.set(manifest.rootCID, new Uint8Array([1, 2, 3]));
    const attempt = commitPublish(s.deps, { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: null });
    await expect(attempt).rejects.toMatchObject({ code: "history-conflict" });
    expect(await journalPresent(s)).toBe(false);
    expect(s.node.manifestWrites).toBe(0);
  });

  it("never pins or publishes when the read-back fails", async () => {
    const s = await scenario();
    const { manifest, file } = await s.next(2, PATHS_V2);
    s.node.topLevelExtras.push("stray.txt");
    await expect(commitPublish(s.deps, { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: null })).rejects.toThrowError(/read-back/);
    expect(s.node.pins).toEqual([]);
    expect(s.node.publishes).toEqual([]);
    expect(await journalPresent(s)).toBe(true);
  });
});

describe("resumeJournal: a kill after each step of the write order", () => {
  it.each([...STEPS])("a rerun after a kill following %s completes or refuses specifically, and leaves no blocking journal", async (step) => {
    const { s } = await killedAt(step);
    const outcome = await resume(s);
    const state = await readRootState(s.host.kv, MFS_ROOT);

    expect(await journalPresent(s)).toBe(false);
    // never a second manifest for one sequence, never a second history file
    expect(s.node.manifestWrites).toBeLessThanOrEqual(1);
    expect(s.node.historyWrites).toBeLessThanOrEqual(1);

    if (step === "journal-write") {
      expect(outcome).toEqual({ kind: "discarded", why: "never-written" });
      expect(state?.sequence).toBe(1);
      expect(s.node.manifestWrites).toBe(0);
      return;
    }
    if (step === "journal-delete") {
      expect(outcome).toEqual({ kind: "none" });
    } else if (step === "state-write") {
      expect(outcome.kind).toBe("settled");
    } else {
      expect(outcome.kind).toBe("completed");
    }
    expect(state?.sequence).toBe(2);
    expect(s.node.manifestWrites).toBe(1);
    const node = await decodeManifestFile(s.keys, s.node.manifestFile ?? new Uint8Array());
    expect(node.sequence).toBe(2);
    expect(classifySequence(state, node)).toEqual({ kind: "in-sync" });
  });

  it("an interrupted publish that reached IPNS is not published a second time after the state was recorded", async () => {
    const { s } = await killedAt("state-write");
    const before = s.node.publishes.length;
    await resume(s);
    expect(s.node.publishes.length).toBe(before);
  });

  it("a kill before the manifest write lets the rerun commit the same sequence once", async () => {
    const s = await scenario();
    const { manifest, file } = await s.next(2, PATHS_V2);
    const pending = { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: null };
    await expect(commitPublish(killAfter(s.deps, "journal-write"), pending)).rejects.toBeInstanceOf(Killed);
    expect((await resume(s)).kind).toBe("discarded");
    const state = await commitPublish(s.deps, pending);
    expect(state.sequence).toBe(2);
    expect(s.node.manifestWrites).toBe(1);
    expect(await journalPresent(s)).toBe(false);
  });

  it("a kill between manifest.enc and its history file: the history file is written from the node's bytes", async () => {
    const { s, file2 } = await killedAt("manifest-write");
    expect(s.node.history.has(s.node.current ?? "")).toBe(false);
    const outcome = await resume(s);
    expect(outcome.kind).toBe("completed");
    expect(s.node.history.get(s.node.current ?? "")).toEqual(file2);
    expect(s.node.publishes).toHaveLength(1);
  });
});

describe("resumeJournal: refusals and reconciliation", () => {
  it("an object planted under current/ while the publisher was down does not lock it out", async () => {
    const { s } = await killedAt("manifest-write");
    s.node.plantUnderCurrent();
    const outcome = await resume(s);
    expect(outcome.kind).toBe("adopted");
    expect(await journalPresent(s)).toBe(false);
    const state = await readRootState(s.host.kv, MFS_ROOT);
    expect(state?.sequence).toBe(2);
    expect(state?.manifest.rootCID).toBe(cidFor("tree-2-notes/a.md,notes/b.md,notes/c.md"));
    expect(state?.mtimes).toEqual({ "notes/c.md": 5 });
    // no pin, no publish for the interrupted snapshot
    expect(s.node.pins).toEqual([]);
    expect(s.node.publishes).toEqual([]);
    // the drift path can run at the next sequence: the node and the adopted state agree
    const node = await decodeManifestFile(s.keys, s.node.manifestFile ?? new Uint8Array());
    expect(classifySequence(state, node)).toEqual({ kind: "in-sync" });
    // and a publish at sequence 3 goes through
    const { manifest, file } = await s.next(3, [...PATHS_V2, "notes/d.md"]);
    const next = await commitPublish(s.deps, { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: state?.rootCid ?? null });
    expect(next.sequence).toBe(3);
  });

  it("a read-back failure on resume adopts the pending state instead of locking the publisher out", async () => {
    const { s } = await killedAt("manifest-write");
    s.node.topLevelExtras.push("stray.txt");
    expect((await resume(s)).kind).toBe("adopted");
    expect(await journalPresent(s)).toBe(false);
    expect((await readRootState(s.host.kv, MFS_ROOT))?.sequence).toBe(2);
  });

  it("adopts, instead of wedging on the journal, when the history file holds different bytes than the node's manifest.enc", async () => {
    const { s } = await killedAt("manifest-write");
    s.node.history.set(s.node.current ?? "", new Uint8Array([9, 9, 9]));
    expect((await resume(s)).kind).toBe("adopted");
    expect(await journalPresent(s)).toBe(false);
    expect((await readRootState(s.host.kv, MFS_ROOT))?.sequence).toBe(2);
    expect(s.node.manifestWrites).toBe(1);
    expect(s.node.pins).toEqual([]);
  });

  it("refuses when the node holds a different manifest at the journal's sequence", async () => {
    const { s } = await killedAt("manifest-write");
    const { manifest, file } = await s.next(2, ["other.md"]);
    expect(manifest.sequence).toBe(2);
    s.node.manifestFile = file;
    await expect(resume(s)).rejects.toMatchObject({ code: "journal-manifest-mismatch" });
    expect(await journalPresent(s)).toBe(true);
  });

  it("refuses when the node is ahead of the interrupted publish, and names --repair", async () => {
    const { s } = await killedAt("manifest-write");
    const { file } = await s.next(5, PATHS_V2);
    s.node.manifestFile = file;
    const error = await resume(s).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "sequence-ahead" });
    expect((error as Error).message).toContain("--repair");
  });

  it("refuses when the node is more than one behind the journal, and names --repair", async () => {
    const s = await scenario();
    const { manifest, file } = await s.next(4, PATHS_V2);
    await expect(commitPublish(killAfter(s.deps, "journal-write"), { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: null })).rejects.toBeInstanceOf(Killed);
    const error = await resume(s).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "journal-conflict" });
    expect((error as Error).message).toContain("--repair");
  });

  it("refuses when the node has no manifest but the journal is past the first publish", async () => {
    const s = await scenario();
    const { manifest, file } = await s.next(2, PATHS_V2);
    await expect(commitPublish(killAfter(s.deps, "journal-write"), { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: null })).rejects.toBeInstanceOf(Killed);
    s.node.manifestFile = undefined;
    await expect(resume(s)).rejects.toMatchObject({ code: "node-manifest-missing" });
  });

  it("a first publish killed after its journal and before any manifest is discarded", async () => {
    const s = await scenario();
    await s.host.kv.delete(rootFileNames(MFS_ROOT).state);
    s.node.manifestFile = undefined;
    s.node.history.clear();
    const { manifest, file } = await s.next(1, PATHS_V2);
    await expect(commitPublish(killAfter(s.deps, "journal-write"), { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: null })).rejects.toBeInstanceOf(Killed);
    expect((await resume(s)).kind).toBe("discarded");
  });

  it("W-04: a manifest.enc that does not authenticate (a cut-short write) is written again from the journal and the publish completes", async () => {
    for (const damage of ["flipped", "truncated"] as const) {
      const { s } = await killedAt("manifest-write");
      const good = new Uint8Array(s.node.manifestFile ?? new Uint8Array());
      const bad = damage === "truncated" ? good.slice(0, Math.floor(good.length / 2)) : Uint8Array.from(good, (byte, index) => (index === good.length - 1 ? byte ^ 1 : byte));
      s.node.manifestFile = bad;
      const outcome = await resume(s);
      expect(outcome.kind).toBe("completed");
      expect(s.node.manifestFile).not.toEqual(bad);
      expect((await decodeManifestFile(s.keys, s.node.manifestFile ?? new Uint8Array())).sequence).toBe(2);
      expect(await journalPresent(s)).toBe(false);
      expect(s.node.pins).toHaveLength(1);
    }
  });

  it("W-04: a kill right after the rewrite still resumes (the journal records the new file's hash first)", async () => {
    const { s } = await killedAt("manifest-write");
    s.node.manifestFile = new Uint8Array(s.node.manifestFile ?? new Uint8Array()).slice(0, 40);
    const killing = { ...s.deps, node: { ...s.deps.node, readHistoryFile: async (): Promise<never> => { throw new Killed("rewrite"); } } };
    await expect(resumeJournal(killing, { target: s.target, state: await readRootState(s.host.kv, MFS_ROOT) })).rejects.toBeInstanceOf(Killed);
    expect(await journalPresent(s)).toBe(true);
    expect((await resume(s)).kind).toBe("completed");
  });

  it("a platform failure while reading the manifest is not mistaken for a torn write", async () => {
    const { s } = await killedAt("manifest-write");
    const deps = { ...s.deps, decodeManifest: async (): Promise<never> => { throw new CryptoError("platform-failure", "the platform crypto call failed"); } };
    await expect(resumeJournal(deps, { target: s.target, state: await readRootState(s.host.kv, MFS_ROOT) })).rejects.toMatchObject({ code: "platform-failure" });
    expect(await journalPresent(s)).toBe(true);
  });

  it("discards a journal it cannot read (a torn write) and lets the sequence rules decide", async () => {
    const s = await scenario();
    await s.host.kv.set(rootFileNames(MFS_ROOT).journal, new TextEncoder().encode('{"version":1,"mfsRo'));
    expect(await resume(s)).toEqual({ kind: "discarded", why: "damaged" });
    expect(await journalPresent(s)).toBe(false);
  });

  it.each([
    ["another vault", { vaultId: "1".repeat(32) }, "vault"],
    ["another key-slot file", { keyslotsSha256: "d".repeat(64) }, "key slots"],
  ] as const)("refuses a journal that belongs to %s before touching the node", async (_label, change, what) => {
    const { s } = await killedAt("manifest-write");
    const before = [...s.node.calls];
    const error = await resumeJournal(s.deps, { target: { ...s.target, ...change }, state: undefined }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PublishRefusedError);
    expect((error as PublishRefusedError).code).toBe("journal-mismatch");
    expect((error as Error).message).toContain(what);
    expect(s.node.calls).toEqual(before);
    expect(await journalPresent(s)).toBe(true);
  });

  it("refuses a journal file that was copied under another root's name", async () => {
    const { s } = await killedAt("manifest-write");
    const other = "/obsidian-vault-sync/elsewhere";
    const bytes = await s.host.kv.get(rootFileNames(MFS_ROOT).journal);
    await s.host.kv.set(rootFileNames(other).journal, bytes ?? new Uint8Array());
    const error = await resumeJournal(s.deps, { target: { ...s.target, mfsRoot: other }, state: undefined }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "journal-mismatch" });
    expect((error as Error).message).toContain("root");
  });

  it("refuses a journal older than the local record, without touching the node", async () => {
    const { s } = await killedAt("manifest-write");
    const state = await readRootState(s.host.kv, MFS_ROOT);
    if (state === undefined) throw new Error("state expected");
    const newer = { ...state, sequence: 3, manifest: { ...state.manifest, sequence: 3 } };
    const before = [...s.node.calls];
    await expect(resumeJournal(s.deps, { target: s.target, state: newer })).rejects.toMatchObject({ code: "journal-conflict" });
    expect(s.node.calls).toEqual(before);
  });

  it("W-10: refuses a journal that names another publication key, without touching the node", async () => {
    const { s } = await killedAt("manifest-write");
    const target = { ...s.target, key: "obsidian-vault-other" };
    const before = [...s.node.calls];
    const error = await resumeJournal(s.deps, { target, state: await readRootState(s.host.kv, MFS_ROOT) }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "journal-mismatch" });
    expect((error as Error).message).toContain("publication key");
    expect(s.node.calls).toEqual(before);
    expect((await readJournal(s.host.kv, MFS_ROOT)).kind).toBe("ok");
  });
});

describe("local records carry the vault and the key-slot hash", () => {
  it("the journal and the state record vaultId and keyslotsSha256, and no secret", async () => {
    const { s } = await killedAt("manifest-write");
    const read = await readJournal(s.host.kv, MFS_ROOT);
    if (read.kind !== "ok") throw new Error("journal expected");
    expect(read.journal).toMatchObject({ vaultId: s.keys.vaultId, keyslotsSha256: KEYSLOTS_SHA, sequence: 2, mfsRoot: MFS_ROOT });
    const raw = new TextDecoder().decode(await s.host.kv.get(rootFileNames(MFS_ROOT).journal));
    expect(raw).not.toMatch(/passphrase|secret|"vck"|"kek"/i);
  });
});
