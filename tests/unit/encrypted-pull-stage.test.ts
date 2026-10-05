// mvp-07a task 4.6b: the decrypting pull, steps 7 and 8 (plan, large-pull confirmation, fetch and verify, conflict copy,
// rename, baseline and state write, journal set-aside). A recording node serves a real encrypted vault published by device A;
// device B pulls it through the whole production path (`pullEncryptedVault`: steps 1 to 6 and the stage).
import { describe, expect, it } from "vitest";
import { blobNameFor } from "../../src/crypto";
import { KuboHttpError, type KuboClient } from "../../src/kubo";
import { createRangedBlobSources } from "../../src/sync/blob-source";
import { localDateStamp } from "../../src/sync/conflict-name";
import { createFilesMap, encodeManifestFile, serializeManifestV2, type EncryptedManifest } from "../../src/sync/encrypted-manifest";
import { HostPathError } from "../../src/sync/host-errors";
import { buildJournal, readJournal, writeJournal } from "../../src/sync/journal";
import { rootFileNames } from "../../src/sync/root-files";
import { SEQUENCE_FLOOR_FILE } from "../../src/sync/sequence-floor";
import { newPuller, NOW, currentRoot, expectOnlyReads, pointNameAt, publishedOnce, publishAgain, resetNodeTrace, servedRoot } from "../helpers/encrypted-pull-rig";
import type { FakeNode } from "../helpers/fake-kubo";
import { KEY, ROOT, blobPaths, type Rig } from "../helpers/publish-rig";
import { partFiles, publishAsSecondDevice, pulledOf, runVaultPull, sourceTexts, stateOf, streamingSources, vaultTexts } from "../helpers/pull-stage-rig";
import { seal } from "../vectors/manifest-helpers";

const DAILY = "Daily/2026-09-30.md";
const PLAN = "Projects/Secret Merger/Quarterly plan.md";
const BINARY = "attachment.bin";
const BLOB_GET = /^GET \S+\/[a-z2-7]{2}\/[a-z2-7]{52}/;

const blobGets = (node: FakeNode): string[] => node.calls.filter((line) => BLOB_GET.test(line));

async function publishEdits(rig: Rig, edits: Record<string, string>): Promise<string> {
  rig.host.clock += 60_000;
  for (const [path, text] of Object.entries(edits)) rig.host.put(path, text);
  await rig.publish();
  const root = servedRoot(rig.node);
  resetNodeTrace(rig.node);
  return root;
}

/** The real manifest plus entries for extra paths (blob names are the real HMACs, so the codec accepts them). Replaces `manifest.enc` and repoints the name. */
async function forgeWithPaths(rig: Rig, extra: readonly string[]): Promise<EncryptedManifest> {
  const keys = await rig.keys();
  const real = await rig.manifest();
  const template = Object.values(real.files)[0];
  if (template === undefined) throw new Error("the vault has no file");
  const files = createFilesMap(Object.entries(real.files));
  for (const [index, path] of extra.entries()) {
    files[path] = { ...template, blob: await blobNameFor(keys, path), fileId: (index + 1).toString(16).padStart(32, "0") };
  }
  const forged: EncryptedManifest = { ...real, files };
  rig.node.files.set(`${ROOT}/manifest.enc`, (await encodeManifestFile(keys, forged)).file);
  pointNameAt(rig.node);
  resetNodeTrace(rig.node);
  return forged;
}

async function realRoots(rig: Rig): Promise<{ manifest: EncryptedManifest }> {
  return { manifest: await rig.manifest() };
}

