import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, type ResolvedEndpoint } from "../../src/core/config";
import { DEFAULT_IPNS_TTL, createKuboClient, type KuboClient } from "../../src/kubo";

const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

interface Captured {
  readonly url: URL;
  readonly init: RequestInit;
}

function endpoint(name: "rpc" | "gateway", baseUrl: string): ResolvedEndpoint {
  return { name, baseUrl, auth: { kind: "bearer", token: "tok" } };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("key, pin and name operations", () => {
  let calls: Captured[];
  let respond: (url: URL) => Response;
  let client: KuboClient;

  beforeEach(() => {
    calls = [];
    respond = () => json({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        calls.push({ url, init });
        return respond(url);
      }),
    );
    client = createKuboClient({
      rpc: endpoint("rpc", "https://rpc.example.org"),
      gateway: endpoint("gateway", "https://gw.example.org"),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("key/gen sends the name and type in the query string with no body", async () => {
    respond = () => json({ Name: "obsidian-vault-sync", Id: "k51new" });
    expect(await client.keyGen("obsidian-vault-sync")).toEqual({ name: "obsidian-vault-sync", id: "k51new" });
    const call = calls[0];
    expect(call?.init.method).toBe("POST");
    expect(call?.url.pathname).toBe("/api/v0/key/gen");
    expect(call?.url.searchParams.get("arg")).toBe("obsidian-vault-sync");
    expect(call?.url.searchParams.get("type")).toBe("ed25519");
    expect(call?.init.body ?? undefined).toBeUndefined();
    expect(new Headers(call?.init.headers).get("authorization")).toBe("Bearer tok");
  });

  it.each(["consult-capture", "gomark-relay-lab", "prince-live", "self", "other-name", "Obsidian-Vault"])(
    "key/gen refuses %s before any request",
    async (name) => {
      await expect(client.keyGen(name)).rejects.toBeInstanceOf(ConfigError);
      expect(calls).toHaveLength(0);
    },
  );

  it("pin/add is recursive, quiet and query-string only", async () => {
    respond = () => json({ Pins: [CID] });
    await client.pinAdd(CID);
    const query = calls[0]?.url.searchParams;
    expect(calls[0]?.url.pathname).toBe("/api/v0/pin/add");
    expect(query?.get("arg")).toBe(CID);
    expect(query?.get("recursive")).toBe("true");
    expect(query?.get("progress")).toBe("false");
    expect(calls[0]?.init.body ?? undefined).toBeUndefined();
  });

  it("pin/add refuses something that is not a CID before any request", async () => {
    await expect(client.pinAdd("../../etc")).rejects.toThrow(/not a valid CID/);
    expect(calls).toHaveLength(0);
  });

  it("name/publish sends /ipfs/<cid>, the key and ttl=5m by default", async () => {
    respond = () => json({ Name: "k51new", Value: `/ipfs/${CID}` });
    expect(await client.namePublish("obsidian-vault-sync", CID)).toEqual({ name: "k51new", value: `/ipfs/${CID}` });
    const query = calls[0]?.url.searchParams;
    expect(calls[0]?.url.pathname).toBe("/api/v0/name/publish");
    expect(query?.get("arg")).toBe(`/ipfs/${CID}`);
    expect(query?.get("key")).toBe("obsidian-vault-sync");
    expect(query?.get("ttl")).toBe("5m");
    expect(DEFAULT_IPNS_TTL).toBe("5m");
  });

  it("name/publish takes an explicit ttl", async () => {
    respond = () => json({ Name: "k51new", Value: `/ipfs/${CID}` });
    await client.namePublish("obsidian-vault-sync", CID, "30s");
    expect(calls[0]?.url.searchParams.get("ttl")).toBe("30s");
  });

  it.each(["consult-capture", "gomark-relay-lab", "prince-live", "someone-else"])(
    "name/publish refuses key %s before any request",
    async (key) => {
      await expect(client.namePublish(key, CID)).rejects.toBeInstanceOf(ConfigError);
      expect(calls).toHaveLength(0);
    },
  );

  it("name/resolve prefixes /ipns/ and returns the path", async () => {
    respond = () => json({ Path: `/ipfs/${CID}` });
    expect(await client.nameResolve("k51new")).toBe(`/ipfs/${CID}`);
    expect(calls[0]?.url.pathname).toBe("/api/v0/name/resolve");
    expect(calls[0]?.url.searchParams.get("arg")).toBe("/ipns/k51new");
    expect(calls[0]?.url.searchParams.get("nocache")).toBe("true");
  });

  it("reports a malformed response instead of returning undefined fields", async () => {
    respond = () => new Response("<html>bad gateway</html>", { status: 200 });
    await expect(client.keyGen("obsidian-vault-sync")).rejects.toThrow(/unexpected response from key\/gen/);
    respond = () => json({ Nope: 1 });
    await expect(client.namePublish("obsidian-vault-sync", CID)).rejects.toThrow(/missing string field "Name"/);
  });

  it("exposes no removal, rename or rotation for keys or pins", () => {
    const names = Object.keys(client);
    expect(names).toEqual(expect.arrayContaining(["keyGen", "keyList", "pinAdd", "namePublish", "nameResolve"]));
    for (const forbidden of ["keyRm", "keyRemove", "keyRename", "keyRotate", "pinRm", "pinRemove"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("files/write carries the chunk offset in the query string", async () => {
    respond = () => new Response("", { status: 200 });
    await client.filesWrite("/obsidian-vault-sync/x/big.bin", new Uint8Array(4), { offset: 8_388_608, truncate: false });
    const query = calls[0]?.url.searchParams;
    expect(query?.get("offset")).toBe("8388608");
    expect(query?.get("truncate")).toBe("false");
  });
});
