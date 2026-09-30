// `record`: writes the LOCAL release record. It edits manifest.json and package.json (version bump), runs the
// project build, and writes files under the output directory. It never runs git or gh and never writes a
// publication receipt.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assemble } from "./assemble.mjs";
import { bumpManifestText, bumpPackageText } from "./bump.mjs";
import { DEFAULT_OUT, MIN_APP_VERSION, REPO, TAG, VERSION } from "./constants.mjs";
import { gatherFacts, sha256 } from "./facts.mjs";
import { blockers } from "./plan.mjs";

class Refusal extends Error {}

const parseEvidence = (spec, root) => {
  const at = spec.indexOf("=");
  const path = resolve(root, at === -1 ? spec : spec.slice(0, at));
  return { path, observed: at === -1 ? null : spec.slice(at + 1) };
};

function checkPreconditions(facts, evidence, outDir, noBuild) {
  const problems = blockers(facts).filter((item) => !item.startsWith("CHANGELOG.md") && !item.startsWith("README.md"));
  for (const item of evidence) if (!existsSync(item.path)) problems.push(`Evidence path does not exist: ${item.path}`);
  if (existsSync(outDir) && readdirSync(outDir).length > 0) problems.push(`Output directory is not empty: ${outDir}`);
  if (!facts.rootManifest.ok || !facts.pkg.ok) problems.push("manifest.json or package.json is missing or unreadable.");
  if (noBuild && (facts.versions.dist !== VERSION || facts.minAppVersion.dist !== MIN_APP_VERSION)) {
    problems.push(`--no-build given but dist/plugin/manifest.json reads ${facts.versions.dist} / ${facts.minAppVersion.dist}, not ${VERSION} / ${MIN_APP_VERSION}.`);
  }
  if (problems.length) throw new Refusal(problems.map((item) => `- ${item}`).join("\n"));
}

function applyBump(root) {
  for (const [file, bump] of [["manifest.json", bumpManifestText], ["package.json", bumpPackageText]]) {
    const path = join(root, file);
    writeFileSync(path, bump(readFileSync(path, "utf8")));
  }
}

function runBuild(root, out) {
  out(`running: pnpm build (cwd ${root})`);
  const result = spawnSync("pnpm", ["build"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  out(`${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd());
  if (result.status !== 0) throw new Error(`pnpm build exited with ${result.status ?? result.error?.message}`);
}

function claimsFor({ facts, evidence, files }) {
  const demo = evidence.length > 0;
  return [
    { claim: "Version fields read 0.2.0 and minAppVersion 1.12.3", evidence: ["manifest.json", "package.json"], status: "evidenced" },
    { claim: "Artifacts are byte-identical to dist/plugin/", evidence: ["SHA256SUMS"], status: "evidenced" },
    { claim: "Feature operation passed", evidence: [facts.featureOp.path], status: facts.featureOp.verdict === "passing" ? "evidenced" : "unverified" },
    { claim: "Pull-with-conflict demonstrated in Obsidian desktop on macOS", evidence: evidence.map((e) => e.path), status: demo ? "evidenced" : "unverified" },
    { claim: "Mobile works", evidence: [], status: "unverified" },
    { claim: `Release is published (${files.length} assets)`, evidence: [], status: "unverified" },
  ];
}

export function runRecord({ root, outRel = DEFAULT_OUT, featureOpPath, evidenceSpecs = [], noBuild = false, out }) {
  const outDir = resolve(root, outRel);
  const evidence = evidenceSpecs.map((spec) => parseEvidence(spec, root));
  const before = gatherFacts(root, { featureOpPath });
  checkPreconditions(before, evidence, outDir, noBuild);

  applyBump(root);
  out(`bumped manifest.json to ${VERSION} (minAppVersion ${MIN_APP_VERSION}) and package.json to ${VERSION}`);
  if (!noBuild) runBuild(root, out);

  const facts = gatherFacts(root, { featureOpPath });
  if (facts.versions.dist !== VERSION || facts.minAppVersion.dist !== MIN_APP_VERSION) {
    throw new Error(`after the build dist/plugin/manifest.json reads ${facts.versions.dist} / ${facts.minAppVersion.dist}; root files were already bumped`);
  }
  const built = assemble(facts, { evidenceSupplied: evidence.length > 0 });
  mkdirSync(outDir, { recursive: true });
  for (const file of built.files) {
    if (file.bytes) writeFileSync(join(outDir, file.name), file.bytes);
    else copyFileSync(join(root, "dist", "plugin", file.name), join(outDir, file.name));
  }
  const sums = [...built.files].sort((a, b) => a.name.localeCompare(b.name)).map((f) => `${f.sha256}  ${f.name}\n`).join("");
  writeFileSync(join(outDir, "SHA256SUMS"), sums);
  writeFileSync(join(outDir, "release-notes.md"), built.notes);

  const evidenceDoc = {
    schemaVersion: 1, version: VERSION, tag: TAG, repository: REPO, createdAt: new Date().toISOString(),
    source: { branch: facts.git.branch, commit: facts.git.commit, workingTreeInspected: false },
    artifacts: built.files.map(({ name, size, sha256: sum }) => ({ name, size, sha256: sum })),
    cliTarballContents: built.tarball?.contents ?? [],
    featureOperation: { path: facts.featureOp.path, verdict: facts.featureOp.verdict, sha256: facts.featureOp.sha256 ?? null },
    evidence: evidence.map((item) => ({ path: item.path, exists: existsSync(item.path), sha256: sha256(readFileSync(item.path)), observed: item.observed ?? "not stated by the operator" })),
    claims: claimsFor({ facts, evidence, files: built.files }),
    unverified: built.unverified,
    publication: { status: "pending", receipt: null, reason: "Local record only. No tag, push or release was made by this tool. The cadence publication receipt requires public HTTPS URLs and an advertising page and was not produced." },
  };
  writeFileSync(join(outDir, "evidence.json"), `${JSON.stringify(evidenceDoc, null, 2)}\n`);

  return verifyRecord({ root, outDir, out });
}

// Recomputes every checksum from disk and compares copies with dist/plugin/ byte for byte.
export function verifyRecord({ root, outDir, out }) {
  const listed = readFileSync(join(outDir, "SHA256SUMS"), "utf8").trim().split("\n").map((line) => line.split("  "));
  let bad = 0;
  for (const [sum, name] of listed) {
    const actual = sha256(readFileSync(join(outDir, name)));
    const distCopy = ["main.js", "manifest.json", "styles.css"].includes(name) && existsSync(join(root, "dist", "plugin", name));
    const same = !distCopy || readFileSync(join(outDir, name)).equals(readFileSync(join(root, "dist", "plugin", name)));
    const ok = actual === sum && same;
    if (!ok) bad += 1;
    out(`${ok ? "ok    " : "FAIL  "}${sum}  ${basename(name)}${distCopy ? (same ? "  (identical to dist/plugin)" : "  (DIFFERS from dist/plugin)") : ""}`);
  }
  out(bad === 0 ? `record written to ${outDir}; local only, not published; publication receipt not produced` : `${bad} checksum verification(s) failed`);
  return bad === 0 ? 0 : 1;
}

export { Refusal };
