import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as nodeHttp from "node:http";
import * as nodeHttps from "node:https";
import { readdirSync, readFileSync } from "node:fs";
import { createServer as createRawServer, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedEndpoint } from "../../src/core/config";
import { KuboNetworkError, KuboResponseTooLargeError, createKuboClient, rpcCall, type Transport } from "../../src/kubo";
import { REDIRECT_REFUSED_MESSAGE } from "../../src/kubo/http";
import { buildMultipart } from "../../src/kubo/multipart";
import { getEventListeners } from "node:events";
import {
  NODE_RESPONSE_UNREADABLE_MESSAGE,
  NODE_UNAVAILABLE_MESSAGE,
  NodeTransportHeaderError,
  TLS_CONNECT_FAILURE_MESSAGE,
  TLS_FAILURE_MESSAGE,
  createNodeTransport,
  type NodeModules,
} from "../../src/plugin/node-transport";
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

interface RawServer {
  readonly baseUrl: string;
  readonly sockets: Socket[];
  readonly closed: Promise<void>[];
  readonly close: () => Promise<void>;
}

/** A TCP server that answers the first request bytes with `raw`, written verbatim (latin1), so it can say what no HTTP server library would. */
async function rawServer(raw: string): Promise<RawServer> {
  const sockets: Socket[] = [];
  const closed: Promise<void>[] = [];
  const server = createRawServer((socket) => {
    sockets.push(socket);
    closed.push(new Promise<void>((resolve) => socket.once("close", () => resolve())));
    socket.on("error", () => undefined);
    socket.once("data", () => socket.write(Buffer.from(raw, "latin1")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    sockets,
    closed,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Test-side deadline so a hang fails in one second rather than at the test timeout. It is not product code. */
async function within<T>(ms: number, work: Promise<T>): Promise<T | "hung"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"hung">((resolve) => {
    timer = setTimeout(() => resolve("hung"), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("node transport: a response this plugin cannot read", () => {
  const servers: RawServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  const unreadable = [
    ["600", "HTTP/1.1 600 Nope\r\nContent-Length: 0\r\n\r\n"],
    ["999", "HTTP/1.1 999 Nope\r\nContent-Length: 0\r\n\r\n"],
    ["099", "HTTP/1.1 099 Nope\r\nContent-Length: 0\r\n\r\n"],
    ["101", "HTTP/1.1 101 Nope\r\nContent-Length: 0\r\n\r\n"],
  ] as const;
  // 102 and 103 never reach the handler: Node's client emits them as 'information' and waits for the final response.

  for (const [status, raw] of unreadable) {
    it(`status ${status}: rejects with the fixed error, promptly, and closes the socket`, async () => {
      const server = await rawServer(raw);
      servers.push(server);
      const started = Date.now();
      const outcome = await within(
        1000,
        nodeOnly()(`${server.baseUrl}/x`, { method: "GET" }).then(
          () => "resolved" as const,
          (error: unknown) => error,
        ),
      );
      expect(outcome).not.toBe("hung");
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe(NODE_RESPONSE_UNREADABLE_MESSAGE);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(await within(1000, Promise.all(server.closed))).not.toBe("hung");
    });
  }

  it("a malformed header never leaves the call pending", async () => {
    const server = await rawServer("HTTP/1.1 200 OK\r\nBad Name: v\r\nContent-Length: 0\r\n\r\n");
    servers.push(server);
    const outcome = await within(
      1000,
      nodeOnly()(`${server.baseUrl}/x`, { method: "GET" }).then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
    );
    expect(outcome).not.toBe("hung");
    expect(outcome).toBeInstanceOf(Error);
    expect(await within(1000, Promise.all(server.closed))).not.toBe("hung");
  });

  it("a header set that Headers refuses rejects with the fixed error and destroys both ends, echoing nothing", async () => {
    const destroyed: string[] = [];
    const hostile = "secret-header-name host.internal";
    const fake: NodeModules = {
      http: {
        request: () => {
          const handlers = new Map<string, (value: never) => void>();
          const incoming = {
            statusCode: 200,
            headers: { [hostile]: "v" },
            on() {},
            pause() {},
            resume() {},
            destroy() {
              destroyed.push("incoming");
            },
          };
          const outgoing = {
            on(event: string, listener: (value: never) => void) {
              handlers.set(event, listener);
              return outgoing;
            },
            end() {
              queueMicrotask(() => handlers.get("response")?.(incoming as never));
            },
            destroy() {
              destroyed.push("request");
            },
          };
          return outgoing;
        },
      },
      https: nodeHttps,
    };
    const transport = createNodeTransport({ fallback: refusedFallback, node: fake });
    const outcome = await within(1000, transport("http://127.0.0.1:1/x", { method: "GET" }).catch((error: unknown) => error));
    expect(outcome).not.toBe("hung");
    expect((outcome as Error).message).toBe(NODE_RESPONSE_UNREADABLE_MESSAGE);
    expect((outcome as Error).message).not.toContain(hostile);
    expect(destroyed.sort()).toEqual(["incoming", "request"]);
  });

  it("the fixed text is stable", () => {
    expect(NODE_RESPONSE_UNREADABLE_MESSAGE).toBe("the node answered with a response this plugin cannot read");
  });
});

type Emit = (event: string, value?: unknown) => void;

/** A Node module pair whose request does only what the test scripts: `onEnd` runs after `end()`, `emit` fires a registered listener. */
function fakeNode(onEnd?: (emit: Emit) => void): { node: NodeModules; state: { requests: number; destroyed: unknown[] }; emit: Emit } {
  const state = { requests: 0, destroyed: [] as unknown[] };
  const handlers = new Map<string, (value: never) => void>();
  const emit: Emit = (event, value) => handlers.get(event)?.(value as never);
  const request = (): unknown => {
    state.requests += 1;
    const outgoing = {
      on(event: string, listener: (value: never) => void) {
        handlers.set(event, listener);
        return outgoing;
      },
      end() {
        if (onEnd !== undefined) queueMicrotask(() => onEnd(emit));
      },
      destroy(error?: unknown) {
        state.destroyed.push(error ?? "none");
      },
    };
    return outgoing;
  };
  return { node: { http: { request }, https: { request } } as unknown as NodeModules, state, emit };
}

/** Records every uncaught exception raised while `work` runs and for a moment after (test-side wait, not product code). */
async function uncaughtDuring(work: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const spy = (error: unknown): void => {
    seen.push(error);
  };
  process.on("uncaughtException", spy);
  try {
    await work();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
  } finally {
    process.off("uncaughtException", spy);
  }
  return seen;
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

const settle = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => "resolved" as const,
    (error: unknown) => error,
  );

describe("node transport: abort", () => {
  const servers: RawServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("before the response: rejects with AbortError promptly, closes the socket, raises nothing uncaught, leaves no listener", async () => {
    const server = await rawServer("");
    servers.push(server);
    const controller = new AbortController();
    let outcome: unknown;
    const uncaught = await uncaughtDuring(async () => {
      const pending = settle(nodeOnly()(`${server.baseUrl}/x`, { method: "POST", body: "x", signal: controller.signal }));
      await until(() => server.sockets.length > 0);
      controller.abort();
      outcome = await within(1000, pending);
    });
    expect(outcome).not.toBe("hung");
    expect((outcome as Error).name).toBe("AbortError");
    expect((outcome as Error).message).not.toContain("TLS");
    expect(await within(1000, Promise.all(server.closed))).not.toBe("hung");
    expect(uncaught).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("after the response but before the first body read: the body read rejects with AbortError, nothing uncaught, socket closed", async () => {
    const server = await rawServer("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial");
    servers.push(server);
    const controller = new AbortController();
    let read: unknown;
    const uncaught = await uncaughtDuring(async () => {
      const response = await within(1000, nodeOnly()(`${server.baseUrl}/x`, { method: "GET", signal: controller.signal }));
      expect(response).not.toBe("hung");
      controller.abort();
      read = await within(1000, settle((response as Response).text()));
    });
    expect(read).not.toBe("hung");
    expect((read as Error).name).toBe("AbortError");
    expect(await within(1000, Promise.all(server.closed))).not.toBe("hung");
    expect(uncaught).toEqual([]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("after the body is complete: no effect, and the signal holds no listener", async () => {
    const local = await listen((_request, response) => {
      response.writeHead(200).end("ok");
    });
    try {
      const controller = new AbortController();
      const uncaught = await uncaughtDuring(async () => {
        const response = await nodeOnly()(`${local.baseUrl}/x`, { method: "GET", signal: controller.signal });
        expect(await response.text()).toBe("ok");
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        controller.abort();
      });
      expect(uncaught).toEqual([]);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      await local.close();
    }
  });

  it("an already-aborted signal rejects at once with the signal's own reason and opens no request", async () => {
    const { node, state } = fakeNode();
    const transport = createNodeTransport({ fallback: refusedFallback, node });
    const reason = new DOMException("took too long", "TimeoutError");
    const outcome = await within(1000, settle(transport("http://127.0.0.1:1/x", { method: "GET", signal: AbortSignal.abort(reason) })));
    expect(outcome).toBe(reason);
    const plain = await within(1000, settle(transport("http://127.0.0.1:1/x", { method: "GET", signal: AbortSignal.abort() })));
    expect((plain as Error).name).toBe("AbortError");
    expect(state.requests).toBe(0);
  });

  it("a response that arrives after the abort is destroyed, never wrapped, and the promise is not settled twice", async () => {
    const { node, state, emit } = fakeNode();
    const transport = createNodeTransport({ fallback: refusedFallback, node });
    const controller = new AbortController();
    const pending = settle(transport("http://127.0.0.1:1/x", { method: "GET", signal: controller.signal }));
    controller.abort();
    expect(((await within(1000, pending)) as Error).name).toBe("AbortError");
    const destroyed: string[] = [];
    emit("response", {
      statusCode: 200,
      headers: {},
      on() {},
      pause() {},
      resume() {},
      destroy() {
        destroyed.push("incoming");
      },
    });
    expect(destroyed).toEqual(["incoming"]);
    expect(state.destroyed.length).toBeGreaterThanOrEqual(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("a DOMException-like error with the legacy numeric code 20 is passed on as it is: no TypeError, no hang", async () => {
    const abortLike = new DOMException("not ours", "AbortError");
    expect(typeof (abortLike as { code: unknown }).code).toBe("number");
    const { node } = fakeNode((emit) => emit("error", abortLike));
    const transport = createNodeTransport({ fallback: refusedFallback, node });
    let outcome: unknown;
    const uncaught = await uncaughtDuring(async () => {
      outcome = await within(1000, settle(transport("http://127.0.0.1:1/x", { method: "GET" })));
    });
    expect(outcome).toBe(abortLike);
    expect(uncaught).toEqual([]);
  });

  it("an error after an abort is reported as the abort, never as a TLS failure", async () => {
    const certLike = Object.assign(new Error("from node"), { code: "CERT_HAS_EXPIRED" });
    const { node, emit } = fakeNode();
    const transport = createNodeTransport({ fallback: refusedFallback, node });
    const controller = new AbortController();
    const pending = settle(transport("http://127.0.0.1:1/x", { method: "GET", signal: controller.signal }));
    controller.abort();
    emit("error", certLike);
    const outcome = (await within(1000, pending)) as Error;
    expect(outcome.name).toBe("AbortError");
    expect(outcome.message).not.toBe(TLS_FAILURE_MESSAGE);
  });
});

describe("node transport: TLS failure classes", () => {
  const sendFailing = async (code: string): Promise<unknown> => {
    const { node } = fakeNode((emit) => emit("error", Object.assign(new Error("text supplied by node"), { code })));
    const transport = createNodeTransport({ fallback: refusedFallback, node });
    return within(1000, settle(transport("https://tls.example.org/x", { method: "GET" })));
  };

  it.each([
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "CERT_CHAIN_TOO_LONG",
    "CERT_SIGNATURE_FAILURE",
    "INVALID_PURPOSE",
    "INVALID_CA",
    "PATH_LENGTH_EXCEEDED",
    "CERT_REJECTED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ])("%s is a certificate failure: the fixed verification message", async (code) => {
    const outcome = (await sendFailing(code)) as Error;
    expect(outcome.message).toBe(TLS_FAILURE_MESSAGE);
  });

  it.each(["ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "ERR_TLS_HANDSHAKE_TIMEOUT", "EPROTO"])(
    "%s is not a certificate failure: a different fixed message with no CA advice",
    async (code) => {
      const outcome = (await sendFailing(code)) as Error;
      expect(outcome.message).toBe(TLS_CONNECT_FAILURE_MESSAGE);
      expect(outcome.message).not.toContain("NODE_EXTRA_CA_CERTS");
      expect(outcome.message).not.toContain("text supplied by node");
    },
  );

  it("the two fixed texts are stable", () => {
    expect(TLS_CONNECT_FAILURE_MESSAGE).toBe("the connection could not be established as TLS: check the address and scheme");
  });

  it("an error whose code is not a TLS code passes through unchanged", async () => {
    const original = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    const { node } = fakeNode((emit) => emit("error", original));
    const transport = createNodeTransport({ fallback: refusedFallback, node });
    expect(await within(1000, settle(transport("http://127.0.0.1:1/x", { method: "GET" })))).toBe(original);
  });

  it("an https URL pointed at a plain-HTTP port gets the connection message, not the CA advice", async () => {
    const local = await listen((_request, response) => {
      response.writeHead(200).end("plain");
    });
    try {
      const outcome = await within(2000, settle(nodeOnly()(local.baseUrl.replace("http:", "https:") + "/x", { method: "GET" })));
      expect(outcome).not.toBe("hung");
      expect((outcome as Error).message).toBe(TLS_CONNECT_FAILURE_MESSAGE);
    } finally {
      await local.close();
    }
  });
});

describe("node transport: connection-framing request headers", () => {
  it.each(["Host", "host", "HOST", "Transfer-Encoding", "transfer-encoding", "Connection", "cOnNeCtIoN", "Upgrade", "Expect", "TE", "Keep-Alive", "Proxy-Connection", "Trailer"])(
    "refuses a request carrying %s with a fixed typed error and sends nothing",
    async (name) => {
      const local = await listen((_request, response) => {
        response.writeHead(200).end("x");
      });
      try {
        const failure = await nodeOnly()(`${local.baseUrl}/x`, { method: "POST", body: "x", headers: { [name]: "evil.example" } }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(NodeTransportHeaderError);
        expect(failure).toBeInstanceOf(TypeError);
        expect((failure as Error).message).toBe("the node transport refuses connection-framing request headers");
        expect((failure as Error).message).not.toContain("evil.example");
        expect(local.seen).toHaveLength(0);
      } finally {
        await local.close();
      }
    },
  );

  it("Content-Type and Range still pass, and a caller's Content-Length is replaced by the real one", async () => {
    const local = await listen((_request, response) => {
      response.writeHead(200).end("x");
    });
    try {
      await nodeOnly()(`${local.baseUrl}/x`, {
        method: "POST",
        body: "abc",
        headers: { "Content-Type": "application/json", Range: "bytes=0-1", "Content-Length": "999" },
      });
      expect(local.seen[0]?.headers["content-type"]).toBe("application/json");
      expect(local.seen[0]?.headers["range"]).toBe("bytes=0-1");
      expect(local.seen[0]?.headers["content-length"]).toBe("3");
      expect(local.seen[0]?.body.toString("utf8")).toBe("abc");
    } finally {
      await local.close();
    }
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

  it("on desktop with no usable Node modules it fails closed: every request is refused and requestUrl is never called", async () => {
    setRequestUrlHandler(() => stubResponse(200, "via-request-url"));
    const hosts: unknown[] = [
      {},
      { require: "not a function" },
      { require: () => { throw new Error("no module"); } },
      { require: (id: string) => (id === "http" ? nodeHttp : undefined) },
    ];
    for (const host of hosts) {
      const transport = pluginTransport(host);
      expect(transport.transportName).toBe("node-unavailable");
      const failure = await transport("https://gw.example.org/x", { method: "POST" }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(NODE_UNAVAILABLE_MESSAGE);
    }
    expect(requestUrlCalls).toEqual([]);
    expect(NODE_UNAVAILABLE_MESSAGE).toBe(
      "the desktop network layer is unavailable, so the plugin will not send requests through the redirect-following fallback; reload the plugin or report this",
    );
  });

  it("the refusal reaches a client call as a typed network error carrying the fixed text", async () => {
    const transport = pluginTransport({});
    const client = createKuboClient({ rpc: endpointOf("https://rpc.example.org:5001"), gateway: endpointOf("https://gw.example.org"), transport });
    const failure = await client.keyList().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KuboNetworkError);
    expect((failure as Error).message).toContain(NODE_UNAVAILABLE_MESSAGE);
  });

  it("on mobile (isDesktopApp false) it uses requestUrl, whatever require is", async () => {
    setRequestUrlHandler(() => stubResponse(200, "via-request-url"));
    Platform.isDesktopApp = false;
    for (const host of [{}, { require: () => nodeHttp }]) {
      const transport = pluginTransport(host);
      expect(transport.transportName).toBe("requestUrl");
      expect(await (await transport("https://gw.example.org/x", { method: "GET" })).text()).toBe("via-request-url");
    }
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
