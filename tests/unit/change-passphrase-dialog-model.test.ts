import { describe, expect, it } from "vitest";
import { KDF_ITERATIONS_DEFAULT, KDF_MEMORY_DEFAULT_KIB, KDF_PARALLELISM, type KdfParams } from "../../src/crypto";
import { createChangePassphraseModel } from "../../src/plugin/change-passphrase-dialog-model";
import { CHANGE_PASSPHRASE_COPY, KEY_DIALOG_COPY, SETUP_COPY, UNLOCK_COPY } from "../../src/plugin/encryption-copy";
import { REVOCATION_STATEMENT } from "../../src/sync/key-management-text";
import type { PassphraseFormatCheck } from "../../src/plugin/unlock-dialog-model";

const NEW_PASSPHRASE = "ABCDE-FGHIJ-KLMNO-PQRST-UVWX2";
const COST: KdfParams = { m: KDF_MEMORY_DEFAULT_KIB, t: KDF_ITERATIONS_DEFAULT, p: KDF_PARALLELISM };
const OLD = "KLMNO-PQRST-UVWX2-ABCDE-FGHIJ";

const check: PassphraseFormatCheck = (text) => (text.replaceAll("-", "").length === 25 ? undefined : "wrong-length");
const fresh = () => createChangePassphraseModel({ passphrase: NEW_PASSPHRASE, cost: COST, check });

/** A model with everything the form needs. */
function ready() {
  const model = fresh();
  model.setCurrent(OLD);
  model.setReentry(NEW_PASSPHRASE);
  model.setAcknowledged(true);
  return model;
}

describe("change-passphrase model: gating of the confirm control", () => {
  it("starts disabled and names all three requirements in reading order", () => {
    const state = fresh().state();
    expect(state.phase).toBe("form");
    expect(state.canConfirm).toBe(false);
    expect(state.missing).toEqual(["current", "reentry", "acknowledgement"]);
    expect(state.requirementsText).toContain(KEY_DIALOG_COPY.needCurrent);
    expect(state.requirementsText).toContain(CHANGE_PASSPHRASE_COPY.needReentry);
    expect(state.requirementsText).toContain(CHANGE_PASSPHRASE_COPY.needAcknowledgement);
  });

  it("stays disabled until the statement is acknowledged, whatever else is filled in", () => {
    const model = fresh();
    model.setCurrent(OLD);
    const state = model.setReentry(NEW_PASSPHRASE);
    expect(state.canConfirm).toBe(false);
    expect(state.missing).toEqual(["acknowledgement"]);
    expect(model.setAcknowledged(true).canConfirm).toBe(true);
    expect(model.setAcknowledged(false).canConfirm).toBe(false);
  });

  it("stays disabled while the re-entry differs from the shown passphrase", () => {
    const model = fresh();
    model.setCurrent(OLD);
    model.setAcknowledged(true);
    const state = model.setReentry("ABCDE-FGHIJ-KLMNO-PQRST-UVWX3");
    expect(state.canConfirm).toBe(false);
    expect(state.missing).toEqual(["reentry"]);
    expect(state.reentryError).toBe(SETUP_COPY.mismatch);
  });

  it("stays disabled while the current passphrase is empty or malformed, and says so in text once the field is left", () => {
    const model = fresh();
    model.setReentry(NEW_PASSPHRASE);
    model.setAcknowledged(true);
    expect(model.state().missing).toEqual(["current"]);
    const typo = model.setCurrent("ABC");
    expect(typo.canConfirm).toBe(false);
    expect(typo.current.status).toBe("invalid");
    expect(typo.current.error).toBeUndefined();
    expect(model.touchCurrent().current.error).toBe(UNLOCK_COPY.wrongLength);
    expect(model.setCurrent(OLD).canConfirm).toBe(true);
    expect(model.state().current.error).toBeUndefined();
  });

  it("enables confirm only when all three hold", () => {
    expect(ready().state().canConfirm).toBe(true);
    expect(ready().state().requirementsText).toBe("");
  });

  it("offers no way to choose one's own passphrase: the shown one is the only one that can match", () => {
    const state = fresh().state();
    expect(state.groups).toEqual(["ABCDE", "FGHIJ", "KLMNO", "PQRST", "UVWX2"]);
    const model = fresh();
    model.setCurrent(OLD);
    model.setAcknowledged(true);
    expect(model.setReentry("ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ").canConfirm).toBe(false);
  });
});

