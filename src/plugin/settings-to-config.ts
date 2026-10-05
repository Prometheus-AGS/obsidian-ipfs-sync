import {
  authWarnings,
  buildAuth,
  ConfigError,
  DEFAULT_MFS_ROOT,
  DEFAULT_PUBLICATION_KEY,
  assertValidKeyName,
  composeEndpointUrl,
  resolveLocalConfig,
  resolveSyncConfig,
  validateMfsRoot,
  type EndpointName,
  type LocalSyncConfig,
  type RawAuthInput,
  type RawConfigLayer,
  type SyncConfig,
} from "../core/config";
import { isSet, NODE_NOT_SET_NOTICE } from "./node-status";
import { parsePullName, PULL_NAME_MESSAGE } from "./pull-target";
import { isValidReadCapMb, READ_CAP_RANGE_MESSAGE } from "./read-cap";
import { isValidPullConfirmAboveMb, PULL_CONFIRM_RANGE_MESSAGE, type AuthSettings, type EndpointSettings, type PluginSettings } from "./settings-model";

/**
 * Settings model -> the raw config layer the CLI resolves too, so the plugin gets the same
 * validation, endpoint composition, JWT warning and node-safety errors as the CLI.
 */

function rawAuth(auth: AuthSettings): RawAuthInput {
  switch (auth.scheme) {
    case "none":
      return { scheme: "none" };
    case "basic":
      return { scheme: "basic", user: auth.user, password: auth.password };
    case "bearer":
      return { scheme: "bearer", token: auth.token };
    case "header":
      return { scheme: "header", headerName: auth.headerName, headerValue: auth.headerValue };
  }
}

export function settingsToLayer(settings: PluginSettings): RawConfigLayer {
  return {
    rpc: { url: settings.rpc.url, port: settings.rpc.port },
    // The gateway's own auth only when the operator set a block (including none). Absent is "Same as node": the shared
    // builder (`buildSyncConfig`) decides by origin; the plugin adds no rule of its own.
    gateway: {
      url: settings.gateway.url,
      port: settings.gateway.port,
      ...(settings.gatewayAuth === undefined ? {} : { auth: rawAuth(settings.gatewayAuth) }),
    },
    publicationKey: settings.publicationKey,
    mfsRoot: settings.mfsRoot,
    auth: rawAuth(settings.auth),
    ownedKeys: settings.ownedKeys,
  };
}

/** Validated configuration for the sync engine. Throws ConfigError (never carrying a secret) before any request is possible. */
export function settingsToConfig(settings: PluginSettings, now: Date): SyncConfig {
  try {
    return resolveSyncConfig([settingsToLayer(settings)], now);
  } catch (error) {
    // The core message names CLI flags; the plugin has settings instead. Same stable code, plugin words.
    if (error instanceof ConfigError && error.code === "no-rpc-url") throw new ConfigError(error.code, `${NODE_NOT_SET_NOTICE} (the RPC URL is empty)`);
    if (error instanceof ConfigError && error.code === "no-gateway-url") throw new ConfigError(error.code, `${NODE_NOT_SET_NOTICE} (the gateway URL is empty)`);
    throw error;
  }
}

/** The validated local fields without the endpoints, for an action that sends no request (Abandon): it works with no node set. */
export function settingsToLocalConfig(settings: PluginSettings): LocalSyncConfig {
  return resolveLocalConfig([settingsToLayer(settings)]);
}

/**
 * The operator's additions plus the vault's configuration folder when it is not `.obsidian` (which
 * DEFAULT_EXCLUSIONS already covers). Obsidian lets a vault rename it (`Vault.configDir`), so the renamed
 * folder is excluded the same way. Anchored, directory-only entry (`name/`).
 */
export function exclusionsWithConfigDir(userExclusions: readonly string[], configDir: string | undefined): readonly string[] {
  const dir = (configDir ?? "").trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (dir === "" || dir === ".obsidian") return userExclusions;
  return [...userExclusions, `${dir}/`];
}

// ---------- field-level validation ----------

export type SettingsField =
  | "rpcUrl"
  | "rpcPort"
  | "gatewayUrl"
  | "gatewayPort"
  | "publicationKey"
  | "mfsRoot"
  | "auth"
  | "gatewayAuth"
  | "publishIntervalMinutes"
  | "pullName"
  /** A toggle: it never has an error, but it is a field like the others. */
  | "catchUpOnLoad"
  | "maxReadMb"
  | "pullConfirmAboveMb";

export interface FieldError {
  readonly field: SettingsField;
  readonly message: string;
}

export interface SettingsValidation {
  readonly errors: readonly FieldError[];
  /** Findings that do not block saving, such as an expired JWT. */
  readonly warnings: readonly string[];
}

