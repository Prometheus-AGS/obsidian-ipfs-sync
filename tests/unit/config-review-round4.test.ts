// Delta review A-M2, A-L7, A-L8: the rule is tested over its variants, not one example.
//   A-M2  an address is shown only when it parses as http or https with a host; anything else is the fixed phrase. The protocol error is fixed text.
//   A-L7  the plain-http credential warning exempts only localhost, 127.0.0.0/8 and [::1] (not *.localhost).
//   A-L8  an explicit port in the URL is found whatever whitespace or control characters the URL parser would strip.
import { describe, expect, it } from "vitest";
import { ConfigError, composeEndpointUrl, displayAddress, resolveSyncConfig } from "../../src/core/config";

const NOW = new Date("2026-10-05T12:00:00Z");
const BEARER = { scheme: "bearer", token: "plain-static-token" };

describe("displayAddress shows only http or https with a host (A-M2)", () => {
  it.each([
    "user:s3cret@host:5001",
    "bob:hunter2",
    "javascript:alert(1)",
    "ftp://u:p@h",
    "ftp://h/path",
    "file:///etc/passwd",
    "ws://h:1",
    "mailto:bob:hunter2@example.org",
    "data:text/plain,secret",
    "http://",
    "https://",
    "http://:80",
    "not a url",
    "//u:p@host",
    "host:5001",
    "  user:s3cret@host:5001  ",
  ])("prints the fixed phrase for %j", (raw) => {
    expect(displayAddress(raw)).toBe("invalid address");
  });

  it.each([
    ["http://host:5001", "http://host:5001"],
    ["https://node.example.org/base/", "https://node.example.org/base"],
    ["  https://node.example.org/base//  ", "https://node.example.org/base"],
    ["HTTP://Host:8080/", "http://host:8080"],
    ["http://[::1]:5001/api", "http://[::1]:5001/api"],
    ["https://alice:hunter2@node.example.org/base/?token=t0k#frag", "https://node.example.org/base"],
  ])("shows %j as %j", (raw, shown) => {
    expect(displayAddress(raw)).toBe(shown);
  });

  it("keeps an empty address empty", () => {
    expect(displayAddress("")).toBe("");
    expect(displayAddress("   ")).toBe("");
  });

  it.each(["user:s3cret@host:5001", "bob:hunter2", "javascript:alert(1)", "ftp://u:p@h", "mailto:x"])(
    "the protocol refusal for %j is fixed text that does not carry the scheme or the address",
    (raw) => {
      let caught: unknown;
      try {
        composeEndpointUrl("rpc", raw);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      const message = (caught as Error).message;
      expect(message).toBe("rpc URL must use http or https");
      for (const leaked of ["s3cret", "hunter2", "alert", "user:", "bob:", "ftp:", "mailto"]) expect(message).not.toContain(leaked);
    },
  );
});

describe("the plain-http warning exempts only the machine itself (A-L7)", () => {
  const warns = (url: string): boolean =>
    resolveSyncConfig([{ rpc: { url }, gateway: { url }, auth: BEARER }], NOW).warnings.some((line) => line.includes("plain http"));

  it.each(["http://localhost:5001", "http://LOCALHOST", "http://127.0.0.1:5001", "http://127.9.9.9", "http://127.255.255.254", "http://[::1]:5001"])(
    "does not warn for %s",
    (url) => {
      expect(warns(url)).toBe(false);
    },
  );

  it.each([
    "http://app.localhost",
    "http://deep.sub.localhost:5001",
    "http://localhost.example.org",
    "http://notlocalhost",
    "http://128.0.0.1",
    "http://126.255.255.255",
    "http://127.0.0.1.example.org",
    "http://[::2]:5001",
    "http://node.example.org",
  ])("warns for %s", (url) => {
    expect(warns(url)).toBe(true);
  });
});

describe("an explicit port in the URL is found whatever the URL parser strips (A-L8)", () => {
  it.each([
    " http://h:8080",
    "http://h:8080 ",
    "  http://h:8080/base  ",
    "\thttp://h:8080",
    "\nhttp://h:8080\n",
    "\u0001http://h:8080",
    "http://h:8080\t",
    "http://h:80\t80",
    "http:\\\\h:8080",
    "http:h:8080",
    "http:/h:8080",
    "http://h:8080",
    "HTTP://h:8080",
    "http://[::1]:8080",
  ])("%j with port 9000 is a conflict", (raw) => {
    let caught: unknown;
    try {
      composeEndpointUrl("rpc", raw, 9000);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).code).toBe("port-conflict");
  });

  it.each([" http://h:8080", "http://h:8080 ", "\thttp://h:8080", "http:\\\\h:8080", "http://h:8080"])("%j with the same port 8080 is accepted", (raw) => {
    expect(composeEndpointUrl("rpc", raw, 8080)).toBe("http://h:8080");
  });

  it("a URL without a port takes the setting, trimmed or not", () => {
    expect(composeEndpointUrl("rpc", " http://h ", 9000)).toBe("http://h:9000");
    expect(composeEndpointUrl("rpc", "http://h/base/", "9000")).toBe("http://h:9000/base");
  });
});
