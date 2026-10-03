// mvp-07a task 4.5: the planner, the outcome classes and the baseline / unmaterialized merge of the encrypted pull.
import { describe, expect, it } from "vitest";
import { createFilesMap, type EncryptedManifest, type EncryptedManifestFile } from "../../src/sync/encrypted-manifest";
import {
  NOT_REACHED_REASON,
  isWritable,
  planEncryptedPull,
  settlePull,
  type EncryptedPullPlan,
  type FetchResult,
  type PlannedPath,
  type PullBase,
} from "../../src/sync/encrypted-pull-plan";
import { HostReadCapError } from "../../src/sync/host-errors";
import { createMemoryHost, type MemoryHost } from "../helpers/memory-host";
import { FAKE_CID, encode, sha } from "../helpers/pull-fixtures";

const VAULT_ID = "0123456789abcdef0123456789abcdef";
const NO_RESULTS: ReadonlyMap<string, FetchResult> = new Map();

async function entryOf(text: string): Promise<EncryptedManifestFile> {
  return { sha256: await sha(text), size: encode(text).length, blob: "a".repeat(52), fileId: "b".repeat(32), cid: FAKE_CID };
}

async function manifestOf(files: Readonly<Record<string, string>>): Promise<EncryptedManifest> {
  const entries = await Promise.all(Object.entries(files).map(async ([path, text]) => [path, await entryOf(text)] as const));
  return {
    version: 2,
    vaultId: VAULT_ID,
    sequence: 5,
    rootCID: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    publishedAt: "2026-10-01T00:00:00.000Z",
    device: "other-0123456789ab",
    excludesHash: "0".repeat(64),
    files: createFilesMap(entries),
  };
}

async function baseOf(files: Readonly<Record<string, string>>, mtimes: Readonly<Record<string, number>> = {}): Promise<PullBase> {
  const entries = await Promise.all(Object.entries(files).map(async ([path, text]) => [path, { sha256: await sha(text), size: encode(text).length }] as const));
  return { files: Object.fromEntries(entries), mtimes };
}

interface PlanOptions {
  readonly host: MemoryHost;
  readonly remote: Readonly<Record<string, string>>;
  readonly base?: Readonly<Record<string, string>>;
  readonly mtimes?: Readonly<Record<string, number>>;
  readonly unmaterialized?: readonly string[];
  readonly forceVerify?: boolean;
}

async function plan(options: PlanOptions): Promise<{ readonly manifest: EncryptedManifest; readonly plan: EncryptedPullPlan }> {
  const manifest = await manifestOf(options.remote);
  const result = await planEncryptedPull({
    fs: options.host.fs,
    manifest,
    base: options.base === undefined ? undefined : await baseOf(options.base, options.mtimes),
    unmaterialized: options.unmaterialized ?? [],
    forceVerify: options.forceVerify ?? false,
  });
  return { manifest, plan: result };
}

const decisionOf = (planned: EncryptedPullPlan, path: string): PlannedPath => {
  const found = planned.paths.find((item) => item.path === path);
  if (found === undefined) throw new Error(`no decision for ${path}`);
  return found;
};
const kindOf = (planned: EncryptedPullPlan, path: string): string | undefined => planned.paths.find((item) => item.path === path)?.kind;

const fetched = (mtimeMs = 1): FetchResult => ({ ok: true, mtimeMs });
const failed = (outcome: "integrity-failed" | "unfetched", reason = "because"): FetchResult => ({ ok: false, outcome, reason });

