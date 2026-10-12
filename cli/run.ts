import { ConfigError } from "../src/core/config";
import type { CanonicalPassphrase } from "../src/crypto";
import { createKuboClient } from "../src/kubo";
import type { FreeBytes } from "../src/sync/encrypted-pull-fetch";
import type { KeyOperations } from "../src/sync/key-management";
import { UsageError, parseCliArgs, type ParsedArgs } from "./args";
import { runAbandon } from "./abandon-command";
import { HELP_TEXT } from "./help-text";
import { runHistory } from "./history-command";
import { runInit } from "./init-command";
import { EXIT_OK, EXIT_USAGE, type CliIo } from "./io";
import { KEYS_SUBCOMMANDS, runKeys, type KeysSubcommand } from "./keys-command";
import { DEFAULT_CONFIG_PATH, loadLocalConfig, loadSyncConfig, type ConfigDeps } from "./load-config";
import { passphraseFileInsideVault } from "./passphrase-file";
import { PASSPHRASE_FILE_ENV, readVaultPassphrase, type FileHost, type PromptTerminal } from "./passphrase-input";
import { runPrune } from "./prune-command";
import { runPublish } from "./publish-command";
import { runPull } from "./pull-command";
import { installRequestTrace } from "./request-trace";
import { runStatus } from "./status-command";

const COMMANDS: readonly string[] = ["status", "init", "publish", "pull", "abandon", "keys", "prune-history", "history"];

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
  /** pull: free bytes on the volume of the vault. Default: Node `statfs` of the vault directory. */
  readonly freeBytes?: FreeBytes;
  /** keys: the cryptography (rewrap and test unlock). Absent in production; tests pass fast stand-ins. */
  readonly keyOperations?: KeyOperations;
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

/** `keys <subcommand> <vault>`: exactly those two operands, the subcommand one this build has. */
function checkKeysOperands(args: ParsedArgs): { readonly subcommand: KeysSubcommand; readonly vault: string } {
  const [subcommand, vault, ...rest] = args.operands;
  if (subcommand === undefined || vault === undefined || rest.length > 0) {
    throw new UsageError(`keys needs a subcommand and the vault directory: ipfs-sync keys <${KEYS_SUBCOMMANDS.join("|")}> <vault>`);
  }
  const known = KEYS_SUBCOMMANDS.find((name) => name === subcommand);
  if (known === undefined) throw new UsageError(`unknown keys subcommand "${subcommand}" (this build has: ${KEYS_SUBCOMMANDS.join(", ")})`);
  return { subcommand: known, vault };
}

/** The vault directory `init`, `publish`, `pull` and `abandon` need; `status` takes no operands. `keys` is checked by `checkKeysOperands`. */
function checkOperands(args: ParsedArgs): string | undefined {
  if (args.command === "keys") return checkKeysOperands(args).vault;
  if (args.command === "init" || args.command === "publish" || args.command === "pull" || args.command === "abandon" || args.command === "prune-history") {
    if (args.operands.length !== 1) throw new UsageError(`${args.command} needs exactly one argument: the vault directory`);
    return args.operands[0];
  }
  if (args.operands.length > 0) throw new UsageError(`unexpected argument "${args.operands[0]}"`);
  return undefined;
}

/** The pull flags `keys accept-slots` shares: which root to read and what to expect of it. Every other flag of `pull` stays refused there. */
const ACCEPT_SLOTS_PULL_FLAGS: ReadonlySet<string> = new Set(["--name", "--root-cid", "--allow-rollback", "--expect-min-sequence", "--expect-vault-id"]);

