// mvp-07a final review B1-01 (depth, length and segment caps; no quadratic prefix building), B1-02 (linear group handling) and
// B1-05 (display escape of default-ignorable and format characters). Invisible characters are built from code points.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExclusionMatcher } from "../../src/sync/exclusions";
import { ManifestFormatError, createFilesMap, decodeManifestFile, serializeManifestV2 } from "../../src/sync/encrypted-manifest";
import { PATH_LIMITS, pathLimitViolation } from "../../src/sync/path-limits";
import { createPullExclusionMatcher, escapeForDisplay, evaluatePathPolicy, refusePath } from "../../src/sync/path-policy";
import { entryFor, keysFrom, manifestFor, refusal, seal } from "../vectors/manifest-helpers";

const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

afterEach(() => vi.restoreAllMocks());

describe("path limits (B1-01)", () => {
  it("names the three limits in one place", () => {
    expect(PATH_LIMITS).toEqual({ maxPathBytes: 4096, maxSegmentBytes: 255, maxSegments: 128 });
  });

  it("accepts a path of exactly 4096 bytes and refuses 4097", () => {
    const exact = [..."x".repeat(15).split("").map(() => "m".repeat(255)), "x".repeat(128), "y".repeat(127)].join("/");
    expect(new TextEncoder().encode(exact).length).toBe(4096);
    expect(refusePath(exact)).toBeUndefined();
    const over = refusePath(`${exact}z`);
    expect(over).toMatchObject({ severity: "unsafe", class: "shape", code: "path-too-long" });
  });

  it("measures a segment in UTF-8 bytes: 255 pass, 256 are refused", () => {
    expect(refusePath(`d/${"é".repeat(127)}x`)).toBeUndefined();
    expect(refusePath(`d/${"é".repeat(128)}`)).toMatchObject({ code: "segment-too-long", class: "shape" });
    expect(refusePath(`d/${"n".repeat(255)}`)).toBeUndefined();
    expect(refusePath(`d/${"n".repeat(256)}`)).toMatchObject({ code: "segment-too-long" });
  });

  it("allows 128 segments and refuses 129", () => {
    expect(refusePath(Array.from({ length: 128 }, () => "a").join("/"))).toBeUndefined();
    expect(refusePath(Array.from({ length: 129 }, () => "a").join("/"))).toMatchObject({ code: "too-many-segments", class: "shape" });
  });

  it("the reasons are fixed strings that never echo the path", () => {
    const hostile = `${"s".repeat(300)}/secret-name`;
    expect(refusePath(hostile)?.reason).not.toContain("secret-name");
  });

  it("refuses a path of a million segments by shape, without per-segment work", () => {
    const huge = `${"a/".repeat(1_000_000)}a`;
    expect(pathLimitViolation(huge)).toBe("path-too-long");
    const started = performance.now();
    const verdict = evaluatePathPolicy([huge]);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(verdict.accepted).toEqual([]);
    expect(verdict.refusals).toHaveLength(1);
    expect(verdict.refusals[0]).toMatchObject({ severity: "unsafe", class: "shape", code: "path-too-long" });
  });

  it("the check precedes the control-character and dot-segment scans", () => {
    expect(refusePath(`${"a/".repeat(3000)}\u0001`)).toMatchObject({ code: "path-too-long" });
    expect(refusePath(`${"a/".repeat(200)}..`)).toMatchObject({ code: "too-many-segments" });
  });
});

describe("exclusion matchers build no prefix per segment (B1-01)", () => {
  const long = `${"a/".repeat(100_000)}.git/x`;

  it.each([
    ["pull matcher", () => createPullExclusionMatcher()],
    ["publisher matcher", () => createExclusionMatcher()],
  ])("%s: 100,000 segments, no slice per segment, same answer", (_name, make) => {
    const matcher = make();
    // A counting wrapper, not a spy: a spy would keep every returned copy alive and exhaust memory on the quadratic code it detects.
    const original = Array.prototype.slice;
    let calls = 0;
    Array.prototype.slice = function counted(this: unknown[], ...args: [number?, number?]): unknown[] {
      calls += 1;
      return original.apply(this, args);
    };
    let answer: boolean;
    const started = performance.now();
    try {
      answer = matcher(long);
    } finally {
      Array.prototype.slice = original;
    }
    const elapsed = performance.now() - started;
    expect(answer).toBe(true);
    expect(calls).toBeLessThan(100);
    expect(elapsed).toBeLessThan(20_000);
  });

  it.each([
    ["pull matcher", (extra: readonly string[]) => createPullExclusionMatcher(extra)],
    ["publisher matcher", (extra: readonly string[]) => createExclusionMatcher(extra)],
  ])("%s: anchored rules still match only at the vault root", (_name, make) => {
    const matcher = make(["private/deep", "top/sub/"]);
    expect(matcher("private/deep/n.md")).toBe(true);
    expect(matcher("private/deep")).toBe(true);
    expect(matcher("x/private/deep/n.md")).toBe(false);
    expect(matcher("top/sub/a")).toBe(true);
    expect(matcher("top/sub")).toBe(false);
    expect(matcher("top/sub", true)).toBe(true);
    expect(matcher("x/top/sub/a")).toBe(false);
    expect(matcher(`${"a/".repeat(5000)}private/deep`)).toBe(false);
  });
});

