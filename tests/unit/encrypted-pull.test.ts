// mvp-07a task 4.6a: the decrypting pull, steps 1 to 6 (guard, locks, target, unlock, authenticate, path policy, verdict,
// first-pull confirmation, key-slot copy, floor). A recording node serves a real encrypted vault published by device A;
// device B pulls it. The stage (steps 7 and 8) is a recording stand-in: these tests prove what happens BEFORE it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const kdf = vi.hoisted(() => ({ derivations: 0 }));
vi.mock("@noble/hashes/argon2.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@noble/hashes/argon2.js")>();
  return { ...original, argon2idAsync: (...args: Parameters<typeof original.argon2idAsync>) => (kdf.derivations++, original.argon2idAsync(...args)) };
});

import { MANIFEST_MAX_FILE_BYTES, canonicalizePassphraseText } from "../../src/crypto";
import { KuboHttpError } from "../../src/kubo";
import type { FirstPullDetails } from "../../src/sync/encrypted-pull";
import { manifestIdentity } from "../../src/sync/manifest-identity";
import { describeLock, encodeLock } from "../../src/sync/publish-lock";
import { lockHeld } from "../../src/sync/publish-refusals";
import { rootFileNames } from "../../src/sync/root-files";
import { SEQUENCE_FLOOR_FILE, readFloor } from "../../src/sync/sequence-floor";
import { keySlotsCopyPath } from "../../src/sync/vault-keys";
import { createMemoryHost } from "../helpers/memory-host";
import { KEY, ROOT, blobPaths, type Rig } from "../helpers/publish-rig";
import {
  NOW,
  currentRoot,
  expectNothingWritten,
  expectOnlyReads,
  forgeManifest,
  newPuller,
  pointNameAt,
  publishedOnce,
  resetNodeTrace,
  runPull,
  stopOf,
  verifiedOf,
} from "../helpers/encrypted-pull-rig";
import { seal } from "../vectors/manifest-helpers";
import { OTHER_PASSPHRASE, referencePassphrase } from "../vectors/slot-helpers";

const gets = (calls: readonly string[]): string[] => calls.filter((line) => line.startsWith("GET "));
const PASSPHRASE_TEXT = new TextDecoder().decode(referencePassphrase());

/** A vault published once by device A. The derivation counter is reset, so a test counts only what the pull does. */
async function vault(): Promise<Rig> {
  const rig = await publishedOnce();
  kdf.derivations = 0;
  return rig;
}

beforeEach(() => {
  kdf.derivations = 0;
});

describe("a first pull that is confirmed", () => {
  it("authenticates, stores the key-slot copy and the floor, and hands a verified pull to the stage; every request is a read", async () => {
    const rig = await vault();
    const b = newPuller();
    const verified = verifiedOf(await runPull(rig, b));
    expect(kdf.derivations).toBe(1); // read before the helper below opens the publisher's vault

    expect(verified.verdict.kind).toBe("first-pull");
    expect(verified.firstPullConfirmed).toBe(true);
    expect(verified.target).toEqual({ kind: "name", rootCid: currentRoot(rig.node), ipnsName: rig.node.keys.find((key) => key.name === KEY)?.id, historyName: undefined });
    expect(verified.manifest.sequence).toBe(1);
    expect(verified.identity).toBe(manifestIdentity(await rig.manifest()));
    expectOnlyReads(rig.node);

    // The only writes: the key-slot copy (byte for byte what the node holds) and the floor. No state, no marker, no vault file.
    const copyPath = await keySlotsCopyPath(ROOT);
    expect(b.host.mutations).toEqual([`write ${copyPath}`]);
    expect(b.host.files.get(copyPath)?.data).toEqual(rig.node.files.get(`${ROOT}/keyslots.json`));
    expect(b.host.kvStore.size).toBe(0);
    expect(b.store.writes).toEqual([SEQUENCE_FLOOR_FILE]);
    const floor = await readFloor(b.store, verified.manifest.vaultId);
    expect(floor).toEqual({ sequence: 1, identity: verified.identity, at: NOW });
    expect(verified.keySlotsStored).toBe(true);
    expect(verified.floorWritten).toBe(true);
    expect(verified.needsMarker).toBe(false);
    expect(verified.policy.refusals).toEqual([]);
  });

  it("holds both locks for the stage and releases them after it, on every path", async () => {
    const rig = await vault();
    const b = newPuller();
    let heldDuring: boolean | undefined;
    let processHeld = false;
    let released = 0;
    await runPull(rig, b, {
      deps: {
        processLock: {
          tryAcquire: () => {
            processHeld = true;
            return () => {
              processHeld = false;
              released += 1;
            };
          },
        },
        stage: async () => {
          heldDuring = b.locks.file.bytes !== undefined && processHeld;
          return "ok";
        },
      },
    });
    expect(heldDuring).toBe(true);
    expect(b.locks.file.bytes).toBeUndefined();
    expect(processHeld).toBe(false);
    expect(released).toBe(1);

    // A stage that throws still releases both.
    const c = newPuller();
    await expect(
      runPull(rig, c, {
        deps: {
          processLock: { tryAcquire: () => () => undefined },
          stage: async () => {
            throw new Error("stage failed");
          },
        },
      }),
    ).rejects.toThrow("stage failed");
    expect(c.locks.file.bytes).toBeUndefined();
    expect(c.locks.ctx.stopped).toBe(1);
  });
});

