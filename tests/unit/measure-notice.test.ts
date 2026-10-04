import { describe, expect, it } from "vitest";
import { MEASURE_START_NOTICE, groupBuildHash, measurementNoticeText } from "../../src/plugin/measure-notice";

const HASH = "a1b2c3d4e5f60718";

describe("measure notice", () => {
  it("groups the first sixteen hex characters of the build hash in fours", () => {
    expect(groupBuildHash(HASH)).toBe("a1b2 c3d4 e5f6 0718");
    expect(groupBuildHash(HASH.toUpperCase())).toBe("A1B2 C3D4 E5F6 0718");
  });

  it("treats anything else as unavailable", () => {
    expect(groupBuildHash(undefined)).toBeUndefined();
    expect(groupBuildHash("")).toBeUndefined();
    expect(groupBuildHash("a1b2c3d4e5f6071")).toBeUndefined();
    expect(groupBuildHash("a1b2c3d4e5f607189")).toBeUndefined();
    expect(groupBuildHash("a1b2c3d4e5f6071g")).toBeUndefined();
  });

  it("shows seconds, platform, completed, the longest gap and the grouped hash", () => {
    const text = measurementNoticeText({ seconds: 1.1432, platform: "ios", completed: true, longestGapMs: 21, buildHashPrefix: HASH });
    expect(text).toContain("Seconds: 1.14");
    expect(text).toContain("Platform: ios");
    expect(text).toContain("Completed: yes");
    expect(text).toContain("Longest event-loop gap: 21 ms");
    expect(text).toContain("Build hash (first 16 characters): a1b2 c3d4 e5f6 0718");
    expect(text).toContain("64 MiB, 3 iterations");
  });

  it("says the build hash is unavailable when there is none", () => {
    const text = measurementNoticeText({ seconds: 2, platform: "android", completed: true, longestGapMs: 5, buildHashPrefix: undefined });
    expect(text).toContain("Build hash: unavailable");
    expect(text).not.toContain("first 16 characters");
  });

  it("reports an unfinished derivation as not completed", () => {
    const text = measurementNoticeText({ seconds: 0.4, platform: "ios", completed: false, longestGapMs: undefined, buildHashPrefix: HASH });
    expect(text).toContain("Completed: no");
    expect(text).toContain("Longest event-loop gap: not measured");
  });

  it("does not print a non-finite or negative time as a number", () => {
    expect(measurementNoticeText({ seconds: Number.NaN, platform: "x", completed: false, longestGapMs: undefined, buildHashPrefix: undefined })).toContain("Seconds: unknown");
    expect(measurementNoticeText({ seconds: -1, platform: "x", completed: false, longestGapMs: undefined, buildHashPrefix: undefined })).toContain("Seconds: unknown");
  });

  it("escapes control and bidirectional characters in the platform label", () => {
    expect(measurementNoticeText({ seconds: 1, platform: "io‮s", completed: true, longestGapMs: 1, buildHashPrefix: HASH })).toContain("Platform: io\\u202es");
  });

  it("carries no vault data and no passphrase, and tells the user to keep the app open", () => {
    expect(MEASURE_START_NOTICE).toContain("keep the app open");
    expect(MEASURE_START_NOTICE).toContain("no vault data");
  });
});