describe("a fresh directory pulls a vault published by another device", () => {
  it("restores every file byte for byte, writes the state the design lists, and a publish with no edit has no work", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    const { verified, result } = pulledOf(await runVaultPull(rig, b));

    expect(vaultTexts(b.host)).toEqual(sourceTexts(rig));
    expect(Object.keys(vaultTexts(b.host)).sort()).toEqual([BINARY, DAILY, PLAN].sort());
    expect(result.verdict).toBe("first-pull");
    expect([...result.settlement.fetched].sort()).toEqual([BINARY, DAILY, PLAN].sort());
    expect(result.settlement.needsAttention).toBe(false);
    expect(partFiles(b.host)).toEqual([]);
    expectOnlyReads(rig.node);

    const state = await stateOf(b.host);
    expect(state).toBeDefined();
    expect(state).toMatchObject({
      mfsRoot: ROOT,
      key: KEY,
      rootCid: currentRoot(rig.node),
      sequence: 1,
      highestSequence: 1,
      manifestIdentity: verified.identity,
      highestIdentity: verified.identity,
      previousIdentity: null,
      complete: true,
      unmaterialized: [],
      keyslotsSha256: verified.unlock.keySlotsSha256,
    });
    expect(state?.devicesSeen).toEqual([verified.manifest.device]);
    expect(state?.restoredFrom).toBeUndefined();
    expect(Object.keys(state?.mtimes ?? {}).sort()).toEqual([BINARY, DAILY, PLAN].sort());
    expect(state?.manifest.files).toEqual(verified.manifest.files);

    // The guard is removed: the pull writes no marker, and the second device publishes without a hand step.
    expect(b.host.files.get(".ipfs-sync-fixture")).toBeUndefined();
    expect(result.markerWritten).toBe(false);
    resetNodeTrace(rig.node);
    const published = await publishAsSecondDevice(rig, b);
    expect(published.published).toBe(false);
    expect(rig.node.calls.filter((line) => /^(write|rm|pin|publish|keyGen) /.test(line))).toEqual([]);
  });

  it("a second pull of the same sequence fetches nothing and hashes nothing (the size-and-mtime shortcut)", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    pulledOf(await runVaultPull(rig, b));
    resetNodeTrace(rig.node);
    const { result } = pulledOf(await runVaultPull(rig, b));
    expect(result.verdict).toBe("same");
    expect(blobGets(rig.node)).toEqual([]);
    expect(result.hashedLocalFiles).toBe(0);
    expect([...result.settlement.unchanged].sort()).toEqual([BINARY, DAILY, PLAN].sort());
    expect(result.markerWritten).toBe(false);
  });

  it("a different exclusion list warns once and verifies every local file by content", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    const first = pulledOf(await runVaultPull(rig, b));
    expect(first.result.exclusionWarning).toBeUndefined();
    const { result } = pulledOf(await runVaultPull(rig, b, { options: { extraExclusions: ["private/"] } }));
    expect(result.exclusionWarning).toMatch(/exclusion lists differ/);
    expect(result.hashedLocalFiles).toBe(3);
    expect(result.settlement.unchanged).toHaveLength(3);
  });
});

describe("blobs come from the authenticated tree, never from the root's current/", () => {
  it("a node root whose current/ differs from the authenticated tree: files come from the authenticated tree", async () => {
    const rig = await publishedOnce();
    const { manifest } = await realRoots(rig);
    // A hostile writer replaces every blob in the mutable tree and repoints the name; manifest.enc is untouched.
    for (const path of blobPaths(rig.node)) rig.node.files.set(path, new Uint8Array((rig.node.files.get(path) as Uint8Array).length).fill(0xaa));
    pointNameAt(rig.node);
    const tamperedCurrent = rig.node.cidOf(`${ROOT}/current`);
    expect(tamperedCurrent).toBeDefined();
    expect(tamperedCurrent).not.toBe(manifest.rootCID);
    resetNodeTrace(rig.node);

    const b = newPuller();
    const { result } = pulledOf(await runVaultPull(rig, b));
    expect(vaultTexts(b.host)).toEqual(sourceTexts(rig));
    expect(result.settlement.integrityFailed).toEqual([]);
    // Every blob request names the authenticated tree's CID; nothing refers to current/ or to the tampered tree.
    const gets = blobGets(rig.node);
    expect(gets).toHaveLength(3);
    for (const line of gets) expect(line.startsWith(`GET ${manifest.rootCID}/`)).toBe(true);
    const trace = rig.node.calls.join("\n");
    expect(trace).not.toContain("current");
    expect(trace).not.toContain(tamperedCurrent ?? "unexpected");
  });

  it("when the authenticated tree cannot be read, the files fail and nothing is taken from current/", async () => {
    const rig = await publishedOnce();
    const { manifest } = await realRoots(rig);
    // current/ is intact and would restore everything if the pull read it; the authenticated tree is withheld.
    const client = {
      ...rig.node.client,
      ipfsLs: (path: string) =>
        path.startsWith(`/ipfs/${manifest.rootCID}`) ? Promise.reject(new KuboHttpError("rpc", "https://node.test", 500, "node does not have it")) : rig.node.client.ipfsLs(path),
    };
    const b = newPuller();
    const { result } = pulledOf(await runVaultPull(rig, b, { deps: { client } }));
    expect(vaultTexts(b.host)).toEqual({});
    expect(result.settlement.integrityFailed.map((problem) => problem.path).sort()).toEqual([BINARY, DAILY, PLAN].sort());
    expect(result.settlement.complete).toBe(false);
    expect(blobGets(rig.node)).toEqual([]);
    expect(rig.node.calls.join("\n")).not.toContain("current");
    const state = await stateOf(b.host);
    expect(state?.complete).toBe(false);
    expect(state?.unmaterialized).toEqual([BINARY, DAILY, PLAN].sort());
  });
});

