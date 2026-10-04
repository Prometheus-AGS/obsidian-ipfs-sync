import { describe, expect, it } from "vitest";
import { ENCRYPTION_COPY } from "../../src/plugin/encryption-copy";
import { describeKeyActions, describeSlotCost } from "../../src/plugin/encryption-settings-model";

const open = (): void => undefined;
const all = { openChangePassphrase: open, openIncreaseCost: open, openAcceptSlots: open };

describe("slot cost line", () => {
  it("names memory and iterations and says when the cost is the default", () => {
    expect(describeSlotCost({ m: 65_536, t: 3, p: 1 })).toBe("64 MiB, 3 iterations (the default).");
  });

  it("says when the cost is above or below the default", () => {
    expect(describeSlotCost({ m: 131_072, t: 4, p: 1 })).toBe("128 MiB, 4 iterations (above the default).");
    expect(describeSlotCost({ m: 32_768, t: 3, p: 1 })).toBe("32 MiB, 3 iterations (below the default).");
  });

  it("says plainly when this device does not know the cost", () => {
    expect(describeSlotCost(undefined)).toBe(ENCRYPTION_COPY.slotCostUnknown);
  });
});

describe("key actions in the Encryption section", () => {
  it("shows no action before a vault exists", () => {
    expect(describeKeyActions("not-set-up", all)).toEqual([]);
  });

  it("shows the three actions, in reading order, whether the vault is locked or unlocked, because each dialog asks for the passphrase itself", () => {
    for (const state of ["locked", "unlocked"] as const) {
      expect(describeKeyActions(state, all).map((a) => a.id)).toEqual(["change-passphrase", "increase-cost", "accept-slots"]);
    }
  });

  it("shows only the actions the source can open", () => {
    expect(describeKeyActions("locked", { openAcceptSlots: open }).map((a) => a.id)).toEqual(["accept-slots"]);
    expect(describeKeyActions("locked", {})).toEqual([]);
  });

  it("gives each action a visible name, a description and a button label that is not a bare verb", () => {
    for (const action of describeKeyActions("unlocked", all)) {
      expect(action.name.length).toBeGreaterThan(5);
      expect(action.desc.length).toBeGreaterThan(20);
      expect(action.button.endsWith("...")).toBe(true);
    }
  });

  it("adds Prune history after the key rows when the source can open it, hidden until a vault exists (task 2.5)", () => {
    const withPrune = { ...all, openPruneHistory: open };
    expect(describeKeyActions("not-set-up", withPrune)).toEqual([]);
    for (const state of ["locked", "unlocked"] as const) {
      expect(describeKeyActions(state, withPrune).map((a) => a.id)).toEqual(["change-passphrase", "increase-cost", "accept-slots", "prune-history"]);
    }
    expect(describeKeyActions("locked", { openPruneHistory: open }).map((a) => a.id)).toEqual(["prune-history"]);
    expect(describeKeyActions("locked", all).map((a) => a.id)).not.toContain("prune-history");
  });

  it("describes Prune history by what it removes, what it keeps and that it asks first", () => {
    const row = describeKeyActions("unlocked", { openPruneHistory: open }).find((a) => a.id === "prune-history");
    expect(row?.name).toBe("Prune history");
    expect(row?.button).toBe("Prune history...");
    expect(row?.desc).toContain("newest 20");
    expect(row?.desc).toContain("stay pinned");
    expect(row?.desc).toContain("before anything is removed");
  });

  it("says in the descriptions that old passphrases are not revoked and that accepting needs the new passphrase", () => {
    const byId = Object.fromEntries(describeKeyActions("unlocked", all).map((a) => [a.id, a.desc]));
    expect(byId["change-passphrase"]).toContain("old passphrase");
    expect(byId["increase-cost"]).toContain("old");
    expect(byId["accept-slots"]).toContain("passphrase");
  });
});
