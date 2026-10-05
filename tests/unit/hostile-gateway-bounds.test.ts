import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as nodeHttp from "node:http";
import * as nodeHttps from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedEndpoint } from "../../src/core/config";
import { createKuboClient, type Transport } from "../../src/kubo";
import { createNodeTransport } from "../../src/plugin/node-transport";
import { RangedSourceRefusal, createRangedBlobSources, probeSizeClasses, type GatewayBlobLocation } from "../../src/sync/blob-source";
import { sizeClassOf, blobsPerSizeClass } from "../../src/sync/pull-budget";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const CID = "bafyroot000000000000";
/** The hostile gateway may have this much in flight toward us before the abort lands: socket buffers plus one read-ahead chunk. */
const STREAM_BYTE_BUDGET = 4 * MIB;

const location = (name: string, totalLength: number): GatewayBlobLocation => ({ cid: CID, path: `ab/${name}`, totalLength });

describe("size classes", () => {
  it("buckets by floor(log2(length)) and keeps the smallest blob of each class, ascending", () => {
    expect(sizeClassOf(1)).toBe(0);
    expect(sizeClassOf(2 ** 20)).toBe(20);
    expect(sizeClassOf(2 ** 20 - 1)).toBe(19);
    const picked = blobsPerSizeClass([location("a", 3 * MIB), location("b", 100), location("c", 2 * MIB + 5), location("d", 120), location("e", 3 * GIB)]);
    expect(picked.map((blob) => blob.path)).toEqual(["ab/b", "ab/c", "ab/e"]);
    expect(blobsPerSizeClass([])).toEqual([]);
  });
});

describe("probing every size class", () => {
  it("probes each class once, smallest first, and stops at the first Range-ignoring answer", async () => {
    const seen: string[] = [];
    const sources = {
      state: (): "unprobed" | "honoured" | "ignored" => (seen.length >= 2 ? "ignored" : "honoured"),
      probe: async (blob: GatewayBlobLocation): Promise<unknown> => {
        seen.push(blob.path);
        return undefined;
      },
    };
    const sent = await probeSizeClasses(sources, [location("big", 3 * GIB), location("small", 100), location("mid", 5 * MIB), location("huge", 9 * GIB)]);
    expect(seen).toEqual(["ab/small", "ab/mid"]);
    expect(sent).toBe(2);
  });

  it("sends every class probe when the gateway keeps honouring Range", async () => {
    const seen: string[] = [];
    const sources = {
      state: (): "honoured" => "honoured",
      probe: async (blob: GatewayBlobLocation): Promise<unknown> => {
        seen.push(blob.path);
        return undefined;
      },
    };
    expect(await probeSizeClasses(sources, [location("a", 100), location("b", 5 * MIB), location("c", 5 * GIB)])).toBe(3);
    expect(seen).toEqual(["ab/a", "ab/b", "ab/c"]);
  });
});

interface Hostile {
  readonly endpoint: ResolvedEndpoint;
  readonly stats: { bytesWritten: number; requests: number; closed: number };
  readonly close: () => Promise<void>;
}