/** The flags only `pull` understands (and `keys accept-slots` for five of them); every other command refuses them. A flag that is off is `undefined` here. */
function checkPullFlags(args: ParsedArgs): void {
  if (args.command === "pull") return;
  const shared = args.command === "keys" && args.operands[0] === "accept-slots" ? ACCEPT_SLOTS_PULL_FLAGS : new Set<string>();
  const on = (flag: boolean): true | undefined => (flag ? true : undefined);
  const given = Object.entries({
    "--name": args.pull.name,
    "--manifest": args.pull.manifest,
    "--root-cid": args.pull.rootCid,
    "--allow-rollback": on(args.pull.allowRollback),
    "--resolve-fork": on(args.pull.resolveFork),
    "--expect-min-sequence": args.pull.expectMinSequence,
    "--expect-vault-id": args.pull.expectVaultId,
    "--accept-first-pull": on(args.pull.acceptFirstPull),
    "--accept-replace": on(args.pull.acceptReplace),
    "--max-bytes": args.pull.maxBytes,
    "--accept-large": on(args.pull.acceptLarge),
    "--list-versions": on(args.pull.listVersions),
  }).find(([flag, value]) => value !== undefined && !shared.has(flag));
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
    "--allow-mass-removal": args.allowMassRemoval,
  }).find(([, value]) => value);
  if (given !== undefined) throw new UsageError(`${given[0]} is only valid for the publish command`);
}

/** `--passphrase-file` belongs to `init` and `keys change-passphrase`; the other commands read `IPFS_SYNC_PASSPHRASE_FILE`. */
function checkInitFlags(args: ParsedArgs): void {
  if (args.command === "init" || args.passphraseFile === undefined) return;
  if (args.command === "keys") return; // which subcommand takes it is judged by the command itself
  throw new UsageError("--passphrase-file is only valid for the init command and keys change-passphrase; publish reads the file named by IPFS_SYNC_PASSPHRASE_FILE");
}

/** `--cost`, `--accept-no-revocation` and `--allow-downgrade` belong to `keys` only. */
function checkKeysFlags(args: ParsedArgs): void {
  if (args.command === "keys") return;
  const given = Object.entries({ "--cost": args.keys.cost, "--accept-no-revocation": args.keys.acceptNoRevocation || undefined, "--allow-downgrade": args.keys.allowDowngrade || undefined }).find(
    ([, value]) => value !== undefined,
  );
  if (given !== undefined) throw new UsageError(`${given[0]} is only valid for the keys command`);
}

/** `--keep`, `--dry-run` and `--yes-prune` belong to `prune-history` only, and `prune-history` needs `--keep` and takes one yes (a dry run asks nothing). */
function checkPruneFlags(args: ParsedArgs): void {
  const { keep, dryRun, yesPrune } = args.prune;
  if (args.command !== "prune-history") {
    const given = Object.entries({ "--keep": keep, "--dry-run": dryRun || undefined, "--yes-prune": yesPrune || undefined }).find(([, value]) => value !== undefined);
    if (given !== undefined) throw new UsageError(`${given[0]} is only valid for the prune-history command`);
    return;
  }
  if (keep === undefined) throw new UsageError("prune-history needs --keep <n>: how many history files to keep (at least 20 are always kept); nothing was sent");
  if (dryRun && yesPrune) throw new UsageError("--dry-run and --yes-prune exclude each other: a dry run removes nothing, so there is nothing to confirm; nothing was sent");
}

/** `--limit` belongs to `history` only. */
function checkHistoryFlags(args: ParsedArgs): void {
  if (args.command !== "history" && args.history.limit !== undefined) throw new UsageError("--limit is only valid for the history command");
}

/**
 * A passphrase file inside the vault folder would be published with the notes it protects. Both the file `--passphrase-file` is to create and the
 * one `IPFS_SYNC_PASSPHRASE_FILE` names are judged by their real location; `init` and `abandon` ignore the variable and are not judged on it.
 */
async function checkPassphraseFileOutsideVault(args: ParsedArgs, vaultPath: string | undefined, env: CliDeps["env"]): Promise<void> {
  if (vaultPath === undefined) return;
  const readsEnvironment = args.command !== "init" && args.command !== "abandon";
  for (const file of [args.passphraseFile, readsEnvironment ? env[PASSPHRASE_FILE_ENV] : undefined]) {
    if (file !== undefined && (await passphraseFileInsideVault(vaultPath, file))) {
      throw new UsageError("the passphrase file is inside the vault folder, where the next publish would upload it; keep it outside the vault; nothing was sent");
    }
  }
}

