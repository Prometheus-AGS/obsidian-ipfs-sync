import type { VaultAdapter } from "../../src/plugin/obsidian-fs";

interface StoredFile {
  data: ArrayBuffer;
  mtime: number;
}

/**
 * An in-memory stand-in for Obsidian's `DataAdapter`. Deliberately strict: writes and mkdir fail when the
 * parent folder is missing, and the root is spelled "/", so the bridge cannot rely on friendlier behaviour.
 * Every `readBinary` is recorded so tests can assert that only requested files were read.
 */
export class MemoryAdapter implements VaultAdapter {
  readonly files = new Map<string, StoredFile>();
  readonly folders = new Set<string>();
  readonly reads: string[] = [];
  readonly calls: string[] = [];
  clock = 1_700_000_000_000;

  /** Test helper: create a file (and its folders). */
  put(path: string, content: string | Uint8Array, mtime = this.clock): void {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.ensure(path.split("/").slice(0, -1).join("/"));
    this.files.set(path, { data: Uint8Array.from(bytes).buffer, mtime });
  }

  text(path: string): string | undefined {
    const file = this.files.get(path);
    return file === undefined ? undefined : new TextDecoder().decode(file.data);
  }

  private ensure(folder: string): void {
    const parts = folder.split("/").filter((part) => part !== "");
    for (let index = 1; index <= parts.length; index += 1) this.folders.add(parts.slice(0, index).join("/"));
  }

  private hasParent(path: string): boolean {
    const parent = path.split("/").slice(0, -1).join("/");
    return parent === "" || this.folders.has(parent);
  }

  async stat(path: string): Promise<{ type: "file" | "folder"; mtime: number; size: number } | null> {
    this.calls.push(`stat ${path}`);
    const file = this.files.get(path);
    if (file !== undefined) return { type: "file", mtime: file.mtime, size: file.data.byteLength };
    return this.folders.has(path) ? { type: "folder", mtime: this.clock, size: 0 } : null;
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    this.calls.push(`list ${path}`);
    const prefix = path === "/" ? "" : `${path}/`;
    const direct = (candidate: string): boolean => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/");
    return { files: [...this.files.keys()].filter(direct), folders: [...this.folders].filter(direct) };
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    this.reads.push(path);
    const file = this.files.get(path);
    if (file === undefined) throw new Error(`ENOENT ${path}`);
    return file.data.slice(0);
  }

  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.calls.push(`write ${path}`);
    if (!this.hasParent(path)) throw new Error(`ENOENT parent of ${path}`);
    this.files.set(path, { data: data.slice(0), mtime: this.clock });
  }

  async appendBinary(path: string, data: ArrayBuffer): Promise<void> {
    const file = this.files.get(path);
    if (file === undefined) throw new Error(`ENOENT ${path}`);
    const merged = new Uint8Array(file.data.byteLength + data.byteLength);
    merged.set(new Uint8Array(file.data));
    merged.set(new Uint8Array(data), file.data.byteLength);
    this.files.set(path, { data: merged.buffer, mtime: this.clock });
  }

  async mkdir(path: string): Promise<void> {
    this.calls.push(`mkdir ${path}`);
    if (!this.hasParent(path)) throw new Error(`ENOENT parent of ${path}`);
    this.folders.add(path);
  }

  async remove(path: string): Promise<void> {
    this.calls.push(`remove ${path}`);
    if (!this.files.delete(path)) throw new Error(`ENOENT ${path}`);
  }

  async rename(path: string, newPath: string): Promise<void> {
    this.calls.push(`rename ${path} ${newPath}`);
    const file = this.files.get(path);
    if (file === undefined) throw new Error(`ENOENT ${path}`);
    if (this.files.has(newPath)) throw new Error(`EEXIST ${newPath}`);
    this.files.delete(path);
    this.files.set(newPath, file);
  }
}
