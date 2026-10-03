import { describe, expect, it } from "vitest";
import type { MfsEntry } from "../../src/kubo";
import { HISTORY_REFUSE_AT, HISTORY_WARN_AT, assessHistoryCount, junkNames, sortHistory, type HistoryView } from "../../src/sync/history-check";
import { historyFileName } from "../../src/sync/history-names";

const cidAt = (index: number): string => `b${index.toString(32).padStart(58, "w")}`;
const prefixed = (index: number): MfsEntry => ({ name: historyFileName(index + 1, cidAt(index)), type: "file", size: 1, cid: "x" });
const legacy = (index: number): MfsEntry => ({ name: `${cidAt(index)}.enc`, type: "file", size: 1, cid: "x" });
const view = (entries: readonly MfsEntry[]): HistoryView => ({ entries, overflow: false });

describe("the pre-publish look at manifests/", () => {
  it("accepts prefixed only, legacy only and mixed folders and finds no junk", () => {
    expect(junkNames(view([prefixed(1), prefixed(2)]))).toEqual([]);
    expect(junkNames(view([legacy(1), legacy(2)]))).toEqual([]);
    expect(junkNames(view([legacy(1), prefixed(2)]))).toEqual([]);
  });

  it("still names junk: a bad name, a bad prefix, a directory with a history-shaped name", () => {
    const folder: MfsEntry = { ...prefixed(9), type: "directory" };
    const junk = junkNames(view([prefixed(1), { name: "x", type: "file", size: 1, cid: "x" }, { name: `12-${cidAt(3)}.enc`, type: "file", size: 1, cid: "x" }, folder]));
    expect(junk).toEqual([folder.name, "x", `12-${cidAt(3)}.enc`].sort());
  });

  it("sortHistory puts legacy names first and prefixed names in sequence order, whatever the listing order", () => {
    const entries = [prefixed(30), legacy(2), prefixed(4), legacy(1), prefixed(12)];
    const sorted = sortHistory(view(entries)).map((entry) => entry.name);
    expect(sorted).toEqual([legacy(1), legacy(2), prefixed(4), prefixed(12), prefixed(30)].map((entry) => entry.name));
  });

  it("keeps its limits with prefixed names: silent at 1,499, a warning at 1,500, a refusal at 1,999 and at 2,000", () => {
    const folder = (count: number, make: (index: number) => MfsEntry): HistoryView => view(Array.from({ length: count }, (_, index) => make(index)));
    expect(HISTORY_WARN_AT).toBe(1_500);
    expect(HISTORY_REFUSE_AT).toBe(1_999);
    expect(assessHistoryCount(folder(1499, prefixed))).toBeUndefined();
    expect(assessHistoryCount(folder(1500, prefixed))).toContain("1500");
    expect(() => assessHistoryCount(folder(1998, prefixed))).not.toThrow();
    for (const count of [1999, 2000]) expect(() => assessHistoryCount(folder(count, prefixed))).toThrowError(/1,999|prune-history/);
    expect(() => assessHistoryCount(folder(1999, (index) => (index % 2 === 0 ? legacy(index) : prefixed(index))))).toThrow();
    expect(() => assessHistoryCount({ entries: [], overflow: true })).toThrow();
  });
});
