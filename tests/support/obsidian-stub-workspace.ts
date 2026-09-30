/**
 * Test-only stand-ins for the parts of Obsidian's workspace the plugin touches: text editor views and the
 * workspace that holds them. Re-exported by obsidian-stub.ts, which is what the `obsidian` alias points at.
 */

/** A text editor view as `TextFileView` exposes it: a file, the last saved text, and the editor's current text. */
export class TextFileView {
  file: { readonly path: string } | null = null;
  data = "";
  /** What the editor shows now; `getViewData` returns it. Tests set it to simulate an unsaved edit. */
  editorText = "";
  saves = 0;
  saveError: Error | undefined;

  getViewData(): string {
    return this.editorText;
  }

  async save(): Promise<void> {
    if (this.saveError !== undefined) throw this.saveError;
    this.saves += 1;
    this.data = this.editorText;
    this.onSave(this.editorText);
  }

  /** Hook for tests: write the saved text somewhere (the memory vault). */
  onSave(_text: string): void {}
}

export interface StubLeaf {
  readonly view: unknown;
}

/** The parts of `Workspace` the plugin uses: leaves to iterate and `onLayoutReady`. */
export class Workspace {
  readonly leaves: StubLeaf[] = [];
  layoutReady = false;
  private readonly pending: (() => unknown)[] = [];

  iterateAllLeaves(callback: (leaf: StubLeaf) => unknown): void {
    for (const leaf of this.leaves) callback(leaf);
  }

  onLayoutReady(callback: () => unknown): void {
    if (this.layoutReady) void callback();
    else this.pending.push(callback);
  }

  /** Test helper: the workspace becomes ready and the queued callbacks run. */
  markLayoutReady(): void {
    this.layoutReady = true;
    for (const callback of this.pending.splice(0)) void callback();
  }
}
