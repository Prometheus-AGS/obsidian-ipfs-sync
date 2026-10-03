import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One per-user state directory for the whole test process, so a CLI publish never reaches the real home directory. */
const STATE_HOME = mkdtempSync(join(tmpdir(), "ipfs-sync-test-state-"));

/** A CLI environment whose device store lives in a temporary directory; `extra` is added on top. */
export function stateEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { XDG_STATE_HOME: STATE_HOME, ...extra };
}
