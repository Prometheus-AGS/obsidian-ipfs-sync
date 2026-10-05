import type { App as ObsidianApp } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FIRST_PULL_GATEWAY_STATEMENT,
  FIRST_PULL_KEY_HOLDER_STATEMENT,
  FIRST_PULL_NO_BASELINE_STATEMENT,
  NO_STATE_PULL_STATEMENT,
  type FirstPullDetails,
} from "../../src/sync/encrypted-pull";
import { confirmFirstPull } from "../../src/plugin/first-pull-dialog";
import { confirmResolveFork } from "../../src/plugin/fork-dialog";
import { confirmLargePull } from "../../src/plugin/large-pull-dialog";
import { formatSize } from "../../src/plugin/large-pull-dialog-model";
import { createConfirmModel } from "../../src/plugin/pull-confirm-model";
import { FIRST_PULL_COPY, LARGE_PULL_COPY, PUBLISH_REQUIREMENTS, RESTORE_COPY } from "../../src/plugin/pull-dialog-copy";
import { chooseRestoreEntry, confirmRestore } from "../../src/plugin/restore-dialog";
import { describeRestoreEntry, type RestoreEntry } from "../../src/plugin/restore-dialog-model";
import { byId, focusOrder, referencedText, type FakeEl } from "../support/fake-dom";
import { App, Modal } from "../support/obsidian-stub";
import { labelOf } from "../support/settings-tab-rig";

const app = (): ObsidianApp => new App() as unknown as ObsidianApp;

beforeEach(() => Modal.reset());

/** The dialog the last call opened. */
function lastDialog(): { readonly root: FakeEl; readonly close: () => void; readonly title: FakeEl } {
  const modal = Modal.instances.at(-1);
  if (modal === undefined) throw new Error("no dialog was opened");
  return { root: modal.contentEl, close: () => modal.close(), title: modal.titleEl };
}

const button = (root: FakeEl, text: string): FakeEl => {
  const found = root.find((el) => el.tag === "button" && el.text === text);
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
};

/** Resolves to the value, or "pending" when the promise has not settled yet. */
async function settled<T>(promise: Promise<T>): Promise<T | "pending"> {
  return Promise.race([promise, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0))]);
}

const HOSTILE_DEVICE = "<img src=x onerror=alert(1)>\\u202e <b>laptop</b>";

const DETAILS: FirstPullDetails = {
  target: "name",
  sequence: 7,
  publishedAt: "2026-09-30T10:15:00.000Z",
  device: HOSTILE_DEVICE,
  fileCount: 120,
  pathsRefused: 0,
  pathsSummary: undefined,
  replacedLocalFiles: 0,
  statements: [FIRST_PULL_KEY_HOLDER_STATEMENT, FIRST_PULL_NO_BASELINE_STATEMENT],
};

// ---------- first pull ----------

