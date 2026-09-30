import { describe, expect, it } from "vitest";
import type { ResolvedEndpoint } from "../../src/core/config";
import { KuboHttpError, KuboResponseTooLargeError, createKuboClient, isMissingPathError, rpcCall, type Transport } from "../../src/kubo";
import { ERROR_BODY_MAX_BYTES } from "../../src/kubo/http";
import { RPC_RESPONSE_MAX_BYTES } from "../../src/kubo/rpc-call";

const RPC: ResolvedEndpoint = { name: "rpc", baseUrl: "https://rpc.example.org:5001", auth: { kind: "none" } };
const GATEWAY: ResolvedEndpoint = { name: "gateway", baseUrl: "https://gw.example.org", auth: { kind: "none" } };
const always = (make: () => Response): Transport => async () => make();

function endless(seen: { pulled: number; cancelled: boolean }, status: number): Response {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      seen.pulled += 1;
      controller.enqueue(new Uint8Array(4096).fill(0x61));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return new Response(body, { status });
}

const failureOf = async (transport: Transport): Promise<unknown> => {
  const client = createKuboClient({ rpc: RPC, gateway: GATEWAY, transport });
  return client.filesStat("/x").catch((error: unknown) => error);
};

describe("W-06: small RPC caps", () => {
  it.each(["key/list", "pin/add", "name/publish", "key/gen", "id"])("%s refuses an answer above the 64 KiB default", async (command) => {
    const body = "z".repeat(RPC_RESPONSE_MAX_BYTES + 1);
    const failure = await rpcCall({ endpoint: RPC, command, transport: always(() => new Response(body)) }, "text").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KuboResponseTooLargeError);
  });

  it("the client methods that call key/list, key/gen and files/rm inherit the cap", async () => {
    const client = createKuboClient({ rpc: RPC, gateway: GATEWAY, transport: always(() => new Response("q".repeat(RPC_RESPONSE_MAX_BYTES + 5))) });
    await expect(client.keyList()).rejects.toBeInstanceOf(KuboResponseTooLargeError);
    await expect(client.filesRm("/obsidian-vault-sync/x/current/a", { recursive: false })).rejects.toBeInstanceOf(KuboResponseTooLargeError);
  });

  it("a non-2xx body that never ends is read for at most the error-body cap and cancelled", async () => {
    const seen = { pulled: 0, cancelled: false };
    const failure = await failureOf(always(() => endless(seen, 502)));
    expect(failure).toBeInstanceOf(KuboHttpError);
    expect(seen.cancelled).toBe(true);
    expect(seen.pulled * 4096).toBeLessThanOrEqual(ERROR_BODY_MAX_BYTES + 4096);
    expect((failure as Error).message.length).toBeLessThan(400);
  });
});

describe("W-08: isMissingPathError trusts only the node's JSON Message on HTTP 500", () => {
  const missing = async (status: number, body: string): Promise<boolean> => isMissingPathError(await failureOf(always(() => new Response(body, { status }))));

  it("accepts the node's own message on 500", async () => {
    expect(await missing(500, JSON.stringify({ Message: "file does not exist", Code: 0, Type: "error" }))).toBe(true);
    expect(await missing(500, JSON.stringify({ Message: 'no link named "a" under bafy', Code: 0, Type: "error" }))).toBe(true);
  });

  it("rejects a proxy 404, an HTML page and the wrong status", async () => {
    expect(await missing(404, "<html>not found</html>")).toBe(false);
    expect(await missing(404, JSON.stringify({ Message: "file does not exist" }))).toBe(false);
    expect(await missing(500, "<html>502 not found upstream</html>")).toBe(false);
    expect(await missing(502, JSON.stringify({ Message: "file does not exist" }))).toBe(false);
  });

  it("does not match text that only appears in the URL", async () => {
    const client = createKuboClient({ rpc: RPC, gateway: GATEWAY, transport: always(() => new Response(JSON.stringify({ Message: "context deadline exceeded" }), { status: 500 })) });
    const failure = await client.filesStat("/does not exist/not found").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KuboHttpError);
    expect(isMissingPathError(failure)).toBe(false);
  });
});
