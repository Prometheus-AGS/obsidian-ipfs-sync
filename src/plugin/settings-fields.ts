import { composeEndpointUrl, parsePort, type AuthScheme } from "../core/config";
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

/**
 * The gateway's own authentication block (mvp-07b task 2.6): a scheme picker with a default of "Same as node", and the fields of
 * each explicit kind. Kept apart from `FIELD_IDS` because it is a second auth block, not another node field.
 */
export const GATEWAY_AUTH_FIELD_IDS = [
  "gatewayAuthScheme",
  "gatewayAuthUser",
  "gatewayAuthPassword",
  "gatewayAuthToken",
  "gatewayAuthHeaderName",
  "gatewayAuthHeaderValue",
] as const;

export type FieldId = (typeof FIELD_IDS)[number];
export type PullFieldId = (typeof PULL_FIELD_IDS)[number];
export type GatewayAuthFieldId = (typeof GATEWAY_AUTH_FIELD_IDS)[number];
/** Every field the view model can edit. */
export type EditableFieldId = FieldId | PullFieldId | GatewayAuthFieldId;
export type FieldValues = Readonly<Record<EditableFieldId, string>>;

/** Fields whose values are secrets: the tab masks them. */
export const SECRET_FIELDS: readonly FieldId[] = ["authPassword", "authToken", "authHeaderValue"];

/** The gateway block's secret fields: masked, and described by the plain-text warning beside them. */
export const GATEWAY_SECRET_FIELDS: readonly GatewayAuthFieldId[] = ["gatewayAuthPassword", "gatewayAuthToken", "gatewayAuthHeaderValue"];

/** The gateway picker's default: no block is stored, and the shared builder decides by origin. */
export const GATEWAY_AUTH_SAME = "same";
export type GatewayAuthChoice = AuthScheme | typeof GATEWAY_AUTH_SAME;
export const GATEWAY_AUTH_CHOICES: readonly GatewayAuthChoice[] = [GATEWAY_AUTH_SAME, ...AUTH_SCHEMES];

export type FieldGroup =
  | "rpc"
  | "gateway"
  | "publicationKey"
  | "mfsRoot"
  | "auth"
  | "gatewayAuth"
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
  gatewayAuthScheme: "gatewayAuth",
  gatewayAuthUser: "gatewayAuth",
  gatewayAuthPassword: "gatewayAuth",
  gatewayAuthToken: "gatewayAuth",
  gatewayAuthHeaderName: "gatewayAuth",
  gatewayAuthHeaderValue: "gatewayAuth",
  publishIntervalMinutes: "publishIntervalMinutes",
  pullName: "pullName",
  catchUpOnLoad: "catchUpOnLoad",
  maxReadMb: "maxReadMb",
  pullConfirmAboveMb: "pullConfirmAboveMb",
};

export function groupOf(field: EditableFieldId): FieldGroup {
  return GROUP_OF[field];
}