describe("the first-pull confirmation", () => {
  it("a declined first pull writes nothing: no state, no floor, no key-slot copy, no vault file", async () => {
    const rig = await vault();
    const b = newPuller();
    let shown: FirstPullDetails | undefined;
    const stop = stopOf(
      await runPull(rig, b, {
        options: { acceptFirstPull: false },
        deps: {
          confirmFirstPull: async (details) => {
            shown = details;
            return false;
          },
        },
      }),
    );
    expect(stop.reason).toBe("first-pull-declined");
    expectNothingWritten(b);
    expectOnlyReads(rig.node);
    expect(b.locks.file.bytes).toBeUndefined();
    // It did derive once (the confirmation comes after authentication), and it showed the authenticated values and the statements.
    expect(kdf.derivations).toBe(1);
    expect(shown).toMatchObject({ target: "name", sequence: 1, fileCount: 3, pathsRefused: 0 });
    expect(shown?.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(shown?.statements.join(" ")).toContain("chosen by whoever holds the vault key");
    expect(shown?.statements.join(" ")).toContain("no baseline");
  });

  it("a non-interactive pull without --accept-first-pull refuses before writing anything", async () => {
    const rig = await vault();
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b, { options: { acceptFirstPull: false } }));
    expect(stop.reason).toBe("first-pull-not-confirmed");
    expect(stop.message).toContain("--accept-first-pull");
    expectNothingWritten(b);
  });

  it("a confirmation callback that throws is a refusal, never an approval", async () => {
    const rig = await vault();
    const b = newPuller();
    const stop = stopOf(
      await runPull(rig, b, {
        options: { acceptFirstPull: false },
        deps: {
          confirmFirstPull: async () => {
            throw new Error("dialog crashed");
          },
        },
      }),
    );
    expect(stop.reason).toBe("first-pull-declined");
    expectNothingWritten(b);
  });

  it("an accepted confirmation is the yes: the same pull then proceeds", async () => {
    const rig = await vault();
    const b = newPuller();
    const verified = verifiedOf(await runPull(rig, b, { options: { acceptFirstPull: false }, deps: { confirmFirstPull: async () => true } }));
    expect(verified.firstPullConfirmed).toBe(true);
    expect(b.staged).toHaveLength(1);
  });

  it("an explicit root target adds the gateway statement", async () => {
    const rig = await vault();
    const b = newPuller();
    let shown: FirstPullDetails | undefined;
    await runPull(rig, b, {
      options: { acceptFirstPull: false, target: { kind: "root-cid", cid: currentRoot(rig.node) } },
      deps: {
        confirmFirstPull: async (details) => {
          shown = details;
          return true;
        },
      },
    });
    expect(shown?.target).toBe("root-cid");
    expect(shown?.statements.join(" ")).toContain("does not verify the returned bytes");
  });
});

