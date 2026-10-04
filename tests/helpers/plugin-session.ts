import type { SyncConfig } from "../../src/core/config";
import type { CostPolicy } from "../../src/crypto";
import { requestUrlTransport } from "../../src/plugin/request-url-transport";
import type { VaultAdapter } from "../../src/plugin/obsidian-fs";
import {
  createSessionKeys,
  type DialogCallbacks,
  type SessionKeys,
  type SetupRequest,
  type SetupResult,
  type UnlockRequest,
  type UnlockingEvent,
} from "../../src/plugin/session-keys";
import type { SettingsStore } from "../../src/plugin/settings-store";
import { createVaultOpener, createVaultProbe } from "../../src/plugin/vault-opener";
import type { PublishClient } from "../../src/sync/publish";
import { FLOOR_PARAMS, referencePassphrase } from "../vectors/slot-helpers";

/** The reference passphrase as a user would type it. */
export const REFERENCE_TEXT = String.fromCharCode(...referencePassphrase());

export interface SessionRig {
  readonly session: SessionKeys;
  readonly unlockRequests: UnlockRequest[];
  readonly setupRequests: SetupRequest[];
  readonly events: UnlockingEvent[];
  /** Key derivations seen (the unlocking indicator's `start` events). */
  derivations(): number;
}

export interface SessionRigOptions {
  readonly store: SettingsStore;
  readonly adapter: VaultAdapter;
  readonly createClient: (config: SyncConfig) => PublishClient;
  /** What the unlock dialog returns, in order; the last entry repeats. Default: the reference passphrase. `undefined` entries cancel. */
  readonly typed?: readonly (string | undefined)[];
  /** The setup dialog: default confirms with the displayed passphrase. */
  readonly setup?: (request: SetupRequest) => Promise<SetupResult | undefined>;
  /** The cost policy of the opener (task 2.4); absent: a slot above the default cost is refused. */
  readonly costPolicy?: CostPolicy;
}

/**
 * A real key session over the plugin's real `open` port at the floor KDF cost, with dialogs that answer from a script.
 * Nothing here stores a passphrase; the script holds the reference text a user would type.
 */
export function sessionRig(options: SessionRigOptions): SessionRig {
  const unlockRequests: UnlockRequest[] = [];
  const setupRequests: SetupRequest[] = [];
  const events: UnlockingEvent[] = [];
  const typed = [...(options.typed ?? [REFERENCE_TEXT])];
  const dialogs: DialogCallbacks = {
    unlock: async (request) => {
      unlockRequests.push(request);
      return typed.length > 1 ? typed.shift() : typed[0];
    },
    setup: async (request) => {
      setupRequests.push(request);
      return options.setup === undefined ? { confirmed: true, reentered: request.passphrase } : options.setup(request);
    },
    unlocking: (event) => void events.push(event),
  };
  const now = (): Date => new Date(1_800_000_000_000);
  const session = createSessionKeys({
    dialogs,
    open: createVaultOpener({ store: options.store, adapter: options.adapter, transport: requestUrlTransport, now, createClient: options.createClient, createParams: FLOOR_PARAMS, ...(options.costPolicy === undefined ? {} : { costPolicy: options.costPolicy }) }),
    vaultExists: createVaultProbe({ store: options.store, adapter: options.adapter, now }),
  });
  return { session, unlockRequests, setupRequests, events, derivations: () => events.filter((event) => event.kind === "start").length };
}
