import { createSyncEventBus, type SyncEventBus } from "../../src/core/events";
import type { GatewayRange, GatewayStream } from "../../src/kubo";
import { createObsidianHostBridge } from "../../src/plugin/obsidian-host-bridge";
import type { PullDialogs } from "../../src/plugin/pull-dialogs";
import type { PassphrasePort, PassphraseVerdict } from "../../src/plugin/pull-keys";
import { createPullRunner, type PullOutcome, type PullRunner, type PullRunOptions } from "../../src/plugin/pull-runner";
import type { RestoreEntry, RestoreRequest } from "../../src/plugin/restore-dialog-model";
import type { UnlockRequest } from "../../src/plugin/session-keys";
import type { ForkRequest } from "../../src/plugin/fork-dialog-model";
import type { LargePullRequest } from "../../src/plugin/large-pull-dialog-model";
import { createSyncLock, type SyncLock } from "../../src/plugin/sync-lock";
import type { PluginSettings } from "../../src/plugin/settings-model";
import type { FirstPullDetails } from "../../src/sync/encrypted-pull";
import { readRootState, type RootState } from "../../src/sync/root-state";
import { unlockForPull } from "../../src/sync/pull-unlock";
import type { UnlockedVault } from "../../src/sync/vault-keys";
import { referencePassphrase } from "../vectors/slot-helpers";
import { keyIdOf } from "./encrypted-pull-rig";
import type { FakeNode } from "./fake-kubo";
import { createMemoryHost } from "./memory-host";
import { ROOT, type Rig } from "./publish-rig";
import { NOW, freshVault, storeWith } from "./plugin-pull-rig";
import { REFERENCE_TEXT } from "./plugin-session";
import type { MemoryAdapter } from "../support/memory-adapter";

/** Test helpers for the plugin's decrypting pull (mvp-07a task 5.3): device B is a plugin over a memory vault; device A is the publish rig. */

export { REFERENCE_TEXT };

/** The recording node's client. */
export type NodeClient = FakeNode["client"];

/** The node's client with `Range` honoured the way a gateway does (206 and a `Content-Range`), which the plugin's source requires. */
export interface RangedOptions {
  /** How many segment reads (a range that does not start at 0) come back with every byte flipped, from the first one. */
  readonly corruptSegments?: number;
}

export function rangedClient(client: NodeClient, options: RangedOptions = {}): NodeClient {
  let corruptLeft = options.corruptSegments ?? 0;
  return {
    ...client,
    gatewayStream: async (cid, path = "", range?: GatewayRange): Promise<GatewayStream> => {
      const whole = await client.gatewayFetch(cid, path);
      const part = range === undefined ? whole : whole.slice(range.start, range.start + range.length);
      let served = part;
      if (range !== undefined && range.start > 0 && corruptLeft > 0) {
        corruptLeft -= 1;
        served = part.map((byte) => byte ^ 0xff);
      }
      async function* chunks(): AsyncGenerator<Uint8Array> {
        yield served;
      }
      return range === undefined
        ? { status: 200, contentRange: undefined, chunks: chunks() }
        : { status: 206, contentRange: `bytes ${range.start}-${range.start + part.length - 1}/${whole.length}`, chunks: chunks() };
    },
  };
}

export interface ScriptedPassphrase extends PassphrasePort {
  readonly requests: UnlockRequest[];
  readonly verdicts: PassphraseVerdict[];
  readonly fractions: number[];
  /** Runs when the dialog is asked again, with the request: where a test looks at what exists between two attempts. */
  onAsk: ((request: UnlockRequest) => void) | undefined;
}

