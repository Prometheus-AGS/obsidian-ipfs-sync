// mvp-07a task 6.1: two devices taking turns over one recording fake node, through `publishVault` and the decrypting pull with real
// state, floor and locks (helpers/integration-devices.ts). Scenarios: publish A and first pull B (declined, then accepted); both edit,
// publish, pull, conflict copy; a pulled directory and the marker; state v2 upgrade; `.smart-env/`; every pull sends only reads.
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/config";
import type { FirstPullDetails } from "../../src/sync/encrypted-pull";
import { localDateStamp } from "../../src/sync/conflict-name";
import { manifestIdentity } from "../../src/sync/manifest-identity";
import { rootFileNames } from "../../src/sync/root-files";
import { encodeRootState, readRootState } from "../../src/sync/root-state";
import { SEQUENCE_FLOOR_FILE, readFloor } from "../../src/sync/sequence-floor";
import { NOW, expectOnlyReads, resetNodeTrace, servedRoot } from "../helpers/encrypted-pull-rig";
import { ALL_FILES, BINARY, DAILY, PLAN, addManifestEntries, blobReads, bytesOf, createDevices, editAndPublish, leftovers, mutatingCalls, syncedTexts, type Device } from "../helpers/integration-devices";
import { ROOT, blobPaths } from "../helpers/publish-rig";
import { pulledOf } from "../helpers/pull-stage-rig";

const A_DAILY = "A edited the daily note, longer than before.\n";
const A_PLAN = "A rewrote the plan.\n";
const B_DAILY = "B edited the same daily note.\n";
const B_BINARY = new Uint8Array([9, 9, 9]);
/** Every request a pull may send: key list, name resolution, listings and gateway reads. */
const READ_ONLY = /^(keyList|nameResolve |stat |ls |ipfs-ls |GET )/;

describe("publish A, first pull B: declined, then accepted", () => {
  it("a declined first pull shows the authenticated sequence, date and device and writes nothing; the accepted one restores every file byte for byte", async () => {
    const { rig, node, a, b } = await createDevices();
    const shown: FirstPullDetails[] = [];

    const declined = await b.pull({ options: { acceptFirstPull: false }, deps: { confirmFirstPull: async (details) => (shown.push(details), false) } });

    expect(declined.kind).toBe("stopped");
    if (declined.kind === "stopped") expect(declined.stop.reason).toBe("first-pull-declined");
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ target: "name", sequence: 1, fileCount: 3 });
    expect(shown[0]?.device).toMatch(/^device-a-[0-9a-f]{12}$/);
    expect(shown[0]?.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(shown[0]?.statements.join(" ")).toContain("whoever holds the vault key");
    // Nothing of the pull is on device B: no vault file, no record, no key-slot copy, no floor, no blob requested, no lock left.
    expect(b.host.mutations).toEqual([]);
    expect(b.host.kvStore.size).toBe(0);
    expect(b.puller.store.writes).toEqual([]);
    expect(blobReads(node)).toEqual([]);
    expect(b.puller.locks.file.bytes).toBeUndefined();

    resetNodeTrace(node);
    const { verified, result } = pulledOf(await b.pull({ options: { acceptFirstPull: false }, deps: { confirmFirstPull: async (details) => (shown.push(details), true) } }));

    expect(shown).toHaveLength(2);
    expect(result.verdict).toBe("first-pull");
    expect(Object.keys(b.texts()).sort()).toEqual(ALL_FILES);
    for (const path of ALL_FILES) expect(bytesOf(b.host, path), path).toEqual(bytesOf(a.host, path));
    expect(leftovers(b.host)).toEqual([]);
    expect(b.host.files.get(".ipfs-sync-fixture") === undefined ? "" : new TextDecoder().decode(b.host.files.get(".ipfs-sync-fixture")?.data)).toBe("pulled-fixture\n");
    // The key-slot copy, the record and the floor exist only now, and agree with the authenticated manifest.
    expect(b.host.files.has(`.ipfs-sync/${rootFileNames(ROOT).keyslots}`)).toBe(true);
    const state = await b.state();
    expect(state).toMatchObject({ sequence: 1, highestSequence: 1, complete: true, unmaterialized: [], previousIdentity: null, manifestIdentity: verified.identity });
    expect(state?.devicesSeen).toEqual([verified.manifest.device]);
    expect(await readFloor(b.puller.store, state?.vaultId ?? "")).toMatchObject({ sequence: 1, identity: verified.identity });
    expect(b.puller.store.writes).toContain(SEQUENCE_FLOOR_FILE);
    expectOnlyReads(node);
    expect(node.calls.every((line) => READ_ONLY.test(line))).toBe(true);
  });
});

