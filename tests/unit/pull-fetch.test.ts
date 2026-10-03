import { describe, expect, it } from "vitest";
import { GatewayRangeError, PathRefusedError, SymlinkRefusedError, TEMP_DIR, VerificationError, commitStaged, stageVerified, sweepTemp, type FetchContext } from "../../src/sync/pull-fetch";
import { createFakeGateway, type FakeGateway } from "../helpers/fake-gateway";
import { createMemoryHost, type MemoryHost } from "../helpers/memory-host";
import { FAKE_CID, decode, encode, sha } from "../helpers/pull-fixtures";

interface Setup {
  readonly host: MemoryHost;
  readonly gateway: FakeGateway;
  readonly ctx: FetchContext;
}

function setup(options: Parameters<typeof createFakeGateway>[0] = {}): Setup {
  const host = createMemoryHost();
  const gateway = createFakeGateway(options);
  let counter = 0;
  return { host, gateway, ctx: { client: gateway.client, fs: host.fs, newId: () => `t${(counter += 1)}` } };
}

async function entryFor(data: Uint8Array): Promise<{ sha256: string; size: number; cid: string }> {
  return { sha256: await sha(data), size: data.length, cid: FAKE_CID };
}

const tempFiles = (host: MemoryHost): string[] => [...host.files.keys()].filter((path) => path.startsWith(`${TEMP_DIR}/`));

describe("stageVerified and commitStaged", () => {
  it("streams to a temp file, verifies, and renames onto the destination", async () => {
    const { host, gateway, ctx } = setup();
    const data = encode("hello verified world, longer than one seven byte chunk");
    gateway.objects.set(`${FAKE_CID}/notes/a.md`, data);
    const temp = await stageVerified(ctx, FAKE_CID, "notes/a.md", await entryFor(data));
    expect(temp.startsWith(`${TEMP_DIR}/`)).toBe(true);
    expect(host.files.has("notes/a.md")).toBe(false);
    const mtime = await commitStaged(ctx, temp, "notes/a.md");
    expect(decode(host.files.get("notes/a.md")?.data)).toBe(decode(data));
    expect(mtime).toBe(host.files.get("notes/a.md")?.mtimeMs);
    expect(tempFiles(host)).toEqual([]);
  });

  it("creates an empty file for an empty manifest entry", async () => {
    const { host, gateway, ctx } = setup();
    gateway.objects.set(`${FAKE_CID}/empty.md`, new Uint8Array());
    const temp = await stageVerified(ctx, FAKE_CID, "empty.md", await entryFor(new Uint8Array()));
    await commitStaged(ctx, temp, "empty.md");
    expect(host.files.get("empty.md")?.data.length).toBe(0);
  });

  it("leaves the destination unchanged and no temp file on a hash mismatch", async () => {
    const { host, gateway, ctx } = setup();
    const data = encode("the real bytes");
    host.put("a.md", "local original", 5);
    gateway.objects.set(`${FAKE_CID}/a.md`, data);
    gateway.corrupt = /a\.md/;
    await expect(stageVerified(ctx, FAKE_CID, "a.md", await entryFor(data))).rejects.toThrowError(VerificationError);
    expect(decode(host.files.get("a.md")?.data)).toBe("local original");
    expect(tempFiles(host)).toEqual([]);
  });

  it("fails a truncated body as a size failure and leaves nothing", async () => {
    const { host, gateway, ctx } = setup();
    const data = encode("0123456789abcdef");
    gateway.objects.set(`${FAKE_CID}/a.md`, data);
    gateway.truncate = /a\.md/;
    await expect(stageVerified(ctx, FAKE_CID, "a.md", await entryFor(data))).rejects.toThrowError(/received 13 bytes, manifest lists 16/);
    expect(host.files.has("a.md")).toBe(false);
    expect(tempFiles(host)).toEqual([]);
  });

  it("stops a body longer than the manifest size", async () => {
    const { host, gateway, ctx } = setup();
    gateway.objects.set(`${FAKE_CID}/a.md`, encode("far too long for the entry"));
    const entry = { sha256: await sha("short"), size: 5, cid: FAKE_CID };
    await expect(stageVerified(ctx, FAKE_CID, "a.md", entry)).rejects.toThrowError(/more than the 5 bytes/);
    expect(tempFiles(host)).toEqual([]);
  });

  it("removes the temp file when the stream is interrupted", async () => {
    const { host, gateway, ctx } = setup();
    const data = encode("an interrupted transfer of some length");
    gateway.objects.set(`${FAKE_CID}/a.md`, data);
    gateway.breakStream = /a\.md/;
    await expect(stageVerified(ctx, FAKE_CID, "a.md", await entryFor(data))).rejects.toThrowError(/connection reset/);
    expect(host.files.has("a.md")).toBe(false);
    expect(tempFiles(host)).toEqual([]);
  });

  it("removes the temp file when the rename fails", async () => {
    const { host, gateway, ctx } = setup();
    const data = encode("payload");
    gateway.objects.set(`${FAKE_CID}/a.md`, data);
    const temp = await stageVerified(ctx, FAKE_CID, "a.md", await entryFor(data));
    host.failOn.rename = /a\.md/;
    await expect(commitStaged(ctx, temp, "a.md")).rejects.toThrowError(/injected rename failure/);
    expect(tempFiles(host)).toEqual([]);
    expect(host.files.has("a.md")).toBe(false);
  });
});

