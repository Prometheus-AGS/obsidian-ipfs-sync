import { Setting } from "obsidian";
import { addSection } from "./settings-tab-controls";
import { STALE_LOCK_COPY as COPY, STALE_LOCK_SECTION } from "./stale-lock-copy";
import type { StaleLockView } from "./stale-lock";

const DESC_ID = "ipfs-sync-desc-stale-lock";

/** What the Publish lock section needs from the plugin. */
export interface StaleLockSource {
  inspect(): Promise<StaleLockView>;
  /** Open the confirmation; resolves when it is done. The section then looks at the lock again. */
  open(): Promise<void>;
}

/**
 * The Publish lock section: the lock's state in words and a "Clear stale lock" button that is enabled only when the lock's
 * heartbeat is older than the staleness window. The state text is a polite live region; the button is built once and
 * enabled or disabled in place, so focus is not lost when the state is read again.
 */
export class StaleLockSection {
  private statusEl: HTMLElement | undefined;
  private button: HTMLButtonElement | undefined;
  private generation = 0;

  constructor(private readonly source: StaleLockSource) {}

  render(parent: HTMLElement): void {
    const section = addSection(parent, "ipfs-sync-section-publish-lock", STALE_LOCK_SECTION);
    const row = new Setting(section).setName(COPY.name).setDesc(COPY.desc);
    row.descEl.id = DESC_ID;
    const status = section.createDiv({ cls: "setting-item-description", attr: { "aria-live": "polite", role: "status" } });
    this.statusEl = status;
    row.addButton((button) => {
      button.setButtonText(COPY.button);
      button.buttonEl.setAttr("aria-describedby", DESC_ID);
      button.buttonEl.disabled = true;
      button.onClick(() => void this.clear());
      this.button = button.buttonEl;
    });
    void this.refresh();
  }

  /** Read the lock again and redraw the state and the button. */
  async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.statusEl?.setText(COPY.checking);
    let view: StaleLockView;
    try {
      view = await this.source.inspect();
    } catch (error) {
      if (generation === this.generation) this.draw(`Could not read the lock file: ${error instanceof Error ? error.message : "unknown error"}`, false);
      return;
    }
    if (generation !== this.generation) return;
    if (view.kind === "stale") this.draw(`${COPY.stale} ${view.description}.`, true);
    else if (view.kind === "held") this.draw(`${COPY.held} (${view.description}.)`, false);
    else this.draw(COPY[view.kind], false);
  }

  private draw(text: string, canClear: boolean): void {
    this.statusEl?.setText(text);
    if (this.button !== undefined) this.button.disabled = !canClear;
  }

  private async clear(): Promise<void> {
    await this.source.open();
    await this.refresh();
    this.button?.focus();
  }
}
