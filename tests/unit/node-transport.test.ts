import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as nodeHttp from "node:http";
import * as nodeHttps from "node:https";
import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedEndpoint } from "../../src/core/config";
import { KuboNetworkError, KuboResponseTooLargeError, createKuboClient, rpcCall, type Transport } from "../../src/kubo";
import { REDIRECT_REFUSED_MESSAGE } from "../../src/kubo/http";
import { buildMultipart } from "../../src/kubo/multipart";
import { TLS_FAILURE_MESSAGE, createNodeTransport, type NodeModules } from "../../src/plugin/node-transport";
import { pluginTransport } from "../../src/plugin/request-url-transport";
import { Platform, requestUrlCalls, resetRequestUrl, setRequestUrlHandler, stubResponse } from "../support/obsidian-stub";

const nodeModules: NodeModules = { http: nodeHttp, https: nodeHttps };
const refusedFallback: Transport = Object.assign(
  async (): Promise<Response> => {
    throw new Error("fallback transport must not be used for this request");
  },
  { transportName: "fallback" },
);
const CID = "bafkreiaaaaaaaaaaaaaaaaaa";

interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage["headers"];
  readonly body: Buffer;
}

interface Local {
  readonly baseUrl: string;
  readonly seen: Seen[];
  readonly stats: { bytesWritten: number };
  readonly close: () => Promise<void>;
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse, seen: Seen) => void): Promise<Local> {
  const seen: Seen[] = [];
  const stats = { bytesWritten: 0 };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry: Seen = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) };
      seen.push(entry);
      handler(request, response, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const endpointOf = (baseUrl: string): ResolvedEndpoint => ({ name: "rpc", baseUrl, auth: { kind: "bearer", token: "tok-secret" } });
const nodeOnly = (): Transport => createNodeTransport({ fallback: refusedFallback, node: nodeModules });

describe("node transport", () => {
  const open: Local[] = [];
  const start = async (handler: Parameters<typeof listen>[0]): Promise<Local> => {
    const local = await listen(handler);
    open.push(local);
    return local;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((local) => local.close()));
  });

  for (const status of [301, 302, 303, 307, 308]) {
    it(`refuses a ${status} on a POST: the redirector sees one request, the target none, and the call fails with the fixed message`, async () => {
      const target = await start((_request, response) => {
        response.writeHead(200).end("{}");
      });
      const redirector = await start((_request, response) => {
        response.writeHead(status, { Location: `${target.baseUrl}/api/v0/key/list` }).end();
      });
      const client = createKuboClient({ rpc: endpointOf(redirector.baseUrl), gateway: endpointOf(redirector.baseUrl), transport: nodeOnly() });
      const failure = await client.keyList().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(KuboNetworkError);
      expect((failure as Error).message).toContain(REDIRECT_REFUSED_MESSAGE);
      expect((failure as Error).message).not.toContain(target.baseUrl);
      expect(redirector.seen).toHaveLength(1);
      expect(redirector.seen[0]?.method).toBe("POST");
      expect(target.seen).toHaveLength(0);
    });

    it(`refuses a ${status} on a GET: the redirector sees one request, the target none, and the call fails with the fixed message`, async () => {
      const target = await start((_request, response) => {
        response.writeHead(200).end("x");
      });
      const redirector = await start((_request, response) => {
        response.writeHead(status, { Location: `${target.baseUrl}/ipfs/${CID}` }).end();
      });
      const client = createKuboClient({ rpc: endpointOf(redirector.baseUrl), gateway: endpointOf(redirector.baseUrl), transport: nodeOnly() });
      const failure = await client.gatewayFetch(CID).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(KuboNetworkError);
      expect((failure as Error).message).toContain(REDIRECT_REFUSED_MESSAGE);
      expect(redirector.seen).toHaveLength(1);
      expect(redirector.seen[0]?.method).toBe("GET");
      expect(target.seen).toHaveLength(0);
    });
  }

  it("sends the credential only to the first URL", async () => {
    const target = await start((_request, response) => {
      response.writeHead(200).end("{}");
    });
    const redirector = await start((_request, response) => {
      response.writeHead(307, { Location: `${target.baseUrl}/x` }).end();
    });
    const client = createKuboClient({ rpc: endpointOf(redirector.baseUrl), gateway: endpointOf(redirector.baseUrl), transport: nodeOnly() });
    await client.keyList().catch(() => undefined);
    expect(redirector.seen[0]?.headers["authorization"]).toBe("Bearer tok-secret");
    expect(target.seen).toHaveLength(0);
  });

  it("delivers a JSON-less POST with Content-Length 0 and no chunked encoding", async () => {
    const local = await start((_request, response) => {
      response.writeHead(200).end('{"Keys":[]}');
    });
    const client = createKuboClient({ rpc: endpointOf(local.baseUrl), gateway: endpointOf(local.baseUrl), transport: nodeOnly() });
    expect(await client.keyList()).toEqual([]);
    expect(local.seen[0]?.headers["content-length"]).toBe("0");
    expect(local.seen[0]?.headers["transfer-encoding"]).toBeUndefined();
  });

  it("delivers a multipart body byte for byte with its boundary and Content-Length", async () => {
    const local = await start((_request, response) => {
      response.writeHead(200).end();
    });
    const payload = Uint8Array.from([0, 255, 13, 10, 45, 45, 1, 2, 3]);
    const multipart = buildMultipart("data", payload);
    await rpcCall({ endpoint: endpointOf(local.baseUrl), command: "files/write", body: multipart, transport: nodeOnly() }, "none");
    const got = local.seen[0];
    expect(got?.headers["content-type"]).toBe(multipart.contentType);
    expect(got?.headers["content-length"]).toBe(String(multipart.bytes.length));
    expect([...(got?.body ?? [])]).toEqual([...multipart.bytes]);
  });

  it("delivers string, Uint8Array (a view), and ArrayBuffer bodies byte for byte", async () => {
    const local = await start((_request, response) => {
      response.writeHead(200).end();
    });
    const transport = nodeOnly();
    const json = JSON.stringify({ a: "é" });
    const view = new Uint8Array([9, 9, 1, 2, 3, 9]).subarray(2, 5);
    await transport(`${local.baseUrl}/a`, { method: "POST", body: json, headers: { "content-type": "application/json" } });
    await transport(`${local.baseUrl}/b`, { method: "POST", body: view });
    await transport(`${local.baseUrl}/c`, { method: "POST", body: new Uint8Array([4, 5]).buffer });
    expect(local.seen[0]?.body.toString("utf8")).toBe(json);
    expect(local.seen[0]?.headers["content-length"]).toBe(String(Buffer.byteLength(json)));
    expect([...(local.seen[1]?.body ?? [])]).toEqual([1, 2, 3]);
    expect([...(local.seen[2]?.body ?? [])]).toEqual([4, 5]);
  });

  it("rejects a body type it cannot send with a typed error, never falling back", async () => {
    const calls: string[] = [];
    const fallback: Transport = Object.assign(async (): Promise<Response> => {
      calls.push("fallback");
      return new Response("x");
    }, { transportName: "fallback" });
    const transport = createNodeTransport({ fallback, node: nodeModules });
    const failure = await transport("http://127.0.0.1:1/x", { method: "POST", body: new Blob(["x"]) }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe("the node transport sends text or bytes only");
    expect(calls).toEqual([]);
  });

  it("a Range GET still returns the 206 answer and its headers", async () => {
    const local = await start((request, response) => {
      response.writeHead(206, { "Content-Range": "bytes 1-3/10" }).end(Buffer.from([11, 12, 13]));
      expect(request.headers["range"]).toBe("bytes=1-3");
    });
    const client = createKuboClient({ rpc: endpointOf(local.baseUrl), gateway: endpointOf(local.baseUrl), transport: nodeOnly() });
    const stream = await client.gatewayStream(CID, "current/a.bin", { start: 1, length: 3 });
    expect(stream.status).toBe(206);
    expect(stream.contentRange).toBe("bytes 1-3/10");
    const parts: number[] = [];
    for await (const chunk of stream.chunks) parts.push(...chunk);
    expect(parts).toEqual([11, 12, 13]);
  });

  it("an oversize RPC response is cut by the bounded reader long before the body is buffered", async () => {
    const local = await start((_request, response) => {
      response.writeHead(200);
      const chunk = Buffer.alloc(64 * 1024, 7);
      const pump = (): void => {
        while (!response.destroyed) {
          local.stats.bytesWritten += chunk.length;
          if (!response.write(chunk)) {
            response.once("drain", pump);
            return;
          }
        }
      };
      pump();
    });
    const failure = await rpcCall({ endpoint: endpointOf(local.baseUrl), command: "key/list", transport: nodeOnly() }, "text").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KuboResponseTooLargeError);
    expect(local.stats.bytesWritten).toBeLessThan(4 * 1024 * 1024);
  });

  it("names TLS trust in a fixed message and never echoes the node's text", async () => {
    const secret = "unable to verify the first certificate for host.internal";
    const failing: NodeModules = {
      http: nodeHttp,
      https: {
        request: () => {
          const handlers = new Map<string, (value: never) => void>();
          const outgoing = {
            on(event: string, listener: (value: never) => void) {
              handlers.set(event, listener);
              return outgoing;
            },
            end() {
              queueMicrotask(() => handlers.get("error")?.(Object.assign(new Error(secret), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) as never));
            },
            write() {},
            destroy() {},
          };
          return outgoing;
        },
      },
    };
    const transport = createNodeTransport({ fallback: refusedFallback, node: failing });
    const client = createKuboClient({ rpc: endpointOf("https://tls.example.org:5001"), gateway: endpointOf("https://tls.example.org"), transport });
    const failure = await client.keyList().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KuboNetworkError);
    expect((failure as Error).message).toContain(TLS_FAILURE_MESSAGE);
    expect((failure as Error).message).not.toContain(secret);
    expect(TLS_FAILURE_MESSAGE).toBe(
      "the connection failed TLS verification; on desktop the plugin uses Node's certificate list; set NODE_EXTRA_CA_CERTS for a private CA",
    );
  });
});

