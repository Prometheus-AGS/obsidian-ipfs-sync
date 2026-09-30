import { describe, expect, it } from "vitest";
import { flushOpenEditors, type WorkspaceLike } from "../../src/plugin/editor-flush";
import { MemoryAdapter } from "../support/memory-adapter";
import { TextFileView, Workspace } from "../support/obsidian-stub";

function editor(adapter: MemoryAdapter, path: string | null, editorText: string): TextFileView {
  const view = new TextFileView();
  view.file = path === null ? null : { path };
  view.editorText = editorText;
  view.data = adapter.text(path ?? "") ?? "";
  // Saving writes the editor's text to the file, like Obsidian does.
  view.onSave = (text) => {
    if (path !== null) adapter.put(path, text, 9000);
  };
  return view;
}

/** The stub workspace stands in for Obsidian's; its leaves carry only a view. */
function workspaceWith(...views: unknown[]): WorkspaceLike {
  const workspace = new Workspace();
  for (const view of views) workspace.leaves.push({ view });
  return workspace as unknown as WorkspaceLike;
}

describe("editor flush", () => {
  it("saves an editor whose text is not on disk yet", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("a.md", "on disk", 1000);
    const pending = editor(adapter, "a.md", "typed a moment ago");
    await flushOpenEditors(workspaceWith(pending), adapter);
    expect(pending.saves).toBe(1);
    expect(adapter.text("a.md")).toBe("typed a moment ago");
  });

  it("leaves an editor alone when its text equals the file, so an untouched note is not rewritten", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("a.md", "same text", 1000);
    const clean = editor(adapter, "a.md", "same text");
    await flushOpenEditors(workspaceWith(clean), adapter);
    expect(clean.saves).toBe(0);
    expect(adapter.files.get("a.md")?.mtime).toBe(1000);
  });

  it("skips views that are not text editors and editors without a file", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("a.md", "x", 1000);
    const unsaved = editor(adapter, null, "scratch");
    await flushOpenEditors(workspaceWith({ notATextView: true }, unsaved), adapter);
    expect(unsaved.saves).toBe(0);
  });

  it("saves every pending editor and rejects when one save fails", async () => {
    const adapter = new MemoryAdapter();
    adapter.put("a.md", "1", 1000);
    adapter.put("b.md", "2", 1000);
    const first = editor(adapter, "a.md", "1 edited");
    const second = editor(adapter, "b.md", "2 edited");
    second.saveError = new Error("save failed");
    await expect(flushOpenEditors(workspaceWith(first, second), adapter)).rejects.toThrowError("save failed");
    expect(first.saves).toBe(1);
  });
});