describe("hostile manifest paths", () => {
  it("skips plugin code, a protected-folder alias, Windows names and collisions; counts them as specified; requests no blob for them", async () => {
    const rig = await publishedOnce();
    const alias = `.${String.fromCodePoint(0x131)}pfs-sync/x`;
    const hostile = [".obsidian/plugins/x/main.js", alias, "CON.md", "Note.md", "note.md", ".obsidian/app.json"];
    const forged = await forgeWithPaths(rig, hostile);
    const b = newPuller();
    const { result } = pulledOf(await runVaultPull(rig, b));

    expect(vaultTexts(b.host)).toEqual(sourceTexts(rig));
    const skipped = Object.fromEntries(result.settlement.skipped.map((skip) => [skip.path, skip.severity === "unsafe" ? `unsafe/${skip.class}` : skip.severity]));
    expect(skipped).toEqual({
      ".obsidian/plugins/x/main.js": "unsafe/shape",
      [alias]: "unsafe/shape",
      "CON.md": "unsafe/platform",
      "Note.md": "unsafe/platform",
      "note.md": "unsafe/platform",
      ".obsidian/app.json": "expected",
    });
    expect(result.settlement.needsAttention).toBe(true);
    expect(result.settlement.complete).toBe(true);
    expect(result.settlement.integrityFailed).toEqual([]);

    // Platform skips are in the baseline and in `unmaterialized`; expected and shape skips are in neither.
    const state = await stateOf(b.host);
    expect(state?.unmaterialized).toEqual(["CON.md", "Note.md", "note.md"]);
    expect(Object.keys(state?.manifest.files ?? {}).sort()).toEqual([BINARY, DAILY, PLAN, "CON.md", "Note.md", "note.md"].sort());
    for (const path of [".obsidian/plugins/x/main.js", alias, ".obsidian/app.json"]) expect(state?.manifest.files[path]).toBeUndefined();
    expect(state?.manifest.sequence).toBe(forged.sequence);

    // No blob of a skipped path was requested, and nothing was written outside the three real files.
    expect(blobGets(rig.node)).toHaveLength(3);
    expect(Object.keys(vaultTexts(b.host))).toHaveLength(3);
    expect(b.host.files.has(".obsidian/plugins/x/main.js")).toBe(false);
  });

  it("bidirectional overrides and isolates: all nine code points are skipped as unsafe/shape, no blob is requested and nothing is written for them (mvp-07b 7.6)", async () => {
    const rig = await publishedOnce();
    const codePoints = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    const spoof = `invoice${String.fromCodePoint(0x202e)}txt.exe`;
    const hostile = [spoof, ...codePoints.map((codePoint) => `note${String.fromCodePoint(codePoint)}.md`)];
    const implicit = `Notes/a${String.fromCodePoint(0x200f)}b.md`;
    await forgeWithPaths(rig, [...hostile, implicit]);
    const b = newPuller();
    const { result } = pulledOf(await runVaultPull(rig, b));

    const skipped = Object.fromEntries(result.settlement.skipped.map((skip) => [skip.path, skip.severity === "unsafe" ? `unsafe/${skip.class}` : skip.severity]));
    expect(Object.keys(skipped).sort()).toEqual([...new Set(hostile)].sort());
    for (const path of hostile) expect(skipped[path], path).toBe("unsafe/shape");
    expect(result.settlement.needsAttention).toBe(true);
    for (const path of hostile) expect(b.host.files.has(path), path).toBe(false);
    // The implicit-mark name passes the policy (it is not skipped); its forged blob does not exist on the node, so it is not restored here.
    expect(skipped[implicit]).toBeUndefined();
    expect(Object.keys(vaultTexts(b.host)).sort()).toEqual([BINARY, DAILY, PLAN].sort());
    // Shape skips are not carried: the hostile paths are in neither the baseline nor `unmaterialized`.
    const state = await stateOf(b.host);
    for (const path of hostile) expect(state?.manifest.files[path], path).toBeUndefined();
    expect(state?.unmaterialized ?? []).not.toEqual(expect.arrayContaining(hostile));
    // Blobs were requested for the 3 real files and the implicit-mark name only; none for the bidi paths.
    expect(blobGets(rig.node).length).toBeLessThanOrEqual(4);
  });

  it("a traversal path never reaches the plan: the authenticated manifest is refused as unreadable and nothing is requested or written", async () => {
    const rig = await publishedOnce();
    const keys = await rig.keys();
    const real = await rig.manifest();
    const json = JSON.parse(new TextDecoder().decode(serializeManifestV2(real))) as { files: Record<string, unknown> };
    json.files["../x"] = Object.values(json.files)[0];
    rig.node.files.set(`${ROOT}/manifest.enc`, await seal(keys, JSON.stringify(json)));
    pointNameAt(rig.node);
    resetNodeTrace(rig.node);

    const b = newPuller();
    const outcome = await runVaultPull(rig, b);
    expect(outcome.kind).toBe("stopped");
    if (outcome.kind === "stopped") expect(outcome.stop.reason).toBe("manifest-unsupported");
    expect(blobGets(rig.node)).toEqual([]);
    expect(b.host.mutations).toEqual([]);
    expect(await stateOf(b.host)).toBeUndefined();
  });
});