describe("authentication comes before anything else is trusted", () => {
  it("a forged manifest requests no blob and writes nothing", async () => {
    const rig = await vault();
    const blobCids = blobPaths(rig.node).map((path) => rig.node.cidOf(path));
    expect(blobCids).toHaveLength(3);
    const forged = Uint8Array.from(rig.node.files.get(`${ROOT}/manifest.enc`) as Uint8Array);
    forged[forged.length - 1] = (forged[forged.length - 1] ?? 0) ^ 0x01;
    rig.node.files.set(`${ROOT}/manifest.enc`, forged);
    pointNameAt(rig.node);
    resetNodeTrace(rig.node);

    const b = newPuller();
    const stop = stopOf(await runPull(rig, b));
    expect(stop.reason).toBe("manifest-not-authentic");
    expect(stop.message).toContain("does not authenticate");
    // Two reads by CID: keyslots.json and manifest.enc. No blob.
    expect(gets(rig.node.calls)).toHaveLength(2);
    for (const cid of blobCids) expect(rig.node.calls.join("\n")).not.toContain(cid ?? "unexpected");
    expectNothingWritten(b);
    expectOnlyReads(rig.node);
  });

  it("a truncated manifest is the same stop", async () => {
    const rig = await vault();
    rig.node.files.set(`${ROOT}/manifest.enc`, (rig.node.files.get(`${ROOT}/manifest.enc`) as Uint8Array).slice(0, 40));
    pointNameAt(rig.node);
    const b = newPuller();
    expect(stopOf(await runPull(rig, b)).reason).toBe("manifest-not-authentic");
    expectNothingWritten(b);
  });

  it("an oversize manifest is refused from the listing, without downloading it", async () => {
    const rig = await vault();
    rig.node.sizeLie = (name) => (name === "manifest.enc" ? MANIFEST_MAX_FILE_BYTES + 1 : undefined);
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b));
    expect(stop.reason).toBe("remote-object");
    expect(gets(rig.node.calls)).toHaveLength(1); // keyslots.json only
    expectNothingWritten(b);
  });

  it("a manifest of another vault's key does not authenticate", async () => {
    const rig = await vault();
    const other = await publishedOnce();
    rig.node.files.set(`${ROOT}/manifest.enc`, other.node.files.get(`${ROOT}/manifest.enc`) as Uint8Array);
    pointNameAt(rig.node);
    const b = newPuller();
    expect(stopOf(await runPull(rig, b)).reason).toBe("manifest-not-authentic");
    expectNothingWritten(b);
  });

  it("an authenticated manifest this build cannot read is a separate, named stop", async () => {
    const rig = await vault();
    const keys = await rig.keys();
    rig.node.files.set(`${ROOT}/manifest.enc`, await seal(keys, JSON.stringify({ version: 3 })));
    pointNameAt(rig.node);
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b));
    expect(stop.reason).toBe("manifest-unsupported");
    expectNothingWritten(b);
  });
});

describe("key slots without a manifest", () => {
  it("refuses when manifest.enc is absent, treats the vault as neither empty nor creatable, and writes nothing", async () => {
    const rig = await vault();
    rig.node.files.delete(`${ROOT}/manifest.enc`);
    pointNameAt(rig.node);
    resetNodeTrace(rig.node);
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b));
    expect(stop.reason).toBe("slots-without-manifest");
    expect(stop.message).toMatch(/withheld or not yet published/);
    expect(stop.message).toMatch(/neither empty nor creatable/);
    expectNothingWritten(b);
    expectOnlyReads(rig.node);
    expect(kdf.derivations).toBe(0); // refused before any derivation on node-supplied parameters
  });

  it("refuses when the listing names manifest.enc but the gateway answers 404 for it", async () => {
    const rig = await vault();
    const manifestCid = rig.node.cidOf(`${ROOT}/manifest.enc`);
    const gatewayStream = rig.node.client.gatewayStream.bind(rig.node.client);
    const client = {
      ...rig.node.client,
      gatewayStream: (cid: string, path?: string, range?: { start: number; length: number }) =>
        cid === manifestCid ? Promise.reject(new KuboHttpError("gateway", "https://gw.test", 404, "not found")) : gatewayStream(cid, path, range),
    };
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b, { deps: { client } }));
    expect(stop.reason).toBe("slots-without-manifest");
    expect(stop.message).toMatch(/withheld or not yet published/);
    expectNothingWritten(b);
  });

  it("refuses the same way on a device that already holds the key-slot copy", async () => {
    const rig = await vault();
    const b = newPuller();
    verifiedOf(await runPull(rig, b));
    rig.node.files.delete(`${ROOT}/manifest.enc`);
    pointNameAt(rig.node);
    const c = newPuller(b.host, b.store);
    expect(stopOf(await runPull(rig, c)).reason).toBe("slots-without-manifest");
  });

  it("a root with neither key slots nor a manifest is reported as not an encrypted vault", async () => {
    const rig = await vault();
    rig.node.files.delete(`${ROOT}/keyslots.json`);
    rig.node.files.delete(`${ROOT}/manifest.enc`);
    pointNameAt(rig.node);
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b));
    expect(stop.reason).toBe("no-key-slots");
    expect(stop.message).toContain("not an encrypted vault");
    expectNothingWritten(b);
  });
});