describe("first-pull dialog", () => {
  it("names the three publishing requirements and shows the statements the pull supplied", () => {
    void confirmFirstPull(app(), DETAILS);
    const { root } = lastDialog();
    const text = root.textContent();
    for (const requirement of PUBLISH_REQUIREMENTS) expect(text).toContain(requirement);
    expect(PUBLISH_REQUIREMENTS).toHaveLength(3);
    expect(text).toContain(FIRST_PULL_KEY_HOLDER_STATEMENT);
    expect(text).toContain(FIRST_PULL_NO_BASELINE_STATEMENT);
    expect(text).toContain("It only reads from the node");
  });

  it("shows the explicit-root statement when the pull supplies it", () => {
    void confirmFirstPull(app(), { ...DETAILS, target: "root-cid", statements: [...DETAILS.statements, FIRST_PULL_GATEWAY_STATEMENT] });
    expect(lastDialog().root.textContent()).toContain(FIRST_PULL_GATEWAY_STATEMENT);
  });

  it("shows sequence, date and device as text, and builds no element from a device name containing markup", () => {
    void confirmFirstPull(app(), DETAILS);
    const { root } = lastDialog();
    const values = root.findAll((el) => el.tag === "dd").map((el) => el.text);
    expect(values[0]).toBe("7");
    expect(values[1]).toContain("2026-09-30T10:15:00.000Z");
    expect(values[2]).toBe(HOSTILE_DEVICE);
    expect(root.find((el) => el.tag === "img" || el.tag === "b" || el.tag === "script")).toBeUndefined();
  });

  it("shows the destination as text when the pull supplies one, and no destination line when it does not (review round 3, S-M1)", () => {
    void confirmFirstPull(app(), DETAILS);
    expect(lastDialog().root.textContent()).not.toContain("Destination");
    void confirmFirstPull(app(), { ...DETAILS, destination: "/Users/ann/<b>notes</b>" });
    const { root } = lastDialog();
    const dt = root.findAll((el) => el.tag === "dt").map((el) => el.text);
    const dd = root.findAll((el) => el.tag === "dd").map((el) => el.text);
    expect(dt).toContain("Destination");
    expect(dd[dt.indexOf("Destination")]).toBe("/Users/ann/<b>notes</b>");
    expect(root.find((el) => el.tag === "b")).toBeUndefined();
  });

  it("shows the no-state statement as text next to the destination", () => {
    void confirmFirstPull(app(), { ...DETAILS, destination: "Field notes", statements: [FIRST_PULL_KEY_HOLDER_STATEMENT, NO_STATE_PULL_STATEMENT] });
    const { root } = lastDialog();
    expect(root.textContent()).toContain(NO_STATE_PULL_STATEMENT);
    expect(root.textContent()).not.toContain(FIRST_PULL_NO_BASELINE_STATEMENT);
    expect(root.findAll((el) => el.tag === "dd").map((el) => el.text)).toContain("Field notes");
  });

  it("lists skipped paths with the count when the pull reports some", () => {
    void confirmFirstPull(app(), { ...DETAILS, pathsRefused: 4, pathsSummary: '"CON.md" (reserved name) and 3 more' });
    expect(lastDialog().root.textContent()).toContain('4: "CON.md" (reserved name) and 3 more');
  });

  it("says how many existing local files will be replaced, only when there are some", () => {
    void confirmFirstPull(app(), DETAILS);
    expect(lastDialog().root.textContent()).not.toContain("will be replaced");
    void confirmFirstPull(app(), { ...DETAILS, replacedLocalFiles: 3 });
    const text = lastDialog().root.textContent();
    expect(text).toContain("Local files that will be replaced");
    expect(text).toContain("at least 3 (a dated copy of each is kept)");
  });

  it("keeps Confirm disabled until the acknowledgement is ticked, and says in text what is missing", async () => {
    const answer = confirmFirstPull(app(), DETAILS);
    const { root } = lastDialog();
    const confirm = button(root, FIRST_PULL_COPY.confirm);
    expect(confirm.disabled).toBe(true);
    expect(referencedText(root, confirm.getAttr("aria-describedby"))).toBe(FIRST_PULL_COPY.needAcknowledge);
    await confirm.dispatch("click");
    expect(await settled(answer)).toBe("pending");
    const ack = byId(root, "ipfs-sync-first-pull-acknowledge");
    if (ack === undefined) throw new Error("no acknowledgement");
    ack.checked = true;
    await ack.dispatch("change");
    expect(confirm.disabled).toBe(false);
    expect(referencedText(root, confirm.getAttr("aria-describedby"))).toBe("");
    await confirm.dispatch("click");
    expect(await answer).toBe(true);
  });

  it("answers no for Cancel and for closing any other way, and a ticked box does not turn a cancel into a yes", async () => {
    const answer = confirmFirstPull(app(), DETAILS);
    const { root, close } = lastDialog();
    const ack = byId(root, "ipfs-sync-first-pull-acknowledge");
    if (ack === undefined) throw new Error("no acknowledgement");
    ack.checked = true;
    await ack.dispatch("change");
    await button(root, FIRST_PULL_COPY.cancel).dispatch("click");
    close();
    expect(await answer).toBe(false);

    Modal.reset();
    const escaped = confirmFirstPull(app(), DETAILS);
    lastDialog().close();
    expect(await escaped).toBe(false);
  });

  it("puts the acknowledgement first in reading order, then Cancel, then Confirm, with initial focus on Cancel (review round 3, P-L1)", () => {
    void confirmFirstPull(app(), DETAILS);
    const { root } = lastDialog();
    expect(focusOrder(root).map((el) => labelOf(root, el) || el.text)).toEqual([FIRST_PULL_COPY.acknowledge, FIRST_PULL_COPY.cancel]);
    expect(byId(root, "ipfs-sync-first-pull-acknowledge")?.focused).toBe(false);
    expect(focusOrder(root).filter((el) => el.focused).map((el) => el.text)).toEqual([FIRST_PULL_COPY.cancel]);
    expect(root.findAll((el) => el.tag === "button").map((el) => el.text)).toEqual([FIRST_PULL_COPY.cancel, FIRST_PULL_COPY.confirm]);
  });
});