/** A gateway that honours Range for paths ending `/small` and ignores it (200, huge body) for every other path. */
async function startHostile(body: (response: ServerResponse, stats: Hostile["stats"]) => void): Promise<Hostile> {
  const stats = { bytesWritten: 0, requests: 0, closed: 0 };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    stats.requests += 1;
    response.on("close", () => {
      stats.closed += 1;
    });
    if (request.url?.endsWith("/small") === true) {
      response.writeHead(206, { "Content-Range": "bytes 0-21/100", "Content-Length": "22" });
      response.end(Buffer.alloc(22));
      return;
    }
    response.writeHead(200);
    body(response, stats);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: { name: "gateway", baseUrl: `http://127.0.0.1:${port}`, auth: { kind: "none" } },
    stats,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

/** Writes 64 KiB chunks for as long as the peer reads; stops when the socket is gone. */
function flood(response: ServerResponse, stats: Hostile["stats"]): void {
  const chunk = Buffer.alloc(64 * 1024, 7);
  const pump = (): void => {
    while (!response.destroyed) {
      stats.bytesWritten += chunk.length;
      if (!response.write(chunk)) {
        response.once("drain", pump);
        return;
      }
    }
  };
  pump();
}

/** One byte every 2 ms, ignoring Range. */
function drip(response: ServerResponse, stats: Hostile["stats"]): void {
  const timer = setInterval(() => {
    if (response.destroyed) {
      clearInterval(timer);
      return;
    }
    stats.bytesWritten += 1;
    response.write("x");
  }, 2);
  response.on("close", () => clearInterval(timer));
}

const nodeModules = { http: nodeHttp, https: nodeHttps };
const refusedFallback: Transport = Object.assign(
  async (): Promise<Response> => {
    throw new Error("fallback transport must not be used for this request");
  },
  { transportName: "fallback" },
);

describe("hostile gateway under the desktop streaming transport", () => {
  let hostile: Hostile | undefined;
  afterEach(async () => {
    await hostile?.close();
    hostile = undefined;
  });

  function clientFor(endpoint: ResolvedEndpoint, transport: Transport) {
    return createKuboClient({ rpc: endpoint, gateway: endpoint, transport });
  }

  it("a multi-GiB full body for a 22-byte header request is cut off after the probe margin, not buffered", async () => {
    hostile = await startHostile(flood);
    const sources = createRangedBlobSources(clientFor(hostile.endpoint, createNodeTransport({ fallback: refusedFallback, node: nodeModules })));
    const state = await sources.probe(location("large", 10 * GIB));
    expect(state).toBe("ignored");
    await expect(sources.source(location("large", 10 * GIB)).chunks[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(RangedSourceRefusal);
    expect(hostile.stats.bytesWritten).toBeLessThan(STREAM_BYTE_BUDGET);
    await expect.poll(() => hostile?.stats.closed).toBe(1);
  });

  it("honours Range for the smallest class, then stops probing at the first larger class that ignores it", async () => {
    hostile = await startHostile(flood);
    const sources = createRangedBlobSources(clientFor(hostile.endpoint, createNodeTransport({ fallback: refusedFallback, node: nodeModules })));
    const blobs = [location("large", 10 * GIB), location("small", 100), location("larger", 20 * GIB), location("huge", 40 * GIB)];
    const sent = await probeSizeClasses(sources, blobs);
    expect(sent).toBe(2);
    expect(sources.state()).toBe("ignored");
    expect(hostile.stats.requests).toBe(2);
    expect(hostile.stats.bytesWritten).toBeLessThan(STREAM_BYTE_BUDGET);
  });

  it("a slow drip that ignores Range is refused after the margin has arrived (about 90 bytes), not after the body", async () => {
    hostile = await startHostile(drip);
    const sources = createRangedBlobSources(clientFor(hostile.endpoint, createNodeTransport({ fallback: refusedFallback, node: nodeModules })));
    expect(await sources.probe(location("large", 10 * GIB))).toBe("ignored");
    expect(hostile.stats.bytesWritten).toBeLessThan(400);
    await expect.poll(() => hostile?.stats.closed).toBe(1);
  });

  it("a request without a Range header, or a non-GET, also goes through Node, never to the fallback transport", async () => {
    hostile = await startHostile((response) => {
      response.end("ok");
    });
    const calls: string[] = [];
    const fallback: Transport = Object.assign(async (): Promise<Response> => {
      calls.push("fallback");
      return new Response("ok", { status: 200 });
    }, { transportName: "fallback" });
    const transport = createNodeTransport({ fallback, node: nodeModules });
    await (await transport(`${hostile.endpoint.baseUrl}/x`, { method: "GET" })).text();
    await (await transport(`${hostile.endpoint.baseUrl}/x`, { method: "POST", headers: { Range: "bytes=0-1" } })).text();
    expect(calls).toEqual([]);
    expect(hostile.stats.requests).toBe(2);
  });

  it("without Node modules (mobile, or require unavailable) every request goes to the fallback", async () => {
    const calls: string[] = [];
    const fallback: Transport = Object.assign(async (): Promise<Response> => {
      calls.push("fallback");
      return new Response("ok", { status: 200 });
    }, { transportName: "fallback" });
    const transport = createNodeTransport({ fallback, node: undefined });
    await transport("http://127.0.0.1:1/x", { method: "GET", headers: { Range: "bytes=0-1" } });
    expect(calls).toEqual(["fallback"]);
  });
});
