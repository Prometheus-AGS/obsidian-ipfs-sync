import { describe, expect, it } from "vitest";
import { historyFileName, isHistoryName, parseHistoryName } from "../../src/sync/history-names";
import { HISTORY_KEEP_FLOOR, planPrune } from "../../src/sync/prune-history";

/**
 * Task 1.6: the removal set of `prune-history` as a pure function of the names in `manifests/`. It decides nothing about authentication; it
 * proves what may be removed and what never is: only validated history names, never more than the surplus over the keep count, never the entries
 * the current manifest and the fork ancestor rule need.
 */

const cid = (index: number): string => `bafytest${String(index).padStart(40, "0")}`;
const prefixed = (count: number): string[] => Array.from({ length: count }, (_, index) => historyFileName(index + 1, cid(index + 1)));
const legacy = (count: number): string[] => Array.from({ length: count }, (_, index) => `bafylegacy${String(index).padStart(36, "0")}.enc`);
const shuffled = (names: readonly string[]): string[] => [...names].sort((a, b) => (a.split("").reverse().join("") < b.split("").reverse().join("") ? -1 : 1));

describe("the removal set", () => {
  it("removes the oldest 1,500 of 1,600 prefixed entries to keep 100", () => {
    const names = prefixed(1_600);
    const plan = planPrune(shuffled(names), { keep: 100 });
    expect(plan.removals).toEqual(names.slice(0, 1_500));
    expect(plan.kept).toEqual(names.slice(1_500));
    expect(plan.keepEffective).toBe(100);
    expect(plan.floorApplied).toBe(false);
    expect(plan.total).toBe(1_600);
    expect(plan.prefixed).toBe(1_600);
  });

  it("keeps at least the latest 20 whatever the request", () => {
    const names = prefixed(1_600);
    for (const keep of [1, 5, 19]) {
      const plan = planPrune(names, { keep });
      expect(plan.keepEffective, `--keep ${keep}`).toBe(HISTORY_KEEP_FLOOR);
      expect(plan.floorApplied).toBe(true);
      expect(plan.kept).toEqual(names.slice(-HISTORY_KEEP_FLOOR));
      expect(plan.removals).toHaveLength(1_580);
    }
    expect(planPrune(names, { keep: 20 }).floorApplied).toBe(false);
  });

  it("removes nothing when the folder holds no more than the keep count", () => {
    const names = prefixed(30);
    expect(planPrune(names, { keep: 30 }).removals).toEqual([]);
    expect(planPrune(names, { keep: 50 }).removals).toEqual([]);
    expect(planPrune([], { keep: 100 }).removals).toEqual([]);
  });

  it("counts files: two files at one sequence are two entries and are counted as duplicates", () => {
    const names = [...prefixed(40), historyFileName(38, "bafyfork0000000000000000000000000000000000000000")];
    const plan = planPrune(names, { keep: 25 });
    expect(plan.total).toBe(41);
    expect(plan.duplicateFiles).toBe(1);
    expect(plan.removals).toHaveLength(16);
    expect(plan.kept).toHaveLength(25);
  });

  it("removes legacy names first, with no order among them, and says how many", () => {
    const names = [...legacy(50), ...prefixed(60)];
    const plan = planPrune(shuffled(names), { keep: 40 });
    expect(plan.legacyTotal).toBe(50);
    expect(plan.legacyRemoved).toBe(50);
    expect(plan.removals.slice(0, 50).every((name) => parseHistoryName(name)?.sequence === undefined)).toBe(true);
    expect(plan.removals.slice(50)).toEqual(prefixed(60).slice(0, 20));
    expect(plan.kept).toEqual(prefixed(60).slice(20));
  });

  it("fills the keep set from prefixed entries first and from legacy names only for what is left", () => {
    const plan = planPrune([...legacy(10), ...prefixed(12)], { keep: 20 });
    // 12 prefixed entries fill part of the 20; the last 8 legacy names (by name, an arbitrary order) fill the rest.
    expect(plan.kept.filter((name) => parseHistoryName(name)?.sequence !== undefined)).toHaveLength(12);
    expect(plan.kept.filter((name) => parseHistoryName(name)?.sequence === undefined)).toHaveLength(8);
    expect(plan.removals).toHaveLength(2);
    expect(plan.legacyRemoved).toBe(2);
  });

  it("never removes a protected name or a protected sequence, even when the keep count would", () => {
    const names = prefixed(100);
    const plan = planPrune(names, { keep: 20, protectedSequences: [99, 100], protectedNames: [names[3] as string] });
    expect(plan.removals).not.toContain(names[3]);
    expect(plan.kept).toContain(names[3]);
    expect(plan.removals.every((name) => (parseHistoryName(name)?.sequence ?? 0) <= 98)).toBe(true);
    // A protected old entry is extra: the kept set grows by it.
    expect(plan.kept).toHaveLength(21);
    expect(plan.removals).toHaveLength(79);
  });

  it("protects every file at a protected sequence, not only one", () => {
    const names = [...prefixed(50), historyFileName(49, "bafyfork0000000000000000000000000000000000000000"), historyFileName(49, "bafyfork1111111111111111111111111111111111111111")];
    const plan = planPrune(names, { keep: 20, protectedSequences: [49, 50] });
    for (const name of names.filter((candidate) => parseHistoryName(candidate)?.sequence === 49)) expect(plan.removals).not.toContain(name);
  });
});

describe("a hostile listing", () => {
  const hostile = ["..", ".", "../keyslots.json", "current", "manifest.enc", "keyslots.json", "a/b.enc", "x‮.enc", "\u0000", "", "00000000000000000-bafy.enc", `${historyFileName(1, cid(1))}/..`, "0000000000000001-short.enc", "bafyshort.ENC"];

  it("can never put a name that is not a history name into the removal set", () => {
    const real = prefixed(60);
    const plan = planPrune(shuffled([...hostile, ...real]), { keep: 20 });
    expect(plan.ignored).toBe(hostile.length);
    for (const name of plan.removals) expect(isHistoryName(name), name).toBe(true);
    for (const name of hostile) {
      expect(plan.removals).not.toContain(name);
      expect(plan.kept).not.toContain(name);
    }
    expect(plan.removals).toEqual(real.slice(0, 40));
  });

  it("treats a listing of only hostile names as having nothing to remove", () => {
    const plan = planPrune(hostile, { keep: 20 });
    expect(plan.removals).toEqual([]);
    expect(plan.total).toBe(0);
  });

  it("lists a name that appears twice once", () => {
    const names = prefixed(30);
    const plan = planPrune([...names, ...names], { keep: 20 });
    expect(plan.removals).toEqual(names.slice(0, 10));
  });
});
