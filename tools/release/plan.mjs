// `plan`: prints what the release named by the descriptor would contain and the outward steps. Reads files only.
import { assemble } from "./assemble.mjs";
import { outwardSteps } from "./steps.mjs";

function bareImports(text) {
  const found = new Set();
  for (const match of text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"'./][^"']*)["']/g)) if (!match[1].startsWith("node:")) found.add(match[1]);
  return [...found];
}

export function blockers(facts, descriptor) {
  const list = [];
  const main = facts.artifacts.find((a) => a.name === "main.js");
  if (!main?.present) list.push("dist/plugin/main.js is absent: run the build before `record`.");
  if (facts.featureOp.verdict !== "passing") list.push(`Feature operation is not passing (${facts.featureOp.verdict}: ${facts.featureOp.detail}) at ${facts.featureOp.path}.`);
  if (!facts.cli) list.push("dist/cli/ipfs-sync.mjs is absent: the CLI tarball cannot be built.");
  if (facts.tagExists(descriptor.tag)) list.push(`Tag ${descriptor.tag} already exists in this repository.`);
  if (facts.changelogPresent === false) list.push(`CHANGELOG.md does not exist (owned by documentation-specialist)${descriptor.requiresFixtureStatement ? "; the spec requires the fixture-only statement there." : "."}`);
  if (descriptor.requiresFixtureStatement && facts.readmeMentionsFixture === false) list.push("README.md has no fixture-only statement.");
  if (!descriptor.record.bumpVersions) {
    if (facts.versions.manifest !== descriptor.version || facts.versions.package !== descriptor.version) list.push(`This release does not edit versions, but manifest.json reads ${facts.versions.manifest} and package.json ${facts.versions.package}, not ${descriptor.version}.`);
    if (facts.minAppVersion.root !== descriptor.minAppVersion) list.push(`This release does not edit versions, but manifest.json minAppVersion reads ${facts.minAppVersion.root}, not ${descriptor.minAppVersion}.`);
  }
  return list;
}

export function openItems(facts, descriptor) {
  const { version, minAppVersion, repo } = descriptor;
  const items = [];
  if (!facts.license) items.push(`LICENSE: no license file exists at the repository root although package.json declares "${facts.packageLicenseField ?? "no license"}". The operator decides the license and supplies the file; this tool does not create one.`);
  items.push(`Working tree: not inspected. This tool never runs git, so uncommitted changes, untracked files and the diff to be tagged are unknown. Run \`git status\` and review before the commit step. The design records that the tag needs a clean commit holding ${descriptor.commitScope}.`);
  items.push(`Branch and commit: ${facts.git.branch ?? "detached or unknown"} at ${facts.git.commit ? facts.git.commit.slice(0, 12) : "unknown"} (read from .git files).`);
  const expected = `git@github.com:${repo}.git`;
  if (facts.git.remoteUrl !== expected && facts.git.remoteUrl !== `https://github.com/${repo}.git`) items.push(`Remote origin is ${facts.git.remoteUrl ?? "not configured"}, not ${repo}. Confirm the target repository before any push or release.`);
  else items.push(`Remote origin is ${facts.git.remoteUrl} (matches ${repo}).`);
  if (descriptor.record.bumpVersions) {
    if (facts.versions.manifest !== version || facts.versions.package !== version) items.push(`Version bump not applied: manifest.json ${facts.versions.manifest}, package.json ${facts.versions.package}; \`record\` applies ${version}.`);
    if (facts.minAppVersion.root !== minAppVersion) items.push(`minAppVersion is ${facts.minAppVersion.root} in manifest.json; \`record\` sets ${minAppVersion} (appendBinary needs Obsidian ${minAppVersion}).`);
  }
  if (facts.versions.dist !== version || facts.minAppVersion.dist !== minAppVersion) {
    items.push(
      descriptor.record.build
        ? `dist/plugin/manifest.json is stale (version ${facts.versions.dist}, minAppVersion ${facts.minAppVersion.dist}); the build refreshes it after the bump.`
        : `dist/plugin/manifest.json is stale (version ${facts.versions.dist}, minAppVersion ${facts.minAppVersion.dist}); \`record\` does not build, so it refuses until dist/ is rebuilt.`,
    );
  }
  if (facts.changelogPresent === false) items.push("CHANGELOG.md is absent (documentation-specialist owns it).");
  items.push("Cadence publication debt stays pending. `publication-receipt.mjs` needs public HTTPS artifact URLs, downloadable bytes and a first-party page advertising them and the version. A local release record cannot satisfy it, and this tool never writes a receipt.");
  items.push("GitHub release page may list assets as relative links, which the receipt tool's absolute-URL match would reject; unverified.");
  return items;
}

