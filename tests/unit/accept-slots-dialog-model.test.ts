import { describe, expect, it } from "vitest";
import { createAcceptSlotsModel, type AcceptReview } from "../../src/plugin/accept-slots-dialog-model";
import { ACCEPT_SLOTS_COPY } from "../../src/plugin/encryption-copy";
import type { PassphraseFormatCheck } from "../../src/plugin/unlock-dialog-model";
import type { KdfParams } from "../../src/crypto";
import { ACCEPT_ONE_ROOT_STATEMENT, ACCEPT_RESTORE_STATEMENT } from "../../src/sync/key-management-text";

const PASSPHRASE = "ABCDE-FGHIJ-KLMNO-PQRST-UVWX2";
const COST_64: KdfParams = { m: 65_536, t: 3, p: 1 };
const COST_128: KdfParams = { m: 131_072, t: 4, p: 1 };

const check: PassphraseFormatCheck = (text) => (text.replaceAll("-", "").length === 25 ? undefined : "wrong-length");
const fresh = (target: "name" | "root-cid" = "name") => createAcceptSlotsModel({ target, check });
const review = (patch: Partial<AcceptReview> = {}): AcceptReview => ({ current: COST_64, incoming: COST_64, changes: true, ...patch });

/** A model that has passed the passphrase step and is looking at a review. */
function reviewing(r: AcceptReview) {
  const model = fresh();
  model.setCurrent(PASSPHRASE);
  model.beginCheck();
  model.settleCheck({ ok: true, review: r });
  return model;
}

describe("accept-slots model: the passphrase step", () => {
  it("explains that the passphrase must be the one the other device set, before anything is asked", () => {
    const state = fresh().state();
    expect(state.intro).toContain("the one the other device set");
    expect(state.statements).toContain(ACCEPT_ONE_ROOT_STATEMENT);
    expect(state.phase).toBe("enter");
  });

  it("disables the check until the passphrase is well formed", () => {
    const model = fresh();
    expect(model.state().canCheck).toBe(false);
    expect(model.setCurrent("ABC").canCheck).toBe(false);
    expect(model.touchCurrent().current.error).toBeDefined();
    expect(model.setCurrent(PASSPHRASE).canCheck).toBe(true);
  });

  it("adds the older-root statement only for an explicit root", () => {
    expect(fresh("name").state().statements).not.toContain(ACCEPT_RESTORE_STATEMENT);
    expect(fresh("root-cid").state().statements).toContain(ACCEPT_RESTORE_STATEMENT);
  });

  it("begins the check once and forgets the typed status", () => {
    const model = fresh();
    expect(model.beginCheck()).toBe(false);
    model.setCurrent(PASSPHRASE);
    expect(model.beginCheck()).toBe(true);
    expect(model.beginCheck()).toBe(false);
    expect(model.state().phase).toBe("checking");
    expect(model.state().current.status).toBe("empty");
  });

  it("returns to the passphrase step with a text error on the field when the check refuses", () => {
    const model = fresh();
    model.setCurrent(PASSPHRASE);
    model.beginCheck();
    const state = model.settleCheck({ ok: false, reason: "that passphrase did not open the key slots", retryable: true });
    expect(state.phase).toBe("enter");
    expect(state.current.error).toBe("that passphrase did not open the key slots");
    expect(state.canCheck).toBe(false);
  });

  it("stops after a failure that is not a wrong passphrase", () => {
    const model = fresh();
    model.setCurrent(PASSPHRASE);
    model.beginCheck();
    const state = model.settleCheck({ ok: false, reason: "the root holds no manifest.enc", retryable: false });
    expect(state.phase).toBe("stopped");
    expect(state.failure).toBe("the root holds no manifest.enc");
  });
});

