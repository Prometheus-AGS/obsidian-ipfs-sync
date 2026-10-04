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

/**
 * Resolve the effective configuration: flags > environment > config file > defaults.
 * Throws ConfigError for anything invalid or unsafe, before the caller can send a request.
 */
export async function loadSyncConfig(args: ParsedArgs, deps: ConfigDeps, options: LoadOptions = {}): Promise<SyncConfig> {
  const file = await fileLayer(args, deps, options.configMayBeMissing ?? false);
  return resolveSyncConfig([file, envLayer(deps.env), args.flagsLayer], deps.now());
}