/** A passphrase prompt that answers from a script; the last entry repeats and `undefined` cancels. */
export function scriptedPassphrase(typed: readonly (string | undefined)[] = [REFERENCE_TEXT]): ScriptedPassphrase {
  const queue = [...typed];
  const self: ScriptedPassphrase = {
    requests: [],
    verdicts: [],
    fractions: [],
    onAsk: undefined,
    ask: async (request) => {
      self.requests.push(request);
      self.onAsk?.(request);
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    progress: (fraction) => void self.fractions.push(fraction),
    settle: (verdict) => void self.verdicts.push(verdict),
  };
  return self;
}

export interface ScriptedDialogs extends PullDialogs {
  readonly firstPulls: FirstPullDetails[];
  readonly lists: (readonly RestoreEntry[])[];
  readonly restores: RestoreRequest[];
  readonly forks: ForkRequest[];
  readonly larges: LargePullRequest[];
  /** What the next dialogs answer. Change between steps. */
  answers: { firstPull: boolean; restoreIndex: number | undefined; restore: boolean; fork: boolean; large: boolean };
  /** Runs inside the first-pull confirmation, with the dialog's details. */
  onFirstPull: ((details: FirstPullDetails) => void) | undefined;
}

export function scriptedDialogs(answers: Partial<ScriptedDialogs["answers"]> = {}): ScriptedDialogs {
  const self: ScriptedDialogs = {
    firstPulls: [],
    lists: [],
    restores: [],
    forks: [],
    larges: [],
    answers: { firstPull: true, restoreIndex: 0, restore: true, fork: true, large: true, ...answers },
    onFirstPull: undefined,
    confirmFirstPull: async (details) => {
      self.firstPulls.push(details);
      self.onFirstPull?.(details);
      return self.answers.firstPull;
    },
    chooseRestoreEntry: async (entries) => {
      self.lists.push(entries);
      return self.answers.restoreIndex;
    },
    confirmRestore: async (request) => {
      self.restores.push(request);
      return self.answers.restore;
    },
    confirmResolveFork: async (request) => {
      self.forks.push(request);
      return self.answers.fork;
    },
    confirmLargePull: async (request) => {
      self.larges.push(request);
      return self.answers.large;
    },
  };
  return self;
}

export interface EncryptedPluginRig {
  readonly publisher: Rig;
  readonly adapter: MemoryAdapter;
  readonly store: ReturnType<typeof storeWith>;
  readonly runner: PullRunner;
  readonly bus: SyncEventBus;
  readonly lock: SyncLock;
  readonly passphrase: ScriptedPassphrase;
  readonly dialogs: ScriptedDialogs;
  readonly client: NodeClient;
  pull(options?: PullRunOptions): Promise<PullOutcome>;
  /** The plugin's state file for the root, or `undefined`. */
  state(): Promise<RootState | undefined>;
  /** Every vault file as text (not `.obsidian/`, `.ipfs-sync/` or the marker). */
  texts(): Record<string, string>;
}

export interface EncryptedPluginOptions {
  readonly settings?: Partial<PluginSettings>;
  readonly typed?: readonly (string | undefined)[];
  readonly answers?: Partial<ScriptedDialogs["answers"]>;
  readonly adapter?: MemoryAdapter;
  /** The same plugin data as an earlier runner: a second runner over the same device, pointed at another node. */
  readonly store?: ReturnType<typeof storeWith>;
  readonly session?: { provider(): UnlockedVault | undefined };
  readonly corruptSegments?: number;
  readonly lock?: SyncLock;
  /** No passphrase prompt and no dialogs: the way a bare runner (or a quiet run) has them. */
  readonly bare?: boolean;
}

/** Device B: a plugin pull runner over a fresh memory vault, pulling the publish rig's node through a ranged client. */
export function pluginOver(publisher: Rig, options: EncryptedPluginOptions = {}): EncryptedPluginRig {
  const adapter = options.adapter ?? freshVault();
  const store = options.store ?? storeWith({ mfsRoot: ROOT, ownedKeys: [keyIdOf(publisher.node)], ...options.settings });
  const bus = createSyncEventBus();
  const lock = options.lock ?? createSyncLock();
  const passphrase = scriptedPassphrase(options.typed);
  const dialogs = scriptedDialogs(options.answers);
  const client = rangedClient(publisher.node.client, options.corruptSegments === undefined ? {} : { corruptSegments: options.corruptSegments });
  let counter = 0;
  const runner = createPullRunner({
    store,
    adapter,
    bus,
    lock,
    createClient: () => client,
    now: () => NOW,
    newId: () => `part${(counter += 1)}`,
    ...(options.session === undefined ? {} : { session: options.session }),
    ...(options.bare === true ? {} : { passphrase, dialogs }),
  });
  const host = (): ReturnType<typeof createObsidianHostBridge> => createObsidianHostBridge({ adapter });
  return {
    publisher,
    adapter,
    store,
    runner,
    bus,
    lock,
    passphrase,
    dialogs,
    client,
    pull: (runOptions) => runner.run(runOptions),
    state: () => readRootState(host().kv, ROOT),
    texts: () => {
      const texts: Record<string, string> = {};
      for (const path of adapter.files.keys()) {
        if (path.startsWith(".ipfs-sync") || path.startsWith(".obsidian/")) continue;
        texts[path] = adapter.text(path) ?? "";
      }
      return texts;
    },
  };
}

/**
 * A vault held by a session, as a plugin that unlocked it earlier would hold it: opened from the node's key slots the way a pull
 * opens them (read-only, a throwaway directory), which mints the same kind of `UnlockedVault` the session keeps.
 */
export async function heldVault(publisher: Rig): Promise<UnlockedVault> {
  const unlock = await unlockForPull({
    fs: createMemoryHost().fs,
    mfsRoot: ROOT,
    passphrase: referencePassphrase(),
    local: { hasState: false },
    node: { fetchKeySlots: async () => publisher.node.files.get(`${ROOT}/keyslots.json`), manifestPresent: async () => true },
    recordFor: () => undefined,
  });
  return unlock.vault;
}