describe("the plan: every row of the three-way table, per path", () => {
  it("classifies each file against the baseline and the remote", async () => {
    const host = createMemoryHost();
    host.put("same.md", "same", 10);
    host.put("edited-remote.md", "old", 10);
    host.put("edited-local.md", "mine, edited", 10);
    host.put("both.md", "local text", 10);
    host.put("untracked.md", "untracked local", 10);
    host.put("equal-untracked.md", "equal", 10);

    const { plan: planned } = await plan({
      host,
      remote: {
        "same.md": "same",
        "edited-remote.md": "new",
        "edited-local.md": "orig",
        "both.md": "remote text",
        "untracked.md": "remote untracked",
        "equal-untracked.md": "equal",
        "missing.md": "missing locally",
        "gone-local.md": "kept by the node",
      },
      base: { "same.md": "same", "edited-remote.md": "old", "edited-local.md": "orig", "both.md": "orig", "missing.md": "missing locally", "removed-remote.md": "x" },
      mtimes: { "same.md": 10, "edited-remote.md": 10, "edited-local.md": 10, "both.md": 10 },
    });

    expect(kindOf(planned, "same.md")).toBe("unchanged");
    expect(kindOf(planned, "edited-remote.md")).toBe("replace");
    expect(kindOf(planned, "edited-local.md")).toBe("locally-modified");
    expect(kindOf(planned, "both.md")).toBe("conflict");
    expect(kindOf(planned, "untracked.md")).toBe("conflict");
    expect(kindOf(planned, "equal-untracked.md")).toBe("unchanged");
    expect(kindOf(planned, "missing.md")).toBe("fetch");
    expect(kindOf(planned, "gone-local.md")).toBe("fetch");
    expect(planned.remoteDeleted).toEqual(["removed-remote.md"]);
    // The paths come sorted, and only the writable ones are fetched.
    expect(planned.paths.map((item) => item.path)).toEqual([...planned.paths.map((item) => item.path)].sort());
    expect(planned.paths.filter(isWritable).map((item) => item.path)).toEqual(["both.md", "edited-remote.md", "gone-local.md", "missing.md", "untracked.md"]);
    const conflict = decisionOf(planned, "both.md");
    expect(conflict.kind === "conflict" && conflict.localSha256).toBe(await sha("local text"));
  });

  it("trusts size and mtime, and hashes everything when forceVerify is set (exclusion lists differ)", async () => {
    const host = createMemoryHost();
    // Same size and mtime as the baseline, different content: the documented limit of the shortcut.
    host.put("a.md", "tampered!", 10);
    const common = { host, remote: { "a.md": "node text" }, base: { "a.md": "123456789" }, mtimes: { "a.md": 10 } };

    const trusting = await plan({ ...common });
    const verified = await plan({ ...common, forceVerify: true });

    expect(trusting.plan.hashed).toBe(0);
    expect(kindOf(trusting.plan, "a.md")).toBe("replace");
    expect(verified.plan.hashed).toBe(1);
    expect(kindOf(verified.plan, "a.md")).toBe("conflict");
  });

  it("does not match an inherited member: a path named constructor is an ordinary path", async () => {
    const host = createMemoryHost();
    const { plan: planned } = await plan({ host, remote: { constructor: "x", "toString.md": "y" } });
    expect(kindOf(planned, "constructor")).toBe("fetch");
    expect(kindOf(planned, "toString.md")).toBe("fetch");
  });
});

