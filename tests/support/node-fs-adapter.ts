import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VaultAdapter } from "../../src/plugin/obsidian-fs";

/**
 * A `VaultAdapter` over a real directory, shaped like Obsidian's desktop adapter (root spelled "/",
 * results relative to the vault root). Lets a test run the CLI host and the plugin host over the very
 * same files.
 */
export function createNodeFsAdapter(root: string): VaultAdapter {
  const at = (path: string): string => join(root, path === "/" ? "" : path);
  return {
    stat: async (path) => {
      try {
        const info = await stat(at(path));
        return { type: info.isDirectory() ? "folder" : "file", mtime: info.mtimeMs, size: info.size };
      } catch {
        return null;
      }
    },
    list: async (path) => {
      const base = path === "/" ? "" : path;
      const entries = await readdir(at(path), { withFileTypes: true });
      const full = (name: string): string => (base === "" ? name : `${base}/${name}`);
      return {
        files: entries.filter((e) => e.isFile()).map((e) => full(e.name)),
        folders: entries.filter((e) => e.isDirectory()).map((e) => full(e.name)),
      };
    },
    readBinary: async (path) => {
      const bytes = await readFile(at(path));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
    writeBinary: async (path, data) => writeFile(at(path), new Uint8Array(data)),
    appendBinary: async (path, data) => appendFile(at(path), new Uint8Array(data)),
    mkdir: async (path) => {
      await mkdir(at(path));
    },
    remove: async (path) => rm(at(path)),
    rename: async (from, to) => rename(at(from), at(to)),
  };
}