describe("accept-slots model: the review step", () => {
  it("accepts without a confirmation when the incoming slot costs the same", () => {
    const state = reviewing(review()).state();
    expect(state.phase).toBe("review");
    expect(state.costFacts).toEqual([{ label: ACCEPT_SLOTS_COPY.sameCostName, value: "64 MiB, 3 iterations" }]);
    expect(state.canAccept).toBe(true);
    expect(state.needsDowngradeConfirmation).toBe(false);
  });

  it("accepts without a confirmation when the incoming slot costs more, and shows both costs", () => {
    const state = reviewing(review({ incoming: COST_128 })).state();
    expect(state.costFacts.map((f) => f.value)).toEqual(["64 MiB, 3 iterations", "128 MiB, 4 iterations"]);
    expect(state.canAccept).toBe(true);
    expect(state.needsDowngradeConfirmation).toBe(false);
  });

  it("shows both costs and needs a confirmation when the incoming slot is cheaper", () => {
    const model = reviewing(review({ current: COST_128, incoming: COST_64 }));
    const state = model.state();
    expect(state.costFacts.map((f) => f.value)).toEqual(["128 MiB, 4 iterations", "64 MiB, 3 iterations"]);
    expect(state.needsDowngradeConfirmation).toBe(true);
    expect(state.canAccept).toBe(false);
    expect(state.downgradeQuestion).toContain("128 MiB, 4 iterations");
    expect(state.downgradeQuestion).toContain("64 MiB, 3 iterations");
    expect(model.setDowngradeConfirmed(true).canAccept).toBe(true);
    expect(model.setDowngradeConfirmed(false).canAccept).toBe(false);
  });

  it("treats fewer iterations with more memory as cheaper", () => {
    const state = reviewing(review({ current: { m: 65_536, t: 4, p: 1 }, incoming: { m: 131_072, t: 3, p: 1 } })).state();
    expect(state.needsDowngradeConfirmation).toBe(true);
  });

  it("shows only the incoming cost when this device holds no copy", () => {
    const state = reviewing(review({ current: undefined })).state();
    expect(state.costFacts).toEqual([{ label: ACCEPT_SLOTS_COPY.incomingCostName, value: "64 MiB, 3 iterations" }]);
    expect(state.canAccept).toBe(true);
  });

  it("offers nothing to accept when the copy and the records already match", () => {
    const state = reviewing(review({ changes: false })).state();
    expect(state.canAccept).toBe(false);
    expect(state.nothingToAccept).toBe(true);
  });

  it("does not let the downgrade confirmation outlive a review that has none", () => {
    const model = reviewing(review());
    expect(model.setDowngradeConfirmed(true).downgradeConfirmed).toBe(false);
  });
});

describe("accept-slots model: accepting and settling", () => {
  it("begins the accept once and only with the gating satisfied", () => {
    const blocked = reviewing(review({ current: COST_128, incoming: COST_64 }));
    expect(blocked.beginAccept()).toBe(false);
    blocked.setDowngradeConfirmed(true);
    expect(blocked.beginAccept()).toBe(true);
    expect(blocked.beginAccept()).toBe(false);
    expect(blocked.state()).toMatchObject({ phase: "accepting", busy: true, downgradeConfirmed: true });
  });

  it("cannot begin an accept before a review exists", () => {
    expect(fresh().beginAccept()).toBe(false);
  });

  it("finishes with the outcome, and a failure locks the dialog", () => {
    const ok = reviewing(review());
    ok.beginAccept();
    expect(ok.settleAccept({ ok: true, kind: "accepted" })).toMatchObject({ phase: "done", acceptedKind: "accepted" });
    const failed = reviewing(review());
    failed.beginAccept();
    expect(failed.settleAccept({ ok: false, reason: "lock lost", retryable: false })).toMatchObject({ phase: "stopped", failure: "lock lost" });
  });

  it("returns to the review after a refusal that wrote nothing", () => {
    const model = reviewing(review());
    model.beginAccept();
    const state = model.settleAccept({ ok: false, reason: "the name moved", retryable: true });
    expect(state.phase).toBe("review");
    expect(state.failure).toBe("the name moved");
    expect(state.canAccept).toBe(true);
  });

  it("escapes control and bidirectional characters in a reason", () => {
    const model = fresh();
    model.setCurrent(PASSPHRASE);
    model.beginCheck();
    expect(model.settleCheck({ ok: false, reason: "x‮y", retryable: false }).failure).toBe("x\\u202ey");
  });
});
