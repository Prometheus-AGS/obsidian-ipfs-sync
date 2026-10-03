// mvp-07a task 4.5: conflict copy names reserved against manifest paths, and the replace aborted when the copy cannot be written.
import { describe, expect, it } from "vitest";
import { conflictCandidate } from "../../src/sync/conflict-name";
import { settlePull, planEncryptedPull, type FetchResult } from "../../src/sync/encrypted-pull-plan";
import { createFilesMap, type EncryptedManifest } from "../../src/sync/encrypted-manifest";
import { CONFLICT_COPY_FAILED_REASON, createConflictReservations, preserveLocalCopy, tryPreserveLocalCopy, type PreserveContext } from "../../src/sync/pull-conflict";
import { createMemoryHost, type MemoryHost } from "../helpers/memory-host";
import { FAKE_CID, decode, encode, sha } from "../helpers/pull-fixtures";

const DATE = "2026-10-01";

function context(host: MemoryHost, manifestPaths: readonly string[]): PreserveContext {
  let counter = 0;
  return { fs: host.fs, newId: () => `id${(counter += 1)}`, dateStamp: DATE, reserved: createConflictReservations(manifestPaths) };
}

describe("conflict copy names are reserved against manifest paths", () => {
  it("skips a copy name that a manifest path will take, exactly and by fold key", async () => {
    const host = createMemoryHost();
    host.put("note.md", "local edit", 10);
    const taken = conflictCandidate("note.md", DATE, 1);
    const foldedTwin = conflictCandidate("Note.md", DATE, 2);
    const ctx = context(host, ["note.md", taken, foldedTwin]);

    const copy = await preserveLocalCopy(ctx, "note.md");

    // Attempt 1 is a manifest path; attempt 2 differs from `foldedTwin` only by case (same file on a case-insensitive volume); attempt 3 is free.
    expect(copy).toBe(conflictCandidate("note.md", DATE, 3));
    expect(decode(host.files.get(copy)?.data)).toBe("local edit");
    expect(decode(host.files.get("note.md")?.data)).toBe("local edit");
  });

  it("hands out distinct names to two conflicts in one run", async () => {
    const host = createMemoryHost();
    host.put("a.md", "one", 10);
    const ctx = context(host, ["a.md"]);

    const first = await preserveLocalCopy(ctx, "a.md");
    const second = await preserveLocalCopy(ctx, "a.md");

    expect(second).not.toBe(first);
  });

  it("a plain Set of manifest paths still works (the plaintext pull passes one)", async () => {
    const host = createMemoryHost();
    host.put("a.md", "one", 10);

    const copy = await preserveLocalCopy({ ...context(host, []), reserved: new Set(["a.md", conflictCandidate("a.md", DATE, 1)]) }, "a.md");

    expect(copy).toBe(conflictCandidate("a.md", DATE, 2));
  });
});

describe("a conflict copy that cannot be written aborts the replace", () => {
  it("leaves the local file untouched, leaves no temp file, and reports a fixed reason", async () => {
    const host = createMemoryHost();
    host.put("note.md", "local edit", 10);
    host.failOn.rename = /ipfs conflict/;
    const before = host.files.get("note.md");

    const result = await tryPreserveLocalCopy(context(host, ["note.md"]), "note.md");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe(CONFLICT_COPY_FAILED_REASON);
    expect(!result.ok && result.reason).not.toContain("note.md");
    expect(host.files.get("note.md")).toBe(before);
    expect(decode(host.files.get("note.md")?.data)).toBe("local edit");
    expect([...host.files.keys()]).toEqual(["note.md"]);
    // The only things written were the copy's temp file and its removal; nothing touched the original path.
    expect(host.mutations.filter((entry) => entry.endsWith(" note.md"))).toEqual([]);
  });

  it("with that result the path is unfetched and carried, and the pull is incomplete", async () => {
    const host = createMemoryHost();
    host.put("note.md", "local edit", 10);
    host.failOn.rename = /ipfs conflict/;
    const manifest: EncryptedManifest = {
      version: 2,
      vaultId: "0123456789abcdef0123456789abcdef",
      sequence: 2,
      rootCID: FAKE_CID,
      publishedAt: "2026-10-01T00:00:00.000Z",
      device: "other-0123456789ab",
      excludesHash: "0".repeat(64),
      files: createFilesMap([["note.md", { sha256: await sha("remote text"), size: encode("remote text").length, blob: "a".repeat(52), fileId: "b".repeat(32), cid: FAKE_CID }]]),
    };
    const planned = await planEncryptedPull({ fs: host.fs, manifest, base: undefined, unmaterialized: [], forceVerify: false });
    const decision = planned.paths[0];
    expect(decision?.kind).toBe("conflict");

    const preserved = await tryPreserveLocalCopy({ fs: host.fs, newId: () => "x", dateStamp: DATE, reserved: planned.reservations }, "note.md");
    const results = new Map<string, FetchResult>([["note.md", preserved.ok ? { ok: true, mtimeMs: 1, conflictPath: preserved.copyPath } : { ok: false, outcome: "unfetched", reason: preserved.reason }]]);
    const settled = settlePull({ manifest, plan: planned, results });

    expect(settled.unfetched).toEqual([{ path: "note.md", reason: CONFLICT_COPY_FAILED_REASON }]);
    expect(settled.unmaterialized).toEqual(["note.md"]);
    expect(settled.complete).toBe(false);
    expect(decode(host.files.get("note.md")?.data)).toBe("local edit");
  });

  it("an error that is not a failed copy propagates", async () => {
    const host = createMemoryHost();
    host.put("note.md", "x", 10);
    const broken = { ...context(host, ["note.md"]), newId: (): string => { throw new TypeError("no id source"); } };

    await expect(tryPreserveLocalCopy(broken, "note.md")).rejects.toThrow("no id source");
  });
});