describe("both devices edit, publish, pull: the conflict copy and the second-device publish", () => {
  it("B cannot publish before it pulls; the pull keeps B's text beside A's; B's publish is sequence 3 and A converges on it", async () => {
    const { rig, node, a, b } = await createDevices();
    pulledOf(await b.pull());
    b.allowPublish();
    expect((await editAndPublish(rig, a, { [DAILY]: A_DAILY, [PLAN]: A_PLAN })).sequence).toBe(2);
    b.host.clock += 60_000;
    b.host.put(DAILY, B_DAILY);
    b.host.put(BINARY, B_BINARY);

    // B has a record of sequence 1 and the node is at 2: publish stops before any write and says pull first, not --repair.
    resetNodeTrace(node);
    const refused = await b.publish().then(() => undefined, (error: unknown) => error as Error & { code?: string });
    expect(refused?.code).toBe("sequence-ahead");
    expect(refused?.message).toContain("pull first");
    expect(refused?.message).not.toContain("--repair");
    expect(mutatingCalls(node)).toEqual([]);

    resetNodeTrace(node);
    const { result } = pulledOf(await b.pull());
    const copy = `Daily/2026-09-30 (ipfs conflict ${localDateStamp(NOW)}).md`;
    expect(result.verdict).toBe("newer");
    // Only what changed on the node is fetched: the two notes A edited, not the attachment.
    expect(blobReads(node)).toHaveLength(2);
    expect(result.settlement.conflicts).toEqual([{ path: DAILY, conflictPath: copy }]);
    expect(b.texts()[DAILY]).toBe(A_DAILY);
    expect(b.texts()[copy]).toBe(B_DAILY);
    expect(b.texts()[PLAN]).toBe(A_PLAN);
    expect(result.settlement.locallyModified).toEqual([BINARY]);

    // Second-device publish: one sequence above, both devices recorded, no blob of A's removed (B has seen another device, so it only reports strays).
    const namedByA = await rig.manifest();
    const before = new Set(blobPaths(node));
    const published = await editAndPublish(rig, b, {});
    expect(published).toMatchObject({ published: true, sequence: 3, written: 2, removed: 0 });
    const after = new Set(blobPaths(node));
    expect([...before].filter((path) => !after.has(path))).toEqual([]);
    // A blob name is keyed by the path: the edited attachment reuses its name, the conflict copy adds one.
    expect(after.size).toBe(before.size + 1);
    const manifest = await rig.manifest();
    expect(Object.keys(manifest.files).sort()).toEqual([BINARY, DAILY, PLAN, copy].sort());
    expect(manifest.device).toMatch(/^device-b-[0-9a-f]{12}$/);
    expect(manifest.device).not.toBe(namedByA.device);
    const state = await b.state();
    expect(state?.devicesSeen).toHaveLength(2);
    expect(state?.devicesSeen).toContain(namedByA.device);
    expect(state).toMatchObject({ sequence: 3, highestSequence: 3 });

    pulledOf(await a.pull());
    expect(a.texts()[BINARY]).toBe(new TextDecoder().decode(B_BINARY));
    expect(a.texts()[copy]).toBe(B_DAILY);
    expect(a.texts()[DAILY]).toBe(A_DAILY);
    expect(syncedTexts(b)).toEqual(syncedTexts(a));
    servedRoot(node);
  });

  it("a directory made by a pull publishes only after its marker is replaced by hand", async () => {
    const { b } = await createDevices();
    pulledOf(await b.pull());
    b.host.put("note.md", "written on the second device\n");
    const refused = await b.publish().then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(ConfigError);
    expect((refused as ConfigError).code).toBe("fixture-marker-required");
    b.allowPublish();
    expect((await b.publish()).published).toBe(true);
  });
});