describe("a large pull needs a yes", () => {
  it("a declined large pull fetches nothing, leaves complete false, and a later pull restores everything", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    let asked: { totalBytes: number; fileCount: number; ceilingBytes: number } | undefined;
    const { result } = pulledOf(
      await runVaultPull(rig, b, {
        options: { confirmAboveBytes: 1 },
        deps: {
          confirmLargePull: async (details) => {
            asked = details;
            return false;
          },
        },
      }),
    );
    expect(asked).toEqual({ totalBytes: result.bytesToFetch, fileCount: 3, ceilingBytes: 1 });
    expect(result.large).toMatchObject({ confirmed: false });
    expect(result.settlement.unfetched.map((problem) => problem.path).sort()).toEqual([BINARY, DAILY, PLAN].sort());
    expect(result.settlement.complete).toBe(false);
    expect(vaultTexts(b.host)).toEqual({});
    // Nothing of the authenticated tree was listed or requested.
    expect(blobGets(rig.node)).toEqual([]);
    expect(rig.node.calls.filter((line) => line.startsWith("ipfs-ls") && line.split("/").length > 3)).toEqual([]);
    const declined = await stateOf(b.host);
    expect(declined?.complete).toBe(false);
    expect(declined?.unmaterialized).toEqual([BINARY, DAILY, PLAN].sort());

    const retry = pulledOf(await runVaultPull(rig, b));
    expect(retry.result.verdict).toBe("same");
    expect(vaultTexts(b.host)).toEqual(sourceTexts(rig));
    expect([...retry.result.settlement.restored].sort()).toEqual([BINARY, DAILY, PLAN].sort());
    const done = await stateOf(b.host);
    expect(done?.complete).toBe(true);
    expect(done?.unmaterialized).toEqual([]);
  });

  it("a host that cannot ask counts as a refusal; --accept-large is the yes; a callback that throws is a refusal", async () => {
    const rig = await publishedOnce();
    const silent = pulledOf(await runVaultPull(rig, newPuller(), { options: { confirmAboveBytes: 1 } }));
    expect(silent.result.large?.confirmed).toBe(false);

    const thrown = pulledOf(
      await runVaultPull(rig, newPuller(), {
        options: { confirmAboveBytes: 1 },
        deps: {
          confirmLargePull: async () => {
            throw new Error("dialog crashed");
          },
        },
      }),
    );
    expect(thrown.result.large?.confirmed).toBe(false);

    const accepted = newPuller();
    const yes = pulledOf(await runVaultPull(rig, accepted, { options: { confirmAboveBytes: 1, acceptLarge: true } }));
    expect(yes.result.large?.confirmed).toBe(true);
    expect(vaultTexts(accepted.host)).toEqual(sourceTexts(rig));
  });

  it("at the ceiling exactly it does not ask", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    const total = pulledOf(await runVaultPull(rig, newPuller())).result.bytesToFetch;
    const { result } = pulledOf(await runVaultPull(rig, b, { options: { confirmAboveBytes: total }, deps: { confirmLargePull: async () => false } }));
    expect(result.large).toBeUndefined();
    expect(result.settlement.complete).toBe(true);
  });
});

