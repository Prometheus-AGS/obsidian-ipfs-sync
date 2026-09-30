import { classifyKey, isValidKeyName, RESERVED_KEY_NAMES, type KeyState } from "../core/config";
import type { NodeKey } from "../kubo";
import type { SettingsStore } from "./settings-store";

/**
 * What the operator must be told before a key is adopted. The dialog shows these lines as they are:
 * adoption makes the plugin publish to a key that already exists on a shared node.
 */
export const ADOPT_CONSEQUENCES: readonly string[] = [
  "The plugin will publish to this key and replace whatever pointer the key currently holds.",
  "Other projects on this node may depend on that pointer.",
  "The plugin cannot undo this: it has no way to restore the previous pointer or to remove the key.",
];

const KEY_ID_SHAPE = /^[A-Za-z0-9]{8,128}$/;

export type AdoptState =
  | { readonly step: "idle" }
  | { readonly step: "confirming"; readonly keyId: string; readonly keyName: string }
  | { readonly step: "refused"; readonly keyId: string; readonly reason: string }
  | { readonly step: "recorded"; readonly keyId: string; readonly keyName: string };

export interface KeyStateView {
  readonly state: KeyState | "unknown";
  readonly detail: string;
  readonly ownedKeyIds: readonly string[];
}

export interface KeyAdoption {
  state(): AdoptState;
  /** Look the ID up on the node and check the key's name. Records nothing: a valid ID moves to `confirming`. */
  submit(keyId: string): Promise<AdoptState>;
  /** Only from `confirming`: record the ID as owned. */
  confirm(): Promise<AdoptState>;
  /** From `confirming` or `refused`: back to idle, the owned list unchanged. */
  cancel(): AdoptState;
  /** State of the configured publication key against the node, and the recorded owned IDs. */
  keyState(): Promise<KeyStateView>;
}

export interface KeyAdoptionDeps {
  readonly store: SettingsStore;
  /** Keys on the node (names and IDs). Rejects when the node cannot be reached. */
  readonly listNodeKeys: () => Promise<readonly NodeKey[]>;
}

function refusal(keyId: string, reason: string): AdoptState {
  return { step: "refused", keyId, reason };
}

function nameRefusal(keyId: string, name: string): AdoptState {
  const why = RESERVED_KEY_NAMES.includes(name)
    ? "it belongs to another project on the node"
    : "publication keys must be named obsidian-vault or obsidian-vault-<suffix>";
  return refusal(keyId, `The key named "${name}" cannot be adopted: ${why}.`);
}

function reachFailure(error: unknown): string {
  return `The node could not be asked for its keys: ${error instanceof Error ? error.message : "unknown error"}`;
}

export function createKeyAdoption(deps: KeyAdoptionDeps): KeyAdoption {
  let current: AdoptState = { step: "idle" };
  const set = (next: AdoptState): AdoptState => {
    current = next;
    return next;
  };

  return {
    state: () => current,

    submit: async (rawId) => {
      const keyId = rawId.trim();
      if (!KEY_ID_SHAPE.test(keyId)) return set(refusal(keyId, "That is not a key ID: use the ID shown by the node, letters and digits only."));
      if (deps.store.get().ownedKeys.includes(keyId)) return set(refusal(keyId, "That key is already recorded as owned."));
      let nodeKeys: readonly NodeKey[];
      try {
        nodeKeys = await deps.listNodeKeys();
      } catch (error) {
        return set(refusal(keyId, reachFailure(error)));
      }
      const found = nodeKeys.find((key) => key.id === keyId);
      if (found === undefined) return set(refusal(keyId, "The node has no key with that ID."));
      if (!isValidKeyName(found.name)) return set(nameRefusal(keyId, found.name));
      return set({ step: "confirming", keyId, keyName: found.name });
    },

    confirm: async () => {
      if (current.step !== "confirming") return current;
      const { keyId, keyName } = current;
      try {
        await deps.store.update((s) => (s.ownedKeys.includes(keyId) ? s : { ...s, ownedKeys: [...s.ownedKeys, keyId] }));
      } catch (error) {
        return set(refusal(keyId, `The key ID could not be saved: ${error instanceof Error ? error.message : "unknown error"}`));
      }
      return set({ step: "recorded", keyId, keyName });
    },

    cancel: () => (current.step === "idle" ? current : set({ step: "idle" })),

    keyState: async () => {
      const { publicationKey, ownedKeys } = deps.store.get();
      try {
        const nodeKeys = (await deps.listNodeKeys()).map((key) => ({ name: key.name, id: key.id === "" ? undefined : key.id }));
        const found = classifyKey(publicationKey, nodeKeys, ownedKeys);
        return { state: found.state, detail: found.reason, ownedKeyIds: ownedKeys };
      } catch (error) {
        return { state: "unknown", detail: reachFailure(error), ownedKeyIds: ownedKeys };
      }
    },
  };
}
