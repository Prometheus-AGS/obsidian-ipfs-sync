import { describe, expect, it } from "vitest";
import { createFilesMap, decodeManifestFile, encodeManifestFile, serializeManifestV2 } from "../../src/sync/encrypted-manifest";
import { sha256Hex } from "../../src/sync/hash";
import { buildJournal, decodeJournal, encodeJournal, readJournal, writeJournal } from "../../src/sync/journal";
import { RootStateError } from "../../src/sync/local-record";
import { parseLocalManifest, sameManifest } from "../../src/sync/local-manifest";
import { manifestIdentity } from "../../src/sync/manifest-identity";
import { commitPublish } from "../../src/sync/publish-commit";
import { PUBLISH_LOCK_KEY, rootDigest, rootFileNames } from "../../src/sync/root-files";
import { DEVICES_SEEN_MAX, addDeviceSeen, buildRootState, decodeRootState, encodeRootState, publishedFields, readRootState, writeRootState } from "../../src/sync/root-state";
import { createMemoryHost } from "../helpers/memory-host";
import { KEYSLOTS_SHA, MFS_ROOT, buildManifest, cidFor, scenario } from "../helpers/commit-scenario";
import { keysFrom } from "../vectors/manifest-helpers";

const KV_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytes = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

describe("per-root file names", () => {
  it("carry the first 16 hex characters of sha256(mfsRoot) and are valid key-value keys", () => {
    expect(rootDigest("/obsidian-vault-sync/a")).toMatch(/^[0-9a-f]{16}$/);
    const names = rootFileNames("/obsidian-vault-sync/a");
    for (const name of Object.values(names)) expect(name).toMatch(KV_KEY);
    expect(names.state).toBe(`state.${rootDigest("/obsidian-vault-sync/a")}.json`);
    expect(names.journal).toBe(`journal.${rootDigest("/obsidian-vault-sync/a")}.json`);
    expect(names.keyslots).toBe(`keyslots.${rootDigest("/obsidian-vault-sync/a")}.json`);
    expect(PUBLISH_LOCK_KEY).toMatch(KV_KEY);
  });

  it("differ for two roots, and never collide with the pull record's state.json", () => {
    const a = rootFileNames("/obsidian-vault-sync/a");
    const b = rootFileNames("/obsidian-vault-sync/b");
    expect(a.state).not.toBe(b.state);
    expect(a.journal).not.toBe(b.journal);
    expect(a.keyslots).not.toBe(b.keyslots);
    expect(a.state).not.toBe("state.json");
  });

  it("one directory publishing to two roots keeps two independent records", async () => {
    const s = await scenario();
    const otherRoot = "/obsidian-vault-sync/second";
    await writeRootState(s.host.kv, { ...s.state1, mfsRoot: otherRoot, sequence: 1 });
    expect((await readRootState(s.host.kv, MFS_ROOT))?.mfsRoot).toBe(MFS_ROOT);
    expect((await readRootState(s.host.kv, otherRoot))?.mfsRoot).toBe(otherRoot);
    expect(await readRootState(s.host.kv, "/obsidian-vault-sync/third")).toBeUndefined();
  });
});

