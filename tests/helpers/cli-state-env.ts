import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_GATEWAY_URL, TEST_RPC_URL } from "./test-node-settings";

/** One per-user state directory for the whole test process, so a CLI publish never reaches the real home directory. */
const STATE_HOME = mkdtempSync(join(tmpdir(), "ipfs-sync-test-state-"));

/**
 * The CLI has no default node, so a run that should reach the fake node names one. Tests stub `fetch` and route on the path,
 * so the host is a `.test` name that nothing resolves.
 */
export const NODE_ENV: Readonly<Record<string, string>> = { IPFS_SYNC_RPC_URL: TEST_RPC_URL, IPFS_SYNC_GATEWAY_URL: TEST_GATEWAY_URL };

/** A CLI environment whose device store lives in a temporary directory and that names the test node; `extra` is added on top. */
export function stateEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...NODE_ENV, XDG_STATE_HOME: STATE_HOME, ...extra };
}