describe("a full disk is unfetched, not tampering", () => {
  it("the freeBytes port: a file that does not fit is unfetched and its blob is not requested", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    const { result } = pulledOf(await runVaultPull(rig, b, { deps: { freeBytes: async () => 10 } }));
    // The 5-byte attachment fits in 10 bytes; the two notes do not.
    expect(result.settlement.unfetched.map((problem) => problem.path).sort()).toEqual([DAILY, PLAN].sort());
    expect(result.settlement.unfetched[0]?.reason).toMatch(/free disk space/);
    expect(result.settlement.integrityFailed).toEqual([]);
    expect(vaultTexts(b.host)).toEqual({ [BINARY]: "\u0001\u0002\u0003\u0004\u0005" });
    expect(blobGets(rig.node)).toHaveLength(1);
    expect(result.settlement.complete).toBe(false);
  });

  it("a write that fails removes the part file and is unfetched with the reason 'could not write'", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    b.host.failOn.append = /\.part$/;
    const { result } = pulledOf(await runVaultPull(rig, b));
    expect(result.settlement.integrityFailed).toEqual([]);
    expect(result.settlement.unfetched).toHaveLength(3);
    for (const problem of result.settlement.unfetched) expect(problem.reason).toBe("could not write");
    expect(partFiles(b.host)).toEqual([]);
    expect(vaultTexts(b.host)).toEqual({});
  });

  it("a rename that fails leaves the destination as it was and the file unfetched", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    b.host.failOn.rename = /^Daily\//;
    const { result } = pulledOf(await runVaultPull(rig, b));
    expect(result.settlement.unfetched.map((problem) => problem.path)).toEqual([DAILY]);
    expect(b.host.files.has(DAILY)).toBe(false);
    expect(partFiles(b.host)).toEqual([]);
    expect((await stateOf(b.host))?.unmaterialized).toEqual([DAILY]);
  });
});

