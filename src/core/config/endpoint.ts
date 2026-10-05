import { ConfigError } from "./errors";
import type { EndpointName } from "./types";

const MAX_PORT = 65535;
const EXPLICIT_PORT = /^https?:\/\/(?:[^/?#@]*@)?(?:\[[^\]]*\]|[^/?#:]*):(\d+)/i;
/** Everything between `//` and the last `@` before the first whitespace: a password may itself hold `/`, `?` or `#`. */
const USERINFO = /\/\/\S*@/;

/** The text with any userinfo (user and password) replaced by a marker, so it is safe to put in a message. */
export function redactUserinfo(text: string): string {
  return text.replace(USERINFO, "//<redacted>@");
}

/** True when the text looks like a URL with userinfo, whether or not it parses. */
export function hasUserinfo(text: string): boolean {
  return USERINFO.test(text);
}

const INVALID_ADDRESS = "invalid address";

/**
 * An address as it may be shown: scheme, host, port and path only. Userinfo, query and fragment are dropped; text that
 * does not parse as a URL becomes a fixed phrase. An empty address stays empty.
 */
export function displayAddress(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  // Parse first: the parts that may be shown (protocol, host, path) come from the parsed URL, so userinfo, query and fragment are never
  // in the output whatever characters they hold. Text that does not parse is not echoed at all.
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return INVALID_ADDRESS;
  }
}

/** Parse a port from a number or numeric string. Empty or missing means "unset". */
export function parsePort(name: EndpointName, value: number | string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_PORT) {
    throw new ConfigError("invalid-port", `${name} port must be an integer from 1 to ${MAX_PORT}, got "${String(value)}"`);
  }
  return n;
}

function parseHttpUrl(name: EndpointName, raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError("invalid-url", `${name} URL is not a valid URL: ${INVALID_ADDRESS}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError("invalid-url", `${name} URL must use http or https, got "${parsed.protocol}"`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ConfigError("invalid-url", `${name} URL must not embed credentials; use the auth settings`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new ConfigError("invalid-url", `${name} URL must not carry a query string or fragment`);
  }
  return parsed;
}

/**
 * Compose the endpoint base URL from a URL and an optional separate port.
 * A URL that already names a different port is an error, never silently overridden.
 */
export function composeEndpointUrl(
  name: EndpointName,
  rawUrl: string,
  portInput?: number | string,
): string {
  const parsed = parseHttpUrl(name, rawUrl);
  const port = parsePort(name, portInput);
  const inUrl = EXPLICIT_PORT.exec(rawUrl)?.[1];
  if (port !== undefined && inUrl !== undefined && Number(inUrl) !== port) {
    throw new ConfigError(
      "port-conflict",
      `${name} URL already carries port ${inUrl} but the port setting is ${port}`,
    );
  }
  if (port !== undefined) parsed.port = String(port);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}
