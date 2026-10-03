import { describe, expect, it } from "vitest";
import { decodeManifestFile } from "../../src/sync/encrypted-manifest";
import { commitPublish } from "../../src/sync/publish-commit";
import * as refusals from "../../src/sync/publish-refusals";
import { authorizeRepair, planRepair, type RepairFacts } from "../../src/sync/repair";
import { rootFileNames } from "../../src/sync/root-files";
import { RootStateError } from "../../src/sync/local-record";
import { readRootState, writeRootState } from "../../src/sync/root-state";
import { StateError } from "../../src/sync/state";
import { assertSequenceAllowsPublish, classifySequence } from "../../src/sync/sequence-rules";
import { MFS_ROOT, scenario, type Scenario } from "../helpers/commit-scenario";

const SLOTS = new TextEncoder().encode('{\n  "slots": [],\n  "vaultId": "x",\n  "version": 1\n}\n');
const PATHS = ["notes/a.md", "notes/b.md"] as const;

async function publishSecond(s: Scenario): Promise<void> {
  const { manifest, file } = await s.next(2, [...PATHS, "notes/c.md"]);
  await commitPublish(s.deps, { target: s.target, manifest, manifestFile: file, mtimes: { "notes/c.md": 2 }, previousRootCid: s.state1.rootCid });
}

async function facts(s: Scenario, overrides: Partial<RepairFacts> = {}): Promise<RepairFacts> {
  const local = await readRootState(s.host.kv, MFS_ROOT);
  const node = s.node.manifestFile === undefined ? undefined : await decodeManifestFile(s.keys, s.node.manifestFile);
  return { verdict: classifySequence(local, node), local, node, vaultId: s.keys.vaultId, nodeKeyslots: SLOTS, localKeyslots: SLOTS, ...overrides };
}

describe("sequence rules", () => {
  it("first publish, in sync, behind, ahead, fork and lost manifest are told apart", async () => {
    const s = await scenario();
    const node1 = await decodeManifestFile(s.keys, s.file1);
    expect(classifySequence(undefined, undefined)).toEqual({ kind: "first-publish" });
    expect(classifySequence(s.state1, node1)).toEqual({ kind: "in-sync" });
    expect(classifySequence(s.state1, undefined)).toEqual({ kind: "node-manifest-missing" });
    expect(classifySequence(undefined, node1)).toEqual({ kind: "ahead", node: 1, local: undefined });
    expect(classifySequence({ ...s.state1, sequence: 2 }, node1)).toEqual({ kind: "behind", node: 1, local: 2 });
    expect(classifySequence({ ...s.state1, sequence: 0 }, node1)).toEqual({ kind: "ahead", node: 1, local: 0 });
    const forked = { ...s.state1, manifest: { ...s.state1.manifest, rootCID: `b${"a".repeat(20)}` } };
    expect(classifySequence(forked, node1)).toEqual({ kind: "fork", sequence: 1 });
  });

  it("only first-publish and in-sync allow a publish; every other verdict is a named refusal that never advises deleting state", () => {
    expect(() => assertSequenceAllowsPublish({ kind: "first-publish" })).not.toThrow();
    expect(() => assertSequenceAllowsPublish({ kind: "in-sync" })).not.toThrow();
    const cases = [
      [{ kind: "behind", node: 1, local: 3 }, "sequence-behind", true],
      [{ kind: "ahead", node: 4, local: 2 }, "sequence-ahead", false],
      [{ kind: "ahead", node: 4, local: undefined }, "sequence-ahead", false],
      [{ kind: "fork", sequence: 2 }, "sequence-fork", false],
      [{ kind: "node-manifest-missing" }, "node-manifest-missing", true],
      [{ kind: "node-manifest-unreadable" }, "node-manifest-unreadable", true],
    ] as const;
    for (const [verdict, code, namesRepair] of cases) {
      const error = (() => {
        try {
          assertSequenceAllowsPublish(verdict);
        } catch (e) {
          return e as refusals.PublishRefusedError;
        }
        throw new Error("expected a refusal");
      })();
      expect(error.code).toBe(code);
      expect(error.message.includes("--repair")).toBe(namesRepair);
      expect(error.message).not.toMatch(/delete|remove .*state|rm /i);
    }
  });

  it("no refusal or record error text advises deleting local state", () => {
    const texts = [
      refusals.sequenceBehind(1, 2).message,
      refusals.sequenceAhead(3, 1).message,
      refusals.sequenceFork(2).message,
      refusals.nodeManifestMissing().message,
      refusals.journalMismatch("vault").message,
      refusals.journalConflict(2, 3).message,
      refusals.journalOutOfStep(4, 1).message,
      refusals.journalManifestMismatch(2, "content").message,
      refusals.historyConflict().message,
      refusals.repairRefused("x").message,
      refusals.repairDeclined().message,
      refusals.lockHeld("process 1 on h, last heartbeat 3 s ago").message,
      refusals.lockUnreadable().message,
      refusals.lockLost().message,
      new RootStateError("state is not valid JSON").message,
      new StateError("state is not valid JSON").message,
    ];
    for (const text of texts) expect(text).not.toMatch(/\bdelet|\bremove\b.*\b(state|record)\b|force a full publish/i);
  });
});