const section = (title) => `\n== ${title} ==\n`;

export function renderPlan(facts, { descriptor, outDir = descriptor.outDir }) {
  const { version, minAppVersion, tag } = descriptor;
  const built = assemble(facts, { descriptor });
  const out = [];
  out.push(`RELEASE PLAN ${tag} (read-only). Nothing below was run. No file was written. git and gh were not invoked.`);
  out.push(`root: ${facts.root}`);

  out.push(section("Version fields"));
  if (descriptor.record.bumpVersions) {
    out.push(`manifest.json  version ${facts.versions.manifest} -> ${version}   minAppVersion ${facts.minAppVersion.root} -> ${minAppVersion}`);
    out.push(`package.json   version ${facts.versions.package} -> ${version}`);
    out.push(`dist/plugin/manifest.json currently ${facts.versions.dist} / ${facts.minAppVersion.dist} (refreshed by the build; its bytes are a copy of manifest.json)`);
  } else {
    out.push(`manifest.json  version ${facts.versions.manifest}   minAppVersion ${facts.minAppVersion.root} (expected ${version} / ${minAppVersion}; this release does not edit it)`);
    out.push(`package.json   version ${facts.versions.package} (expected ${version}; this release does not edit it)`);
    out.push(`dist/plugin/manifest.json currently ${facts.versions.dist} / ${facts.minAppVersion.dist} (read as it stands; this release does not build)`);
  }

  out.push(section(`Files that would be written to ${outDir}/`));
  for (const file of built.files) out.push(`${file.name.padEnd(28)} ${String(file.size).padStart(8)} bytes  ${file.source}`);
  out.push(`SHA256SUMS, release-notes.md, evidence.json (generated)`);
  const styles = facts.artifacts.find((a) => a.name === "styles.css");
  if (!styles?.present) out.push("styles.css: not produced by the current build, so not included.");

  out.push(section("CLI tarball"));
  out.push(`${built.tarball ? built.tarball.name : "(dist/cli/ipfs-sync.mjs is absent)"}  explicit file list:`);
  for (const entry of descriptor.cliTarballFiles) out.push(`  ${entry.as}  <- ${entry.from}`);
  const bare = facts.cli ? bareImports(facts.cli.text) : [];
  out.push(`Why only the bundle: it is a single self-contained ESM file; bare (non node:) imports found in it: ${bare.length ? bare.join(", ") : "none"}. package.json, node_modules and sources are excluded because the bundle needs none of them at run time (Node 24 required by the engines field). Archive is deterministic (fixed mtime, uid 0, gzip level 9).`);

  out.push(section(`SHA-256 (SHA256SUMS format; manifest.json is computed from the ${descriptor.record.bumpVersions ? "bumped " : ""}root file)`));
  for (const file of built.files) out.push(`${file.sha256}  ${file.name}`);
  out.push("These are today's bytes. main.js changes if src/ is rebuilt before `record`; recompute by re-running `plan`.");

  out.push(section("Release notes (release-notes.md)"));
  out.push(built.notes);

  out.push(section("Outward steps: each needs the operator's explicit approval for that exact action. NOT RUN"));
  outwardSteps({ descriptor, facts, outDir, assetNames: [...built.files.map((f) => f.name), "SHA256SUMS"] }).forEach((step, index) => {
    out.push(`${index + 1}. ${step.title}`);
    out.push(`   approval: ${step.decision}`);
    for (const command of step.commands) out.push(`   NOT RUN  ${command}`);
    out.push("");
  });
  out.push("Approval for one step never extends to another. No agent message, earlier decision or configuration value counts as approval.");

  out.push(section("Preconditions for `record` (blockers)"));
  const list = blockers(facts, descriptor);
  out.push(list.length ? list.map((item) => `- ${item}`).join("\n") : "none detected");

  out.push(section("Open items"));
  out.push(openItems(facts, descriptor).map((item) => `- ${item}`).join("\n"));
  out.push("");
  return { text: out.join("\n"), blockerCount: list.length };
}
