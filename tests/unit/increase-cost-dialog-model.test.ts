import { describe, expect, it } from "vitest";
import {
  KDF_ITERATIONS_CEILING,
  KDF_ITERATIONS_DEFAULT,
  KDF_MEMORY_CEILING_KIB,
  KDF_MEMORY_DEFAULT_KIB,
  KDF_PARALLELISM,
  assertKdfParams,
  type KdfParams,
} from "../../src/crypto";
import { INCREASE_COST_COPY } from "../../src/plugin/encryption-copy";
import { createIncreaseCostModel } from "../../src/plugin/increase-cost-dialog-model";
import type { PassphraseFormatCheck } from "../../src/plugin/unlock-dialog-model";
import { PHONE_STATEMENT, REVOCATION_STATEMENT, SAME_PASSPHRASE_STATEMENT } from "../../src/sync/key-management-text";

const STANDARD: KdfParams = { m: KDF_MEMORY_DEFAULT_KIB, t: KDF_ITERATIONS_DEFAULT, p: KDF_PARALLELISM };
const HIGH: KdfParams = { m: KDF_MEMORY_CEILING_KIB, t: KDF_ITERATIONS_CEILING, p: KDF_PARALLELISM };
const PASSPHRASE = "ABCDE-FGHIJ-KLMNO-PQRST-UVWX2";

const check: PassphraseFormatCheck = (text) => (text.replaceAll("-", "").length === 25 ? undefined : "wrong-length");
const at = (current: KdfParams) => createIncreaseCostModel({ current, check });

describe("increase-cost model: the choices", () => {
  it("offers the current cost first and the higher preset, nothing above the ceilings", () => {
    const state = at(STANDARD).state();
    expect(state.options.map((o) => o.id)).toEqual(["current", "high"]);
    expect(state.options.map((o) => o.relation)).toEqual(["same", "higher"]);
    expect(state.selected.id).toBe("current");
    for (const option of state.options) expect(() => assertKdfParams(option.params)).not.toThrow();
  });

  it("names memory and iterations in every choice", () => {
    for (const option of at(STANDARD).state().options) {
      expect(option.label).toContain("MiB");
      expect(option.label).toContain("iterations");
    }
  });

  it("offers the lower preset, marked lower, when the current cost is already the highest", () => {
    const state = at(HIGH).state();
    expect(state.options.map((o) => o.id)).toEqual(["current", "standard"]);
    expect(state.options.map((o) => o.relation)).toEqual(["same", "lower"]);
  });

  it("treats a mixed change (more memory, fewer iterations) as lower", () => {
    const mixed: KdfParams = { m: KDF_MEMORY_CEILING_KIB, t: KDF_ITERATIONS_DEFAULT, p: KDF_PARALLELISM };
    const model = at(mixed);
    expect(model.state().options.find((o) => o.id === "high")?.relation).toBe("higher");
    const lowMemory: KdfParams = { m: KDF_MEMORY_DEFAULT_KIB, t: KDF_ITERATIONS_CEILING, p: KDF_PARALLELISM };
    expect(at(lowMemory).state().options.find((o) => o.id === "standard")?.relation).toBe("lower");
  });

  it("ignores a choice that is not one of the offered presets", () => {
    const model = at(STANDARD);
    expect(model.choose("custom").selected.id).toBe("current");
    expect(model.choose("131073").selected.id).toBe("current");
    expect(model.choose("high").selected.id).toBe("high");
  });
});

