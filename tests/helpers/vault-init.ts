import type { HostFs } from "../../src/core/host-bridge";
import type { KdfParams } from "../../src/crypto";
import { openVault } from "../../src/sync/vault-keys";
import { FLOOR_PARAMS, referenceGenerated, referencePassphrase } from "../vectors/slot-helpers";
import type { FakeNode } from "./fake-kubo";

/** Forget every request the fake node has seen, so a test asserts only on what follows. */
export function resetTrace(node: FakeNode): void {
  node.calls.length = 0;
  node.requests.length = 0;
  node.mutations = 0;
}

/**
 * Create a vault the way `ipfs-sync init` will: the local copy of the key slots (through `fs`) and `keyslots.json` on
 * the node, no manifest. Uses the floor KDF cost so a test unlocks in a fraction of a second. The request trace is
 * reset afterwards.
 */
export async function initVault(fs: Pick<HostFs, "read" | "write" | "stat">, node: FakeNode, mfsRoot: string, params: KdfParams = FLOOR_PARAMS): Promise<void> {
  const opened = await openVault({
    fs,
    mfsRoot,
    passphrase: referencePassphrase(),
    local: { hasState: false },
    node: { fetchKeySlots: async () => undefined, manifestPresent: async () => false },
    create: referenceGenerated(),
    createParams: params,
  });
  await node.client.filesWrite(`${mfsRoot}/keyslots.json`, opened.keySlots);
  resetTrace(node);
}
