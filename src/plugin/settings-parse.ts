import { isValidReadCapMb } from "./read-cap";
import {
  AUTH_SCHEMES,
  defaultSettings,
  isValidPullConfirmAboveMb,
  SETTINGS_VERSION,
  type AuthSettings,
  type EndpointSettings,
  type PluginSettings,
  type PublishSummary,
  type PullSummary,
} from "./settings-model";

type Stored = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Stored {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseEndpoint(value: unknown): EndpointSettings | undefined {
  if (!isObject(value) || typeof value["url"] !== "string") return undefined;
  const port = value["port"];
  if (port === undefined) return { url: value["url"] };
  return typeof port === "number" && Number.isInteger(port) ? { url: value["url"], port } : undefined;
}

function fields(value: Stored, names: readonly string[]): readonly string[] | undefined {
  const picked = names.map((name) => value[name]);
  return picked.every((item): item is string => typeof item === "string") ? picked : undefined;
}

function parseAuth(value: unknown): AuthSettings | undefined {
  if (!isObject(value)) return undefined;
  const scheme = value["scheme"];
  if (typeof scheme !== "string" || !AUTH_SCHEMES.some((known) => known === scheme)) return undefined;
  switch (scheme) {
    case "none":
      return { scheme: "none" };
    case "basic": {
      const [user, password] = fields(value, ["user", "password"]) ?? [];
      return user === undefined || password === undefined ? undefined : { scheme: "basic", user, password };
    }
    case "bearer": {
      const [token] = fields(value, ["token"]) ?? [];
      return token === undefined ? undefined : { scheme: "bearer", token };
    }
    default: {
      const [headerName, headerValue] = fields(value, ["headerName", "headerValue"]) ?? [];
      return headerName === undefined || headerValue === undefined ? undefined : { scheme: "header", headerName, headerValue };
    }
  }
}

function parseKv(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === "string") ? (value as Readonly<Record<string, string>>) : undefined;
}

/** The device store section. Data written before it existed has none and loads with an empty one. */
function parseDeviceStore(value: unknown): Readonly<Record<string, string>> | undefined {
  return value === undefined ? {} : parseKv(value);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function counts(stored: Stored, names: readonly string[]): readonly number[] | undefined {
  const picked = names.map((name) => count(stored[name]));
  return picked.every((item): item is number => item !== undefined) ? picked : undefined;
}

/** A summary that does not have the exact shape is dropped, never fatal: it must not cost the user their endpoints. */
function parsePullSummary(value: unknown): PullSummary | undefined {
  if (!isObject(value)) return undefined;
  const { at, rootCid, manifestCid } = value;
  const numbers = counts(value, ["fetched", "unchanged", "conflicts", "failed", "remoteDeleted"]);
  if (typeof at !== "string" || typeof rootCid !== "string" || typeof manifestCid !== "string" || numbers === undefined) return undefined;
  const [fetched = 0, unchanged = 0, conflicts = 0, failed = 0, remoteDeleted = 0] = numbers;
  return { at, rootCid, manifestCid, fetched, unchanged, conflicts, failed, remoteDeleted };
}

function parsePublishSummary(value: unknown): PublishSummary | undefined {
  if (!isObject(value)) return undefined;
  const { at, rootCid } = value;
  const numbers = counts(value, ["written", "removed", "skipped"]);
  if (typeof at !== "string" || numbers === undefined || (rootCid !== undefined && typeof rootCid !== "string")) return undefined;
  const [written = 0, removed = 0, skipped = 0] = numbers;
  return rootCid === undefined ? { at, written, removed, skipped } : { at, written, removed, skipped, rootCid };
}

interface PullFields {
  readonly pullName: string;
  readonly catchUpOnLoad: boolean;
  readonly maxReadMb: number;
  readonly pullConfirmAboveMb: number;
}

/** The fields added with pull. Missing ones take their defaults; one of the wrong type makes the data unreadable. */
function parsePullFields(stored: Stored): PullFields | undefined {
  const fallback = defaultSettings();
  const {
    pullName = fallback.pullName,
    catchUpOnLoad = fallback.catchUpOnLoad,
    maxReadMb = fallback.maxReadMb,
    pullConfirmAboveMb = fallback.pullConfirmAboveMb,
  } = stored;
  const valid =
    typeof pullName === "string" &&
    typeof catchUpOnLoad === "boolean" &&
    typeof maxReadMb === "number" &&
    isValidReadCapMb(maxReadMb) &&
    typeof pullConfirmAboveMb === "number" &&
    isValidPullConfirmAboveMb(pullConfirmAboveMb);
  return valid ? { pullName, catchUpOnLoad, maxReadMb, pullConfirmAboveMb } : undefined;
}

/**
 * The publish interval is a whole number of minutes, 0 or more (0 = off). A stored number that is not (a fraction, a negative, NaN
 * or infinity) loads as the default 0, auto-publish off, instead of making the whole file unreadable: the rest of the settings
 * (credentials, owned keys, sequence floor) stay, and nothing starts publishing by itself. A value above the cap is kept; the timer holds it at the cap.
 * `null` is the same damage: `JSON.stringify` writes NaN and infinity as `null`. Every other type stays unreadable.
 */
function wholeMinutes(stored: number | null): number {
  return stored !== null && Number.isInteger(stored) && stored >= 0 ? stored : 0;
}

/**
 * The stored data of the current form (version 3) or the previous one (version 2, which has none of the pull
 * fields) as a typed model, or `undefined` when any part of it has the wrong shape. The result is always the
 * current form, with defaults for whatever the stored data lacks.
 */
export function parseStoredSettings(stored: Stored): PluginSettings | undefined {
  const rpc = parseEndpoint(stored["rpc"]);
  const gateway = parseEndpoint(stored["gateway"]);
  const auth = parseAuth(stored["auth"]);
  // Absent means "Same as node". A block that is present must be well formed, like the node block.
  const gatewayAuth = "gatewayAuth" in stored ? parseAuth(stored["gatewayAuth"]) : undefined;
  const gatewayAuthValid = !("gatewayAuth" in stored) || gatewayAuth !== undefined;
  const kv = parseKv(stored["kv"]);
  const deviceStore = parseDeviceStore(stored["deviceStore"]);
  const pull = parsePullFields(stored);
  const { publicationKey, mfsRoot, userExclusions, ownedKeys, publishIntervalMinutes } = stored;
  const interval = publishIntervalMinutes;
  const valid =
    rpc !== undefined &&
    gateway !== undefined &&
    auth !== undefined &&
    gatewayAuthValid &&
    kv !== undefined &&
    deviceStore !== undefined &&
    pull !== undefined &&
    typeof publicationKey === "string" &&
    typeof mfsRoot === "string" &&
    isStringList(userExclusions) &&
    isStringList(ownedKeys) &&
    (typeof interval === "number" || interval === null);
  if (!valid) return undefined;
  const lastPull = parsePullSummary(stored["lastPull"]);
  const lastPublish = parsePublishSummary(stored["lastPublish"]);
  return {
    version: SETTINGS_VERSION,
    rpc,
    gateway,
    publicationKey,
    mfsRoot,
    auth,
    ...(gatewayAuth === undefined ? {} : { gatewayAuth }),
    userExclusions,
    ownedKeys,
    publishIntervalMinutes: wholeMinutes(interval),
    ...pull,
    ...(stored["retiredDefaultNoticeShown"] === true ? { retiredDefaultNoticeShown: true } : {}),
    ...(lastPull === undefined ? {} : { lastPull }),
    ...(lastPublish === undefined ? {} : { lastPublish }),
    kv,
    deviceStore,
  };
}
