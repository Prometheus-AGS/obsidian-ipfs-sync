import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, ResolvedEndpoint } from "../../src/core/config";
import { KuboAuthError, createKuboClient, type KuboClient } from "../../src/kubo";

const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";
const HINT_NOT_SENT = "node credential is not sent to a gateway on a different address";

function endpoint(name: "rpc" | "gateway", baseUrl: string, auth: AuthConfig, credentialWithheld = false): ResolvedEndpoint {
  return credentialWithheld ? { name, baseUrl, auth, credentialWithheld } : { name, baseUrl, auth };
}

/** `withheld` is what the shared builder sets when the node credential was not inherited because the origins differ. */
function clientWith(rpcAuth: AuthConfig, gatewayAuth: AuthConfig, withheld = false): KuboClient {
  return createKuboClient({
    rpc: endpoint("rpc", "https://rpc.example.org:5001", rpcAuth),
    gateway: endpoint("gateway", "https://gw.example.org:8080", gatewayAuth, withheld),
  });
}

describe("auth error hint for a gateway without a credential", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("explains that the node credential is not sent and where to set one, for 401 and 403", async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status })));
      const client = clientWith({ kind: "bearer", token: "node-secret" }, { kind: "none" }, true);
      const failure = await client.gatewayFetch(CID).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(KuboAuthError);
      const message = (failure as KuboAuthError).message;
      expect(message).toContain(`HTTP ${status}`);
      expect(message).toContain(HINT_NOT_SENT);
      expect(message).toContain("Gateway authentication");
      expect(message).toContain("IPFS_SYNC_GATEWAY_AUTH_*");
      expect(message).not.toContain("node-secret");
    }
  });

  it("keeps the plain message when the gateway has no credential for another reason (explicit none, or a node without credential)", async () => {
    const plain = "credentials rejected by the gateway endpoint https://gw.example.org:8080 (HTTP 401)";
    for (const rpcAuth of [{ kind: "bearer", token: "node-secret" }, { kind: "none" }] as const) {
      const failure = await clientWith(rpcAuth, { kind: "none" }).gatewayFetch(CID).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(KuboAuthError);
      expect((failure as KuboAuthError).message).toBe(plain);
    }
  });

  it("never adds the hint for the RPC endpoint, even when marked", async () => {
    const client = createKuboClient({
      rpc: endpoint("rpc", "https://rpc.example.org:5001", { kind: "none" }, true),
      gateway: endpoint("gateway", "https://gw.example.org:8080", { kind: "none" }),
    });
    const failure = await client.id().catch((error: unknown) => error);
    expect((failure as KuboAuthError).message).toBe("credentials rejected by the rpc endpoint https://rpc.example.org:5001 (HTTP 401)");
  });

  it("does not add the hint when the gateway carries its own credential, and leaks no secret", async () => {
    const client = clientWith({ kind: "bearer", token: "node-secret" }, { kind: "bearer", token: "gw-secret" });
    const failure = await client.gatewayFetch(CID).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KuboAuthError);
    const message = (failure as KuboAuthError).message;
    expect(message).toBe(`credentials rejected by the gateway endpoint https://gw.example.org:8080 (HTTP 401)`);
    expect(message).not.toContain("gw-secret");
    expect(message).not.toContain("node-secret");
  });

  it("leaves an RPC 401 unchanged, even without a credential", async () => {
    for (const auth of [{ kind: "none" }, { kind: "bearer", token: "node-secret" }] as const) {
      const client = clientWith(auth, { kind: "none" });
      const failure = await client.id().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(KuboAuthError);
      expect((failure as KuboAuthError).message).toBe("credentials rejected by the rpc endpoint https://rpc.example.org:5001 (HTTP 401)");
    }
  });
});