describe("increase-cost model: gating of the confirm control", () => {
  const filled = (model: ReturnType<typeof at>) => {
    model.setCurrent(PASSPHRASE);
    model.setAcknowledged(true);
  };

  it("starts disabled with every requirement named", () => {
    const state = at(STANDARD).state();
    expect(state.canConfirm).toBe(false);
    expect(state.missing).toEqual(["choice", "current", "acknowledgement"]);
    expect(state.requirementsText).toContain(INCREASE_COST_COPY.needChoice);
  });

  it("stays disabled while the current cost is selected: there is nothing to change", () => {
    const model = at(STANDARD);
    filled(model);
    expect(model.state().canConfirm).toBe(false);
    expect(model.state().missing).toEqual(["choice"]);
  });

  it("stays disabled until the old-passphrases statement is acknowledged", () => {
    const model = at(STANDARD);
    model.choose("high");
    model.setCurrent(PASSPHRASE);
    expect(model.state().canConfirm).toBe(false);
    expect(model.state().missing).toEqual(["acknowledgement"]);
    expect(model.setAcknowledged(true).canConfirm).toBe(true);
  });

  it("needs the current passphrase", () => {
    const model = at(STANDARD);
    model.choose("high");
    model.setAcknowledged(true);
    expect(model.state().missing).toEqual(["current"]);
  });

  it("needs a separate downgrade confirmation for a lower choice, and loses it when the choice changes", () => {
    const model = at(HIGH);
    filled(model);
    const lower = model.choose("standard");
    expect(lower.canConfirm).toBe(false);
    expect(lower.missing).toEqual(["downgrade"]);
    expect(lower.downgradeQuestion).toContain("128 MiB, 4 iterations");
    expect(lower.downgradeQuestion).toContain("64 MiB, 3 iterations");
    expect(model.setDowngradeConfirmed(true).canConfirm).toBe(true);
    model.choose("current");
    expect(model.choose("standard").canConfirm).toBe(false);
  });

  it("shows no downgrade question for a higher choice", () => {
    const model = at(STANDARD);
    expect(model.choose("high").downgradeQuestion).toBeUndefined();
  });
});

describe("increase-cost model: statements", () => {
  it("states that old passphrases and copies stay valid, warns about slower devices, and says a same-passphrase increase leaves the old cheaper slot", () => {
    const state = at(STANDARD).choose("high");
    const text = state.statements.join("\n");
    expect(text).toContain(REVOCATION_STATEMENT);
    expect(text).toContain(PHONE_STATEMENT);
    expect(text).toContain(SAME_PASSPHRASE_STATEMENT);
  });

  it("adds the above-default warning only for a cost above the default", () => {
    const model = at(STANDARD);
    expect(model.state().selectionText).not.toContain(INCREASE_COST_COPY.aboveDefault);
    expect(model.choose("high").selectionText).toContain(INCREASE_COST_COPY.aboveDefault);
  });

  it("shows the current cost and the chosen cost", () => {
    const text = at(STANDARD).choose("high").selectionText;
    expect(text).toContain("64 MiB, 3 iterations");
    expect(text).toContain("128 MiB, 4 iterations");
  });
});

describe("increase-cost model: run and settle", () => {
  it("begins once, with the chosen cost and the downgrade flag only for a confirmed lower choice", () => {
    const up = at(STANDARD);
    up.choose("high");
    up.setCurrent(PASSPHRASE);
    up.setAcknowledged(true);
    expect(up.begin()).toBe(true);
    expect(up.state().selected.params).toEqual(HIGH);
    expect(up.state().allowDowngrade).toBe(false);
    expect(up.begin()).toBe(false);

    const down = at(HIGH);
    down.choose("standard");
    down.setDowngradeConfirmed(true);
    down.setCurrent(PASSPHRASE);
    down.setAcknowledged(true);
    expect(down.begin()).toBe(true);
    expect(down.state().allowDowngrade).toBe(true);
  });

  it("settles like the other key dialogs: success shows the test unlock, a clean refusal reopens the form, a partial failure locks it", () => {
    const run = () => {
      const model = at(STANDARD);
      model.choose("high");
      model.setCurrent(PASSPHRASE);
      model.setAcknowledged(true);
      model.begin();
      return model;
    };
    expect(run().settle({ ok: true, testUnlock: "verified" })).toMatchObject({ phase: "done", testUnlock: "verified" });
    const refused = run().settle({ ok: false, reason: "wrong passphrase", retryable: true });
    expect(refused.phase).toBe("form");
    expect(refused.current.error).toBe("wrong passphrase");
    expect(run().settle({ ok: false, reason: "stopped", retryable: false })).toMatchObject({ phase: "stopped", failure: "stopped" });
  });
});
