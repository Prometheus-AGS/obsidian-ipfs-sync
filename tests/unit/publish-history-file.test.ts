import { describe, expect, it } from "vitest";
import { CryptoError } from "../../src/crypto";
import { encodeManifestFile, type EncryptedManifest } from "../../src/sync/encrypted-manifest";
import { readJournal } from "../../src/sync/journal";
import { commitPublish } from "../../src/sync/publish-commit";
import { resumeJournal } from "../../src/sync/publish-resume";
import { MFS_ROOT, buildManifest, historyKey, killAfter, scenario, type Scenario } from "../helpers/commit-scenario";
import { keysFrom } from "../vectors/manifest-helpers";
import { readRootState } from "../../src/sync/root-state";

const PATHS = ["notes/a.md", "notes/b.md", "notes/c.md"] as const;

async function pending(s: Scenario) {
  const { manifest, file } = await s.next(2, PATHS);
  return { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: s.state1.rootCid };
}

/** A history file holding a manifest of `keys` at `sequence` over `rootCID` (a fresh encryption every call). */
async function historyAt(s: Scenario, rootCID: string, sequence: number, keys = s.keys): Promise<Uint8Array<ArrayBuffer>> {
  return (await encodeManifestFile(keys, await buildManifest(keys, sequence, PATHS, rootCID))).file;
}

/** The pending manifest encrypted again (same plaintext, other nonce): what a resume that re-encrypts produces. */
async function reEncrypted(s: Scenario, manifest: EncryptedManifest): Promise<Uint8Array<ArrayBuffer>> {
  return (await encodeManifestFile(s.keys, manifest)).file;
}

describe("history file name: one file per sequence and tree", () => {
  it("a publish writes manifests/<16-digit sequence>-<cid>.enc and nothing at the legacy name", async () => {
    const s = await scenario();
    const p = await pending(s);
    await commitPublish(s.deps, p);
    expect(historyKey(p.manifest)).toBe(`0000000000000002-${p.manifest.rootCID}.enc`);
    expect(s.node.history.get(historyKey(p.manifest))).toEqual(p.manifestFile);
    expect(s.node.history.has(`${p.manifest.rootCID}.enc`)).toBe(false);
  });

  it("two sequences over one tree CID keep two files (an edit that was reverted)", async () => {
    const s = await scenario();
    const p2 = await pending(s);
    await commitPublish(s.deps, p2);
    // sequence 3 restores the very tree of sequence 2
    const manifest3 = await buildManifest(s.keys, 3, PATHS, p2.manifest.rootCID);
    const file3 = await reEncrypted(s, manifest3);
    await commitPublish(s.deps, { target: s.target, manifest: manifest3, manifestFile: file3, mtimes: {}, previousRootCid: null });
    expect(s.node.history.get(historyKey(p2.manifest))).toEqual(p2.manifestFile);
    expect(s.node.history.get(historyKey(manifest3))).toEqual(file3);
    expect([...s.node.history.keys()].filter((name) => name.endsWith(`-${p2.manifest.rootCID}.enc`))).toHaveLength(2);
  });

  it("a legacy file for the same tree is neither read as the history file nor replaced", async () => {
    const s = await scenario();
    const p = await pending(s);
    const legacy = new TextEncoder().encode("legacy");
    s.node.history.set(`${p.manifest.rootCID}.enc`, legacy);
    await commitPublish(s.deps, p);
    expect(s.node.history.get(`${p.manifest.rootCID}.enc`)).toEqual(legacy);
    expect(s.node.history.get(historyKey(p.manifest))).toEqual(p.manifestFile);
  });
});

