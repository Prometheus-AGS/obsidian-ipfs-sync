import { describe, expect, it } from "vitest";
import type { PluginSettings } from "../../src/plugin/settings-model";
import { byId, focusOrder, referencedText, type FakeEl } from "../support/fake-dom";
import { controlFor, flush, labelOf, open, OWNED_ID, type } from "../support/settings-tab-rig";

const PULL_LABELS = ["Pull IPNS name", "Ask before pulling more than (MB)", "Catch up on load", "Read cap (MB)"] as const;
const PEER_NAME = "k51peerpeerpeerpeer";

const describedText = (root: FakeEl, label: string): string => referencedText(root, controlFor(root, label).getAttr("aria-describedby"));

async function toggle(root: FakeEl, label: string, on: boolean): Promise<void> {
  const box = controlFor(root, label);
  box.checked = on;
  await box.dispatch("change");
  await flush();
}

describe("settings tab: pull section", () => {
  it("adds a labelled, described control for each new field, after the owned keys and in reading order", async () => {
    const { root } = await open();
    const labels = focusOrder(root).map((el) => labelOf(root, el));
    expect(labels.slice(-4)).toEqual([...PULL_LABELS]);
    for (const label of PULL_LABELS) {
      expect(controlFor(root, label).getAttr("aria-describedby"), label).toContain("ipfs-sync-error-");
      expect(describedText(root, label), label).not.toBe("");
    }
    for (const title of ["Pull", "Memory", "Last activity"]) {
      const heading = root.find((el) => el.tag === "div" && el.getAttr("role") === "heading" && el.text === title);
      expect(heading, title).toBeDefined();
    }
  });

  it("shows the owned key's ID as the name that will be pulled, beside the empty pull name", async () => {
    const { root } = await open({ ownedKeys: [OWNED_ID] });
    const input = controlFor(root, "Pull IPNS name");
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("empty: your publication key");
    expect(input.style["width"]).toBe("100%");
    expect(byId(root, "ipfs-sync-pull-target")?.text).toContain(OWNED_ID);
    expect(describedText(root, "Pull IPNS name")).toContain(`The name that will be pulled: ${OWNED_ID}`);
  });

  it("says when no name is available", async () => {
    const { root } = await open();
    expect(byId(root, "ipfs-sync-pull-target")?.text).toContain("No name is available to pull from");
  });

  it("saves a valid pull name, drops the /ipns/ prefix, and updates the target line", async () => {
    const { root, store } = await open({ ownedKeys: [OWNED_ID] });
    await type(root, "Pull IPNS name", `/ipns/${PEER_NAME}`);
    expect(store.get().pullName).toBe(PEER_NAME);
    expect(byId(root, "ipfs-sync-pull-target")?.text).toContain(`${PEER_NAME} (from the pull name setting)`);
    expect(describedText(root, "Pull IPNS name")).not.toContain("Error:");
  });

  it("refuses a name with spaces: text error tied to the field, invalid mark, previous value kept", async () => {
    const { root, store } = await open({ pullName: PEER_NAME });
    await type(root, "Pull IPNS name", "two words");
    const input = controlFor(root, "Pull IPNS name");
    expect(describedText(root, "Pull IPNS name")).toMatch(/Error: The pull name must be a single IPNS key ID.*no spaces\./);
    expect(input.getAttr("aria-invalid")).toBe("true");
    expect(store.get().pullName).toBe(PEER_NAME);
    await type(root, "Pull IPNS name", PEER_NAME);
    expect(describedText(root, "Pull IPNS name")).not.toContain("Error:");
    expect(input.getAttr("aria-invalid")).toBeNull();
  });
});

describe("settings tab: catch-up toggle", () => {
  it("is a switch, off by default, that says it is per device and no longer says it is fixture-only", async () => {
    const { root, store } = await open();
    const box = controlFor(root, "Catch up on load");
    expect(box.type).toBe("checkbox");
    expect(box.getAttr("role")).toBe("switch");
    expect(box.checked).toBe(false);
    expect(store.get().catchUpOnLoad).toBe(false);
    const text = describedText(root, "Catch up on load");
    expect(text).toContain("per-device");
    expect(text).not.toContain(".ipfs-sync-fixture");
    expect(text).not.toContain("fixture");
  });

  it("saves true and false, and shows the stored state when reopened", async () => {
    const { root, store, tab } = await open();
    await toggle(root, "Catch up on load", true);
    expect(store.get().catchUpOnLoad).toBe(true);
    tab.display();
    expect(controlFor(root, "Catch up on load").checked).toBe(true);
    await toggle(root, "Catch up on load", false);
    expect(store.get().catchUpOnLoad).toBe(false);
  });
});

describe("settings tab: read cap", () => {
  it("shows the stored cap, the range and the effect of a file above it, in words", async () => {
    const { root } = await open({ maxReadMb: 128 });
    const input = controlFor(root, "Read cap (MB)");
    expect(input.value).toBe("128");
    expect(input.getAttr("inputmode")).toBe("numeric");
    const text = describedText(root, "Read cap (MB)");
    expect(text).toContain("from 8 to 1024");
    expect(text).toContain("publish skips it");
    expect(text).toContain("pull counts it as failed");
  });

  it("refuses 4 with the allowed range, keeps the stored value, and accepts 8", async () => {
    const { root, store } = await open();
    await type(root, "Read cap (MB)", "4");
    expect(describedText(root, "Read cap (MB)")).toMatch(/Error: The read cap must be a whole number of megabytes from 8 to 1024\./);
    expect(controlFor(root, "Read cap (MB)").getAttr("aria-invalid")).toBe("true");
    expect(store.get().maxReadMb).toBe(64);
    await type(root, "Read cap (MB)", "8");
    expect(store.get().maxReadMb).toBe(8);
    expect(describedText(root, "Read cap (MB)")).not.toContain("Error:");
  });
});

describe("settings tab: last activity", () => {
  it("says so in words when nothing has run", async () => {
    const { root } = await open();
    expect(byId(root, "ipfs-sync-last-publish")?.text).toBe("No publish has run on this device yet.");
    expect(byId(root, "ipfs-sync-last-pull")?.text).toBe("No pull has run on this device yet.");
  });

  it("renders stored summaries as counts, time and a shortened root, with visible names", async () => {
    const patch: Partial<PluginSettings> = {
      lastPublish: { at: "2026-09-30T10:05:00Z", written: 3, removed: 1, skipped: 2, rootCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" },
      lastPull: { at: "2026-09-30T11:00:00Z", fetched: 4, unchanged: 9, conflicts: 1, failed: 0, remoteDeleted: 2, rootCid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", manifestCid: "bafyother" },
    };
    const { root } = await open(patch);
    const publish = byId(root, "ipfs-sync-last-publish")?.text ?? "";
    const pull = byId(root, "ipfs-sync-last-pull")?.text ?? "";
    expect(publish).toContain("3 written, 1 removed, 2 skipped (over the read cap)");
    expect(publish).toContain("Root bafybeigdyrzt5sf…");
    expect(pull).toContain("4 fetched, 9 unchanged, 1 conflicts, 0 failed, 2 remote deletions kept");
    const names = root.findAll((el) => el.hasClass("setting-item-name")).map((el) => el.text);
    expect(names).toEqual(expect.arrayContaining(["Name that will be pulled", "Last publish", "Last pull"]));
    // Read-only text: no control is added for the summaries.
    expect(focusOrder(root).some((el) => /Last (publish|pull)/.test(labelOf(root, el)))).toBe(false);
  });
});