describe("hostile objects at the names the pull reads", () => {
  it("an oversize keyslots.json is refused from the listing without a download", async () => {
    const rig = await vault();
    rig.node.sizeLie = (name) => (name === "keyslots.json" ? 1024 * 1024 : undefined);
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b));
    expect(stop.reason).toBe("remote-object");
    expect(gets(rig.node.calls)).toEqual([]);
    expect(kdf.derivations).toBe(0);
    expectNothingWritten(b);
  });

  it("a directory where keyslots.json should be is refused as the wrong kind of object", async () => {
    const rig = await vault();
    rig.node.files.delete(`${ROOT}/keyslots.json`);
    await rig.node.client.filesWrite(`${ROOT}/keyslots.json/inner`, new Uint8Array([1]));
    pointNameAt(rig.node);
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b));
    expect(stop.reason).toBe("remote-object");
    expectNothingWritten(b);
  });

  it("key slots the format reader rejects are a named stop, not a crash", async () => {
    const rig = await vault();
    rig.node.files.set(`${ROOT}/keyslots.json`, new TextEncoder().encode("{}"));
    pointNameAt(rig.node);
    const b = newPuller();
    expect(stopOf(await runPull(rig, b)).reason).toBe("key-slots-invalid");
    expect(kdf.derivations).toBe(0);
    expectNothingWritten(b);
  });
});

describe("a planted plaintext manifest", () => {
  it("manifest.json next to an encrypted layout is never requested", async () => {
    const rig = await vault();
    await rig.node.client.filesWrite(`${ROOT}/manifest.json`, new TextEncoder().encode('{"planted":true}'));
    pointNameAt(rig.node);
    const plantedCid = rig.node.cidOf(`${ROOT}/manifest.json`);
    expect(plantedCid).toBeDefined();
    resetNodeTrace(rig.node);

    const b = newPuller();
    verifiedOf(await runPull(rig, b));
    expect(rig.node.calls.join("\n")).not.toContain(plantedCid ?? "unexpected");
    // The root listing is the only place its name appears; no stat, no GET, no ls of it.
    expect(rig.node.calls.filter((line) => line.includes("manifest.json"))).toEqual([]);
    expectOnlyReads(rig.node);
  });
});

describe("locks", () => {
  it("a held publish.lock refuses with publish's own text, before any request", async () => {
    const rig = await vault();
    const b = newPuller();
    const holder = { token: "other-token", pid: 999, host: "other-host", time: NOW };
    b.locks.file.bytes = encodeLock(holder);
    const stop = stopOf(await runPull(rig, b));
    expect(stop.reason).toBe("lock-held");
    expect(stop.message).toBe(lockHeld(describeLock(holder, NOW)).message);
    expect(rig.node.calls).toEqual([]);
    expectNothingWritten(b);
    expect(b.locks.file.bytes).toEqual(encodeLock(holder)); // the other holder's lock is untouched
  });

  it("an unreadable lock file is publish's lock-unreadable refusal", async () => {
    const rig = await vault();
    const b = newPuller();
    b.locks.file.bytes = new TextEncoder().encode("not a lock");
    expect(stopOf(await runPull(rig, b)).reason).toBe("lock-unreadable");
    expect(rig.node.calls).toEqual([]);
  });

  it("another operation in this process refuses before the file lock is even tried", async () => {
    const rig = await vault();
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b, { deps: { processLock: { tryAcquire: () => undefined } } }));
    expect(stop.reason).toBe("busy");
    expect(b.locks.file.creates).toBe(0);
    expect(rig.node.calls).toEqual([]);
    expectNothingWritten(b);
  });

  it("a lock that is lost before the writes of step 6 stops the pull with nothing stored", async () => {
    const rig = await vault();
    const b = newPuller();
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const stop = stopOf(
      await runPull(rig, b, {
        options: { acceptFirstPull: false },
        deps: {
          confirmFirstPull: async () => {
            // Another process takes the lock over while the dialog is open; the next heartbeat notices.
            b.locks.file.bytes = encodeLock({ token: "taken-over", pid: 1, host: "x", time: NOW });
            for (const tick of b.locks.ctx.ticks) tick();
            await flush();
            return true;
          },
        },
      }),
    );
    expect(stop.reason).toBe("lock-lost");
    expectNothingWritten(b);
  });
});

