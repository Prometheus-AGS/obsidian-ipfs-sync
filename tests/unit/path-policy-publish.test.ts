// mvp-07a task 3.1b: the publisher's side of the path policy. The decoder still accepts CON.md, the publisher warns and publishes,
// and the call sites of untrustedPathReason are the ones the decoder and the planners already had.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { STATE_FOLDER, untrustedPathReason } from "../../src/sync/manifest-paths";
import { buildRootState, readRootState, writeRootState } from "../../src/sync/root-state";
import { ROOT, createRig } from "../helpers/publish-rig";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("the decoder's rule is unchanged", () => {
  it("untrustedPathReason still accepts the names only the pull policy refuses", () => {
    for (const path of ["CON.md", "com¹.txt", "a./b.md", "file::$DATA", "OBSIDI~1/x", "GIT~1/x", "abc~1.md", "Note.md", "notes/ipfs-sync.md"]) {
      expect(untrustedPathReason(path), path).toBeUndefined();
    }
  });

  it("and still refuses what it refused", () => {
    expect(untrustedPathReason("../x")).toBeDefined();
    expect(untrustedPathReason(".IPFS-SYNC/x")).toBe(`inside the ${STATE_FOLDER} state folder`);
    expect(untrustedPathReason("a\u0001b")).toBeDefined();
  });

  it("only these files call it (the call sites recorded before this task)", () => {
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts") && readFileSync(full, "utf8").includes("untrustedPathReason(")) callers.push(relative(repoRoot, full));
      }
    };
    walk(join(repoRoot, "src"));
    walk(join(repoRoot, "cli"));
    expect(callers.sort()).toEqual([
      "src/sync/encrypted-manifest.ts",
      "src/sync/idle-check.ts",
      "src/sync/local-manifest.ts",
      "src/sync/manifest-paths.ts",
      "src/sync/publish-plan.ts",
      "src/sync/pull-plan.ts",
    ]);
  });
});

describe("publish: the advisory warns and never refuses", () => {
  it("publishes a vault with CON.md, warns that other devices will not restore it, and the manifest decodes with it", async () => {
    const rig = createRig();
    rig.host.put("CON.md", "reserved on Windows", 1000);
    rig.host.put("note.md", "ordinary", 1000);
    await rig.init();

    const result = await rig.publish();

    expect(result.published).toBe(true);
    expect(result.written).toBe(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('"CON.md"');
    expect(result.warnings[0]).toContain("will not be restored");
    expect(result.warnings[0]).not.toContain("note.md");
    // The publisher's own decoder reads the manifest back with CON.md in it.
    expect(Object.keys((await rig.manifest()).files).sort()).toEqual(["CON.md", "note.md"]);
  });

  it("names three paths and counts the rest, and escapes a control character", async () => {
    const rig = createRig();
    for (const path of ["CON.md", "PRN.md", "AUX.md", "NUL.md", "a\u009bb.md"]) rig.host.put(path, path, 1000);
    rig.host.put("fine.md", "x", 1000);
    await rig.init();

    const result = await rig.publish();

    expect(result.published).toBe(true);
    const [line] = result.warnings;
    expect(line).toContain("5 path(s)");
    expect(line).toContain("and 2 more");
    expect(/[\u009b]/.test(line!)).toBe(false);
  });

  it("no warning for ordinary names, including .gitignore, notes/ipfs-sync.md and abc~1.md", async () => {
    const rig = createRig();
    for (const path of [".gitignore", "notes/ipfs-sync.md", "abc~1.md", "Note.md"]) rig.host.put(path, path, 1000);
    await rig.init();

    const result = await rig.publish();

    expect(result.published).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("a Note.md and note.md pair that the Linux vault holds is published, with a warning", async () => {
    const rig = createRig();
    rig.host.put("Note.md", "a", 1000);
    rig.host.put("note.md", "b", 1000);
    await rig.init();

    const result = await rig.publish();

    expect(result.published).toBe(true);
    expect(result.warnings[0]).toContain("2 path(s)");
  });

  it("an idle republish (nothing changed) returns before the plan, publishes nothing and does not repeat the warning", async () => {
    const rig = createRig();
    rig.host.put("CON.md", "x", 1000);
    await rig.init();
    await rig.publish();

    const again = await rig.publish();

    expect(again.published).toBe(false);
    expect(again.warnings).toEqual([]);
  });

  it("a publish with other work after a first publish warns again for the unchanged CON.md", async () => {
    const rig = createRig();
    rig.host.put("CON.md", "x", 1000);
    rig.host.put("note.md", "y", 1000);
    await rig.init();
    await rig.publish();
    rig.host.put("note.md", "edited", 2000);

    const again = await rig.publish();

    expect(again.published).toBe(true);
    expect(again.warnings.some((warning) => warning.includes('"CON.md"'))).toBe(true);
  });

  it("a carried path this device could not restore is not advised again", async () => {
    const rig = createRig();
    rig.host.put("CON.md", "x", 1000);
    rig.host.put("note.md", "y", 1000);
    await rig.init();
    await rig.publish();
    const state = await readRootState(rig.host.kv, ROOT);
    if (state === undefined) throw new Error("state expected");
    await writeRootState(rig.host.kv, buildRootState({ ...state, unmaterialized: ["CON.md"], complete: false }));
    rig.host.drop("CON.md");
    rig.host.put("note.md", "edited elsewhere", 2000);

    const result = await rig.publish();

    expect(result.published).toBe(true);
    expect(result.carried).toEqual(["CON.md"]);
    expect(result.warnings).toEqual([]);
    expect(Object.keys((await rig.manifest()).files).sort()).toEqual(["CON.md", "note.md"]);
  });
});