describe("change-passphrase model: statements shown before confirm", () => {
  it("states that old passphrases and old copies keep working, the cost, and that other devices must accept", () => {
    const text = fresh().state().statements.join("\n");
    expect(text).toContain(REVOCATION_STATEMENT);
    expect(text).toContain("64 MiB, 3 iterations");
    expect(text).toContain("accept");
    expect(text).toContain("four key derivations");
  });
});

describe("change-passphrase model: run and settle", () => {
  it("refuses to begin unless confirm is allowed, and begins once", () => {
    const blocked = fresh();
    expect(blocked.begin()).toBe(false);
    expect(blocked.state().busy).toBe(false);
    const model = ready();
    expect(model.begin()).toBe(true);
    expect(model.begin()).toBe(false);
    const state = model.state();
    expect(state.phase).toBe("working");
    expect(state.busy).toBe(true);
    expect(state.canConfirm).toBe(false);
  });

  it("forgets the current passphrase's status when the run begins (the dialog empties the field)", () => {
    const model = ready();
    model.begin();
    expect(model.state().current.status).toBe("empty");
  });

  it("reports progress only while working, clamped to 0..1", () => {
    const model = ready();
    expect(model.reportProgress(0.5).progress).toBeUndefined();
    model.begin();
    expect(model.reportProgress(0.4).progress).toBe(0.4);
    expect(model.reportProgress(7).progress).toBe(1);
    expect(model.reportProgress(Number.NaN).progress).toBe(1);
  });

  it("shows the test unlock result when the run succeeds and keeps the new passphrase visible until dispose", () => {
    const model = ready();
    model.begin();
    const state = model.settle({ ok: true, testUnlock: "verified" });
    expect(state.phase).toBe("done");
    expect(state.busy).toBe(false);
    expect(state.testUnlock).toBe("verified");
    expect(state.groups).toHaveLength(5);
    model.dispose();
    expect(model.state().groups).toEqual([]);
  });

  it("returns to the form with a text error on the current-passphrase field after a refusal that wrote nothing", () => {
    const model = ready();
    model.begin();
    const state = model.settle({ ok: false, reason: "That passphrase did not open this vault.", retryable: true });
    expect(state.phase).toBe("form");
    expect(state.current.error).toBe("That passphrase did not open this vault.");
    expect(state.canConfirm).toBe(false);
    expect(model.setCurrent(OLD).canConfirm).toBe(true);
  });

  it("locks the form after a failure that may have changed the node, and keeps the new passphrase visible", () => {
    const model = ready();
    model.begin();
    const state = model.settle({ ok: false, reason: "test unlock failed", retryable: false });
    expect(state.phase).toBe("stopped");
    expect(state.failure).toBe("test unlock failed");
    expect(state.canConfirm).toBe(false);
    expect(state.groups).toHaveLength(5);
    expect(model.begin()).toBe(false);
  });

  it("escapes control and bidirectional characters in a reason before it is shown", () => {
    const model = ready();
    model.begin();
    const state = model.settle({ ok: false, reason: "bad‮name\u0007", retryable: false });
    expect(state.failure).toBe("bad\\u202ename\\u0007");
  });

  it("has a copy of the no-recovery note in the dialog's own words", () => {
    expect(KEY_DIALOG_COPY.cancel).toBe("Cancel");
    expect(CHANGE_PASSPHRASE_COPY.noRecovery).toContain("no recovery mechanism");
  });
});