describe("a path the host refuses is an unsafe skip, not a failure", () => {
  it("HostPathError from rename skips that path (platform class: the node's entry is carried) and the others go on", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    const rename = b.host.fs.rename.bind(b.host.fs);
    b.host.fs.rename = async (from, to) => {
      if (to === DAILY) throw new HostPathError(to, "its parent directory resolves outside the vault root");
      return rename(from, to);
    };
    const { result } = pulledOf(await runVaultPull(rig, b));
    expect(result.settlement.integrityFailed).toEqual([]);
    expect(result.settlement.unfetched).toEqual([]);
    expect(result.settlement.skipped).toMatchObject([{ path: DAILY, severity: "unsafe", class: "platform" }]);
    expect(result.settlement.needsAttention).toBe(true);
    expect(result.settlement.complete).toBe(true);
    expect(Object.keys(vaultTexts(b.host)).sort()).toEqual([BINARY, PLAN].sort());
    expect(partFiles(b.host)).toEqual([]);
    const state = await stateOf(b.host);
    expect(state?.unmaterialized).toEqual([DAILY]);
    expect(state?.manifest.files[DAILY]).toBeDefined();
  });

  it("HostPathError from the write of the part file is the same skip", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    const write = b.host.fs.write.bind(b.host.fs);
    b.host.fs.write = async (path, data) => {
      if (path.startsWith(".ipfs-sync/tmp/")) throw new HostPathError(path, "its parent directory resolves outside the vault root");
      return write(path, data);
    };
    const { result } = pulledOf(await runVaultPull(rig, b));
    expect(result.settlement.integrityFailed).toEqual([]);
    expect(result.settlement.unfetched).toEqual([]);
    expect(result.settlement.skipped).toHaveLength(3);
    expect(vaultTexts(b.host)).toEqual({});
  });
});

describe("the plugin's ranged source", () => {
  it("a ranged refusal is unfetched, never integrity-failed, and decrypts nothing", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    // The recording node answers a Range request with 206 and no Content-Range: the source refuses every file.
    const { result } = pulledOf(await runVaultPull(rig, b, { deps: { sources: createRangedBlobSources(rig.node.client) } }));
    expect(result.settlement.integrityFailed).toEqual([]);
    expect(result.settlement.unfetched).toHaveLength(3);
    expect(result.settlement.unfetched[0]?.reason).toMatch(/Content-Range/);
    expect(vaultTexts(b.host)).toEqual({});
    expect(partFiles(b.host)).toEqual([]);
    expect(result.settlement.complete).toBe(false);
  });

  it("with honoured ranges the probe goes first and every file is restored byte for byte", async () => {
    const rig = await publishedOnce();
    const gatewayFetch = rig.node.client.gatewayFetch;
    const client = {
      ...rig.node.client,
      gatewayStream: async (cid: string, path = "", range?: { start: number; length: number }) => {
        const whole = await gatewayFetch(cid, path);
        const part = range === undefined ? whole : whole.slice(range.start, range.start + range.length);
        async function* chunks(): AsyncGenerator<Uint8Array> {
          yield part;
        }
        return range === undefined
          ? { status: 200, contentRange: undefined, chunks: chunks() }
          : { status: 206, contentRange: `bytes ${range.start}-${range.start + part.length - 1}/${whole.length}`, chunks: chunks() };
      },
    } as unknown as KuboClient;
    const ranged = createRangedBlobSources(client);
    const b = newPuller();
    const { result } = pulledOf(await runVaultPull(rig, b, { deps: { client, sources: ranged } }));
    expect(ranged.state()).toBe("honoured");
    expect(vaultTexts(b.host)).toEqual(sourceTexts(rig));
    expect(result.settlement.complete).toBe(true);
  });
});

describe("one bad blob does not stop the others", () => {
  it("a flipped bit fails only that file, which is carried; a lie about a blob's length does the same", async () => {
    const rig = await publishedOnce();
    const { manifest } = await realRoots(rig);
    const planEntry = manifest.files[PLAN];
    const dailyEntry = manifest.files[DAILY];
    if (planEntry === undefined || dailyEntry === undefined) throw new Error("fixture changed");
    const planBlob = rig.node.cidOf(`${ROOT}/current/${planEntry.blob.slice(0, 2)}/${planEntry.blob}`) as string;
    const original = rig.node.bytesOf(planBlob) as Uint8Array;
    rig.node.corruptRead = (cid) => {
      if (cid !== planBlob) return undefined;
      const flipped = Uint8Array.from(original);
      flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
      return flipped;
    };
    rig.node.sizeLie = (name) => (name === dailyEntry.blob ? 99_999 : undefined);

    const b = newPuller();
    const { result } = pulledOf(await runVaultPull(rig, b));
    expect(result.settlement.integrityFailed.map((problem) => problem.path).sort()).toEqual([DAILY, PLAN].sort());
    expect(Object.keys(vaultTexts(b.host))).toEqual([BINARY]);
    expect(partFiles(b.host)).toEqual([]);
    expect(result.settlement.complete).toBe(false);
    expect(result.settlement.needsAttention).toBe(true);
    const state = await stateOf(b.host);
    expect(state?.complete).toBe(false);
    expect(state?.unmaterialized).toEqual([DAILY, PLAN].sort());
    expect(state?.manifest.files[PLAN]).toEqual(planEntry);
  });
});

