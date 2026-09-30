import { afterEach, describe, expect, it, vi } from "vitest";
import { KuboAuthError, KuboNetworkError, createKuboClient, type KuboClient } from "../../src/kubo";

const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

interface Captured {
  readonly url: URL;
  readonly init: RequestInit;
}

function clientWith(respond: (url: URL) => Response, calls: Captured[]): KuboClient {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      calls.push({ url: new URL(String(input)), init });
      return respond(new URL(String(input)));
    }),
  );
  return createKuboClient({
    rpc: { name: "rpc", baseUrl: "https://rpc.example.org", auth: { kind: "none" } },
    gateway: { name: "gateway", baseUrl: "https://gw.example.org", auth: { kind: "bearer", token: "gw-token" } },
  });
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of chunks) parts.push(new TextDecoder().decode(chunk));
  return parts.join("");
}

describe("gatewayStream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the Range header and the gateway auth, and reports 206 with Content-Range", async () => {
    const calls: Captured[] = [];
    const client = clientWith(
      () => new Response("abcd", { status: 206, headers: { "content-range": "bytes 8-11/100" } }),
      calls,
    );
    const stream = await client.gatewayStream(CID, "dir/a b.md", { start: 8, length: 4 });
    expect(stream.status).toBe(206);
    expect(stream.contentRange).toBe("bytes 8-11/100");
    expect(await collect(stream.chunks)).toBe("abcd");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("range")).toBe("bytes=8-11");
    expect(headers.get("authorization")).toBe("Bearer gw-token");
    expect(calls[0]?.url.pathname).toBe(`/ipfs/${CID}/dir/a%20b.md`);
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("sends no Range header without a range and reports a whole-body 200", async () => {
    const calls: Captured[] = [];
    const client = clientWith(() => new Response("whole", { status: 200 }), calls);
    const stream = await client.gatewayStream(CID);
    expect(stream.status).toBe(200);
    expect(stream.contentRange).toBeUndefined();
    expect(await collect(stream.chunks)).toBe("whole");
    expect(new Headers(calls[0]?.init.headers).has("range")).toBe(false);
  });

  it("rejects an invalid range and an unsafe path before any request", async () => {
    const calls: Captured[] = [];
    const client = clientWith(() => new Response(""), calls);
    await expect(client.gatewayStream(CID, "", { start: -1, length: 4 })).rejects.toThrowError(/invalid gateway range/);
    await expect(client.gatewayStream(CID, "", { start: 0, length: 0 })).rejects.toThrowError(/invalid gateway range/);
    await expect(client.gatewayStream(CID, "../x")).rejects.toThrowError(/must not contain/);
    expect(calls).toHaveLength(0);
  });

  it("raises the typed auth error on 403", async () => {
    const client = clientWith(() => new Response("no", { status: 403 }), []);
    await expect(client.gatewayStream(CID)).rejects.toBeInstanceOf(KuboAuthError);
  });

  it("turns a body that breaks mid-transfer into a network error", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("par"));
      },
      pull() {
        throw new Error("connection reset");
      },
    });
    const client = clientWith(() => new Response(body, { status: 200 }), []);
    const stream = await client.gatewayStream(CID);
    await expect(collect(stream.chunks)).rejects.toBeInstanceOf(KuboNetworkError);
  });
});
