import { ConfigError } from "../src/core/config";
import type { CanonicalPassphrase } from "../src/crypto";
import { createKuboClient } from "../src/kubo";
import { UsageError, parseCliArgs, type ParsedArgs } from "./args";
import { runAbandon } from "./abandon-command";
import { HELP_TEXT } from "./help-text";
import { runInit } from "./init-command";
import { EXIT_OK, EXIT_USAGE, type CliIo } from "./io";
import { DEFAULT_CONFIG_PATH, loadSyncConfig, type ConfigDeps } from "./load-config";
import { readVaultPassphrase, type FileHost, type PromptTerminal } from "./passphrase-input";
import { runPublish } from "./publish-command";
import { runPull } from "./pull-command";
import { installRequestTrace } from "./request-trace";
import { runStatus } from "./status-command";

const COMMANDS: readonly string[] = ["status", "init", "publish", "pull", "abandon"];

/**
 * What the process supplies beyond configuration. `passphrase` yields the vault passphrase, already canonicalised, or
 * undefined when none is available; publishing refuses without one, before any request. Its sources (environment
 * variable, 0600 file, terminal prompt) are read by `readVaultPassphrase` unless a test passes its own `passphrase`.
 */
export interface CliDeps extends ConfigDeps {
  readonly passphrase?: () => Promise<CanonicalPassphrase | undefined>;
  /** Standard input and error when both are terminals; absent when the run has no terminal (a pipe, a test). */
  readonly terminal?: PromptTerminal;
  /** Default: the running platform. */
  readonly platform?: NodeJS.Platform;
  /** Default: the numeric user ID of this process, where the platform has one. */
  readonly userId?: number;
}

function fileHost(deps: CliDeps): FileHost {
  return { platform: deps.platform ?? process.platform, userId: deps.userId ?? process.getuid?.() };
}

function reportBadInput(io: CliIo, error: UsageError | ConfigError): number {
  const kind = error instanceof ConfigError ? "configuration error" : "usage error";
  io.err(`ipfs-sync: ${kind}: ${error.message}`);
  if (error instanceof UsageError) io.err("run `ipfs-sync --help` for usage");
  return EXIT_USAGE;
}

/** The vault directory `init`, `publish`, `pull` and `abandon` need; `status` takes no operands. */
function checkOperands(args: ParsedArgs): string | undefined {
  if (args.command === "init" || args.command === "publish" || args.command === "pull" || args.command === "abandon") {
    if (args.operands.length !== 1) throw new UsageError(`${args.command} needs exactly one argument: the vault directory`);
    return args.operands[0];
  }
  if (args.operands.length > 0) throw new UsageError(`unexpected argument "${args.operands[0]}"`);
  return undefined;
}

/** `--name`, `--manifest`, `--manifest-file` and `--allow-plaintext-v1` belong to `pull` only. */
function checkPullFlags(args: ParsedArgs): void {
  if (args.command === "pull") return;
  const given = Object.entries({
    "--name": args.pull.name,
    "--manifest": args.pull.manifest,
    "--manifest-file": args.pull.manifestFile,
    "--allow-plaintext-v1": args.pull.allowPlaintextV1 ? true : undefined,
  }).find(([, value]) => value !== undefined);
  if (given !== undefined) throw new UsageError(`${given[0]} is only valid for the pull command`);
}

/** `--break-lock`, `--repair`, `--recover-slots` and `--allow-full-reupload` belong to `publish` only. */
function checkPublishFlags(args: ParsedArgs): void {
  if (args.command === "publish") return;
  const given = Object.entries({
    "--break-lock": args.breakLock,
    "--repair": args.repair,
    "--recover-slots": args.recoverSlots,
    "--allow-full-reupload": args.allowFullReupload,
  }).find(([, value]) => value);
  if (given !== undefined) throw new UsageError(`${given[0]} is only valid for the publish command`);
}

/** `--passphrase-file` belongs to `init` only; the other commands read `IPFS_SYNC_PASSPHRASE_FILE`. */
function checkInitFlags(args: ParsedArgs): void {
  if (args.command !== "init" && args.passphraseFile !== undefined) {
    throw new UsageError("--passphrase-file is only valid for the init command; publish reads the file named by IPFS_SYNC_PASSPHRASE_FILE");
  }
}

/** `--yes-abandon` belongs to `abandon` only. */
function checkAbandonFlags(args: ParsedArgs): void {
  if (args.command !== "abandon" && args.yesAbandon) throw new UsageError("--yes-abandon is only valid for the abandon command");
}

async function execute(argv: readonly string[], deps: CliDeps, io: CliIo): Promise<number> {
  const args = parseCliArgs(argv);
  if (args.help) {
    io.out(HELP_TEXT);
    return EXIT_OK;
  }
  if (args.command === undefined || !COMMANDS.includes(args.command)) {
    throw new UsageError(args.command === undefined ? "no command given" : `unknown command "${args.command}"`);
  }
  const vaultPath = checkOperands(args);
  checkPullFlags(args);
  checkPublishFlags(args);
  checkInitFlags(args);
  checkAbandonFlags(args);
  // Configuration is validated in full before the first request can be sent.
  const config = await loadSyncConfig(args, deps, { configMayBeMissing: args.command === "publish" });
  for (const warning of config.warnings) io.err(`warning: ${warning}`);
  if (args.command === "abandon" && vaultPath !== undefined) {
    // Local only: no client is created, so no request can be sent to the node.
    return await runAbandon({ config, io, vaultPath, env: deps.env, now: deps.now, yesAbandon: args.yesAbandon });
  }
  const client = createKuboClient({ rpc: config.rpc, gateway: config.gateway });
  const restore = args.showRequest ? installRequestTrace(config, io) : undefined;
  try {
    if (vaultPath === undefined) return await runStatus({ config, client, io });
    if (args.command === "init") {
      return await runInit({ config, client, io, vaultPath, env: deps.env, now: deps.now, passphraseFile: args.passphraseFile, terminal: deps.terminal, file: fileHost(deps) });
    }
    if (args.command === "pull") {
      return await runPull({ config, client, io, vaultPath, flags: args.pull, env: deps.env, now: deps.now });
    }
    const configPath = args.configPath ?? DEFAULT_CONFIG_PATH;
    return await runPublish({
      config,
      client,
      io,
      vaultPath,
      configPath,
      env: deps.env,
      now: deps.now,
      passphrase: deps.passphrase ?? (() => readVaultPassphrase({ ...fileHost(deps), env: deps.env, terminal: deps.terminal, warn: (text) => io.err(text) })),
      flags: { breakLock: args.breakLock, repair: args.repair, recoverSlots: args.recoverSlots, allowFullReupload: args.allowFullReupload },
    });
  } finally {
    restore?.();
  }
}

/** Run the CLI and return the process exit code. */
export async function runCli(argv: readonly string[], deps: CliDeps, io: CliIo): Promise<number> {
  try {
    return await execute(argv, deps, io);
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError) return reportBadInput(io, error);
    throw error;
  }
}
