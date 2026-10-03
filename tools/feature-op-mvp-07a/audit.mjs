// The end-of-run audits: what the run changed on the node, and the proxy's own record of every request.
import { BASE, DEMO_PARENT, KEY, STAGING_ROOT } from "./constants.mjs";
import { PULL_READ_COMMANDS, mutationLogProblems } from "./policy.mjs";
import { check, out } from "./report.mjs";
import { tamperOnce } from "./tamper.mjs";
import { diffMaps, nodeSnapshot } from "./workspace.mjs";

export async function nodeComparison(S, before) {
  out("\n-- what the run changed on the node --");
  // Tamper "base-changed": a sibling of the demo parent appears under the base (stub only; the shared node is never written by the script).
  if (S.stub !== undefined && tamperOnce(S, "base-changed")) S.stub.node.files.set(`${BASE}/planted-sibling/note`, Buffer.from("planted by --tamper base-changed"));
  const after = await nodeSnapshot(S.client);
  const baseChanges = diffMaps(before.base, after.base);
  const parentChanges = diffMaps(before.demoParent, after.demoParent);
  const keyChanges = diffMaps(before.keys, after.keys);
  const demoName = DEMO_PARENT.slice(BASE.length + 1);
  check(`only ${DEMO_PARENT} changed under ${BASE}`, baseChanges.every((name) => name === demoName), `changed: ${baseChanges.join(", ") || "none"}`);
  check(`only this run's folder ${S.runId} was added under ${DEMO_PARENT}`, parentChanges.every((name) => name === S.runId && !before.demoParent.has(name)), `changed: ${parentChanges.join(", ") || "none"}`);
  check(`no key was changed or removed; at most ${KEY} was added`, keyChanges.every((name) => name === KEY && !before.keys.has(name)), `changed: ${keyChanges.join(", ") || "none"}`);
}

export function proxyAudit(S) {
  out("\n-- proxy audit: every request the CLI sent, from the proxy's own log --");
  const log = S.proxy.log;
  const counts = new Map();
  for (const entry of log) counts.set(entry.command, (counts.get(entry.command) ?? 0) + 1);
  out(`      requests by RPC path: ${[...counts].map(([command, count]) => `${command} x${count}`).join(", ")}`);
  out(`      reads sent by the pull commands (task notes): ${[...S.pullReads].map(([command, count]) => `${command} x${count}`).join(", ") || "none"}`);
  check("proxy: no request left the allowlist (no key/rm, no pin/rm, no files/mv, no foreign key, nothing outside the demo root, no staging root)", S.proxy.violations.length === 0, S.proxy.violations.slice(0, 3).map((entry) => `${entry.command}: ${entry.reason}`).join("; "));
  // Judged again from the log, from the command names and arguments (not from the policy's own "mutating" flag), against an explicit expected set.
  const mutationProblems = mutationLogProblems(log, S.demoRoot);
  const mutations = log.filter((entry) => entry.allowed && !PULL_READ_COMMANDS.includes(entry.command));
  check(`proxy: the ${mutations.length} requests that change the node are only files/write|rm below ${S.demoRoot}, files/mkdir at or below it, key/gen or name/publish of ${KEY}, or pin/add of a CID, and no request names ${STAGING_ROOT}`, mutationProblems.length === 0, mutationProblems.slice(0, 3).join("; "));
  check(`proxy: every name/publish used the key ${KEY}`, log.filter((entry) => entry.command === "name/publish").every((entry) => entry.key === KEY));
  const leaks = log.filter((entry) => entry.needle !== undefined);
  check("proxy: no request path, query or body carried a recorded plaintext title, path, folder name or body word or the passphrase", leaks.length === 0, leaks.slice(0, 2).map((entry) => `${entry.command} ${entry.needle}`).join("; "));
}
