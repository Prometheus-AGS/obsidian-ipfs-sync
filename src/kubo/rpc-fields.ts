import type { ResolvedEndpoint } from "../core/config";
import { KuboError } from "./errors";

/** A decoded JSON object from a kubo response. Field names are kubo's own (`Hash`, `Size`, `Keys`, ...). */
export type JsonObject = Readonly<Record<string, unknown>>;

export function malformed(endpoint: ResolvedEndpoint, command: string, detail: string): KuboError {
  return new KuboError(endpoint.name, endpoint.baseUrl, `unexpected response from ${command}: ${detail}`);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A required non-empty string field. */
export function stringField(endpoint: ResolvedEndpoint, command: string, body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value === "string" && value !== "") return value;
  throw malformed(endpoint, command, `missing string field "${field}"`);
}

/** An optional string field; anything else (absent, null, wrong type) reads as `fallback`. */
export function optionalString(body: JsonObject, field: string, fallback = ""): string {
  const value = body[field];
  return typeof value === "string" ? value : fallback;
}

/** A required finite number field. */
export function numberField(endpoint: ResolvedEndpoint, command: string, body: JsonObject, field: string): number {
  const value = body[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw malformed(endpoint, command, `missing number field "${field}"`);
}

/** A list of objects that kubo may omit or send as `null` when empty. */
export function objectList(endpoint: ResolvedEndpoint, command: string, body: JsonObject, field: string): readonly JsonObject[] {
  const value = body[field];
  if (value === undefined || value === null) return [];
  if (Array.isArray(value) && value.every(isJsonObject)) return value;
  throw malformed(endpoint, command, `field "${field}" is not a list of objects`);
}
