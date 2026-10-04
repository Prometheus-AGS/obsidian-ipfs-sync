import { describe, expect, it } from "vitest";
import type { HostKv } from "../../src/core/host-bridge";
import { historyFileName } from "../../src/sync/history-names";
import { buildJournal, readJournal, writeJournal } from "../../src/sync/journal";
import {
  MAINTENANCE_JOURNAL_VERSION,
  PRUNE_PHASES,
  REWRAP_PHASES,
  assertNoMaintenanceJournal,
  assertNoPublishJournal,
  buildPruneJournal,
  buildRewrapJournal,
  decodeMaintenanceJournal,
  discardMaintenanceJournal,
  encodeMaintenanceJournal,
  readMaintenanceJournal,
  writeMaintenanceJournal,
  type MaintenanceFacts,
} from "../../src/sync/maintenance-journal";
import { MAINTENANCE_WAYS_OUT, PublishRefusedError } from "../../src/sync/publish-refusals";
import { rootFileNames } from "../../src/sync/root-files";
import { ABANDON_CONFIRMATION, abandonVault, rootDigest } from "../../src/sync/vault-keys";
import { keysFrom, manifestFor } from "../vectors/manifest-helpers";
import { expectNothingWritten, newPuller, runPull, stopOf } from "../helpers/encrypted-pull-rig";
import { MUTATING_REQUEST } from "../helpers/encrypted-pull-rig";
import { createMemoryHost } from "../helpers/memory-host";
import { KEY, ROOT, createRig, seedVault } from "../helpers/publish-rig";
import { createFakeNode } from "../helpers/fake-kubo";

const MFS = "/obsidian-vault-sync/maint-test";
const CID_A = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CID_B = "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354";

const facts = (): MaintenanceFacts => ({
  mfsRoot: MFS,
  key: "obsidian-vault-sync",
  vaultId: "a".repeat(32),
  keyslotsSha256: "b".repeat(64),
  startRoot: CID_A,
  nodeSequence: 4,
  manifestSha256: "c".repeat(64),
  startedAt: "2026-10-03T10:00:00.000Z",
});

const OLD = new Uint8Array([1, 2, 3]);
const NEW = new Uint8Array([4, 5, 6, 7]);
const rewrap = () => buildRewrapJournal(facts(), { oldKeySlots: OLD, newKeySlots: NEW });
const names = (): string[] => [historyFileName(1, CID_A), historyFileName(2, CID_B)];
const prune = () => buildPruneJournal(facts(), names());

/** A kv that records every write, so "no write occurs" is a fact and not a hope. */
function recordingKv(): HostKv & { readonly writes: string[] } {
  const host = createMemoryHost();
  const writes: string[] = [];
  return {
    get: (key) => host.kv.get(key),
    list: (prefix) => host.kv.list(prefix),
    set: async (key, value) => {
      writes.push(`set ${key}`);
      await host.kv.set(key, value);
    },
    delete: async (key) => {
      writes.push(`delete ${key}`);
      await host.kv.delete(key);
    },
    writes,
  };
}

const refusal = async (promise: Promise<unknown>): Promise<PublishRefusedError> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(PublishRefusedError);
  return error as PublishRefusedError;
};

