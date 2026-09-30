// Fixed release parameters for Release 1. Changing any of these is a release decision, not a tool option.
export const VERSION = "0.2.0";
export const TAG = `v${VERSION}`;
export const MIN_APP_VERSION = "1.12.3"; // lead decision 2026-09-30: appendBinary needs Obsidian 1.12.3
export const REPO = "Prometheus-AGS/obsidian-ipfs-sync";
export const CLI_TARBALL = `ipfs-sync-cli-${VERSION}.tgz`;
export const CLI_TARBALL_FILES = [{ from: "dist/cli/ipfs-sync.mjs", as: "package/dist/cli/ipfs-sync.mjs", mode: 0o755 }];
export const PLUGIN_ARTIFACTS = ["main.js", "manifest.json", "styles.css"]; // styles.css only when the build makes one
export const FEATURE_OP_FILE = "feature-op-mvp-05.json";
export const DEFAULT_OUT = `dist/release/${TAG}`;
export const ENCRYPTION_PLAN_PATH = "openspec/changes/mvp-06-encrypted-vault-publish";
export const RECEIPT_TOOL = ".claude/skills/delivery-cadence/scripts/publication-receipt.mjs";
export const LIMITATIONS = [
  "Symbolic links are not detected by the plugin.",
  "A per-file read cap applies (default 64 MB, configurable 8 to 1024 MB).",
  "Remote deletions are not applied on pull.",
  "Mobile is not verified.",
];
