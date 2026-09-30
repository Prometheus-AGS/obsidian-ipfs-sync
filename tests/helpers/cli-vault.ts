import { createNodeHostBridge } from "../../cli/node-host-bridge";
import type { CanonicalPassphrase } from "../../src/crypto";
import { referencePassphrase } from "../vectors/slot-helpers";
import type { FakeNode } from "./fake-kubo";
import { initVault } from "./vault-init";

/** Create the encrypted vault for a vault directory on disk, the way `ipfs-sync init` will; the node trace is reset afterwards. */
export async function initDiskVault(vault: string, mfsRoot: string, node: FakeNode): Promise<void> {
  await initVault(createNodeHostBridge({ root: vault, env: {}, now: () => Date.now() }).fs, node, mfsRoot);
}

/** What a terminal or a file source will supply to the CLI: the canonical passphrase of the reference vault. */
export const referencePassphraseSource = async (): Promise<CanonicalPassphrase> => referencePassphrase();