describe("plugin transport choice", () => {
  afterEach(() => {
    Platform.isDesktopApp = true;
    resetRequestUrl();
  });

  it("is the Node transport when require('http'/'https') exists, and requestUrl is not called", async () => {
    const local = await listen((_request, response) => {
      response.writeHead(200).end("ok");
    });
    try {
      resetRequestUrl();
      const host = { require: (id: string) => (id === "http" ? nodeHttp : id === "https" ? nodeHttps : undefined) };
      const transport = pluginTransport(host);
      expect(transport.transportName).toBe("node");
      expect(await (await transport(`${local.baseUrl}/x`, { method: "GET" })).text()).toBe("ok");
      expect(local.seen).toHaveLength(1);
      expect(requestUrlCalls).toEqual([]);
    } finally {
      await local.close();
    }
  });

  it("falls back to requestUrl when require is unavailable, throws, or the app is not desktop", async () => {
    setRequestUrlHandler(() => stubResponse(200, "via-request-url"));
    const hosts: unknown[] = [{}, { require: () => { throw new Error("no module"); } }];
    for (const host of hosts) {
      const transport = pluginTransport(host);
      expect(transport.transportName).toBe("requestUrl");
      expect(await (await transport("https://gw.example.org/x", { method: "GET" })).text()).toBe("via-request-url");
    }
    Platform.isDesktopApp = false;
    expect(pluginTransport({ require: () => nodeHttp }).transportName).toBe("requestUrl");
  });

  it("no source file reaches requestUrl or requestUrlTransport except the module that owns the fallback", () => {
    const root = join(__dirname, "..", "..", "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) files.push(path);
      }
    };
    walk(root);
    const owner = join(root, "plugin", "request-url-transport.ts");
    const offenders = files.filter((file) => file !== owner && /\brequestUrlTransport\b|\brequestUrl\(/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
    const plugin = readFileSync(join(root, "plugin", "index.ts"), "utf8");
    expect(plugin.match(/pluginTransport\(\)/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
