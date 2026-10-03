// mvp-07a final review A-05: the local file is looked at again after the conflict copy is read and before the copy is renamed
// into place. An edit saved in between is in neither the copy nor (after the replace) the vault, so the copy is redone once
// and, if the file changes again, the replace is abandoned with the local file untouched.
import { describe, expect, it } from "vitest";
import { CONFLICT_COPY_FAILED_REASON, createConflictReservations, preserveLocalCopy, tryPreserveLocalCopy, type PreserveContext } from "../../src/sync/pull-conflict";
import { createMemoryHost, type MemoryHost } from "../helpers/memory-host";
import { decode } from "../helpers/pull-fixtures";

const DATE = "2026-10-03";

function context(host: MemoryHost, fs: PreserveContext["fs"] = host.fs): PreserveContext {
  let counter = 0;
  return { fs, newId: () => `id${(counter += 1)}`, dateStamp: DATE, reserved: createConflictReservations(["note.md"]) };
}

/** A file system whose first `edits.length` reads of `note.md` are followed by a save of the next text (so the read bytes are already stale). */
function editedAfterRead(host: MemoryHost, edits: readonly string[]): { readonly fs: PreserveContext["fs"]; readonly reads: () => number } {
  let reads = 0;
  const fs: PreserveContext["fs"] = {
    ...host.fs,
    read: async (path) => {
      const data = await host.fs.read(path);
      if (path === "note.md") {
        const next = edits[reads];
        reads += 1;
        if (next !== undefined) host.put("note.md", next, 100 + reads);
      }
      return data;
    },
  };
  return { fs, reads: () => reads };
}

describe("the conflict copy is redone once when the local file changes while it is read", () => {
  it("an edit saved after the read ends up in the copy, and the original is untouched", async () => {
    const host = createMemoryHost();
    host.put("note.md", "first text", 10);
    const racing = editedAfterRead(host, ["edited while the copy was being read"]);

    const copy = await preserveLocalCopy(context(host, racing.fs), "note.md");

    expect(decode(host.files.get(copy)?.data)).toBe("edited while the copy was being read");
    expect(decode(host.files.get("note.md")?.data)).toBe("edited while the copy was being read");
    expect(racing.reads()).toBe(2);
    expect([...host.files.keys()].filter((path) => path.startsWith(".ipfs-sync/tmp/"))).toEqual([]);
  });

  it("an unchanged file is read once", async () => {
    const host = createMemoryHost();
    host.put("note.md", "stable", 10);
    const racing = editedAfterRead(host, []);

    const copy = await preserveLocalCopy(context(host, racing.fs), "note.md");

    expect(decode(host.files.get(copy)?.data)).toBe("stable");
    expect(racing.reads()).toBe(1);
  });

  it("a file that changes again during the second read is not copied: no copy, no temp file, the local file is as the user left it", async () => {
    const host = createMemoryHost();
    host.put("note.md", "first text", 10);
    const racing = editedAfterRead(host, ["second text", "third text, longer"]);

    const result = await tryPreserveLocalCopy(context(host, racing.fs), "note.md");

    expect(result).toMatchObject({ ok: false, reason: CONFLICT_COPY_FAILED_REASON });
    expect(decode(host.files.get("note.md")?.data)).toBe("third text, longer");
    expect([...host.files.keys()]).toEqual(["note.md"]);
    expect(racing.reads()).toBe(2);
  });

  it("a change of modification time alone, with the same size, is also seen", async () => {
    const host = createMemoryHost();
    host.put("note.md", "same size 1", 10);
    const racing = editedAfterRead(host, ["same size 2"]);

    const copy = await preserveLocalCopy(context(host, racing.fs), "note.md");

    expect(decode(host.files.get(copy)?.data)).toBe("same size 2");
  });
});
