import type { HostKv } from "../core/host-bridge";
import type { PublishDeps } from "./publish-types";

/**
 * A key-value store whose writes and deletes first call `assertHeld`. The publish lock is checked before each network
 * mutation and, through this wrapper, before each write to local state, the journal and the key-slot copy: a
 * holder whose lock lapsed must not move the record on either side.
 */
export function guardKv(kv: HostKv, assertHeld: () => void): HostKv {
  return {
    get: (key) => kv.get(key),
    list: (prefix) => kv.list(prefix),
    set: async (key, value) => {
      assertHeld();
      return kv.set(key, value);
    },
    delete: async (key) => {
      assertHeld();
      return kv.delete(key);
    },
  };
}

/** The same dependencies with local writes behind the lock check; unchanged when the run holds no lock. */
export function guardLocalWrites(deps: PublishDeps, assertHeld: (() => void) | undefined): PublishDeps {
  return assertHeld === undefined ? deps : { ...deps, host: { ...deps.host, kv: guardKv(deps.host.kv, assertHeld) } };
}
