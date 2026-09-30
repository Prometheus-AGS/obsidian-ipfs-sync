import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedEndpoint } from "../../src/core/config";
import { KuboAuthError, KuboHttpError, KuboNetworkError, createKuboClient, rpcCall, type KuboClient } from "../../src/kubo";
import { createSyncEventBus } from "../../src/core/events";
import { createPublishRunner } from "../../src/plugin/publish-runner";
import { defaultSettings } from "../../src/plugin/settings-model";
import { createSettingsStore } from "../../src/plugin/settings-store";
import { MemoryAdapter } from "../support/memory-adapter";
import { requestUrlTransport } from "../../src/plugin/request-url-transport";
import { requestUrlCalls, resetRequestUrl, setRequestUrlHandler, stubResponse, type RequestUrlParam } from "../support/obsidian-stub";

const RPC: ResolvedEndpoint = { name: "rpc", baseUrl: "https://rpc.example.org:5001", auth: { kind: "bearer", token: "tok-secret" } };
const GATEWAY: ResolvedEndpoint = { name: "gateway", baseUrl: "https://gw.example.org", auth: { kind: "basic", user: "u", password: "p" } };
const CID = "bafkreiaaaaaaaaaaaaaaaaaa";

function lastCall(): RequestUrlParam {
  const call = requestUrlCalls.at(-1);
  if (call === undefined) throw new Error("requestUrl was not called");
  return call;
}