describe("root state (format 3)", () => {
  it("round trips byte for byte and records the vault, the key-slot hash and the latch", async () => {
    const s = await scenario();
    const encoded = encodeRootState(s.state1);
    const decoded = decodeRootState(encoded);
    expect(encodeRootState(decoded)).toEqual(encoded);
    expect(decoded).toMatchObject({ version: 3, vaultId: s.keys.vaultId, keyslotsSha256: KEYSLOTS_SHA, sequence: 1, encryptedSeen: true });
    expect(text(encoded)).not.toMatch(/passphrase|secret/i);
  });

  it("keeps a path named __proto__ as data", async () => {
    const keys = await keysFrom(0x20, 0x50);
    const manifest = await buildManifest(keys, 1, ["__proto__", "constructor"], cidFor("t"));
    const state = buildRootState({ mfsRoot: MFS_ROOT, key: "k", rootCid: null, vaultId: keys.vaultId, keyslotsSha256: KEYSLOTS_SHA, sequence: 1, manifest, ...publishedFields(undefined, manifest, []), mtimes: {} });
    const decoded = decodeRootState(encodeRootState(state));
    expect(Object.keys(decoded.manifest.files).sort()).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(decoded.manifest.files)).toBeNull();
    expect(sameManifest(decoded.manifest, manifest)).toBe(true);
  });

  it("allows a null rootCid (no publish completed yet) and refuses a malformed one", async () => {
    const s = await scenario();
    const raw = JSON.parse(text(encodeRootState(s.state1))) as Record<string, unknown>;
    expect(decodeRootState(bytes(JSON.stringify({ ...raw, rootCid: null }))).rootCid).toBeNull();
    expect(() => decodeRootState(bytes(JSON.stringify({ ...raw, rootCid: "not a cid!" })))).toThrowError(RootStateError);
  });

  it.each([
    ["invalid JSON", () => bytes("{ broken")],
    ["not an object", () => bytes("[]")],
    ["a format 1 record", () => bytes('{"version":1}')],
    ["a format 2 record without its latch", (raw: Record<string, unknown>) => bytes(JSON.stringify({ ...raw, version: 2, encryptedSeen: false }))],
    ["a format 4 record", (raw: Record<string, unknown>) => bytes(JSON.stringify({ ...raw, version: 4 }))],
    ["a sequence that differs from the manifest", (raw: Record<string, unknown>) => bytes(JSON.stringify({ ...raw, sequence: 9 }))],
    ["a vaultId that differs from the manifest", (raw: Record<string, unknown>) => bytes(JSON.stringify({ ...raw, vaultId: "9".repeat(32) }))],
    ["a bad key-slot hash", (raw: Record<string, unknown>) => bytes(JSON.stringify({ ...raw, keyslotsSha256: "zz" }))],
    ["a bad modification time", (raw: Record<string, unknown>) => bytes(JSON.stringify({ ...raw, mtimes: { "a.md": "yesterday" } }))],
    ["an unsafe manifest path", (raw: Record<string, unknown>) => bytes(JSON.stringify({ ...raw, manifest: { ...(raw["manifest"] as object), files: { "../x": (Object.values((raw["manifest"] as { files: object }).files)[0]) } } }))],
  ])("refuses %s, with a message that does not advise deleting the record", async (_label, mutate) => {
    const s = await scenario();
    const raw = JSON.parse(text(encodeRootState(s.state1))) as Record<string, unknown>;
    let error: unknown;
    try {
      decodeRootState(mutate(raw));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RootStateError);
    expect((error as Error).message).not.toMatch(/delet/i);
    expect((error as Error).message).toContain("--repair");
  });

  it("refuses a state file that names another MFS root", async () => {
    const s = await scenario();
    const other = "/obsidian-vault-sync/other";
    await s.host.kv.set(rootFileNames(other).state, encodeRootState(s.state1));
    await expect(readRootState(s.host.kv, other)).rejects.toThrowError(/different MFS root/);
  });

  it("does not read or write the pull record (state.json, format 1)", async () => {
    const host = createMemoryHost();
    await host.kv.set("state.json", bytes('{"version":1}'));
    expect(await readRootState(host.kv, MFS_ROOT)).toBeUndefined();
    await writeRootState(host.kv, (await scenario()).state1);
    expect(text((await host.kv.get("state.json")) ?? new Uint8Array())).toBe('{"version":1}');
  });
});

const rawOf = async (): Promise<{ readonly s: Awaited<ReturnType<typeof scenario>>; readonly raw: Record<string, unknown> }> => {
  const s = await scenario();
  return { s, raw: JSON.parse(text(encodeRootState(s.state1))) as Record<string, unknown> };
};

/** The decoder of the previous build (format 2 only), kept as a test double for the downgrade case. */
function previousBuildDecode(input: Uint8Array): void {
  const record = JSON.parse(text(input)) as Record<string, unknown>;
  if (record["version"] !== 2) throw new RootStateError(`state format ${String(record["version"])} is not supported by this version`);
}

describe("root state: format 2 upgrade", () => {
  const V3_ONLY = ["manifestIdentity", "previousIdentity", "highestSequence", "highestIdentity", "complete", "unmaterialized", "devicesSeen"];

  it("decodes a format 2 file to format 3 with the identity of its manifest and the upgrade defaults", async () => {
    const { s, raw } = await rawOf();
    const v2 = Object.fromEntries(Object.entries({ ...raw, version: 2 }).filter(([key]) => !V3_ONLY.includes(key)));
    const decoded = decodeRootState(bytes(JSON.stringify(v2)));
    const expected = await sha256Hex(serializeManifestV2(s.manifest1));
    expect(decoded).toMatchObject({
      version: 3,
      manifestIdentity: expected,
      highestIdentity: expected,
      highestSequence: 1,
      previousIdentity: null,
      complete: true,
      unmaterialized: [],
      devicesSeen: [s.manifest1.device],
    });
    expect(JSON.parse(text(encodeRootState(decoded)))).toMatchObject({ version: 3 });
  });

  it("refuses a format 3 file in a build that only knows format 2 (the downgrade fails closed)", async () => {
    const { s } = await rawOf();
    expect(() => previousBuildDecode(encodeRootState(s.state1))).toThrowError(/format 3 is not supported/);
  });
});

