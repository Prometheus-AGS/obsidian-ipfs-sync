// The two phases of task 4.6 that need nothing from the Obsidian or CLI phases: install and hash the build, and audit what the run changed.
import { BASE, DEMO_PARENT, KEY, STAGING_ROOT, VAULT_NAMES } from "./constants.mjs";
import { installPlugin } from "./install.mjs";
import { diffMaps, nodeSnapshot } from "./node-view.mjs";
import { mutationLogProblems } from "./policy.mjs";

/** installed-files-hashed: the build installed into two throwaway vaults equals the bytes the build state (B) vouches for. */
export async function harnessInstallPhase(S) {
  const result = installPlugin({ distDir: S.distDir, vaultsRoot: S.vaultsRoot, names: VAULT_NAMES, expected: S.guardState?.files, tamperExpect: S.opts.tamperExpect });
  S.installed = result.installed;
  const hashes = result.installed.vaults.map((vault) => `${vault.name}: ${Object.entries(vault.files).map(([file, hash]) => `${file} ${hash.slice(0, 12)}`).join(", ")}`);
  const detail = result.ok ? `${hashes.join("; ")}; cli ${result.installed.cli.slice(0, 12)}${S.guardState === undefined ? " (no build state: compared with the source files)" : " (equal to the build state B)"}` : result.problems.join("; ");
  return [{ id: "installed-files-hashed", passed: result.ok, detail }];
}

/** only-demo-root-and-owned-key-changed: the node comparison and the proxy's own log, judged against explicit expectations. */
export async function harnessAuditPhase(S) {
  const after = await nodeSnapshot(S.client);
  const demoName = DEMO_PARENT.slice(BASE.length + 1);
  const baseChanges = diffMaps(S.before.base, after.base);
  const parentChanges = diffMaps(S.before.demoParent, after.demoParent);
  const keyChanges = diffMaps(S.before.keys, after.keys);
  const log = S.proxy.log;
  const problems = [];
  if (!baseChanges.every((name) => name === demoName)) problems.push(`changed under ${BASE}: ${baseChanges.join(", ")}`);
  if (!parentChanges.every((name) => name === S.runId && !S.before.demoParent.has(name))) problems.push(`changed under ${DEMO_PARENT}: ${parentChanges.join(", ")}`);
  if (!keyChanges.every((name) => name === KEY && !S.before.keys.has(name))) problems.push(`keys changed: ${keyChanges.join(", ")}`);
  if (S.proxy.violations.length > 0) problems.push(`${S.proxy.violations.length} request(s) left the allowlist: ${S.proxy.violations.slice(0, 3).map((entry) => `${entry.command}: ${entry.reason}`).join("; ")}`);
  problems.push(...mutationLogProblems(log, S.demoRoot));
  if (log.some((entry) => entry.command === "name/publish" && entry.key !== KEY)) problems.push(`a name/publish used a key other than ${KEY}`);
  if (log.some((entry) => `${entry.arg ?? ""}`.includes(STAGING_ROOT))) problems.push(`a request named ${STAGING_ROOT}`);
  const mutations = log.filter((entry) => entry.allowed && entry.mutating).length;
  const detail = problems.length === 0 ? `${log.length} proxied request(s), ${mutations} mutating, all inside ${S.demoRoot} or for ${KEY}; node changes: ${[...baseChanges, ...parentChanges, ...keyChanges].join(", ") || "none"}` : problems.slice(0, 4).join("; ");
  return [{ id: "only-demo-root-and-owned-key-changed", passed: problems.length === 0, detail }];
}