describe("requestUrl transport", () => {
  let client: KuboClient;

  beforeEach(() => {
    resetRequestUrl();
    client = createKuboClient({ rpc: RPC, gateway: GATEWAY, transport: requestUrlTransport });
  });

  afterEach(() => {
    resetRequestUrl();
  });

  it("sends a JSON RPC as a POST with the query string, the auth header and throw: false", async () => {
    setRequestUrlHandler(() => stubResponse(200, JSON.stringify({ Keys: [{ Name: "obsidian-vault-sync", Id: "k51x" }] })));
    expect(await client.keyList()).toEqual([{ name: "obsidian-vault-sync", id: "k51x" }]);
    const call = lastCall();
    expect(call.url).toBe("https://rpc.example.org:5001/api/v0/key/list");
    expect(call.method).toBe("POST");
    expect(call.throw).toBe(false);
    expect(call.headers?.["authorization"]).toBe("Bearer tok-secret");
    expect(call.body).toBeUndefined();
  });

  it("reads every response mode", async () => {
    setRequestUrlHandler(() => stubResponse(200, '{"n":1}\n{"n":2}\n'));
    const input = { endpoint: RPC, command: "x", transport: requestUrlTransport };
    expect(await rpcCall(input, "ndjson")).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await rpcCall(input, "ndjson-last")).toEqual({ n: 2 });
    expect(await rpcCall(input, "text")).toBe('{"n":1}\n{"n":2}\n');
    expect(await rpcCall(input, "none")).toBeUndefined();
    setRequestUrlHandler(() => stubResponse(200, '{"n":3}'));
    expect(await rpcCall(input, "json")).toEqual({ n: 3 });
    setRequestUrlHandler(() => stubResponse(204));
    expect(await rpcCall(input, "none")).toBeUndefined();
  });

  it("maps 403 and 401 to the authentication error without the token", async () => {
    for (const status of [401, 403]) {
      setRequestUrlHandler(() => stubResponse(status, "denied"));
      const failure = await client.keyList().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(KuboAuthError);
      expect((failure as KuboAuthError).message).toContain(RPC.baseUrl);
      expect((failure as KuboAuthError).message).not.toContain("tok-secret");
    }
  });

  it("maps other statuses to an HTTP error carrying the node's message", async () => {
    setRequestUrlHandler(() => stubResponse(500, JSON.stringify({ Message: "file does not exist", Code: 0, Type: "error" })));
    const failure = await client.filesStat("/obsidian-vault-sync/none").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KuboHttpError);
    expect((failure as KuboHttpError).message).toContain("file does not exist");
  });

  it("turns a network failure into a typed error that names the transport and hints at CORS", async () => {
    setRequestUrlHandler(() => {
      throw new TypeError("Failed to fetch");
    });
    const failure = await client.keyList().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KuboNetworkError);
    const message = (failure as KuboNetworkError).message;
    expect(message).toContain("(via requestUrl)");
    expect(message).toContain("the browser blocked the request (CORS); the plugin uses requestUrl to avoid this");
    expect(message).not.toContain("tok-secret");

    setRequestUrlHandler(() => {
      throw new Error("net::ERR_CONNECTION_REFUSED");
    });
    const refused = await client.keyList().catch((error: unknown) => error);
    expect((refused as KuboNetworkError).message).toContain("ERR_CONNECTION_REFUSED");
    expect((refused as KuboNetworkError).message).not.toContain("CORS");
  });

  it("sends files/write as one prebuilt multipart buffer with field data and the boundary in contentType", async () => {
    setRequestUrlHandler(() => stubResponse(200));
    const payload = Uint8Array.from([0, 255, 13, 10, 45, 45, 1, 2, 3]);
    await client.filesWrite("/obsidian-vault-sync/mvp04/a.bin", payload);
    const call = lastCall();
    const url = new URL(call.url);
    expect(url.searchParams.get("arg")).toBe("/obsidian-vault-sync/mvp04/a.bin");
    expect(url.searchParams.get("cid-version")).toBe("1");
    expect(call.contentType).toMatch(/^multipart\/form-data; boundary=ipfs-sync-[0-9a-f]+$/);
    expect(Object.keys(call.headers ?? {}).map((k) => k.toLowerCase())).not.toContain("content-type");
    expect(call.headers?.["authorization"]).toBe("Bearer tok-secret");
    expect(call.body).toBeInstanceOf(ArrayBuffer);
    const form = await new Response(call.body, { headers: { "content-type": call.contentType ?? "" } }).formData();
    expect([...form.keys()]).toEqual(["data"]);
    expect([...new Uint8Array(await (form.get("data") as Blob).arrayBuffer())]).toEqual([...payload]);
  });

  it("reads a byte range from the gateway with the Range header and returns the bytes", async () => {
    setRequestUrlHandler(() => stubResponse(206, Uint8Array.from([11, 12, 13]), { "content-range": "bytes 1-3/10" }));
    const stream = await client.gatewayStream(CID, "current/a.bin", { start: 1, length: 3 });
    const call = lastCall();
    expect(call.method).toBe("GET");
    expect(call.url).toBe(`https://gw.example.org/ipfs/${CID}/current/a.bin`);
    expect(call.headers?.["range"]).toBe("bytes=1-3");
    expect(call.headers?.["authorization"]).toBe(`Basic ${btoa("u:p")}`);
    expect(stream.status).toBe(206);
    expect(stream.contentRange).toBe("bytes 1-3/10");
    const parts: number[] = [];
    for await (const chunk of stream.chunks) parts.push(...chunk);
    expect(parts).toEqual([11, 12, 13]);
  });

  it("fetches a whole gateway object as bytes", async () => {
    setRequestUrlHandler(() => stubResponse(200, Uint8Array.from([1, 2, 3, 250])));
    expect([...(await client.gatewayFetch(CID))]).toEqual([1, 2, 3, 250]);
  });
});

describe("plugin default transport", () => {
  it("the publish runner reaches the node through requestUrl and never through fetch", async () => {
    resetRequestUrl();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      setRequestUrlHandler((params) => (params.url.endsWith("/key/list") ? stubResponse(200, '{"Keys":[]}') : stubResponse(500, '{"Message":"stop here"}')));
      const adapter = new MemoryAdapter();
      adapter.put(".ipfs-sync-fixture", "fixture\n");
      adapter.put("notes/a.md", "a");
      const store = createSettingsStore(
        { loadData: async () => null, saveData: async () => undefined },
        { settings: { ...defaultSettings(), mfsRoot: "/obsidian-vault-sync/mvp04-test" }, outcome: "fresh", notices: [], persist: false },
      );
      const outcome = await createPublishRunner({ store, adapter, bus: createSyncEventBus() }).run();
      expect(outcome.kind).toBe("failed");
      expect(requestUrlCalls.map((c) => new URL(c.url).pathname)).toEqual(["/api/v0/key/list", "/api/v0/key/gen"]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      resetRequestUrl();
    }
  });
});