/** Validation errors are keyed by `SettingsField`; every node auth control shares the single `auth` error, every gateway auth control `gatewayAuth`. */
export function errorKeyOf(field: EditableFieldId): SettingsField {
  const group = GROUP_OF[field];
  return group === "auth" || group === "gatewayAuth" ? group : (field as SettingsField);
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

/** The five text slots of an auth block, whichever block (node or gateway) they belong to. */
interface AuthTexts {
  readonly user: string;
  readonly password: string;
  readonly token: string;
  readonly headerName: string;
  readonly headerValue: string;
}

const BLANK_AUTH_TEXTS: AuthTexts = { user: "", password: "", token: "", headerName: "", headerValue: "" };

function authTexts(auth: AuthSettings): AuthTexts {
  switch (auth.scheme) {
    case "none":
      return BLANK_AUTH_TEXTS;
    case "basic":
      return { ...BLANK_AUTH_TEXTS, user: auth.user, password: auth.password };
    case "bearer":
      return { ...BLANK_AUTH_TEXTS, token: auth.token };
    case "header":
      return { ...BLANK_AUTH_TEXTS, headerName: auth.headerName, headerValue: auth.headerValue };
  }
}

function authValues(auth: AuthSettings): Pick<FieldValues, "authUser" | "authPassword" | "authToken" | "authHeaderName" | "authHeaderValue"> {
  const t = authTexts(auth);
  return { authUser: t.user, authPassword: t.password, authToken: t.token, authHeaderName: t.headerName, authHeaderValue: t.headerValue };
}

function gatewayAuthValues(
  auth: AuthSettings | undefined,
): Pick<FieldValues, "gatewayAuthScheme" | "gatewayAuthUser" | "gatewayAuthPassword" | "gatewayAuthToken" | "gatewayAuthHeaderName" | "gatewayAuthHeaderValue"> {
  const t = auth === undefined ? BLANK_AUTH_TEXTS : authTexts(auth);
  return {
    gatewayAuthScheme: auth === undefined ? GATEWAY_AUTH_SAME : auth.scheme,
    gatewayAuthUser: t.user,
    gatewayAuthPassword: t.password,
    gatewayAuthToken: t.token,
    gatewayAuthHeaderName: t.headerName,
    gatewayAuthHeaderValue: t.headerValue,
  };
}

/** The gateway controls to show for the picker's current choice: only the fields of the selected kind, none for "Same as node". */
export function visibleGatewayAuthFields(choice: GatewayAuthChoice): readonly GatewayAuthFieldId[] {
  switch (choice) {
    case "same":
    case "none":
      return [];
    case "basic":
      return ["gatewayAuthUser", "gatewayAuthPassword"];
    case "bearer":
      return ["gatewayAuthToken"];
    case "header":
      return ["gatewayAuthHeaderName", "gatewayAuthHeaderValue"];
  }
}

/**
 * The scheme, host and port an endpoint talks to, or its trimmed URL text when that cannot be composed. A credential saved for one
 * origin is never kept for another, so two endpoints with the same origin (different paths) are the same place.
 */
export function endpointOrigin(endpoint: { readonly url: string; readonly port?: number | undefined }): string {
  const url = endpoint.url.trim();
  if (url === "") return "";
  try {
    return new URL(composeEndpointUrl("rpc", url, endpoint.port)).origin;
  } catch {
    return url;
  }
}

export interface CredentialClearing {
  readonly settings: PluginSettings;
  /** A stored credential was dropped because its endpoint moved to another origin. */
  readonly cleared: boolean;
}

/**
 * A credential is saved for one origin. When an edit moves the endpoint it belongs to (RPC for the node block, gateway for the gateway
 * block) to another origin, the credential is dropped so nothing typed for the old host is ever sent to the new one.
 */
export function clearCredentialOnOriginChange(before: PluginSettings, after: PluginSettings, group: FieldGroup): CredentialClearing {
  if (group === "rpc" && endpointOrigin(before.rpc) !== endpointOrigin(after.rpc)) {
    return { settings: { ...after, auth: emptyAuth("none") }, cleared: before.auth.scheme !== "none" };
  }
  if (group === "gateway" && endpointOrigin(before.gateway) !== endpointOrigin(after.gateway)) {
    // An explicit "none" holds no secret and is a choice the operator made: it stays.
    if (before.gatewayAuth === undefined || before.gatewayAuth.scheme === "none") return { settings: after, cleared: false };
    const { gatewayAuth: _dropped, ...rest } = after;
    return { settings: rest, cleared: true };
  }
  return { settings: after, cleared: false };
}

/** A copy of the values with the named fields emptied. */
export function withBlankedFields(values: FieldValues, fields: readonly EditableFieldId[]): FieldValues {
  const next: Record<EditableFieldId, string> = { ...values };
  for (const field of fields) next[field] = "";
  return next;
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
    ...gatewayAuthValues(settings.gatewayAuth),
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

function authFromTexts(scheme: string, t: AuthTexts): AuthSettings | undefined {
  switch (scheme) {
    case "none":
      return emptyAuth("none");
    case "basic":
      return { scheme, user: t.user.trim(), password: t.password };
    case "bearer":
      return { scheme, token: t.token.trim() };
    case "header":
      return { scheme, headerName: t.headerName.trim(), headerValue: t.headerValue.trim() };
    default:
      return undefined;
  }
}

function authFrom(values: FieldValues): AuthSettings | undefined {
  return authFromTexts(values.authScheme, {
    user: values.authUser,
    password: values.authPassword,
    token: values.authToken,
    headerName: values.authHeaderName,
    headerValue: values.authHeaderValue,
  });
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

/** "Same as node" removes the block; any other kind stores an explicit one (none included) once every field of it is filled. */
function parseGatewayAuthGroup(values: FieldValues): GroupParse {
  if (values.gatewayAuthScheme === GATEWAY_AUTH_SAME) {
    return {
      kind: "ok",
      apply: (settings) => {
        const { gatewayAuth: _removed, ...rest } = settings;
        return rest;
      },
    };
  }
  const gatewayAuth = authFromTexts(values.gatewayAuthScheme, {
    user: values.gatewayAuthUser,
    password: values.gatewayAuthPassword,
    token: values.gatewayAuthToken,
    headerName: values.gatewayAuthHeaderName,
    headerValue: values.gatewayAuthHeaderValue,
  });
  if (gatewayAuth === undefined) return invalid("gatewayAuth", `unknown gateway authentication (use ${GATEWAY_AUTH_CHOICES.join(", ")})`);
  return isComplete(gatewayAuth) ? { kind: "ok", apply: (settings) => ({ ...settings, gatewayAuth }) } : { kind: "incomplete" };
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
    case "gatewayAuth":
      return parseGatewayAuthGroup(values);
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
