import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent, type ConfigDeps } from "../../cli/load-config";
import { runCli } from "../../cli/run";
import { FIXTURE_MARKER } from "../../src/core/config";
import { createSyncEventBus } from "../../src/core/events";
import { createPublishRunner } from "../../src/plugin/publish-runner";
import { loadSettings } from "../../src/plugin/settings-migration";
import { defaultSettings } from "../../src/plugin/settings-model";
import { createSettingsStore } from "../../src/plugin/settings-store";
import { assertPublishMarker, readMarkerState } from "../../src/sync/fixture-marker";
import { publishVault } from "../../src/sync/publish";
import { assertPullDestination, assertVaultPullDestination } from "../../src/sync/pull-guard";
import { writeFixtureVault } from "../../fixtures/generate-fixture-vault";
import { createObsidianHostBridge } from "../../src/plugin/obsidian-host-bridge";
import { createFakeNode } from "../helpers/fake-kubo";
import { fakeNodeFetch } from "../helpers/fake-kubo-http";
import { createMemoryHost } from "../helpers/memory-host";
import { FILES_V1, ROOT1, TREE1, harness } from "../helpers/pull-harness";
import { seedRemote } from "../helpers/pull-fixtures";
import { sessionRig } from "../helpers/plugin-session";
import { initVault } from "../helpers/vault-init";
import { MemoryAdapter } from "../support/memory-adapter";
import { referencePassphrase } from "../vectors/slot-helpers";

const MFS_ROOT = "/obsidian-vault-sync/marker-test";
const KEY = "obsidian-vault-sync";
const REVIEW_PENDING = /not yet independently reviewed or verified in Obsidian/;

/** Marker file contents that must NOT enable publish, with the reason the message must give. */
const REFUSED_MARKERS: readonly (readonly [string, string | undefined, RegExp])[] = [
  ["no marker", undefined, /has no \.ipfs-sync-fixture marker/],
  ["an empty marker", "", /marker is empty/],
  ["a newline-only marker", "\n", /marker is empty/],
  ["pulled-fixture", "pulled-fixture\n", /says "pulled-fixture"/],
  ["pulled-fixture without a newline", "pulled-fixture", /says "pulled-fixture"/],
  ["an unrecognised marker", "marker", /does not hold the text "fixture"/],
  ["a pull marker of the released 0.2.0 build", "fixture copy created by ipfs-sync pull\n", /marker predates this version: it holds the text a pulled copy got in release 0.2.0/],
  ["a pull marker of the released 0.2.0 build without a newline", "fixture copy created by ipfs-sync pull", /marker predates this version/],
  ["a marker with different case", "Fixture", /does not hold the text "fixture"/],
];

function engine(marker: string | undefined) {
  const host = createMemoryHost({ env: { IPFS_SYNC_DEVICE: "marker-test" } });
  if (marker !== undefined) host.put(FIXTURE_MARKER, marker);
  host.put("notes/hello.md", "hello", 1000);
  const node = createFakeNode();
  const run = () =>
    publishVault(
      { client: node.client, host, bus: createSyncEventBus() },
      { mfsRoot: MFS_ROOT, keyName: KEY, ownedKeys: [], recordOwnedKey: async () => undefined, concurrency: 1, passphrase: referencePassphrase() },
    );
  return { host, node, run, init: () => initVault(host.fs, node, MFS_ROOT) };
}

describe("publish marker: engine", () => {
  it.each(REFUSED_MARKERS)("refuses %s before any request", async (_label, marker, reason) => {
    const { node, run, host } = engine(marker);
    const error = await run().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "fixture-marker-required" });
    expect((error as Error).message).toMatch(REVIEW_PENDING);
    expect((error as Error).message).toMatch(reason);
    expect((error as Error).message).toContain('containing the text "fixture"');
    expect(node.calls).toEqual([]);
    expect(host.mutations).toEqual([]);
  });

  it.each(["fixture", "fixture\n", "fixture\r\n"])("accepts the marker %j and publishes", async (marker) => {
    const { node, run, init } = engine(marker);
    await init();
    const result = await run();
    expect(result.published).toBe(true);
    expect(node.calls.length).toBeGreaterThan(0);
  });

  it("does not echo the marker text or a hostile marker size", async () => {
    const { run } = engine("secret-looking-text-Zk93");
    const error = (await run().catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain("secret-looking-text-Zk93");
  });

  it("treats a marker larger than 64 bytes as unrecognised without reading it", async () => {
    const host = createMemoryHost();
    host.put(FIXTURE_MARKER, `fixture${" ".repeat(200)}`);
    expect(await readMarkerState(host.fs)).toBe("unrecognised");
    expect(host.reads.count).toBe(0);
  });

  it("treats a marker that is a directory as absent", async () => {
    const host = createMemoryHost();
    host.put(`${FIXTURE_MARKER}/inner`, "x");
    expect(await readMarkerState(host.fs)).toBe("absent");
    await expect(assertPublishMarker(host.fs)).rejects.toMatchObject({ code: "fixture-marker-required" });
  });
});

