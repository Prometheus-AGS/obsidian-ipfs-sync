/**
 * Configuration model shared by the plugin and the CLI.
 * Pure data: no Obsidian APIs, no Node built-ins, no I/O.
 */

export type EndpointName = "rpc" | "gateway";

export type AuthScheme = "none" | "basic" | "bearer" | "header";

/** Resolved, validated credentials. A JWT is a `bearer` token. */
export type AuthConfig =
  | { readonly kind: "none" }
  | { readonly kind: "basic"; readonly user: string; readonly password: string }
  | { readonly kind: "bearer"; readonly token: string }
  | { readonly kind: "header"; readonly name: string; readonly value: string };

/** Unvalidated auth fields as they arrive from flags, env or a config file. */
export interface RawAuthInput {
  readonly scheme?: string;
  readonly user?: string;
  readonly password?: string;
  readonly token?: string;
  readonly headerName?: string;
  readonly headerValue?: string;
}

export interface RawEndpointInput {
  readonly url?: string;
  readonly port?: number | string;
  /** Optional per-endpoint override of the global auth. */
  readonly auth?: RawAuthInput;
}

/** One precedence layer (defaults, config file, env or flags). */
export interface RawConfigLayer {
  readonly rpc?: RawEndpointInput;
  readonly gateway?: RawEndpointInput;
  readonly publicationKey?: string;
  readonly mfsRoot?: string;
  readonly auth?: RawAuthInput;
  /** IDs of IPNS keys this installation created or adopted. */
  readonly ownedKeys?: readonly string[];
}

export interface ResolvedEndpoint {
  readonly name: EndpointName;
  /** Origin plus optional path prefix, no trailing slash, port applied. */
  readonly baseUrl: string;
  readonly auth: AuthConfig;
}

export interface SyncConfig {
  readonly rpc: ResolvedEndpoint;
  readonly gateway: ResolvedEndpoint;
  readonly publicationKey: string;
  /** Normalised, confined to `/obsidian-vault-sync`. */
  readonly mfsRoot: string;
  readonly ownedKeys: readonly string[];
  /** Non-fatal findings such as an expired JWT. */
  readonly warnings: readonly string[];
}
