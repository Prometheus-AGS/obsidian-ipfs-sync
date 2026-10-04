import { describe, expect, it } from "vitest";
import { buildRootState, readRootState, writeRootState } from "../../src/sync/root-state";
import { ROOT, createRig, type Rig } from "../helpers/publish-rig";

const MUTATING = /^(write|rm|pin|publish|keyGen) /;

/** A published vault of `names` (each file has its own content), ready for a second publish. */
async function publishedVault(names: readonly string[]): Promise<Rig> {
  const rig = createRig();
  for (const name of names) rig.host.put(name, `content of ${name}`, 1000);
  await rig.init();
  await rig.publish();
  rig.node.calls.length = 0;
  return rig;
}

const ten = Array.from({ length: 10 }, (_, index) => `note-${index}.md`);
const mutations = (rig: Rig): string[] => rig.node.calls.filter((call) => MUTATING.test(call));

describe("publish: the mass-removal guard", () => {
  it("stops an emptied vault directory before any node write, and says an unmounted vault looks the same", async () => {
    const rig = await publishedVault(ten);
    for (const name of ten) rig.host.drop(name);

    const error = await rig.publish().then(() => undefined, (caught: unknown) => caught as Error);

    expect(error).toMatchObject({ name: "PublishRefusedError", code: "mass-removal" });
    expect(error?.message).toContain("10 of 10 entries");
    expect(error?.message).toContain("unmounted");
    expect(mutations(rig)).toEqual([]);
  });

  it("proceeds when 3 of 10 entries go", async () => {
    const rig = await publishedVault(ten);
    for (const name of ten.slice(0, 3)) rig.host.drop(name);
    expect(await rig.publish()).toMatchObject({ published: true, removed: 3 });
  });

  it("proceeds when exactly half goes", async () => {
    const rig = await publishedVault(ten);
    for (const name of ten.slice(0, 5)) rig.host.drop(name);
    expect(await rig.publish()).toMatchObject({ published: true, removed: 5 });
  });

  it("stops when 6 of 10 go, leaving the node untouched", async () => {
    const rig = await publishedVault(ten);
    for (const name of ten.slice(0, 6)) rig.host.drop(name);

    await expect(rig.publish()).rejects.toMatchObject({ code: "mass-removal", message: expect.stringContaining("6 of 10 entries") });
    expect(mutations(rig)).toEqual([]);
  });

  it("stops a one-entry manifest that loses its only file", async () => {
    const rig = await publishedVault(["only.md", "second.md"]);
    rig.host.drop("second.md");
    await rig.publish();
    rig.host.drop("only.md");

    await expect(rig.publish()).rejects.toMatchObject({ code: "mass-removal" });
  });

  it("proceeds when the caller confirmed with the flag", async () => {
    const rig = await publishedVault(ten);
    for (const name of ten.slice(0, 6)) rig.host.drop(name);
    expect(await rig.publish({ allowMassRemoval: true })).toMatchObject({ published: true, removed: 6 });
  });

  it("asks the confirm port with the counts, proceeds on a yes and refuses on a no", async () => {
    const rig = await publishedVault(ten);
    for (const name of ten.slice(0, 6)) rig.host.drop(name);
    const asked: unknown[] = [];

    await expect(rig.publish({ confirmMassRemoval: async (info) => (asked.push(info), false) })).rejects.toMatchObject({ code: "mass-removal" });
    expect(mutations(rig)).toEqual([]);
    expect(await rig.publish({ confirmMassRemoval: async () => true })).toMatchObject({ published: true, removed: 6 });
    expect(asked).toEqual([{ removing: 6, remaining: 10, exclusionDriven: 0 }]);
  });

  it("refuses without any confirm port (the plugin's timer path) and does not open anything", async () => {
    const rig = await publishedVault(ten);
    for (const name of ten.slice(0, 6)) rig.host.drop(name);
    await expect(rig.publish({ confirmMassRemoval: undefined, allowMassRemoval: undefined })).rejects.toMatchObject({ code: "mass-removal" });
    expect(mutations(rig)).toEqual([]);
  });

  it("does not ask or stop on the first publish of a vault", async () => {
    const rig = createRig();
    rig.host.put("a.md", "a", 1000);
    await rig.init();
    let asked = 0;
    expect(await rig.publish({ confirmMassRemoval: async () => (asked += 1, false) })).toMatchObject({ published: true });
    expect(asked).toBe(0);
  });
});

describe("publish: the mass-removal guard and the exclusion list", () => {
  const upgradeDay = ["docs/a.md", "docs/b.md", "docs/c.md", "keep-1.md", "keep-2.md"];

  it("proceeds on upgrade day: three removals caused by the exclusion list are reported and not counted", async () => {
    const rig = await publishedVault(upgradeDay);

    const result = await rig.publish({ extraExclusions: ["docs/"] });

    expect(result).toMatchObject({ published: true, removed: 3, exclusionRemoved: ["docs/a.md", "docs/b.md", "docs/c.md"] });
  });

  it("stops when the same vault also lost both of its notes, counting two against the two remaining and not blaming the exclusion list", async () => {
    const rig = await publishedVault(upgradeDay);
    rig.host.drop("keep-1.md");
    rig.host.drop("keep-2.md");

    const error = await rig.publish({ extraExclusions: ["docs/"] }).then(() => undefined, (caught: unknown) => caught as Error);

    expect(error).toMatchObject({ code: "mass-removal" });
    expect(error?.message).toContain("2 of 2 entries");
    expect(error?.message).not.toMatch(/exclusion list (caused|is the cause|is to blame)/);
    expect(error?.message).toContain("3 more");
    expect(mutations(rig)).toEqual([]);
  });

  it("counts a carried entry as kept: two of five removals proceed", async () => {
    const rig = await publishedVault(["CON.md", "a.md", "b.md", "c.md", "d.md"]);
    const state = await readRootState(rig.host.kv, ROOT);
    if (state === undefined) throw new Error("state expected");
    await writeRootState(rig.host.kv, buildRootState({ ...state, unmaterialized: ["CON.md"], complete: false }));
    rig.host.drop("CON.md");
    rig.host.drop("a.md");
    rig.host.drop("b.md");

    expect(await rig.publish()).toMatchObject({ published: true, removed: 2, carried: ["CON.md"] });
  });
});
