import { describe, expect, it } from "vitest";
import type { ResolvedEndpoint } from "../../src/core/config";
import { KuboAuthError, KuboError, KuboHttpError, KuboNetworkError, createKuboClient, rpcCall, type Transport } from "../../src/kubo";

const RPC: ResolvedEndpoint = { name: "rpc", baseUrl: "https://rpc.example.org:5001", auth: { kind: "bearer", token: "tok-secret" } };
const GATEWAY: ResolvedEndpoint = { name: "gateway", baseUrl: "https://gw.example.org", auth: { kind: "none" } };

interface Seen {
  readonly url: URL;
  readonly init: RequestInit;
}

function recordingTransport(respond: (url: URL) => Response): { readonly transport: Transport; readonly seen: Seen[] } {
  const seen: Seen[] = [];
  const transport: Transport = async (url, init) => {
    const parsed = new URL(url);
    seen.push({ url: parsed, init });
    return respond(parsed);
  };
  return { transport, seen };
}

describe("rpcCall", () => {
  it("posts with every argument in the query string, repeated args included, and the endpoint's auth", async () => {
    const { transport, seen } = recordingTransport(() => new Response("{}"));
    await rpcCall(
      { endpoint: RPC, command: "files/ls", args: { arg: ["/a b", "/c"], long: true, skip: undefined }, transport },
      "json",
    );
    const call = seen[0];
    expect(call?.init.method).toBe("POST");
    expect(call?.url.pathname).toBe("/api/v0/files/ls");
    expect(call?.url.searchParams.getAll("arg")).toEqual(["/a b", "/c"]);
    expect(call?.url.searchParams.get("long")).toBe("true");
    expect(call?.url.searchParams.has("skip")).toBe(false);
    expect(call?.init.body ?? undefined).toBeUndefined();
    expect(new Headers(call?.init.headers).get("authorization")).toBe("Bearer tok-secret");
  });

  it("reads json, ndjson (all and last), text and none", async () => {
    const body = '{"n":1}\n\n{"n":2}\n';
    const { transport } = recordingTransport(() => new Response(body));
    expect(await rpcCall({ endpoint: RPC, command: "x", transport }, "json").catch(() => "bad")).toBe("bad");
    expect(await rpcCall({ endpoint: RPC, command: "x", transport }, "ndjson")).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await rpcCall({ endpoint: RPC, command: "x", transport }, "ndjson-last")).toEqual({ n: 2 });
    expect(await rpcCall({ endpoint: RPC, command: "x", transport }, "text")).toBe(body);
    expect(await rpcCall({ endpoint: RPC, command: "x", transport }, "none")).toBeUndefined();
  });

  it("raises a typed error naming the command for a body that is not a JSON object", async () => {
    const { transport } = recordingTransport(() => new Response("<html>oops</html>"));
    const failure = await rpcCall({ endpoint: RPC, command: "key/list", transport }, "json").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KuboError);
    expect((failure as KuboError).message).toContain("key/list");
    expect((failure as KuboError).message).not.toContain("SyntaxError");
  });

  it("surfaces the node's error message from a non-success JSON body", async () => {
    const { transport } = recordingTransport(
      () => new Response(JSON.stringify({ Message: "file does not exist", Code: 0, Type: "error" }), { status: 500 }),
    );
    const failure = await rpcCall({ endpoint: RPC, command: "files/stat", transport }, "json").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KuboHttpError);
    expect((failure as KuboHttpError).message).toContain("file does not exist");
    expect((failure as KuboHttpError).status).toBe(500);
  });

  it("maps 401 and 403 to the authentication error without the token", async () => {
    for (const status of [401, 403]) {
      const { transport } = recordingTransport(() => new Response("denied", { status }));
      const failure = await rpcCall({ endpoint: RPC, command: "id", transport }, "json").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(KuboAuthError);
      expect((failure as KuboAuthError).message).toContain(RPC.baseUrl);
      expect((failure as KuboAuthError).message).not.toContain("tok-secret");
    }
  });

  it("maps a transport rejection to a network error", async () => {
    const transport: Transport = () => Promise.reject(new TypeError("fetch failed"));
    const failure = await rpcCall({ endpoint: RPC, command: "id", transport }, "json").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KuboNetworkError);
  });
});

describe("kubo client over an injected transport", () => {
  it("sends every RPC and gateway read through the transport, never the global fetch", async () => {
    const { transport, seen } = recordingTransport((url) => {
      if (url.pathname === "/api/v0/name/resolve") return new Response('{"Path":"/ipfs/bafkreiaaaaaaaaaaaaaaaaaa"}');
      if (url.pathname.startsWith("/ipfs/")) return new Response("bytes");
      return new Response("{}");
    });
    const client = createKuboClient({ rpc: RPC, gateway: GATEWAY, transport });
    expect(await client.nameResolve("k51abc")).toBe("/ipfs/bafkreiaaaaaaaaaaaaaaaaaa");
    await client.gatewayFetch("bafkreiaaaaaaaaaaaaaaaaaa");
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url.searchParams.get("nocache")).toBe("true");
    expect(seen[0]?.url.searchParams.get("arg")).toBe("/ipns/k51abc");
    expect(seen[1]?.url.origin).toBe("https://gw.example.org");
  });

  it("reads files/ls both as one Entries object and as one entry per line", async () => {
    const cid = "bafkreiaaaaaaaaaaaaaaaaaa";
    const shapes = [
      JSON.stringify({ Entries: [{ Name: "a", Type: 0, Size: 1, Hash: cid }, { Name: "d", Type: 1, Size: 0, Hash: cid }] }),
      [{ Name: "a", Type: 0, Size: 1, Hash: cid }, { Name: "d", Type: 1, Size: 0, Hash: cid }].map((e) => JSON.stringify(e)).join("\n"),
      JSON.stringify({ Entries: null }),
    ];
    const results = [];
    for (const shape of shapes) {
      const { transport } = recordingTransport(() => new Response(shape));
      results.push(await createKuboClient({ rpc: RPC, gateway: GATEWAY, transport }).filesLs("/obsidian-vault-sync/x"));
    }
    const expected = [
      { name: "a", type: "file", size: 1, cid },
      { name: "d", type: "directory", size: 0, cid },
    ];
    expect(results[0]).toEqual(expected);
    expect(results[1]).toEqual(expected);
    expect(results[2]).toEqual([]);
  });

  it("treats a non-empty files/rm body as a node error", async () => {
    const { transport } = recordingTransport(() => new Response("some daemon error"));
    const client = createKuboClient({ rpc: RPC, gateway: GATEWAY, transport });
    const failure = await client.filesRm("/obsidian-vault-sync/a").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KuboError);
    expect((failure as KuboError).message).toContain("some daemon error");
  });
});