function messageOf(error: unknown): string {
  return error instanceof ConfigError ? error.message : "the value could not be checked";
}

function endpointError(name: EndpointName, endpoint: EndpointSettings): FieldError | undefined {
  // An empty URL is "not configured", not a typing mistake: the tab says so in its Node line and every action refuses with a notice.
  if (!isSet(endpoint.url) && endpoint.port === undefined) return undefined;
  try {
    composeEndpointUrl(name, endpoint.url, endpoint.port);
    return undefined;
  } catch (error) {
    // A port problem (invalid, or different from the URL's own) belongs beside the port field.
    const isPort = error instanceof ConfigError && (error.code === "invalid-port" || error.code === "port-conflict");
    const field: SettingsField = name === "rpc" ? (isPort ? "rpcPort" : "rpcUrl") : isPort ? "gatewayPort" : "gatewayUrl";
    return { field, message: messageOf(error) };
  }
}

function attempt(field: SettingsField, check: () => unknown): FieldError | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    return { field, message: messageOf(error) };
  }
}

function intervalError(minutes: number): FieldError | undefined {
  return Number.isInteger(minutes) && minutes >= 0
    ? undefined
    : { field: "publishIntervalMinutes", message: "the publish interval must be a whole number of minutes, 0 or more" };
}

function pullNameError(name: string): FieldError | undefined {
  const parsed = parsePullName(name);
  return parsed.ok && parsed.name === name ? undefined : { field: "pullName", message: PULL_NAME_MESSAGE };
}

function readCapError(megabytes: number): FieldError | undefined {
  return isValidReadCapMb(megabytes) ? undefined : { field: "maxReadMb", message: READ_CAP_RANGE_MESSAGE };
}

function pullCeilingError(megabytes: number): FieldError | undefined {
  return isValidPullConfirmAboveMb(megabytes) ? undefined : { field: "pullConfirmAboveMb", message: PULL_CONFIRM_RANGE_MESSAGE };
}

/**
 * True when a node credential is set, the gateway block is "Same as node", and the shared builder resolved the gateway
 * to no credential (its origin differs from the RPC origin). The answer comes from `resolveSyncConfig`, not from an
 * origin comparison of its own, so the tab can never disagree with what is sent. Unset or invalid endpoints say nothing here:
 * the endpoint fields report those.
 */
export function nodeCredentialWithheldFromGateway(settings: PluginSettings, now: Date): boolean {
  if (settings.gatewayAuth !== undefined) return false;
  try {
    // Only the endpoints and the node credential matter; the other fields are given valid defaults so they cannot hide the answer.
    const layer = { ...settingsToLayer(settings), mfsRoot: DEFAULT_MFS_ROOT, publicationKey: DEFAULT_PUBLICATION_KEY };
    const config = resolveSyncConfig([layer], now);
    return config.rpc.auth.kind !== "none" && config.gateway.auth.kind === "none";
  } catch {
    // Not resolvable (an endpoint is empty or malformed, or the node credential is incomplete): nothing to explain here.
    return false;
  }
}

/** Warnings about the gateway's own credential, such as an expired JWT. Empty for "Same as node" (the node warning covers it). */
export function gatewayAuthWarnings(settings: PluginSettings, now: Date): readonly string[] {
  if (settings.gatewayAuth === undefined) return [];
  try {
    return authWarnings("gateway", buildAuth(rawAuth(settings.gatewayAuth), "gateway auth"), now);
  } catch {
    // An invalid block is reported as a field error by `validateSettings`.
    return [];
  }
}

/**
 * Every field checked on its own with the shared validators, so an error is shown beside the field
 * that caused it. Messages come from the validators and never contain a secret value.
 */
export function validateSettings(settings: PluginSettings, now: Date): SettingsValidation {
  const authFailure = attempt("auth", () => buildAuth(rawAuth(settings.auth), "auth"));
  const gatewayAuth = settings.gatewayAuth;
  const errors = [
    endpointError("rpc", settings.rpc),
    endpointError("gateway", settings.gateway),
    attempt("publicationKey", () => assertValidKeyName(settings.publicationKey)),
    attempt("mfsRoot", () => validateMfsRoot(settings.mfsRoot)),
    authFailure,
    gatewayAuth === undefined ? undefined : attempt("gatewayAuth", () => buildAuth(rawAuth(gatewayAuth), "gateway auth")),
    intervalError(settings.publishIntervalMinutes),
    pullNameError(settings.pullName),
    readCapError(settings.maxReadMb),
    pullCeilingError(settings.pullConfirmAboveMb),
  ].filter((error): error is FieldError => error !== undefined);
  const warnings = authFailure === undefined ? authWarnings("auth", buildAuth(rawAuth(settings.auth), "auth"), now) : [];
  return { errors, warnings };
}