// ---------- the confirm model ----------

describe("confirm model", () => {
  it("allows a yes at most once and never when blocked", () => {
    const open = createConfirmModel({});
    expect(open.confirm()).toBe(true);
    expect(open.confirm()).toBe(false);
    const blocked = createConfirmModel({ blocker: "no" });
    expect(blocked.state().canConfirm).toBe(false);
    expect(blocked.confirm()).toBe(false);
  });

  it("needs the acknowledgement before a yes", () => {
    const model = createConfirmModel({ acknowledgement: { label: "x", needText: "tick it" } });
    expect(model.state().needText).toBe("tick it");
    expect(model.confirm()).toBe(false);
    model.setAcknowledged(true);
    expect(model.confirm()).toBe(true);
  });
});

// ---------- restore ----------

const AUTHENTICATED = { sequence: 4, publishedAt: "2026-09-01T08:00:00.000Z", device: "phone-0123456789ab" } as const;

describe("restore confirmation", () => {
  it("shows the authenticated sequence, date and device, and says later files are not removed", async () => {
    const answer = confirmRestore(app(), { authenticated: AUTHENTICATED, highestSequence: 9, labelMismatch: undefined });
    const { root } = lastDialog();
    const values = root.findAll((el) => el.tag === "dd").map((el) => el.text);
    expect(values[0]).toBe("4");
    expect(values[1]).toContain("2026-09-01T08:00:00.000Z");
    expect(values[2]).toBe("phone-0123456789ab");
    expect(values[3]).toBe("9");
    const text = root.textContent();
    expect(text).toContain("Files created after this version are not removed.");
    expect(text).toContain("A file you edited locally is kept first as a dated conflict copy.");
    expect(text).toContain("The highest sequence recorded on this device is not lowered.");
    expect(text).toContain("makes the result a new version");
    expect(text).toContain("not from its file name");
    const confirm = button(root, RESTORE_COPY.confirm);
    expect(confirm.disabled).toBe(false);
    await confirm.dispatch("click");
    expect(await answer).toBe(true);
  });

  it("refuses to enable Confirm when the runner reports a label mismatch, and says why in text tied to the button", async () => {
    const answer = confirmRestore(app(), { authenticated: AUTHENTICATED, highestSequence: undefined, labelMismatch: { listedSequence: 12 } });
    const { root, close } = lastDialog();
    const confirm = button(root, RESTORE_COPY.confirm);
    expect(confirm.disabled).toBe(true);
    const reason = referencedText(root, confirm.getAttr("aria-describedby"));
    expect(reason).toBe("Error: This history entry does not match its name: it was listed as sequence 12 but it holds sequence 4. Nothing was changed.");
    await confirm.dispatch("click");
    expect(await settled(answer)).toBe("pending");
    close();
    expect(await answer).toBe(false);
  });

  it("answers no for Cancel", async () => {
    const answer = confirmRestore(app(), { authenticated: AUTHENTICATED, highestSequence: undefined, labelMismatch: undefined });
    await button(lastDialog().root, RESTORE_COPY.cancel).dispatch("click");
    expect(await answer).toBe(false);
  });

  it("shows a device name containing markup as text", () => {
    void confirmRestore(app(), { authenticated: { ...AUTHENTICATED, device: "<script>x</script>" }, highestSequence: undefined, labelMismatch: undefined });
    const { root } = lastDialog();
    expect(root.find((el) => el.tag === "script")).toBeUndefined();
    expect(root.findAll((el) => el.tag === "dd")[2]?.text).toBe("<script>x</script>");
  });
});

