import { readFile } from "node:fs/promises";
import {
  ConfigError,
  envLayer,
  parseConfigFile,
  resolveLocalConfig,
  resolveSyncConfig,
  type EnvMap,
  type LocalSyncConfig,
  type RawConfigLayer,
  type SyncConfig,
} from "../src/core/config";
import type { ParsedArgs } from "./args";

export const DEFAULT_CONFIG_PATH = "ipfs-sync.config.json";

export interface ConfigDeps {
  readonly env: EnvMap;
  readonly now: () => Date;
  /** Returns undefined when the file does not exist. */
  readonly readText: (path: string) => Promise<string | undefined>;
}

export async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function fileLayer(args: ParsedArgs, deps: ConfigDeps, mayBeMissing: boolean): Promise<RawConfigLayer> {
  const path = args.configPath ?? DEFAULT_CONFIG_PATH;
  const text = await deps.readText(path);
  if (text === undefined) {
    if (args.configPath !== undefined && !mayBeMissing) {
      throw new ConfigError("invalid-config-file", `config file not found: ${path}`);
    }
    return {};
  }
  return parseConfigFile(text);
}

export interface LoadOptions {
  /** `publish` creates the config file when it records a new key, so an explicit path may not exist yet. */
  readonly configMayBeMissing?: boolean;
}

/** The local fields only, for a command that sends no request (`abandon`): no RPC or gateway URL is required. Every other check and the precedence are the same. */
export async function loadLocalConfig(args: ParsedArgs, deps: ConfigDeps): Promise<LocalSyncConfig> {
  const file = await fileLayer(args, deps, false);
  return resolveLocalConfig([file, envLayer(deps.env), args.flagsLayer]);
}

const hasFields = (value: object | undefined): boolean => value !== undefined && Object.values(value).some((field) => field !== undefined);

/** A credential given by the environment or a flag: the global one, or one for a single endpoint. `none` is not a credential. */
function carriesCredential(layer: RawConfigLayer): boolean {
  return [layer.auth, layer.rpc?.auth, layer.gateway?.auth].some((auth) => hasFields(auth) && auth?.scheme !== "none");
}

/**
 * `./ipfs-sync.config.json` is read when no `--config` is given, so a file dropped into the working directory could name the node. The
 * credential follows the RPC URL, so such a file must not set an address that the environment and the flags do not set themselves while a
 * credential is configured: the person has not chosen to send it there. An explicit `--config` is the person's choice and is not judged.
 */
function assertImplicitFileDoesNotSteerCredential(args: ParsedArgs, file: RawConfigLayer, others: readonly RawConfigLayer[]): void {
  if (args.configPath !== undefined) return;
  if (!others.some(carriesCredential)) return;
  const setsUrl = (endpoint: "rpc" | "gateway"): boolean =>
    file[endpoint]?.url !== undefined && !others.some((layer) => layer[endpoint]?.url !== undefined);
  if (!setsUrl("rpc") && !setsUrl("gateway")) return;
  throw new ConfigError(
    "invalid-config-file",
    `${DEFAULT_CONFIG_PATH} in the working directory sets a node address while a credential is configured, and it was found, not asked for. ` +
      "Pass it explicitly with --config <path> to use it, or set the address by flag or environment variable.",
  );
}

/**
 * Resolve the effective configuration: flags > environment > config file > defaults.
 * Throws ConfigError for anything invalid or unsafe, before the caller can send a request.
 */
export async function loadSyncConfig(args: ParsedArgs, deps: ConfigDeps, options: LoadOptions = {}): Promise<SyncConfig> {
  const file = await fileLayer(args, deps, options.configMayBeMissing ?? false);
  const env = envLayer(deps.env);
  assertImplicitFileDoesNotSteerCredential(args, file, [env, args.flagsLayer]);
  return resolveSyncConfig([file, env, args.flagsLayer], deps.now());
}
