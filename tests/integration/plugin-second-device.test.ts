// mvp-07a task 6.1: the plugin as the second device, through its pull runner and its publish runner (real engines, the adapter lock file,
// the floor in the plugin data), taking turns with a device that publishes through the library. Nothing here ran in Obsidian.
import { describe, expect, it } from "vitest";
import { SEQUENCE_FLOOR_FILE } from "../../src/sync/sequence-floor";
import { DAILY, PLAN, createDevices, editAndPublish, syncedTexts } from "../helpers/integration-devices";
import { publishFromPlugin } from "../helpers/integration-plugin";
import { pluginOver } from "../helpers/plugin-pull-encrypted-rig";
import { pulledOf } from "../helpers/pull-stage-rig";

describe("the plugin takes turns with another device", () => {
  it("pulls the vault, publishes a note as sequence 2 under its own device identity and floor, and picks up the other device's next edit", async () => {
    const { rig, a } = await createDevices();
    const b = pluginOver(rig);
    expect((await b.pull()).kind).toBe("completed");
    expect(b.dialogs.firstPulls).toHaveLength(1);
    expect(syncedTexts({ texts: b.texts })).toEqual(syncedTexts(a));

    // The documented hand step for a pulled directory, then a note written on the phone.
    b.adapter.put(".ipfs-sync-fixture", "fixture\n");
    b.adapter.put("From the phone.md", "written in the plugin\n", 9000);
    const published = await publishFromPlugin(b);

    expect(published.kind).toBe("published");
    const manifest = await rig.manifest();
    expect(manifest.sequence).toBe(2);
    expect(manifest.device).toMatch(/^obsidian-[0-9a-f]{12}$/);
    expect(Object.keys(manifest.files)).toContain("From the phone.md");
    expect(b.store.get().deviceStore[SEQUENCE_FLOOR_FILE]).toBeDefined();
    expect(b.adapter.files.has(".ipfs-sync/publish.lock")).toBe(false);
    expect(await b.state()).toMatchObject({ sequence: 2, highestSequence: 2, complete: true });
    expect((await b.state())?.devicesSeen).toHaveLength(2);

    // The first device pulls the plugin's publish, edits, publishes; the plugin pulls that.
    pulledOf(await a.pull());
    expect(a.texts()["From the phone.md"]).toBe("written in the plugin\n");
    expect((await editAndPublish(rig, a, { [DAILY]: "A edited the daily note after the phone.\n", [PLAN]: "A rewrote the plan.\n" })).sequence).toBe(3);
    expect((await b.pull()).kind).toBe("completed");
    expect(b.texts()[DAILY]).toBe("A edited the daily note after the phone.\n");
    expect(b.texts()[PLAN]).toBe("A rewrote the plan.\n");
    expect(syncedTexts({ texts: b.texts })).toEqual(syncedTexts(a));
  });

  it("a plugin publish before it pulls a newer sequence is refused with pull first and writes nothing to the node", async () => {
    const { rig, a } = await createDevices();
    const b = pluginOver(rig);
    expect((await b.pull()).kind).toBe("completed");
    b.adapter.put(".ipfs-sync-fixture", "fixture\n");
    await editAndPublish(rig, a, { [DAILY]: "A moved on.\n" });
    b.adapter.put("From the phone.md", "written in the plugin\n", 9000);

    const refused = await publishFromPlugin(b);

    expect(refused.kind).not.toBe("published");
    expect(refused.notice).toContain("pull");
    expect(rig.node.calls.filter((line) => /^(write|rm|pin|publish|keyGen) /.test(line))).toEqual([]);
  });
});
