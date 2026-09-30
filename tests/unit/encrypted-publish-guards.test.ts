import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/config";
import { CryptoError, KEY_SLOTS_MAX_BYTES, OversizeInputError } from "../../src/crypto";
import { EmptyVaultError, OwnedKeyNotRecordedError } from "../../src/sync/publish-errors";
import { VaultKeysError } from "../../src/sync/vault-keys";
import { ROOT, createRig, seedVault, type Rig } from "../helpers/publish-rig";
import { createFakeNode } from "../helpers/fake-kubo";
import { otherPassphrase } from "../vectors/slot-helpers";

const KEY = "obsidian-vault-sync";
const MUTATING = /^(write|rm|pin|publish|keyGen) /;

async function ready(): Promise<Rig> {
  const rig = createRig();
  seedVault(rig.host);
  await rig.init();
  return rig;
}

async function published(): Promise<Rig> {
  const rig = await ready();
  await rig.publish();
  rig.node.calls.length = 0;
  return rig;
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

describe("encrypted publish: guards that send no request", () => {
  it("refuses a vault without the fixture marker before anything else, with or without a passphrase", async () => {
    const rig = createRig({ marker: false });
    seedVault(rig.host);
    await expect(rig.publish()).rejects.toMatchObject({ code: "fixture-marker-required" });
    await expect(rig.publish({ passphrase: undefined })).rejects.toMatchObject({ code: "fixture-marker-required" });
    expect(rig.node.calls).toEqual([]);
  });

  it("refuses to publish without a passphrase, before any request, however the vault looks", async () => {
    const rig = await ready();
    const error = await rejection(rig.publish({ passphrase: undefined }));
    expect(error).toMatchObject({ code: "passphrase-required" });
    expect(rig.node.calls).toEqual([]);
  });

  it("stops on a wrong passphrase when a local copy of the key slots exists, before any request", async () => {
    const rig = await ready();
    const error = await rejection(rig.publish({ passphrase: otherPassphrase() }));
    expect(error).toBeInstanceOf(CryptoError);
    expect(error).toMatchObject({ code: "wrong-passphrase-or-damaged-slot" });
    expect(rig.node.calls).toEqual([]);
  });

  it.each(["/obsidian-vault-staging", "/obsidian-vault-sync", "/obsidian-vault-sync/../other", "/"])("refuses the MFS root %s with no request", async (mfsRoot) => {
    const rig = await ready();
    await expect(rig.publish({ mfsRoot })).rejects.toBeInstanceOf(ConfigError);
    expect(rig.node.calls).toEqual([]);
  });

  it.each(["consult-capture", "gomark-relay-lab", "prince-live", "self"])("refuses the key %s with no request", async (keyName) => {
    const rig = await ready();
    await expect(rig.publish({ keyName })).rejects.toBeInstanceOf(ConfigError);
    expect(rig.node.calls).toEqual([]);
  });
});

describe("encrypted publish: what the root may hold", () => {
  it("never creates a vault: an empty root is refused, naming `ipfs-sync init`, and nothing is written", async () => {
    const rig = createRig();
    seedVault(rig.host);
    const error = await rejection(rig.publish());
    expect(error).toMatchObject({ code: "no-vault" });
    expect((error as Error).message).toContain("ipfs-sync init");
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    expect(rig.node.files.size).toBe(0);
  });

  it("refuses a root that holds a plaintext manifest.json, suggesting a new MFS root, and writes nothing", async () => {
    const rig = await ready();
    await rig.node.client.filesWrite(`${ROOT}/manifest.json`, new TextEncoder().encode("{}"));
    rig.node.calls.length = 0;
    const error = await rejection(rig.publish());
    expect(error).toMatchObject({ code: "plaintext-root" });
    expect((error as Error).message).toContain("new MFS root");
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("refuses plaintext entries under current/ that do not match the blob layout", async () => {
    const rig = await ready();
    await rig.node.client.filesWrite(`${ROOT}/current/notes/a.md`, new TextEncoder().encode("plain"));
    rig.node.calls.length = 0;
    await expect(rig.publish()).rejects.toMatchObject({ code: "plaintext-root" });
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("refuses an extra top-level entry before uploading anything, naming it", async () => {
    const rig = await published();
    await rig.node.client.filesWrite(`${ROOT}/stray.txt`, new TextEncoder().encode("x"));
    rig.host.put("notes/new.md", "new", 5000);
    rig.node.calls.length = 0;
    const error = await rejection(rig.publish());
    expect(error).toMatchObject({ code: "unexpected-root-entry" });
    expect((error as Error).message).toContain('"stray.txt"');
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("refuses a device with no state and no copy of the slots when the node holds a vault, deriving and writing nothing", async () => {
    const first = await published();
    const second = createRig({ node: first.node });
    seedVault(second.host);
    const error = await rejection(second.publish());
    expect(error).toBeInstanceOf(VaultKeysError);
    expect(error).toMatchObject({ code: "new-device" });
    expect(first.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("stops without generating a key when the node lost the key slots", async () => {
    const rig = await published();
    rig.node.files.delete(`${ROOT}/keyslots.json`);
    const error = await rejection(rig.publish());
    expect(error).toMatchObject({ code: "lost-slots" });
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("finishes an interrupted first publish with the same vault key: the slots that never reached the node are written first", async () => {
    const rig = await ready();
    const slots = rig.node.files.get(`${ROOT}/keyslots.json`) as Uint8Array;
    rig.node.files.delete(`${ROOT}/keyslots.json`);
    const result = await rig.publish();
    expect(result).toMatchObject({ published: true, sequence: 1 });
    const firstWrite = rig.node.calls.find((call) => call.startsWith("write "));
    expect(firstWrite).toBe(`write ${ROOT}/keyslots.json`);
    expect(rig.node.files.get(`${ROOT}/keyslots.json`)).toEqual(slots);
    expect((await rig.manifest()).vaultId).toBe((await rig.keys()).vaultId);
  });
});

describe("encrypted publish: hostile objects on the node", () => {
  it("refuses a key-slot file that is not the local copy (another vault's, or one byte off) and writes nothing", async () => {
    const rig = await published();
    const genuine = rig.node.files.get(`${ROOT}/keyslots.json`) as Uint8Array;
    const flipped = Uint8Array.from(genuine);
    flipped[flipped.length - 3] = (flipped[flipped.length - 3] ?? 0) ^ 1;
    const stranger = createRig();
    await stranger.init();
    for (const bytes of [flipped, stranger.node.files.get(`${ROOT}/keyslots.json`) as Uint8Array]) {
      rig.node.files.set(`${ROOT}/keyslots.json`, bytes);
      rig.node.calls.length = 0;
      await expect(rig.publish()).rejects.toMatchObject({ code: "vault-mismatch" });
      expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    }
  });

  it("refuses an oversize key-slot file from its stated size, without downloading it", async () => {
    const rig = await published();
    rig.node.files.set(`${ROOT}/keyslots.json`, new Uint8Array(KEY_SLOTS_MAX_BYTES + 1024));
    rig.node.calls.length = 0;
    await expect(rig.publish()).rejects.toMatchObject({ code: "remote-object-too-large" });
    expect(rig.node.calls.filter((call) => call.startsWith("GET "))).toEqual([]);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("cuts off a key-slot file whose stated size is understated, at the cap", async () => {
    const rig = await published();
    rig.node.files.set(`${ROOT}/keyslots.json`, new Uint8Array(KEY_SLOTS_MAX_BYTES * 4));
    rig.node.sizeLie = (name) => (name === "keyslots.json" ? 1024 : undefined);
    rig.node.calls.length = 0;
    await expect(rig.publish()).rejects.toMatchObject({ code: "remote-object-too-large" });
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("refuses a 200 MiB manifest.enc from its stated size, without downloading it", async () => {
    const rig = await published();
    rig.node.sizeLie = (name) => (name === "manifest.enc" ? 200 * 1024 * 1024 : undefined);
    rig.host.put("notes/changed-since.md", "a change, so the publish is not idle", 9000);
    rig.node.calls.length = 0;
    await expect(rig.publish()).rejects.toMatchObject({ code: "remote-object-too-large" });
    expect(rig.node.calls.filter((call) => call.startsWith("GET ")).length).toBe(1); // the key slots only
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("refuses a manifest.enc that does not authenticate (garbage, one flipped bit, another vault's) with a typed message and writes nothing", async () => {
    const rig = await published();
    const genuine = rig.node.files.get(`${ROOT}/manifest.enc`) as Uint8Array;
    const flipped = Uint8Array.from(genuine);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    const stranger = await published();
    for (const bytes of [new Uint8Array(200).fill(7), flipped, stranger.node.files.get(`${ROOT}/manifest.enc`) as Uint8Array]) {
      rig.node.files.set(`${ROOT}/manifest.enc`, bytes);
      rig.node.calls.length = 0;
      const error = await rejection(rig.publish());
      expect(error).toMatchObject({ name: "PublishRefusedError", code: "node-manifest-unreadable" });
      expect((error as Error).message).toContain("--repair");
      expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
    }
  });
});

describe("encrypted publish: caps and formats are checked before any blob is written", () => {
  it("refuses a vault whose paths exceed the manifest's path-byte cap, naming the cap", async () => {
    const rig = await ready();
    for (let index = 0; index < 9; index += 1) rig.host.put(`${"x".repeat(1_000_000)}${index}.md`, "a", 1000);
    const error = await rejection(rig.publish());
    expect(error).toBeInstanceOf(OversizeInputError);
    expect(error).toMatchObject({ cap: "manifest-path-bytes" });
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("refuses a file name a manifest cannot carry (a backslash) before the first write", async () => {
    const rig = await ready();
    rig.host.put("notes/ok.md", "fine", 1000);
    rig.host.put("notes/bad\\name.md", "x", 1000);
    const error = await rejection(rig.publish());
    expect(error).toBeInstanceOf(CryptoError);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("refuses an empty vault before the first write", async () => {
    const rig = createRig();
    await rig.init();
    await expect(rig.publish()).rejects.toBeInstanceOf(EmptyVaultError);
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });
});

describe("encrypted publish: publication key", () => {
  it("refuses a foreign key of the same name after the unlock, and sends neither a write nor name/publish", async () => {
    const node = createFakeNode([{ name: KEY, id: "k51foreign" }]);
    const rig = createRig({ node });
    seedVault(rig.host);
    await rig.init();
    await expect(rig.publish()).rejects.toMatchObject({ code: "foreign-key" });
    expect(node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("adopts a foreign key only when its exact ID is passed", async () => {
    const node = createFakeNode([{ name: KEY, id: "k51foreign" }]);
    const rig = createRig({ node });
    seedVault(rig.host);
    await rig.init();
    await expect(rig.publish({ ownedKeys: ["k51other"] })).rejects.toMatchObject({ code: "foreign-key" });
    const result = await rig.publish({ ownedKeys: ["k51foreign"] });
    expect(result).toMatchObject({ published: true, keyId: "k51foreign", keyCreated: false });
    expect(node.calls.some((call) => call.startsWith("keyGen"))).toBe(false);
  });

  it("classifies a key whose ID the node hides as foreign", async () => {
    const node = createFakeNode([{ name: KEY, id: "" }]);
    const rig = createRig({ node });
    seedVault(rig.host);
    await rig.init();
    await expect(rig.publish({ ownedKeys: ["k51mine"] })).rejects.toMatchObject({ code: "foreign-key" });
  });

  it("stops before any write when the generated key ID cannot be recorded, naming the ID", async () => {
    const rig = await ready();
    const error = await rejection(
      rig.publish({
        recordOwnedKey: async () => {
          throw new Error("read-only file system");
        },
      }),
    );
    expect(error).toBeInstanceOf(OwnedKeyNotRecordedError);
    expect((error as Error).message).toContain(`--owned-key ${rig.node.keys[0]?.id}`);
    expect(rig.node.calls.filter((call) => /^(write|rm|pin|publish) /.test(call))).toEqual([]);
  });

  it("does not generate a key that already exists and is owned", async () => {
    const node = createFakeNode([{ name: KEY, id: "k51mine" }]);
    const rig = createRig({ node });
    seedVault(rig.host);
    await rig.init();
    await rig.publish({ ownedKeys: ["k51mine"] });
    expect(node.calls.some((call) => call.startsWith("keyGen"))).toBe(false);
  });
});
