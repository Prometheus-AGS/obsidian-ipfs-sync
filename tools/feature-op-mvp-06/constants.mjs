// Constants, tamper kinds, the unverified list and the refusal type of the mvp-06 feature operation.
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI = join(REPO, "dist", "cli", "ipfs-sync.mjs");
export const GENERATOR = join(REPO, "fixtures", "generate-fixture-vault.ts");

export const BASE = "/obsidian-vault-sync";
export const DEMO_PARENT = `${BASE}/mvp06-demo`;
export const KEY = "obsidian-vault-sync";
export const STAGING_ROOT = "/obsidian-vault-staging";
export const RUN_ID_PATTERN = /^[a-z0-9-]{8,}$/;
/** The shared node's host. The forwarding proxy refuses any other upstream unless --local-stub. */
export const ALLOWED_HOSTS = ["ipfs.prometheusags.ai"];
const CONFIG_DIR = join(tmpdir(), "ipfs-sync-feature-ops");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const DEFAULT_OUT = join(CONFIG_DIR, "feature-op-mvp-06.json");
export const LOCK_FILE = join(tmpdir(), "ipfs-sync-feature-op-mvp06.lock");
export const SEED = 20260930;
export const LARGE_NOTE = "notes/large-repetitive.md";
export const LARGE_NOTE_BYTES = 256 * 1024;
export const CANARY = "canary-phrase-zx91-ipfs";
export const WORDS = ["harbor", "lantern", "meadow", "quartz", "ember", "willow", "signal", "orbit", "cobalt", "thistle", "ripple", "anvil"];
export const NEEDLE_MIN_BYTES = 5;
export const MIN_PUBLISHED_FILES = 10;
export const MIN_ENTROPY = 7.99;
export const BLOB_MAGIC_TEXT = "ISBL";
export const BLOB_HEADER_BYTES = 22;
export const BLOB_EXPONENT = 23;
export const CHILD_TIMEOUT_MS = 300000;
export const UNLOCK_TARGET_MS = 3000;
export const UNLOCK_GAP_TARGET_MS = 100;
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_REFUSED = 2;
/** Where each read-boundary tamper is applied: the first (sequence 1) or the second (sequence 2) inspection of the node. corrupted-commitment acts inside the first unlock, resume-fails on the first killed publish, proxy-outside-allowlist before the audit. */
export const TAMPER_AT = { "title-in-blob": "first", "flipped-listing-name": "first", "stale-sequence": "second" };
export const TAMPER_KINDS = ["title-in-blob", "flipped-listing-name", "stale-sequence", "corrupted-commitment", "resume-fails", "proxy-outside-allowlist"];
export const UNVERIFIED = [
  "phone timing of Argon2id at 64 MiB / t=3",
  "the in-app plugin passphrase flow (until mvp-07's operator run)",
  "zeroization of secrets in memory",
  "rollback prevention (unenforced by design)",
  "an authenticated (auth-protected) kubo endpoint",
  "plugin large-body transport (requestUrl with multi-megabyte bodies)",
];

export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = "Refusal";
  }
}
