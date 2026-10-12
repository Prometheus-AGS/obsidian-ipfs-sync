// CLI child runner with per-device isolation (task 1.4, design decision 4). Every scenario step spawns
// `process.execPath dist/cli/ipfs-sync.mjs` as a child process — the sync loop never runs as a library call.
// Modeled on tools/feature-op-mvp-07a/children.mjs: the effective-target assertion is re-bound to SUITE_KEY and
// the run root, the environment allowlist / redaction / needle scanning come from 07a through ./tools-07a, and the
// effective configuration is computed with the CLI's own loader (cli/args.ts parseCliArgs + cli/load-config.ts
// loadSyncConfig) from the exact argv and environment the child will get, before the spawn.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { parseCliArgs } from "../../../cli/args";
import { loadSyncConfig, readTextIfPresent } from "../../../cli/load-config";
import { type RunContext, SUITE_KEY, SuiteRefusal } from "./run-context";
import { loadTools07a, type Needle } from "./tools-07a";

/** Per-child spawn timeout (design decision 7; the value of 07a's CHILD_TIMEOUT_MS). */
export const CHILD_TIMEOUT_MS = 300_000;

export interface EffectiveConfig {
  readonly rpc: string;
  readonly gateway: string;
  readonly mfsRoot: string;
  readonly key: string;
  readonly command: string | undefined;
}

/** The CLI's own loader applied to the exact argv and environment a child would get (the 07a toolbox effectiveConfig). */
export async function effectiveConfig(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<EffectiveConfig> {
  const args = parseCliArgs(argv);
  const config = await loadSyncConfig(args, { env, now: () => new Date(), readText: readTextIfPresent }, { configMayBeMissing: args.command === "publish" });
  return { rpc: config.rpc.baseUrl, gateway: config.gateway.baseUrl, mfsRoot: config.mfsRoot, key: config.publicationKey, command: args.command };
}

/**
 * The 07a loopback check, re-declared: tools-07a.ts does not surface isLoopbackUrl (the suite's proxy URL is always
 * its own loopback listener, so this never judges an operator-supplied address).
 */
export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

export interface EffectiveTarget {
  /** The loopback proxy URL every child must point at. */
  readonly url: string;
  /** This run's MFS root; the effective root must lie at or below it. */
  readonly runRoot: string;
}

/**
 * Refuse to start a child unless its effective configuration — computed with the CLI's own loader from the exact
 * argv/env — is exactly the intended target: the loopback proxy, a root at or below the run root, and SUITE_KEY
 * (the 07a assertEffectiveTarget pattern, re-bound).
 */
export async function assertEffectiveTarget(argv: readonly string[], env: Record<string, string>, target: EffectiveTarget): Promise<void> {
  const tools = await loadTools07a();
  const effective = await effectiveConfig(argv, env).catch((error: unknown) => {
    throw new SuiteRefusal(`refusing to start a child: its configuration does not load (${tools.firstLine(error instanceof Error ? error.message : String(error))})`);
  });
  const problems: string[] = [];
  if (!isLoopbackUrl(target.url)) problems.push(`the intended API URL ${target.url} is not a loopback URL`);
  if (effective.rpc !== target.url) problems.push(`effective RPC URL is ${effective.rpc}, expected ${target.url}`);
  if (effective.gateway !== target.url) problems.push(`effective gateway URL is ${effective.gateway}, expected ${target.url}`);
  if (!tools.isWithin(effective.mfsRoot, target.runRoot, { allowEqual: true })) problems.push(`effective MFS root ${effective.mfsRoot} is outside ${target.runRoot}`);
  if (effective.key !== SUITE_KEY) problems.push(`effective publication key is ${effective.key}, expected ${SUITE_KEY}`);
  if (problems.length > 0) throw new SuiteRefusal(`refusing to start a child: ${problems.join("; ")}`);
}

export interface DeviceSpec {
  /** Device label, passed to every child as IPFS_SYNC_DEVICE. */
  readonly name: string;
  /** The device's own vault directory, under the per-run temp dir. */
  readonly vaultDir: string;
  /** The device's own config file, under the per-run temp dir. */
  readonly configFile: string;
  /** XDG_STATE_HOME of every child of this device (device id, sequence floor, history database). */
  readonly stateHome: string;
  /** HOME of every child of this device. */
  readonly homeDir: string;
}

const DEVICE_NAME = /^[a-z0-9-]+$/;

/**
 * The per-device layout under the run's temp dir: own vault, config file, state home and home, all created.
 * The name interpolates into paths, so separators and dot segments are refused instead of resolved.
 */
export async function makeDevice(context: RunContext, name: string): Promise<DeviceSpec> {
  if (!DEVICE_NAME.test(name)) throw new SuiteRefusal(`device name "${name.slice(0, 40)}" does not match ${DEVICE_NAME}`);
  const dir = join(context.tempDir, "devices", name);
  const device: DeviceSpec = {
    name,
    vaultDir: join(dir, "vault"),
    configFile: join(dir, "ipfs-sync.config.json"),
    stateHome: join(dir, "state"),
    homeDir: join(dir, "home"),
  };
  await mkdir(device.vaultDir, { recursive: true });
  await mkdir(device.stateHome, { recursive: true });
  await mkdir(device.homeDir, { recursive: true });
  return device;
}

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
  /** A passphrase spelling or a fixture plaintext needle appeared in the child's output. */
  readonly leaked: boolean;
  /** The label of the first plaintext needle found, when any. */
  readonly needle?: string;
}

