// Delta review A-L6: the gateway's CID check and the target checks (--root-cid, --manifest, --name) use the same 10 to 128 bound as the local record.
import { describe, expect, it, vi } from "vitest";
import type { ResolvedEndpoint } from "../../src/core/config";
import { KuboError } from "../../src/kubo";
import { fetchGatewayBytes, openGatewayStream } from "../../src/kubo/gateway";
import type { Transport } from "../../src/kubo/http";
import { isCid, isIpnsName } from "../../src/sync/target-resolution";

const GATEWAY: ResolvedEndpoint = { name: "gateway", baseUrl: "https://gw.example.org", auth: { kind: "none" } };

function transportStub(): { readonly transport: Transport; readonly calls: string[] } {
  const calls: string[] = [];
  const transport = Object.assign(
    vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(new Uint8Array([1, 2, 3]));
    }),
    { transportName: "stub" },
  ) as unknown as Transport;
  return { transport, calls };
}

const IN_BOUNDS = ["a".repeat(10), "a".repeat(59), "a".repeat(128)];
const OUT_OF_BOUNDS = ["a".repeat(9), "a".repeat(129), "a".repeat(500), "", "a".repeat(10) + "-", " " + "a".repeat(20)];

describe("the gateway's CID check (A-L6)", () => {
  it.each(IN_BOUNDS)("fetches a CID of %s characters", async (cid) => {
    const { transport, calls } = transportStub();
    await fetchGatewayBytes(GATEWAY, cid, "", transport);
    expect(calls).toEqual([`https://gw.example.org/ipfs/${cid}`]);
  });

  it.each(OUT_OF_BOUNDS)("refuses %j before any request, for a whole read and for a stream", async (cid) => {
    const { transport, calls } = transportStub();
    await expect(fetchGatewayBytes(GATEWAY, cid, "", transport)).rejects.toBeInstanceOf(KuboError);
    await expect(openGatewayStream(GATEWAY, cid, "", undefined, transport)).rejects.toBeInstanceOf(KuboError);
    expect(calls).toEqual([]);
  });

  it("does not echo more than a short, sanitised prefix of a refused CID", async () => {
    const { transport } = transportStub();
    const error = await fetchGatewayBytes(GATEWAY, "x".repeat(300), "", transport).catch((caught: unknown) => caught);
    expect((error as Error).message.length).toBeLessThan(200);
  });
});

describe("the target checks (A-L6)", () => {
  it.each(IN_BOUNDS)("accepts %s characters as a CID and as an IPNS name", (value) => {
    expect(isCid(value)).toBe(true);
    expect(isIpnsName(value)).toBe(true);
  });

  it.each(OUT_OF_BOUNDS)("refuses %j as a CID and as an IPNS name", (value) => {
    expect(isCid(value)).toBe(false);
    expect(isIpnsName(value)).toBe(false);
  });
});