describe("the plan: path policy and the local walk", () => {
  it("skips an old-build .obsidian entry as expected, a traversal as unsafe/shape, a Windows form as unsafe/platform, and reads none of them", async () => {
    const host = createMemoryHost();
    const { plan: planned } = await plan({ host, remote: { ".obsidian/app.json": "{}", "../x": "x", "CON.md": "c", "ok.md": "fine" } });

    const skip = (path: string): unknown => {
      const decision = decisionOf(planned, path);
      return decision.kind === "policy-skipped" ? { severity: decision.skip.severity, class: "class" in decision.skip ? decision.skip.class : undefined } : undefined;
    };
    expect(skip(".obsidian/app.json")).toEqual({ severity: "expected", class: undefined });
    expect(skip("../x")).toEqual({ severity: "unsafe", class: "shape" });
    expect(skip("CON.md")).toEqual({ severity: "unsafe", class: "platform" });
    expect(kindOf(planned, "ok.md")).toBe("fetch");
    expect(host.reads.count).toBe(0);
  });

  it("skips a collision group as a group, and a file/directory prefix group", async () => {
    const host = createMemoryHost();
    const { plan: planned } = await plan({ host, remote: { "Note.md": "a", "note.md": "b", a: "file", "a/b.md": "under", "other.md": "o" } });

    for (const path of ["Note.md", "note.md", "a", "a/b.md"]) {
      const decision = decisionOf(planned, path);
      expect(decision.kind, path).toBe("policy-skipped");
      expect(decision.kind === "policy-skipped" && decision.skip.severity === "unsafe" && decision.skip.class, path).toBe("platform");
    }
    expect(kindOf(planned, "other.md")).toBe("fetch");
  });

  it("skips a path behind a symbolic link as unsafe/platform without reading it", async () => {
    const host = createMemoryHost();
    host.link("linked");
    const { plan: planned } = await plan({ host, remote: { "linked/inside.md": "x" } });

    const decision = decisionOf(planned, "linked/inside.md");
    expect(decision.kind === "policy-skipped" && decision.skip.code).toBe("symlink");
    expect(decision.kind === "policy-skipped" && decision.skip.severity === "unsafe" && decision.skip.class).toBe("platform");
    expect(host.reads.count).toBe(0);
  });

  it("skips a manifest file path where this device has a directory", async () => {
    const host = createMemoryHost();
    host.put("notes/inner.md", "x");
    const { plan: planned } = await plan({ host, remote: { notes: "a file in the manifest" } });

    expect(decisionOf(planned, "notes").kind).toBe("policy-skipped");
  });

  it("leaves a local file the host cannot read, and says unfetched (not integrity-failed)", async () => {
    const host = createMemoryHost();
    host.put("huge.md", "content", 10);
    const refusing = { ...host.fs, read: async (): Promise<never> => { throw new HostReadCapError("huge.md", 99_000_000, 50_000_000); } };
    const manifest = await manifestOf({ "huge.md": "node" });

    const planned = await planEncryptedPull({ fs: refusing, manifest, base: undefined, unmaterialized: [], forceVerify: false });

    const decision = decisionOf(planned, "huge.md");
    expect(decision.kind).toBe("unfetched");
    expect(decision.kind === "unfetched" && decision.reason).not.toContain("huge.md");
  });
});

describe("unmaterialized paths are planned with B absent", () => {
  it("a differing local file is a conflict, a missing file is a fetch, an equal file is a restored path", async () => {
    const host = createMemoryHost();
    host.put("differs.md", "stale older copy", 10);
    host.put("equal.md", "node text", 10);
    // Every baseline entry is the node's, and the old local copy even equals what the baseline says: B must not be used.
    const { plan: planned } = await plan({
      host,
      remote: { "differs.md": "node text", "missing.md": "node text", "equal.md": "node text" },
      base: { "differs.md": "stale older copy", "missing.md": "node text", "equal.md": "node text" },
      mtimes: { "differs.md": 10, "equal.md": 10 },
      unmaterialized: ["differs.md", "missing.md", "equal.md"],
    });

    expect(kindOf(planned, "differs.md")).toBe("conflict");
    expect(kindOf(planned, "missing.md")).toBe("fetch");
    const equal = decisionOf(planned, "equal.md");
    expect(equal.kind === "unchanged" && equal.restored).toBe(true);
  });

  it("an unmaterialized path never takes the size-and-mtime shortcut", async () => {
    const host = createMemoryHost();
    host.put("a.md", "tampered!", 10);
    const { plan: planned } = await plan({ host, remote: { "a.md": "node text" }, base: { "a.md": "123456789" }, mtimes: { "a.md": 10 }, unmaterialized: ["a.md"] });

    expect(planned.hashed).toBe(1);
    expect(kindOf(planned, "a.md")).toBe("conflict");
  });
});

