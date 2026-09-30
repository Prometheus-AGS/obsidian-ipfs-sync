import { REDACTED, type AuthConfig } from "../core/config";

export type HeaderMap = Readonly<Record<string, string>>;

const ALWAYS_CREDENTIAL_HEADERS: readonly string[] = ["authorization", "proxy-authorization", "cookie"];

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}

/** Headers that carry the configured credentials. Empty for `none`. */
export function authHeaders(auth: AuthConfig): HeaderMap {
  switch (auth.kind) {
    case "none":
      return {};
    case "basic":
      return { Authorization: `Basic ${utf8ToBase64(`${auth.user}:${auth.password}`)}` };
    case "bearer":
      return { Authorization: `Bearer ${auth.token}` };
    case "header":
      return { [auth.name]: auth.value };
  }
}

/** The auth headers with values replaced by a marker, for `--show-request` output. */
export function redactedAuthHeaders(auth: AuthConfig): HeaderMap {
  return Object.fromEntries(Object.keys(authHeaders(auth)).map((name) => [name, REDACTED]));
}

/** Names (lower case) whose values must never be printed for this auth config. */
export function credentialHeaderNames(auth: AuthConfig): readonly string[] {
  const custom = auth.kind === "header" ? [auth.name.toLowerCase()] : [];
  return [...ALWAYS_CREDENTIAL_HEADERS, ...custom];
}

/** Redact credential values in an arbitrary header list; other values pass through. */
export function redactHeaderEntries(
  entries: Iterable<readonly [string, string]>,
  auth: AuthConfig,
): readonly (readonly [string, string])[] {
  const secret = credentialHeaderNames(auth);
  return Array.from(entries, ([name, value]) => [name, secret.includes(name.toLowerCase()) ? REDACTED : value] as const);
}
