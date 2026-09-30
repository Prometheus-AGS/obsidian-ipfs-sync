import { describe, expect, it } from "vitest";
import { blobMfsPath, blobNameFor, toHex, utf8 } from "../../src/crypto";
import { sha256Hex } from "../../src/sync/hash";
import { readJournal } from "../../src/sync/journal";
import { readRootState } from "../../src/sync/root-state";
import { ROOT, SECRET_FOLDER, SECRET_TITLE, SECRET_WORD, blobPaths, createRig, decodeText, seedVault, type Rig } from "../helpers/publish-rig";

const TITLE_PATH = `Projects/${SECRET_FOLDER}/${SECRET_TITLE}.md`;
const PATHS = ["Daily/2026-09-30.md", TITLE_PATH, "attachment.bin"];

/** Request lines with the opaque parts replaced, so the order can be asserted literally. */
function shape(calls: readonly string[]): string[] {
  return calls.map((call) =>
    call
      .replace(new RegExp(ROOT, "g"), "<root>")
      .replace(/\/current\/[a-z2-7]{2}\/[a-z2-7]{52}/g, "/current/<blob>")
      .replace(/\/current\/[a-z2-7]{2}$/, "/current/<prefix>")
      .replace(/\b(bafy|bafk)[a-z2-7]{50,}/g, "<cid>")
      .replace(/ Range: bytes=\d+-\d+/g, " <range>"),
  );
}

async function published(): Promise<Rig> {
  const rig = createRig();
  seedVault(rig.host);
  await rig.init();
  await rig.publish();
  return rig;
}

/** Everything the node was sent that could carry a name or a word: request lines and bodies, and every stored path. */
function wireText(rig: Rig): string {
  const bodies = rig.node.requests.map((request) => `${request.line}\n${request.body === undefined ? "" : Buffer.from(request.body).toString("latin1")}`);
  return [...bodies, ...rig.node.files.keys()].join("\n");
}