describe("settlePull: the baseline, unmaterialized and complete", () => {
  it("a fetch that fails takes the node's entry and joins unmaterialized, whichever class", async () => {
    const host = createMemoryHost();
    const { manifest, plan: planned } = await plan({ host, remote: { "bad.md": "b", "slow.md": "s", "good.md": "g" } });

    const settled = settlePull({
      manifest,
      plan: planned,
      results: new Map([["bad.md", failed("integrity-failed")], ["slow.md", failed("unfetched")], ["good.md", fetched(7)]]),
    });

    expect(settled.unmaterialized).toEqual(["bad.md", "slow.md"]);
    expect(settled.manifest.files["bad.md"]).toEqual(manifest.files["bad.md"]);
    expect(settled.manifest.files["slow.md"]).toEqual(manifest.files["slow.md"]);
    expect(Object.keys(settled.manifest.files).sort()).toEqual(["bad.md", "good.md", "slow.md"]);
    expect(settled.integrityFailed).toEqual([{ path: "bad.md", reason: "because" }]);
    expect(settled.unfetched).toEqual([{ path: "slow.md", reason: "because" }]);
    expect(settled.fetched).toEqual(["good.md"]);
    expect(settled.mtimes).toEqual({ "good.md": 7 });
    expect(settled.complete).toBe(false);
    expect(settled.needsAttention).toBe(true);
    // The state invariant: unmaterialized is sorted, unique and a subset of the baseline.
    for (const path of settled.unmaterialized) expect(Object.hasOwn(settled.manifest.files, path)).toBe(true);
  });

  it("a Note.md/note.md group and CON.md join unmaterialized; .obsidian/app.json and ../x are in neither the baseline nor the list", async () => {
    const host = createMemoryHost();
    const { manifest, plan: planned } = await plan({
      host,
      remote: { "Note.md": "a", "note.md": "b", "CON.md": "c", ".obsidian/app.json": "{}", "../x": "x", "plain.md": "p" },
    });

    const settled = settlePull({ manifest, plan: planned, results: new Map([["plain.md", fetched()]]) });

    expect(settled.unmaterialized).toEqual(["CON.md", "Note.md", "note.md"]);
    expect(Object.keys(settled.manifest.files).sort()).toEqual(["CON.md", "Note.md", "note.md", "plain.md"]);
    expect(Object.hasOwn(settled.manifest.files, ".obsidian/app.json")).toBe(false);
    expect(Object.hasOwn(settled.manifest.files, "../x")).toBe(false);
    expect(settled.skipped).toHaveLength(5);
    // A skip never makes a pull incomplete, but an unsafe skip still needs attention (exit 1).
    expect(settled.complete).toBe(true);
    expect(settled.needsAttention).toBe(true);
  });

  it("complete is false iff a path is integrity-failed or unfetched", async () => {
    const host = createMemoryHost();
    const { manifest, plan: planned } = await plan({ host, remote: { "a.md": "a", "CON.md": "c", ".obsidian/app.json": "{}" } });

    const clean = settlePull({ manifest, plan: planned, results: new Map([["a.md", fetched()]]) });
    const integrity = settlePull({ manifest, plan: planned, results: new Map([["a.md", failed("integrity-failed")]]) });
    const unfetched = settlePull({ manifest, plan: planned, results: new Map([["a.md", failed("unfetched")]]) });

    expect(clean.complete).toBe(true);
    expect(integrity.complete).toBe(false);
    expect(unfetched.complete).toBe(false);
  });

  it("an old-build manifest with .obsidian/app.json is policy-skipped/expected, complete, and exits 0", async () => {
    const host = createMemoryHost();
    const { manifest, plan: planned } = await plan({ host, remote: { ".obsidian/app.json": "{}", ".obsidian/themes/x.css": "css", "note.md": "n" } });

    const settled = settlePull({ manifest, plan: planned, results: new Map([["note.md", fetched()]]) });

    expect(settled.skipped.map((skip) => skip.severity)).toEqual(["expected", "expected"]);
    expect(settled.complete).toBe(true);
    expect(settled.needsAttention).toBe(false);
    expect(settled.unmaterialized).toEqual([]);
    expect(Object.keys(settled.manifest.files)).toEqual(["note.md"]);
  });

  it("a restored path leaves unmaterialized and takes the node's entry (fetched, or an equal local file)", async () => {
    const host = createMemoryHost();
    host.put("equal.md", "node text", 10);
    const { manifest, plan: planned } = await plan({
      host,
      remote: { "equal.md": "node text", "fetched.md": "node text 2", "still.md": "node text 3" },
      base: { "equal.md": "node text", "fetched.md": "node text 2", "still.md": "node text 3" },
      unmaterialized: ["equal.md", "fetched.md", "still.md"],
    });

    const settled = settlePull({ manifest, plan: planned, results: new Map([["fetched.md", fetched(9)], ["still.md", failed("unfetched")]]) });

    expect(settled.restored).toEqual(["equal.md", "fetched.md"]);
    expect(settled.unmaterialized).toEqual(["still.md"]);
    expect(settled.complete).toBe(false);
    expect(settled.mtimes).toEqual({ "equal.md": 10, "fetched.md": 9 });
  });

  it("a later pull that fetches every previously failed file sets complete and empties unmaterialized", async () => {
    const host = createMemoryHost();
    const { manifest, plan: planned } = await plan({ host, remote: { "a.md": "a" }, base: { "a.md": "a" }, unmaterialized: ["a.md"] });

    const settled = settlePull({ manifest, plan: planned, results: new Map([["a.md", fetched()]]) });

    expect(settled.complete).toBe(true);
    expect(settled.unmaterialized).toEqual([]);
  });

  it("a writable path without a result counts unfetched (the pool stopped), and a remote deletion is dropped from the baseline", async () => {
    const host = createMemoryHost();
    const { manifest, plan: planned } = await plan({ host, remote: { "a.md": "a" }, base: { "a.md": "a", "old.md": "o" } });

    const settled = settlePull({ manifest, plan: planned, results: NO_RESULTS });

    expect(settled.unfetched).toEqual([{ path: "a.md", reason: NOT_REACHED_REASON }]);
    expect(settled.unmaterialized).toEqual(["a.md"]);
    expect(settled.remoteDeleted).toEqual(["old.md"]);
    expect(Object.hasOwn(settled.manifest.files, "old.md")).toBe(false);
  });

  it("a locally modified path takes the node's entry (B = R) and records no mtime; a conflict is reported with its copy", async () => {
    const host = createMemoryHost();
    host.put("mine.md", "my edit", 10);
    host.put("both.md", "my side", 10);
    const { manifest, plan: planned } = await plan({
      host,
      remote: { "mine.md": "orig", "both.md": "their side" },
      base: { "mine.md": "orig", "both.md": "orig" },
    });

    const settled = settlePull({
      manifest,
      plan: planned,
      results: new Map([["both.md", { ok: true, mtimeMs: 3, conflictPath: "both (ipfs conflict 2026-10-01).md" }]]),
    });

    expect(settled.locallyModified).toEqual(["mine.md"]);
    expect(settled.manifest.files["mine.md"]).toEqual(manifest.files["mine.md"]);
    expect(settled.mtimes).toEqual({ "both.md": 3 });
    expect(settled.conflicts).toEqual([{ path: "both.md", conflictPath: "both (ipfs conflict 2026-10-01).md" }]);
    expect(settled.unmaterialized).toEqual([]);
  });

  it("an unreadable local file is unfetched and carried; a symlinked path is a platform skip and carried", async () => {
    const host = createMemoryHost();
    host.put("huge.md", "content", 10);
    host.link("linked");
    const refusing = { ...host.fs, read: async (): Promise<never> => { throw new HostReadCapError("huge.md", 99_000_000, 50_000_000); } };
    const manifest = await manifestOf({ "huge.md": "node", "linked/a.md": "x" });
    const planned = await planEncryptedPull({ fs: refusing, manifest, base: undefined, unmaterialized: [], forceVerify: false });

    const settled = settlePull({ manifest, plan: planned, results: NO_RESULTS });

    expect(settled.unmaterialized).toEqual(["huge.md", "linked/a.md"]);
    expect(settled.complete).toBe(false);
  });
});