describe("conflicts and local edits", () => {
  async function twoDevices(): Promise<{ rig: Rig; b: ReturnType<typeof newPuller> }> {
    const rig = await publishedOnce();
    const b = newPuller();
    pulledOf(await runVaultPull(rig, b));
    return { rig, b };
  }

  it("an edit on both sides: the node's text takes the path and the local text survives in the dated copy; a local-only edit stays; a remote-only edit replaces", async () => {
    const { rig, b } = await twoDevices();
    await publishEdits(rig, { [DAILY]: "A edited the daily note, much longer than before.\n", [PLAN]: "A rewrote the plan.\n" });
    b.host.put(DAILY, "B edited it too.\n", 5_000);
    b.host.put(BINARY, new Uint8Array([9, 9]), 5_000);

    const { result } = pulledOf(await runVaultPull(rig, b));
    expect(result.verdict).toBe("newer");
    const copy = `Daily/2026-09-30 (ipfs conflict ${localDateStamp(NOW)}).md`;
    expect(vaultTexts(b.host)).toEqual({
      [DAILY]: "A edited the daily note, much longer than before.\n",
      [copy]: "B edited it too.\n",
      [PLAN]: "A rewrote the plan.\n",
      [BINARY]: "\u0009\u0009",
    });
    expect(result.settlement.conflicts).toEqual([{ path: DAILY, conflictPath: copy }]);
    expect(result.settlement.locallyModified).toEqual([BINARY]);
    expect([...result.settlement.fetched].sort()).toEqual([DAILY, PLAN].sort());
    const state = await stateOf(b.host);
    expect(state).toMatchObject({ sequence: 2, highestSequence: 2, complete: true, unmaterialized: [], previousIdentity: null });
    expect(Object.keys(state?.mtimes ?? {}).sort()).toEqual([DAILY, PLAN].sort());
    // The conflict copy is not a manifest path of this pull: the next publish sees it as a new file.
    expect(state?.manifest.files[copy]).toBeUndefined();
    expect(partFiles(b.host)).toEqual([]);
  });

  it("a file the user edits while the pull is fetching is copied, not overwritten", async () => {
    const { rig, b } = await twoDevices();
    await publishEdits(rig, { [PLAN]: "A rewrote the plan, and this is longer.\n" });
    const planBlob = (await rig.manifest()).files[PLAN]?.blob as string;
    const client = rig.node.client;
    const sources = {
      source: (location: Parameters<ReturnType<typeof streamingSources>["source"]>[0]) => {
        const inner = streamingSources(client).source(location);
        return {
          totalLength: inner.totalLength,
          chunks: {
            async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
              if (location.path.endsWith(planBlob)) b.host.put(PLAN, "typed while the pull ran\n", 9_000);
              yield* inner.chunks;
            },
          },
        };
      },
    };
    const { result } = pulledOf(await runVaultPull(rig, b, { deps: { sources } }));
    const copy = `Projects/Secret Merger/Quarterly plan (ipfs conflict ${localDateStamp(NOW)}).md`;
    expect(vaultTexts(b.host)[PLAN]).toBe("A rewrote the plan, and this is longer.\n");
    expect(vaultTexts(b.host)[copy]).toBe("typed while the pull ran\n");
    expect(result.settlement.conflicts).toEqual([{ path: PLAN, conflictPath: copy }]);
  });

  it("a conflict copy that cannot be written leaves the local file untouched and the path unfetched", async () => {
    const { rig, b } = await twoDevices();
    await publishEdits(rig, { [DAILY]: "A edited the daily note, much longer than before.\n" });
    b.host.put(DAILY, "B edited it too.\n", 5_000);
    b.host.failOn.rename = /ipfs conflict/;

    const { result } = pulledOf(await runVaultPull(rig, b));
    expect(vaultTexts(b.host)[DAILY]).toBe("B edited it too.\n");
    expect(result.settlement.unfetched.map((problem) => problem.path)).toEqual([DAILY]);
    expect(result.settlement.unfetched[0]?.reason).toMatch(/conflict copy/);
    expect(result.settlement.integrityFailed).toEqual([]);
    expect(partFiles(b.host)).toEqual([]);
    expect(Object.keys(vaultTexts(b.host)).filter((path) => path.includes("conflict"))).toEqual([]);
    const state = await stateOf(b.host);
    expect(state?.unmaterialized).toEqual([DAILY]);
    expect(state?.complete).toBe(false);
  });
});