describe("encrypted publish: first publish", () => {
  it("issues the requests in the specified order and publishes exactly the verified root CID with ttl 5m", async () => {
    const rig = createRig();
    seedVault(rig.host);
    await rig.init();
    const result = await rig.publish();

    expect(shape(rig.node.calls)).toEqual([
      "stat <root>",
      "ls <root>",
      "GET <cid> <range>",
      "keyList",
      "stat <root>/manifest.enc",
      "ls <root>/manifests",
      "keyGen obsidian-vault-sync",
      "write <root>/current/<blob>",
      "stat <root>/current/<blob>",
      "write <root>/current/<blob>",
      "stat <root>/current/<blob>",
      "write <root>/current/<blob>",
      "stat <root>/current/<blob>",
      "stat <root>/current",
      "stat <root>/manifests/<cid>.enc",
      "write <root>/manifest.enc",
      "stat <root>/manifest.enc",
      "stat <root>/manifests/<cid>.enc",
      "write <root>/manifests/<cid>.enc",
      "stat <root>/manifests/<cid>.enc",
      "stat <root>",
      "ipfs-ls /ipfs/<cid>",
      "GET <cid> <range>",
      "GET <cid> <range>",
      "ipfs-ls /ipfs/<cid>/manifests",
      "ipfs-ls /ipfs/<cid>/current/<prefix>",
      "ipfs-ls /ipfs/<cid>/current/<prefix>",
      "ipfs-ls /ipfs/<cid>/current/<prefix>",
      "pin <cid>",
      "keyList",
      "publish obsidian-vault-sync <cid> 5m",
    ]);
    const pinned = rig.node.calls.find((call) => call.startsWith("pin "))?.slice(4);
    expect(pinned).toBe(result.rootCid);
    expect(rig.node.calls.at(-1)).toBe(`publish obsidian-vault-sync ${result.rootCid} 5m`);
    expect(result).toMatchObject({ published: true, written: 3, removed: 0, keyCreated: true, sequence: 1, anomalies: 0 });
  });

  it("stores a manifest that lists every published file with its plaintext hash, blob name, identifier and CID", async () => {
    const rig = await published();
    const manifest = await rig.manifest();
    const keys = await rig.keys();
    expect(Object.keys(manifest.files).sort()).toEqual(PATHS);
    expect(manifest).toMatchObject({ version: 2, vaultId: keys.vaultId, sequence: 1, device: "test-device" });
    expect(manifest.rootCID).toBe(rig.node.cidOf(`${ROOT}/current`));

    const text = utf8(decodeText(rig.host.files.get(TITLE_PATH)?.data));
    const entry = manifest.files[TITLE_PATH];
    expect(entry).toMatchObject({ sha256: await sha256Hex(text), size: text.length });
    expect(entry?.blob).toBe(await blobNameFor(keys, TITLE_PATH));
    expect(entry?.fileId).toMatch(/^[0-9a-f]{32}$/);
    expect(entry?.cid).toBe(rig.node.cidOf(`${ROOT}/${blobMfsPath(entry?.blob ?? "")}`));
  });

  it("keeps a history file equal to manifest.enc, and the local record and journal in step", async () => {
    const rig = await published();
    const manifest = await rig.manifest();
    expect(rig.node.files.get(`${ROOT}/manifests/${manifest.rootCID}.enc`)).toEqual(rig.node.files.get(`${ROOT}/manifest.enc`));
    const state = await readRootState(rig.host.kv, ROOT);
    expect(state).toMatchObject({ sequence: 1, encryptedSeen: true, rootCid: rig.node.cidOf(ROOT) });
    expect(state?.manifest).toEqual(manifest);
    expect(await readJournal(rig.host.kv, ROOT)).toEqual({ kind: "none" });
    expect(rig.node.published.get(rig.node.keys[0]?.id ?? "")).toBe(`/ipfs/${rig.node.cidOf(ROOT)}`);
  });

  it("sends nothing readable: no title, folder or body word in any URL, body or stored path, and no manifest.json", async () => {
    const rig = await published();
    const wire = wireText(rig);
    for (const secret of [SECRET_TITLE, SECRET_FOLDER, SECRET_WORD, "Projects", "Daily", "attachment", ".md"]) {
      expect(wire).not.toContain(secret);
      expect(wire.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect([...rig.node.files.keys()].some((path) => path.endsWith("manifest.json"))).toBe(false);
    const writes = rig.node.calls.filter((call) => call.startsWith("write ")).map((call) => shape([call])[0]);
    expect(new Set(writes)).toEqual(new Set(["write <root>/current/<blob>", "write <root>/manifest.enc", "write <root>/manifests/<cid>.enc"]));
  });

  it("writes blobs that start with the magic and have exactly 22 + 28 n + size bytes", async () => {
    const rig = await published();
    const manifest = await rig.manifest();
    for (const entry of Object.values(manifest.files)) {
      const blob = rig.node.files.get(`${ROOT}/${blobMfsPath(entry.blob)}`) as Uint8Array;
      expect(new TextDecoder().decode(blob.slice(0, 4))).toBe("ISBL");
      expect(blob.length).toBe(22 + 28 + entry.size);
      expect(toHex(blob.slice(6, 22))).toBe(entry.fileId);
    }
  });

  it("never sends excluded files or the fixture marker, and creates the key before any write", async () => {
    const rig = await published();
    const manifest = await rig.manifest();
    expect(Object.keys(manifest.files).some((path) => /\.trash|workspace|fixture/.test(path))).toBe(false);
    expect(rig.owned).toEqual([rig.node.keys[0]?.id]);
    const firstWrite = rig.node.calls.findIndex((call) => call.startsWith("write "));
    expect(rig.node.calls.findIndex((call) => call.startsWith("keyGen "))).toBeLessThan(firstWrite);
  });

  it("emits file.changed once per written file and one publish.complete with counts and CIDs only", async () => {
    const rig = await published();
    expect(rig.events.changed.map((event) => `${event.kind}:${event.path}`).sort()).toEqual(PATHS.map((path) => `added:${path}`).sort());
    const complete = rig.events.completed;
    expect(complete).toHaveLength(1);
    expect(complete[0]).toMatchObject({ rootCid: rig.node.cidOf(ROOT), manifestCid: rig.node.cidOf(`${ROOT}/current`), written: 3, removed: 0 });
    const allowed = new Set(["path", "kind", "sha256", "rootCid", "manifestCid", "written", "removed", "durationMs"]);
    expect([...rig.events.changed, ...complete].flatMap((event) => Object.keys(event)).every((key) => allowed.has(key))).toBe(true);
    const events = JSON.stringify([...rig.events.changed, ...complete]);
    expect(events).not.toContain(String.fromCharCode(...rig.passphrase));
  });
});

describe("encrypted publish: delta behaviour", () => {
  it("sends no write and no name/publish when nothing changed, and does not move the sequence", async () => {
    const rig = await published();
    rig.node.calls.length = 0;
    const again = await rig.publish({ ownedKeys: rig.owned });
    expect(again).toMatchObject({ published: false, written: 0, removed: 0, keyCreated: false });
    expect(rig.node.calls.filter((call) => /^(write|rm|pin|publish|keyGen) /.test(call))).toEqual([]);
    expect((await rig.manifest()).sequence).toBe(1);
  });

  it("rewrites exactly one blob after one edit and the sequence goes from 1 to 2", async () => {
    const rig = await published();
    const before = new Map(blobPaths(rig.node).map((path) => [path, rig.node.cidOf(path)]));
    rig.node.calls.length = 0;
    rig.host.put(TITLE_PATH, `The ${SECRET_WORD} merger closed early.\n`, 2000);
    const result = await rig.publish();
    expect(result).toMatchObject({ published: true, written: 1, removed: 0, sequence: 2, keyCreated: false });

    const changed = blobPaths(rig.node).filter((path) => rig.node.cidOf(path) !== before.get(path));
    expect(changed).toHaveLength(1);
    expect(shape(rig.node.calls).filter((call) => call.startsWith("write "))).toEqual(["write <root>/current/<blob>", "write <root>/manifest.enc", "write <root>/manifests/<cid>.enc"]);
    const manifest = await rig.manifest();
    expect(manifest.sequence).toBe(2);
    expect(manifest.files[TITLE_PATH]?.size).toBe(utf8(`The ${SECRET_WORD} merger closed early.\n`).length);
    const histories = [...rig.node.files.keys()].filter((path) => path.startsWith(`${ROOT}/manifests/`));
    expect(histories).toHaveLength(2);
    expect(rig.events.changed.at(-1)).toMatchObject({ path: TITLE_PATH, kind: "modified" });
  });

  it("does not read, hash or encrypt a file whose size and modification time are unchanged", async () => {
    const rig = await published();
    rig.host.put(TITLE_PATH, `The ${SECRET_WORD} merger closed early.\n`, 2000);
    rig.host.reads.wholeReads.length = 0;
    rig.host.reads.rangeLengths.length = 0;
    await rig.publish();
    // The marker check and the unlock read their own small files (".ipfs-sync*"); no vault file except the edited one is read.
    expect(rig.host.reads.wholeReads.filter((path) => !path.startsWith(".ipfs-sync"))).toEqual([TITLE_PATH]);
    expect(rig.host.reads.rangeLengths).toHaveLength(1);
  });

  it("removes the blob of a deleted file, counts it, and keeps earlier history files", async () => {
    const rig = await published();
    const first = await rig.manifest();
    const gone = `${ROOT}/${blobMfsPath(first.files["attachment.bin"]?.blob ?? "")}`;
    rig.host.drop("attachment.bin");
    const result = await rig.publish();
    expect(result).toMatchObject({ written: 0, removed: 1, sequence: 2 });
    expect(rig.node.files.has(gone)).toBe(false);
    expect(rig.node.calls).toContain(`rm ${gone}`);
    expect(Object.keys((await rig.manifest()).files).sort()).toEqual([PATHS[0], PATHS[1]]);
    expect(rig.node.files.has(`${ROOT}/manifests/${first.rootCID}.enc`)).toBe(true);
    expect(rig.events.changed.at(-1)).toEqual({ path: "attachment.bin", kind: "removed" });
  });

  it("treats a rename as a removal plus a whole new upload under a new opaque name", async () => {
    const rig = await published();
    const before = await rig.manifest();
    const oldBlob = before.files["Daily/2026-09-30.md"]?.blob ?? "";
    const data = rig.host.files.get("Daily/2026-09-30.md")?.data ?? new Uint8Array();
    rig.host.drop("Daily/2026-09-30.md");
    rig.host.put("Daily/2026-10-01.md", data, 1000);
    const result = await rig.publish();
    expect(result).toMatchObject({ written: 1, removed: 1 });
    const after = await rig.manifest();
    expect(after.files["Daily/2026-10-01.md"]?.blob).not.toBe(oldBlob);
    expect(rig.node.files.has(`${ROOT}/${blobMfsPath(oldBlob)}`)).toBe(false);
    expect(rig.node.files.has(`${ROOT}/${blobMfsPath(after.files["Daily/2026-10-01.md"]?.blob ?? "")}`)).toBe(true);
  });

  it("adds a new file as one blob", async () => {
    const rig = await published();
    rig.host.put("notes/new.md", "brand new", 3000);
    expect(await rig.publish()).toMatchObject({ written: 1, removed: 0, sequence: 2 });
    expect(Object.keys((await rig.manifest()).files)).toContain("notes/new.md");
  });

  it("a file that goes back to earlier content is written again under a fresh file identifier", async () => {
    const rig = await published();
    const original = decodeText(rig.host.files.get(TITLE_PATH)?.data);
    const first = (await rig.manifest()).files[TITLE_PATH];
    rig.host.put(TITLE_PATH, "in between\n", 2000);
    await rig.publish();
    rig.host.put(TITLE_PATH, original, 3000);
    await rig.publish();
    const third = (await rig.manifest()).files[TITLE_PATH];
    expect(third?.sha256).toBe(first?.sha256);
    expect(third?.fileId).not.toBe(first?.fileId);
    expect(third?.cid).not.toBe(first?.cid);
  });

  it("leaves the empty prefix folder of a removed blob in place", async () => {
    const rig = await published();
    const blob = (await rig.manifest()).files["attachment.bin"]?.blob ?? "";
    rig.host.drop("attachment.bin");
    await rig.publish();
    expect(rig.node.cidOf(`${ROOT}/current/${blob.slice(0, 2)}`)).toBeDefined();
  });

  it("publishes the vault when every file was deleted, as an empty manifest", async () => {
    const rig = await published();
    for (const path of PATHS) rig.host.drop(path);
    const result = await rig.publish();
    expect(result).toMatchObject({ published: true, written: 0, removed: 3, sequence: 2 });
    expect(Object.keys((await rig.manifest()).files)).toEqual([]);
  });
});
