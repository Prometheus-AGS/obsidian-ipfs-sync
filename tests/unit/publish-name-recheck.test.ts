import { describe, expect, it } from "vitest";
import type { Bytes } from "../../src/core/host-bridge";
import type { CommitDeps, NameReading, NameStart } from "../../src/sync/commit-ports";
import { encodeManifestFile, type EncryptedManifest } from "../../src/sync/encrypted-manifest";
import { buildJournal, decodeJournal, encodeJournal, journalSetAsideName, readJournal, setAsideJournal, writeJournal } from "../../src/sync/journal";
import { assertNameUnmoved, rootOfReading } from "../../src/sync/name-recheck";
import { manifestIdentity } from "../../src/sync/manifest-identity";
import { commitPublish } from "../../src/sync/publish-commit";
import { resumeJournal } from "../../src/sync/publish-resume";
import { PublishRefusedError } from "../../src/sync/publish-refusals";
import { rootFileNames } from "../../src/sync/root-files";
import { readRootState } from "../../src/sync/root-state";
import { KEYSLOTS_SHA, Killed, MFS_ROOT, cidFor, killAfter, scenario, type Scenario, type Step } from "../helpers/commit-scenario";

/**
 * Task 2.2 at the commit protocol: the journal's `startRoot` (format 2, format 1 still decoded), the resume-time name
 * comparison, the end-of-publish re-check and the rules of `name-recheck.ts`. Readings are injected through the fake
 * commit node; the text-to-class table is covered in `kubo-name-resolve-classify.test.ts`.
 */

const PATHS_V2 = ["notes/a.md", "notes/b.md", "notes/c.md"] as const;
const ROOT_1 = cidFor("root-1");
const OTHER_ROOT = cidFor("a-foreign-root");
const START: NameStart = { root: ROOT_1, firstPublish: false };

const value = (root: string): NameReading => ({ kind: "value", root });
const NOT_FOUND: NameReading = { kind: "not-found" };
const TIMED_OUT: NameReading = { kind: "failed", timedOut: true };
const FAILED: NameReading = { kind: "failed", timedOut: false };

const refusal = (code: string) => expect.objectContaining({ code });

async function killedAt(step: Step, nameStart: NameStart | undefined = START): Promise<Scenario> {
  const s = await scenario();
  const { manifest, file } = await s.next(2, PATHS_V2);
  const pending = { target: s.target, manifest, manifestFile: file, mtimes: { "notes/c.md": 5 }, previousRootCid: s.state1.rootCid, ...(nameStart === undefined ? {} : { nameStart }) };
  await expect(commitPublish(killAfter(s.deps, step), pending)).rejects.toBeInstanceOf(Killed);
  return s;
}

const journalPresent = async (s: Scenario): Promise<boolean> => (await s.host.kv.get(rootFileNames(MFS_ROOT).journal)) !== undefined;
const resume = async (s: Scenario, deps: CommitDeps = s.deps) => resumeJournal(deps, { target: s.target, state: await readRootState(s.host.kv, MFS_ROOT) });
const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

describe("the rules of the name re-check", () => {
  it("reads a value, not-found, and a failed reading", () => {
    expect(rootOfReading(value(ROOT_1), false)).toBe(ROOT_1);
    expect(rootOfReading(NOT_FOUND, false)).toBeNull();
    expect(rootOfReading(undefined, false)).toBeNull();
    expect(() => rootOfReading(FAILED, false)).toThrow(PublishRefusedError);
    expect(() => rootOfReading(FAILED, true)).toThrow(/name could not be read/);
  });

  it("a routing timeout refuses and names routing, except on the first publish of a vault where it counts as not found", () => {
    expect(() => rootOfReading(TIMED_OUT, false)).toThrow(expect.objectContaining({ code: "name-routing-failed" }));
    expect(rootOfReading(TIMED_OUT, true)).toBeNull();
    // an unrecognised failure is never softened, not even on the first publish
    expect(() => rootOfReading(FAILED, true)).toThrow(expect.objectContaining({ code: "name-routing-failed" }));
  });

  it("the end value must equal the start value; not-found must stay not-found", () => {
    expect(() => assertNameUnmoved({ root: ROOT_1, firstPublish: false }, value(ROOT_1), cidFor("new"))).not.toThrow();
    expect(() => assertNameUnmoved({ root: null, firstPublish: false }, NOT_FOUND, cidFor("new"))).not.toThrow();
    expect(() => assertNameUnmoved({ root: ROOT_1, firstPublish: false }, value(OTHER_ROOT), cidFor("new"))).toThrow(refusal("overlapping-publish"));
    expect(() => assertNameUnmoved({ root: null, firstPublish: false }, value(OTHER_ROOT), cidFor("new"))).toThrow(refusal("overlapping-publish"));
    // the name resolved at the start and no longer does
    expect(() => assertNameUnmoved({ root: ROOT_1, firstPublish: false }, NOT_FOUND, cidFor("new"))).toThrow(refusal("overlapping-publish"));
  });

  it("the root being published is an acceptable end value (an earlier attempt of this publish already moved the name)", () => {
    const publishing = cidFor("new");
    expect(() => assertNameUnmoved({ root: ROOT_1, firstPublish: false }, value(publishing), publishing)).not.toThrow();
  });

  it("a failed end reading refuses even when the start was a value", () => {
    expect(() => assertNameUnmoved({ root: ROOT_1, firstPublish: false }, TIMED_OUT, cidFor("new"))).toThrow(refusal("name-routing-failed"));
  });
});