describe("--repair", () => {
  it("succeeds for an older genuine manifest replayed on the node, and the next publish is one above the local sequence", async () => {
    const s = await scenario();
    await publishSecond(s);
    // the node serves the genuine manifest of sequence 1 again
    s.node.manifestFile = s.file1;
    const f = await facts(s);
    expect(f.verdict).toEqual({ kind: "behind", node: 1, local: 2 });
    await expect(authorizeRepair(s.host.kv, MFS_ROOT, f, undefined)).resolves.toEqual({ kind: "behind", nextSequence: 3, warning: undefined });
    const { manifest, file } = await s.next(3, [...PATHS, "notes/c.md", "notes/d.md"]);
    const state = await commitPublish(s.deps, { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: null });
    expect(state.sequence).toBe(3);
    const node = await decodeManifestFile(s.keys, s.node.manifestFile ?? new Uint8Array());
    expect(classifySequence(state, node)).toEqual({ kind: "in-sync" });
  });

  const FLOOR = { sequence: 2, identity: "a".repeat(64), at: 1 } as const;

  it("a restored backup (the local record is older than the node but decodes) is refused: pull first", async () => {
    const s = await scenario();
    await publishSecond(s);
    await writeRootState(s.host.kv, s.state1); // restore the sequence-1 record
    const f = await facts(s);
    expect(f.verdict).toEqual({ kind: "ahead", node: 2, local: 1 });
    const error = await Promise.resolve().then(() => planRepair(f)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "repair-refused" });
    expect((error as Error).message).toContain("pull first");
    await expect(authorizeRepair(s.host.kv, MFS_ROOT, f, async () => true)).rejects.toMatchObject({ code: "repair-refused" });
  });

  it("with no local record and no floor it is a new device: refused, pull first", async () => {
    const s = await scenario();
    await s.host.kv.delete(rootFileNames(MFS_ROOT).state);
    const f = await facts(s);
    expect(() => planRepair(f)).toThrow(/pull first/);
    expect(() => planRepair({ ...f, stateUndecodable: false })).toThrow(/new device/);
  });

  it("after .ipfs-sync/ was deleted (a floor exists, no state) the ahead case is refused: pull first", async () => {
    const s = await scenario();
    await s.host.kv.delete(rootFileNames(MFS_ROOT).state);
    const f = await facts(s, { floor: FLOOR });
    expect(() => planRepair(f)).toThrow(/sequence floor/);
    expect(() => planRepair(f)).toThrow(/pull first/);
    // also when a state file exists but does not decode: the floor wins
    expect(() => planRepair({ ...f, stateUndecodable: true })).toThrow(/pull first/);
  });

  it("a floor refuses the ahead case even when the local record decodes", async () => {
    const s = await scenario();
    await publishSecond(s);
    await writeRootState(s.host.kv, s.state1);
    const f = await facts(s, { floor: FLOOR });
    expect(() => planRepair(f)).toThrow(/sequence floor/);
  });

  it("review-final A-02: a behind or rebuild repair publishes above the sequence floor, never at or below it", async () => {
    const s = await scenario();
    await publishSecond(s);
    const high = { ...FLOOR, sequence: 9 };
    s.node.manifestFile = s.file1;
    const behind = await facts(s, { floor: high });
    expect(behind.verdict).toMatchObject({ kind: "behind" });
    expect(planRepair(behind)).toMatchObject({ kind: "behind", nextSequence: 10 });
    // a rebuild starts from this device's record: below the floor (or with no record) it is refused, and says pull first
    s.node.manifestFile = undefined;
    const rebuild = await facts(s, { floor: high, recordSequence: 2 });
    expect(() => planRepair(rebuild)).toThrow(expect.objectContaining({ code: "sequence-below-floor" }));
    expect(() => planRepair({ ...rebuild, local: undefined, recordSequence: 2 })).toThrow(/pull first/);
    // at or above the floor it goes ahead, and a floor below the other sequences changes nothing
    expect(planRepair({ ...rebuild, floor: { ...FLOOR, sequence: 2 } })).toMatchObject({ kind: "rebuild", nextSequence: 3 });
    expect(planRepair({ ...rebuild, floor: { ...FLOOR, sequence: 1 } })).toMatchObject({ kind: "rebuild", nextSequence: 3 });
  });

  it("an unreadable state file with no floor still reaches the confirmation, whose warning recommends pull", async () => {
    const s = await scenario();
    await s.host.kv.delete(rootFileNames(MFS_ROOT).state);
    const f = await facts(s, { stateUndecodable: true });
    const asked: string[] = [];
    const plan = await authorizeRepair(s.host.kv, MFS_ROOT, f, async (warning) => (asked.push(warning), true));
    expect(plan).toMatchObject({ kind: "ahead", nextSequence: 2 });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("Changes made by any other publisher");
    expect(asked[0]).toContain("run pull");
  });

  it("the ahead case (unreadable state, no floor) is refused when the user declines, and when the run cannot ask", async () => {
    const s = await scenario();
    await publishSecond(s);
    await s.host.kv.delete(rootFileNames(MFS_ROOT).state);
    const f = await facts(s, { stateUndecodable: true });
    await expect(authorizeRepair(s.host.kv, MFS_ROOT, f, async () => false)).rejects.toMatchObject({ code: "repair-declined" });
    await expect(authorizeRepair(s.host.kv, MFS_ROOT, f, undefined)).rejects.toMatchObject({ code: "repair-refused" });
  });

  it("is refused when the node's slot file differs from the local copy by one byte", async () => {
    const s = await scenario();
    await publishSecond(s);
    s.node.manifestFile = s.file1;
    const other = new Uint8Array(SLOTS);
    other[3] = (other[3] ?? 0) ^ 1;
    const f = await facts(s, { nodeKeyslots: other });
    expect(() => planRepair(f)).toThrowError(/key-slot file differs/);
    await expect(authorizeRepair(s.host.kv, MFS_ROOT, f, undefined)).rejects.toMatchObject({ code: "repair-refused" });
  });

  it.each([
    ["no local copy of the slot file", { localKeyslots: undefined }, /no copy of the key-slot file/],
    ["no node slot file", { nodeKeyslots: undefined }, /key-slot file differs/],
    ["a manifest that does not authenticate", { node: undefined }, /missing or does not authenticate/],
    ["another vault on the node", { vaultId: "2".repeat(32) }, /another vault/],
  ] as const)("is refused with %s", async (_label, override, message) => {
    const s = await scenario();
    await publishSecond(s);
    s.node.manifestFile = s.file1;
    const f = { ...(await facts(s)), ...override };
    expect(() => planRepair(f)).toThrowError(message);
  });

  it("is refused when the sequences already agree and for a fork", async () => {
    const s = await scenario();
    const agreed = await facts(s);
    expect(() => planRepair(agreed)).toThrowError(/do not need repairing/);
    const fork = await facts(s, { verdict: { kind: "fork", sequence: 1 } });
    expect(() => planRepair(fork)).toThrowError(/different manifest at the same sequence/);
  });

  it("a successful repair drops the journal of an interrupted publish", async () => {
    const s = await scenario();
    await publishSecond(s);
    s.node.manifestFile = s.file1;
    await s.host.kv.set(rootFileNames(MFS_ROOT).journal, new TextEncoder().encode("{}"));
    await authorizeRepair(s.host.kv, MFS_ROOT, await facts(s), undefined);
    expect(await s.host.kv.get(rootFileNames(MFS_ROOT).journal)).toBeUndefined();
  });

  it("a refused repair leaves the journal alone", async () => {
    const s = await scenario();
    await s.host.kv.set(rootFileNames(MFS_ROOT).journal, new TextEncoder().encode("{}"));
    await expect(authorizeRepair(s.host.kv, MFS_ROOT, await facts(s), undefined)).rejects.toMatchObject({ code: "repair-refused" });
    expect(await s.host.kv.get(rootFileNames(MFS_ROOT).journal)).toBeDefined();
  });
});

