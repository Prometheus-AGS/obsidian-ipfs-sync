import { describe, expect, it } from "vitest";
import type { ResolvedEndpoint } from "../../src/core/config";
import { RPC_RESPONSE_MAX_BYTES } from "../../src/kubo/rpc-call";
import { KuboResponseTooLargeError, MFS_LIST_MAX_ENTRIES, MFS_RESPONSE_MAX_BYTES, createKuboClient, rpcCall, type Transport } from "../../src/kubo";

const RPC: ResolvedEndpoint = { name: "rpc", baseUrl: "https://rpc.example.org:5001", auth: { kind: "none" } };
const GATEWAY: ResolvedEndpoint = { name: "gateway", baseUrl: "https://gw.example.org", auth: { kind: "none" } };

const always = (make: () => Response): Transport => async () => make();

const entry = (index: number): string => JSON.stringify({ Name: `n${index}`, Type: 0, Size: 1, Hash: "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });

/** A body that keeps producing bytes until it is cancelled, and records that it was. */
function endlessBody(seen: { cancelled: boolean; pulled: number }): Response {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      seen.pulled += 1;
      controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return new Response(body);
}

describe("rpcCall: maxResponseBytes", () => {
  it("refuses a response whose declared length is above the limit without reading it", async () => {
    let read = false;
    const transport = always(() => {
      const response = new Response("{}", { headers: { "content-length": "5000" } });
      const text = response.text.bind(response);
      response.text = async () => ((read = true), text());
      return response;
    });
    const failure = await rpcCall({ endpoint: RPC, command: "files/stat", transport, maxResponseBytes: 1000 }, "json").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KuboResponseTooLargeError);
    expect(read).toBe(false);
  });

  it("cuts off a body that keeps streaming past the limit, and cancels it", async () => {
    const seen = { cancelled: false, pulled: 0 };
    const failure = await rpcCall({ endpoint: RPC, command: "files/ls", transport: always(() => endlessBody(seen)), maxResponseBytes: 1024 * 1024 }, "text").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KuboResponseTooLargeError);
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled).toBeLessThan(40);
  });

  it("accepts a body of exactly the limit and reads it whole", async () => {
    const body = "x".repeat(2048);
    expect(await rpcCall({ endpoint: RPC, command: "x", transport: always(() => new Response(body)), maxResponseBytes: 2048 }, "text")).toBe(body);
    await expect(rpcCall({ endpoint: RPC, command: "x", transport: always(() => new Response(`${body}x`)), maxResponseBytes: 2048 }, "text")).rejects.toBeInstanceOf(KuboResponseTooLargeError);
  });

  it("applies the 64 KiB default to a call that does not ask for a limit", async () => {
    const body = "y".repeat(RPC_RESPONSE_MAX_BYTES);
    expect((await rpcCall({ endpoint: RPC, command: "x", transport: always(() => new Response(body)) }, "text")).length).toBe(body.length);
    await expect(rpcCall({ endpoint: RPC, command: "x", transport: always(() => new Response(`${body}y`)) }, "text")).rejects.toBeInstanceOf(KuboResponseTooLargeError);
  });
});

describe("files/ls and files/stat responses are capped at 1 MiB and 2,000 entries", () => {
  const client = (respond: () => Response) => createKuboClient({ rpc: RPC, gateway: GATEWAY, transport: always(respond) });

  it("lists up to 2,000 entries", async () => {
    const lines = Array.from({ length: MFS_LIST_MAX_ENTRIES }, (_, index) => entry(index)).join("\n");
    expect(await client(() => new Response(lines)).filesLs("/obsidian-vault-sync/x")).toHaveLength(MFS_LIST_MAX_ENTRIES);
  });

  it("refuses a listing of 5,000 entries", async () => {
    const lines = Array.from({ length: 5000 }, (_, index) => entry(index)).join("\n");
    await expect(client(() => new Response(lines)).filesLs("/obsidian-vault-sync/x")).rejects.toBeInstanceOf(KuboResponseTooLargeError);
  });

  it("refuses a listing larger than 1 MiB", async () => {
    const seen = { cancelled: false, pulled: 0 };
    await expect(client(() => endlessBody(seen)).filesLs("/obsidian-vault-sync/x")).rejects.toBeInstanceOf(KuboResponseTooLargeError);
    expect(seen.cancelled).toBe(true);
  });

  it("refuses an oversize stat answer", async () => {
    const huge = JSON.stringify({ Hash: "bafk", Size: 1, CumulativeSize: 1, Type: "file", Padding: "z".repeat(MFS_RESPONSE_MAX_BYTES) });
    await expect(client(() => new Response(huge)).filesStat("/obsidian-vault-sync/x")).rejects.toBeInstanceOf(KuboResponseTooLargeError);
  });

  it("reads an ordinary stat answer", async () => {
    const stat = await client(() => new Response(JSON.stringify({ Hash: "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Size: 12, CumulativeSize: 12, Type: "file" }))).filesStat("/obsidian-vault-sync/x");
    expect(stat).toMatchObject({ size: 12, type: "file" });
  });
});

describe("ipfsLs: the children of an immutable directory", () => {
  const client = (respond: () => Response) => createKuboClient({ rpc: RPC, gateway: GATEWAY, transport: always(respond) });
  const link = (index: number, type: number) => ({ Name: `n${index}`, Hash: "bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Size: 7, Type: type, Target: "" });

  it("sends the path in the query string and maps names, kinds, sizes and CIDs (directories are types 1 and 5)", async () => {
    let seen: URL | undefined;
    const transport: Transport = async (url) => {
      seen = new URL(url);
      return new Response(JSON.stringify({ Objects: [{ Hash: "bafyroot", Links: [link(0, 1), link(1, 5), link(2, 2), link(3, 0)] }] }));
    };
    const entries = await createKuboClient({ rpc: RPC, gateway: GATEWAY, transport }).ipfsLs("/ipfs/bafyroot/current");
    expect(seen?.pathname).toBe("/api/v0/ls");
    expect(seen?.searchParams.get("arg")).toBe("/ipfs/bafyroot/current");
    expect(entries.map((entry) => [entry.name, entry.type, entry.size])).toEqual([["n0", "directory", 7], ["n1", "directory", 7], ["n2", "file", 7], ["n3", "file", 7]]);
  });

  it("reads an empty directory (Links null) as no entries", async () => {
    expect(await client(() => new Response(JSON.stringify({ Objects: [{ Hash: "bafyroot", Links: null }] }))).ipfsLs("/ipfs/bafyroot")).toEqual([]);
  });

  it("refuses more than 2,000 links and a response above 1 MiB", async () => {
    const many = { Objects: [{ Hash: "x", Links: Array.from({ length: 2001 }, (_, index) => link(index, 2)) }] };
    await expect(client(() => new Response(JSON.stringify(many))).ipfsLs("/ipfs/x")).rejects.toBeInstanceOf(KuboResponseTooLargeError);
    const seen = { cancelled: false, pulled: 0 };
    await expect(client(() => endlessBody(seen)).ipfsLs("/ipfs/x")).rejects.toBeInstanceOf(KuboResponseTooLargeError);
  });
});