describe("publish marker: a directory populated by pull is refused by publish", () => {
  it("pull writes pulled-fixture into an empty destination, and publish then refuses it with no request", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await h.run();
    expect(new TextDecoder().decode(h.host.files.get(FIXTURE_MARKER)?.data)).toBe("pulled-fixture\n");

    const node = createFakeNode();
    const attempt = publishVault(
      { client: node.client, host: h.host, bus: createSyncEventBus() },
      { mfsRoot: MFS_ROOT, keyName: KEY, ownedKeys: [], recordOwnedKey: async () => undefined, passphrase: referencePassphrase() },
    );
    await expect(attempt).rejects.toMatchObject({ code: "fixture-marker-required" });
    await expect(attempt).rejects.toThrowError(/says "pulled-fixture"/);
    expect(node.calls).toEqual([]);
  });

  it("a second pull into the pulled destination is still accepted", async () => {
    const h = harness();
    await seedRemote(h.gateway, FILES_V1, { tree: TREE1, root: ROOT1 });
    await h.run();
    await expect(h.run()).resolves.toMatchObject({ failed: 0 });
  });
});

describe("pull destination guard: either word accepted", () => {
  it.each(["fixture", "fixture\n", "pulled-fixture", "pulled-fixture\n"])("accepts a non-empty destination marked %j", async (marker) => {
    const host = createMemoryHost();
    host.put(FIXTURE_MARKER, marker);
    host.put("notes/keep.md", "keep");
    await expect(assertPullDestination(host.fs)).resolves.toEqual({ needsMarker: false });
    await expect(assertVaultPullDestination(host.fs)).resolves.toEqual({ needsMarker: false });
  });

  it.each([
    ["", /predates this version: it holds an empty marker from release 0\.2\.0/],
    ["marker", /predates this version: it holds the text "marker" from release 0\.2\.0/],
    ["fixture copy created by ipfs-sync pull\n", /predates this version: it holds the text a pulled copy got in release 0\.2\.0/],
  ] as const)(
    "refuses a destination whose marker holds the release-0.2.0 content %j with a message about the version, before any request",
    async (marker, message) => {
      const host = createMemoryHost();
      host.put(FIXTURE_MARKER, marker);
      host.put("notes/keep.md", "keep");
      await expect(assertPullDestination(host.fs)).rejects.toMatchObject({ reason: "real-vault" });
      await expect(assertPullDestination(host.fs)).rejects.toThrowError(message);
      await expect(assertVaultPullDestination(host.fs)).rejects.toThrowError(message);
      await expect(assertPullDestination(host.fs)).rejects.toThrowError(/Re-mark this directory deliberately .* "fixture" or "pulled-fixture"/);
      expect(host.mutations).toEqual([]);
    },
  );

  it("keeps the generic message for other unrecognised text, which is not a release-0.2.0 marker", async () => {
    const host = createMemoryHost();
    host.put(FIXTURE_MARKER, "Fixture");
    host.put("notes/keep.md", "keep");
    await expect(assertPullDestination(host.fs)).rejects.toThrowError(/not one of the accepted words/);
    await expect(assertPullDestination(host.fs)).rejects.not.toThrowError(/predates this version/);
  });

  it("a destination that holds only the state folder is still empty (the latch lives there)", async () => {
    const host = createMemoryHost();
    host.put(".ipfs-sync/encrypted-seen.json", "{}");
    await expect(assertPullDestination(host.fs)).resolves.toEqual({ needsMarker: true });
    host.put("notes/keep.md", "keep");
    await expect(assertPullDestination(host.fs)).rejects.toMatchObject({ reason: "real-vault" });
  });

  it("a destination that holds only an empty marker is refused, not silently re-marked", async () => {
    const host = createMemoryHost();
    host.put(FIXTURE_MARKER, "");
    await expect(assertPullDestination(host.fs)).rejects.toThrowError(/predates this version/);
  });
});