describe("symlinks", () => {
  it("refuses a symlink destination before any request and touches nothing", async () => {
    const { host, gateway, ctx } = setup();
    host.put("notes/a.md", "target text", 5);
    host.link("notes/a.md");
    const before = host.mutations.length;
    await expect(stageVerified(ctx, FAKE_CID, "notes/a.md", { sha256: await sha("x"), size: 1, cid: FAKE_CID })).rejects.toThrowError(SymlinkRefusedError);
    expect(gateway.requests).toEqual([]);
    expect(host.mutations.length).toBe(before);
    expect(decode(host.files.get("notes/a.md")?.data)).toBe("target text");
  });

  it("refuses a symlinked directory component", async () => {
    const { host, gateway, ctx } = setup();
    host.link("linked");
    await expect(stageVerified(ctx, FAKE_CID, "linked/x.md", { sha256: await sha("x"), size: 1, cid: FAKE_CID })).rejects.toThrowError(/"linked" is a symbolic link/);
    expect(gateway.requests).toEqual([]);
    expect(host.files.size).toBe(0);
  });

  it("re-checks at commit time and removes the temp file when a link appeared meanwhile", async () => {
    const { host, gateway, ctx } = setup();
    const data = encode("payload");
    gateway.objects.set(`${FAKE_CID}/dir/a.md`, data);
    const temp = await stageVerified(ctx, FAKE_CID, "dir/a.md", await entryFor(data));
    host.link("dir");
    await expect(commitStaged(ctx, temp, "dir/a.md")).rejects.toThrowError(SymlinkRefusedError);
    expect(tempFiles(host)).toEqual([]);
    expect(host.files.has("dir/a.md")).toBe(false);
  });
});

describe("large files", () => {
  const MIB = 1024 * 1024;

  it("reads a 40 MB file in ranges of at most 8 MB and verifies the hash", async () => {
    const { host, gateway, ctx } = setup({ chunkSize: MIB });
    const data = new Uint8Array(40 * MIB).map((_, index) => (index * 31 + 7) & 0xff);
    gateway.objects.set(`${FAKE_CID}/big.bin`, data);
    const temp = await stageVerified(ctx, FAKE_CID, "big.bin", await entryFor(data));
    await commitStaged(ctx, temp, "big.bin");
    expect(gateway.ranges).toHaveLength(5);
    expect(Math.max(...gateway.ranges.map(([, length]) => length))).toBeLessThanOrEqual(8 * MIB);
    expect(gateway.ranges.map(([start]) => start)).toEqual([0, 8, 16, 24, 32].map((n) => n * MIB));
    expect(await sha(host.files.get("big.bin")?.data ?? new Uint8Array())).toBe(await sha(data));
  }, 60_000);

  it("falls back to one whole stream when the gateway ignores Range", async () => {
    const { host, gateway, ctx } = setup({ chunkSize: 4 * MIB, honourRange: false });
    const data = new Uint8Array(33 * MIB).map((_, index) => index & 0xff);
    gateway.objects.set(`${FAKE_CID}/big.bin`, data);
    const temp = await stageVerified(ctx, FAKE_CID, "big.bin", await entryFor(data));
    await commitStaged(ctx, temp, "big.bin");
    expect(gateway.requests.filter((r) => r.startsWith("GET"))).toHaveLength(1);
    expect(await sha(host.files.get("big.bin")?.data ?? new Uint8Array())).toBe(await sha(data));
  }, 60_000);

  it("fails when a later range is answered without partial content", async () => {
    const { host, ctx } = setup();
    const contexts = { ...ctx, client: { gatewayStream: async (_cid: string, _path?: string, range?: { start: number; length: number }) => ({ status: range?.start === 0 ? 206 : 200, contentRange: undefined, chunks: (async function* () { yield new Uint8Array(8 * MIB); })() }) } };
    const entry = { sha256: await sha("x"), size: 33 * MIB, cid: FAKE_CID };
    await expect(stageVerified(contexts, FAKE_CID, "big.bin", entry)).rejects.toThrowError(GatewayRangeError);
    expect(tempFiles(host)).toEqual([]);
  });
});

describe("sweepTemp", () => {
  it("removes leftovers of an earlier run and reports how many", async () => {
    const { host } = setup();
    host.put(`${TEMP_DIR}/old1.part`, "x");
    host.put(`${TEMP_DIR}/old2.part`, "y");
    host.put("notes/keep.md", "keep");
    expect(await sweepTemp(host.fs)).toBe(2);
    expect(tempFiles(host)).toEqual([]);
    expect(host.files.has("notes/keep.md")).toBe(true);
    expect(await sweepTemp(host.fs)).toBe(0);
  });
});

describe("the write-time path policy (B2-01)", () => {
  it.each(["OBSIDI~1/plugins/p/main.js", `.obs${String.fromCodePoint(0x131)}dian/plugins/p/main.js`, ".obsidian./community-plugins.json", "CON.md", "a:b"])(
    "refuses %j before a byte is requested or written",
    async (path) => {
      const { host, gateway, ctx } = setup();
      const data = encode("code");
      gateway.objects.set(`${FAKE_CID}/${path}`, data);
      await expect(stageVerified(ctx, FAKE_CID, path, await entryFor(data))).rejects.toBeInstanceOf(PathRefusedError);
      expect(host.files.size).toBe(0);
    },
  );

  it("refuses at commit when a path is policy-refused, removing the staged temp file", async () => {
    const { host, gateway, ctx } = setup();
    const data = encode("ok");
    gateway.objects.set(`${FAKE_CID}/a.md`, data);
    const temp = await stageVerified(ctx, FAKE_CID, "a.md", await entryFor(data));
    await expect(commitStaged(ctx, temp, "CON.md")).rejects.toBeInstanceOf(PathRefusedError);
    expect(host.files.has("CON.md")).toBe(false);
    expect(tempFiles(host)).toEqual([]);
  });
});
