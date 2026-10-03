// Constants, tamper kinds, the unverified list and the refusal type of the mvp-07a feature operation.
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The repository through its symlinks: a guard that compares a real path must compare it with this too (L-08). */
export const REPO_REAL = realpathSync(REPO);
export const CLI = join(REPO, "dist", "cli", "ipfs-sync.mjs");
export const GENERATOR = join(REPO, "fixtures", "generate-fixture-vault.ts");

export const BASE = "/obsidian-vault-sync";
export const DEMO_PARENT = `${BASE}/mvp07a-demo`;
export const KEY = "obsidian-vault-sync";
export const STAGING_ROOT = "/obsidian-vault-staging";
export const RUN_ID_PATTERN = /^[a-z0-9-]{8,}$/;
/** The shared node's host. The forwarding proxy refuses any other upstream unless --local-stub. */
export const ALLOWED_HOSTS = ["ipfs.prometheusags.ai"];
/** An address nothing listens on (the discard port on loopback): the proxy self-test forwards to it, so a request that slips through cannot reach any node (L-01). */
export const DEAD_UPSTREAM = Object.freeze({ rpc: "http://127.0.0.1:9", gateway: "http://127.0.0.1:9" });
/** The only node answer recorded as "never published" (src/kubo/ipns.ts NAME_RESOLVE_ERROR_TEXTS.notFound, observed 2026-10-01). Timeout and not-found are indistinguishable on that node. */
export const NEVER_PUBLISHED_MESSAGES = Object.freeze(["could not resolve name"]);
/** Retries of the pre-run name/resolve on the shared-node path before the run refuses (M-01). */
export const PRE_RUN_RESOLVE_ATTEMPTS = 3;
export const PRE_RUN_RESOLVE_DELAY_MS = 2000;
/** The environment a child may inherit (L-02). Everything else is dropped; IPFS_SYNC_* auth variables are added back on the shared-node path only. */
export const CHILD_ENV_ALLOWLIST = Object.freeze(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]);
/** Termination signals the run cleans up after, with their conventional exit codes (128 + signal number) (L-08). */
export const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGHUP: 129, SIGTERM: 143 });
/** Upper bound on the best-effort post-run pointer record made when a signal ends the run (N-02 c); the handler exits when it passes. */
export const SIGNAL_POST_RUN_TIMEOUT_MS = 5000;
const CONFIG_DIR = join(tmpdir(), "ipfs-sync-feature-ops");
/** The same per-machine config file the mvp-06 operation uses: it records the ID of the owned key, which is the same key. */
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const DEFAULT_OUT = join(CONFIG_DIR, "feature-op-mvp-07a.json");
export const LOCK_FILE = join(tmpdir(), "ipfs-sync-feature-op-mvp07a.lock");
export const SEED = 20260930;
/** Device labels of the two simulated devices (IPFS_SYNC_DEVICE); the manifest carries "<label>-<first 12 hex of the device id>". */
export const DEVICE_A = "fop07a-a";
export const DEVICE_B = "fop07a-b";
export const WORDS = ["harbor", "lantern", "meadow", "quartz", "ember", "willow", "signal", "orbit", "cobalt", "thistle", "ripple", "anvil"];
export const NEEDLE_MIN_BYTES = 5;
export const MIN_PUBLISHED_FILES = 10;
export const CHILD_TIMEOUT_MS = 300000;
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_REFUSED = 2;
/** Files edited in the two-device phase: A alone, B alone, and one both devices edit (the conflict-copy check). */
export const EDIT_A_ONLY = "notes/welcome.md";
export const EDIT_B_ONLY = "notes/daily/2026-01-02.md";
export const EDIT_BOTH = "projects/alpha/tasks.md";
export const TAMPER_KINDS = ["pull-writes", "hash-mismatch", "replay-accepted", "declined-writes", "outside-allowlist", "base-changed"];
export const UNVERIFIED = [
  "the in-app plugin pull and its dialogs (until the 07b operator run)",
  "fork resolution by --resolve-fork (it needs a terminal to confirm; the script only checks the refusal by name and that the question is answered no without a terminal)",
  "large-file pull and the Range-honouring gateway behaviour on the shared node",
  "plugin large-body transport (requestUrl with multi-megabyte bodies)",
  "zeroization of secrets in memory",
  "an authenticated (auth-protected) kubo endpoint",
  "what a Windows or Linux-only path does on another platform's device",
];

export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = "Refusal";
  }
}
