// G-10: untrustedPathReason lives in a pure module; these tests pin the specification's path list.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STATE_FOLDER, untrustedPathReason } from "../../src/sync/manifest-paths";
import * as fromPullPlan from "../../src/sync/pull-plan";

describe("untrusted path rules (manifest-v2 spec, 'Untrusted path rules')", () => {
  const refused: readonly [string, string][] = [
    ["", "empty path"],
    ["/a", "absolute path"],
    ["C:/a", "absolute path"],
    ["c:relative", "absolute path"],
    ["a\\b", "backslash in path"],
    ["a/../b", "empty, . or .. path segment"],
    ["a//b", "empty, . or .. path segment"],
    ["./a", "empty, . or .. path segment"],
    ["a/./b", "empty, . or .. path segment"],
    ["a/", "empty, . or .. path segment"],
    ["..", "empty, . or .. path segment"],
    ["\u0007bell", "control character in path"],
    ["a\u0000b", "control character in path"],
    ["a\u001fb", "control character in path"],
    ["a\u007fb", "control character in path"],
    [".IPFS-SYNC/x", `inside the ${STATE_FOLDER} state folder`],
    [".ipfs-sync", `inside the ${STATE_FOLDER} state folder`],
    [".Ipfs-Sync/state.json", `inside the ${STATE_FOLDER} state folder`],
  ];
  for (const [path, reason] of refused) {
    it(`refuses ${JSON.stringify(path)} (${reason})`, () => expect(untrustedPathReason(path)).toBe(reason));
  }

  it("accepts ordinary paths, including dots inside names, later segments named like the state folder, and non-ASCII", () => {
    for (const path of ["notes/daily/2026-01-01.md", "a.md", "a/.hidden", "a/b.c/d", "x/.ipfs-sync/y", ".ipfs-syncx/a", "\u00e9t\u00e9/caf\u00e9.md", "a b/c d.md", "__proto__", "1:/a", "dd:/a"]) {
      expect(untrustedPathReason(path), path).toBeUndefined();
    }
  });

  it("pull-plan re-exports the same function and constant (no behaviour change)", () => {
    expect(fromPullPlan.untrustedPathReason).toBe(untrustedPathReason);
    expect(fromPullPlan.STATE_FOLDER).toBe(STATE_FOLDER);
  });

  it("the encrypted manifest module no longer imports pull-plan, and manifest-paths.ts imports nothing", () => {
    const codec = readFileSync(new URL("../../src/sync/encrypted-manifest.ts", import.meta.url), "utf8");
    expect(codec).not.toMatch(/pull-plan/);
    expect(codec).toMatch(/from "\.\/manifest-paths"/);
    const paths = readFileSync(new URL("../../src/sync/manifest-paths.ts", import.meta.url), "utf8");
    expect(paths).not.toMatch(/^\s*import\s/m);
  });
});
