// Constants of the mvp-07b operator-run harness. What the checker owns (record names, freshness bound, REQUIRED_ASSERTIONS, the
// per-user directory rule) is imported from it, never declared here; what 07a owns and does not depend on its demo parent is re-used.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURE_OPS_DIRECTORY, OPERATOR_RECORD_FILE, OPERATOR_RECORD_MAX_AGE_MS, OPERATOR_TRANSCRIPT_FILE, REQUIRED_ASSERTIONS, perUserStateDir } from "../check-guard-preconditions.mjs";
import { ALLOWED_HOSTS, BASE, CONFIG_FILE, DEAD_UPSTREAM, EXIT_FAILED, EXIT_OK, EXIT_REFUSED, KEY, REPO, REPO_REAL, RUN_ID_PATTERN, Refusal, SIGNAL_EXIT_CODES, SIGNAL_POST_RUN_TIMEOUT_MS, STAGING_ROOT } from "../feature-op-mvp-07a/constants.mjs";

export { ALLOWED_HOSTS, BASE, CONFIG_FILE, DEAD_UPSTREAM, EXIT_FAILED, EXIT_OK, EXIT_REFUSED, FEATURE_OPS_DIRECTORY, KEY, OPERATOR_RECORD_FILE, OPERATOR_RECORD_MAX_AGE_MS, OPERATOR_TRANSCRIPT_FILE, REPO, REPO_REAL, REQUIRED_ASSERTIONS, RUN_ID_PATTERN, Refusal, SIGNAL_EXIT_CODES, SIGNAL_POST_RUN_TIMEOUT_MS, STAGING_ROOT, perUserStateDir };

/** The per-run demo root is below this folder (07a used mvp07a-demo). */
export const DEMO_PARENT = `${BASE}/mvp07b-demo`;
/** One run at a time: the owned key and the shared config are single-writer. Not 07a's lock. */
export const LOCK_FILE = join(tmpdir(), "ipfs-sync-feature-op-mvp07b.lock");
export const PHASE_MODES = Object.freeze(["all", "script-only"]);
/** The two throwaway vaults of design 11. */
export const VAULT_NAMES = Object.freeze(["v1", "v2"]);
/** The plugin files the build makes (dist/plugin/) and the CLI bundle; styles.css exists only when the build makes one. */
export const PLUGIN_FILES = Object.freeze([
  Object.freeze({ name: "main.js", required: true }),
  Object.freeze({ name: "manifest.json", required: true }),
  Object.freeze({ name: "styles.css", required: false }),
]);
export const CLI_BUNDLE = "dist/cli/ipfs-sync.mjs";
export const RECORD_SCHEMA = 1;