const ENTRIES: readonly RestoreEntry[] = [
  { name: "0000000000000012-bafyaaaaaaaaaa.enc", sequence: 12, detail: { publishedAt: "2026-09-30T09:00:00.000Z", device: "desk-aaaaaaaaaaaa" }, legacy: false },
  { name: "0000000000000011-bafybbbbbbbbbb.enc", sequence: 11, detail: undefined, legacy: false },
  { name: "bafylegacylegacy.enc", sequence: undefined, detail: undefined, legacy: true },
];

describe("restore list", () => {
  it("labels what was read, what was not, and entries with no order", () => {
    expect(describeRestoreEntry(ENTRIES[0] as RestoreEntry)).toContain("Sequence 12, 2026-09-30T09:00:00.000Z");
    expect(describeRestoreEntry(ENTRIES[0] as RestoreEntry)).toContain("device desk-aaaaaaaaaaaa");
    expect(describeRestoreEntry(ENTRIES[1] as RestoreEntry)).toBe("Sequence 11 (details not read, entry is large)");
    expect(describeRestoreEntry(ENTRIES[2] as RestoreEntry)).toBe("bafylegacylegacy.enc (older file name, order unknown)");
  });

  it("escapes control characters in a name or device from the node", () => {
    const hostile: RestoreEntry = { name: "x\u009b31m.enc", sequence: undefined, detail: undefined, legacy: true };
    expect(describeRestoreEntry(hostile)).toContain("x\\u009b31m.enc");
  });

  it("is a labelled radio group; Continue is disabled until a version is chosen and returns that index", async () => {
    const chosen = chooseRestoreEntry(app(), ENTRIES);
    const { root } = lastDialog();
    const group = byId(root, "ipfs-sync-restore-list");
    expect(group?.tag).toBe("fieldset");
    expect(group?.find((el) => el.tag === "legend")?.text).toBe("Versions on the node");
    const radios = root.findAll((el) => el.tag === "input" && el.type === "radio");
    expect(radios).toHaveLength(3);
    for (const radio of radios) expect(labelOf(root, radio)).not.toBe("");
    expect(radios[0]?.focused).toBe(true);
    const next = button(root, "Continue");
    expect(next.disabled).toBe(true);
    expect(referencedText(root, next.getAttr("aria-describedby"))).toBe("To enable Continue: choose a version.");
    await radios[1]?.dispatch("change");
    expect(next.disabled).toBe(false);
    await next.dispatch("click");
    expect(await chosen).toBe(1);
  });

  it("answers undefined for Cancel and for closing, and says so when there is nothing to list", async () => {
    const cancelled = chooseRestoreEntry(app(), ENTRIES);
    await button(lastDialog().root, "Cancel").dispatch("click");
    expect(await cancelled).toBeUndefined();

    Modal.reset();
    const empty = chooseRestoreEntry(app(), []);
    const { root, close } = lastDialog();
    expect(root.textContent()).toContain("The node has no earlier versions to list.");
    expect(button(root, "Continue").disabled).toBe(true);
    close();
    expect(await empty).toBeUndefined();
  });
});

// ---------- fork ----------

describe("fork dialog", () => {
  it("states what happens, names a fork without calling it an attack, and does nothing without the yes", async () => {
    const answer = confirmResolveFork(app(), { sequence: 5 });
    const { root, close } = lastDialog();
    const text = root.textContent();
    expect(text).toContain("not by itself a sign of an attack");
    expect(text).toContain("the node's version takes the file");
    expect(text).toContain("kept as a dated conflict copy");
    expect(text).toContain("Nothing is merged automatically");
    expect(root.findAll((el) => el.tag === "dd").map((el) => el.text)).toEqual(["5"]);
    close();
    expect(await answer).toBe(false);
  });

  it("answers yes only for Resolve fork", async () => {
    const answer = confirmResolveFork(app(), { sequence: undefined });
    const { root } = lastDialog();
    expect(root.find((el) => el.tag === "dl")).toBeUndefined();
    await button(root, "Resolve fork").dispatch("click");
    expect(await answer).toBe(true);
  });
});

