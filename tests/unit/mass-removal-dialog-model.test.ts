import { describe, expect, it } from "vitest";
import { MASS_REMOVAL_COPY } from "../../src/plugin/encryption-copy";
import { createMassRemovalModel, massRemovalTimerNotice } from "../../src/plugin/mass-removal-dialog-model";
import type { MassRemovalCounts } from "../../src/sync/publish-refusals";

const counts = (patch: Partial<MassRemovalCounts> = {}): MassRemovalCounts => ({ removing: 6, remaining: 10, exclusionDriven: 0, ...patch });

describe("mass-removal model: what is shown", () => {
  it("states how many of how many entries would be removed", () => {
    const view = createMassRemovalModel(counts()).view();
    expect(view.summary).toBe("This publish would remove 6 of 10 entries from the published vault.");
    expect(view.title).toBe(MASS_REMOVAL_COPY.title);
  });

  it("says every entry when the removals equal the whole manifest, and agrees in number", () => {
    const all = createMassRemovalModel(counts({ removing: 10, remaining: 10 })).view();
    expect(all.title).toBe(MASS_REMOVAL_COPY.titleAll);
    expect(all.summary).toBe("This publish would remove all 10 entries from the published vault.");
    const one = createMassRemovalModel(counts({ removing: 1, remaining: 1 })).view();
    expect(one.summary).toBe("This publish would remove the only entry from the published vault.");
  });

  it("always states that an emptied or unmounted vault looks the same", () => {
    expect(createMassRemovalModel(counts()).view().lookAlike).toBe(MASS_REMOVAL_COPY.lookAlike);
    expect(MASS_REMOVAL_COPY.lookAlike).toContain("emptied");
    expect(MASS_REMOVAL_COPY.lookAlike).toContain("unmounted");
  });

  it("reports exclusion-driven removals apart and does not count them", () => {
    const view = createMassRemovalModel(counts({ removing: 2, remaining: 2, exclusionDriven: 3 })).view();
    expect(view.summary).toContain("all 2 entries");
    expect(view.exclusionNote).toBe("3 more entries are removed because the exclusion list now matches them. They are not counted above.");
    expect(createMassRemovalModel(counts({ exclusionDriven: 1 })).view().exclusionNote).toContain("1 more entry is removed");
    expect(createMassRemovalModel(counts()).view().exclusionNote).toBeUndefined();
  });

  it("names the consequence on the confirm button, not just 'OK'", () => {
    const view = createMassRemovalModel(counts()).view();
    expect(view.confirmLabel).toBe("Remove 6 entries and publish");
    expect(createMassRemovalModel(counts({ removing: 1, remaining: 1 })).view().confirmLabel).toBe("Remove 1 entry and publish");
  });
});

describe("mass-removal model: gating", () => {
  it("makes cancel the default focus and the destructive action the warning style", () => {
    const view = createMassRemovalModel(counts()).view();
    expect(view.initialFocus).toBe("cancel");
    expect(view.confirmStyle).toBe("warning");
    expect(view.cancelLabel).toBe(MASS_REMOVAL_COPY.cancel);
  });

  it("takes the yes once, and only through an explicit confirm", () => {
    const model = createMassRemovalModel(counts());
    expect(model.state().decided).toBe(false);
    expect(model.confirm()).toBe(true);
    expect(model.confirm()).toBe(false);
    expect(model.state()).toEqual({ canConfirm: false, decided: true });
  });

  it("starts with confirm available but undecided: nothing is a yes until confirm is called", () => {
    expect(createMassRemovalModel(counts()).state()).toEqual({ canConfirm: true, decided: false });
  });

  it("makes cancel final", () => {
    const model = createMassRemovalModel(counts());
    model.cancel();
    expect(model.confirm()).toBe(false);
    expect(model.state().decided).toBe(true);
  });
});

describe("mass-removal timer notice", () => {
  it("says the automatic publish stopped, how many entries, that nothing was written, and that a dialog was not opened", () => {
    const text = massRemovalTimerNotice(counts());
    expect(text).toContain("6 of 10 entries");
    expect(text).toContain("Nothing was written");
    expect(text).toContain("Publish by hand");
  });

  it("mentions the vault-folder check", () => {
    expect(massRemovalTimerNotice(counts({ removing: 10, remaining: 10 }))).toContain("vault folder");
  });
});
