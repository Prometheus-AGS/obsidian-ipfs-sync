// mvp-07a task 5.3: the temp sweep that runs when the plugin loads (only while it holds publish.lock), and what the presenter
// does with the decrypting pull's outcomes (the Resolve fork button, the quiet rules, the status line).
import { describe, expect, it } from "vitest";
import { createSyncEventBus } from "../../src/core/events";
import { createPullPresenter, RESOLVE_FORK_LABEL, type PresenterPorts } from "../../src/plugin/pull-presenter";
import type { PullReport } from "../../src/plugin/pull-notices";
import { createPullRunner, type PullOutcome, type PullRunner } from "../../src/plugin/pull-runner";
import { createSyncLock, type SyncLock } from "../../src/plugin/sync-lock";
import { encodeLock } from "../../src/sync/publish-lock";
import { NOW, freshVault, storeWith } from "../helpers/plugin-pull-rig";
import type { MemoryAdapter } from "../support/memory-adapter";

function sweeper(adapter = freshVault(), lock = createSyncLock()): { readonly adapter: MemoryAdapter; readonly lock: SyncLock; readonly sweep: PullRunner["sweepTemp"] } {
  const runner = createPullRunner({ store: storeWith(), adapter, bus: createSyncEventBus(), lock, now: () => NOW });
  return { adapter, lock, sweep: () => runner.sweepTemp() };
}

describe("temp sweep on load", () => {
  it("removes stale part and copy files while it holds publish.lock, leaves other files alone, and releases the lock", async () => {
    const adapter = freshVault();
    adapter.put(".ipfs-sync/tmp/aaaa-1111.part", "partial", 1000);
    adapter.put(".ipfs-sync/tmp/bbbb-2222.copy", "copy", 1000);
    adapter.put(".ipfs-sync/tmp/notes.txt", "not ours", 1000);
    const s = sweeper(adapter);

    expect(await s.sweep()).toEqual({ ran: true, removed: 2 });

    expect([...adapter.files.keys()].filter((path) => path.startsWith(".ipfs-sync/"))).toEqual([".ipfs-sync/tmp/notes.txt"]);
    expect(s.lock.holder()).toBeUndefined();
  });

  it("is skipped while another process holds publish.lock, and runs once the lock is free", async () => {
    const adapter = freshVault();
    adapter.put(".ipfs-sync/tmp/aaaa-1111.part", "partial", 1000);
    const other = encodeLock({ token: "a-running-pull", pid: 77, host: "another-host", time: NOW.getTime() });
    adapter.put(".ipfs-sync/publish.lock", other);
    const s = sweeper(adapter);

    expect(await s.sweep()).toEqual({ ran: false, removed: 0 });
    expect(adapter.files.has(".ipfs-sync/tmp/aaaa-1111.part")).toBe(true);
    expect(new Uint8Array(adapter.files.get(".ipfs-sync/publish.lock")?.data ?? new ArrayBuffer(0))).toEqual(other);

    adapter.files.delete(".ipfs-sync/publish.lock");
    expect(await s.sweep()).toEqual({ ran: true, removed: 1 });
    expect(adapter.files.has(".ipfs-sync/tmp/aaaa-1111.part")).toBe(false);
    expect(adapter.files.has(".ipfs-sync/publish.lock")).toBe(false);
  });

  it("is skipped while a publish or pull of this process holds the in-process lock", async () => {
    const adapter = freshVault();
    adapter.put(".ipfs-sync/tmp/aaaa-1111.part", "partial", 1000);
    const s = sweeper(adapter);
    const release = s.lock.tryAcquire("publish");
    expect(await s.sweep()).toEqual({ ran: false, removed: 0 });
    expect(adapter.files.has(".ipfs-sync/tmp/aaaa-1111.part")).toBe(true);
    release?.();
    expect((await s.sweep()).ran).toBe(true);
  });

  it("takes no lock and writes nothing when there is no temp folder", async () => {
    const adapter = freshVault();
    adapter.calls.length = 0;
    const s = sweeper(adapter);
    expect(await s.sweep()).toEqual({ ran: false, removed: 0 });
    expect(adapter.calls.filter((call) => /^(write|mkdir|rename|remove)/.test(call))).toEqual([]);
  });
});

