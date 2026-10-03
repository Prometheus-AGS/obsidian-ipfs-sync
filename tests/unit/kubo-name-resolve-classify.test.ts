import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedEndpoint } from "../../src/core/config";
import {
  KuboAuthError,
  KuboHttpError,
  KuboNetworkError,
  NAME_RESOLVE_DHT_TIMEOUT,
  NAME_RESOLVE_ERROR_TEXTS,
  classifyResolveFailure,
  createKuboClient,
  type KuboClient,
} from "../../src/kubo";

/**
 * Task 2.2: `name/resolve` takes an optional `dht-timeout` and its failures are classified from a table held in
 * `src/kubo/ipns.ts`. The one text asserted below as `not-found` is the answer the operator's node gave on
 * 2026-10-01T12:25:16Z for a never-published key id; no other node text is asserted as kubo's.
 */

const RECORDED_NOT_FOUND_BODY = '{"Message":"could not resolve name","Code":0,"Type":"error"}';

describe("name/resolve: dht-timeout and classification", () => {
  let calls: URL[];
  let respond: () => Response;
  let client: KuboClient;

  beforeEach(() => {
    calls = [];
    respond = () => new Response(JSON.stringify({ Path: "/ipfs/bafyaaaaaaaaaaaaaaaaaa" }), { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        calls.push(new URL(String(input)));
        return respond();
      }),
    );
    const endpoint = (name: "rpc" | "gateway", baseUrl: string): ResolvedEndpoint => ({ name, baseUrl, auth: { kind: "bearer", token: "tok" } });
    client = createKuboClient({ rpc: endpoint("rpc", "https://rpc.example.org"), gateway: endpoint("gateway", "https://gw.example.org") });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends dht-timeout only when asked, and keeps nocache either way", async () => {
    await client.nameResolve("k51new");
    expect(calls[0]?.searchParams.get("dht-timeout")).toBeNull();
    expect(calls[0]?.searchParams.get("nocache")).toBe("true");
    await client.nameResolve("k51new", { dhtTimeout: NAME_RESOLVE_DHT_TIMEOUT });
    expect(calls[1]?.searchParams.get("dht-timeout")).toBe("10s");
    expect(calls[1]?.searchParams.get("nocache")).toBe("true");
  });

  it("holds exactly the text recorded from the operator's node, and records no timeout text", () => {
    expect(NAME_RESOLVE_ERROR_TEXTS.notFound).toEqual(["could not resolve name"]);
    expect(NAME_RESOLVE_ERROR_TEXTS.timeout).toEqual([]);
  });

  it("classifies the recorded answer of a never-published key as not-found, end to end through the client", async () => {
    respond = () => new Response(RECORDED_NOT_FOUND_BODY, { status: 500, headers: { "content-type": "application/json" } });
    const failure = await client.nameResolve("k51never").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(KuboHttpError);
    expect(classifyResolveFailure(failure)).toEqual({ kind: "not-found" });
  });

  it("classifies an unrecognised node message as failed (fail closed)", () => {
    const unknown = new KuboHttpError("rpc", "https://node.test", 500, "some other error", "some other error");
    expect(classifyResolveFailure(unknown)).toEqual({ kind: "failed", timedOut: false });
  });

  it("does not read the recorded text on another status, from a proxy page, or without the node's own message", () => {
    expect(classifyResolveFailure(new KuboHttpError("rpc", "https://node.test", 502, "could not resolve name", "could not resolve name"))).toEqual({ kind: "failed", timedOut: false });
    expect(classifyResolveFailure(new KuboHttpError("rpc", "https://node.test", 500, "could not resolve name"))).toEqual({ kind: "failed", timedOut: false });
    expect(classifyResolveFailure(new KuboHttpError("rpc", "https://node.test", 500, "x", "could not resolve name and more"))).toEqual({ kind: "failed", timedOut: false });
  });

  it("classifies a network failure as failed", () => {
    expect(classifyResolveFailure(new KuboNetworkError("rpc", "https://node.test", new TypeError("fetch failed")))).toEqual({ kind: "failed", timedOut: false });
  });

  it("rethrows a credentials error and an error that is not the client's own", () => {
    const auth = new KuboAuthError("rpc", "https://node.test", 401);
    expect(() => classifyResolveFailure(auth)).toThrow(auth);
    const bug = new TypeError("not a kubo error");
    expect(() => classifyResolveFailure(bug)).toThrow(bug);
  });
});
