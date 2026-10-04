import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_KDF_PARAMS, KDF_ITERATIONS_CEILING, KDF_MEMORY_CEILING_KIB, KDF_PARALLELISM, type KdfParams } from "../../src/crypto";
import { enforceCostPolicy } from "../../src/crypto/argon2";
import { costConfirmationFrom, createCostConfirmModel } from "../../src/plugin/cost-confirm-dialog-model";
import { COST_CONFIRM_COPY } from "../../src/plugin/encryption-copy";

const HIGH: KdfParams = { m: 131_072, t: 4, p: KDF_PARALLELISM };
const CEILING: KdfParams = { m: KDF_MEMORY_CEILING_KIB, t: KDF_ITERATIONS_CEILING, p: KDF_PARALLELISM };

describe("cost-confirm model: what is shown", () => {
  it("states the slot's cost and the default it is above, from engine values", () => {
    const view = createCostConfirmModel([HIGH]).view();
    expect(view.summary).toBe("This key slot costs 128 MiB, 4 iterations to unlock, above the default of 64 MiB, 3 iterations.");
    expect(view.costLines).toEqual(["128 MiB, 4 iterations"]);
    expect(view.title).toBe(COST_CONFIRM_COPY.title);
    expect(view.blocked).toBeUndefined();
  });

  it("lists every tried slot when more than one is above the default", () => {
    const view = createCostConfirmModel([HIGH, CEILING]).view();
    expect(view.costLines).toHaveLength(2);
    expect(view.summary).toContain("These key slots cost 128 MiB, 4 iterations; ");
  });

  it("says that nothing is written and that the unlock takes memory and time here", () => {
    const view = createCostConfirmModel([HIGH]).view();
    expect(view.nothingWritten).toContain("Nothing has been written");
    expect(view.effects).toContain("memory and time");
  });

  it("names the default from the engine constant", () => {
    expect(createCostConfirmModel([HIGH]).view().summary).toContain(`${DEFAULT_KDF_PARAMS.m / 1024} MiB, ${DEFAULT_KDF_PARAMS.t} iterations`);
  });
});

describe("cost-confirm model: gating", () => {
  it("puts the initial focus on Cancel and labels the yes with what it does", () => {
    const view = createCostConfirmModel([HIGH]).view();
    expect(view.initialFocus).toBe("cancel");
    expect(view.cancelLabel).toBe(COST_CONFIRM_COPY.cancel);
    expect(view.confirmLabel).toBe(COST_CONFIRM_COPY.confirm);
  });

  it("takes a yes only from an explicit confirm, and only once", () => {
    const model = createCostConfirmModel([HIGH]);
    expect(model.state()).toEqual({ canConfirm: true, decided: false });
    expect(model.confirm()).toBe(true);
    expect(model.confirm()).toBe(false);
    expect(model.state()).toEqual({ canConfirm: false, decided: true });
  });

  it("a cancel is a no and a later confirm cannot flip it", () => {
    const model = createCostConfirmModel([HIGH]);
    model.cancel();
    expect(model.confirm()).toBe(false);
    expect(model.state().decided).toBe(true);
  });

  it("fails closed with no cost to confirm", () => {
    const model = createCostConfirmModel([]);
    expect(model.state().canConfirm).toBe(false);
    expect(model.confirm()).toBe(false);
    expect(model.view().blocked).toBe(COST_CONFIRM_COPY.blockedNothing);
  });

  it("fails closed for a cost that is not a finite positive number", () => {
    for (const bad of [{ ...HIGH, m: Number.NaN }, { ...HIGH, t: Number.POSITIVE_INFINITY }, { ...HIGH, m: 0 }]) {
      const model = createCostConfirmModel([HIGH, bad]);
      expect(model.confirm()).toBe(false);
      expect(model.view().blocked).toBe(COST_CONFIRM_COPY.blockedInvalid);
      expect(model.view().costLines).toEqual([]);
    }
  });
});

describe("cost-confirm ports", () => {
  it("the policy asks once per tried slot above the default and approves only on true", async () => {
    const asked: KdfParams[][] = [];
    const ports = costConfirmationFrom(async (costs) => {
      asked.push([...costs]);
      return true;
    });
    await expect(enforceCostPolicy([HIGH, CEILING], ports.policy)).resolves.toBeUndefined();
    expect(asked).toEqual([[HIGH], [CEILING]]);
  });

  it("a no, a rejected ask and a non-boolean answer are all refusals", async () => {
    for (const ask of [async () => false, async () => Promise.reject(new Error("closed")), async () => "yes" as unknown as boolean]) {
      const ports = costConfirmationFrom(ask);
      await expect(enforceCostPolicy([HIGH], ports.policy)).rejects.toMatchObject({ code: "kdf-cost-refused" });
      expect(await ports.confirm([HIGH])).toBe(false);
    }
  });

  it("confirm asks once for all tried slots", async () => {
    const asked: KdfParams[][] = [];
    const ports = costConfirmationFrom(async (costs) => {
      asked.push([...costs]);
      return true;
    });
    expect(await ports.confirm([HIGH, CEILING])).toBe(true);
    expect(asked).toEqual([[HIGH, CEILING]]);
  });
});

describe("cost-confirm dialog source", () => {
  const source = (file: string): string => readFileSync(new URL(`../../src/plugin/${file}`, import.meta.url), "utf8");

  it("has no clipboard control and no HTML sink", () => {
    for (const file of ["cost-confirm-dialog.ts", "cost-confirm-dialog-model.ts"]) {
      const text = source(file);
      expect(text).not.toMatch(/clipboard|execCommand|innerHTML|outerHTML|insertAdjacentHTML/);
    }
  });

  it("focuses Cancel on open and treats close as a no", () => {
    const text = source("cost-confirm-dialog.ts");
    expect(text).toContain("this.cancelButton?.focus()");
    expect(text).toMatch(/onClose\(\)[\s\S]*this\.onFinish\(this\.yes\)/);
  });

  it("is passed to the key actions by the plugin entry", () => {
    const entry = source("index.ts");
    expect(entry).toContain("const costConfirmation = obsidianCostConfirmation(this.app)");
    expect(entry).toMatch(/createKeyActions\(\{[\s\S]*?\n\s+costConfirmation,/);
  });
});
