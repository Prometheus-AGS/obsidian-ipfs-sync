import { describe, expect, it } from "vitest";
import { planDelta, type DeltaBaseline, type DeltaEntry } from "../../src/sync/diff";
import { createExclusionMatcher } from "../../src/sync/exclusions";
import { sha256Hex } from "../../src/sync/hash";
import { FileChangedDuringReadError, HostReadCapError } from "../../src/sync/host-errors";
import { scanVault } from "../../src/sync/scan";
import { createMemoryHost } from "../helpers/memory-host";

const text = (value: string) => new TextEncoder().encode(value);

async function entry(content: string): Promise<DeltaEntry> {
  return { sha256: await sha256Hex(text(content)), size: content.length };
}

describe("planDelta: carried paths", () => {
  async function scene() {
    const host = createMemoryHost();
    host.put("note.md", "note v1", 1000);
    host.put("stale.md", "older local copy", 1000);
    const baseline: DeltaBaseline<DeltaEntry> = {
      manifest: { files: { "note.md": await entry("note v1"), "stale.md": await entry("node version"), "CON.md": await entry("linux only") } },
      mtimes: { "note.md": 1000 },
    };
    return { host, baseline, scanned: await scanVault(host.fs, createExclusionMatcher()) };
  }

  it("returns the baseline entry of a carried path, does not call it removed, and never reads a local file at that path", async () => {
    const { host, baseline, scanned } = await scene();
    const plan = await planDelta(host.fs, scanned, baseline, { carried: new Set(["CON.md", "stale.md"]) });
    expect(plan.carried).toEqual({ "CON.md": baseline.manifest.files["CON.md"], "stale.md": baseline.manifest.files["stale.md"] });
    expect(plan.removed).toEqual([]);
    expect(plan.writes).toEqual([]);
    expect(Object.keys(plan.unchanged)).toEqual(["note.md"]);
    expect(host.reads.wholeReads).toEqual([]);
    // a local file at a carried path leaves no recorded modification time either
    expect(plan.mtimes).toEqual({ "note.md": 1000 });
  });

  it("without the carried set the same baseline reports the missing file as removed and the stale copy as a write", async () => {
    const { host, baseline, scanned } = await scene();
    const plan = await planDelta(host.fs, scanned, baseline);
    expect(plan.removed).toEqual(["CON.md"]);
    expect(plan.writes.map((write) => write.path)).toEqual(["stale.md"]);
    expect(plan.carried).toEqual({});
  });

  it("ignores a carried path that the baseline does not hold: it is an ordinary file", async () => {
    const { host, baseline, scanned } = await scene();
    host.put("extra.md", "fresh", 2000);
    const plan = await planDelta(host.fs, await scanVault(host.fs, createExclusionMatcher()), baseline, { carried: new Set(["extra.md"]) });
    expect(plan.carried).toEqual({});
    expect(plan.writes.map((write) => write.path)).toContain("extra.md");
    expect(scanned.length).toBeGreaterThan(0);
  });
});

describe("planDelta: files the host could not read whole", () => {
  async function planWith(error: Error) {
    const host = createMemoryHost();
    host.put("moving.md", "edited while read", 5000);
    host.put("steady.md", "steady", 5000);
    const original = host.fs.read;
    Object.assign(host.fs, {
      read: async (path: string) => {
        if (path === "moving.md") throw error;
        return original(path);
      },
    });
    const previous: DeltaBaseline<DeltaEntry> = { manifest: { files: { "moving.md": await entry("earlier text") } }, mtimes: { "moving.md": 1 } };
    return planDelta(host.fs, await scanVault(host.fs, createExclusionMatcher()), previous);
  }

  it("treats a file that changed during the planning-stage read as skipped, like one over the read cap", async () => {
    const changed = await planWith(new FileChangedDuringReadError("moving.md"));
    const capped = await planWith(new HostReadCapError("moving.md", 100, 10));
    expect(changed.skipped.map((file) => file.path)).toEqual(["moving.md"]);
    expect(changed.skipped[0]?.reason).toContain("changed while it was being read");
    expect(capped.skipped.map((file) => file.path)).toEqual(["moving.md"]);
    // not a write, keeps its previous entry, records no new modification time
    expect(changed.writes.map((write) => write.path)).toEqual(["steady.md"]);
    expect(Object.keys(changed.unchanged)).toEqual(["moving.md"]);
    expect(changed.mtimes).toEqual({ "steady.md": 5000 });
    expect(changed.removed).toEqual([]);
  });

  it("still throws any other read error", async () => {
    await expect(planWith(new Error("disk on fire"))).rejects.toThrow("disk on fire");
  });
});
