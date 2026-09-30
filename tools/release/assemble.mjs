// Computes what a release would contain from the current files, without writing anything.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bumpManifestText } from "./bump.mjs";
import { CLI_TARBALL, CLI_TARBALL_FILES } from "./constants.mjs";
import { sha256 } from "./facts.mjs";
import { buildReleaseNotes } from "./notes.mjs";
import { buildTarball } from "./tar.mjs";

export function unverifiedClaims(facts, { evidenceSupplied }) {
  const items = [
    "Mobile (iOS and Android) has not been run.",
    "An authenticated kubo endpoint has not been exercised.",
    "Symlink and rename behaviour on Windows and Linux.",
    "The crash window of remove-then-rename.",
    "Large-file behaviour above the tested sizes; the 64 MB default cap is unproven.",
  ];
  if (!evidenceSupplied) items.unshift("The pull-with-conflict demonstration inside Obsidian desktop: no screenshot, recording or notes file was supplied.");
  if (facts.featureOp.verdict !== "passing") items.unshift("The feature operation has not passed.");
  return items;
}

// Returns the ordered artifact list. `manifest.json` is the bytes the build would copy after the version bump.
export function assemble(facts, { evidenceSupplied = false } = {}) {
  const files = [];
  const present = new Map(facts.artifacts.filter((a) => a.present).map((a) => [a.name, a]));
  const main = present.get("main.js");
  if (main) files.push({ name: "main.js", size: main.size, sha256: main.sha256, source: "dist/plugin/main.js (current bytes)" });
  if (facts.rootManifest.ok) {
    const bumped = Buffer.from(bumpManifestText(readFileSync(join(facts.root, "manifest.json"), "utf8")));
    files.push({ name: "manifest.json", size: bumped.length, sha256: sha256(bumped), source: "root manifest.json with the bump applied (the build copies it unchanged)", bytes: bumped });
  }
  const styles = present.get("styles.css");
  if (styles) files.push({ name: "styles.css", size: styles.size, sha256: styles.sha256, source: "dist/plugin/styles.css" });
  let tarball = null;
  if (facts.cli) {
    const bytes = buildTarball(CLI_TARBALL_FILES.map((entry) => ({ ...entry, from: join(facts.root, entry.from) })));
    tarball = { name: CLI_TARBALL, size: bytes.length, sha256: sha256(bytes), bytes, contents: CLI_TARBALL_FILES.map((e) => e.as) };
    files.push({ name: CLI_TARBALL, size: bytes.length, sha256: sha256(bytes), source: `deterministic ustar+gzip of ${CLI_TARBALL_FILES.map((e) => e.from).join(", ")}`, bytes });
  }
  const unverified = unverifiedClaims(facts, { evidenceSupplied });
  const notes = buildReleaseNotes({ sums: files, unverified });
  return { files, tarball, unverified, notes };
}
