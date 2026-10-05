/**
 * Request header names Node honours as connection framing or routing. One set, two enforcers: `buildAuth` refuses them as the
 * name of a custom credential header, and the desktop transport refuses them in any request it is asked to send. Lower case.
 */
export const CONNECTION_FRAMING_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "transfer-encoding",
  "connection",
  "content-length",
  "upgrade",
  "expect",
  "te",
  "keep-alive",
  "proxy-connection",
  "trailer",
]);

/**
 * Names a custom credential header may not use: the framing set, plus the two headers the client sets itself. A credential
 * header named Content-Type or Range would merge with the real one through `Headers` ("secret, bytes=..."). The transport does
 * NOT refuse these two: the client sets them legitimately.
 */
export const CREDENTIAL_FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([...CONNECTION_FRAMING_HEADERS, "content-type", "range"]);

export function isConnectionFramingHeader(name: string): boolean {
  return CONNECTION_FRAMING_HEADERS.has(name.toLowerCase());
}

export function isCredentialForbiddenHeader(name: string): boolean {
  return CREDENTIAL_FORBIDDEN_HEADERS.has(name.toLowerCase());
}
