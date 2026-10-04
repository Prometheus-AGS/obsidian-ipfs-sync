// Computes what a release would contain from the current files, without writing anything.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bumpManifestText } from "./bump.mjs";
import { sha256 } from "./facts.mjs";
import { buildTarball } from "./tar.mjs";

// Returns the ordered artifact list. `manifest.json` is the bytes the build would copy after the version bump, or
// the root file's own bytes when the descriptor does not bump.
export function assemble(facts, { descriptor, evidenceSupplied = false }) {
  const files = [];
  const present = new Map(facts.artifacts.filter((a) => a.present).map((a) => [a.name, a]));
  const main = present.get("main.js");
  if (main) files.push({ name: "main.js", size: main.size, sha256: main.sha256, source: "dist/plugin/main.js (current bytes)" });
  if (facts.rootManifest.ok) {
    const rootText = readFileSync(join(facts.root, "manifest.json"), "utf8");
    const bumps = descriptor.record.bumpVersions;
    const bytes = Buffer.from(bumps ? bumpManifestText(rootText, descriptor) : rootText);
    files.push({
      name: "manifest.json",
      size: bytes.length,
      sha256: sha256(bytes),
      source: bumps ? "root manifest.json with the bump applied (the build copies it unchanged)" : "root manifest.json (this release does not edit it)",
      bytes,
    });
  }
  const styles = present.get("styles.css");
  if (styles) files.push({ name: "styles.css", size: styles.size, sha256: styles.sha256, source: "dist/plugin/styles.css" });
  let tarball = null;
  if (facts.cli) {
    const bytes = buildTarball(descriptor.cliTarballFiles.map((entry) => ({ ...entry, from: join(facts.root, entry.from) })));
    tarball = { name: descriptor.cliTarball, size: bytes.length, sha256: sha256(bytes), bytes, contents: descriptor.cliTarballFiles.map((e) => e.as) };
    files.push({ name: descriptor.cliTarball, size: bytes.length, sha256: sha256(bytes), source: `deterministic ustar+gzip of ${descriptor.cliTarballFiles.map((e) => e.from).join(", ")}`, bytes });
  }
  const unverified = descriptor.unverifiedClaims(facts, { evidenceSupplied });
  const notes = descriptor.buildNotes({ descriptor, sums: files, unverified });
  return { files, tarball, unverified, notes };
}
