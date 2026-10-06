// Preflights (task 1.2, design decision 5): fail fast, never skip. The node-version floor comes from package.json
// engines.node; the build-freshness refusal re-implements the 07a checkBuildFresh pattern (the suite never builds); the
// node probe is bounded and read-only, and its failure names the node address and the error. Key adoption reuses the 07a
// readOwnedKeys/ensureConfig against the per-machine config; the adoptability check itself is re-declared here because
// the 07a assertKeyAdoptable is bound to the 07a key (obsidian-vault-sync), not to SUITE_KEY.
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { SUITE_KEY, SuiteRefusal } from "./run-context";
import { loadTools07a } from "./tools-07a";

const VERSION_TEXT = /^v?(\d+)\.(\d+)\.(\d+)/;
const REQUIREMENT_TEXT = /^>=\s*(\d+)\.(\d+)\.(\d+)$/;

/** The engines.node requirement of the repository's package.json (">=24.15.0" today). */
export async function enginesNodeRequirement(repoRoot: string): Promise<string> {
  const parsed = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { engines?: { node?: string } };
  const requirement = parsed.engines?.node;
  if (requirement === undefined) throw new SuiteRefusal("package.json has no engines.node; the suite needs the pinned node floor");
  return requirement;
}

/**
 * undefined when `version` satisfies a ">=x.y.z" requirement; otherwise the refusal text. The fix is named because the
 * default shell on this machine resolves node 24.11.1 (mvp-08 gate note, execution.md:105).
 */
export function nodeVersionRefusal(version: string, requirement: string): string | undefined {
  const v = VERSION_TEXT.exec(version);
  const r = REQUIREMENT_TEXT.exec(requirement.trim());
  if (v === null || r === null) return `cannot check node version "${version}" against engines.node "${requirement}"`;
  const actual = [Number(v[1]), Number(v[2]), Number(v[3])];
  const floor = [Number(r[1]), Number(r[2]), Number(r[3])];
  const satisfies = actual[0] > floor[0] || (actual[0] === floor[0] && (actual[1] > floor[1] || (actual[1] === floor[1] && actual[2] >= floor[2])));
  if (satisfies) return undefined;
  return `node ${version} does not satisfy engines.node ${requirement}; spawned CLI children inherit exactly this runtime (process.execPath). On this machine the default shell resolves node 24.11.1 — put the newer node first: PATH=/opt/homebrew/bin:$PATH pnpm test:e2e`;
}

/**
 * The 07a checkBuildFresh pattern, re-declared (tools/ is out of scope): dist/cli/ipfs-sync.mjs must exist and be newer
 * than every .ts/.mjs under cli/ and src/. Returns the refusal text or undefined. The suite never builds.
 */
export async function staleBuildRefusal(repoRoot: string, cliRelativePath = "dist/cli/ipfs-sync.mjs"): Promise<string | undefined> {
  const cli = join(repoRoot, cliRelativePath);
  let built: number;
  try {
    built = (await stat(cli)).mtimeMs;
  } catch {
    return `${cliRelativePath} does not exist; run \`pnpm build\` first (the suite never builds)`;
  }
  let newest = { mtimeMs: 0, path: "" };
  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (/\.(?:ts|mjs)$/.test(entry.name)) {
        const mtimeMs = (await stat(full)).mtimeMs;
        if (mtimeMs > newest.mtimeMs) newest = { mtimeMs, path: full };
      }
    }
  };
  for (const dir of ["cli", "src"]) await visit(join(repoRoot, dir));
  return newest.mtimeMs > built ? `${cliRelativePath} is older than ${relative(repoRoot, newest.path)}; run \`pnpm build\` (the suite never builds)` : undefined;
}

/** Runs both offline preflights and throws a SuiteRefusal on the first failure. */
export async function assertOfflinePreflights(repoRoot: string, version: string = process.version): Promise<void> {
  const node = nodeVersionRefusal(version, await enginesNodeRequirement(repoRoot));
  if (node !== undefined) throw new SuiteRefusal(node);
  const stale = await staleBuildRefusal(repoRoot);
  if (stale !== undefined) throw new SuiteRefusal(stale);
}

/** The read-only surface the node probe and key adoption need. */
export interface PreflightClient {
  version(): Promise<unknown>;
  keyList(): Promise<{ name: string; id: string }[]>;
  keyGen(name: string): Promise<unknown>;
}

export const PROBE_TIMEOUT_MS = 10_000;

async function bounded<T>(call: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The bounded read-only probe: `version` and `key/list` against the upstream. Any failure or timeout throws a
 * SuiteRefusal naming the node address and the error — the suite fails loudly and never skips (design decision 5).
 */
export async function probeNode(client: PreflightClient, nodeAddress: string, options: { timeoutMs?: number } = {}): Promise<{ version: unknown; keys: { name: string; id: string }[] }> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  try {
    const version = await bounded(client.version(), timeoutMs);
    const keys = await bounded(client.keyList(), timeoutMs);
    return { version, keys };
  } catch (error) {
    throw new SuiteRefusal(`node probe failed against ${nodeAddress}: ${error instanceof Error ? error.message : String(error)}. The suite fails instead of skipping: fix the node or the address and re-run.`);
  }
}

export interface KeyAdoption {
  readonly created: boolean;
  readonly keyId: string;
}

/**
 * Key adoption (design decision 2): key/gen of SUITE_KEY only when absent, and the fresh ID is recorded in the
 * per-machine owned-keys config. When the key is already present, its ID must already be in that config or the suite
 * refuses — it is never adopted silently (the 07a assertKeyAdoptable rule, re-bound to SUITE_KEY).
 */
export async function adoptSuiteKey(client: PreflightClient, ownedKeysConfigFile: string): Promise<KeyAdoption> {
  const tools = await loadTools07a();
  await tools.ensureConfig(ownedKeysConfigFile);
  const existing = (await client.keyList()).find((key) => key.name === SUITE_KEY);
  if (existing !== undefined) {
    const owned = await tools.readOwnedKeys(ownedKeysConfigFile);
    if (!owned.includes(existing.id)) {
      throw new SuiteRefusal(`key "${SUITE_KEY}" already exists on the node (ID ${existing.id}) but is not recorded in ${ownedKeysConfigFile}. If it is yours, record that ID in ownedKeys there. It is never adopted silently.`);
    }
    return { created: false, keyId: existing.id };
  }
  await client.keyGen(SUITE_KEY);
  const created = (await client.keyList()).find((key) => key.name === SUITE_KEY);
  if (created === undefined) throw new SuiteRefusal(`key/gen ${SUITE_KEY} returned but the key is absent from key/list`);
  const owned = await tools.readOwnedKeys(ownedKeysConfigFile);
  await writeFile(ownedKeysConfigFile, `${JSON.stringify({ ownedKeys: [...owned, created.id] }, null, 2)}\n`);
  return { created: true, keyId: created.id };
}