describe("maintenance journal: format", () => {
  it("is its own file, with its own version, a type and a phase", () => {
    expect(rootFileNames(MFS).maintenance).toMatch(/^maintenance\.[0-9a-f]{16}\.json$/);
    expect(rootFileNames(MFS).maintenance).not.toBe(rootFileNames(MFS).journal);
    expect(MAINTENANCE_JOURNAL_VERSION).toBe(1);
    const body = JSON.parse(new TextDecoder().decode(encodeMaintenanceJournal(rewrap()))) as Record<string, unknown>;
    expect(body).toMatchObject({ version: 1, type: "rewrap", phase: "journaled", snapshotRoot: null });
  });

  it("round-trips a rewrap and a prune journal at every phase", () => {
    for (const phase of REWRAP_PHASES) {
      const journal = { ...rewrap(), phase, snapshotRoot: phase === "journaled" || phase === "file-written" ? null : CID_B };
      expect(decodeMaintenanceJournal(encodeMaintenanceJournal(journal))).toEqual(journal);
    }
    for (const phase of PRUNE_PHASES) {
      const journal = { ...prune(), phase, snapshotRoot: phase === "journaled" || phase === "removing" ? null : CID_B };
      expect(decodeMaintenanceJournal(encodeMaintenanceJournal(journal))).toEqual(journal);
    }
  });

  it.each([
    ["an unknown type", (j: Record<string, unknown>) => ({ ...j, type: "compact" })],
    ["a phase of the other type", (j: Record<string, unknown>) => ({ ...j, phase: "removing" })],
    ["a snapshot root before the snapshot phase", (j: Record<string, unknown>) => ({ ...j, snapshotRoot: CID_B })],
    ["no snapshot root at the snapshot phase", (j: Record<string, unknown>) => ({ ...j, phase: "snapshotted", snapshotRoot: null })],
    ["a newer version", (j: Record<string, unknown>) => ({ ...j, version: 2 })],
    ["non-hex slot bytes", (j: Record<string, unknown>) => ({ ...j, newKeySlotsHex: "zz" })],
    ["a malformed start root", (j: Record<string, unknown>) => ({ ...j, startRoot: "../x" })],
  ])("reads %s as damaged", async (_label, mutate) => {
    const kv = recordingKv();
    const body = JSON.parse(new TextDecoder().decode(encodeMaintenanceJournal(rewrap()))) as Record<string, unknown>;
    await kv.set(rootFileNames(MFS).maintenance, new TextEncoder().encode(JSON.stringify(mutate(body))));
    expect(await readMaintenanceJournal(kv, MFS)).toEqual({ kind: "damaged" });
  });

  it("refuses a prune journal whose removal list holds a path or junk", async () => {
    const kv = recordingKv();
    const body = JSON.parse(new TextDecoder().decode(encodeMaintenanceJournal(prune()))) as Record<string, unknown>;
    for (const removals of [["../manifest.enc"], ["notes.md"], [historyFileName(1, CID_A), historyFileName(1, CID_A)]]) {
      await kv.set(rootFileNames(MFS).maintenance, new TextEncoder().encode(JSON.stringify({ ...body, removals })));
      expect(await readMaintenanceJournal(kv, MFS)).toEqual({ kind: "damaged" });
    }
  });

  it("reads none, ok and damaged, and a publish journal's bytes are not a maintenance journal", async () => {
    const kv = recordingKv();
    expect(await readMaintenanceJournal(kv, MFS)).toEqual({ kind: "none" });
    await writeMaintenanceJournal(kv, rewrap());
    expect(await readMaintenanceJournal(kv, MFS)).toEqual({ kind: "ok", journal: rewrap() });
    await kv.set(rootFileNames(MFS).maintenance, new TextEncoder().encode("{ torn"));
    expect(await readMaintenanceJournal(kv, MFS)).toEqual({ kind: "damaged" });
  });
});

