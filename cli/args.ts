import { parseArgs } from "node:util";
import type { RawAuthInput, RawConfigLayer, RawEndpointInput } from "../src/core/config";
import type { CostPresetName } from "../src/sync/key-management";

export interface ParsedArgs {
  readonly command: string | undefined;
  /** Positional arguments after the command (for `publish`, the vault directory). */
  readonly operands: readonly string[];
  readonly help: boolean;
  readonly showRequest: boolean;
  /** `--break-lock`: remove a stale-looking publish lock after a confirmation (publish only). */
  readonly breakLock: boolean;
  /** `--repair`, `--recover-slots`, `--allow-full-reupload`: publish only. */
  readonly repair: boolean;
  readonly recoverSlots: boolean;
  readonly allowFullReupload: boolean;
  /** `--allow-mass-removal`: publish only. */
  readonly allowMassRemoval: boolean;
  /** `--yes-abandon`: confirm the abandon command without typing the word (abandon only). */
  readonly yesAbandon: boolean;
  /** `--yes-discard`: confirm `keys discard` without a terminal (keys discard only). */
  readonly yesDiscard: boolean;
  /** `--passphrase-file <path>`: where `init` writes the passphrase it generates (init only). */
  readonly passphraseFile: string | undefined;
  readonly configPath: string | undefined;
  /** Highest-precedence configuration layer built from flags. */
  readonly flagsLayer: RawConfigLayer;
  /** Flags only `pull` understands; other commands reject them. */
  readonly pull: PullFlags;
  /** Flags only `keys` understands; other commands reject them. */
  readonly keys: KeysFlags;
  /** Flags only `prune-history` understands; other commands reject them. */
  readonly prune: PruneFlags;
}

export interface PruneFlags {
  /** `--keep <n>`: the number of history files to keep (at least 20 are always kept). Required by `prune-history`. */
  readonly keep: number | undefined;
  /** `--dry-run`: print the files that would be removed and stop; nothing is written, no lock is taken. */
  readonly dryRun: boolean;
  /** `--yes-prune`: the non-interactive yes to the removal question. */
  readonly yesPrune: boolean;
}

/** The cost presets of `keys increase-cost` and `keys change-passphrase`; the numbers live in `src/sync/key-management.ts` (`COST_PRESETS`). */
export const COST_PRESET_NAMES = ["standard", "high"] as const satisfies readonly CostPresetName[];

export interface KeysFlags {
  /** `--cost standard|high`: the cost of the new key slot. `increase-cost` needs it; `change-passphrase` keeps the current cost without it. */
  readonly cost: CostPresetName | undefined;
  /** `--accept-no-revocation`: the non-interactive yes to the statement that old passphrases and old slot copies keep working. */
  readonly acceptNoRevocation: boolean;
  /** `--allow-downgrade`: the non-interactive yes to a new cost below the current one (change-passphrase only). */
  readonly allowDowngrade: boolean;
}

