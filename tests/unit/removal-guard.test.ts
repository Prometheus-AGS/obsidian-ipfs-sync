import { describe, expect, it } from "vitest";
import { assessRemovals } from "../../src/sync/removal-guard";

const paths = (count: number, prefix = "n"): string[] => Array.from({ length: count }, (_, index) => `${prefix}${index}.md`);
const nothingExcluded = (): boolean => false;
const underObsidian = (path: string): boolean => path.startsWith(".obsidian/");

describe("assessRemovals: the mass-removal threshold", () => {
  it("proceeds when 3 of 10 entries go", () => {
    const before = paths(10);
    expect(assessRemovals({ before, removed: before.slice(0, 3), dropped: [], excluded: nothingExcluded })).toMatchObject({ stop: false, others: before.slice(0, 3), remaining: 10 });
  });

  it("proceeds at exactly half and stops above it", () => {
    const before = paths(10);
    expect(assessRemovals({ before, removed: before.slice(0, 5), dropped: [], excluded: nothingExcluded }).stop).toBe(false);
    expect(assessRemovals({ before, removed: before.slice(0, 6), dropped: [], excluded: nothingExcluded }).stop).toBe(true);
  });

  it("stops when every entry goes, including a one-entry manifest", () => {
    const before = paths(4);
    expect(assessRemovals({ before, removed: before, dropped: [], excluded: nothingExcluded }).stop).toBe(true);
    expect(assessRemovals({ before: ["only.md"], removed: ["only.md"], dropped: [], excluded: nothingExcluded }).stop).toBe(true);
  });

  it("does not stop a publish that removes nothing, or has no baseline entries", () => {
    expect(assessRemovals({ before: paths(3), removed: [], dropped: [], excluded: nothingExcluded }).stop).toBe(false);
    expect(assessRemovals({ before: [], removed: [], dropped: [], excluded: nothingExcluded }).stop).toBe(false);
  });

  it("does not stop one removal of two entries (half)", () => {
    expect(assessRemovals({ before: ["a.md", "b.md"], removed: ["a.md"], dropped: [], excluded: nothingExcluded }).stop).toBe(false);
  });
});

describe("assessRemovals: removals caused by the exclusion list", () => {
  const before = ["a.md", "b.md", ".obsidian/app.json", ".obsidian/core.json", ".obsidian/x.json"];
  const exclusion = [".obsidian/app.json", ".obsidian/core.json", ".obsidian/x.json"];

  it("lists them apart and counts them in neither numerator nor denominator", () => {
    const result = assessRemovals({ before, removed: exclusion, dropped: [], excluded: underObsidian });
    expect(result).toMatchObject({ stop: false, exclusionDriven: exclusion, others: [], remaining: 2 });
  });

  it("stops when the two remaining notes go as well, and counts them against the two remaining entries", () => {
    const result = assessRemovals({ before, removed: [...exclusion, "a.md", "b.md"], dropped: [], excluded: underObsidian });
    expect(result).toMatchObject({ stop: true, others: ["a.md", "b.md"], remaining: 2 });
    expect(result.exclusionDriven).toEqual(exclusion);
  });

  it("treats a carried entry that the exclusion list drops as exclusion-driven, and an unsafe dropped entry as outside the count", () => {
    const result = assessRemovals({
      before: ["a.md", "b.md", "c.md", ".obsidian/app.json", "x/../y.md"],
      removed: [],
      dropped: [
        { path: ".obsidian/app.json", reason: "excluded by this device's exclusion list" },
        { path: "x/../y.md", reason: "unsafe path (dot segment)" },
      ],
      excluded: underObsidian,
    });
    expect(result).toMatchObject({ stop: false, exclusionDriven: [".obsidian/app.json"], others: [], remaining: 3 });
  });
});

describe("assessRemovals: carried entries", () => {
  it("counts a carried CON.md as kept: two of five removals proceed", () => {
    const before = ["CON.md", "a.md", "b.md", "c.md", "d.md"];
    const result = assessRemovals({ before, removed: ["a.md", "b.md"], dropped: [], excluded: nothingExcluded });
    expect(result).toMatchObject({ stop: false, remaining: 5 });
  });
});
