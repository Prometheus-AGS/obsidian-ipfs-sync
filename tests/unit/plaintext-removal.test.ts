// mvp-07b task 3.1c: the plaintext reader is gone. These tests pin the three refusals the removal leaves behind (a plaintext root, key
// slots without a manifest, a planted manifest.json) at the decrypting pull's engine, and the absence of the deleted modules. The CLI
// and plugin renderings of the plaintext refusal are in cli-pull-encrypted.test.ts, plugin-pull-entry.test.ts and plugin-pull-runner.test.ts;
// the publish-side refusals are in encrypted-publish-guards.test.ts and sync-vault-keys.test.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createObsidianFs } from "../../src/plugin/obsidian-fs";
import { createFolderKv } from "../../src/plugin/obsidian-kv";
import { PLAINTEXT_UNSUPPORTED_MESSAGE } from "../../src/sync/pull-errors";
import { ROOT, type Rig } from "../helpers/publish-rig";
import {
  expectNothingWritten,
  expectOnlyReads,
  newPuller,
  pointNameAt,
  publishedOnce,
  resetNodeTrace,
  runPull,
  stopOf,
  verifiedOf,
} from "../helpers/encrypted-pull-rig";
import { MemoryAdapter } from "../support/memory-adapter";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const PLANTED = new TextEncoder().encode(JSON.stringify({ version: 1, files: {} }));

/** The root the way the removed plaintext publisher left it: a `manifest.json`, no key slots, no `manifest.enc`. */
function servePlaintextRoot(rig: Rig): void {
  rig.node.files.delete(`${ROOT}/keyslots.json`);
  rig.node.files.delete(`${ROOT}/manifest.enc`);
  rig.node.files.set(`${ROOT}/manifest.json`, PLANTED);
  pointNameAt(rig.node);
  resetNodeTrace(rig.node);
}

describe("the plaintext reader is gone", () => {
  it.each(["manifest", "state", "pull", "pull-plan", "pull-fetch", "pull-record", "pull-target", "pull-screen", "pull-latch"])("src/sync/%s.ts no longer exists", (name) => {
    expect(existsSync(join(repoRoot, "src", "sync", `${name}.ts`))).toBe(false);
  });
});

describe("a plaintext root is refused by the decrypting pull", () => {
  it("stops with the plaintext refusal on a device that never saw the vault, writes nothing, and never requests the manifest", async () => {
    const rig = await publishedOnce();
    servePlaintextRoot(rig);
    const b = newPuller();

    const stop = stopOf(await runPull(rig, b));

    expect(stop.reason).toBe("plaintext-root");
    expect(stop.message).toBe(PLAINTEXT_UNSUPPORTED_MESSAGE);
    expect(stop.message).toContain("no longer supported");
    expect(stop.message).not.toMatch(/--allow|--manifest-file|downgrade/);
    expectNothingWritten(b);
    expectOnlyReads(rig.node);
    expect(rig.node.calls.filter((line) => line.includes("manifest.json"))).toEqual([]);
  });

  it("stops the same way on a device that holds the vault's key-slot copy, whatever it recorded: the root alone decides", async () => {
    const rig = await publishedOnce();
    const b = newPuller();
    verifiedOf(await runPull(rig, b));
    const written = [...b.host.mutations];
    const floorWrites = [...b.store.writes];
    servePlaintextRoot(rig);
    const again = newPuller(b.host, b.store);

    const stop = stopOf(await runPull(rig, again));

    expect(stop.reason).toBe("plaintext-root");
    expect(stop.message).toBe(PLAINTEXT_UNSUPPORTED_MESSAGE);
    expect(b.host.mutations).toEqual(written);
    expect(b.store.writes).toEqual(floorWrites);
    expect(again.staged).toEqual([]);
    expect(rig.node.calls.filter((line) => line.includes("manifest.json"))).toEqual([]);
  });

  it("keeps an empty or unknown root apart from a plaintext one: it is the ordinary no-key-slots stop, with no plaintext wording", async () => {
    const rig = await publishedOnce();
    rig.node.files.delete(`${ROOT}/keyslots.json`);
    rig.node.files.delete(`${ROOT}/manifest.enc`);
    pointNameAt(rig.node);
    const b = newPuller();

    const stop = stopOf(await runPull(rig, b));

    expect(stop.reason).toBe("no-key-slots");
    expect(stop.message).not.toBe(PLAINTEXT_UNSUPPORTED_MESSAGE);
    expect(stop.message).not.toMatch(/plaintext/i);
    expectNothingWritten(b);
  });
});

describe("key slots without a manifest, and a planted manifest.json", () => {
  it("a planted manifest.json does not turn key slots without manifest.enc into a readable or creatable root", async () => {
    const rig = await publishedOnce();
    rig.node.files.delete(`${ROOT}/manifest.enc`);
    rig.node.files.set(`${ROOT}/manifest.json`, PLANTED);
    pointNameAt(rig.node);
    resetNodeTrace(rig.node);
    const b = newPuller();

    const stop = stopOf(await runPull(rig, b));

    expect(stop.reason).toBe("slots-without-manifest");
    expect(stop.message).toMatch(/neither empty nor creatable/);
    expectNothingWritten(b);
    expect(rig.node.calls.filter((line) => line.includes("manifest.json"))).toEqual([]);
  });
});

describe("no downgrade latch survives in the plugin's state store", () => {
  it("the folder key-value store lists key-shaped files only: an abandoned-<h>-<ms> backup folder is not listed and no latch file is read", async () => {
    const adapter = new MemoryAdapter();
    adapter.put(".ipfs-sync/keep.json", "{}");
    const kv = createFolderKv(createObsidianFs(adapter));
    for (const folder of ["abandoned-nothex-1", "abandoned-0123456789abcdef-", "other-folder", "abandoned-0123456789abcdef-1700"]) await adapter.mkdir(`.ipfs-sync/${folder}`);
    adapter.put(".ipfs-sync/abandoned-0123456789abcdef-1700/keyslots.0123456789abcdef.json", "{}");

    expect(await kv.list("")).toEqual(["keep.json"]);
    expect(await kv.list("aband")).toEqual([]);
    expect(await kv.get("encrypted-seen.json")).toBeUndefined();
  });
});