export interface PullFlags {
  readonly name: string | undefined;
  readonly manifest: string | undefined;
  /** `--root-cid <cid>`: pull an explicit immutable root instead of the name (encrypted vaults). */
  readonly rootCid: string | undefined;
  /** `--allow-rollback`: with `--root-cid` or `--manifest`, accept an older sequence as a restore. */
  readonly allowRollback: boolean;
  /** `--resolve-fork`: merge the node's state into this device's after a fork (name target only). */
  readonly resolveFork: boolean;
  readonly expectMinSequence: number | undefined;
  readonly expectVaultId: string | undefined;
  /** `--accept-first-pull`: the non-interactive yes to the first-pull question. */
  readonly acceptFirstPull: boolean;
  /** `--max-bytes <n>`: plaintext bytes above which the pull asks (default 512 MiB). */
  readonly maxBytes: number | undefined;
  /** `--accept-large`: the non-interactive yes to the large-pull question. */
  readonly acceptLarge: boolean;
  /** `--list-versions`: print the newest history entries and stop. */
  readonly listVersions: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const OPTIONS = {
  config: { type: "string" },
  "rpc-url": { type: "string" },
  "rpc-port": { type: "string" },
  "gateway-url": { type: "string" },
  "gateway-port": { type: "string" },
  "mfs-root": { type: "string" },
  key: { type: "string" },
  "owned-key": { type: "string", multiple: true },
  auth: { type: "string" },
  "auth-user": { type: "string" },
  "auth-header-name": { type: "string" },
  "show-request": { type: "boolean" },
  "break-lock": { type: "boolean" },
  repair: { type: "boolean" },
  "recover-slots": { type: "boolean" },
  "allow-full-reupload": { type: "boolean" },
  "allow-mass-removal": { type: "boolean" },
  "yes-abandon": { type: "boolean" },
  "yes-discard": { type: "boolean" },
  "passphrase-file": { type: "string" },
  name: { type: "string" },
  manifest: { type: "string" },
  "root-cid": { type: "string" },
  "allow-rollback": { type: "boolean" },
  "resolve-fork": { type: "boolean" },
  "expect-min-sequence": { type: "string" },
  "expect-vault-id": { type: "string" },
  "accept-first-pull": { type: "boolean" },
  "max-bytes": { type: "string" },
  "accept-large": { type: "boolean" },
  "list-versions": { type: "boolean" },
  cost: { type: "string" },
  "accept-no-revocation": { type: "boolean" },
  "allow-downgrade": { type: "boolean" },
  keep: { type: "string" },
  "dry-run": { type: "boolean" },
  "yes-prune": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

interface FlagValues {
  readonly "rpc-url"?: string;
  readonly "rpc-port"?: string;
  readonly "gateway-url"?: string;
  readonly "gateway-port"?: string;
  readonly "mfs-root"?: string;
  readonly key?: string;
  readonly "owned-key"?: string[];
  readonly auth?: string;
  readonly "auth-user"?: string;
  readonly "auth-header-name"?: string;
}

function endpointFlags(url: string | undefined, port: string | undefined): RawEndpointInput | undefined {
  return url === undefined && port === undefined ? undefined : { url, port };
}

function authFlags(values: FlagValues): RawAuthInput | undefined {
  const auth: RawAuthInput = {
    scheme: values["auth"],
    user: values["auth-user"],
    password: undefined,
    token: undefined,
    headerName: values["auth-header-name"],
    headerValue: undefined,
  };
  return Object.values(auth).every((v) => v === undefined) ? undefined : auth;
}

function toLayer(values: FlagValues): RawConfigLayer {
  return {
    rpc: endpointFlags(values["rpc-url"], values["rpc-port"]),
    gateway: endpointFlags(values["gateway-url"], values["gateway-port"]),
    mfsRoot: values["mfs-root"],
    publicationKey: values["key"],
    ownedKeys: values["owned-key"],
    auth: authFlags(values),
  };
}

/** `--passphrase` (any spelling) is refused by name: the passphrase never travels on the command line, and its value is never echoed. */
function rejectPassphraseFlag(argv: readonly string[]): void {
  const end = argv.indexOf("--");
  const flags = end === -1 ? argv : argv.slice(0, end);
  if (flags.some((arg) => arg === "--passphrase" || arg.startsWith("--passphrase="))) {
    throw new UsageError(
      "unknown option --passphrase: the passphrase is never taken from the command line; it comes from the environment (IPFS_SYNC_PASSPHRASE), a file (IPFS_SYNC_PASSPHRASE_FILE) or a prompt",
    );
  }
}

/** The credential flags that were removed, with the environment variable that replaces each. A credential on the command line shows in the process list and the shell history. */
const REFUSED_CREDENTIAL_FLAGS: Readonly<Record<string, string>> = {
  "--auth-password": "IPFS_SYNC_AUTH_PASSWORD",
  "--auth-token": "IPFS_SYNC_AUTH_TOKEN",
  "--auth-header-value": "IPFS_SYNC_AUTH_HEADER_VALUE",
};

/** `--auth-password`, `--auth-token` and `--auth-header-value` (either spelling) are refused by name; the value is never echoed. */
function rejectCredentialFlags(argv: readonly string[]): void {
  const end = argv.indexOf("--");
  const flags = end === -1 ? argv : argv.slice(0, end);
  for (const [flag, variable] of Object.entries(REFUSED_CREDENTIAL_FLAGS)) {
    if (flags.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) {
      throw new UsageError(
        `unknown option ${flag}: credentials are never taken from the command line, where the process list and the shell history show them; set ${variable} in the environment (per endpoint: ${variable.replace("IPFS_SYNC_AUTH_", "IPFS_SYNC_RPC_AUTH_")} or ${variable.replace("IPFS_SYNC_AUTH_", "IPFS_SYNC_GATEWAY_AUTH_")})`,
      );
    }
  }
}

function parseStrict(argv: readonly string[]) {
  rejectPassphraseFlag(argv);
  rejectCredentialFlags(argv);
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

const HEX32 = /^[0-9a-f]{32}$/;

/** A positive whole number written in decimal digits only, or undefined when the flag is absent. */
function positiveInteger(flag: string, text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(value) || value < 1) throw new UsageError(`${flag} needs a positive whole number, got "${text}"`);
  return value;
}

function pullFlags(values: ReturnType<typeof parseStrict>["values"]): PullFlags {
  const expectVaultId = values["expect-vault-id"];
  if (expectVaultId !== undefined && !HEX32.test(expectVaultId)) {
    throw new UsageError("--expect-vault-id needs 32 lowercase hexadecimal characters (the vault id the key slots carry)");
  }
  return {
    name: values.name,
    manifest: values.manifest,
    rootCid: values["root-cid"],
    allowRollback: values["allow-rollback"] ?? false,
    resolveFork: values["resolve-fork"] ?? false,
    expectMinSequence: positiveInteger("--expect-min-sequence", values["expect-min-sequence"]),
    expectVaultId,
    acceptFirstPull: values["accept-first-pull"] ?? false,
    maxBytes: positiveInteger("--max-bytes", values["max-bytes"]),
    acceptLarge: values["accept-large"] ?? false,
    listVersions: values["list-versions"] ?? false,
  };
}

function keysFlags(values: ReturnType<typeof parseStrict>["values"]): KeysFlags {
  const cost = values.cost;
  const known = COST_PRESET_NAMES.find((name) => name === cost);
  if (cost !== undefined && known === undefined) throw new UsageError(`--cost needs one of ${COST_PRESET_NAMES.join(", ")}, got "${cost}"`);
  return { cost: known, acceptNoRevocation: values["accept-no-revocation"] ?? false, allowDowngrade: values["allow-downgrade"] ?? false };
}

function pruneFlags(values: ReturnType<typeof parseStrict>["values"]): PruneFlags {
  return { keep: positiveInteger("--keep", values.keep), dryRun: values["dry-run"] ?? false, yesPrune: values["yes-prune"] ?? false };
}

/** Parse argv (without node and script). Throws UsageError on unknown flags; each command checks its own operands. */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const parsed = parseStrict(argv);
  const [command, ...operands] = parsed.positionals;
  return {
    command,
    operands,
    help: parsed.values.help ?? false,
    showRequest: parsed.values["show-request"] ?? false,
    breakLock: parsed.values["break-lock"] ?? false,
    repair: parsed.values.repair ?? false,
    recoverSlots: parsed.values["recover-slots"] ?? false,
    allowFullReupload: parsed.values["allow-full-reupload"] ?? false,
    allowMassRemoval: parsed.values["allow-mass-removal"] ?? false,
    yesAbandon: parsed.values["yes-abandon"] ?? false,
    yesDiscard: parsed.values["yes-discard"] ?? false,
    passphraseFile: parsed.values["passphrase-file"],
    configPath: parsed.values.config,
    flagsLayer: toLayer(parsed.values),
    pull: pullFlags(parsed.values),
    keys: keysFlags(parsed.values),
    prune: pruneFlags(parsed.values),
  };
}
