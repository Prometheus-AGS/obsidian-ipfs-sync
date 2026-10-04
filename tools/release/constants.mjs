// Values shared by every release. Values that differ per release (version, tag, tarball, output directory, the
// fixture-only texts, edit and build behaviour) live in a descriptor: see descriptors.mjs.
export const MIN_APP_VERSION = "1.12.3"; // lead decision 2026-09-30: appendBinary needs Obsidian 1.12.3
export const REPO = "Prometheus-AGS/obsidian-ipfs-sync";
export const CLI_TARBALL_FILES = [{ from: "dist/cli/ipfs-sync.mjs", as: "package/dist/cli/ipfs-sync.mjs", mode: 0o755 }];
export const PLUGIN_ARTIFACTS = ["main.js", "manifest.json", "styles.css"]; // styles.css only when the build makes one
export const RELEASE_DIR = "dist/release";
export const RECEIPT_TOOL = ".claude/skills/delivery-cadence/scripts/publication-receipt.mjs";
