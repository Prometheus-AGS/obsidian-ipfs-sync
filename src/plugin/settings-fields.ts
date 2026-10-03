import { parsePort, type AuthScheme } from "../core/config";
import { parsePullName } from "./pull-target";
import { parseReadCapMb } from "./read-cap";
import { AUTH_SCHEMES, emptyAuth, isValidPullConfirmAboveMb, PULL_CONFIRM_RANGE_MESSAGE, type AuthSettings, type PluginSettings } from "./settings-model";
import type { FieldError, SettingsField } from "./settings-to-config";

/**
 * The settings tab's fields as text, and how a group of them turns back into settings. Pure: the view
 * model owns the drafts and the store; this file owns the mapping.
 */

export const FIELD_IDS = [
  "rpcUrl",
  "rpcPort",
  "gatewayUrl",
  "gatewayPort",
  "publicationKey",
  "mfsRoot",
  "authScheme",
  "authUser",
  "authPassword",
  "authToken",
  "authHeaderName",
  "authHeaderValue",
  "publishIntervalMinutes",
] as const;

/** The fields added with pull (mvp-05), and the pull size ceiling (mvp-07a). Kept apart from `FIELD_IDS` because they are not endpoint or authentication fields. */
export const PULL_FIELD_IDS = ["pullName", "catchUpOnLoad", "maxReadMb", "pullConfirmAboveMb"] as const;

export type FieldId = (typeof FIELD_IDS)[number];
export type PullFieldId = (typeof PULL_FIELD_IDS)[number];
/** Every field the view model can edit. */
export type EditableFieldId = FieldId | PullFieldId;
export type FieldValues = Readonly<Record<EditableFieldId, string>>;

/** Fields whose values are secrets: the tab masks them. */
export const SECRET_FIELDS: readonly FieldId[] = ["authPassword", "authToken", "authHeaderValue"];

export type FieldGroup =
  | "rpc"
  | "gateway"
  | "publicationKey"
  | "mfsRoot"
  | "auth"
  | "publishIntervalMinutes"
  | "pullName"
  | "catchUpOnLoad"
  | "maxReadMb"
  | "pullConfirmAboveMb";

const GROUP_OF: Readonly<Record<EditableFieldId, FieldGroup>> = {
  rpcUrl: "rpc",
  rpcPort: "rpc",
  gatewayUrl: "gateway",
  gatewayPort: "gateway",
  publicationKey: "publicationKey",
  mfsRoot: "mfsRoot",
  authScheme: "auth",
  authUser: "auth",
  authPassword: "auth",
  authToken: "auth",
  authHeaderName: "auth",
  authHeaderValue: "auth",
  publishIntervalMinutes: "publishIntervalMinutes",
  pullName: "pullName",
  catchUpOnLoad: "catchUpOnLoad",
  maxReadMb: "maxReadMb",
  pullConfirmAboveMb: "pullConfirmAboveMb",
};

export function groupOf(field: EditableFieldId): FieldGroup {
  return GROUP_OF[field];
}

/** Validation errors are keyed by `SettingsField`; every auth control shares the single `auth` error. */
export function errorKeyOf(field: EditableFieldId): SettingsField {
  return GROUP_OF[field] === "auth" ? "auth" : (field as SettingsField);
}

/** Error keys that belong to a group: an edit is blocked only by errors in its own group. */
export function errorKeysOf(group: FieldGroup): readonly SettingsField[] {
  switch (group) {
    case "rpc":
      return ["rpcUrl", "rpcPort"];
    case "gateway":
      return ["gatewayUrl", "gatewayPort"];
    default:
      return [group];
  }
}

/** The auth controls to show for a scheme: only the fields of the selected scheme. */
export function visibleAuthFields(scheme: AuthScheme): readonly FieldId[] {
  switch (scheme) {
    case "none":
      return [];
    case "basic":
      return ["authUser", "authPassword"];
    case "bearer":
      return ["authToken"];
    case "header":
      return ["authHeaderName", "authHeaderValue"];
  }
}

function authValues(auth: AuthSettings): Pick<FieldValues, "authUser" | "authPassword" | "authToken" | "authHeaderName" | "authHeaderValue"> {
  const blank = { authUser: "", authPassword: "", authToken: "", authHeaderName: "", authHeaderValue: "" };
  switch (auth.scheme) {
    case "none":
      return blank;
    case "basic":
      return { ...blank, authUser: auth.user, authPassword: auth.password };
    case "bearer":
      return { ...blank, authToken: auth.token };
    case "header":
      return { ...blank, authHeaderName: auth.headerName, authHeaderValue: auth.headerValue };
  }
}

export function valuesFrom(settings: PluginSettings): FieldValues {
  return {
    rpcUrl: settings.rpc.url,
    rpcPort: settings.rpc.port === undefined ? "" : String(settings.rpc.port),
    gatewayUrl: settings.gateway.url,
    gatewayPort: settings.gateway.port === undefined ? "" : String(settings.gateway.port),
    publicationKey: settings.publicationKey,
    mfsRoot: settings.mfsRoot,
    authScheme: settings.auth.scheme,
    ...authValues(settings.auth),
    publishIntervalMinutes: String(settings.publishIntervalMinutes),
    pullName: settings.pullName,
    catchUpOnLoad: String(settings.catchUpOnLoad),
    maxReadMb: String(settings.maxReadMb),
    pullConfirmAboveMb: String(settings.pullConfirmAboveMb),
  };
}