describe("maintenance journal: pairing with the publish journal", () => {
  async function publishJournalOn(kv: HostKv): Promise<void> {
    const manifest = await manifestFor(await keysFrom(0x20, 0x50), ["notes/a.md"]);
    await writeJournal(
      kv,
      buildJournal({
        mfsRoot: MFS,
        key: "obsidian-vault-sync",
        vaultId: manifest.vaultId,
        keyslotsSha256: "d".repeat(64),
        sequence: 1,
        manifestSha256: "e".repeat(64),
        pending: { manifest, mtimes: {} },
        startedAt: "2026-10-03T10:00:00.000Z",
        startRoot: null,
      }),
    );
  }

  it("a publish journal and a maintenance journal never read as each other's damaged file", async () => {
    const kv = recordingKv();
    await publishJournalOn(kv);
    expect(await readMaintenanceJournal(kv, MFS)).toEqual({ kind: "none" });
    await writeMaintenanceJournal(kv, prune());
    expect((await readJournal(kv, MFS)).kind).toBe("ok");
    await kv.delete(rootFileNames(MFS).journal);
    expect((await readJournal(kv, MFS)).kind).toBe("none");
    expect((await readMaintenanceJournal(kv, MFS)).kind).toBe("ok");
  });

  it("rewrap and prune refuse while any publish journal exists, damaged or not, and write nothing", async () => {
    for (const damaged of [false, true]) {
      const kv = recordingKv();
      if (damaged) await kv.set(rootFileNames(MFS).journal, new TextEncoder().encode("{ torn"));
      else await publishJournalOn(kv);
      kv.writes.length = 0;
      const refused = await refusal(assertNoPublishJournal(kv, MFS));
      expect(refused.code).toBe("publish-journal-pending");
      expect(refused.message).toContain("publish");
      expect(kv.writes).toEqual([]);
    }
  });

  it("passes when no publish journal exists", async () => {
    await expect(assertNoPublishJournal(recordingKv(), MFS)).resolves.toBeUndefined();
  });

  it.each([
    ["rewrap", rewrap],
    ["prune", prune],
  ])("publish and pull refuse while a %s journal exists, naming keys discard and keys accept-slots, and read only", async (_type, make) => {
    const kv = recordingKv();
    await writeMaintenanceJournal(kv, make());
    kv.writes.length = 0;
    const refused = await refusal(assertNoMaintenanceJournal(kv, MFS));
    expect(refused.code).toBe("maintenance-pending");
    expect(refused.message).toContain("keys discard");
    expect(refused.message).toContain("keys accept-slots");
    expect(kv.writes).toEqual([]);
  });

  it("a damaged maintenance journal blocks publish and pull as well", async () => {
    const kv = recordingKv();
    await kv.set(rootFileNames(MFS).maintenance, new TextEncoder().encode("{ torn"));
    const refused = await refusal(assertNoMaintenanceJournal(kv, MFS));
    expect(refused.code).toBe("maintenance-pending");
    expect(refused.message).toContain("keys discard");
  });

  it("passes when no maintenance journal exists", async () => {
    await expect(assertNoMaintenanceJournal(recordingKv(), MFS)).resolves.toBeUndefined();
  });
});

describe("discardMaintenanceJournal", () => {
  it("removes a readable and a damaged journal, reports what it did, and touches nothing else", async () => {
    const kv = recordingKv();
    await kv.set("state.other.json", new Uint8Array([1]));
    await writeMaintenanceJournal(kv, rewrap());
    expect(await discardMaintenanceJournal(kv, MFS)).toBe("removed");
    expect(await readMaintenanceJournal(kv, MFS)).toEqual({ kind: "none" });
    await kv.set(rootFileNames(MFS).maintenance, new TextEncoder().encode("{ torn"));
    expect(await discardMaintenanceJournal(kv, MFS)).toBe("removed");
    expect(await discardMaintenanceJournal(kv, MFS)).toBe("none");
    expect(await kv.get("state.other.json")).toBeDefined();
  });
});

describe("the ways out of a stuck maintenance journal", () => {
  it("names the command-line commands and says truthfully what the plugin can and cannot do", () => {
    expect(MAINTENANCE_WAYS_OUT).toContain('"ipfs-sync keys discard"');
    expect(MAINTENANCE_WAYS_OUT).toContain('"ipfs-sync keys accept-slots"');
    expect(MAINTENANCE_WAYS_OUT).not.toContain("the same actions in the Encryption section");
    // Task 2.5 added the plugin prune action: the sentence must no longer say the plugin has none, and must still say it cannot discard or finish one.
    expect(MAINTENANCE_WAYS_OUT).not.toMatch(/no discard or prune action/);
    expect(MAINTENANCE_WAYS_OUT).toMatch(/plugin has no discard action and does not finish an interrupted operation/);
    expect(MAINTENANCE_WAYS_OUT).toMatch(/can change the passphrase, increase the cost, prune history and accept changed key slots/);
    expect(MAINTENANCE_WAYS_OUT).toMatch(/Accept changed key slots/);
  });
});

