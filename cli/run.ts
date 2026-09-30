import { ConfigError } from "../src/core/config";
import { createKuboClient } from "../src/kubo";
import { UsageError, parseCliArgs, type ParsedArgs } from "./args";
import { HELP_TEXT } from "./help-text";
import { EXIT_OK, EXIT_USAGE, type CliIo } from "./io";
import { DEFAULT_CONFIG_PATH, loadSyncConfig, type ConfigDeps } from "./load-config";
import { runPublish } from "./publish-command";
import { runPull } from "./pull-command";
import { installRequestTrace } from "./request-trace";
import { runStatus } from "./status-command";

const COMMANDS: readonly string[] = ["status", "publish", "pull"];

function reportBadInput(io: CliIo, error: UsageError | ConfigError): number {
  const kind = error instanceof ConfigError ? "configuration error" : "usage error";
  io.err(`ipfs-sync: ${kind}: ${error.message}`);
  if (error instanceof UsageError) io.err("run `ipfs-sync --help` for usage");
  return EXIT_USAGE;
}

/** The vault directory `publish` and `pull` need; `status` takes no operands. */
function checkOperands(args: ParsedArgs): string | undefined {
  if (args.command === "publish" || args.command === "pull") {
    if (args.operands.length !== 1) throw new UsageError(`${args.command} needs exactly one argument: the vault directory`);
    return args.operands[0];
  }
  if (args.operands.length > 0) throw new UsageError(`unexpected argument "${args.operands[0]}"`);
  return undefined;
}

/** `--name`, `--manifest` and `--manifest-file` belong to `pull` only. */
function checkPullFlags(args: ParsedArgs): void {
  if (args.command === "pull") return;
  const given = Object.entries({ "--name": args.pull.name, "--manifest": args.pull.manifest, "--manifest-file": args.pull.manifestFile }).find(
    ([, value]) => value !== undefined,
  );
  if (given !== undefined) throw new UsageError(`${given[0]} is only valid for the pull command`);
}

async function execute(argv: readonly string[], deps: ConfigDeps, io: CliIo): Promise<number> {
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
  // Configuration is validated in full before the first request can be sent.
  const config = await loadSyncConfig(args, deps, { configMayBeMissing: args.command === "publish" });
  for (const warning of config.warnings) io.err(`warning: ${warning}`);
  const client = createKuboClient({ rpc: config.rpc, gateway: config.gateway });
  const restore = args.showRequest ? installRequestTrace(config, io) : undefined;
  try {
    if (vaultPath === undefined) return await runStatus({ config, client, io });
    if (args.command === "pull") {
      return await runPull({ config, client, io, vaultPath, flags: args.pull, env: deps.env, now: deps.now });
    }
    const configPath = args.configPath ?? DEFAULT_CONFIG_PATH;
    return await runPublish({ config, client, io, vaultPath, configPath, env: deps.env, now: deps.now });
  } finally {
    restore?.();
  }
}

/** Run the CLI and return the process exit code. */
export async function runCli(argv: readonly string[], deps: ConfigDeps, io: CliIo): Promise<number> {
  try {
    return await execute(argv, deps, io);
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError) return reportBadInput(io, error);
    throw error;
  }
}