describe("journal format 2", () => {
  it("records the start root a publish was given, and null for no record", async () => {
    const s = await scenario();
    const { manifest, file } = await s.next(2, PATHS_V2);
    await expect(commitPublish(killAfter(s.deps, "journal-write"), { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: null, nameStart: START })).rejects.toBeInstanceOf(Killed);
    const read = await readJournal(s.host.kv, MFS_ROOT);
    expect(read).toMatchObject({ kind: "ok", journal: { version: 2, startRoot: ROOT_1 } });
    await s.host.kv.delete(rootFileNames(MFS_ROOT).journal);
    await expect(commitPublish(killAfter(s.deps, "journal-write"), { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: null, nameStart: { root: null, firstPublish: true } })).rejects.toBeInstanceOf(Killed);
    expect(await readJournal(s.host.kv, MFS_ROOT)).toMatchObject({ kind: "ok", journal: { version: 2, startRoot: null } });
  });

  async function journalFor(startRoot?: string | null): Promise<{ readonly s: Scenario; readonly journal: ReturnType<typeof buildJournal> }> {
    const s = await scenario();
    const journal = buildJournal({
      mfsRoot: MFS_ROOT,
      key: "k",
      vaultId: s.keys.vaultId,
      keyslotsSha256: KEYSLOTS_SHA,
      sequence: 1,
      manifestSha256: "e".repeat(64),
      pending: { manifest: s.manifest1, mtimes: {} },
      startedAt: "2026-09-30T12:00:00.000Z",
      ...(startRoot === undefined ? {} : { startRoot }),
    });
    return { s, journal };
  }

  it("round trips a start root and a null start root", async () => {
    for (const startRoot of [ROOT_1, null]) {
      const { journal } = await journalFor(startRoot);
      const again = decodeJournal(encodeJournal(journal));
      expect(again.startRoot).toBe(startRoot);
      expect(JSON.parse(new TextDecoder().decode(encodeJournal(journal)))).toMatchObject({ version: 2, startRoot });
    }
  });

  it("a format 1 journal decodes with the start root unknown, and is written back as format 1 until a start root is known", async () => {
    const { journal } = await journalFor();
    expect(JSON.parse(new TextDecoder().decode(encodeJournal(journal)))).not.toHaveProperty("startRoot");
    expect(JSON.parse(new TextDecoder().decode(encodeJournal(journal)))).toMatchObject({ version: 1 });
    const decoded = decodeJournal(encodeJournal(journal));
    expect(decoded.startRoot).toBeUndefined();
    expect(JSON.parse(new TextDecoder().decode(encodeJournal({ ...decoded, startRoot: ROOT_1 })))).toMatchObject({ version: 2, startRoot: ROOT_1 });
  });

  it("a format 2 journal without a usable start root is damaged, not silently unknown", async () => {
    const { s, journal } = await journalFor(ROOT_1);
    const parsed = JSON.parse(new TextDecoder().decode(encodeJournal(journal))) as Record<string, unknown>;
    const damaged = (patch: Record<string, unknown>): Bytes => new TextEncoder().encode(JSON.stringify({ ...parsed, ...patch }));
    const withoutKey = { ...parsed };
    delete withoutKey["startRoot"];
    for (const bytes of [new TextEncoder().encode(JSON.stringify(withoutKey)), damaged({ startRoot: 7 }), damaged({ startRoot: "not a cid!" }), damaged({ startRoot: "" })]) {
      await s.host.kv.set(rootFileNames(MFS_ROOT).journal, bytes);
      expect(await readJournal(s.host.kv, MFS_ROOT)).toEqual({ kind: "damaged" });
    }
    await s.host.kv.set(rootFileNames(MFS_ROOT).journal, damaged({ version: 3 }));
    expect(await readJournal(s.host.kv, MFS_ROOT)).toEqual({ kind: "damaged" });
  });

  it("moves a journal aside byte for byte and reports none when there is no journal", async () => {
    const { s, journal } = await journalFor(ROOT_1);
    expect(await setAsideJournal(s.host.kv, MFS_ROOT, 7)).toBeUndefined();
    await writeJournal(s.host.kv, journal);
    const before = await s.host.kv.get(rootFileNames(MFS_ROOT).journal);
    expect(await setAsideJournal(s.host.kv, MFS_ROOT, 7)).toBe(journalSetAsideName(7));
    expect(await s.host.kv.get(journalSetAsideName(7))).toEqual(before);
    expect(await readJournal(s.host.kv, MFS_ROOT)).toEqual({ kind: "none" });
    expect(journalSetAsideName(7)).toBe("journal-set-aside.7.json");
  });
});

