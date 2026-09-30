import { describe, expect, it, vi } from "vitest";
import { createPullRunner } from "../../src/plugin/pull-runner";
import { createSyncLock } from "../../src/plugin/sync-lock";
import { createSyncEventBus } from "../../src/core/events";
import { KuboHttpError } from "../../src/kubo";
import { FILES_V1, SECRET, TODAY, freshVault, pullRig, seed, storeWith } from "../helpers/plugin-pull-rig";
import { IPNS_NAME } from "../helpers/pull-fixtures";
import { MemoryAdapter } from "../support/memory-adapter";
import { requestUrlCalls, resetRequestUrl, setRequestUrlHandler, stubResponse } from "../support/obsidian-stub";

const MB = 1024 * 1024;

describe("plugin pull runner: destination guard", () => {
  it("refuses a vault with notes and no marker before any request, and changes nothing", async () => {
    const adapter = freshVault();
    adapter.put("notes/real.md", "private");
    const rig = pullRig({ adapter });
    await seed(rig, FILES_V1);
    adapter.calls.length = 0;

    const outcome = await rig.pull();
    expect(outcome).toMatchObject({ kind: "refused", reason: "fixture-only" });
    expect(outcome.notice).toContain("Pull of a real vault is not available in this build");
    expect(outcome.notice).toContain(".ipfs-sync-fixture");
    expect(rig.gateway.requests).toEqual([]);
    expect(adapter.calls.filter((call) => /^(write|remove|rename|mkdir)/.test(call))).toEqual([]);
    expect(adapter.files.has(".ipfs-sync-fixture")).toBe(false);
    expect(rig.store.get().lastPull).toBeUndefined();
  });

  it("refuses a note nested deep in a folder, but ignores folders that hold no files", async () => {
    const nested = freshVault();
    nested.put("projects/2026/plan.md", "x");
    expect((await pullRig({ adapter: nested }).pull()).kind).toBe("refused");

    const emptyFolders = freshVault();
    emptyFolders.folders.add("drafts");
    emptyFolders.folders.add("drafts/2026");
    const rig = pullRig({ adapter: emptyFolders });
    await seed(rig, FILES_V1);
    expect((await rig.pull()).kind).toBe("pulled");
  });

  it("admits a fresh vault that holds only .obsidian and writes the marker", async () => {
    const rig = pullRig({ adapter: freshVault() });
    await seed(rig, FILES_V1);
    const outcome = await rig.pull();
    expect(outcome.kind).toBe("pulled");
    expect(rig.adapter.text("notes/a.md")).toBe("alpha");
    expect(rig.adapter.text("c.md")).toBe("charlie");
    expect(rig.adapter.files.has(".ipfs-sync-fixture")).toBe(true);
    expect(rig.adapter.files.has(".ipfs-sync/state.json")).toBe(true);
    // The state folder holds no temp files afterwards.
    expect([...rig.adapter.files.keys()].filter((path) => path.startsWith(".ipfs-sync/tmp/"))).toEqual([]);
  });

  it("admits a vault that carries the marker even when it has notes", async () => {
    const adapter = freshVault();
    adapter.put(".ipfs-sync-fixture", "fixture\n");
    adapter.put("notes/a.md", "alpha", 5000);
    const rig = pullRig({ adapter });
    await seed(rig, FILES_V1);
    expect((await rig.pull()).kind).toBe("pulled");
  });

});

