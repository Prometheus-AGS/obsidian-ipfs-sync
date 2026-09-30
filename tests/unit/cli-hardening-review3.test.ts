import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProcessIo, stripControlCharacters } from "../../cli/io";
import { createNodeHostBridge } from "../../cli/node-host-bridge";

describe("W-11: local kv files are owner-only", () => {
  let root = "";
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates .ipfs-sync 0700 and each file 0600", async () => {
    root = await mkdtemp(join(tmpdir(), "ipfs-sync-kv-"));
    const host = createNodeHostBridge({ root });
    await host.kv.set("state.json", new TextEncoder().encode("{}"));
    expect((await stat(join(root, ".ipfs-sync"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, ".ipfs-sync", "state.json"))).mode & 0o777).toBe(0o600);
  });

  it("tightens a directory and a stale temp file that were created with looser modes", async () => {
    root = await mkdtemp(join(tmpdir(), "ipfs-sync-kv-"));
    const dir = join(root, ".ipfs-sync");
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);
    await writeFile(join(dir, `.journal.json.${process.pid}.tmp`), "old", { mode: 0o644 });
    const host = createNodeHostBridge({ root });
    await host.kv.set("journal.json", new TextEncoder().encode("{}"));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "journal.json"))).mode & 0o777).toBe(0o600);
    expect(await host.kv.list("")).toEqual(["journal.json"]);
  });
});

describe("W-13: control characters never reach the terminal", () => {
  it("replaces newlines, escapes and C1 controls", () => {
    expect(stripControlCharacters("bad\nwarning: forged\u001b[31m\u0085\u007f")).toBe("bad?warning: forged?[31m??");
    expect(stripControlCharacters("plain text: ok")).toBe("plain text: ok");
  });

  it("io.err applies it once to what it writes", () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    try {
      createProcessIo().err("ipfs-sync: publish failed: HTTP 500: x\r\nwarning: forged\u001b]0;title\u0007");
    } finally {
      spy.mockRestore();
    }
    expect(written).toEqual(["ipfs-sync: publish failed: HTTP 500: x??warning: forged?]0;title?\n"]);
  });
});
