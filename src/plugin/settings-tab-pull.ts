import { Setting } from "obsidian";
import { PULL_TARGET_ID, addSection, addTextField, addToggleField, type FieldContext } from "./settings-tab-controls";
import { PULL_COPY as COPY, SECTIONS } from "./settings-tab-copy";
import type { SettingsViewState } from "./settings-view-model";

/**
 * The Pull, Memory and Last activity sections. Pull holds the name to pull from (with the name that will
 * actually be used, in words) and the per-device catch-up switch; Memory holds the read cap; Last activity is
 * read-only text about the last publish and the last pull on this device.
 */
export class PullSections {
  private targetEl: HTMLElement | undefined;
  private publishEl: HTMLElement | undefined;
  private pullEl: HTMLElement | undefined;

  render(root: HTMLElement, ctx: FieldContext): void {
    const pull = addSection(root, "ipfs-sync-section-pull", SECTIONS.pull);
    addTextField(pull, "pullName", ctx);
    this.targetEl = this.summaryRow(pull, COPY.targetName, PULL_TARGET_ID, true);
    addToggleField(pull, "catchUpOnLoad", ctx);
    const memory = addSection(root, "ipfs-sync-section-memory", SECTIONS.memory);
    addTextField(memory, "maxReadMb", ctx);
    const activity = addSection(root, "ipfs-sync-section-activity", SECTIONS.activity);
    this.publishEl = this.summaryRow(activity, COPY.publishName, "ipfs-sync-last-publish", false);
    this.pullEl = this.summaryRow(activity, COPY.pullName, "ipfs-sync-last-pull", false);
  }

  /** Refresh the read-only lines from the view state (the pull name edit changes the target line). */
  update(state: SettingsViewState): void {
    this.targetEl?.setText(state.pullTarget);
    this.publishEl?.setText(state.lastPublish.text);
    this.pullEl?.setText(state.lastPull.text);
  }

  /** A read-only row: a visible name and a text value in the description area. Not focusable, so the keyboard order is unchanged. */
  private summaryRow(parent: HTMLElement, name: string, id: string, live: boolean): HTMLElement {
    const row = new Setting(parent).setName(name);
    if (live) row.descEl.setAttr("aria-live", "polite");
    row.descEl.id = id;
    return row.descEl;
  }
}
