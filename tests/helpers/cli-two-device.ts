import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { runCli, type CliDeps } from "../../cli/run";
import { rootFileNames } from "../../src/sync/root-files";
import { MFS_ROOT, NOW, type CliPullRig, type CliResult } from "./cli-pull-rig";
import { NODE_ENV } from "./cli-state-env";
import { referencePassphraseSource } from "./cli-vault";
import { restoreNode, snapshotNode, type FakeNode } from "./fake-kubo";
import { fakeNodeFetch } from "./fake-kubo-http";

/**
 * Extra moves of the CLI two-device integration (mvp-07a task 6.1): device B publishes and abandons through `runCli`, and the
 * rig's one global `fetch` can be pointed at a second node, so two devices can each publish a sequence of their own.
 */

function sink(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => void out.push(text), err: (text) => void err.push(text) }, out, err };
}

const depsOf = (env: Record<string, string>): CliDeps => ({ env: { ...NODE_ENV, ...env }, now: () => NOW, readText: readTextIfPresent, passphrase: referencePassphraseSource });

/** Device B's configuration file: it owns the publication key (the documented onboarding step). */
async function configOfB(rig: CliPullRig): Promise<string> {
  const path = join(rig.dir, "cfg-b", "config.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ownedKeys: [rig.keyId()] }, null, 2)}\n`);
  return path;
}

/** `ipfs-sync publish` of device B's directory. The marker is replaced by hand first, as the documentation says. */
export async function cliPublishB(rig: CliPullRig, extra: readonly string[] = []): Promise<CliResult> {
  await writeFile(join(rig.vaultB, ".ipfs-sync-fixture"), "fixture\n");
  const s = sink();
  const code = await runCli(["publish", rig.vaultB, "--config", await configOfB(rig), "--mfs-root", MFS_ROOT, ...extra], depsOf({ XDG_STATE_HOME: rig.stateB }), s.io);
  return { code, out: s.out.join("\n"), err: s.err.join("\n") };
}

/** `ipfs-sync abandon` of device B's directory. */
export async function cliAbandonB(rig: CliPullRig): Promise<CliResult> {
  const s = sink();
  const code = await runCli(["abandon", rig.vaultB, "--mfs-root", MFS_ROOT, "--yes-abandon"], depsOf({ XDG_STATE_HOME: rig.stateB }), s.io);
  return { code, out: s.out.join("\n"), err: s.err.join("\n") };
}

/** Device B's local record for the MFS root: the file the CLI host keeps under `.ipfs-sync/`. */
export const stateFileOfB = (rig: CliPullRig): string => join(rig.vaultB, ".ipfs-sync", rootFileNames(MFS_ROOT).state);

/** Delete device B's record (a single file); its floor in the per-user store stays. */
export async function dropStateOfB(rig: CliPullRig): Promise<void> {
  await rm(stateFileOfB(rig), { force: true });
}

/** A second node that starts as a copy of the rig's node, for two publishes at one sequence. */
export function secondNode(rig: CliPullRig): FakeNode {
  const node = restoreNode(snapshotNode(rig.node));
  // Registers the blocks of the current root, so `/ipfs/<root>` reads of it keep working after the node changes.
  node.cidOf(MFS_ROOT);
  return node;
}

/** Point the rig's `fetch` (what the real kubo client uses) at `node`; requests keep being recorded in `rig.requests`. */
export function useNode(rig: CliPullRig, node: FakeNode): void {
  rig.fetchStub.mockImplementation(fakeNodeFetch(node, rig.requests));
}
