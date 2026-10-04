import { readFileSync } from "node:fs";
import type { App as ObsidianApp } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KDF_ITERATIONS_DEFAULT, KDF_MEMORY_DEFAULT_KIB, KDF_PARALLELISM, type KdfParams } from "../../src/crypto";
import { KEY_DIALOG_COPY, PRUNE_HISTORY_COPY as COPY } from "../../src/plugin/encryption-copy";
import { PruneHistoryDialog, type PruneHistoryDialogRequest } from "../../src/plugin/prune-history-dialog";
import type { PrunePreviewResult, PruneRemoveResult, PruneReview } from "../../src/plugin/prune-history-dialog-model";
import { PRUNE_KEEPS_STATEMENT } from "../../src/sync/prune-history-text";
import { byId, focusOrder, type FakeEl } from "../support/fake-dom";
import { App, Modal } from "../support/obsidian-stub";
import { flush, labelOf } from "../support/settings-tab-rig";

const STANDARD: KdfParams = { m: KDF_MEMORY_DEFAULT_KIB, t: KDF_ITERATIONS_DEFAULT, p: KDF_PARALLELISM };
const OLD = "KLMNO-PQRST-UVWX2-ABCDE-FGHIJ";
const check = (text: string) => (text.replaceAll("-", "").length === 25 ? undefined : ("wrong-length" as const));
const REVIEW: PruneReview = {
  removing: 1_500,
  keeping: 100,
  total: 1_600,
  statements: ["Prune history: 1500 of the 1600 history files in manifests/ on the node would be removed from its working tree; 100 stay.", PRUNE_KEEPS_STATEMENT],
};

const app = (): ObsidianApp => new App() as unknown as ObsidianApp;
beforeEach(() => Modal.reset());

const content = (dialog: unknown): FakeEl => (dialog as { contentEl: FakeEl }).contentEl;

function must(root: FakeEl, id: string): FakeEl {
  const el = byId(root, id);
  if (el === undefined) throw new Error(`no element ${id}`);
  return el;
}

const button = (root: FakeEl, text: string): FakeEl => {
  const found = root.find((el) => el.tag === "button" && el.text === text);
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
};

const hiddenIn = (el: FakeEl): boolean => {
  for (let node: FakeEl | null = el; node !== null; node = node.parent) if (node.style["display"] === "none") return true;
  return false;
};
const buttons = (root: FakeEl): string[] => root.findAll((el) => el.tag === "button" && !hiddenIn(el)).map((el) => el.text);
const tabOrder = (root: FakeEl): string[] => focusOrder(root).filter((el) => !hiddenIn(el)).map((el) => el.id || el.text);
const focusedNames = (root: FakeEl): string[] => focusOrder(root).filter((el) => el.focused).map((el) => el.id || el.text);

async function type(el: FakeEl, text: string): Promise<void> {
  el.value = text;
  await el.dispatch("input");
}

function openPrune(patch: Partial<Pick<PruneHistoryDialogRequest, "preview" | "remove">> = {}) {
  const finished = vi.fn();
  const preview = vi.fn(patch.preview ?? (async (): Promise<PrunePreviewResult> => ({ ok: true, review: REVIEW })));
  const remove = vi.fn(patch.remove ?? (async (): Promise<PruneRemoveResult> => ({ ok: true, kind: "pruned", removed: 1_500, kept: 100 })));
  const dialog = new PruneHistoryDialog(app(), { cost: STANDARD, check, preview, remove }, finished);
  dialog.open();
  return { dialog, root: content(dialog), finished, preview, remove };
}

async function fill(root: FakeEl, keep = "100"): Promise<void> {
  await type(must(root, "ipfs-sync-prune-keep"), keep);
  await type(must(root, "ipfs-sync-prune-current"), OLD);
}

async function previewed(patch: Partial<Pick<PruneHistoryDialogRequest, "preview" | "remove">> = {}) {
  const rig = openPrune(patch);
  await fill(rig.root);
  await button(rig.root, COPY.previewButton).dispatch("click");
  await flush();
  return rig;
}