describe("manifest identity", () => {
  it("is equal for two encryptions of one manifest and different when publishedAt changes", async () => {
    const s = await scenario();
    const first = await encodeManifestFile(s.keys, s.manifest1);
    const second = await encodeManifestFile(s.keys, s.manifest1);
    expect(first.file).not.toEqual(second.file);
    const a = await decodeManifestFile(s.keys, first.file);
    const b = await decodeManifestFile(s.keys, second.file);
    expect(manifestIdentity(a)).toBe(manifestIdentity(b));
    expect(manifestIdentity(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestIdentity({ ...s.manifest1, publishedAt: "2026-09-30T13:00:00.000Z" })).not.toBe(manifestIdentity(a));
  });
});

describe("root state: strict format 3", () => {
  const omit = (key: string) => (raw: Record<string, unknown>) => bytes(JSON.stringify(Object.fromEntries(Object.entries(raw).filter(([name]) => name !== key))));
  const set = (patch: Record<string, unknown>) => (raw: Record<string, unknown>) => bytes(JSON.stringify({ ...raw, ...patch }));

  it.each([
    ["a missing complete", omit("complete")],
    ["complete as a string", set({ complete: "true" })],
    ["complete as a number", set({ complete: 1 })],
    ["a missing manifestIdentity", omit("manifestIdentity")],
    ["a 63-character manifestIdentity", set({ manifestIdentity: "a".repeat(63) })],
    ["an upper-case manifestIdentity", set({ manifestIdentity: "A".repeat(64) })],
    ["a missing previousIdentity", omit("previousIdentity")],
    ["a malformed previousIdentity", set({ previousIdentity: "abc" })],
    ["a missing highestSequence", omit("highestSequence")],
    ["highestSequence below the sequence", set({ highestSequence: 0 })],
    ["a fractional highestSequence", set({ highestSequence: 1.5 })],
    ["a missing highestIdentity", omit("highestIdentity")],
    ["equal sequences with different identities", set({ highestSequence: 1, highestIdentity: "f".repeat(64) })],
    ["a missing unmaterialized list", omit("unmaterialized")],
    ["an unsorted unmaterialized list", set({ unmaterialized: ["notes/b.md", "notes/a.md"] })],
    ["a repeated unmaterialized path", set({ unmaterialized: ["notes/a.md", "notes/a.md"] })],
    ["an unmaterialized path that is not in the manifest", set({ unmaterialized: ["zzz.md"] })],
    ["a missing devicesSeen", omit("devicesSeen")],
    ["a repeated device", set({ devicesSeen: ["a", "a"] })],
    ["more than 16 devices", set({ devicesSeen: Array.from({ length: DEVICES_SEEN_MAX + 1 }, (_value, index) => `d${index}`) })],
    ["a restoredFrom of zero", set({ restoredFrom: 0 })],
  ])("refuses %s and does not default it", async (_label, mutate) => {
    const { raw } = await rawOf();
    let error: unknown;
    try {
      decodeRootState(mutate(raw));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RootStateError);
    expect((error as Error).message).not.toMatch(/delet/i);
  });

  it("accepts a higher highestSequence with its own identity, a sorted unmaterialized subset and restoredFrom", async () => {
    const { raw } = await rawOf();
    const decoded = decodeRootState(set({ highestSequence: 4, highestIdentity: "e".repeat(64), unmaterialized: ["notes/a.md", "notes/b.md"], restoredFrom: 2, devicesSeen: ["x", "y"] })(raw));
    expect(decoded).toMatchObject({ highestSequence: 4, unmaterialized: ["notes/a.md", "notes/b.md"], restoredFrom: 2, devicesSeen: ["x", "y"] });
  });
});

describe("devicesSeen", () => {
  it("keeps first-seen order, unique, and drops the earliest-seen value over the limit", () => {
    const full = Array.from({ length: DEVICES_SEEN_MAX }, (_value, index) => `d${index}`);
    expect(addDeviceSeen(["a"], "b")).toEqual(["a", "b"]);
    expect(addDeviceSeen(["a", "b"], "a")).toEqual(["a", "b"]);
    const next = addDeviceSeen(full, "new");
    expect(next).toHaveLength(DEVICES_SEEN_MAX);
    expect(next[0]).toBe("d1");
    expect(next.at(-1)).toBe("new");
  });
});

describe("writers of the state", () => {
  const PATHS_V2 = ["notes/a.md", "notes/b.md", "notes/c.md"] as const;

  it("finishPublish writes the identity, the previous identity, highest, complete, the sorted carried paths and the device", async () => {
    const s = await scenario();
    const { manifest, file } = await s.next(2, PATHS_V2);
    const state = await commitPublish(s.deps, { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: s.state1.rootCid, unmaterialized: ["notes/b.md", "notes/a.md", "notes/b.md"] });
    expect(state).toMatchObject({
      manifestIdentity: manifestIdentity(manifest),
      previousIdentity: s.state1.manifestIdentity,
      highestSequence: 2,
      highestIdentity: manifestIdentity(manifest),
      complete: true,
      unmaterialized: ["notes/a.md", "notes/b.md"],
      devicesSeen: [manifest.device],
    });
    expect(decodeRootState(encodeRootState(state))).toEqual(state);
  });

  it("finishPublish without a carried input writes an empty list, and never lowers the highest record", async () => {
    const s = await scenario();
    await writeRootState(s.host.kv, buildRootState({ ...s.state1, highestSequence: 9, highestIdentity: "9".repeat(64) }));
    const { manifest, file } = await s.next(2, PATHS_V2);
    const state = await commitPublish(s.deps, { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: s.state1.rootCid });
    expect(state).toMatchObject({ unmaterialized: [], highestSequence: 9, highestIdentity: "9".repeat(64) });
  });

  it("finishPublish over a state that does not decode starts with no previous identity", async () => {
    const s = await scenario();
    await s.host.kv.set(rootFileNames(MFS_ROOT).state, bytes("{ broken"));
    const { manifest, file } = await s.next(2, PATHS_V2);
    const state = await commitPublish(s.deps, { target: s.target, manifest, manifestFile: file, mtimes: {}, previousRootCid: null });
    expect(state).toMatchObject({ previousIdentity: null, highestSequence: 2, devicesSeen: [manifest.device] });
  });

  it("publishedFields adds the manifest device after the baseline's and keeps the baseline's order", async () => {
    const s = await scenario();
    const baseline = buildRootState({ ...s.state1, devicesSeen: ["other", s.manifest1.device] });
    const { manifest } = await s.next(2, PATHS_V2);
    expect(publishedFields(baseline, { ...manifest, device: "third" }, []).devicesSeen).toEqual(["other", s.manifest1.device, "third"]);
  });
});

describe("journal file", () => {
  it("round trips and stays per root", async () => {
    const s = await scenario();
    const journal = buildJournal({
      mfsRoot: MFS_ROOT,
      key: "k",
      vaultId: s.keys.vaultId,
      keyslotsSha256: KEYSLOTS_SHA,
      sequence: 1,
      manifestSha256: "e".repeat(64),
      pending: { manifest: s.manifest1, mtimes: { "notes/a.md": 3 } },
      startedAt: "2026-09-30T12:00:00.000Z",
    });
    expect(encodeJournal(decodeJournal(encodeJournal(journal)))).toEqual(encodeJournal(journal));
    await writeJournal(s.host.kv, journal);
    expect(await readJournal(s.host.kv, MFS_ROOT)).toMatchObject({ kind: "ok" });
    expect(await readJournal(s.host.kv, "/obsidian-vault-sync/other")).toEqual({ kind: "none" });
  });

  it("reports an unreadable journal as damaged instead of throwing", async () => {
    const host = createMemoryHost();
    await host.kv.set(rootFileNames(MFS_ROOT).journal, bytes("{"));
    expect(await readJournal(host.kv, MFS_ROOT)).toEqual({ kind: "damaged" });
  });
});

describe("local manifest reader", () => {
  it("accepts what the codec writes and compares manifests on vaultId, sequence, rootCID and the file map", async () => {
    const s = await scenario();
    const copy = parseLocalManifest(JSON.parse(JSON.stringify(s.manifest1)));
    expect(sameManifest(copy, s.manifest1)).toBe(true);
    const files = createFilesMap(Object.entries(s.manifest1.files));
    const first = Object.keys(files)[0] as string;
    const entry = files[first];
    if (entry === undefined) throw new Error("entry expected");
    files[first] = { ...entry, sha256: "0".repeat(64) };
    expect(sameManifest({ ...s.manifest1, files }, s.manifest1)).toBe(false);
    expect(sameManifest({ ...s.manifest1, sequence: 2 }, s.manifest1)).toBe(false);
    expect(sameManifest({ ...s.manifest1, rootCID: `b${"z".repeat(20)}` }, s.manifest1)).toBe(false);
    expect(sameManifest({ ...s.manifest1, files: createFilesMap() }, s.manifest1)).toBe(false);
  });
});