describe("the end-of-publish check receives the start root", () => {
  it("a fresh commit hands the start it was given to publishRoot", async () => {
    const s = await scenario();
    const { manifest, file } = await s.next(2, PATHS_V2);
    await commitPublish(s.deps, { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: s.state1.rootCid, nameStart: START });
    expect(s.node.publishStarts).toEqual([START]);
  });
});

describe("a refused name re-check puts back a manifest.enc that it overwrote (defect D-1), narrowed by A-01 and A-03", () => {
  /** The node adapter's `publishRoot`, in miniature: the end-of-publish name check, then the publication. */
  function nameMovedTo(s: Scenario, reading: NameReading, beforeCheck: () => void = () => undefined): void {
    s.node.nameReading = reading;
    s.node.publishRoot = async (rootCid, start) => {
      beforeCheck();
      if (start !== undefined) assertNameUnmoved(start, s.node.nameReading, rootCid);
      s.node.publishes.push(rootCid);
    };
  }
  const commit = async (s: Scenario, before: (manifest: EncryptedManifest) => Promise<void> = async () => undefined) => {
    const { manifest, file } = await s.next(2, PATHS_V2);
    await before(manifest);
    return { file, result: await rejection(commitPublish(s.deps, { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: s.state1.rootCid, nameStart: START })) };
  };
  /** A re-encryption of the very manifest being published: another file, the same identity (a previous attempt of this publish). */
  const priorAttempt = async (s: Scenario, manifest: EncryptedManifest): Promise<Bytes> => (await encodeManifestFile(s.keys, manifest)).file;

  it("A-01: a winner's manifest.enc (same sequence, another snapshot) found before the first node write is refused up front: it is never overwritten, nothing is written", async () => {
    const s = await scenario();
    const winner = await s.next(2, ["other.md"]);
    s.node.manifestFile = winner.file;
    nameMovedTo(s, value(OTHER_ROOT));
    const { result } = await commit(s);
    expect(result).toMatchObject({ code: "overlapping-publish" });
    expect((result as Error).message).toContain("pull first");
    expect(s.node.manifestFile).toBe(winner.file);
    expect(s.node.calls.filter((line) => line === "manifest-write" || line === "history-write")).toEqual([]);
    expect(s.node.publishes).toEqual([]);
    // the journal the protocol writes first stays (the next pull sets it aside), as for every other overlap
    expect(await journalPresent(s)).toBe(true);
  });

  it("A-01: a winner at a higher sequence is refused the same way", async () => {
    const s = await scenario();
    const winner = await s.next(3, ["other.md"]);
    s.node.manifestFile = winner.file;
    const { result } = await commit(s);
    expect(result).toMatchObject({ code: "overlapping-publish" });
    expect(s.node.manifestFile).toBe(winner.file);
    expect(s.node.calls.filter((line) => line === "manifest-write")).toEqual([]);
  });

  it("A-01: a manifest.enc with this publish's own identity (an earlier attempt, other bytes) is not an overlap", async () => {
    const s = await scenario();
    let file: Bytes | undefined;
    const { result } = await commit(s, async (manifest) => {
      file = await priorAttempt(s, manifest);
      s.node.manifestFile = file;
    });
    expect(result).toBeUndefined();
    expect(s.node.calls.filter((line) => line === "manifest-write")).toHaveLength(1);
  });

  it("A-01: an older manifest.enc, one that does not authenticate and an absent one do not refuse", async () => {
    for (const prepare of [async () => undefined, async (s: Scenario) => void (s.node.manifestFile = new Uint8Array([1, 2, 3, 4])), async (s: Scenario) => void (s.node.manifestFile = undefined)]) {
      const s = await scenario();
      await prepare(s);
      const { result } = await commit(s);
      expect(result).toBeUndefined();
    }
  });

  it("A-03: puts back the manifest.enc it overwrote when that file is exactly the one inside the root the name moved to", async () => {
    const s = await scenario();
    let prior: Bytes | undefined;
    nameMovedTo(s, value(OTHER_ROOT));
    const { file, result } = await commit(s, async (manifest) => {
      prior = await priorAttempt(s, manifest);
      s.node.manifestFile = prior;
      s.node.rootManifests.set(OTHER_ROOT, prior);
    });
    expect(result).toMatchObject({ code: "overlapping-publish" });
    expect(s.node.manifestFile).toBe(prior);
    expect(s.node.manifestFile).not.toBe(file);
  });

  it("A-03: does not put it back when the root the name moved to holds another manifest.enc", async () => {
    const s = await scenario();
    const elsewhere = await s.next(4, ["elsewhere.md"]);
    nameMovedTo(s, value(OTHER_ROOT));
    const { file, result } = await commit(s, async (manifest) => {
      s.node.manifestFile = await priorAttempt(s, manifest);
      s.node.rootManifests.set(OTHER_ROOT, elsewhere.file);
    });
    expect(result).toMatchObject({ code: "overlapping-publish" });
    expect(s.node.manifestFile).toBe(file);
  });

  it("A-03: does not put it back when that root has no manifest.enc, or when the name no longer resolves", async () => {
    for (const reading of [value(OTHER_ROOT), NOT_FOUND]) {
      const s = await scenario();
      nameMovedTo(s, reading);
      const { file, result } = await commit(s, async (manifest) => void (s.node.manifestFile = await priorAttempt(s, manifest)));
      expect(result).toMatchObject({ code: "overlapping-publish" });
      expect(s.node.manifestFile).toBe(file);
    }
  });

  it("A-03: a withdrawal that fails (the write, or the read of the root's file) leaves the original overlapping-publish refusal", async () => {
    const writeFails = await scenario();
    nameMovedTo(writeFails, value(OTHER_ROOT));
    writeFails.node.failManifestWriteNumber = 2;
    const first = await commit(writeFails, async (manifest) => {
      const prior = await priorAttempt(writeFails, manifest);
      writeFails.node.manifestFile = prior;
      writeFails.node.rootManifests.set(OTHER_ROOT, prior);
    });
    expect(first.result).toMatchObject({ code: "overlapping-publish" });
    expect(writeFails.node.calls.filter((line) => line === "manifest-write")).toHaveLength(2);

    const readFails = await scenario();
    nameMovedTo(readFails, value(OTHER_ROOT));
    readFails.node.rootManifestFault = new Error("gateway down");
    const second = await commit(readFails, async (manifest) => void (readFails.node.manifestFile = await priorAttempt(readFails, manifest)));
    expect(second.result).toMatchObject({ code: "overlapping-publish" });
  });

  it("leaves its own manifest.enc when what it overwrote was only this device's earlier publish: the resume refusal covers that rerun", async () => {
    const s = await scenario();
    nameMovedTo(s, value(OTHER_ROOT));
    const { file, result } = await commit(s);
    expect(result).toMatchObject({ code: "overlapping-publish" });
    expect(s.node.manifestFile).toBe(file);
  });

  it("writes nothing back, and removes nothing, when there was no manifest.enc before", async () => {
    const s = await scenario();
    s.node.manifestFile = undefined;
    nameMovedTo(s, value(OTHER_ROOT));
    const { file, result } = await commit(s);
    expect(result).toMatchObject({ code: "overlapping-publish" });
    expect(s.node.manifestFile).toBe(file);
    expect(s.node.calls.filter((line) => line === "manifest-write")).toHaveLength(1);
  });

  it("does not put back a file that does not authenticate under this vault's key", async () => {
    const s = await scenario();
    const planted = new Uint8Array([1, 2, 3, 4]);
    s.node.manifestFile = planted;
    s.node.rootManifests.set(OTHER_ROOT, planted);
    nameMovedTo(s, value(OTHER_ROOT));
    const { file, result } = await commit(s);
    expect(result).toMatchObject({ code: "overlapping-publish" });
    expect(s.node.manifestFile).toBe(file);
  });

  it("leaves a manifest.enc that another device wrote after this publish's write", async () => {
    const s = await scenario();
    const later = await s.next(3, ["later.md"]);
    nameMovedTo(s, value(OTHER_ROOT), () => (s.node.manifestFile = later.file));
    const { result } = await commit(s, async (manifest) => {
      const prior = await priorAttempt(s, manifest);
      s.node.manifestFile = prior;
      s.node.rootManifests.set(OTHER_ROOT, prior);
    });
    expect(result).toMatchObject({ code: "overlapping-publish" });
    expect(s.node.manifestFile).toBe(later.file);
    expect(s.node.calls.filter((line) => line === "manifest-write")).toHaveLength(1);
  });

  it("only an overlap withdraws: any other stop leaves manifest.enc for the resume to finish", async () => {
    const s = await scenario();
    const { manifest, file } = await s.next(2, PATHS_V2);
    await expect(commitPublish(killAfter(s.deps, "pin"), { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: s.state1.rootCid, nameStart: START })).rejects.toBeInstanceOf(Killed);
    expect(s.node.manifestFile).toBe(file);
  });
});