describe("the publish journal", () => {
  async function pulledTwice(): Promise<{ rig: Rig; manifest: EncryptedManifest; keyslotsSha256: string }> {
    const rig = await publishedOnce();
    await publishAgain(rig);
    const probe = newPuller();
    const { verified } = pulledOf(await runVaultPull(rig, probe));
    return { rig, manifest: verified.manifest, keyslotsSha256: verified.unlock.keySlotsSha256 };
  }

  const journalFor = (manifest: EncryptedManifest, sequence: number, keyslotsSha256: string) =>
    buildJournal({
      mfsRoot: ROOT,
      key: KEY,
      vaultId: manifest.vaultId,
      keyslotsSha256,
      sequence,
      manifestSha256: "0".repeat(64),
      pending: { manifest: { ...manifest, sequence }, mtimes: {} },
      startedAt: "2026-10-01T00:00:00.000Z",
      startRoot: null,
    });

  it.each([
    { journalSequence: 2, movedAside: true },
    { journalSequence: 1, movedAside: true },
    { journalSequence: 3, movedAside: false },
  ])("a journal at sequence $journalSequence with a sequence 2 manifest pulled: moved aside = $movedAside", async ({ journalSequence, movedAside }) => {
    const { rig, manifest, keyslotsSha256 } = await pulledTwice();
    const b = newPuller();
    await writeJournal(b.host.kv, journalFor(manifest, journalSequence, keyslotsSha256));
    const before = b.host.kvStore.get(rootFileNames(ROOT).journal) as Uint8Array;

    const { result } = pulledOf(await runVaultPull(rig, b));
    const aside = `journal-set-aside.${journalSequence}.json`;
    if (movedAside) {
      expect(result.journalSetAside).toEqual({ name: aside, sequence: journalSequence });
      expect((await readJournal(b.host.kv, ROOT)).kind).toBe("none");
      expect(b.host.kvStore.get(aside)).toEqual(before); // byte for byte
    } else {
      expect(result.journalSetAside).toBeUndefined();
      expect((await readJournal(b.host.kv, ROOT)).kind).toBe("ok");
      expect(b.host.kvStore.has(aside)).toBe(false);
    }
  });

  it("a journal of another vault, or a damaged one, is left alone", async () => {
    const { rig, manifest, keyslotsSha256 } = await pulledTwice();
    const stranger = newPuller();
    await writeJournal(stranger.host.kv, { ...journalFor(manifest, 1, keyslotsSha256), vaultId: "f".repeat(32), pending: { manifest: { ...manifest, sequence: 1, vaultId: "f".repeat(32) }, mtimes: {} } });
    expect(pulledOf(await runVaultPull(rig, stranger)).result.journalSetAside).toBeUndefined();
    expect((await readJournal(stranger.host.kv, ROOT)).kind).toBe("ok");

    const damaged = newPuller();
    damaged.host.kvStore.set(rootFileNames(ROOT).journal, new TextEncoder().encode("{not json"));
    expect(pulledOf(await runVaultPull(rig, damaged)).result.journalSetAside).toBeUndefined();
    expect((await readJournal(damaged.host.kv, ROOT)).kind).toBe("damaged");
  });
});

describe("the device store", () => {
  it("the stage does not write it: the floor is written once, by step 6 of the first pull", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    pulledOf(await runVaultPull(rig, b));
    expect(b.store.writes).toEqual([SEQUENCE_FLOOR_FILE]);
  });
});
