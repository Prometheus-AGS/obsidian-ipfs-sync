// Review round 3, K-L2 / K-L3 / K-L4: a credential over plain http to a non-loopback host is warned about (never refused), and an address that
// does not parse is never echoed (a query string or a password in it would show).
import { describe, expect, it } from "vitest";
import { composeEndpointUrl, displayAddress, resolveSyncConfig } from "../../src/core/config";

const NOW = new Date("2026-10-05T12:00:00Z");
const BEARER = { scheme: "bearer", token: "plain-static-token" };

function config(rpcUrl: string, gatewayUrl: string, auth: object | null = BEARER) {
  return resolveSyncConfig([{ rpc: { url: rpcUrl }, gateway: { url: gatewayUrl }, ...(auth === null ? {} : { auth }) }], NOW);
}

describe("a credential over plain http (K-L2)", () => {
  it("warns for a non-loopback http endpoint that carries a credential, and still builds the configuration", () => {
    const built = config("http://node.example.org:5001", "http://node.example.org:8080");
    expect(built.rpc.auth).toEqual({ kind: "bearer", token: "plain-static-token" });
    const text = built.warnings.join("\n");
    expect(text).toMatch(/http/);
    expect(text).toContain("node.example.org");
    expect(text).not.toContain("plain-static-token");
  });

  it("names each endpoint that is affected", () => {
    const built = config("https://node.example.org", "http://other.example.org", null);
    expect(built.warnings).toEqual([]);
    const withGateway = resolveSyncConfig(
      [{ rpc: { url: "https://node.example.org" }, gateway: { url: "http://gw.example.org", auth: BEARER } }],
      NOW,
    );
    expect(withGateway.warnings).toHaveLength(1);
    expect(withGateway.warnings[0]).toContain("gateway");
  });

  it.each(["http://localhost:5001", "http://127.0.0.1:5001", "http://127.9.9.9", "http://[::1]:5001", "http://app.localhost"])("does not warn for loopback %s", (url) => {
    expect(config(url, url).warnings).toEqual([]);
  });

  it("does not warn for https, or for http without a credential", () => {
    expect(config("https://node.example.org", "https://node.example.org").warnings).toEqual([]);
    expect(config("http://node.example.org", "http://node.example.org", null).warnings).toEqual([]);
  });
});

describe("an address that does not parse is never echoed (K-L3, K-L4)", () => {
  const hostile = "http://[bad?token=sekrit-token&u=1";

  it("displayAddress prints the fixed phrase", () => {
    expect(displayAddress(hostile)).toBe("invalid address");
    expect(displayAddress("not a url ?token=sekrit-token")).toBe("invalid address");
  });

  it("displayAddress drops userinfo, query and fragment of an address that parses, from the parsed parts", () => {
    expect(displayAddress("https://alice:hunter2@node.example.org/base/?token=t0k#frag")).toBe("https://node.example.org/base");
    expect(displayAddress("")).toBe("");
  });

  it("the configuration error for an unparsable URL carries the fixed phrase and none of the text", () => {
    let message = "";
    try {
      composeEndpointUrl("rpc", hostile);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("invalid address");
    expect(message).not.toContain("sekrit-token");
    expect(message).not.toContain("token=");
  });
});
