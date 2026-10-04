import { describe, expect, it } from "vitest";
import { KDF_ITERATIONS_DEFAULT, KDF_MEMORY_DEFAULT_KIB, KDF_PARALLELISM, type KdfParams } from "../../src/crypto";
import { KEY_DIALOG_COPY, PRUNE_HISTORY_COPY as COPY } from "../../src/plugin/encryption-copy";
import { createPruneHistoryModel, type PruneHistoryModel, type PruneReview } from "../../src/plugin/prune-history-dialog-model";
import { HISTORY_KEEP_FLOOR } from "../../src/sync/prune-history";
import { PRUNE_KEEPS_STATEMENT, PRUNE_RESTORE_STATEMENT } from "../../src/sync/prune-history-text";

const STANDARD: KdfParams = { m: KDF_MEMORY_DEFAULT_KIB, t: KDF_ITERATIONS_DEFAULT, p: KDF_PARALLELISM };
const OK = "ABCDE-FGHIJ-KLMNO-PQRST-UVWX2";
const check = (text: string) => (text.replaceAll("-", "").length === 25 ? undefined : ("wrong-length" as const));

const REVIEW: PruneReview = {
  removing: 1_500,
  keeping: 100,
  total: 1_600,
  statements: ["Prune history: 1500 of the 1600 history files in manifests/ on the node would be removed from its working tree; 100 stay.", PRUNE_KEEPS_STATEMENT],
};

function model(): PruneHistoryModel {
  return createPruneHistoryModel({ cost: STANDARD, check });
}

/** A form that is ready to preview. */
function ready(keep = "100"): PruneHistoryModel {
  const m = model();
  m.setKeep(keep);
  m.setCurrent(OK);
  return m;
}

describe("prune-history dialog model: the form", () => {
  it("shows the floor from the engine, the one-derivation statement and the statements about what a prune keeps, before anything is typed", () => {
    const state = model().state();
    expect(state.floor).toBe(HISTORY_KEEP_FLOOR);
    expect(state.phase).toBe("form");
    const text = state.statements.join("\n");
    expect(text).toContain("one key derivation");
    expect(text).toContain("64 MiB");
    expect(text).toContain("Removing does not derive again");
    expect(state.statements).toContain(PRUNE_KEEPS_STATEMENT);
    expect(state.statements).toContain(PRUNE_RESTORE_STATEMENT);
    expect(COPY.keepDesc).toContain(String(HISTORY_KEEP_FLOOR));
  });

  it("keeps the preview disabled until a count to keep and a well formed current passphrase are given, and says which is missing", () => {
    const m = model();
    expect(m.state()).toMatchObject({ canPreview: false, missing: ["keep", "current"] });
    expect(m.state().requirementsText).toContain(COPY.needKeep);
    expect(m.state().requirementsText).toContain(KEY_DIALOG_COPY.needCurrent);
    m.setKeep("100");
    expect(m.state()).toMatchObject({ canPreview: false, missing: ["current"] });
    m.setCurrent(OK);
    expect(m.state()).toMatchObject({ canPreview: true, missing: [], requirementsText: "" });
    m.setKeep("");
    expect(m.state().canPreview).toBe(false);
  });

  it.each(["0", "-5", "1.5", "abc", "1e3", " ", "1234567890", "٣"])("refuses %j as a count to keep, with a text error only once the field is left", (text) => {
    const m = model();
    m.setCurrent(OK);
    m.setKeep(text);
    expect(m.state().canPreview).toBe(false);
    if (text.trim() === "") return;
    expect(m.state().keep).toMatchObject({ status: "invalid", error: undefined });
    m.touchKeep();
    expect(m.state().keep.error).toBe(COPY.keepInvalid);
  });

  it("raises a count under the floor and says so, in words", () => {
    const m = ready("5");
    expect(m.state().keep).toMatchObject({ status: "ok", value: 5, effective: HISTORY_KEEP_FLOOR });
    expect(m.state().keep.note).toContain(`${HISTORY_KEEP_FLOOR}`);
    expect(m.state().canPreview).toBe(true);
    m.setKeep("100");
    expect(m.state().keep).toMatchObject({ value: 100, effective: 100, note: undefined });
  });

  it("starts with the focus on the count, and never on a button that removes anything", () => {
    expect(model().state().initialFocus).toBe("keep");
  });

  it("returns the count and empties the passphrase entry when the preview begins, once", () => {
    const m = ready("40");
    expect(m.beginPreview()).toEqual({ keep: 40 });
    expect(m.state()).toMatchObject({ phase: "previewing", busy: true, canPreview: false });
    expect(m.state().current.status).toBe("empty");
    expect(m.beginPreview()).toBeUndefined();
  });

  it("does not begin a preview while the gating fails", () => {
    expect(model().beginPreview()).toBeUndefined();
    const m = model();
    m.setKeep("40");
    expect(m.beginPreview()).toBeUndefined();
    expect(m.state().phase).toBe("form");
  });

  it("clamps progress to 0..1 while the preview runs and ignores a report that is not a number", () => {
    const m = ready();
    m.beginPreview();
    expect(m.reportProgress(0.4).progress).toBe(0.4);
    expect(m.reportProgress(7).progress).toBe(1);
    expect(m.reportProgress(Number.NaN).progress).toBe(1);
  });
});

