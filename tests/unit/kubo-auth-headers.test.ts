import { describe, expect, it } from "vitest";
import { REDACTED, type AuthConfig } from "../../src/core/config";
import { authHeaders, credentialHeaderNames, redactHeaderEntries, redactedAuthHeaders } from "../../src/kubo";

describe("authHeaders", () => {
  it("sends nothing for none", () => {
    expect(authHeaders({ kind: "none" })).toEqual({});
  });

  it("builds Basic base64(user:password)", () => {
    const expected = `Basic ${Buffer.from("u:p").toString("base64")}`;
    expect(authHeaders({ kind: "basic", user: "u", password: "p" })).toEqual({ Authorization: expected });
  });

  it("encodes non-ASCII basic credentials as UTF-8", () => {
    const expected = `Basic ${Buffer.from("usér:pässwörd", "utf8").toString("base64")}`;
    expect(authHeaders({ kind: "basic", user: "usér", password: "pässwörd" })).toEqual({ Authorization: expected });
  });

  it("builds Bearer for a static token or a JWT", () => {
    expect(authHeaders({ kind: "bearer", token: "abc.def.ghi" })).toEqual({ Authorization: "Bearer abc.def.ghi" });
  });

  it("uses the custom header name", () => {
    expect(authHeaders({ kind: "header", name: "X-Api-Key", value: "v" })).toEqual({ "X-Api-Key": "v" });
  });
});

describe("redaction for --show-request", () => {
  const cases: readonly (readonly [string, AuthConfig, string])[] = [
    ["basic", { kind: "basic", user: "u", password: "p" }, "Authorization"],
    ["bearer", { kind: "bearer", token: "tok" }, "Authorization"],
    ["header", { kind: "header", name: "X-Api-Key", value: "v" }, "X-Api-Key"],
  ];

  it.each(cases)("%s shows the header name with a redacted value", (_scheme, auth, name) => {
    expect(redactedAuthHeaders(auth)).toEqual({ [name]: REDACTED });
  });

  it("redacts credential headers in a captured request and leaves others visible", () => {
    const auth: AuthConfig = { kind: "header", name: "X-Api-Key", value: "v" };
    const entries = redactHeaderEntries(
      [
        ["x-api-key", "v"],
        ["Authorization", "Bearer leaked"],
        ["content-type", "application/json"],
      ],
      auth,
    );
    expect(entries).toEqual([
      ["x-api-key", REDACTED],
      ["Authorization", REDACTED],
      ["content-type", "application/json"],
    ]);
    expect(credentialHeaderNames({ kind: "none" })).toContain("authorization");
  });
});
