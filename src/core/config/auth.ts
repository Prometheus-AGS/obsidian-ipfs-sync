import { isConnectionFramingHeader, isCredentialForbiddenHeader } from "./connection-headers";
import { ConfigError } from "./errors";
import type { AuthConfig, RawAuthInput } from "./types";

export const REDACTED = "<redacted>";

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function suppliedFields(raw: RawAuthInput): readonly string[] {
  const fields: readonly (readonly [string, string | undefined])[] = [
    ["user", raw.user],
    ["password", raw.password],
    ["token", raw.token],
    ["header name", raw.headerName],
    ["header value", raw.headerValue],
  ];
  return fields.filter(([, value]) => value !== undefined && value !== "").map(([field]) => field);
}

function need(label: string, scheme: string, field: string, value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new ConfigError("invalid-auth", `${label}: the ${scheme} scheme requires ${field}`);
  }
  if (CONTROL_CHARS.test(value)) {
    throw new ConfigError("invalid-auth", `${label}: ${field} contains control characters`);
  }
  return value;
}

function buildBasic(label: string, raw: RawAuthInput): AuthConfig {
  const user = need(label, "basic", "a user", raw.user);
  const password = need(label, "basic", "a password", raw.password);
  if (user.includes(":")) {
    throw new ConfigError("invalid-auth", `${label}: a basic-auth user must not contain ":"`);
  }
  return { kind: "basic", user, password };
}

function buildHeader(label: string, raw: RawAuthInput): AuthConfig {
  const name = need(label, "header", "a header name", raw.headerName);
  const value = need(label, "header", "a header value", raw.headerValue);
  if (!HEADER_NAME.test(name)) {
    throw new ConfigError("invalid-auth", `${label}: the header name is not a valid HTTP header name`);
  }
  if (isConnectionFramingHeader(name)) {
    throw new ConfigError("invalid-auth", `${label}: that header name is controlled by the HTTP connection and cannot carry a credential`);
  }
  if (isCredentialForbiddenHeader(name)) {
    throw new ConfigError("invalid-auth", `${label}: that header name is set by the request itself and cannot carry a credential`);
  }
  return { kind: "header", name, value };
}

/**
 * Validate raw auth input into the discriminated union.
 * Credentials without a scheme are an error, never silently dropped.
 */
export function buildAuth(raw: RawAuthInput | undefined, label: string): AuthConfig {
  const input = raw ?? {};
  const scheme = input.scheme?.trim().toLowerCase();
  if (scheme === undefined || scheme === "") {
    const stray = suppliedFields(input);
    if (stray.length > 0) {
      throw new ConfigError("invalid-auth", `${label}: ${stray.join(", ")} supplied but no auth scheme is set`);
    }
    return { kind: "none" };
  }
  switch (scheme) {
    case "none":
      return { kind: "none" };
    case "basic":
      return buildBasic(label, input);
    case "bearer":
      return { kind: "bearer", token: need(label, "bearer", "a token", input.token) };
    case "header":
      return buildHeader(label, input);
    default:
      throw new ConfigError("invalid-auth", `${label}: unknown auth scheme "${scheme}" (use none, basic, bearer or header)`);
  }
}

/** Copy of the auth with every secret value replaced by a marker. Safe to print or serialise. */
export function redactAuth(auth: AuthConfig): AuthConfig {
  switch (auth.kind) {
    case "none":
      return auth;
    case "basic":
      return { kind: "basic", user: auth.user, password: REDACTED };
    case "bearer":
      return { kind: "bearer", token: REDACTED };
    case "header":
      return { kind: "header", name: auth.name, value: REDACTED };
  }
}

/** One-line description that names the scheme but never a secret. */
export function describeAuth(auth: AuthConfig): string {
  switch (auth.kind) {
    case "none":
      return "none";
    case "basic":
      return `basic (user ${auth.user})`;
    case "bearer":
      return "bearer";
    case "header":
      return `header (${auth.name})`;
  }
}