describe("plugin pull runner: node traffic", () => {
  it("sends only name resolve, key list and gateway reads", async () => {
    const rig = pullRig({ adapter: freshVault() });
    await seed(rig, FILES_V1);
    await rig.pull();
    expect(rig.gateway.requests.length).toBeGreaterThan(0);
    for (const request of rig.gateway.requests) expect(request, request).toMatch(/^(keyList|nameResolve \S+|GET \S+)/);
    expect(rig.gateway.requests[0]).toBe("keyList");
    expect(rig.gateway.requests[1]).toBe(`nameResolve ${IPNS_NAME}`);
  });

  it("asks for the key list only when no pull name is set", async () => {
    const rig = pullRig({ adapter: freshVault(), settings: { pullName: IPNS_NAME, ownedKeys: [] } });
    await seed(rig, FILES_V1);
    await rig.pull();
    expect(rig.gateway.requests).not.toContain("keyList");
    expect(rig.gateway.requests[0]).toBe(`nameResolve ${IPNS_NAME}`);
  });

  it("stops before fetching, and writes nothing, when the default key is not owned and no name is set", async () => {
    const adapter = freshVault();
    const rig = pullRig({ adapter, settings: { ownedKeys: [] } });
    await seed(rig, FILES_V1);
    adapter.calls.length = 0;
    const outcome = await rig.pull();
    expect(outcome).toMatchObject({ kind: "refused", reason: "no-target" });
    expect(outcome.notice).toContain("pull name");
    expect(rig.gateway.requests).toEqual(["keyList"]);
    expect(adapter.calls.filter((call) => /^(write|remove|rename|mkdir)/.test(call))).toEqual([]);
    expect(adapter.files.has(".ipfs-sync-fixture")).toBe(false);
  });

  it("uses the requestUrl transport by default and never the WebView fetch", async () => {
    resetRequestUrl();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      setRequestUrlHandler(() => stubResponse(500, '{"Message":"stop here"}'));
      const store = storeWith({ pullName: IPNS_NAME });
      const runner = createPullRunner({ store, adapter: freshVault(), bus: createSyncEventBus() });
      const outcome = await runner.run();
      expect(outcome.kind).toBe("failed");
      expect(requestUrlCalls).toHaveLength(1);
      const call = requestUrlCalls[0];
      expect(call?.method).toBe("POST");
      const url = new URL(call?.url ?? "");
      expect(url.pathname).toBe("/api/v0/name/resolve");
      expect(url.searchParams.get("nocache")).toBe("true");
      expect(url.searchParams.get("arg")).toBe(`/ipns/${IPNS_NAME}`);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      resetRequestUrl();
    }
  });
});

describe("plugin pull runner: local edits", () => {
  it("saves open editors first, so a pending edit becomes a conflict copy instead of being overwritten", async () => {
    const flushes: string[] = [];
    const adapter = freshVault();
    // The destination guard reads the small marker file; a note read is any other read.
    const noteReads = (): number => adapter.reads.filter((path) => path !== ".ipfs-sync-fixture").length;
    const rig = pullRig({
      adapter,
      flushEditors: async () => {
        flushes.push(`flush after ${noteReads()} reads and ${rig.gateway.requests.length} requests`);
        // The second pull finds an editor with content that is not on disk yet.
        if (flushes.length === 2) adapter.put("notes/a.md", "typed but not yet saved", 9000);
      },
    });
    await seed(rig, FILES_V1);
    expect((await rig.pull()).kind).toBe("pulled");

    await seed(rig, { ...FILES_V1, "notes/a.md": "alpha from the other device" }, 2);
    const reads = noteReads();
    const requests = rig.gateway.requests.length;
    const outcome = await rig.pull();
    // The flush ran before this pull read any local file and before its first request.
    expect(flushes[1]).toBe(`flush after ${reads} reads and ${requests} requests`);
    expect(outcome.kind).toBe("pulled");
    expect(adapter.text("notes/a.md")).toBe("alpha from the other device");
    expect(adapter.text(`notes/a (ipfs conflict ${TODAY}).md`)).toBe("typed but not yet saved");
  });

  it("does not pull at all when the editors cannot be saved", async () => {
    const adapter = freshVault();
    const rig = pullRig({ adapter, flushEditors: () => Promise.reject(new Error("view is busy")) });
    await seed(rig, FILES_V1);
    const outcome = await rig.pull();
    expect(outcome.kind).toBe("failed");
    expect(outcome.notice).toContain("nothing was pulled");
    expect(outcome.notice).toContain("view is busy");
    expect(rig.gateway.requests).toEqual([]);
    expect(adapter.text("c.md")).toBeUndefined();
  });

  it("leaves the conflict copy with the local bytes and the extension kept, and replaces the original", async () => {
    const adapter = freshVault();
    const rig = pullRig({ adapter });
    await seed(rig, FILES_V1);
    await rig.pull();
    adapter.put("notes/a.md", "local text", 9000);
    await seed(rig, { ...FILES_V1, "notes/a.md": "remote text", "notes/new.md": "only remote" }, 2);

    const outcome = await rig.pull();
    expect(outcome.kind).toBe("pulled");
    expect(adapter.text("notes/a.md")).toBe("remote text");
    expect(adapter.text(`notes/a (ipfs conflict ${TODAY}).md`)).toBe("local text");
    expect(adapter.text("notes/new.md")).toBe("only remote");
    if (outcome.kind === "pulled") {
      expect(outcome.result).toMatchObject({ fetched: 2, conflicted: 1, failed: 0 });
      expect(outcome.notice).toContain("Pull complete: 2 fetched");
      expect(outcome.notice).toContain("1 conflicts, 0 failed");
      expect(outcome.notice).toContain(`notes/a (ipfs conflict ${TODAY}).md`);
    }
    expect(rig.events).toEqual(["conflict notes/a.md"]);
  });

  it("does not rewrite files that did not change", async () => {
    const adapter = freshVault();
    const rig = pullRig({ adapter });
    await seed(rig, FILES_V1);
    await rig.pull();
    const before = adapter.files.get("notes/b.md");
    await seed(rig, { ...FILES_V1, "notes/a.md": "alpha 2" }, 2);
    adapter.calls.length = 0;
    await rig.pull();
    expect(adapter.files.get("notes/b.md")).toBe(before);
    expect(adapter.calls.some((call) => call.includes("notes/b.md") && /^(write|remove|rename)/.test(call))).toBe(false);
  });
});