// ---------- text -> settings, one group at a time ----------

export type GroupParse =
  | { readonly kind: "ok"; readonly apply: (settings: PluginSettings) => PluginSettings }
  /** Required auth fields are still empty: not an error, nothing is saved yet. */
  | { readonly kind: "incomplete" }
  | { readonly kind: "invalid"; readonly error: FieldError };

function invalid(field: SettingsField, message: string): GroupParse {
  return { kind: "invalid", error: { field, message } };
}

function parseEndpoint(group: "rpc" | "gateway", url: string, portText: string): GroupParse {
  const urlField: SettingsField = group === "rpc" ? "rpcUrl" : "gatewayUrl";
  const portField: SettingsField = group === "rpc" ? "rpcPort" : "gatewayPort";
  let port: number | undefined;
  try {
    port = parsePort(group, portText.trim());
  } catch (error) {
    return invalid(portField, error instanceof Error ? error.message : "the port is not valid");
  }
  if (url.trim() === "") return invalid(urlField, `the ${group} URL must not be empty`);
  const endpoint = { url: url.trim().replace(/\/+$/, ""), port };
  return { kind: "ok", apply: (settings) => ({ ...settings, [group]: endpoint }) };
}

function parseInterval(text: string): GroupParse {
  const trimmed = text.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return invalid("publishIntervalMinutes", "the publish interval must be a whole number of minutes, 0 or more");
  const minutes = Number(trimmed);
  return { kind: "ok", apply: (settings) => ({ ...settings, publishIntervalMinutes: minutes }) };
}

function parsePullNameGroup(text: string): GroupParse {
  const parsed = parsePullName(text);
  if (!parsed.ok) return invalid("pullName", parsed.message);
  return { kind: "ok", apply: (settings) => ({ ...settings, pullName: parsed.name }) };
}

function parseReadCapGroup(text: string): GroupParse {
  const parsed = parseReadCapMb(text);
  if (!parsed.ok) return invalid("maxReadMb", parsed.message);
  return { kind: "ok", apply: (settings) => ({ ...settings, maxReadMb: parsed.megabytes }) };
}

/** The pull ceiling's text to a group parse: a whole number of megabytes from 64 to 8192. */
export function parsePullCeilingField(text: string): GroupParse {
  const trimmed = text.trim();
  const value = /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!isValidPullConfirmAboveMb(value)) return invalid("pullConfirmAboveMb", PULL_CONFIRM_RANGE_MESSAGE);
  return { kind: "ok", apply: (settings) => ({ ...settings, pullConfirmAboveMb: value }) };
}

/** The toggle's text is `true` or `false`; the tab passes the switch state as one of them. */
function parseCatchUpGroup(text: string): GroupParse {
  if (text !== "true" && text !== "false") return invalid("catchUpOnLoad", "the catch-up setting must be on or off");
  const enabled = text === "true";
  return { kind: "ok", apply: (settings) => ({ ...settings, catchUpOnLoad: enabled }) };
}

function authFrom(values: FieldValues): AuthSettings | undefined {
  const scheme = values.authScheme;
  switch (scheme) {
    case "none":
      return emptyAuth("none");
    case "basic":
      return { scheme, user: values.authUser.trim(), password: values.authPassword };
    case "bearer":
      return { scheme, token: values.authToken.trim() };
    case "header":
      return { scheme, headerName: values.authHeaderName.trim(), headerValue: values.authHeaderValue.trim() };
    default:
      return undefined;
  }
}

function isComplete(auth: AuthSettings): boolean {
  switch (auth.scheme) {
    case "none":
      return true;
    case "basic":
      return auth.user !== "" && auth.password !== "";
    case "bearer":
      return auth.token !== "";
    case "header":
      return auth.headerName !== "" && auth.headerValue !== "";
  }
}

function parseAuthGroup(values: FieldValues): GroupParse {
  const auth = authFrom(values);
  if (auth === undefined) return invalid("auth", `unknown auth scheme (use ${AUTH_SCHEMES.join(", ")})`);
  return isComplete(auth) ? { kind: "ok", apply: (settings) => ({ ...settings, auth }) } : { kind: "incomplete" };
}

export function parseGroup(group: FieldGroup, values: FieldValues): GroupParse {
  switch (group) {
    case "rpc":
      return parseEndpoint("rpc", values.rpcUrl, values.rpcPort);
    case "gateway":
      return parseEndpoint("gateway", values.gatewayUrl, values.gatewayPort);
    case "publicationKey": {
      const key = values.publicationKey.trim();
      return { kind: "ok", apply: (settings) => ({ ...settings, publicationKey: key }) };
    }
    case "mfsRoot": {
      const root = values.mfsRoot.trim();
      return { kind: "ok", apply: (settings) => ({ ...settings, mfsRoot: root }) };
    }
    case "auth":
      return parseAuthGroup(values);
    case "publishIntervalMinutes":
      return parseInterval(values.publishIntervalMinutes);
    case "pullName":
      return parsePullNameGroup(values.pullName);
    case "catchUpOnLoad":
      return parseCatchUpGroup(values.catchUpOnLoad);
    case "maxReadMb":
      return parseReadCapGroup(values.maxReadMb);
    case "pullConfirmAboveMb":
      return parsePullCeilingField(values.pullConfirmAboveMb);
  }
}