describe("prune-history dialog model: the preview settles with the real outcome", () => {
  it("shows the counts and the engine's statements, enables only the remove control, and puts the focus on Cancel", () => {
    const m = ready();
    m.beginPreview();
    const state = m.settlePreview({ ok: true, review: REVIEW });
    expect(state).toMatchObject({ phase: "review", canRemove: true, nothingToPrune: false, initialFocus: "cancel", removeLabel: "Remove 1500 history files" });
    expect(state.review?.statements).toEqual(REVIEW.statements);
    expect(state.question).toContain("Remove these history files");
  });

  it("says there is nothing to prune and offers no remove control when the plan removes nothing", () => {
    const m = ready();
    m.beginPreview();
    const state = m.settlePreview({ ok: true, review: { removing: 0, keeping: 24, total: 24, statements: ["Nothing to prune: manifests/ holds 24 history files and at least 20 are kept. Nothing was changed."] } });
    expect(state).toMatchObject({ phase: "review", canRemove: false, nothingToPrune: true });
    expect(m.beginRemove()).toBe(false);
  });

  it("returns to the form with a text error on the passphrase after a refusal that wrote nothing and a retry can fix", () => {
    const m = ready();
    m.beginPreview();
    const state = m.settlePreview({ ok: false, reason: "That passphrase did not open this vault.", retryable: true });
    expect(state.phase).toBe("form");
    expect(state.current.error).toContain("did not open this vault");
    m.setCurrent(OK);
    expect(m.state().canPreview).toBe(true);
    expect(m.state().keep.value).toBe(100);
  });

  it("stops, with the reason written out and 'nothing was removed', after any other refusal at the preview", () => {
    const m = ready();
    m.beginPreview();
    const state = m.settlePreview({ ok: false, reason: "manifests/ holds a name‮ with a control", retryable: false });
    expect(state).toMatchObject({ phase: "stopped", stoppedAt: "preview", canPreview: false, canRemove: false });
    expect(state.failure).toContain("\\u202e");
    expect(state.failure).not.toContain("‮");
    expect(state.stoppedText).toBe(COPY.stoppedAtPreview);
    expect(COPY.stoppedAtPreview).toContain("Nothing was removed");
  });
});

describe("prune-history dialog model: remove", () => {
  function reviewing(): PruneHistoryModel {
    const m = ready();
    m.beginPreview();
    m.settlePreview({ ok: true, review: REVIEW });
    return m;
  }

  it("begins the removal once and only from a review that removes something", () => {
    const m = reviewing();
    expect(m.beginRemove()).toBe(true);
    expect(m.state()).toMatchObject({ phase: "removing", busy: true, canRemove: false });
    expect(m.beginRemove()).toBe(false);
    expect(model().beginRemove()).toBe(false);
  });

  it("ends as done only when the caller says the removal finished, and reports what it removed", () => {
    const m = reviewing();
    m.beginRemove();
    expect(m.state().phase).toBe("removing");
    const state = m.settleRemove({ ok: true, kind: "pruned", removed: 1_500, kept: 100 });
    expect(state).toMatchObject({ phase: "done", outcome: { kind: "pruned", removed: 1_500, kept: 100 } });
  });

  it("stops, with the node may have changed text, after a failure at the removal; it is never a retry", () => {
    const m = reviewing();
    m.beginRemove();
    const state = m.settleRemove({ ok: false, reason: "the node stopped answering", retryable: false });
    expect(state).toMatchObject({ phase: "stopped", stoppedAt: "remove", canRemove: false, canPreview: false });
    expect(state.stoppedText).toBe(COPY.stoppedAtRemove);
    expect(COPY.stoppedAtRemove).toContain("may already have changed");
    expect(COPY.stoppedAtRemove).toContain("ipfs-sync prune-history");
  });

  it("goes back to the review, with the reason, for a failure the caller says wrote nothing and can be retried", () => {
    const m = reviewing();
    m.beginRemove();
    const state = m.settleRemove({ ok: false, reason: "another operation holds the lock", retryable: true });
    expect(state).toMatchObject({ phase: "review", canRemove: true });
    expect(state.failure).toContain("another operation");
  });

  it("never counts the progress of a removal as a derivation", () => {
    const m = reviewing();
    m.beginRemove();
    expect(m.reportProgress(0.5).progress).toBeUndefined();
  });
});