describe("prune-history dialog: the form", () => {
  it("asks only for the count to keep and the current passphrase, states the floor and the one derivation, and offers only Cancel and the preview", () => {
    const { root, dialog } = openPrune();
    const text = root.textContent();
    expect((dialog as unknown as { titleEl: FakeEl }).titleEl.text).toBe(COPY.title);
    expect(text).toContain(COPY.keepDesc);
    expect(text).toContain("one key derivation");
    expect(text).toContain("Removing does not derive again");
    expect(buttons(root)).toEqual([KEY_DIALOG_COPY.cancel, COPY.previewButton]);
    expect(button(root, COPY.previewButton).disabled).toBe(true);
    expect(hiddenIn(must(root, "ipfs-sync-prune-review"))).toBe(true);
  });

  it("lands the first focus on the count, and puts every control in reading order with an accessible name", () => {
    const { root } = openPrune();
    expect(focusedNames(root)).toEqual(["ipfs-sync-prune-keep"]);
    // The preview is disabled until the gating holds, so a keyboard user does not tab to it yet.
    expect(tabOrder(root)).toEqual(["ipfs-sync-prune-keep", "ipfs-sync-prune-current", "ipfs-sync-prune-current-reveal", KEY_DIALOG_COPY.cancel]);
    for (const el of focusOrder(root)) expect(labelOf(root, el) || el.text, `${el.id} has no accessible name`).not.toBe("");
  });

  it("makes the count a numeric field with a visible label and the floor stated, not a free text field", () => {
    const { root } = openPrune();
    const keep = must(root, "ipfs-sync-prune-keep");
    expect(keep.type).toBe("number");
    expect(keep.getAttr("min")).toBe("1");
    expect(keep.getAttr("inputmode")).toBe("numeric");
    expect(labelOf(root, keep)).toBe(COPY.keepName);
  });

  it("keeps the preview disabled and says what is missing, then runs once with the count and the passphrase, and empties the passphrase field", async () => {
    const { root, preview } = openPrune();
    expect(must(root, "ipfs-sync-prune-requirements").textContent()).toContain(COPY.needKeep);
    await fill(root, "40");
    expect(must(root, "ipfs-sync-prune-requirements").textContent()).toBe("");
    await button(root, COPY.previewButton).dispatch("click");
    await flush();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0]?.[0]).toEqual({ keep: 40, passphrase: OLD });
    expect(must(root, "ipfs-sync-prune-current").value).toBe("");
  });

  it("does nothing for Enter before the gating holds, and previews on Enter once it does", async () => {
    const { root, preview } = openPrune();
    await must(root, "ipfs-sync-prune-current").dispatch("keydown", { key: "Enter" });
    expect(preview).not.toHaveBeenCalled();
    await fill(root);
    await must(root, "ipfs-sync-prune-current").dispatch("keydown", { key: "Enter" });
    await flush();
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("says in words that a count under the floor is raised", async () => {
    const { root } = openPrune();
    await type(must(root, "ipfs-sync-prune-keep"), "5");
    expect(must(root, "ipfs-sync-prune-keep-note").textContent()).toContain("20");
  });

  it("shows a text error on the count only after the field is left", async () => {
    const { root } = openPrune();
    const keep = must(root, "ipfs-sync-prune-keep");
    await type(keep, "0");
    expect(must(root, "ipfs-sync-prune-keep-error").textContent()).toBe("");
    await keep.dispatch("change");
    expect(must(root, "ipfs-sync-prune-keep-error").textContent()).toBe(`Error: ${COPY.keepInvalid}`);
    expect(keep.getAttr("aria-invalid")).toBe("true");
  });
});

