import { describe, expect, it } from "vitest";
import { createAbandonModel, typedConfirmation } from "../../src/plugin/abandon-dialog-model";
import { ABANDON_PHRASE, SETUP_COPY, UNLOCK_COPY } from "../../src/plugin/encryption-copy";
import { describeEncryption } from "../../src/plugin/encryption-settings-model";
import { createSetupModel, groupPassphrase, normalizeForCompare } from "../../src/plugin/setup-dialog-model";
import { createUnlockModel, type PassphraseFormatCheck } from "../../src/plugin/unlock-dialog-model";

const PASSPHRASE = "ABCDE-FGHIJ-KLMNO-PQRST-UVWX2";
const BARE = "ABCDEFGHIJKLMNOPQRSTUVWX2";

describe("setup model: grouping", () => {
  it("shows 25 symbols as 5 groups of 5 whatever separators the caller used", () => {
    expect(groupPassphrase(PASSPHRASE)).toEqual(["ABCDE", "FGHIJ", "KLMNO", "PQRST", "UVWX2"]);
    expect(groupPassphrase(BARE)).toEqual(["ABCDE", "FGHIJ", "KLMNO", "PQRST", "UVWX2"]);
    expect(createSetupModel(BARE).state().groups).toHaveLength(5);
  });

  it("compares without case, hyphens or spaces", () => {
    expect(normalizeForCompare("abcde-fghij klmno\tpqrst-uvwx2")).toBe(BARE);
  });
});

describe("setup model: gating of Create", () => {
  it("starts disabled and names both requirements", () => {
    const state = createSetupModel(PASSPHRASE).state();
    expect(state.canCreate).toBe(false);
    expect(state.missing).toEqual(["reentry", "acknowledgement"]);
    expect(state.requirementsText).toContain(SETUP_COPY.needReentry);
    expect(state.requirementsText).toContain(SETUP_COPY.needAcknowledgement);
  });

  it("keeps Create disabled when the re-entry differs, even with the acknowledgement ticked, and reports a text error", () => {
    const model = createSetupModel(PASSPHRASE);
    model.setAcknowledged(true);
    const state = model.setReentry("ABCDE-FGHIJ-KLMNO-PQRST-UVWX3");
    expect(state.reentry).toBe("mismatch");
    expect(state.canCreate).toBe(false);
    expect(state.reentryError).toBe(SETUP_COPY.mismatch);
    expect(state.missing).toEqual(["reentry"]);
  });

  it("keeps Create disabled when the re-entry matches but the acknowledgement is unchecked", () => {
    const model = createSetupModel(PASSPHRASE);
    const state = model.setReentry(PASSPHRASE);
    expect(state.reentry).toBe("match");
    expect(state.reentryError).toBeUndefined();
    expect(state.canCreate).toBe(false);
    expect(state.missing).toEqual(["acknowledgement"]);
    expect(state.requirementsText).toContain(SETUP_COPY.needAcknowledgement);
    expect(state.requirementsText).not.toContain(SETUP_COPY.needReentry);
  });

  it("enables Create only when the re-entry matches and the acknowledgement is ticked, and disables it again on either change", () => {
    const model = createSetupModel(PASSPHRASE);
    model.setAcknowledged(true);
    expect(model.setReentry(PASSPHRASE).canCreate).toBe(true);
    expect(model.state().requirementsText).toBe("");
    expect(model.setAcknowledged(false).canCreate).toBe(false);
    model.setAcknowledged(true);
    expect(model.setReentry(`${PASSPHRASE}X`).canCreate).toBe(false);
  });

  it("accepts a lower-case entry without hyphens", () => {
    const model = createSetupModel(PASSPHRASE);
    model.setAcknowledged(true);
    expect(model.setReentry("abcdefghijklmnopqrstuvwx2").canCreate).toBe(true);
  });

  it("does not call a partial correct entry an error until the field is left, and does once it is left", () => {
    const model = createSetupModel(PASSPHRASE);
    expect(model.setReentry("ABCDE-FG").reentry).toBe("incomplete");
    expect(model.state().reentryError).toBeUndefined();
    expect(model.touchReentry().reentryError).toBe(SETUP_COPY.incomplete);
  });

  it("reports a full-length wrong entry at once, and a short wrong entry only after the field is left", () => {
    const model = createSetupModel(PASSPHRASE);
    expect(model.setReentry("ZZZ").reentryError).toBeUndefined();
    expect(model.touchReentry().reentryError).toBe(SETUP_COPY.mismatch);
    const fresh = createSetupModel(PASSPHRASE);
    expect(fresh.setReentry("ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ").reentryError).toBe(SETUP_COPY.mismatch);
  });

  it("treats an empty field as empty, with no error", () => {
    const model = createSetupModel(PASSPHRASE);
    model.setReentry(PASSPHRASE);
    const state = model.setReentry("  ");
    expect(state.reentry).toBe("empty");
    expect(model.touchReentry().reentryError).toBeUndefined();
  });

  it("refuses to begin unless Create is allowed, and blocks a second begin while busy", () => {
    const model = createSetupModel(PASSPHRASE);
    expect(model.begin()).toBe(false);
    model.setAcknowledged(true);
    model.setReentry(PASSPHRASE);
    expect(model.begin()).toBe(true);
    expect(model.state().busy).toBe(true);
    expect(model.state().canCreate).toBe(false);
    expect(model.begin()).toBe(false);
  });

  it("clamps progress to 0..1, ignores non-numbers, and forgets it when the work ends", () => {
    const model = createSetupModel(PASSPHRASE);
    model.setAcknowledged(true);
    model.setReentry(PASSPHRASE);
    model.begin();
    expect(model.reportProgress(0.4).progress).toBe(0.4);
    expect(model.reportProgress(7).progress).toBe(1);
    expect(model.reportProgress(Number.NaN).progress).toBe(1);
    expect(model.fail("the node refused").progress).toBeUndefined();
  });

  it("returns to a usable state after a failure and shows the reason as text; the next edit clears it", () => {
    const model = createSetupModel(PASSPHRASE);
    model.setAcknowledged(true);
    model.setReentry(PASSPHRASE);
    model.begin();
    const failed = model.fail("the node refused");
    expect(failed.busy).toBe(false);
    expect(failed.failure).toBe("the node refused");
    expect(failed.canCreate).toBe(true);
    expect(model.setReentry(PASSPHRASE).failure).toBeUndefined();
  });

  it("does not keep what was typed, and forgets the passphrase on dispose", () => {
    const model = createSetupModel(PASSPHRASE);
    model.setReentry("ABCDE-FGHIJ-KLMNO-PQRST-UVWX3");
    model.touchReentry();
    const shown = JSON.stringify({ ...model.state(), groups: [] });
    expect(shown).not.toContain("UVWX3");
    model.setAcknowledged(true);
    model.setReentry(PASSPHRASE);
    model.dispose();
    const after = model.state();
    expect(after.groups).toEqual([]);
    expect(after.canCreate).toBe(false);
    expect(model.setReentry(PASSPHRASE).canCreate).toBe(false);
  });
});

