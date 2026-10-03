// mvp-07a task 6.1: what a hostile or merely odd node can serve to a pulling device, through the real production pull (state, floor and locks
// of the integration devices): a planted plaintext manifest, key slots without a manifest, a manifest of another vault, a directory recorded
// for another vault, failed expectations, a first pull that cannot ask, an oversize manifest, a history entry that does not match its name,
// and the paths of an authenticated manifest that the path policy refuses. Each refusal writes nothing.
import { describe, expect, it } from "vitest";
import { MANIFEST_READ_CAP } from "../../src/sync/node-reader";
import { rootFileNames } from "../../src/sync/root-files";
import { pointNameAt, resetNodeTrace } from "../helpers/encrypted-pull-rig";
import { ALL_FILES, addManifestEntries, blobReads, createDevices, type Device } from "../helpers/integration-devices";
import { ROOT } from "../helpers/publish-rig";
import { pulledOf } from "../helpers/pull-stage-rig";
import { editDocument, flipBase64Bit, otherPassphrase } from "../vectors/slot-helpers";

/** Nothing of a pull is on the device: no file, no record, no key-slot copy, no floor entry. */
function expectNothingWritten(device: Device): void {
  expect(device.host.mutations).toEqual([]);
  expect(device.host.kvStore.size).toBe(0);
  expect(device.puller.store.writes).toEqual([]);
  expect(device.puller.locks.file.bytes).toBeUndefined();
}

async function stopOf(device: Device, options: Parameters<Device["pull"]>[0] = {}, from?: Parameters<Device["pull"]>[1]): Promise<{ readonly reason: string; readonly message: string }> {
  const outcome = await device.pull(options, from);
  if (outcome.kind !== "stopped") throw new Error(`expected the pull to stop, it ${outcome.kind}`);
  return outcome.stop;
}

describe("a node that serves more or less than it should", () => {
  it("a planted manifest.json next to the encrypted layout is never read: the pull takes the encrypted path", async () => {
    const { node, b } = await createDevices();
    node.files.set(`${ROOT}/manifest.json`, new TextEncoder().encode(JSON.stringify({ version: 1, files: { "Evil.md": { sha256: "a".repeat(64), size: 1 } } })));
    pointNameAt(node);
    resetNodeTrace(node);

    const { result } = pulledOf(await b.pull());

    expect(node.calls.filter((line) => /^GET \S+\/manifest\.json/.test(line))).toEqual([]);
    expect(Object.keys(b.texts()).sort()).toEqual(ALL_FILES);
    expect(result.settlement.complete).toBe(true);
  });

  it("a wrong passphrase and a damaged slot give the same stop with the same message, and nothing is written", async () => {
    const wrong = await createDevices();
    const damaged = await createDevices();
    const slotsPath = `${ROOT}/keyslots.json`;
    damaged.node.files.set(
      slotsPath,
      editDocument(damaged.node.files.get(slotsPath) ?? new Uint8Array(), (document) => {
        const slot = (document["slots"] as unknown as { commit: string }[])[0];
        if (slot === undefined) throw new Error("the fixture changed");
        slot.commit = flipBase64Bit(slot.commit, 7);
      }),
    );
    pointNameAt(damaged.node);

    const first = await stopOf(wrong.b, { options: { passphrase: otherPassphrase() } });
    const second = await stopOf(damaged.b);

    expect(first.reason).toBe("wrong-passphrase");
    expect(second).toEqual(first);
    expectNothingWritten(wrong.b);
    expectNothingWritten(damaged.b);
  });

  it("a root with no key-slot file is a different outcome from a wrong passphrase: it is not an encrypted vault, or lost its slots", async () => {
    const { node, b } = await createDevices();
    node.files.delete(`${ROOT}/keyslots.json`);
    pointNameAt(node);

    const stop = await stopOf(b);

    expect(stop.reason).toBe("no-key-slots");
    expectNothingWritten(b);
  });

  it("key slots without a manifest are refused as withheld or not yet published; nothing is created", async () => {
    const { node, b } = await createDevices();
    node.files.delete(`${ROOT}/manifest.enc`);
    pointNameAt(node);

    const stop = await stopOf(b);

    expect(stop.reason).toBe("slots-without-manifest");
    expect(stop.message).toMatch(/withheld|not yet published/);
    expectNothingWritten(b);
  });

  it("a manifest above the cap is refused without being downloaded", async () => {
    const { node, b } = await createDevices();
    node.sizeLie = (name) => (name === "manifest.enc" ? MANIFEST_READ_CAP + 1 : undefined);
    resetNodeTrace(node);

    const stop = await stopOf(b);

    expect(stop.reason).toBe("remote-object");
    expect(node.calls.filter((line) => /^GET \S+\/manifest\.enc/.test(line))).toEqual([]);
    expect(blobReads(node)).toEqual([]);
    expectNothingWritten(b);
  });

  it("a history entry whose manifest names another tree than its file name is refused by --manifest", async () => {
    const { node, b } = await createDevices();
    const real = [...node.files.keys()].find((path) => path.startsWith(`${ROOT}/manifests/`));
    const bytes = real === undefined ? undefined : node.files.get(real);
    if (bytes === undefined) throw new Error("the fixture changed");
    const named = `bafy${"a".repeat(40)}`;
    node.files.set(`${ROOT}/manifests/0000000000000001-${named}.enc`, bytes);
    pointNameAt(node);

    const stop = await stopOf(b, { options: { target: { kind: "manifest", cid: named } } });

    expect(stop.reason).toBe("history-entry-mismatch");
    expectNothingWritten(b);
  });
});

