// Install dist/plugin/* into the throwaway vaults and hash what was installed (assertion installed-files-hashed).
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_BUNDLE, PLUGIN_FILES } from "./constants.mjs";
import { assertThrowawayPath } from "./policy.mjs";

const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readOrUndefined = (path) => {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
};
/** Same-length, different hash: the wrong value --tamper-expect expects. */
const flipHash = (hash) => `${hash[0] === "0" ? "1" : "0"}${hash.slice(1)}`;
const FALLBACK_PLUGIN_ID = "ipfs-sync";

function pluginId(manifestBytes) {
  try {
    const id = JSON.parse(manifestBytes.toString("utf8")).id;
    return typeof id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : FALLBACK_PLUGIN_ID;
  } catch {
    return FALLBACK_PLUGIN_ID;
  }
}

/**
 * Copies `<distDir>/plugin/*` into `<vaultsRoot>/<name>/.obsidian/plugins/<manifest id>/` for each name, then hashes the files as they
 * lie in each vault and the CLI bundle `<distDir>/cli/ipfs-sync.mjs`. `expected` maps `dist/...` paths to the sha256 the build state vouches
 * for (B); without it the source files' own hashes are expected. `tamperExpect` flips the expected CLI hash. A missing required output
 * is a problem, never an exception. Returns { ok, problems, installed: { cli, vaults: [{ name, files }] } }.
 */
export function installPlugin({ distDir, vaultsRoot, names, expected, tamperExpect = false }) {
  assertThrowawayPath(vaultsRoot, "vaults directory");
  const problems = [];
  const sources = PLUGIN_FILES.map((file) => ({ ...file, path: `dist/plugin/${file.name}`, bytes: readOrUndefined(join(distDir, "plugin", file.name)) }));
  for (const source of sources) if (source.bytes === undefined && source.required) problems.push(`${source.path} is missing from ${distDir}`);
  const cliBytes = readOrUndefined(join(distDir, "cli", "ipfs-sync.mjs"));
  if (cliBytes === undefined) problems.push(`${CLI_BUNDLE} is missing from ${distDir}`);
  const want = new Map();
  for (const source of sources) if (source.bytes !== undefined || expected?.[source.path] !== undefined) want.set(source.path, expected?.[source.path] ?? hashBytes(source.bytes));
  const wantCli = expected?.[CLI_BUNDLE] ?? (cliBytes === undefined ? undefined : hashBytes(cliBytes));
  const id = pluginId(sources.find((source) => source.name === "manifest.json")?.bytes ?? Buffer.alloc(0));
  const vaults = names.map((name) => {
    const target = join(vaultsRoot, name, ".obsidian", "plugins", id);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const files = {};
    for (const source of sources) {
      if (source.bytes === undefined) continue;
      writeFileSync(join(target, source.name), source.bytes, { mode: 0o644 });
      chmodSync(join(target, source.name), 0o644);
      files[source.name] = hashBytes(readFileSync(join(target, source.name)));
    }
    return { name, files };
  });
  for (const vault of vaults) {
    for (const source of sources) {
      const wanted = want.get(source.path);
      const actual = vault.files[source.name];
      if (wanted !== undefined && actual === undefined) problems.push(`${vault.name}/${source.name} was not installed; the build state has ${source.path}`);
      else if (wanted !== undefined && actual !== wanted) problems.push(`${vault.name}/${source.name} has sha256 ${actual}, expected ${wanted} for ${source.path}`);
      else if (wanted === undefined && actual !== undefined) problems.push(`${vault.name}/${source.name} was installed, but the build state has no ${source.path}`);
    }
  }
  const cli = cliBytes === undefined ? "absent" : hashBytes(cliBytes);
  const wantedCli = wantCli === undefined ? undefined : tamperExpect ? flipHash(wantCli) : wantCli;
  if (wantedCli !== undefined && cli !== wantedCli) problems.push(`${CLI_BUNDLE} has sha256 ${cli}, expected ${wantedCli}`);
  return { ok: problems.length === 0, problems, installed: { cli, vaults } };
}
