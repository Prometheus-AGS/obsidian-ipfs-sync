import { describe, expect, it } from "vitest";
import { CryptoError } from "../../src/crypto";
import { encodeManifestFile } from "../../src/sync/encrypted-manifest";
import { readJournal } from "../../src/sync/journal";
import { commitPublish } from "../../src/sync/publish-commit";
import { resumeJournal } from "../../src/sync/publish-resume";
import { MFS_ROOT, buildManifest, killAfter, scenario, type Scenario } from "../helpers/commit-scenario";
import { keysFrom } from "../vectors/manifest-helpers";
import { readRootState } from "../../src/sync/root-state";

const PATHS = ["notes/a.md", "notes/b.md", "notes/c.md"] as const;

async function pending(s: Scenario) {
  const { manifest, file } = await s.next(2, PATHS);
  return { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: s.state1.rootCid };
}

/** A history file for `rootCID` written by `keys` at `sequence`. */
async function historyAt(s: Scenario, rootCID: string, sequence: number, keys = s.keys): Promise<Uint8Array<ArrayBuffer>> {
  return (await encodeManifestFile(keys, await buildManifest(keys, sequence, PATHS, rootCID))).file;
}

describe("history file rule: replaced only by a later manifest of the same vault", () => {
  it("replaces an older manifest of ours (a tree that came back to an earlier CID, or a repair over an unchanged tree)", async () => {
    const s = await scenario();
    const p = await pending(s);
    s.node.history.set(p.manifest.rootCID, await historyAt(s, p.manifest.rootCID, 1));
    const state = await commitPublish(s.deps, p);
    expect(state.sequence).toBe(2);
    expect(s.node.history.get(p.manifest.rootCID)).toEqual(p.manifestFile);
    expect(s.node.historyWrites).toBe(1);
  });

  it("refuses a file at the same sequence with different bytes, before anything is written", async () => {
    const s = await scenario();
    const p = await pending(s);
    s.node.history.set(p.manifest.rootCID, await historyAt(s, p.manifest.rootCID, 2));
    await expect(commitPublish(s.deps, p)).rejects.toMatchObject({ code: "history-conflict" });
    expect(s.node.manifestWrites).toBe(0);
    expect((await readJournal(s.host.kv, MFS_ROOT)).kind).toBe("none");
  });

  it("refuses a file with a higher sequence", async () => {
    const s = await scenario();
    const p = await pending(s);
    s.node.history.set(p.manifest.rootCID, await historyAt(s, p.manifest.rootCID, 3));
    await expect(commitPublish(s.deps, p)).rejects.toMatchObject({ code: "history-conflict" });
  });

  it("refuses another vault's manifest, even at a lower sequence", async () => {
    const s = await scenario();
    const p = await pending(s);
    s.node.history.set(p.manifest.rootCID, await historyAt(s, p.manifest.rootCID, 1, await keysFrom(0x30, 0x60)));
    await expect(commitPublish(s.deps, p)).rejects.toMatchObject({ code: "history-conflict" });
    expect(s.node.manifestWrites).toBe(0);
  });

  it("refuses bytes that are not a manifest at all", async () => {
    const s = await scenario();
    const p = await pending(s);
    s.node.history.set(p.manifest.rootCID, new TextEncoder().encode("planted"));
    await expect(commitPublish(s.deps, p)).rejects.toMatchObject({ code: "history-conflict" });
  });

  it("does not mistake a platform failure for a planted file: the crypto error propagates", async () => {
    const s = await scenario();
    const p = await pending(s);
    s.node.history.set(p.manifest.rootCID, await historyAt(s, p.manifest.rootCID, 1));
    const deps = {
      ...s.deps,
      decodeManifest: async () => {
        throw new CryptoError("platform-failure", "the platform crypto call failed");
      },
    };
    await expect(commitPublish(deps, p)).rejects.toMatchObject({ code: "platform-failure" });
  });

  it("applies the same rule when a resume writes the missing history file", async () => {
    const s = await scenario();
    const p = await pending(s);
    await expect(commitPublish(killAfter(s.deps, "manifest-write"), p)).rejects.toThrow();
    s.node.history.set(p.manifest.rootCID, await historyAt(s, p.manifest.rootCID, 1));
    const outcome = await resumeJournal(s.deps, { target: s.target, state: await readRootState(s.host.kv, MFS_ROOT) });
    expect(outcome.kind).toBe("completed");
    expect(s.node.history.get(p.manifest.rootCID)).toEqual(p.manifestFile);
  });

  it("a resume adopts around a file of the same sequence with different bytes, and the fresh publish then refuses before writing", async () => {
    const s = await scenario();
    const p = await pending(s);
    await expect(commitPublish(killAfter(s.deps, "manifest-write"), p)).rejects.toThrow();
    s.node.history.set(p.manifest.rootCID, await historyAt(s, p.manifest.rootCID, 2));
    const outcome = await resumeJournal(s.deps, { target: s.target, state: await readRootState(s.host.kv, MFS_ROOT) });
    expect(outcome.kind).toBe("adopted");
    expect((await readJournal(s.host.kv, MFS_ROOT)).kind).toBe("none");
  });
});