describe("a pending maintenance journal through the real publish and pull entries", () => {
  async function publishedRig() {
    const rig = createRig({ node: createFakeNode([{ name: KEY, id: "k51owned" }]) });
    rig.owned.push("k51owned");
    seedVault(rig.host);
    await rig.init();
    await rig.publish();
    return rig;
  }

  it("publish refuses before a derivation or a write, even where the keyless idle check would say unchanged", async () => {
    const rig = await publishedRig();
    await writeMaintenanceJournal(rig.host.kv, { ...rewrap(), mfsRoot: ROOT, key: KEY });
    rig.node.calls.length = 0;
    const kvBefore = new Map(rig.host.kvStore);
    const refused = await refusal(rig.publish());
    expect(refused.code).toBe("maintenance-pending");
    expect(refused.message).toContain("keys discard");
    expect(rig.node.calls.filter((call) => MUTATING_REQUEST.test(call))).toEqual([]);
    expect([...rig.host.kvStore.keys()].sort()).toEqual([...kvBefore.keys()].sort());
  });

  it("publish proceeds again once the journal is discarded", async () => {
    const rig = await publishedRig();
    await writeMaintenanceJournal(rig.host.kv, { ...prune(), mfsRoot: ROOT, key: KEY });
    await refusal(rig.publish());
    await discardMaintenanceJournal(rig.host.kv, ROOT);
    rig.host.put("notes/after.md", "after", 5000);
    expect((await rig.publish()).published).toBe(true);
  });

  it("pull stops with the maintenance reason and writes nothing in the vault", async () => {
    const rig = await publishedRig();
    const puller = newPuller();
    await writeMaintenanceJournal(puller.host.kv, { ...prune(), mfsRoot: ROOT, key: KEY });
    const writesBefore = puller.host.kvStore.size;
    const stop = stopOf(await runPull(rig, puller));
    expect(stop.reason).toBe("maintenance-pending");
    expect(stop.message).toContain("keys discard");
    expect(stop.message).toContain("keys accept-slots");
    expect(puller.host.kvStore.size).toBe(writesBefore);
    expect(puller.host.mutations).toEqual([]);
    expect(puller.store.writes).toEqual([]);
    expect(puller.staged).toEqual([]);
  });

  it("a damaged maintenance journal stops a pull the same way", async () => {
    const rig = await publishedRig();
    const puller = newPuller();
    await puller.host.kv.set(rootFileNames(ROOT).maintenance, new TextEncoder().encode("{ torn"));
    expect(stopOf(await runPull(rig, puller)).reason).toBe("maintenance-pending");
  });

  it("a pull with no maintenance journal is unaffected", async () => {
    const rig = await publishedRig();
    const puller = newPuller();
    const outcome = await runPull(rig, puller);
    expect(outcome.kind).toBe("completed");
    expectNothingWritten(newPuller());
  });
});

describe("abandon moves the maintenance journal with the rest of the root's local files", () => {
  it("includes maintenance.<h>.json, so it cannot block a new vault in the same root", async () => {
    const host = createMemoryHost();
    const digest = await rootDigest(MFS);
    host.put(`.ipfs-sync/state.${digest}.json`, "{}");
    host.put(`.ipfs-sync/${rootFileNames(MFS).maintenance}`, encodeMaintenanceJournal(rewrap()));
    const result = await abandonVault({ fs: host.fs, mfsRoot: MFS, confirmation: ABANDON_CONFIRMATION, nowMs: 9 });
    expect(result.moved.some((path) => path.includes("maintenance."))).toBe(true);
    expect(host.files.has(`.ipfs-sync/${rootFileNames(MFS).maintenance}`)).toBe(false);
  });
});
