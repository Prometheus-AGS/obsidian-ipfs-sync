import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedEndpoint } from "../../src/core/config";
import { KuboNetworkError, createKuboClient, type Transport } from "../../src/kubo";
import { REDIRECT_REFUSED_MESSAGE } from "../../src/kubo/http";

// Review finding H2: a redirect must never carry a request (and its credential) to a host the operator did not configure.

const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const STATUSES = [301, 302, 307, 308] as const;

interface Stub {
  readonly origin: string;
  readonly requests: { readonly method: string | undefined; readonly url: string | undefined; readonly authorization: string | undefined }[];
  readonly close: () => Promise<void>;
}

async function listen(handler: (request: IncomingMessage, respond: (status: number, headers?: Record<string, string>) => void) => void): Promise<Stub> {
  const requests: Stub["requests"][number][] = [];
  const server: Server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    handler(request, (status, headers = {}) => {
      response.writeHead(status, headers);
      response.end("{}");
    });
    request.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const open: Stub[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((stub) => stub.close()));
});

async function pair(status: number): Promise<{ readonly redirector: Stub; readonly target: Stub }> {
  const target = await listen((_request, respond) => respond(200));
  const redirector = await listen((_request, respond) => respond(status, { Location: `${target.origin}/elsewhere` }));
  open.push(target, redirector);
  return { redirector, target };
}

function endpoints(origin: string): { readonly rpc: ResolvedEndpoint; readonly gateway: ResolvedEndpoint } {
  return {
    rpc: { name: "rpc", baseUrl: origin, auth: { kind: "bearer", token: "rpc-secret" } },
    gateway: { name: "gateway", baseUrl: origin, auth: { kind: "bearer", token: "gw-secret" } },
  };
}

async function failureOf(run: () => Promise<unknown>): Promise<KuboNetworkError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof KuboNetworkError) return error;
    throw error;
  }
  throw new Error("the request was not refused");
}

describe.each(STATUSES)("a %i answer", (status) => {
  it("is refused on an RPC POST with the fixed error, and the target sees no request", async () => {
    const { redirector, target } = await pair(status);
    const client = createKuboClient(endpoints(redirector.origin));
    const error = await failureOf(() => client.keyList());
    expect(error.message).toContain(REDIRECT_REFUSED_MESSAGE);
    expect(error.message).not.toContain(target.origin);
    expect(redirector.requests).toHaveLength(1);
    expect(redirector.requests[0]?.method).toBe("POST");
    expect(target.requests).toEqual([]);
  });

  it("is refused on a gateway GET with the fixed error, and the target sees no request or credential", async () => {
    const { redirector, target } = await pair(status);
    const client = createKuboClient(endpoints(redirector.origin));
    const error = await failureOf(() => client.gatewayFetch(CID));
    expect(error.message).toContain(REDIRECT_REFUSED_MESSAGE);
    expect(error.message).not.toContain(target.origin);
    expect(redirector.requests).toHaveLength(1);
    expect(target.requests).toEqual([]);
    const streamError = await failureOf(() => client.gatewayStream(CID, "", { start: 0, length: 8 }));
    expect(streamError.message).toContain(REDIRECT_REFUSED_MESSAGE);
    expect(target.requests).toEqual([]);
  });
});

describe("a transport that does not follow redirects itself (the Node stream transport)", () => {
  function answering(make: () => Response): Transport {
    return Object.assign(async () => make(), { transportName: "stub" });
  }

  it("has its 3xx answer refused with the same fixed error", async () => {
    for (const status of STATUSES) {
      const transport = answering(() => new Response(null, { status, headers: { Location: "https://elsewhere.example/x" } }));
      const client = createKuboClient({ ...endpoints("https://node.example"), transport });
      const rpc = await failureOf(() => client.keyList());
      expect(rpc.message).toContain(REDIRECT_REFUSED_MESSAGE);
      expect(rpc.message).toContain("(via stub)");
      expect(rpc.message).not.toContain("elsewhere.example");
      const gateway = await failureOf(() => client.gatewayFetch(CID));
      expect(gateway.message).toContain(REDIRECT_REFUSED_MESSAGE);
    }
  });

  it("asks the transport not to follow a redirect", async () => {
    const seen: (RequestRedirect | undefined)[] = [];
    const transport: Transport = async (_url, init) => {
      seen.push(init.redirect);
      return new Response("{}", { status: 200 });
    };
    await createKuboClient({ ...endpoints("https://node.example"), transport }).gatewayFetch(CID);
    await createKuboClient({ ...endpoints("https://node.example"), transport }).keyList().catch(() => undefined);
    expect(seen).toEqual(["manual", "manual"]);
  });
});
