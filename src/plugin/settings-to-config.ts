import {
  authWarnings,
  buildAuth,
  ConfigError,
  assertValidKeyName,
  composeEndpointUrl,
  resolveSyncConfig,
  validateMfsRoot,
  type EndpointName,
  type RawAuthInput,
  type RawConfigLayer,
  type SyncConfig,
} from "../core/config";
import { parsePullName, PULL_NAME_MESSAGE } from "./pull-target";
import { isValidReadCapMb, READ_CAP_RANGE_MESSAGE } from "./read-cap";
import type { AuthSettings, EndpointSettings, PluginSettings } from "./settings-model";

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
    gateway: { url: settings.gateway.url, port: settings.gateway.port },
    publicationKey: settings.publicationKey,
    mfsRoot: settings.mfsRoot,
    auth: rawAuth(settings.auth),
    ownedKeys: settings.ownedKeys,
  };
}

/** Validated configuration for the sync engine. Throws ConfigError (never carrying a secret) before any request is possible. */
export function settingsToConfig(settings: PluginSettings, now: Date): SyncConfig {
  return resolveSyncConfig([settingsToLayer(settings)], now);
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
  | "publishIntervalMinutes"
  | "pullName"
  /** A toggle: it never has an error, but it is a field like the others. */
  | "catchUpOnLoad"
  | "maxReadMb";

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

/**
 * Every field checked on its own with the shared validators, so an error is shown beside the field
 * that caused it. Messages come from the validators and never contain a secret value.
 */
export function validateSettings(settings: PluginSettings, now: Date): SettingsValidation {
  const authFailure = attempt("auth", () => buildAuth(rawAuth(settings.auth), "auth"));
  const errors = [
    endpointError("rpc", settings.rpc),
    endpointError("gateway", settings.gateway),
    attempt("publicationKey", () => assertValidKeyName(settings.publicationKey)),
    attempt("mfsRoot", () => validateMfsRoot(settings.mfsRoot)),
    authFailure,
    intervalError(settings.publishIntervalMinutes),
    pullNameError(settings.pullName),
    readCapError(settings.maxReadMb),
  ].filter((error): error is FieldError => error !== undefined);
  const warnings = authFailure === undefined ? authWarnings("auth", buildAuth(rawAuth(settings.auth), "auth"), now) : [];
  return { errors, warnings };
}