describe("the pull refuses before it writes", () => {
  it("a directory recorded for one vault does not pull another vault's root, and no key is derived", async () => {
    const first = await createDevices();
    const other = await createDevices();
    pulledOf(await first.b.pull());
    // The directory keeps its record but has no key-slot copy to compare with (the node's slot file is what is read).
    first.b.host.drop(`.ipfs-sync/${rootFileNames(ROOT).keyslots}`);
    const state = await first.b.state();
    const texts = first.b.texts();
    const writesBefore = first.b.puller.store.writes.length;
    let derived = 0;

    const stop = await stopOf(first.b, { deps: { onProgress: () => void (derived += 1) } }, other.rig);

    expect(stop.reason).toBe("other-vault");
    expect(derived).toBe(0);
    expect(await first.b.state()).toEqual(state);
    expect(first.b.texts()).toEqual(texts);
    expect(first.b.puller.store.writes.length).toBe(writesBefore);
  });

  it("a directory that holds one vault's key-slot copy refuses another vault's slots, names the accept action, and derives nothing", async () => {
    const first = await createDevices();
    const other = await createDevices();
    pulledOf(await first.b.pull());
    const texts = first.b.texts();

    const stop = await stopOf(first.b, {}, other.rig);

    expect(stop.reason).toBe("vault-mismatch");
    expect(stop.message).toContain("accept");
    expect(first.b.texts()).toEqual(texts);
  });

  it("an expectation that fails stops the pull: a minimum sequence the node is below, and a vault id that differs (without deriving a key)", async () => {
    const { b } = await createDevices();
    let derived = 0;

    const low = await stopOf(b, { options: { flags: { expectMinSequence: 9 } } });
    const wrongVault = await stopOf(b, { options: { flags: { expectVaultId: "0".repeat(32) } }, deps: { onProgress: () => void (derived += 1) } });

    expect(low.reason).toBe("expectation-failed");
    expect(low.message).toContain("--expect-min-sequence");
    expect(wrongVault.reason).toBe("expectation-failed");
    expect(wrongVault.message).toContain("--expect-vault-id");
    expect(derived).toBe(0);
    expectNothingWritten(b);
  });

  it("a first pull that cannot ask and was not told to accept refuses before it writes", async () => {
    const { node, b } = await createDevices();
    resetNodeTrace(node);

    const stop = await stopOf(b, { options: { acceptFirstPull: false } });

    expect(stop.reason).toBe("first-pull-not-confirmed");
    expect(stop.message).toContain("--accept-first-pull");
    expect(blobReads(node)).toEqual([]);
    expectNothingWritten(b);
  });

  it("--allow-rollback with a name target is refused before any request", async () => {
    const { node, b } = await createDevices();
    resetNodeTrace(node);

    const stop = await stopOf(b, { options: { flags: { allowRollback: true } } });

    expect(stop.reason).toBe("flag-combination");
    expect(node.calls).toEqual([]);
    expectNothingWritten(b);
  });
});

describe("the paths of an authenticated manifest", () => {
  const dotlessI = "ı";

  it("each refused path is skipped with its class, nothing is written for it, platform names stay in the baseline and carry, and an ordinary tilde name is restored", async () => {
    const { rig, b } = await createDevices({
      seed: (host) => {
        host.put("abc~1.md", "an ordinary tilde name\n", 1000);
        host.put("Note.md", "capital note\n", 1000);
        host.put("note.md", "lower note\n", 1000);
      },
    });
    await addManifestEntries(rig, [`.${dotlessI}pfs-sync/x`, "OBSIDI~1/x", "bad./x"]);

    const { result } = pulledOf(await b.pull());

    const skipped = Object.fromEntries(result.settlement.skipped.map((skip) => [skip.path, skip.severity === "unsafe" ? `unsafe/${skip.class}` : skip.severity]));
    expect(skipped).toEqual({
      [`.${dotlessI}pfs-sync/x`]: "unsafe/shape",
      "OBSIDI~1/x": "unsafe/platform",
      "bad./x": "unsafe/platform",
      "Note.md": "unsafe/platform",
      "note.md": "unsafe/platform",
    });
    expect(result.settlement.needsAttention).toBe(true);
    expect(Object.keys(b.texts()).sort()).toEqual(["abc~1.md", ...ALL_FILES].sort());
    expect(b.host.files.has(`.${dotlessI}pfs-sync/x`)).toBe(false);
    const state = await b.state();
    expect(state?.unmaterialized).toEqual(["Note.md", "OBSIDI~1/x", "bad./x", "note.md"]);
    expect(state?.manifest.files[`.${dotlessI}pfs-sync/x`]).toBeUndefined();
  });
});
