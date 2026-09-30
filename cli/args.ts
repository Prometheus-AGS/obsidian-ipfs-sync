import { parseArgs } from "node:util";
import type { RawAuthInput, RawConfigLayer, RawEndpointInput } from "../src/core/config";

export interface ParsedArgs {
  readonly command: string | undefined;
  /** Positional arguments after the command (for `publish`, the vault directory). */
  readonly operands: readonly string[];
  readonly help: boolean;
  readonly showRequest: boolean;
  readonly configPath: string | undefined;
  /** Highest-precedence configuration layer built from flags. */
  readonly flagsLayer: RawConfigLayer;
  /** Flags only `pull` understands; other commands reject them. */
  readonly pull: PullFlags;
}

export interface PullFlags {
  readonly name: string | undefined;
  readonly manifest: string | undefined;
  readonly manifestFile: string | undefined;
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
  name: { type: "string" },
  manifest: { type: "string" },
  "manifest-file": { type: "string" },
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

function parseStrict(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
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
    configPath: parsed.values.config,
    flagsLayer: toLayer(parsed.values),
    pull: { name: parsed.values.name, manifest: parsed.values.manifest, manifestFile: parsed.values["manifest-file"] },
  };
}
