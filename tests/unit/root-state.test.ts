import { describe, expect, it } from "vitest";
import { createFilesMap } from "../../src/sync/encrypted-manifest";
import { buildJournal, decodeJournal, encodeJournal, readJournal, writeJournal } from "../../src/sync/journal";
import { RootStateError } from "../../src/sync/local-record";
import { parseLocalManifest, sameManifest } from "../../src/sync/local-manifest";
import { PUBLISH_LOCK_KEY, rootDigest, rootFileNames } from "../../src/sync/root-files";
import { buildRootState, decodeRootState, encodeRootState, readRootState, writeRootState } from "../../src/sync/root-state";
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

describe("root state (format 2)", () => {
  it("round trips byte for byte and records the vault, the key-slot hash and the latch", async () => {
    const s = await scenario();
    const encoded = encodeRootState(s.state1);
    const decoded = decodeRootState(encoded);
    expect(encodeRootState(decoded)).toEqual(encoded);
    expect(decoded).toMatchObject({ version: 2, vaultId: s.keys.vaultId, keyslotsSha256: KEYSLOTS_SHA, sequence: 1, encryptedSeen: true });
    expect(text(encoded)).not.toMatch(/passphrase|secret/i);
  });

  it("keeps a path named __proto__ as data", async () => {
    const keys = await keysFrom(0x20, 0x50);
    const manifest = await buildManifest(keys, 1, ["__proto__", "constructor"], cidFor("t"));
    const state = buildRootState({ mfsRoot: MFS_ROOT, key: "k", rootCid: null, vaultId: keys.vaultId, keyslotsSha256: KEYSLOTS_SHA, sequence: 1, manifest, mtimes: {} });
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
    ["a missing latch", (raw: Record<string, unknown>) => bytes(JSON.stringify({ ...raw, encryptedSeen: false }))],
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
