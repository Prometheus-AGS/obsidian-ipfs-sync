import { parseArgs } from "node:util";
import type { RawAuthInput, RawConfigLayer, RawEndpointInput } from "../src/core/config";

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
  /** `--yes-abandon`: confirm the abandon command without typing the word (abandon only). */
  readonly yesAbandon: boolean;
  /** `--passphrase-file <path>`: where `init` writes the passphrase it generates (init only). */
  readonly passphraseFile: string | undefined;
  readonly configPath: string | undefined;
  /** Highest-precedence configuration layer built from flags. */
  readonly flagsLayer: RawConfigLayer;
  /** Flags only `pull` understands; other commands reject them. */
  readonly pull: PullFlags;
}

export interface PullFlags {
  /** `--allow-plaintext-v1`: let the plaintext (version 1) reader run; refused anyway once an encrypted vault was seen. */
  readonly allowPlaintextV1: boolean;
  readonly name: string | undefined;
  readonly manifest: string | undefined;
  readonly manifestFile: string | undefined;
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
  "auth-password": { type: "string" },
  "auth-token": { type: "string" },
  "auth-header-name": { type: "string" },
  "auth-header-value": { type: "string" },
  "show-request": { type: "boolean" },
  "break-lock": { type: "boolean" },
  repair: { type: "boolean" },
  "recover-slots": { type: "boolean" },
  "allow-full-reupload": { type: "boolean" },
  "allow-plaintext-v1": { type: "boolean" },
  "yes-abandon": { type: "boolean" },
  "passphrase-file": { type: "string" },
  name: { type: "string" },
  manifest: { type: "string" },
  "manifest-file": { type: "string" },
  "root-cid": { type: "string" },
  "allow-rollback": { type: "boolean" },
  "resolve-fork": { type: "boolean" },
  "expect-min-sequence": { type: "string" },
  "expect-vault-id": { type: "string" },
  "accept-first-pull": { type: "boolean" },
  "max-bytes": { type: "string" },
  "accept-large": { type: "boolean" },
  "list-versions": { type: "boolean" },
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
  readonly "auth-password"?: string;
  readonly "auth-token"?: string;
  readonly "auth-header-name"?: string;
  readonly "auth-header-value"?: string;
}

function endpointFlags(url: string | undefined, port: string | undefined): RawEndpointInput | undefined {
  return url === undefined && port === undefined ? undefined : { url, port };
}

function authFlags(values: FlagValues): RawAuthInput | undefined {
  const auth: RawAuthInput = {
    scheme: values["auth"],
    user: values["auth-user"],
    password: values["auth-password"],
    token: values["auth-token"],
    headerName: values["auth-header-name"],
    headerValue: values["auth-header-value"],
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

function parseStrict(argv: readonly string[]) {
  rejectPassphraseFlag(argv);
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
    allowPlaintextV1: values["allow-plaintext-v1"] ?? false,
    name: values.name,
    manifest: values.manifest,
    manifestFile: values["manifest-file"],
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
    yesAbandon: parsed.values["yes-abandon"] ?? false,
    passphraseFile: parsed.values["passphrase-file"],
    configPath: parsed.values.config,
    flagsLayer: toLayer(parsed.values),
    pull: pullFlags(parsed.values),
  };
}