const REPORT: PullReport = {
  mode: "pull",
  sequence: 4,
  fetched: 2,
  unchanged: 1,
  conflictCopies: [],
  integrityFailed: [],
  unfetched: [],
  skippedExpected: [],
  skippedUnsafe: [],
  remoteDeleted: 0,
};

interface Seen {
  readonly notices: { readonly text: string; readonly ms: number }[];
  readonly statuses: string[];
  readonly offers: { readonly text: string; readonly label: string; readonly run: () => void }[];
}

function presenter(): { readonly seen: Seen; readonly presenter: ReturnType<typeof createPullPresenter> } {
  const seen: Seen = { notices: [], statuses: [], offers: [] };
  const ports: PresenterPorts = {
    createNotice: (text, ms) => {
      seen.notices.push({ text, ms });
      return { setMessage: () => undefined, hide: () => undefined };
    },
    setStatus: (text) => void seen.statuses.push(text),
    schedule: () => undefined,
    now: () => NOW,
    offerAction: (text, label, run) => void seen.offers.push({ text, label, run }),
  };
  return { seen, presenter: createPullPresenter(ports) };
}

const stoppedFork: PullOutcome = { kind: "stopped", reason: "fork", notice: "fork notice", action: "resolve-fork" };

describe("pull presenter: decrypting outcomes", () => {
  it("offers the Resolve fork action after a fork notice, and the button starts it", () => {
    const { seen, presenter: p } = presenter();
    let started = 0;
    p.begin({ quiet: false, resolveFork: () => void (started += 1) }).finish(stoppedFork);
    expect(seen.offers).toHaveLength(1);
    expect(seen.offers[0]?.label).toBe(RESOLVE_FORK_LABEL);
    seen.offers[0]?.run();
    expect(started).toBe(1);
  });

  it("offers nothing for a stop that has no action, and nothing without a handler", () => {
    const { seen, presenter: p } = presenter();
    p.begin({ quiet: false, resolveFork: () => undefined }).finish({ kind: "stopped", reason: "older", notice: "older", action: undefined });
    p.begin({ quiet: false }).finish(stoppedFork);
    expect(seen.offers).toEqual([]);
  });

  it("shows the finished pull's counts in the status bar, and 'unfinished' when files are", () => {
    const { seen, presenter: p } = presenter();
    p.begin({ quiet: false }).finish({ kind: "completed", notice: "n", report: REPORT });
    p.begin({ quiet: false }).finish({ kind: "unfinished", notice: "n", report: { ...REPORT, unfetched: [{ path: "a.md", reason: "r" }] } });
    expect(seen.statuses).toContain("IPFS Sync: pull 12:00: 2 fetched, 0 conflicts");
    expect(seen.statuses).toContain("IPFS Sync: pull 12:00: 2 fetched, 0 conflicts, 1 unfinished");
  });

  it("a quiet run says nothing about a locked vault, a busy lock or an unconfirmed first pull, and still says what matters", () => {
    const { seen, presenter: p } = presenter();
    p.begin({ quiet: true }).finish({ kind: "refused", reason: "locked", notice: "locked" });
    p.begin({ quiet: true }).finish({ kind: "refused", reason: "busy", notice: "busy" });
    p.begin({ quiet: true }).finish({ kind: "stopped", reason: "first-pull-not-confirmed", notice: "unconfirmed", action: undefined });
    p.begin({ quiet: true }).finish({ kind: "completed", notice: "nothing new", report: { ...REPORT, fetched: 0 } });
    expect(seen.notices).toEqual([]);

    p.begin({ quiet: true }).finish({ kind: "completed", notice: "changed", report: REPORT });
    p.begin({ quiet: true }).finish({ kind: "stopped", reason: "older", notice: "older", action: undefined });
    p.begin({ quiet: true }).finish({ kind: "failed", notice: "failed" });
    expect(seen.notices.map((notice) => notice.text)).toEqual(["changed", "older", "failed"]);
  });
});
