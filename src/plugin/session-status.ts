import type { EncryptionStatusSource } from "./encryption-settings-model";
import type { SessionKeys } from "./session-keys";

/**
 * What the settings tab's Encryption section follows. The session has no events of its own, so `observed` wraps the
 * calls that can change its state (`unlock`, `setup`, `lock`, `refresh`) and tells the listeners once each has ended.
 */

export interface SessionObserver {
  readonly session: SessionKeys;
  /** The section's view of the session. `openSetup` and `openUnlock` are what the buttons call. */
  status(actions: { readonly openSetup: () => void; readonly openUnlock: () => void; readonly openAbandon?: () => void }): EncryptionStatusSource;
}

export function observed(session: SessionKeys): SessionObserver {
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const after = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } finally {
      changed();
    }
  };
  const wrapped: SessionKeys = {
    ...session,
    refresh: () => after(() => session.refresh()),
    unlock: () => after(() => session.unlock()),
    setup: () => after(() => session.setup()),
    lock: () => {
      session.lock();
      changed();
    },
    dispose: () => {
      session.dispose();
      changed();
    },
  };
  return {
    session: wrapped,
    status: (actions) => ({
      state: () => wrapped.state(),
      lock: () => wrapped.lock(),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      openSetup: actions.openSetup,
      openUnlock: actions.openUnlock,
      ...(actions.openAbandon === undefined ? {} : { openAbandon: actions.openAbandon }),
    }),
  };
}