describe("unlock model", () => {
  const check: PassphraseFormatCheck = (input) => {
    if (input === "short") return "wrong-length";
    if (input === "bad$") return "wrong-characters";
    if (input === "typo") return "check-failed";
    return undefined;
  };

  it("reports each local problem as text and lets a well-formed entry through", () => {
    const model = createUnlockModel(check);
    expect(model.validate("short")).toEqual({ ok: false, error: UNLOCK_COPY.wrongLength });
    expect(model.validate("bad$")).toEqual({ ok: false, error: UNLOCK_COPY.wrongCharacters });
    expect(model.validate("typo")).toEqual({ ok: false, error: UNLOCK_COPY.checkFailed });
    expect(model.validate("   ")).toEqual({ ok: false, error: UNLOCK_COPY.empty });
    expect(model.validate("fine")).toEqual({ ok: true });
    expect(model.state().error).toBeUndefined();
  });

  it("calls a failed check a probable typo and says nothing was sent to the node", () => {
    expect(UNLOCK_COPY.checkFailed).toMatch(/probable typo/i);
    expect(UNLOCK_COPY.checkFailed).toContain("Nothing was sent to the node");
  });

  it("clears a shown error when the field is edited, and shows the caller's refusal after a failed unlock", () => {
    const model = createUnlockModel(check);
    model.validate("short");
    expect(model.edited().error).toBeUndefined();
    model.begin();
    expect(model.fail("Wrong passphrase.").error).toBe("Wrong passphrase.");
    expect(model.state().busy).toBe(false);
  });

  it("blocks a second begin while busy and clamps progress", () => {
    const model = createUnlockModel(check);
    expect(model.begin()).toBe(true);
    expect(model.begin()).toBe(false);
    expect(model.reportProgress(-2).progress).toBe(0);
    expect(model.succeed().progress).toBeUndefined();
  });
});

describe("abandon model", () => {
  it("enables the action only after the word is typed, ignoring case and outer spaces", () => {
    const model = createAbandonModel();
    expect(model.state().canAbandon).toBe(false);
    expect(model.setTyped("aband").canAbandon).toBe(false);
    expect(model.setTyped("  ABANDON ").canAbandon).toBe(true);
    expect(typedConfirmation(ABANDON_PHRASE)).toBe(true);
    expect(model.begin()).toBe(true);
    expect(model.state().canAbandon).toBe(false);
    expect(model.begin()).toBe(false);
  });

  it("refuses to begin without the word and keeps the failure as text", () => {
    const model = createAbandonModel();
    expect(model.begin()).toBe(false);
    model.setTyped("abandon");
    model.begin();
    const failed = model.fail("could not write the backup");
    expect(failed.failure).toBe("could not write the backup");
    expect(failed.canAbandon).toBe(true);
  });
});

describe("encryption settings model", () => {
  it("names each state in words and enables Lock only when unlocked", () => {
    const notSetUp = describeEncryption("not-set-up");
    const locked = describeEncryption("locked");
    const unlocked = describeEncryption("unlocked");
    expect([notSetUp.label, locked.label, unlocked.label]).toEqual(["Not set up.", "Locked.", "Unlocked."]);
    expect([notSetUp.canLock, locked.canLock, unlocked.canLock]).toEqual([false, false, true]);
    expect(notSetUp.lockDescription).toContain("not unlocked");
    expect(unlocked.lockDescription).not.toContain("not unlocked");
  });

  it("offers Set up or Unlock only when the source can open them", () => {
    expect(describeEncryption("not-set-up").action).toBeUndefined();
    expect(describeEncryption("not-set-up", { openSetup: () => undefined }).action).toBe("setup");
    expect(describeEncryption("locked", { openUnlock: () => undefined }).action).toBe("unlock");
    expect(describeEncryption("unlocked", { openUnlock: () => undefined }).action).toBeUndefined();
  });
});