describe("expectations and flags", () => {
  it("--expect-vault-id that differs refuses before any derivation", async () => {
    const rig = await vault();
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b, { options: { flags: { expectVaultId: "0".repeat(32) } } }));
    expect(stop.reason).toBe("expectation-failed");
    expect(kdf.derivations).toBe(0);
    expect(gets(rig.node.calls)).toHaveLength(1); // the slot file, needed to read the vault id; never the manifest
    expectNothingWritten(b);
  });

  it("--expect-vault-id that matches proceeds", async () => {
    const rig = await vault();
    const vaultId = (await rig.manifest()).vaultId;
    const b = newPuller();
    verifiedOf(await runPull(rig, b, { options: { flags: { expectVaultId: vaultId } } }));
  });

  it("--expect-min-sequence above the node's sequence refuses, even for a first pull, and writes nothing", async () => {
    const rig = await vault();
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b, { options: { flags: { expectMinSequence: 9 } } }));
    expect(stop.reason).toBe("expectation-failed");
    expect(stop.message).toContain("below the 9");
    expectNothingWritten(b);
    verifiedOf(await runPull(rig, newPuller(), { options: { flags: { expectMinSequence: 1 } } }));
  });

  it.each([
    ["--allow-rollback with a name target", { kind: "name" as const }, { allowRollback: true }],
    ["--resolve-fork with --root-cid", { kind: "root-cid" as const, cid: "bafyexamplecid0000" }, { resolveFork: true }],
    ["--resolve-fork with --manifest", { kind: "manifest" as const, cid: "bafyexamplecid0000" }, { resolveFork: true }],
    ["--resolve-fork with --allow-rollback", { kind: "name" as const }, { resolveFork: true, allowRollback: true }],
  ])("%s is refused before any request, any lock and any read of the directory", async (_name, target, flags) => {
    const rig = await vault();
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b, { options: { target, flags } }));
    expect(stop.reason).toBe("flag-combination");
    expect(rig.node.calls).toEqual([]);
    expect(b.locks.file.creates).toBe(0);
    expectNothingWritten(b);
  });
});

describe("unlock", () => {
  it("a wrong passphrase on a fresh device: one outcome, one derivation, nothing written; the right one then works", async () => {
    const rig = await vault();
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b, { options: { passphrase: canonicalizePassphraseText(OTHER_PASSPHRASE) } }));
    expect(stop.reason).toBe("wrong-passphrase");
    expect(kdf.derivations).toBe(1);
    expectNothingWritten(b);
    verifiedOf(await runPull(rig, b));
  });

  it("with a local key-slot copy a wrong passphrase makes no request at all", async () => {
    const rig = await vault();
    const b = newPuller();
    verifiedOf(await runPull(rig, b));
    resetNodeTrace(rig.node);
    kdf.derivations = 0;
    const again = newPuller(b.host, b.store);
    const stop = stopOf(await runPull(rig, again, { options: { passphrase: canonicalizePassphraseText(OTHER_PASSPHRASE) } }));
    expect(stop.reason).toBe("wrong-passphrase");
    expect(rig.node.calls).toEqual([]);
    expect(kdf.derivations).toBe(1);
  });

  it("a differing node slot file on a device with a copy refuses and names the accept action", async () => {
    const rig = await vault();
    const b = newPuller();
    verifiedOf(await runPull(rig, b));
    const slots = Uint8Array.from(rig.node.files.get(`${ROOT}/keyslots.json`) as Uint8Array);
    slots[slots.length - 2] = (slots[slots.length - 2] ?? 0) ^ 1;
    rig.node.files.set(`${ROOT}/keyslots.json`, slots);
    pointNameAt(rig.node);
    kdf.derivations = 0;
    const stop = stopOf(await runPull(rig, newPuller(b.host, b.store)));
    expect(stop.reason).toBe("vault-mismatch");
    expect(stop.message).toContain("keys accept-slots");
    expect(kdf.derivations).toBe(1); // the local copy only; none on the node's parameters
  });
});