describe("plugin pull runner: read cap", () => {
  it("counts a file above the cap as failed and still pulls the others", async () => {
    const adapter = freshVault();
    adapter.put(".ipfs-sync-fixture", "fixture\n");
    adapter.put("big.bin", new Uint8Array(9 * MB), 5000);
    const rig = pullRig({ adapter, settings: { maxReadMb: 8 } });
    await seed(rig, { ...FILES_V1, "big.bin": "small remote text" });

    const outcome = await rig.pull();
    expect(outcome.kind).toBe("incomplete");
    if (outcome.kind !== "incomplete") return;
    expect(outcome.result.failed).toBe(1);
    expect(outcome.result.failures[0]?.path).toBe("big.bin");
    expect(outcome.result.failures[0]?.reason).toContain("8 MB");
    expect(outcome.notice).toContain("Pull incomplete");
    expect(outcome.notice).not.toContain("Pull complete");
    expect(outcome.notice).toContain("big.bin");
    expect(adapter.text("c.md")).toBe("charlie");
    expect(adapter.files.get("big.bin")?.data.byteLength).toBe(9 * MB);
    expect(rig.store.get().lastPull?.failed).toBe(1);
  });
});

describe("plugin pull runner: one operation at a time", () => {
  it("refuses a pull while a publish holds the lock, sends nothing, then works after the release", async () => {
    const lock = createSyncLock();
    const rig = pullRig({ adapter: freshVault(), lock });
    await seed(rig, FILES_V1);
    const release = lock.tryAcquire("publish");
    expect(release).toBeDefined();
    const outcome = await rig.pull();
    expect(outcome).toMatchObject({ kind: "refused", reason: "busy" });
    expect(outcome.notice).toContain("publish is already in progress");
    expect(rig.gateway.requests).toEqual([]);
    expect(rig.runner.isRunning()).toBe(true);
    release?.();
    expect((await rig.pull()).kind).toBe("pulled");
  });

  it("ignores a second pull while one is running and releases the lock afterwards, also after a failure", async () => {
    const rig = pullRig({ adapter: freshVault() });
    await seed(rig, FILES_V1);
    const first = rig.pull();
    expect(await rig.pull()).toMatchObject({ kind: "refused", reason: "busy" });
    expect((await first).kind).toBe("pulled");
    expect(rig.runner.isRunning()).toBe(false);

    rig.gateway.names.clear();
    expect((await rig.pull()).kind).toBe("failed");
    expect(rig.lock.holder()).toBeUndefined();
  });
});