describe("history file rule: replaced only by the same manifest, encrypted again", () => {
  it("replaces a file of the same vault, sequence and manifest identity with other bytes (a resume that re-encrypted)", async () => {
    const s = await scenario();
    const p = await pending(s);
    s.node.history.set(historyKey(p.manifest), await reEncrypted(s, p.manifest));
    const state = await commitPublish(s.deps, p);
    expect(state.sequence).toBe(2);
    expect(s.node.history.get(historyKey(p.manifest))).toEqual(p.manifestFile);
    expect(s.node.historyWrites).toBe(1);
  });

  it("does not write again when the file already holds the bytes", async () => {
    const s = await scenario();
    const p = await pending(s);
    s.node.history.set(historyKey(p.manifest), p.manifestFile);
    await commitPublish(s.deps, p);
    expect(s.node.historyWrites).toBe(0);
  });

  it("refuses a file at the expected name that authenticates as another sequence, before anything is written", async () => {
    for (const sequence of [1, 3]) {
      const s = await scenario();
      const p = await pending(s);
      s.node.history.set(historyKey(p.manifest), await historyAt(s, p.manifest.rootCID, sequence));
      await expect(commitPublish(s.deps, p)).rejects.toMatchObject({ code: "history-conflict" });
      expect(s.node.manifestWrites).toBe(0);
      expect(s.node.historyWrites).toBe(0);
      expect((await readJournal(s.host.kv, MFS_ROOT)).kind).toBe("none");
    }
  });

  it("refuses a file of the same sequence with another manifest identity (another publisher or device)", async () => {
    const s = await scenario();
    const p = await pending(s);
    const other = { ...p.manifest, device: "another-device" };
    s.node.history.set(historyKey(p.manifest), await reEncrypted(s, other));
    await expect(commitPublish(s.deps, p)).rejects.toMatchObject({ code: "history-conflict" });
    expect(s.node.manifestWrites).toBe(0);
    expect((await readJournal(s.host.kv, MFS_ROOT)).kind).toBe("none");
  });

  it("refuses another vault's manifest at the same sequence", async () => {
    const s = await scenario();
    const p = await pending(s);
    s.node.history.set(historyKey(p.manifest), await historyAt(s, p.manifest.rootCID, 2, await keysFrom(0x30, 0x60)));
    await expect(commitPublish(s.deps, p)).rejects.toMatchObject({ code: "history-conflict" });
    expect(s.node.manifestWrites).toBe(0);
  });

  it("refuses bytes that are not a manifest at all", async () => {
    const s = await scenario();
    const p = await pending(s);
    s.node.history.set(historyKey(p.manifest), new TextEncoder().encode("planted"));
    await expect(commitPublish(s.deps, p)).rejects.toMatchObject({ code: "history-conflict" });
    expect(s.node.manifestWrites).toBe(0);
  });

  it("does not mistake a platform failure for a planted file: the crypto error propagates", async () => {
    const s = await scenario();
    const p = await pending(s);
    s.node.history.set(historyKey(p.manifest), await reEncrypted(s, p.manifest));
    const deps = {
      ...s.deps,
      decodeManifest: async () => {
        throw new CryptoError("platform-failure", "the platform crypto call failed");
      },
    };
    await expect(commitPublish(deps, p)).rejects.toMatchObject({ code: "platform-failure" });
  });

  it("applies the same rule when a resume writes the missing history file: the same manifest encrypted again is replaced", async () => {
    const s = await scenario();
    const p = await pending(s);
    await expect(commitPublish(killAfter(s.deps, "manifest-write"), p)).rejects.toThrow();
    s.node.history.set(historyKey(p.manifest), await reEncrypted(s, p.manifest));
    const outcome = await resumeJournal(s.deps, { target: s.target, state: await readRootState(s.host.kv, MFS_ROOT) });
    expect(outcome.kind).toBe("completed");
    expect(s.node.history.get(historyKey(p.manifest))).toEqual(p.manifestFile);
  });

  it("a resume adopts around a planted file at the expected name, and the journal does not wedge", async () => {
    const s = await scenario();
    const p = await pending(s);
    await expect(commitPublish(killAfter(s.deps, "manifest-write"), p)).rejects.toThrow();
    s.node.history.set(historyKey(p.manifest), await historyAt(s, p.manifest.rootCID, 1));
    const outcome = await resumeJournal(s.deps, { target: s.target, state: await readRootState(s.host.kv, MFS_ROOT) });
    expect(outcome.kind).toBe("adopted");
    expect((await readJournal(s.host.kv, MFS_ROOT)).kind).toBe("none");
  });
});