describe("resume compares the name with the root the interrupted publish started from", () => {
  it("a name still at the start root lets the publish finish, with that start root checked again before name/publish", async () => {
    const s = await killedAt("manifest-write");
    s.node.nameReading = value(ROOT_1);
    const outcome = await resume(s);
    expect(outcome.kind).toBe("completed");
    expect(s.node.publishStarts).toEqual([START]);
    expect(await journalPresent(s)).toBe(false);
  });

  it("crash, foreign publish, resume: ends in overlapping-publish with no publication and no adoption over the foreign manifest", async () => {
    const s = await killedAt("manifest-write");
    // device B published sequence 2 meanwhile: its manifest is on the node and the name moved
    const foreign = await s.next(2, ["other.md"]);
    s.node.manifestFile = foreign.file;
    s.node.nameReading = value(OTHER_ROOT);
    const state = await readRootState(s.host.kv, MFS_ROOT);
    const error = await rejection(resume(s));
    expect(error).toMatchObject({ code: "overlapping-publish" });
    expect((error as Error).message).toContain("pull first");
    expect(s.node.publishes).toEqual([]);
    expect(s.node.pins).toEqual([]);
    expect(await journalPresent(s)).toBe(true);
    // no adoption: the state is exactly what it was
    expect(await readRootState(s.host.kv, MFS_ROOT)).toEqual(state);
    expect(state?.sequence).toBe(1);
  });

  it("the node's manifest is ours but the name moved: overlapping-publish, nothing adopted, nothing published", async () => {
    const s = await killedAt("manifest-write");
    s.node.nameReading = value(OTHER_ROOT);
    await expect(resume(s)).rejects.toMatchObject({ code: "overlapping-publish" });
    expect(s.node.publishes).toEqual([]);
    expect(await journalPresent(s)).toBe(true);
    expect((await readRootState(s.host.kv, MFS_ROOT))?.sequence).toBe(1);
  });

  it("--repair does not lift the overlap", async () => {
    const s = await killedAt("manifest-write");
    s.node.nameReading = value(OTHER_ROOT);
    await expect(resumeJournal(s.deps, { target: s.target, state: await readRootState(s.host.kv, MFS_ROOT), repair: true })).rejects.toMatchObject({ code: "overlapping-publish" });
  });

  it("crash after name/publish and before the state: the name is at the root of this very snapshot, so the resume finishes", async () => {
    const s = await killedAt("publish");
    s.node.nameReading = value(await s.node.rootCid());
    const before = s.node.publishes.length;
    const outcome = await resume(s);
    expect(outcome.kind).toBe("completed");
    // the publication is repeated for the same root (idempotent) and the state is recorded
    expect(s.node.publishes.slice(before)).toEqual([await s.node.rootCid()]);
    expect((await readRootState(s.host.kv, MFS_ROOT))?.sequence).toBe(2);
  });

  it("a name that vanished while the journal started from a root is an overlap; not-found at both ends proceeds", async () => {
    const vanished = await killedAt("manifest-write");
    vanished.node.nameReading = NOT_FOUND;
    await expect(resume(vanished)).rejects.toMatchObject({ code: "overlapping-publish" });
    const unpublished = await killedAt("manifest-write", { root: null, firstPublish: true });
    unpublished.node.nameReading = NOT_FOUND;
    expect((await resume(unpublished)).kind).toBe("completed");
  });

  it("a reading that failed refuses and names routing, for a timeout as for any other failure; nothing is written", async () => {
    for (const reading of [TIMED_OUT, FAILED]) {
      const s = await killedAt("manifest-write");
      s.node.nameReading = reading;
      const writes = s.node.manifestWrites;
      await expect(resume(s)).rejects.toMatchObject({ code: "name-routing-failed" });
      expect(s.node.publishes).toEqual([]);
      expect(s.node.manifestWrites).toBe(writes);
      expect(await journalPresent(s)).toBe(true);
    }
  });

  it("a key whose id is not known yet has no name to read: the resume goes on (the key check before name/publish stands)", async () => {
    const s = await killedAt("manifest-write");
    s.node.nameReading = undefined;
    expect((await resume(s)).kind).toBe("completed");
  });

  it("an unreadable manifest.enc is rewritten only while the name is where the publish started", async () => {
    const moved = await killedAt("manifest-write");
    const good = new Uint8Array(moved.node.manifestFile ?? new Uint8Array());
    moved.node.manifestFile = good.slice(0, Math.floor(good.length / 2));
    const damagedFile = moved.node.manifestFile;
    moved.node.nameReading = value(OTHER_ROOT);
    const writes = moved.node.manifestWrites;
    await expect(resume(moved)).rejects.toMatchObject({ code: "overlapping-publish" });
    expect(moved.node.manifestWrites).toBe(writes);
    expect(moved.node.manifestFile).toEqual(damagedFile);

    const steady = await killedAt("manifest-write");
    steady.node.manifestFile = good.slice(0, Math.floor(good.length / 2));
    steady.node.nameReading = value(ROOT_1);
    expect((await resume(steady)).kind).toBe("completed");
  });

  it("a rewrite brings a journal to format 2 with the start root it compared against", async () => {
    const s = await killedAt("manifest-write", undefined);
    // a format 1 journal: strip the start root from what the commit wrote
    const read = await readJournal(s.host.kv, MFS_ROOT);
    if (read.kind !== "ok") throw new Error("journal expected");
    await writeJournal(s.host.kv, { ...read.journal, startRoot: undefined });
    const good = new Uint8Array(s.node.manifestFile ?? new Uint8Array());
    s.node.manifestFile = good.slice(0, Math.floor(good.length / 2));
    // the state's rootCid stands in for the unknown start root
    s.node.nameReading = value(s.state1.rootCid ?? "");
    const killing = { ...s.deps, node: { ...s.deps.node, readHistoryFile: async (): Promise<never> => { throw new Killed("rewrite"); } } };
    await expect(resume(s, killing)).rejects.toBeInstanceOf(Killed);
    expect(await readJournal(s.host.kv, MFS_ROOT)).toMatchObject({ kind: "ok", journal: { version: 2, startRoot: s.state1.rootCid } });
  });

  it("a format 1 journal compares the name with the state's root: equal proceeds, different is an overlap", async () => {
    for (const [name, expected] of [[ROOT_1, "completed"], [OTHER_ROOT, "overlap"]] as const) {
      const s = await killedAt("manifest-write", undefined);
      const read = await readJournal(s.host.kv, MFS_ROOT);
      if (read.kind !== "ok") throw new Error("journal expected");
      await writeJournal(s.host.kv, { ...read.journal, startRoot: undefined });
      expect(JSON.parse(new TextDecoder().decode((await s.host.kv.get(rootFileNames(MFS_ROOT).journal)) ?? new Uint8Array()))).toMatchObject({ version: 1 });
      s.node.nameReading = value(name);
      if (expected === "completed") {
        expect((await resume(s)).kind).toBe("completed");
        expect(s.node.publishStarts).toEqual([{ root: s.state1.rootCid, firstPublish: false }]);
      } else {
        await expect(resume(s)).rejects.toMatchObject({ code: "overlapping-publish" });
        expect(s.node.publishes).toEqual([]);
      }
    }
  });

  it("a format 1 journal with no state at all stands in with no record", async () => {
    const s = await killedAt("manifest-write", undefined);
    const read = await readJournal(s.host.kv, MFS_ROOT);
    if (read.kind !== "ok") throw new Error("journal expected");
    await writeJournal(s.host.kv, { ...read.journal, startRoot: undefined });
    s.node.nameReading = NOT_FOUND;
    const outcome = await resumeJournal(s.deps, { target: s.target, state: undefined });
    expect(outcome.kind).toBe("completed");
    expect(s.node.publishStarts).toEqual([{ root: null, firstPublish: false }]);
  });
});