describe("the directory's local state", () => {
  it("a damaged state file is a stop before any request", async () => {
    const rig = await vault();
    const b = newPuller();
    b.host.kvStore.set(rootFileNames(ROOT).state, new TextEncoder().encode("{ not json"));
    const stop = stopOf(await runPull(rig, b));
    expect(stop.reason).toBe("state-unreadable");
    expect(rig.node.calls).toEqual([]);
    expect(b.host.mutations).toEqual([]);
  });

  it("a populated directory without the marker is no longer refused: the pull goes on to the node (the guard is removed)", async () => {
    const rig = await vault();
    const host = createMemoryHost();
    host.put("private.md", "my real notes");
    const b = newPuller(host);
    const verified = verifiedOf(await runPull(rig, b));
    expect(verified.needsMarker).toBe(false);
    expect(rig.node.calls.length).toBeGreaterThan(0);
    expect(b.locks.file.creates).toBeGreaterThan(0);
  });

  it("a key that is not owned and no --name is a target error, not a request for a name", async () => {
    const rig = await vault();
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b, { options: { ownedKeys: [] } }));
    expect(stop.reason).toBe("target-unresolved");
    expectNothingWritten(b);
  });
});

describe("explicit targets", () => {
  it("--root-cid pulls the named root; the state of the pull would record that root", async () => {
    const rig = await vault();
    const root = currentRoot(rig.node);
    rig.node.published.clear();
    resetNodeTrace(rig.node);
    const b = newPuller();
    const verified = verifiedOf(await runPull(rig, b, { options: { target: { kind: "root-cid", cid: root } } }));
    expect(verified.target).toEqual({ kind: "root-cid", rootCid: root, ipnsName: undefined, historyName: undefined });
    expect(rig.node.calls.some((line) => line.startsWith("nameResolve") || line === "keyList")).toBe(false);
  });

  it("--manifest whose inner rootCID differs from the named CID refuses", async () => {
    const rig = await vault();
    const manifest = await rig.manifest();
    const [name] = [...rig.node.files.keys()].filter((path) => path.startsWith(`${ROOT}/manifests/`));
    const planted = `${ROOT}/manifests/0000000000000001-bafyplantedcid00000000.enc`;
    rig.node.files.set(planted, rig.node.files.get(name as string) as Uint8Array);
    pointNameAt(rig.node);
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b, { options: { target: { kind: "manifest", cid: "bafyplantedcid00000000" } } }));
    expect(stop.reason).toBe("history-entry-mismatch");
    expectNothingWritten(b);
    // The honest name works, and so does the legacy name form of the same tree.
    const honest = verifiedOf(await runPull(rig, newPuller(), { options: { target: { kind: "manifest", cid: manifest.rootCID } } }));
    expect(honest.target.historyName).toBe(`0000000000000001-${manifest.rootCID}.enc`);
    expect(honest.verdict.kind).toBe("first-pull");
  });

  it("--manifest with no entry for the CID, or two entries for it, is a named stop; the legacy name form is found", async () => {
    const rig = await vault();
    const manifest = await rig.manifest();
    const b = newPuller();
    expect(stopOf(await runPull(rig, b, { options: { target: { kind: "manifest", cid: "bafyunknowncid00000000" } } })).reason).toBe("history-entry-not-found");
    const prefixed = `${ROOT}/manifests/0000000000000001-${manifest.rootCID}.enc`;
    const legacy = `${ROOT}/manifests/${manifest.rootCID}.enc`;
    const bytes = rig.node.files.get(prefixed) as Uint8Array;
    rig.node.files.delete(prefixed);
    rig.node.files.set(legacy, bytes);
    pointNameAt(rig.node);
    const found = verifiedOf(await runPull(rig, newPuller(), { options: { target: { kind: "manifest", cid: manifest.rootCID } } }));
    expect(found.target.historyName).toBe(`${manifest.rootCID}.enc`);
    rig.node.files.set(prefixed, bytes);
    pointNameAt(rig.node);
    expect(stopOf(await runPull(rig, b, { options: { target: { kind: "manifest", cid: manifest.rootCID } } })).reason).toBe("history-entry-ambiguous");
    expectNothingWritten(b);
  });
});

