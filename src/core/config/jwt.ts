import type { AuthConfig } from "./types";

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const MS_PER_SECOND = 1000;

function decodeBase64Url(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/**
 * Read the `exp` claim of a JWT. The signature is never verified: the result
 * only feeds a warning. A token that is not a JWT (a static token) yields undefined.
 */
export function decodeJwtExpiry(token: string): Date | undefined {
  if (!JWT_SHAPE.test(token)) return undefined;
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(decodeBase64Url(payload));
    if (typeof claims !== "object" || claims === null) return undefined;
    const exp = (claims as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? new Date(exp * MS_PER_SECOND) : undefined;
  } catch {
    // Not decodable as a JWT payload: treat as an opaque static token.
    return undefined;
  }
}

/** Warnings for an auth config, injected clock so the function stays pure. */
export function authWarnings(label: string, auth: AuthConfig, now: Date): readonly string[] {
  if (auth.kind !== "bearer") return [];
  const expiry = decodeJwtExpiry(auth.token);
  if (expiry === undefined) return [];
  // A finite `exp` beyond the date range gives an invalid Date, which cannot be printed.
  if (Number.isNaN(expiry.getTime())) return [`${label} bearer token (JWT) expiry could not be read`];
  if (expiry.getTime() > now.getTime()) return [];
  return [`${label} bearer token (JWT) expired at ${expiry.toISOString()}`];
}