describe("plugin pull runner: summary and secrets", () => {
  it("persists counts, root CIDs and a time, and no path or secret", async () => {
    const rig = pullRig({ adapter: freshVault() });
    await seed(rig, FILES_V1);
    await rig.pull();
    const summary = rig.store.get().lastPull;
    expect(summary).toEqual({
      at: new Date(2026, 8, 30, 12, 0, 0).toISOString(),
      rootCid: "bafyrootone000000000000",
      manifestCid: "bafytreeone000000000000",
      fetched: 3,
      unchanged: 0,
      conflicts: 0,
      failed: 0,
      remoteDeleted: 0,
    });
    const stored = JSON.stringify(rig.store.port.data);
    expect(stored).not.toContain("notes/");
    expect(stored).not.toContain("c.md");
    // The token lives in the settings, as before; the summary itself carries none.
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it("does not put credentials into a failure notice", async () => {
    const rig = pullRig({ adapter: freshVault() });
    await seed(rig, FILES_V1);
    rig.gateway.client.nameResolve = () => Promise.reject(new KuboHttpError("rpc", "https://node.test", 500, "could not resolve name"));
    const outcome = await rig.pull();
    expect(outcome.kind).toBe("failed");
    expect(outcome.notice).toContain("pull failed");
    expect(outcome.notice).not.toContain(SECRET);
    expect(rig.adapter.files.has(".ipfs-sync-fixture")).toBe(false);
  });

  it("says the summary was not saved instead of hiding it, and keeps the pull's result", async () => {
    const rig = pullRig({ adapter: freshVault() });
    await seed(rig, FILES_V1);
    rig.store.port.saveData = () => Promise.reject(new Error("disk full"));
    const outcome = await rig.pull();
    expect(outcome.kind).toBe("pulled");
    expect(outcome.notice).toContain("could not be saved: disk full");
    expect(rig.adapter.text("c.md")).toBe("charlie");
  });

  it("reports progress phases with a fetched count that increases", async () => {
    const rig = pullRig({ adapter: freshVault() });
    await seed(rig, FILES_V1);
    const texts: string[] = [];
    await rig.runner.run({ onProgress: (text) => void texts.push(text) });
    expect(texts[0]).toContain("starting");
    const stages = texts.map((text) => text.replace(/^IPFS Sync: pull: /, ""));
    expect(stages).toContain("resolving name...");
    expect(stages).toContain("reading manifest...");
    expect(stages).toContain("comparing 3 files...");
    expect(stages).toContain("fetching 0 of 3...");
    expect(stages).toContain("fetching 3 of 3...");
    const counts = stages.flatMap((stage) => /^fetching (\d+) of 3/.exec(stage)?.[1] ?? []).map(Number);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });
});

describe("plugin pull runner: encrypted roots and the plaintext reader", () => {
  const encrypt = (rig: ReturnType<typeof pullRig>): void => {
    rig.gateway.objects.delete("bafyrootone000000000000/manifest.json");
    rig.gateway.objects.set("bafyrootone000000000000/keyslots.json", new TextEncoder().encode("{}"));
    rig.gateway.objects.set("bafyrootone000000000000/manifest.enc", new Uint8Array([1]));
  };

  it("refuses an encrypted vault with a notice that says pull is not supported yet, changes no file and sets the latch", async () => {
    const adapter = freshVault();
    const rig = pullRig({ adapter });
    await seed(rig, FILES_V1);
    encrypt(rig);
    adapter.calls.length = 0;

    const outcome = await rig.pull();
    expect(outcome).toMatchObject({ kind: "refused", reason: "encrypted-vault" });
    expect(outcome.notice).toContain("not supported yet");
    // Only the latch is written, in the state folder.
    expect(adapter.calls.filter((call) => /^(remove|rename)/.test(call))).toEqual([]);
    expect(adapter.calls.filter((call) => /^mkdir/.test(call))).toEqual(["mkdir .ipfs-sync"]);
    expect(adapter.files.has("notes/a.md")).toBe(false);
    expect(adapter.files.has(".ipfs-sync-fixture")).toBe(false);
    expect(adapter.files.has(".ipfs-sync/encrypted-seen.json")).toBe(true);
    expect(rig.store.get().lastPull).toBeUndefined();
  });

  it("refuses a plaintext root while the plaintext reader is off, and reads no manifest", async () => {
    const rig = pullRig({ adapter: freshVault(), allowPlaintextV1: false });
    await seed(rig, FILES_V1);
    const outcome = await rig.pull();
    expect(outcome).toMatchObject({ kind: "refused", reason: "plaintext-v1-off" });
    expect(outcome.notice).toContain("switched off");
    expect(rig.gateway.requests.some((request) => request.includes("manifest.json"))).toBe(false);
  });

  it("names a downgrade when an encrypted vault was seen before", async () => {
    const adapter = freshVault();
    const rig = pullRig({ adapter });
    await seed(rig, FILES_V1);
    encrypt(rig);
    await rig.pull();
    await seed(rig, FILES_V1);
    rig.gateway.objects.delete("bafyrootone000000000000/keyslots.json");
    rig.gateway.objects.delete("bafyrootone000000000000/manifest.enc");
    const outcome = await rig.pull();
    expect(outcome).toMatchObject({ kind: "refused", reason: "plaintext-v1-off" });
    expect(outcome.notice).toContain("downgrade");
  });
});