/** Item (ii) of the 2026-10-01 routing: a resumed publish raises the sequence floor through the commit deps. */
describe("the sequence floor is raised in finishPublish, for a fresh and a resumed publish, and never by adopt", () => {
  interface Ledger {
    readonly order: string[];
    readonly raised: { vaultId: string; sequence: number; identity: string }[];
    readonly deps: (s: Scenario) => CommitDeps;
  }

  function ledger(): Ledger {
    const order: string[] = [];
    const raised: Ledger["raised"] = [];
    const stateFile = rootFileNames(MFS_ROOT).state;
    return {
      order,
      raised,
      deps: (s) => ({
        ...s.deps,
        floor: {
          raise: async (vaultId, sequence, identity) => {
            order.push("floor");
            raised.push({ vaultId, sequence, identity });
          },
        },
        kv: {
          get: (key) => s.deps.kv.get(key),
          delete: (key) => s.deps.kv.delete(key),
          set: async (key, bytes) => {
            if (key === stateFile) order.push("state");
            await s.deps.kv.set(key, bytes);
          },
        },
      }),
    };
  }

  it("a fresh commit raises the floor once, before it writes the state", async () => {
    const s = await scenario();
    const run = ledger();
    const { manifest, file } = await s.next(2, PATHS_V2);
    await commitPublish(run.deps(s), { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: s.state1.rootCid, nameStart: START });
    expect(run.order).toEqual(["floor", "state"]);
    expect(run.raised).toEqual([{ vaultId: s.keys.vaultId, sequence: 2, identity: manifestIdentity(manifest) }]);
  });

  it("a RESUMED publish (finished through the journal) raises the floor once, before the state", async () => {
    for (const step of ["manifest-write", "history-write", "pin"] as const) {
      const s = await killedAt(step);
      s.node.nameReading = value(ROOT_1);
      const run = ledger();
      const outcome = await resume(s, run.deps(s));
      expect(outcome.kind, step).toBe("completed");
      expect(run.order, step).toEqual(["floor", "state"]);
      expect(run.raised, step).toHaveLength(1);
      expect(run.raised[0]).toMatchObject({ vaultId: s.keys.vaultId, sequence: 2 });
      const state = await readRootState(s.host.kv, MFS_ROOT);
      expect(run.raised[0]?.identity).toBe(state?.highestIdentity);
    }
  });

  it("a resume that only settles a finished publish (state already written) raises nothing", async () => {
    const s = await killedAt("state-write");
    const run = ledger();
    const outcome = await resume(s, run.deps(s));
    expect(outcome.kind).toBe("settled");
    expect(run.order).toEqual([]);
  });

  it("adopt does not touch the floor", async () => {
    const s = await killedAt("manifest-write");
    s.node.plantUnderCurrent();
    s.node.nameReading = value(ROOT_1);
    const run = ledger();
    const outcome = await resume(s, run.deps(s));
    expect(outcome.kind).toBe("adopted");
    expect(run.raised).toEqual([]);
    expect(run.order).toEqual(["state"]);
  });

  it("a failed floor write stops the publish before the state is written", async () => {
    const s = await killedAt("manifest-write");
    s.node.nameReading = value(ROOT_1);
    const failing: CommitDeps = { ...s.deps, floor: { raise: async () => { throw new Error("device store unavailable"); } } };
    await expect(resume(s, failing)).rejects.toThrow(/device store unavailable/);
    expect((await readRootState(s.host.kv, MFS_ROOT))?.sequence).toBe(1);
    expect(await journalPresent(s)).toBe(true);
  });
});
