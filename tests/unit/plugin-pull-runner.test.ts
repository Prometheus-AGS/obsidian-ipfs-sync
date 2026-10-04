import { describe, expect, it, vi } from "vitest";
import { createPullRunner } from "../../src/plugin/pull-runner";
import { createSyncLock } from "../../src/plugin/sync-lock";
import { createSyncEventBus } from "../../src/core/events";
import { KuboHttpError } from "../../src/kubo";
import { PLAINTEXT_UNSUPPORTED_MESSAGE } from "../../src/sync/pull-errors";
import { ROOT1, SECRET, freshVault, plantPlaintextRoot, pullRig, storeWith } from "../helpers/plugin-pull-rig";
import { IPNS_NAME } from "../helpers/pull-fixtures";
import { requestUrlCalls, resetRequestUrl, setRequestUrlHandler, stubResponse } from "../support/obsidian-stub";

/**
 * The plugin pull runner's own rules: the destination guard, the target, the node traffic of a pull, the lock, the failure
 * notice, and what a root that holds no key slots gets. The plaintext (version 1) reader was removed by mvp-07b 3.1b; a
 * plaintext root is refused (`plaintext-unsupported`). The decrypting pull is covered by `plugin-pull-encrypted.test.ts`.
 */

const WRITES = /^(write|remove|rename|mkdir)/;

/** The outcome of a pull that passed the destination guard and found a plaintext root. */
const PLAINTEXT_REFUSED = { kind: "refused", reason: "plaintext-unsupported" } as const;

describe("plugin pull runner: destination guard", () => {
  it("admits a vault with notes and no marker: it reaches the node, writes no marker and changes no note (the guard is removed)", async () => {
    const adapter = freshVault();
    adapter.put("notes/real.md", "private");
    const rig = pullRig({ adapter });
    plantPlaintextRoot(rig.gateway);
    adapter.calls.length = 0;

    const outcome = await rig.pull();
    expect(outcome).toMatchObject(PLAINTEXT_REFUSED);
    expect(rig.gateway.requests.length).toBeGreaterThan(0);
    // The only writes are the lock file's (made and removed again) and its folder.
    expect(adapter.calls.filter((call) => WRITES.test(call) && !call.includes("publish.lock") && call !== "mkdir .ipfs-sync")).toEqual([]);
    expect(adapter.files.has(".ipfs-sync-fixture")).toBe(false);
    expect(adapter.text("notes/real.md")).toBe("private");
  });

  it("admits a note nested deep in a folder, and folders that hold no files", async () => {
    const nested = freshVault();
    nested.put("projects/2026/plan.md", "x");
    const nestedRig = pullRig({ adapter: nested });
    plantPlaintextRoot(nestedRig.gateway);
    expect(await nestedRig.pull()).toMatchObject(PLAINTEXT_REFUSED);

    const emptyFolders = freshVault();
    emptyFolders.folders.add("drafts");
    emptyFolders.folders.add("drafts/2026");
    const rig = pullRig({ adapter: emptyFolders });
    plantPlaintextRoot(rig.gateway);
    expect(await rig.pull()).toMatchObject(PLAINTEXT_REFUSED);
  });

  it("admits a fresh vault that holds only .obsidian, reaches the node, and writes nothing for a root it refuses", async () => {
    const adapter = freshVault();
    const rig = pullRig({ adapter });
    plantPlaintextRoot(rig.gateway);
    adapter.calls.length = 0;
    expect(await rig.pull()).toMatchObject(PLAINTEXT_REFUSED);
    expect(rig.gateway.requests.length).toBeGreaterThan(0);
    expect(adapter.files.has("notes/a.md")).toBe(false);
    expect(adapter.files.has(".ipfs-sync-fixture")).toBe(false);
    expect([...adapter.files.keys()].filter((path) => path.startsWith(".ipfs-sync/") && path !== ".ipfs-sync/publish.lock")).toEqual([]);
  });

  it("admits a vault that carries the marker even when it has notes", async () => {
    const adapter = freshVault();
    adapter.put(".ipfs-sync-fixture", "fixture\n");
    adapter.put("notes/a.md", "alpha", 5000);
    const rig = pullRig({ adapter });
    plantPlaintextRoot(rig.gateway);
    expect(await rig.pull()).toMatchObject(PLAINTEXT_REFUSED);
    expect(adapter.text("notes/a.md")).toBe("alpha");
  });
});