describe("a state file of the previous build (format 2)", () => {
  /** What an mvp-06 development build wrote: format 2, none of the format 3 fields. */
  async function downgradeToFormat2(device: Pick<Device, "host">): Promise<void> {
    const key = rootFileNames(ROOT).state;
    const raw = JSON.parse(new TextDecoder().decode(await device.host.kv.get(key))) as Record<string, unknown>;
    const v3Only = ["manifestIdentity", "previousIdentity", "highestSequence", "highestIdentity", "complete", "unmaterialized", "devicesSeen"];
    const v2 = Object.fromEntries(Object.entries({ ...raw, version: 2 }).filter(([name]) => !v3Only.includes(name)));
    await device.host.kv.set(key, new TextEncoder().encode(JSON.stringify(v2)));
  }

  it("the pull reads it, computes the identity from its manifest, heals the missing floor and writes format 3", async () => {
    const { rig, node, a } = await createDevices();
    await downgradeToFormat2(a);
    a.puller.store.entries.clear();
    const identity = manifestIdentity(await rig.manifest());

    const { result } = pulledOf(await a.pull());

    expect(result.verdict).toBe("same");
    const state = await readRootState(a.host.kv, ROOT);
    expect(JSON.parse(new TextDecoder().decode(a.host.kvStore.get(rootFileNames(ROOT).state))).version).toBe(3);
    expect(state).toMatchObject({ version: 3, manifestIdentity: identity, highestIdentity: identity, highestSequence: 1, complete: true, unmaterialized: [] });
    expect(await readFloor(a.puller.store, state?.vaultId ?? "")).toMatchObject({ sequence: 1, identity });
    expectOnlyReads(node);
  });

  it("a publish from it goes through as sequence 2 and leaves a format 3 record whose previousIdentity is the upgraded identity", async () => {
    const { rig, a } = await createDevices();
    await downgradeToFormat2(a);
    const identity = manifestIdentity(await rig.manifest());

    const published = await editAndPublish(rig, a, { [DAILY]: A_DAILY });

    expect(published).toMatchObject({ published: true, sequence: 2 });
    const state = await readRootState(a.host.kv, ROOT);
    expect(state).toMatchObject({ version: 3, sequence: 2, highestSequence: 2, previousIdentity: identity, complete: true });
    expect(encodeRootState(state as NonNullable<typeof state>)).toBeDefined();
  });
});

describe(".smart-env/ is never published and never pulled", () => {
  const embeddings = (host: { put(path: string, content: string, mtimeMs?: number): void }): void => {
    host.put(".smart-env/multi/Daily_2026-09-30_md.ajson", '"smart_sources:Daily": {"vec": [0.1, 0.2]}\n', 1000);
    host.put(".smart-env/smart_env.json", "{}", 1000);
  };

  it("a vault holding Smart Connections files publishes none of them, and a pull restores none and leaves the pulling device's own alone", async () => {
    const { rig, node, a, b } = await createDevices({ seed: embeddings });
    const manifest = await rig.manifest();
    expect(Object.keys(manifest.files).sort()).toEqual(ALL_FILES);
    expect(blobPaths(node)).toHaveLength(ALL_FILES.length);

    pulledOf(await b.pull());
    expect(Object.keys(b.texts()).sort()).toEqual(ALL_FILES);
    expect(a.texts()[".smart-env/smart_env.json"]).toBe("{}");
    expect(b.texts()[".smart-env/smart_env.json"]).toBeUndefined();

    // Smart Connections now builds its own embeddings on B; a later pull leaves them, and B's publish does not take them.
    b.host.put(".smart-env/multi/Daily_2026-09-30_md.ajson", "embeddings computed on device B\n", 5000);
    await editAndPublish(rig, a, { [PLAN]: A_PLAN });
    pulledOf(await b.pull());
    expect(b.texts()[".smart-env/multi/Daily_2026-09-30_md.ajson"]).toBe("embeddings computed on device B\n");
    b.allowPublish();
    expect((await editAndPublish(rig, b, { [DAILY]: B_DAILY })).sequence).toBe(3);
    expect(Object.keys((await rig.manifest()).files).some((path) => path.startsWith(".smart-env/"))).toBe(false);
  });

  it("rewriting the embeddings makes no new sequence and no new history entry: the idle path holds", async () => {
    const { node, a } = await createDevices({ seed: embeddings });
    const history = (): string[] => [...node.files.keys()].filter((path) => path.startsWith(`${ROOT}/manifests/`));
    const before = history();
    expect(before).toHaveLength(1);

    for (let round = 1; round <= 3; round += 1) {
      a.host.clock += 13_000;
      a.host.put(".smart-env/multi/Daily_2026-09-30_md.ajson", `${'"smart_sources:Daily": {"vec": [0.1, 0.2]}\n'.repeat(round + 1)}`);
      const result = await a.publish();
      expect(result.published).toBe(false);
    }
    expect(history()).toEqual(before);
    expect(mutatingCalls(node)).toEqual([]);
  });

  it("an older build's manifest that lists them is skipped as expected: nothing written, the pull is not marked for attention", async () => {
    const { rig, b } = await createDevices();
    await addManifestEntries(rig, [".smart-env/multi/Daily_2026-09-30_md.ajson", ".smart-env/smart_env.json"]);

    const { result } = pulledOf(await b.pull());

    expect(result.settlement.skipped.map((skip) => [skip.path, skip.severity])).toEqual([
      [".smart-env/multi/Daily_2026-09-30_md.ajson", "expected"],
      [".smart-env/smart_env.json", "expected"],
    ]);
    expect(result.settlement.needsAttention).toBe(false);
    expect(Object.keys(b.texts()).sort()).toEqual(ALL_FILES);
    const state = await b.state();
    expect(Object.keys(state?.manifest.files ?? {}).some((path) => path.startsWith(".smart-env/"))).toBe(false);
    expect(state?.unmaterialized).toEqual([]);
  });
});

