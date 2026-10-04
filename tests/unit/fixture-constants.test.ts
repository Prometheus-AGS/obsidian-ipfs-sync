// mvp-07b task 3.2: the three marker values live in one import-free module that a plain `node` run can load,
// and the publish guard re-exports exactly those values.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as constants from "../../src/sync/fixture-constants";
import * as publishGuard from "../../src/sync/publish-guard";

describe("fixture-constants", () => {
  it("holds the marker file name and the two marker words unchanged", () => {
    expect(constants.FIXTURE_MARKER).toBe(".ipfs-sync-fixture");
    expect(constants.FIXTURE_MARKER_VALUE).toBe("fixture");
    expect(constants.PULLED_MARKER_VALUE).toBe("pulled-fixture");
  });

  it("has no imports, so the fixture generator loads it without the build", async () => {
    const source = await readFile(new URL("../../src/sync/fixture-constants.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it("is re-exported by the publish guard", () => {
    expect(publishGuard.FIXTURE_MARKER).toBe(constants.FIXTURE_MARKER);
    expect(publishGuard.FIXTURE_MARKER_VALUE).toBe(constants.FIXTURE_MARKER_VALUE);
    expect(publishGuard.PULLED_MARKER_VALUE).toBe(constants.PULLED_MARKER_VALUE);
  });
});