describe("prune-history dialog: the preview (a dry run) and the consequence step", () => {
  it("shows the counts as sentences, hides the form, names the question, and moves the focus to Cancel, which comes first", async () => {
    const { root } = await previewed();
    const review = must(root, "ipfs-sync-prune-review");
    expect(hiddenIn(review)).toBe(false);
    expect(review.textContent()).toContain("1500 of the 1600 history files");
    expect(must(root, "ipfs-sync-prune-question").textContent()).toContain("Remove these history files");
    expect(hiddenIn(must(root, "ipfs-sync-prune-current"))).toBe(true);
    expect(buttons(root)).toEqual([KEY_DIALOG_COPY.cancel, "Remove 1500 history files"]);
    expect(focusedNames(root)).toEqual([KEY_DIALOG_COPY.cancel]);
    expect(tabOrder(root).indexOf(KEY_DIALOG_COPY.cancel)).toBeLessThan(tabOrder(root).indexOf("Remove 1500 history files"));
    expect(button(root, "Remove 1500 history files").getAttr("aria-describedby")).toContain("ipfs-sync-prune-question");
  });

  it("removes only after the explicit press, once, and ends done with the counts in words", async () => {
    const { root, remove, dialog, finished } = await previewed();
    expect(remove).not.toHaveBeenCalled();
    await button(root, "Remove 1500 history files").dispatch("click");
    await flush();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(must(root, "ipfs-sync-prune-result").textContent()).toContain("1500");
    expect(buttons(root)).toEqual([KEY_DIALOG_COPY.close]);
    dialog.close();
    expect(finished).toHaveBeenCalledWith("done");
  });

  it("cancel after the preview never removes: it is a cancelled end", async () => {
    const { root, remove, finished } = await previewed();
    await button(root, KEY_DIALOG_COPY.cancel).dispatch("click");
    expect(remove).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith("cancelled");
  });

  it("closing the window after the preview, or twice, is a cancel and never a removal", async () => {
    const { dialog, remove, finished } = await previewed();
    dialog.close();
    dialog.close();
    expect(remove).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledWith("cancelled");
  });

  it("says nothing needs pruning and offers only Close when the plan removes nothing", async () => {
    const empty: PruneReview = { removing: 0, keeping: 24, total: 24, statements: ["Nothing to prune: manifests/ holds 24 history files and at least 20 are kept. Nothing was changed."] };
    const { root, remove } = await previewed({ preview: async () => ({ ok: true, review: empty }) });
    expect(must(root, "ipfs-sync-prune-review").textContent()).toContain("Nothing to prune");
    expect(buttons(root)).toEqual([KEY_DIALOG_COPY.close]);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("prune-history dialog: the real outcome", () => {
  it("returns to the form with a text error on the passphrase after a retryable refusal, keeping the count", async () => {
    const { root, finished } = await previewed({ preview: async () => ({ ok: false, reason: "Wrong passphrase.", retryable: true }) });
    expect(must(root, "ipfs-sync-prune-current-error").text).toBe("Error: Wrong passphrase.");
    expect(must(root, "ipfs-sync-prune-keep").value).toBe("100");
    expect(finished).not.toHaveBeenCalled();
    // The fake DOM never blurs, so the count's earlier focus is still recorded; what matters is that the passphrase field took it back.
    expect(focusedNames(root)).toContain("ipfs-sync-prune-current");
    expect(focusedNames(root)).not.toContain(KEY_DIALOG_COPY.cancel);
  });

  it("stops at a refusal that cannot be retried, says nothing was removed, and renders node text with control and bidirectional characters written out", async () => {
    const { root, dialog, finished } = await previewed({ preview: async () => ({ ok: false, reason: "manifests/ holds ‮a name", retryable: false }) });
    const failure = must(root, "ipfs-sync-prune-failure").textContent();
    expect(failure).toContain("\\u202e");
    expect(failure).not.toContain("‮");
    expect(must(root, "ipfs-sync-prune-result").textContent()).toContain(COPY.stoppedAtPreview);
    expect(buttons(root)).toEqual([KEY_DIALOG_COPY.close]);
    dialog.close();
    expect(finished).toHaveBeenCalledWith("stopped");
  });

  it("stops after a failure at the removal with the 'may already have changed' text", async () => {
    const { root } = await previewed({ remove: async () => ({ ok: false, reason: "the node stopped answering", retryable: false }) });
    await button(root, "Remove 1500 history files").dispatch("click");
    await flush();
    expect(must(root, "ipfs-sync-prune-result").textContent()).toContain(COPY.stoppedAtRemove);
    expect(must(root, "ipfs-sync-prune-failure").textContent()).toContain("the node stopped answering");
    expect(buttons(root)).toEqual([KEY_DIALOG_COPY.close]);
  });

  it("treats a thrown error as a stop with fixed text, never the error's message", async () => {
    const { root } = await previewed({
      preview: async () => {
        throw new Error("secret detail from the node");
      },
    });
    expect(root.textContent()).not.toContain("secret detail");
    expect(must(root, "ipfs-sync-prune-failure").textContent()).toContain("unexpected error");
  });

  it("reports progress in text while the preview runs", async () => {
    let report: (fraction: number) => void = () => undefined;
    let settle: (result: PrunePreviewResult) => void = () => undefined;
    const { root } = openPrune({
      preview: (_input, onProgress) => {
        report = onProgress;
        return new Promise<PrunePreviewResult>((resolve) => {
          settle = resolve;
        });
      },
    });
    await fill(root);
    await button(root, COPY.previewButton).dispatch("click");
    report(0.5);
    expect(must(root, "ipfs-sync-prune-progress-text").textContent()).toContain("50 percent");
    expect(button(root, KEY_DIALOG_COPY.cancel).disabled).toBe(true);
    settle({ ok: true, review: REVIEW });
    await flush();
    expect(must(root, "ipfs-sync-prune-progress-text").textContent()).toBe("");
  });

  it("reports the real end when the window is closed while a removal goes", async () => {
    let settle: (result: PruneRemoveResult) => void = () => undefined;
    const { root, dialog, finished } = await previewed({ remove: () => new Promise<PruneRemoveResult>((resolve) => (settle = resolve)) });
    await button(root, "Remove 1500 history files").dispatch("click");
    dialog.close();
    expect(finished).not.toHaveBeenCalled();
    settle({ ok: true, kind: "pruned", removed: 1_500, kept: 100 });
    await flush();
    expect(finished).toHaveBeenCalledWith("done");
  });
});

describe("prune-history dialog: source hygiene", () => {
  const source = (name: string): string => readFileSync(new URL(`../../src/plugin/${name}`, import.meta.url), "utf8");

  it.each(["prune-history-dialog.ts", "prune-history-dialog-model.ts"])("%s writes no HTML, touches no clipboard and imports no Node module", (name) => {
    const text = source(name);
    expect(text).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|createEl\(\s*["']script|document\.write|\.clipboard|execCommand/);
    expect(text).not.toMatch(/from\s+["'](node:|fs|path|os|crypto|child_process|buffer|stream|util)["']/);
  });

  it("has no copy control", async () => {
    const { root } = await previewed();
    expect(root.findAll((el) => ["button", "a", "input"].includes(el.tag) && /copy|clipboard/i.test(`${el.text} ${el.title}`))).toEqual([]);
  });
});