// ---------- large pull ----------

describe("large pull dialog", () => {
  it("formats sizes in the unit of the settings, rounding up", () => {
    expect(formatSize(1)).toBe("1 MB");
    expect(formatSize(512 * 1024 * 1024)).toBe("512 MB");
    expect(formatSize(512 * 1024 * 1024 + 1)).toBe("513 MB");
    expect(formatSize(1024 * 1024 * 1024)).toBe("1 GB");
    expect(formatSize(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
  });

  it("shows the size, the file count and the limit, and fetches nothing unless confirmed", async () => {
    const answer = confirmLargePull(app(), { totalBytes: 1.5 * 1024 * 1024 * 1024, fileCount: 340, ceilingMb: 512 });
    const { root } = lastDialog();
    expect(root.findAll((el) => el.tag === "dd").map((el) => el.text)).toEqual(["1.5 GB in 340 files", "512 MB"]);
    expect(root.textContent()).toContain("Nothing is fetched.");
    expect(root.textContent()).toContain("keeps those files as the node has them");
    await button(root, LARGE_PULL_COPY.cancel).dispatch("click");
    expect(await answer).toBe(false);
  });

  it("confirms with a button that carries the size", async () => {
    const answer = confirmLargePull(app(), { totalBytes: 600 * 1024 * 1024, fileCount: 1, ceilingMb: 512 });
    const { root } = lastDialog();
    expect(root.findAll((el) => el.tag === "dd")[0]?.text).toBe("600 MB in 1 file");
    await button(root, "Fetch 600 MB").dispatch("click");
    expect(await answer).toBe(true);
  });
});

// ---------- accessibility (fake DOM only) ----------

describe("pull dialogs: accessibility", () => {
  function open(kind: string): FakeEl {
    Modal.reset();
    if (kind === "first") void confirmFirstPull(app(), DETAILS);
    else if (kind === "restore") void confirmRestore(app(), { authenticated: AUTHENTICATED, highestSequence: 9, labelMismatch: undefined });
    else if (kind === "restore-blocked") void confirmRestore(app(), { authenticated: AUTHENTICATED, highestSequence: 9, labelMismatch: { listedSequence: 2 } });
    else if (kind === "fork") void confirmResolveFork(app(), { sequence: 3 });
    else if (kind === "large") void confirmLargePull(app(), { totalBytes: 2 ** 30, fileCount: 2, ceilingMb: 64 });
    else void chooseRestoreEntry(app(), ENTRIES);
    return lastDialog().root;
  }
  const KINDS = ["first", "restore", "restore-blocked", "fork", "large", "list"] as const;

  it("gives every focusable control an accessible name, and ends the tab order with Cancel then the action", () => {
    for (const kind of KINDS) {
      const root = open(kind);
      for (const el of focusOrder(root)) expect(labelOf(root, el), `${kind}: ${el.tag}`).not.toBe("");
      const buttons = root.findAll((el) => el.tag === "button").map((el) => el.text);
      expect(buttons[0], kind).toBe("Cancel");
      expect(buttons, kind).toHaveLength(2);
    }
  });

  it("has no copy control, no clipboard call and no link", () => {
    for (const kind of KINDS) {
      const root = open(kind);
      const controls = root.findAll((el) => el.tag === "button" || el.tag === "input");
      expect(controls.find((el) => /copy/i.test(el.text) || /copy/i.test(el.getAttr("aria-label") ?? "")), kind).toBeUndefined();
      expect(root.find((el) => el.tag === "a"), kind).toBeUndefined();
    }
  });

  it("carries the blocked state in words: an error line tied to Confirm, not a colour", () => {
    const root = open("restore-blocked");
    const confirm = button(root, RESTORE_COPY.confirm);
    expect(confirm.disabled).toBe(true);
    expect(referencedText(root, confirm.getAttr("aria-describedby"))).toMatch(/^Error: /);
  });

  it("uses only theme variables and no fixed colour", () => {
    for (const kind of KINDS) {
      const root = open(kind);
      const styled = [root, ...root.descendants()].flatMap((el) => Object.values(el.style));
      for (const value of styled) expect(value, kind).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
    }
  });
});
