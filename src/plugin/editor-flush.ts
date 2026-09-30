import { TextFileView, type WorkspaceLeaf } from "obsidian";
import type { VaultAdapter } from "./obsidian-fs";

/** The part of Obsidian's `Workspace` the flush uses. */
export interface WorkspaceLike {
  iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => unknown): void;
}

const decoder = new TextDecoder();

async function saveIfPending(view: TextFileView, adapter: Pick<VaultAdapter, "readBinary">): Promise<void> {
  const file = view.file;
  if (file === null) return;
  // Obsidian saves an editor about two seconds after the last keystroke. Until then the file on disk is the
  // old text, so a pull would take an unsaved edit for an unedited file and replace it without a copy.
  // A view whose text already equals the file is left alone: saving it would rewrite an untouched note.
  const onDisk = decoder.decode(await adapter.readBinary(file.path));
  if (view.getViewData() !== onDisk) await view.save();
}

/**
 * Save the pending content of every open text editor to its file. Rejects if any save fails, because a pull
 * that went on could overwrite an edit that never reached the disk. Other view types (canvas, images) are not
 * covered: they hold no text editor buffer.
 */
export async function flushOpenEditors(workspace: WorkspaceLike, adapter: Pick<VaultAdapter, "readBinary">): Promise<void> {
  const views: TextFileView[] = [];
  workspace.iterateAllLeaves((leaf) => {
    if (leaf.view instanceof TextFileView) views.push(leaf.view);
  });
  for (const view of views) await saveIfPending(view, adapter);
}
