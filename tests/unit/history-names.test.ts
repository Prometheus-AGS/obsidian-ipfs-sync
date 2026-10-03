import { describe, expect, it } from "vitest";
import { compareHistoryNames, entriesAtSequence, historyFileName, isHistoryName, isLegacyHistoryName, parseHistoryName, prefixMatchesSequence, sortHistoryNames } from "../../src/sync/history-names";

const CID = `bafy${"a".repeat(55)}`;
const OTHER = `bafy${"b".repeat(55)}`;

describe("history names", () => {
  it("writes the sequence zero-padded to 16 digits before the CID", () => {
    expect(historyFileName(5, CID)).toBe(`0000000000000005-${CID}.enc`);
    expect(historyFileName(Number.MAX_SAFE_INTEGER, CID)).toBe(`9007199254740991-${CID}.enc`);
    expect(historyFileName(Number.MAX_SAFE_INTEGER, CID)).toHaveLength(16 + 1 + CID.length + 4);
  });

  it("refuses a sequence that is not a positive safe integer and a CID that is not a path segment", () => {
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) expect(() => historyFileName(bad, CID)).toThrow(RangeError);
    for (const bad of ["", "short", "a/b".padEnd(20, "x"), `${CID}.enc`, "a".repeat(129)]) expect(() => historyFileName(1, bad)).toThrow(RangeError);
  });

  it("parses prefixed and legacy names and rejects everything else", () => {
    expect(parseHistoryName(`0000000000000012-${CID}.enc`)).toEqual({ name: `0000000000000012-${CID}.enc`, cid: CID, sequence: 12 });
    expect(parseHistoryName(`${CID}.enc`)).toEqual({ name: `${CID}.enc`, cid: CID, sequence: undefined });
    expect(isLegacyHistoryName(`${CID}.enc`)).toBe(true);
    expect(isLegacyHistoryName(`0000000000000012-${CID}.enc`)).toBe(false);
    for (const junk of ["x", "notes.txt", `${CID}.txt`, `123-${CID}.enc`, `00000000000000012-${CID}.enc`, `000000000000001x-${CID}.enc`, "0000000000000012-.enc", `0000000000000012-short.enc`, `0000000000000000-${CID}.enc`, `9999999999999999-${CID}.enc`, `0000000000000012-${CID}.enc.enc`, `../${CID}.enc`, ""]) {
      expect(isHistoryName(junk), junk).toBe(false);
    }
  });

  it("orders legacy names first, then prefixed names by sequence, and sorting the names equals sorting the numbers", () => {
    const names = [`0000000000000010-${CID}.enc`, `${OTHER}.enc`, `0000000000000002-${OTHER}.enc`, `${CID}.enc`, `0000000000000009-${CID}.enc`, `0000000000000002-${CID}.enc`];
    const ordered = sortHistoryNames(names).map((entry) => entry.name);
    expect(ordered).toEqual([`${CID}.enc`, `${OTHER}.enc`, `0000000000000002-${CID}.enc`, `0000000000000002-${OTHER}.enc`, `0000000000000009-${CID}.enc`, `0000000000000010-${CID}.enc`]);
    const prefixed = ordered.filter((name) => !isLegacyHistoryName(name));
    expect([...prefixed].sort()).toEqual(prefixed);
  });

  it("leaves names that are not history names out of the order", () => {
    expect(sortHistoryNames(["x", `${CID}.enc`, "notes.txt"]).map((entry) => entry.name)).toEqual([`${CID}.enc`]);
  });

  it("compares equal names as equal and is antisymmetric", () => {
    const a = parseHistoryName(`0000000000000003-${CID}.enc`);
    const b = parseHistoryName(`${CID}.enc`);
    if (a === undefined || b === undefined) throw new Error("fixture");
    expect(compareHistoryNames(a, a)).toBe(0);
    expect(compareHistoryNames(b, b)).toBe(0);
    expect(compareHistoryNames(a, b)).toBeGreaterThan(0);
    expect(compareHistoryNames(b, a)).toBeLessThan(0);
  });

  it("finds the entries that carry a sequence prefix, never a legacy name or junk (the fork ancestor lookup)", () => {
    const names = [`0000000000000004-${CID}.enc`, `0000000000000004-${OTHER}.enc`, `0000000000000005-${CID}.enc`, `${CID}.enc`, "notes.txt", `0000000000000000-${CID}.enc`];
    expect(entriesAtSequence(names, 4).map((entry) => entry.name)).toEqual([`0000000000000004-${CID}.enc`, `0000000000000004-${OTHER}.enc`]);
    expect(entriesAtSequence(names, 5).map((entry) => entry.cid)).toEqual([CID]);
    expect(entriesAtSequence(names, 6)).toEqual([]);
    expect(entriesAtSequence(names, 0)).toEqual([]);
    expect(entriesAtSequence([`${CID}.enc`], 1)).toEqual([]);
  });

  it("a prefix must equal the manifest's sequence; a legacy name makes no claim", () => {
    const prefixed = parseHistoryName(`0000000000000007-${CID}.enc`);
    const legacy = parseHistoryName(`${CID}.enc`);
    if (prefixed === undefined || legacy === undefined) throw new Error("fixture");
    expect(prefixMatchesSequence(prefixed, 7)).toBe(true);
    expect(prefixMatchesSequence(prefixed, 8)).toBe(false);
    expect(prefixMatchesSequence(legacy, 8)).toBe(true);
  });
});