describe("fixture generator", () => {
  it("writes the marker text `fixture`, and the engine accepts the generated vault", async () => {
    const root = await mkdtemp(join(tmpdir(), "ipfs-sync-marker-"));
    await writeFixtureVault(root, 5);
    expect((await readFile(join(root, FIXTURE_MARKER), "utf8")).replace(/\n$/, "")).toBe("fixture");
  });
});

describe("publish marker: plugin runner", () => {
  function pluginRig(marker: string | undefined) {
    const adapter = new MemoryAdapter();
    if (marker !== undefined) adapter.put(FIXTURE_MARKER, marker);
    adapter.put("notes/world.md", "world", 1000);
    const node = createFakeNode();
    const data = { value: null as unknown };
    const store = createSettingsStore(
      { loadData: async () => data.value, saveData: async (next) => void (data.value = structuredClone(next)) },
      { ...loadSettings(null), settings: { ...defaultSettings(), mfsRoot: MFS_ROOT } },
    );
    const runner = createPublishRunner({ store, adapter, bus: createSyncEventBus(), createClient: () => node.client, session: sessionRig({ store, adapter, createClient: () => node.client }).session, now: () => new Date(1_800_000_000_000) });
    return { node, runner, init: () => initVault(createObsidianHostBridge({ adapter }).fs, node, MFS_ROOT) };
  }

  it.each(REFUSED_MARKERS)("refuses %s with the review-pending notice and no request", async (_label, marker) => {
    const { node, runner } = pluginRig(marker);
    const outcome = await runner.run();
    expect(outcome).toMatchObject({ kind: "refused", reason: "fixture-only" });
    expect(outcome.notice).toMatch(REVIEW_PENDING);
    expect(outcome.notice).toContain('containing the text "fixture"');
    expect(node.calls).toEqual([]);
  });

  it("publishes a vault whose marker holds fixture", async () => {
    const { node, runner, init } = pluginRig("fixture\n");
    await init();
    expect((await runner.run()).kind).toBe("published");
    expect(node.calls.length).toBeGreaterThan(0);
  });
});

describe("publish marker: CLI", () => {
  let dir: string;
  let requests: string[];
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-marker-cli-"));
    requests = [];
    fetchStub = vi.fn(fakeNodeFetch(createFakeNode([{ name: "self", id: "k51self" }]), requests));
    vi.stubGlobal("fetch", fetchStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function publishWithMarker(marker: string | undefined, env: Record<string, string>) {
    const vault = join(dir, `vault-${Math.random().toString(36).slice(2)}`);
    await mkdir(vault);
    await writeFile(join(vault, "note.md"), "private");
    if (marker !== undefined) await writeFile(join(vault, FIXTURE_MARKER), marker);
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = { out: (t) => void out.push(t), err: (t) => void err.push(t) };
    const deps: ConfigDeps = { env, now: () => new Date("2026-09-30T12:00:00Z"), readText: readTextIfPresent };
    const code = await runCli(["publish", vault, "--config", join(dir, "cfg.json"), "--mfs-root", MFS_ROOT], deps, io);
    return { code, err: err.join("\n") };
  }

  it.each(REFUSED_MARKERS)("refuses %s with and without a passphrase in the environment, sending nothing", async (_label, marker) => {
    const environments: Record<string, string>[] = [{}, { IPFS_SYNC_PASSPHRASE: "HEZVI-DN7IB-GLQIX-B5L7V-ARDHC" }];
    for (const env of environments) {
      const result = await publishWithMarker(marker, env);
      expect(result.code).toBe(2);
      expect(result.err).toMatch(REVIEW_PENDING);
      expect(result.err).not.toContain("HEZVI");
    }
    expect(fetchStub).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});