describe("hostile text and the path policy", () => {
  const csi = String.fromCodePoint(0x9b);
  const rlo = String.fromCodePoint(0x202e);
  const dotlessI = String.fromCodePoint(0x131);

  it("escapes control characters and bidi overrides in the device label and in every shown path; carries per-path refusals without stopping", async () => {
    const rig = await vault();
    const hostileDevice = `dev${csi}[31m${rlo}<b>x`;
    await forgeManifest(rig, ["Notes/ok.md", "CON.md", `${rlo}evil.`, ".obsidian/plugins/x/main.js"], { device: hostileDevice });
    const b = newPuller();
    let shown: FirstPullDetails | undefined;
    const verified = verifiedOf(
      await runPull(rig, b, {
        options: { acceptFirstPull: false },
        deps: {
          confirmFirstPull: async (details) => {
            shown = details;
            return true;
          },
        },
      }),
    );
    expect(shown?.device).toBe("dev\\u009b[31m\\u202e<b>x");
    expect(shown?.pathsRefused).toBe(3);
    expect(shown?.pathsSummary).toContain('"\\u202eevil." (');
    expect(shown?.pathsSummary).toContain('"CON.md" (');
    expect(shown?.pathsSummary).toContain('".obsidian/plugins/x/main.js" (');
    const everything = JSON.stringify([shown, verified.policy.refusals.map((refusal) => refusal.reason)]);
    expect(everything).not.toContain(csi);
    expect(everything).not.toContain(rlo);
    // Per-path refusals are carried for the plan, with their severity and class; the pull itself went on.
    const byPath = Object.fromEntries(verified.policy.refusals.map((refusal) => [refusal.path, refusal]));
    expect(byPath[".obsidian/plugins/x/main.js"]).toMatchObject({ severity: "unsafe", class: "shape" });
    expect(byPath["CON.md"]).toMatchObject({ severity: "unsafe", class: "platform" });
    expect(byPath[`${rlo}evil.`]).toMatchObject({ severity: "unsafe", class: "platform" });
    expect(verified.policy.accepted).toEqual(["Notes/ok.md"]);
  });

  it("a fold alias of the state folder is refused, and a summary of more than three names is a count", async () => {
    const rig = await vault();
    await forgeManifest(rig, ["a.md", `.${dotlessI}pfs-sync/x`, "CON.md", "aux.txt", ".obsidian/plugins/y/main.js"]);
    const verified = verifiedOf(await runPull(rig, newPuller()));
    expect(verified.policy.accepted).toEqual(["a.md"]);
    const alias = verified.policy.refusals.find((refusal) => refusal.path === `.${dotlessI}pfs-sync/x`);
    expect(alias).toMatchObject({ severity: "unsafe", class: "shape", code: "state-folder" });
    let shown: FirstPullDetails | undefined;
    await runPull(rig, newPuller(), {
      options: { acceptFirstPull: false },
      deps: {
        confirmFirstPull: async (details) => {
          shown = details;
          return false;
        },
      },
    });
    expect(shown?.pathsRefused).toBe(4);
    expect(shown?.pathsSummary).toMatch(/and 1 more$/);
  });

  it("a stop's message escapes node-supplied text from a lower layer", async () => {
    const rig = await vault();
    rig.node.published.set(rig.node.keys.find((key) => key.name === KEY)?.id ?? "", `/ipfs/${csi}${rlo}not-a-root`);
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b));
    expect(stop.reason).toBe("target-unresolved");
    expect(stop.message).toContain("\\u009b\\u202e");
    expect(stop.message).not.toContain(csi);
    expect(stop.message).not.toContain(rlo);
  });
});

describe("no secret in any output", () => {
  it("stops, details and the verified pull carry neither the passphrase nor key material", async () => {
    const rig = await vault();
    const collected: string[] = [];
    const b = newPuller();
    const wrong = await runPull(rig, b, { options: { passphrase: canonicalizePassphraseText(OTHER_PASSPHRASE) } });
    collected.push(JSON.stringify(wrong));
    const declined = await runPull(rig, newPuller(), {
      options: { acceptFirstPull: false },
      deps: {
        confirmFirstPull: async (details) => {
          collected.push(JSON.stringify(details));
          return false;
        },
      },
    });
    collected.push(JSON.stringify(declined));
    const done = verifiedOf(await runPull(rig, newPuller()));
    collected.push(JSON.stringify({ target: done.target, verdict: done.verdict, policy: done.policy, identity: done.identity }));
    for (const text of collected) {
      expect(text).not.toContain(PASSPHRASE_TEXT);
      expect(text).not.toContain(OTHER_PASSPHRASE);
    }
  });
});