/** `--yes-abandon` belongs to `abandon` only. */
function checkAbandonFlags(args: ParsedArgs): void {
  if (args.command !== "abandon" && args.yesAbandon) throw new UsageError("--yes-abandon is only valid for the abandon command");
}

/** `--yes-discard` belongs to `keys discard` only. */
function checkDiscardFlags(args: ParsedArgs): void {
  if (args.yesDiscard && !(args.command === "keys" && args.operands[0] === "discard")) throw new UsageError("--yes-discard is only valid for keys discard");
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
  checkDiscardFlags(args);
  checkKeysFlags(args);
  checkPruneFlags(args);
  checkHistoryFlags(args);
  await checkPassphraseFileOutsideVault(args, vaultPath, deps.env);
  if (args.command === "history") {
    // Device-local and read-only: no config file is read, no client is created, no request can be sent, no passphrase is asked.
    return await runHistory({ io, env: deps.env, limit: args.history.limit });
  }
  if (args.command === "abandon" && vaultPath !== undefined) {
    // Local only, and the escape hatch for a node that is gone: no RPC or gateway URL is needed, no client is created, no request can be sent.
    const local = await loadLocalConfig(args, deps);
    return await runAbandon({ config: local, io, vaultPath, env: deps.env, now: deps.now, yesAbandon: args.yesAbandon });
  }
  // Configuration is validated in full before the first request can be sent.
  const config = await loadSyncConfig(args, deps, { configMayBeMissing: args.command === "publish" || args.command === "keys" || args.command === "prune-history" });
  for (const warning of config.warnings) io.err(`warning: ${warning}`);
  const client = createKuboClient({ rpc: config.rpc, gateway: config.gateway });
  const restore = args.showRequest ? installRequestTrace(config, io) : undefined;
  try {
    if (vaultPath === undefined) return await runStatus({ config, client, io });
    if (args.command === "init") {
      return await runInit({ config, client, io, vaultPath, env: deps.env, now: deps.now, passphraseFile: args.passphraseFile, terminal: deps.terminal, file: fileHost(deps) });
    }
    const passphrase = deps.passphrase ?? (() => readVaultPassphrase({ ...fileHost(deps), env: deps.env, terminal: deps.terminal, warn: (text) => io.err(text) }));
    if (args.command === "keys") {
      return await runKeys({
        config,
        client,
        io,
        vaultPath,
        subcommand: checkKeysOperands(args).subcommand,
        flags: args.keys,
        accept: {
          name: args.pull.name,
          rootCid: args.pull.rootCid,
          allowRollback: args.pull.allowRollback,
          expectVaultId: args.pull.expectVaultId,
          expectMinSequence: args.pull.expectMinSequence,
        },
        yesDiscard: args.yesDiscard,
        passphraseFile: args.passphraseFile,
        env: deps.env,
        now: deps.now,
        passphrase,
        terminal: deps.terminal,
        file: fileHost(deps),
        ...(deps.keyOperations === undefined ? {} : { operations: deps.keyOperations }),
      });
    }
    if (args.command === "prune-history") {
      return await runPrune({ config, client, io, vaultPath, flags: args.prune, env: deps.env, now: deps.now, passphrase });
    }
    if (args.command === "pull") {
      return await runPull({ config, client, io, vaultPath, flags: args.pull, env: deps.env, now: deps.now, passphrase, freeBytes: deps.freeBytes });
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
      passphrase,
      flags: { breakLock: args.breakLock, repair: args.repair, recoverSlots: args.recoverSlots, allowFullReupload: args.allowFullReupload, allowMassRemoval: args.allowMassRemoval },
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