describe("manifest decoder caps (B1-01)", () => {
  it("refuses a path over 4096 bytes before any per-segment work, naming no path", async () => {
    const keys = await keysFrom(1, 2);
    const path = `${"a/".repeat(3000)}a`;
    const files = createFilesMap([[path, await entryFor(keys, path)]]);
    const text = new TextDecoder().decode(serializeManifestV2({ ...(await manifestFor(keys, [])), files }));
    const error = await refusal(decodeManifestFile(keys, await seal(keys, text)));
    expect(error).toBeInstanceOf(ManifestFormatError);
    expect((error as ManifestFormatError).field).toBe("path");
    expect(error.message).not.toContain("a/a/a");
  });

  it("refuses 129 segments and a 256-byte segment, and accepts the limits", async () => {
    const keys = await keysFrom(1, 2);
    const decode = async (path: string): Promise<unknown> => {
      const files = createFilesMap([[path, await entryFor(keys, path)]]);
      const text = new TextDecoder().decode(serializeManifestV2({ ...(await manifestFor(keys, [])), files }));
      return decodeManifestFile(keys, await seal(keys, text));
    };
    await expect(decode(Array.from({ length: 128 }, () => "a").join("/"))).resolves.toBeDefined();
    await expect(decode(`d/${"n".repeat(255)}`)).resolves.toBeDefined();
    await expect(decode(Array.from({ length: 129 }, () => "a").join("/"))).rejects.toBeInstanceOf(ManifestFormatError);
    await expect(decode(`d/${"n".repeat(256)}`)).rejects.toBeInstanceOf(ManifestFormatError);
  });
});

describe("group handling is linear and names at most three (B1-02)", () => {
  it("a collision group stores three names and a count", () => {
    const verdict = evaluatePathPolicy(["a.md", "A.md", "A.MD", "a.MD", "ok.md"]);
    expect(verdict.refusals).toHaveLength(4);
    for (const refusal of verdict.refusals) {
      expect(refusal.code).toBe("case-collision");
      expect(refusal.group).toEqual(["A.MD", "A.md", "a.MD"]);
      expect(refusal.groupSize).toBe(4);
      expect(Object.isFrozen(refusal.group)).toBe(true);
    }
  });

  it("a file and its descendants form one group of three names and a count", () => {
    const verdict = evaluatePathPolicy(["a", "a/1", "a/2", "a/3", "a/4", "z"]);
    expect(verdict.refusals.map((refusal) => refusal.path)).toEqual(["a", "a/1", "a/2", "a/3", "a/4"]);
    for (const refusal of verdict.refusals) {
      expect(refusal.code).toBe("file-directory-prefix");
      expect(refusal.group).toEqual(["a", "a/1", "a/2"]);
      expect(refusal.groupSize).toBe(5);
    }
  });

  it("100,000 case variants of one name finish and share one group", () => {
    const letters = "abcdefghijklmnopq";
    const variants = Array.from({ length: 100_000 }, (_, mask) => [...letters].map((ch, bit) => (mask & (1 << bit) ? ch.toUpperCase() : ch)).join(""));
    const started = performance.now();
    const verdict = evaluatePathPolicy(variants);
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(verdict.accepted).toEqual([]);
    expect(verdict.refusals).toHaveLength(100_000);
    expect(verdict.refusals[0]!.group).toBe(verdict.refusals[99_999]!.group);
    expect(verdict.refusals[0]!.groupSize).toBe(100_000);
    expect(verdict.refusals[0]!.group).toHaveLength(3);
  }, 120_000);

  it("one file 'a' plus 99,999 files under 'a/' finish and share one group", () => {
    const paths = ["a", ...Array.from({ length: 99_999 }, (_, index) => `a/${index}`)];
    const started = performance.now();
    const verdict = evaluatePathPolicy(paths);
    expect(performance.now() - started).toBeLessThan(30_000);
    expect(verdict.accepted).toEqual([]);
    expect(verdict.refusals).toHaveLength(100_000);
    expect(verdict.refusals[5]!.group).toBe(verdict.refusals[99_000]!.group);
    expect(verdict.refusals[0]!.groupSize).toBe(100_000);
  }, 120_000);
});

describe("display escape of default-ignorable and format characters (B1-05)", () => {
  it.each([
    ["zero width space", cp(0x200b), "\\u200b"],
    ["zero width joiner", cp(0x200d), "\\u200d"],
    ["word joiner", cp(0x2060), "\\u2060"],
    ["byte order mark", cp(0xfeff), "\\ufeff"],
    ["soft hyphen", cp(0x00ad), "\\u00ad"],
    ["variation selector 16", cp(0xfe0f), "\\ufe0f"],
    ["hangul filler", cp(0x3164), "\\u3164"],
    ["tag letter a", cp(0xe0061), "\\u{e0061}"],
    ["variation selector 17", cp(0xe0100), "\\u{e0100}"],
    ["arabic number sign (Cf)", cp(0x0600), "\\u0600"],
  ])("%s is shown escaped", (_name, character, escaped) => {
    expect(escapeForDisplay(`a${character}b`)).toBe(`a${escaped}b`);
  });

  it("a hidden plugin-folder spoof no longer looks like the real name", () => {
    expect(escapeForDisplay(`.ob${cp(0x200d)}sidian/x`)).toBe(".ob\\u200dsidian/x");
  });

  it("leaves ordinary text, accents, emoji and CJK alone, and keeps the existing control escapes", () => {
    expect(escapeForDisplay("naïve 日本 \u{1f600}.md")).toBe("naïve 日本 \u{1f600}.md");
    expect(escapeForDisplay(`x${cp(0x202e)}${cp(0x9b)}${cp(0x0a)}`)).toBe("x\\u202e\\u009b\\u000a");
  });

  it("does not change which paths are refused: a bidi override stays accepted", () => {
    expect(refusePath(`invoice${cp(0x202e)}txt.exe`)).toBeUndefined();
  });
});