describe("every pull sends only reads", () => {
  it("first pull, newer pull, same pull and restore: each request in the node's trace is a read", async () => {
    const { rig, node, a, b } = await createDevices();
    const olderRoot = servedRoot(node);
    const audits: Record<string, string[]> = {};
    const audit = (label: string): void => {
      audits[label] = node.calls.filter((line) => !READ_ONLY.test(line));
      expect(mutatingCalls(node), label).toEqual([]);
      expect(node.calls.length, label).toBeGreaterThan(0);
    };

    resetNodeTrace(node);
    pulledOf(await b.pull());
    audit("first pull");

    await editAndPublish(rig, a, { [DAILY]: A_DAILY });
    pulledOf(await b.pull());
    audit("newer pull");

    resetNodeTrace(node);
    expect(pulledOf(await b.pull()).result.verdict).toBe("same");
    audit("same pull");

    resetNodeTrace(node);
    const restored = await b.pull({ options: { target: { kind: "root-cid", cid: olderRoot }, flags: { allowRollback: true } } });
    expect(pulledOf(restored).result.verdict).toBe("restore");
    audit("restore");

    expect(audits).toEqual({ "first pull": [], "newer pull": [], "same pull": [], restore: [] });
  });
});

describe("a pull above the ceiling needs a yes", () => {
  it("a declined large pull asks before any blob is requested, fetches nothing and is incomplete; the next pull restores everything", async () => {
    const { node, b } = await createDevices();
    resetNodeTrace(node);
    let asked: { readonly fileCount: number; readonly ceilingBytes: number } | undefined;

    const { result } = pulledOf(
      await b.pull({
        options: { confirmAboveBytes: 1 },
        deps: {
          confirmLargePull: async (details) => {
            asked = details;
            return false;
          },
        },
      }),
    );

    expect(asked).toMatchObject({ fileCount: 3, ceilingBytes: 1 });
    expect(blobReads(node)).toEqual([]);
    expect(result.settlement.unfetched.map((problem) => problem.path).sort()).toEqual(ALL_FILES);
    expect(await b.state()).toMatchObject({ complete: false, unmaterialized: ALL_FILES });
    expect(b.texts()).toEqual({});

    expect(pulledOf(await b.pull()).result.settlement.restored.slice().sort()).toEqual(ALL_FILES);
    expect(await b.state()).toMatchObject({ complete: true, unmaterialized: [] });
  });
});

describe("a different exclusion list", () => {
  it("warns once and verifies every local file by content instead of trusting size and mtime; nothing is deleted", async () => {
    const { b } = await createDevices();
    pulledOf(await b.pull());

    const { result } = pulledOf(await b.pull({ options: { extraExclusions: ["private/"] } }));

    expect(result.exclusionWarning).toMatch(/exclusion lists differ/);
    expect(result.hashedLocalFiles).toBe(3);
    expect(Object.keys(b.texts()).sort()).toEqual(ALL_FILES);
  });
});