interface RawChildResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

function execChild(cli: string, argv: readonly string[], env: Record<string, string>, cwd: string, timeoutMs: number): Promise<RawChildResult> {
  const started = performance.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => done({ code: 127, stdout, stderr: `${stderr}${error.message}`, ms: 0 }));
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, ms: Math.round(performance.now() - started) });
    });
  });
}

/**
 * The 07a scrub discipline: every child's output is scanned for the passphrase in both spellings and for the fixture
 * plaintext needles, and the passphrase spellings are redacted, before anything is printed. `leaked` flags any hit so
 * the scenario can fail on it.
 */
export async function scrubOutput(result: RawChildResult, secrets: readonly string[], needles: readonly Needle[]): Promise<CliResult> {
  const tools = await loadTools07a();
  const combined = `${result.stdout}\n${result.stderr}`;
  const needle = tools.findNeedle(Buffer.from(combined, "utf8"), needles);
  const secretHit = secrets.some((secret) => secret !== "" && combined.includes(secret));
  return {
    ...result,
    leaked: secretHit || needle !== undefined,
    needle,
    stdout: tools.redact(result.stdout, secrets),
    stderr: tools.redact(result.stderr, secrets),
  };
}

export interface CliRunOptions {
  /** Passed to the child as IPFS_SYNC_PASSPHRASE_FILE (init/publish/pull of an encrypted vault). */
  readonly passphraseFile?: string;
  /** Overrides the run root for one call (still asserted at or below the run root). */
  readonly mfsRoot?: string;
  /** Extra CLI flags, appended after the operands and before the suite's own flags. */
  readonly extra?: readonly string[];
}

export type CliRunner = (command: string, operands?: readonly string[], options?: CliRunOptions) => Promise<CliResult>;

export interface CliRunnerOptions {
  readonly context: RunContext;
  readonly device: DeviceSpec;
  /** The loopback proxy URL (proxy.url after start()). */
  readonly proxyUrl: string;
  /** Key IDs passed as --owned-key (the adopted suite key ID). */
  readonly ownedKeyIds?: readonly string[];
  /** The passphrase in both spellings (grouped and canonical), redacted from all output. */
  readonly secrets: () => readonly string[];
  /** Fixture plaintext needles scanned out of all child output. */
  readonly needles?: () => readonly Needle[];
  /** Child working directory; defaults to the per-run temp dir (never the repository). */
  readonly cwd?: string;
  /** The built CLI entry; defaults to dist/cli/ipfs-sync.mjs. Overridable for offline tests. */
  readonly cli?: string;
  readonly timeoutMs?: number;
  /** Test seam for the environment the allowlist is applied to; defaults to process.env. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}

/** Strictly below dir (filesystem containment; a path equal to dir does not qualify). */
function isStrictlyUnder(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * One runner per simulated device (07a children.mjs makeCliRunner, re-bound): its own vault directory, config file and
 * per-user state directory. XDG_STATE_HOME and HOME must both be absolute, under the per-run temp dir and outside the
 * repository — a child without its own state would read and write the operator's real device id, sequence floor and
 * history database. The effective target is asserted before every spawn, from the exact argv and environment.
 */
export async function makeCliRunner(options: CliRunnerOptions): Promise<CliRunner> {
  const tools = await loadTools07a();
  const { context, device, proxyUrl } = options;
  for (const [label, dir] of [["XDG_STATE_HOME", device.stateHome], ["HOME", device.homeDir]] as const) {
    if (!isAbsolute(dir)) throw new SuiteRefusal(`${label} of device ${device.name} must be absolute, got "${dir}"`);
    if (!tools.isOutsideRepo(dir)) throw new SuiteRefusal(`${label} of device ${device.name} is inside the repository: ${dir}`);
    if (!isStrictlyUnder(dir, context.tempDir)) throw new SuiteRefusal(`${label} of device ${device.name} must lie under the per-run temp dir ${context.tempDir}, got "${dir}"`);
  }
  const cli = options.cli ?? join(tools.repoRoot, "dist", "cli", "ipfs-sync.mjs");
  const cwd = options.cwd ?? context.tempDir;
  const ownedFlags = (options.ownedKeyIds ?? []).flatMap((id) => ["--owned-key", id]);
  const timeoutMs = options.timeoutMs ?? CHILD_TIMEOUT_MS;
  return async (command, operands = [], runOptions = {}) => {
    const argv = [
      command,
      ...operands,
      ...(runOptions.extra ?? []),
      "--config",
      device.configFile,
      "--rpc-url",
      proxyUrl,
      "--gateway-url",
      proxyUrl,
      "--mfs-root",
      runOptions.mfsRoot ?? context.runRoot,
      "--key",
      SUITE_KEY,
      ...ownedFlags,
    ];
    const env = tools.childEnv(options.baseEnv ?? process.env, {
      IPFS_SYNC_DEVICE: device.name,
      XDG_STATE_HOME: device.stateHome,
      HOME: device.homeDir,
      ...(runOptions.passphraseFile === undefined ? {} : { IPFS_SYNC_PASSPHRASE_FILE: runOptions.passphraseFile }),
    });
    await assertEffectiveTarget(argv, env, { url: proxyUrl, runRoot: context.runRoot });
    return scrubOutput(await execChild(cli, argv, env, cwd, timeoutMs), options.secrets(), options.needles?.() ?? []);
  };
}
