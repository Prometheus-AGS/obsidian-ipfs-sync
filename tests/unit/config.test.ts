import { describe, expect, it } from "vitest";
import {
  ConfigError,
  REDACTED,
  authWarnings,
  buildAuth,
  composeEndpointUrl,
  decodeJwtExpiry,
  describeAuth,
  envLayer,
  parseConfigFile,
  redactAuth,
  resolveSyncConfig,
} from "../../src/core/config";

const NOW = new Date("2026-09-29T12:00:00Z");

/** No node is a default, so a test that resolves a whole config names one. */
const NODE = { rpc: { url: "https://rpc.example" }, gateway: { url: "https://gw.example" } };

/** One reverse proxy that serves both the RPC API and the gateway: the same scheme, host and port. */
const SAME_ORIGIN_NODE = { rpc: { url: "https://node.example" }, gateway: { url: "https://node.example/gateway" } };
const GLOBAL_BEARER = { IPFS_SYNC_AUTH_SCHEME: "bearer", IPFS_SYNC_AUTH_TOKEN: "rpc-secret" };

function jwt(claims: Record<string, unknown>): string {
  const enc = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc(claims)}.sig`;
}

describe("composeEndpointUrl", () => {
  it("applies a separate port", () => {
    expect(composeEndpointUrl("rpc", "https://rpc.example.org", 5001)).toBe("https://rpc.example.org:5001");
    expect(composeEndpointUrl("gateway", "https://gw.example.org", "8080")).toBe("https://gw.example.org:8080");
  });

  it("keeps a URL that already has the same port and a path prefix", () => {
    expect(composeEndpointUrl("rpc", "http://host:5001/kubo/", 5001)).toBe("http://host:5001/kubo");
  });

  it("fails on a conflicting port and names the endpoint and both values", () => {
    expect(() => composeEndpointUrl("rpc", "https://host:8443", 5001)).toThrowError(
      /rpc URL already carries port 8443 but the port setting is 5001/,
    );
  });

  it("detects a conflict even when the URL port is the scheme default", () => {
    expect(() => composeEndpointUrl("rpc", "https://host:443", 5001)).toThrowError(/port 443/);
  });

  it.each(["ftp://host", "file:///tmp/x", "not a url", "", "https://u:p@host", "https://host/?a=1", "https://host/#f"])(
    "rejects %s",
    (url) => {
      expect(() => composeEndpointUrl("rpc", url)).toThrowError(ConfigError);
    },
  );

  it.each(["https://u:pa#ss@host", "https://u:pa/ss@host", "https://u:pa?ss@host", "http://user:se/cr?et#x@[bad", "http://u:p@a@[bad"])(
    "does not echo any part of a password that holds / ? or # (%s)",
    (url) => {
      let message = "";
      try {
        composeEndpointUrl("rpc", url);
      } catch (error) {
        message = String(error);
      }
      // Round 3 (K-L4): an unparsable URL is not echoed at all; the fixed phrase "invalid address" replaces the redacted echo
      // (and its "ss" is why the pattern now names the password fragments, not "pa" and "ss" alone).
      expect(message).not.toMatch(/pa#ss|pa\/ss|pa\?ss|se\/cr|cr\?et|et#x|user|p@a|u:p/);
      expect(message).toContain("invalid address");
    },
  );

  it("does not echo credentials embedded in an unparsable URL", () => {
    try {
      composeEndpointUrl("rpc", "http://user:secret@[bad");
      throw new Error("expected a failure");
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });

  it.each([0, 65536, -1, 1.5, "abc"])("rejects port %s", (port) => {
    expect(() => composeEndpointUrl("rpc", "https://host", port)).toThrowError(/port must be an integer/);
  });
});

describe("buildAuth", () => {
  it("builds every scheme", () => {
    expect(buildAuth(undefined, "auth")).toEqual({ kind: "none" });
    expect(buildAuth({ scheme: "none" }, "auth")).toEqual({ kind: "none" });
    expect(buildAuth({ scheme: "basic", user: "u", password: "p" }, "auth")).toEqual({
      kind: "basic",
      user: "u",
      password: "p",
    });
    expect(buildAuth({ scheme: "Bearer", token: "t" }, "auth")).toEqual({ kind: "bearer", token: "t" });
    expect(buildAuth({ scheme: "header", headerName: "X-Api-Key", headerValue: "v" }, "auth")).toEqual({
      kind: "header",
      name: "X-Api-Key",
      value: "v",
    });
  });

  it.each([
    [{ scheme: "basic", user: "u" }, /requires a password/],
    [{ scheme: "basic", password: "p" }, /requires a user/],
    [{ scheme: "basic", user: "a:b", password: "p" }, /must not contain ":"/],
    [{ scheme: "bearer" }, /requires a token/],
    [{ scheme: "bearer", token: "a\nb" }, /control characters/],
    [{ scheme: "header", headerName: "X-Key" }, /requires a header value/],
    [{ scheme: "header", headerName: "bad name", headerValue: "v" }, /not a valid HTTP header name/],
    [{ scheme: "oauth" }, /unknown auth scheme/],
    [{ token: "t" }, /supplied but no auth scheme/],
  ])("rejects %j", (input, message) => {
    expect(() => buildAuth(input, "auth")).toThrowError(message);
  });

  it("does not echo a header name that was a pasted secret", () => {
    const pasted = "sk-live-9f8e7d6c bearer";
    try {
      buildAuth({ scheme: "header", headerName: pasted, headerValue: "v" }, "auth");
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toMatch(/not a valid HTTP header name/);
      expect((error as Error).message).not.toMatch(/sk-live|9f8e7d6c|bearer/);
    }
  });

  it("redacts every secret and never returns the original secret", () => {
    const basic = redactAuth({ kind: "basic", user: "u", password: "p" });
    const bearer = redactAuth({ kind: "bearer", token: "tok" });
    const header = redactAuth({ kind: "header", name: "X-Api-Key", value: "v" });
    expect(basic).toEqual({ kind: "basic", user: "u", password: REDACTED });
    expect(bearer).toEqual({ kind: "bearer", token: REDACTED });
    expect(header).toEqual({ kind: "header", name: "X-Api-Key", value: REDACTED });
    expect(JSON.stringify([basic, bearer, header])).not.toMatch(/"p"|"tok"|"v"/);
  });

  it("describes the scheme without secrets", () => {
    expect(describeAuth({ kind: "basic", user: "u", password: "p" })).toBe("basic (user u)");
    expect(describeAuth({ kind: "bearer", token: "tok" })).toBe("bearer");
  });
});

describe("JWT expiry warning", () => {
  it("decodes exp", () => {
    expect(decodeJwtExpiry(jwt({ exp: 1_700_000_000 }))?.toISOString()).toBe("2023-11-14T22:13:20.000Z");
  });

  it("returns undefined for a static token or a JWT without exp", () => {
    expect(decodeJwtExpiry("static-token-value")).toBeUndefined();
    expect(decodeJwtExpiry(jwt({ sub: "x" }))).toBeUndefined();
    expect(decodeJwtExpiry("a.b.c")).toBeUndefined();
  });

  it("warns for an expired JWT and names the expiry time", () => {
    const warnings = authWarnings("rpc", { kind: "bearer", token: jwt({ exp: 1_700_000_000 }) }, NOW);
    expect(warnings).toEqual(["rpc bearer token (JWT) expired at 2023-11-14T22:13:20.000Z"]);
  });

  it("never throws for a finite but huge exp; it says the expiry could not be read", () => {
    for (const exp of [1e300, 8.65e12, -8.65e12, 1e20]) {
      const token = jwt({ exp });
      expect(() => authWarnings("rpc", { kind: "bearer", token }, NOW)).not.toThrow();
      expect(authWarnings("rpc", { kind: "bearer", token }, NOW)).toEqual(["rpc bearer token (JWT) expiry could not be read"]);
    }
    expect(() => resolveSyncConfig([NODE, { auth: { scheme: "bearer", token: jwt({ exp: 1e300 }) } }], NOW)).not.toThrow();
  });

  it("does not warn for a live JWT, a static token or other schemes", () => {
    const live = jwt({ exp: Math.floor(NOW.getTime() / 1000) + 3600 });
    expect(authWarnings("rpc", { kind: "bearer", token: live }, NOW)).toEqual([]);
    expect(authWarnings("rpc", { kind: "bearer", token: "static" }, NOW)).toEqual([]);
    expect(authWarnings("rpc", { kind: "none" }, NOW)).toEqual([]);
  });
});

describe("secret resolution and precedence", () => {
  it("reads auth secrets from IPFS_SYNC_AUTH_* env", () => {
    const layer = envLayer({ IPFS_SYNC_AUTH_SCHEME: "basic", IPFS_SYNC_AUTH_USER: "u", IPFS_SYNC_AUTH_PASSWORD: "p" });
    const config = resolveSyncConfig([SAME_ORIGIN_NODE, layer], NOW);
    expect(config.rpc.auth).toEqual({ kind: "basic", user: "u", password: "p" });
    expect(config.gateway.auth).toBe(config.rpc.auth);
  });

  it("flags beat env, env beats file, file beats defaults", () => {
    const file = parseConfigFile(JSON.stringify({ rpc: { url: "https://file.example" }, gateway: { url: "https://gw.example" }, publicationKey: "obsidian-vault-file" }));
    const env = envLayer({ IPFS_SYNC_RPC_URL: "https://env.example", IPFS_SYNC_KEY: "obsidian-vault-env" });
    const flags = { rpc: { url: "https://flag.example" } };
    const config = resolveSyncConfig([file, env, flags], NOW);
    expect(config.rpc.baseUrl).toBe("https://flag.example");
    expect(config.publicationKey).toBe("obsidian-vault-env");
    // No node is a default: the gateway comes from a layer, never from the RPC URL or a built-in host.
    expect(config.gateway.baseUrl).toBe("https://gw.example");
    expect(config.mfsRoot).toBe("/obsidian-vault-sync/default");
  });

  it("merges auth field by field across layers", () => {
    const file = parseConfigFile(JSON.stringify({ auth: { scheme: "basic", user: "u" } }));
    const env = envLayer({ IPFS_SYNC_AUTH_PASSWORD: "p" });
    expect(resolveSyncConfig([NODE, file, env], NOW).rpc.auth).toEqual({ kind: "basic", user: "u", password: "p" });
  });

  it("lets an endpoint override the global auth", () => {
    const env = envLayer({
      IPFS_SYNC_AUTH_SCHEME: "bearer",
      IPFS_SYNC_AUTH_TOKEN: "t",
      IPFS_SYNC_GATEWAY_AUTH_SCHEME: "none",
    });
    const config = resolveSyncConfig([NODE, env], NOW);
    expect(config.rpc.auth).toEqual({ kind: "bearer", token: "t" });
    expect(config.gateway.auth).toEqual({ kind: "none" });
  });

  it("gives the gateway the global auth only when it has the RPC endpoint's origin", () => {
    const config = resolveSyncConfig([SAME_ORIGIN_NODE, envLayer(GLOBAL_BEARER)], NOW);
    expect(config.gateway.auth).toEqual({ kind: "bearer", token: "rpc-secret" });
    // The default port of the scheme is the same origin as the port written out.
    const explicitPort = resolveSyncConfig([{ rpc: { url: "https://node.example" }, gateway: { url: "https://node.example:443" } }, envLayer(GLOBAL_BEARER)], NOW);
    expect(explicitPort.gateway.auth).toEqual({ kind: "bearer", token: "rpc-secret" });
  });

  it("does not send the global auth to a gateway on another host", () => {
    const config = resolveSyncConfig([{ rpc: { url: "https://rpc.example" }, gateway: { url: "https://gw.example" } }, envLayer(GLOBAL_BEARER)], NOW);
    expect(config.rpc.auth).toEqual({ kind: "bearer", token: "rpc-secret" });
    expect(config.gateway.auth).toEqual({ kind: "none" });
  });

  it("does not send the global auth to a gateway on another port of the same host", () => {
    const config = resolveSyncConfig([{ rpc: { url: "https://node.example", port: 5001 }, gateway: { url: "https://node.example", port: 8080 } }, envLayer(GLOBAL_BEARER)], NOW);
    expect(config.gateway.baseUrl).toBe("https://node.example:8080");
    expect(config.gateway.auth).toEqual({ kind: "none" });
  });

  it("does not send the global auth to a gateway on another scheme", () => {
    const config = resolveSyncConfig([{ rpc: { url: "https://node.example" }, gateway: { url: "http://node.example" } }, envLayer(GLOBAL_BEARER)], NOW);
    expect(config.gateway.auth).toEqual({ kind: "none" });
  });

  it("lets an explicit gateway auth win on a different origin and on the same origin", () => {
    const own = { IPFS_SYNC_GATEWAY_AUTH_SCHEME: "basic", IPFS_SYNC_GATEWAY_AUTH_USER: "g", IPFS_SYNC_GATEWAY_AUTH_PASSWORD: "gp" };
    const elsewhere = resolveSyncConfig([{ rpc: { url: "https://rpc.example" }, gateway: { url: "https://gw.example" } }, envLayer({ ...GLOBAL_BEARER, ...own })], NOW);
    expect(elsewhere.rpc.auth).toEqual({ kind: "bearer", token: "rpc-secret" });
    expect(elsewhere.gateway.auth).toEqual({ kind: "basic", user: "g", password: "gp" });
    const sameOrigin = resolveSyncConfig([SAME_ORIGIN_NODE, envLayer({ ...GLOBAL_BEARER, ...own })], NOW);
    expect(sameOrigin.gateway.auth).toEqual({ kind: "basic", user: "g", password: "gp" });
  });

  it("marks the gateway credentialWithheld only when it has none because the origin differs from a credentialed RPC", () => {
    const other = { rpc: { url: "https://rpc.example" }, gateway: { url: "https://gw.example" } };
    const withheld = resolveSyncConfig([other, envLayer(GLOBAL_BEARER)], NOW);
    expect(withheld.gateway.credentialWithheld).toBe(true);
    expect(withheld.rpc.credentialWithheld).toBeUndefined();
    // Same origin: inherited. No node credential: nothing was withheld. Explicit none or explicit auth: the operator chose.
    expect(resolveSyncConfig([SAME_ORIGIN_NODE, envLayer(GLOBAL_BEARER)], NOW).gateway.credentialWithheld).toBeUndefined();
    expect(resolveSyncConfig([other], NOW).gateway.credentialWithheld).toBeUndefined();
    expect(resolveSyncConfig([{ ...other, gateway: { url: "https://gw.example", auth: { scheme: "none" } } }, envLayer(GLOBAL_BEARER)], NOW).gateway.credentialWithheld).toBeUndefined();
    expect(resolveSyncConfig([{ ...other, gateway: { url: "https://gw.example", auth: { scheme: "bearer", token: "g" } } }, envLayer(GLOBAL_BEARER)], NOW).gateway.credentialWithheld).toBeUndefined();
  });

  it("composes separate RPC and gateway hosts and ports", () => {
    const config = resolveSyncConfig(
      [{ rpc: { url: "https://rpc.example.org", port: 5001 }, gateway: { url: "https://gw.example.org", port: "8080" } }],
      NOW,
    );
    expect(config.rpc.baseUrl).toBe("https://rpc.example.org:5001");
    expect(config.gateway.baseUrl).toBe("https://gw.example.org:8080");
  });

  it("does not inherit a lower layer's port when a higher layer sets only a URL", () => {
    const config = resolveSyncConfig([NODE, { rpc: { url: "https://a.example", port: 5001 } }, { rpc: { url: "https://b.example" } }], NOW);
    expect(config.rpc.baseUrl).toBe("https://b.example");
  });

  it("collects a single warning when both endpoints share an expired JWT", () => {
    const token = jwt({ exp: 1_700_000_000 });
    const config = resolveSyncConfig([SAME_ORIGIN_NODE, { auth: { scheme: "bearer", token } }], NOW);
    expect(config.warnings).toEqual(["auth bearer token (JWT) expired at 2023-11-14T22:13:20.000Z"]);
    // Another origin no longer shares the credential, so only the RPC endpoint carries (and warns about) it.
    const split = resolveSyncConfig([NODE, { auth: { scheme: "bearer", token } }], NOW);
    expect(split.warnings).toEqual(["rpc bearer token (JWT) expired at 2023-11-14T22:13:20.000Z"]);
  });

  it("fails closed on unsafe root and key before returning a config", () => {
    expect(() => resolveSyncConfig([{ mfsRoot: "/obsidian-vault-staging" }], NOW)).toThrowError(/outside \/obsidian-vault-sync/);
    expect(() => resolveSyncConfig([{ publicationKey: "consult-capture" }], NOW)).toThrowError(/refused/);
  });
});

describe("parseConfigFile", () => {
  it("accepts endpoints and non-secret fields", () => {
    const layer = parseConfigFile(
      JSON.stringify({
        rpc: { url: "https://rpc.example.org", port: 5001, auth: { scheme: "none" } },
        gateway: { url: "https://gw.example.org" },
        publicationKey: "obsidian-vault",
        mfsRoot: "/obsidian-vault-sync",
        auth: { scheme: "header", headerName: "X-Api-Key" },
        ownedKeys: ["k51abc"],
      }),
    );
    expect(layer.rpc?.port).toBe(5001);
    expect(layer.auth?.headerName).toBe("X-Api-Key");
    expect(layer.ownedKeys).toEqual(["k51abc"]);
  });

  it.each([
    [{ auth: { scheme: "bearer", token: "x" } }, "auth.token"],
    [{ auth: { scheme: "basic", user: "u", password: "p" } }, "auth.password"],
    [{ auth: { scheme: "header", headerName: "X", headerValue: "v" } }, "auth.headerValue"],
    [{ rpc: { url: "https://h", auth: { token: "x" } } }, "rpc.auth.token"],
    [{ token: "x" }, "token"],
    [{ passphrase: "x" }, "passphrase"],
    [{ Passphrase: "x" }, "Passphrase"],
  ])("rejects a secret key in %j", (file, key) => {
    let caught: unknown;
    try {
      parseConfigFile(JSON.stringify(file));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).code).toBe("secret-in-config-file");
    expect((caught as ConfigError).message).toContain(key);
    expect((caught as ConfigError).message).not.toContain('"x"');
  });

  it.each(["not json", "[]", JSON.stringify({ surprise: 1 }), JSON.stringify({ rpc: { port: {} } }), JSON.stringify({ ownedKeys: [1] })])(
    "rejects malformed file %s",
    (text) => {
      expect(() => parseConfigFile(text)).toThrowError(ConfigError);
    },
  );
});