describe("plugin pull runner: node traffic", () => {
  it("sends only name resolve, key list and gateway reads", async () => {
    const rig = pullRig({ adapter: freshVault() });
    plantPlaintextRoot(rig.gateway);
    await rig.pull();
    expect(rig.gateway.requests.length).toBeGreaterThan(0);
    for (const request of rig.gateway.requests) expect(request, request).toMatch(/^(keyList|nameResolve \S+|GET \S+)/);
    expect(rig.gateway.requests[0]).toBe("keyList");
    expect(rig.gateway.requests[1]).toBe(`nameResolve ${IPNS_NAME}`);
  });

  it("asks for the key list only when no pull name is set", async () => {
    const rig = pullRig({ adapter: freshVault(), settings: { pullName: IPNS_NAME, ownedKeys: [] } });
    plantPlaintextRoot(rig.gateway);
    await rig.pull();
    expect(rig.gateway.requests).not.toContain("keyList");
    expect(rig.gateway.requests[0]).toBe(`nameResolve ${IPNS_NAME}`);
  });

  it("stops before fetching, and writes nothing, when the default key is not owned and no name is set", async () => {
    const adapter = freshVault();
    const rig = pullRig({ adapter, settings: { ownedKeys: [] } });
    plantPlaintextRoot(rig.gateway);
    adapter.calls.length = 0;
    const outcome = await rig.pull();
    expect(outcome).toMatchObject({ kind: "refused", reason: "no-target" });
    expect(outcome.notice).toContain("pull name");
    expect(rig.gateway.requests).toEqual(["keyList"]);
    expect(adapter.calls.filter((call) => WRITES.test(call))).toEqual([]);
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
  it("saves open editors first, before the pull makes any request", async () => {
    const flushes: string[] = [];
    const rig = pullRig({
      adapter: freshVault(),
      flushEditors: async () => {
        flushes.push(`flush after ${rig.gateway.requests.length} requests`);
      },
    });
    plantPlaintextRoot(rig.gateway);
    expect(await rig.pull()).toMatchObject(PLAINTEXT_REFUSED);
    expect(flushes).toEqual(["flush after 0 requests"]);
  });

  it("does not pull at all when the editors cannot be saved", async () => {
    const adapter = freshVault();
    const rig = pullRig({ adapter, flushEditors: () => Promise.reject(new Error("view is busy")) });
    plantPlaintextRoot(rig.gateway);
    const outcome = await rig.pull();
    expect(outcome.kind).toBe("failed");
    expect(outcome.notice).toContain("nothing was pulled");
    expect(outcome.notice).toContain("view is busy");
    expect(rig.gateway.requests).toEqual([]);
    expect(adapter.text("notes/a.md")).toBeUndefined();
  });
});

describe("plugin pull runner: one operation at a time", () => {
  it("refuses a pull while a publish holds the lock, sends nothing, then works after the release", async () => {
    const lock = createSyncLock();
    const rig = pullRig({ adapter: freshVault(), lock });
    plantPlaintextRoot(rig.gateway);
    const release = lock.tryAcquire("publish");
    expect(release).toBeDefined();
    const outcome = await rig.pull();
    expect(outcome).toMatchObject({ kind: "refused", reason: "busy" });
    expect(outcome.notice).toContain("publish is already in progress");
    expect(rig.gateway.requests).toEqual([]);
    expect(rig.runner.isRunning()).toBe(true);
    release?.();
    expect(await rig.pull()).toMatchObject(PLAINTEXT_REFUSED);
  });

  it("ignores a second pull while one is running and releases the lock afterwards, also after a failure", async () => {
    const rig = pullRig({ adapter: freshVault() });
    plantPlaintextRoot(rig.gateway);
    const first = rig.pull();
    expect(await rig.pull()).toMatchObject({ kind: "refused", reason: "busy" });
    expect(await first).toMatchObject(PLAINTEXT_REFUSED);
    expect(rig.runner.isRunning()).toBe(false);

    rig.gateway.names.clear();
    expect((await rig.pull()).kind).toBe("failed");
    expect(rig.lock.holder()).toBeUndefined();
  });
});

describe("plugin pull runner: secrets", () => {
  it("does not put credentials into a failure notice", async () => {
    const rig = pullRig({ adapter: freshVault() });
    plantPlaintextRoot(rig.gateway);
    rig.gateway.client.nameResolve = () => Promise.reject(new KuboHttpError("rpc", "https://node.test", 500, "could not resolve name"));
    const outcome = await rig.pull();
    expect(outcome.kind).toBe("failed");
    expect(outcome.notice).toContain("pull failed");
    expect(outcome.notice).not.toContain(SECRET);
    expect(rig.adapter.files.has(".ipfs-sync-fixture")).toBe(false);
  });
});

describe("plugin pull runner: a root without key slots", () => {
  const encrypt = (rig: ReturnType<typeof pullRig>): void => {
    rig.gateway.objects.delete(`${ROOT1}/manifest.json`);
    rig.gateway.objects.set(`${ROOT1}/keyslots.json`, new TextEncoder().encode("{}"));
    rig.gateway.objects.set(`${ROOT1}/manifest.enc`, new Uint8Array([1]));
  };

  it("sends a root with key slots to the decrypting pull: unreadable slots stop it, nothing is written and the lock is released", async () => {
    const adapter = freshVault();
    const rig = pullRig({ adapter });
    plantPlaintextRoot(rig.gateway);
    encrypt(rig);

    const outcome = await rig.pull();
    expect(outcome.kind).toBe("stopped");
    expect(outcome.notice).toContain("pull stopped");
    expect(outcome.notice).toContain("Nothing was written to your vault");
    expect(adapter.files.has("notes/a.md")).toBe(false);
    expect(adapter.files.has(".ipfs-sync-fixture")).toBe(false);
    expect(adapter.files.has(".ipfs-sync/publish.lock")).toBe(false);
    expect(rig.store.get().lastPull).toBeUndefined();
  });

  it("refuses a plaintext root with the no-longer-supported notice: nothing is written, the manifest is never read, the lock is released", async () => {
    const adapter = freshVault();
    const rig = pullRig({ adapter });
    plantPlaintextRoot(rig.gateway);
    adapter.calls.length = 0;

    const outcome = await rig.pull();
    expect(outcome).toMatchObject(PLAINTEXT_REFUSED);
    expect(outcome.notice).toContain("plaintext publications are no longer supported");
    expect(outcome.notice).toContain(PLAINTEXT_UNSUPPORTED_MESSAGE);
    expect(outcome.notice).not.toMatch(/switched off|downgrade|--allow/);
    expect(rig.gateway.requests.some((request) => request.includes("manifest.json"))).toBe(false);
    // Only the lock's own folder and file are touched: no vault file, no state, no marker.
    expect(adapter.calls.filter((call) => WRITES.test(call) && !call.includes("publish.lock") && call !== "mkdir .ipfs-sync")).toEqual([]);
    expect(adapter.files.has("notes/a.md")).toBe(false);
    expect(adapter.files.has(".ipfs-sync/publish.lock")).toBe(false);
    expect(rig.store.get().lastPull).toBeUndefined();
    expect(rig.lock.holder()).toBeUndefined();
  });

  it("gives an unattended run (the catch-up pull) the same refusal, and a vault that recorded an encrypted pull before gets no downgrade wording", async () => {
    const adapter = freshVault();
    // The old latch file: nothing reads it any more.
    adapter.put(".ipfs-sync/encrypted-seen.json", JSON.stringify({ version: 1, encryptedSeen: true, sightings: [] }), 1000);
    const rig = pullRig({ adapter });
    plantPlaintextRoot(rig.gateway);
    const outcome = await rig.runner.run({ unattended: true });
    expect(outcome).toMatchObject(PLAINTEXT_REFUSED);
    expect(outcome.notice).not.toMatch(/downgrade|attack/);
  });
});
