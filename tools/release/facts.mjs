// Read-only fact gathering. Nothing here spawns a process or writes a file; git state is read from .git files.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);

export function readJson(path) {
  const text = readText(path);
  if (text === null) return { ok: false, reason: "missing" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, reason: `unparseable (${error.message})` };
  }
}

const versionOf = (json) => (json.ok && typeof json.value.version === "string" ? json.value.version : null);

function gitFacts(root) {
  const gitDir = join(root, ".git");
  const head = readText(join(gitDir, "HEAD"))?.trim() ?? null;
  const branch = head?.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
  let commit = head && !branch ? head : null;
  if (branch) {
    commit = readText(join(gitDir, "refs", "heads", branch))?.trim() ?? null;
    if (!commit) {
      const packed = readText(join(gitDir, "packed-refs")) ?? "";
      commit = packed.split("\n").find((line) => line.endsWith(` refs/heads/${branch}`))?.split(" ")[0] ?? null;
    }
  }
  const config = readText(join(gitDir, "config")) ?? "";
  const remoteUrl = config.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1] ?? null;
  const packedRefs = readText(join(gitDir, "packed-refs")) ?? "";
  return { present: existsSync(gitDir), branch, commit, remoteUrl, packedRefs };
}

function artifactFacts(root, name) {
  const path = join(root, "dist", "plugin", name);
  if (!existsSync(path)) return { name, present: false };
  const bytes = readFileSync(path);
  return { name, present: true, path, size: bytes.length, sha256: sha256(bytes), mtimeMs: statSync(path).mtimeMs };
}

export function gatherFacts(root, { featureOpPath, descriptor }) {
  const rootManifest = readJson(join(root, "manifest.json"));
  const distManifest = readJson(join(root, "dist", "plugin", "manifest.json"));
  const pkg = readJson(join(root, "package.json"));
  const git = gitFacts(root);
  const cliPath = join(root, "dist", "cli", "ipfs-sync.mjs");
  const cliBytes = existsSync(cliPath) ? readFileSync(cliPath) : null;
  const featureOp = featureOpPath ?? join(root, descriptor.featureOpFile);
  const readme = readText(join(root, "README.md"));
  const changelog = readText(join(root, "CHANGELOG.md"));
  return {
    root,
    rootManifest,
    distManifest,
    pkg,
    versions: { manifest: versionOf(rootManifest), package: versionOf(pkg), dist: versionOf(distManifest) },
    minAppVersion: {
      root: rootManifest.ok ? rootManifest.value.minAppVersion ?? null : null,
      dist: distManifest.ok ? distManifest.value.minAppVersion ?? null : null,
    },
    artifacts: descriptor.pluginArtifacts.map((name) => artifactFacts(root, name)),
    cli: cliBytes ? { path: cliPath, size: cliBytes.length, sha256: sha256(cliBytes), text: cliBytes.toString("utf8") } : null,
    git,
    tagExists: (tag) => existsSync(join(root, ".git", "refs", "tags", tag)) || git.packedRefs.includes(`refs/tags/${tag}`),
    license: ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"].some((name) => existsSync(join(root, name))),
    packageLicenseField: pkg.ok ? pkg.value.license ?? null : null,
    featureOp: { path: featureOp, ...readFeatureOp(featureOp) },
    readmeMentionsFixture: readme === null ? null : /fixture/i.test(readme),
    changelogPresent: changelog !== null,
    changelogMentionsFixture: changelog === null ? null : /fixture/i.test(changelog),
  };
}

// The feature-op output format is owned by tools/feature-op-mvp-05.mjs. Only unambiguous verdicts count as a pass.
export function readFeatureOp(path) {
  const json = readJson(path);
  if (!json.ok) return { verdict: "missing-or-unreadable", detail: json.reason };
  const doc = json.value;
  const flags = [doc.passed, doc.ok, doc.pass].filter((v) => typeof v === "boolean");
  const status = typeof doc.status === "string" ? doc.status.toLowerCase() : null;
  const failed = Array.isArray(doc.assertions) ? doc.assertions.filter((a) => a && (a.passed === false || a.status === "fail" || a.status === "failed")) : [];
  if (flags.includes(false) || ["fail", "failed"].includes(status) || failed.length > 0) return { verdict: "failing", detail: `${failed.length} failed assertion(s)` };
  if (flags.includes(true) || ["pass", "passed", "ok"].includes(status)) return { verdict: "passing", detail: "explicit pass verdict", sha256: sha256(readFileSync(path)) };
  return { verdict: "indeterminate", detail: "no boolean passed/ok/pass field and no status pass/passed/ok" };
}
