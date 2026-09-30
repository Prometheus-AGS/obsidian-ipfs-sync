/**
 * A small typed event bus. Event names and payloads are statically checked;
 * listeners are removable; a failing listener never stops the others.
 */

/** Words that must not appear in a payload field name (compared in lower case). */
type SecretWord = "token" | "password" | "passphrase" | "secret" | "credential" | "authorization" | "content" | "bytes";

type SecretFieldName = `${string}${SecretWord}${string}`;

type HasSecretField<Payload> = [Extract<Lowercase<keyof Payload & string>, SecretFieldName>] extends [never]
  ? false
  : true;

/**
 * Constraint for an event map: an event whose payload has a secret-looking
 * field is mapped to `never`, so declaring it fails to compile.
 */
export type SecretFreeEventMap<Events> = {
  readonly [Name in keyof Events]: HasSecretField<Events[Name]> extends true ? never : Events[Name];
};

export type Listener<Payload> = (payload: Payload) => void | Promise<void>;

export interface ListenerFailure {
  readonly event: string;
  readonly error: unknown;
}

export type ListenerFailureHandler = (failure: ListenerFailure) => void;

export interface EventBus<Events> {
  /** Subscribe. The returned function unsubscribes. */
  on<Name extends keyof Events>(name: Name, listener: Listener<Events[Name]>): () => void;
  off<Name extends keyof Events>(name: Name, listener: Listener<Events[Name]>): void;
  /** Call every listener registered for `name`; never throws because of a listener. */
  emit<Name extends keyof Events>(name: Name, payload: Events[Name]): void;
  /** The bus's own error channel: receives whatever a listener threw or rejected with. */
  onListenerFailure(handler: ListenerFailureHandler): () => void;
}

function without<T>(items: readonly T[], item: T): readonly T[] {
  return items.filter((candidate) => candidate !== item);
}

/** Listeners are stored erased; `on` and `emit` keep the public signatures exact per event name. */
type StoredListener = (payload: never) => void | Promise<void>;

export function createEventBus<Events extends SecretFreeEventMap<Events>>(): EventBus<Events> {
  let listeners: ReadonlyMap<keyof Events, readonly StoredListener[]> = new Map();
  let failureHandlers: readonly ListenerFailureHandler[] = [];

  function setListeners(name: keyof Events, next: readonly StoredListener[]): void {
    listeners = new Map([...listeners, [name, next]]);
  }

  function report(event: string, error: unknown): void {
    for (const handler of failureHandlers) {
      try {
        handler({ event, error });
      } catch {
        // A failing failure handler has nowhere else to report to; the publish must go on.
      }
    }
  }

  function invoke<Name extends keyof Events>(name: Name, listener: StoredListener, payload: Events[Name]): void {
    try {
      const result = (listener as Listener<Events[Name]>)(payload);
      if (result instanceof Promise) result.catch((error: unknown) => report(String(name), error));
    } catch (error) {
      report(String(name), error);
    }
  }

  function off<Name extends keyof Events>(name: Name, listener: Listener<Events[Name]>): void {
    setListeners(name, without(listeners.get(name) ?? [], listener));
  }

  return {
    on(name, listener) {
      setListeners(name, [...(listeners.get(name) ?? []), listener]);
      return () => off(name, listener);
    },
    off,
    emit(name, payload) {
      for (const listener of listeners.get(name) ?? []) invoke(name, listener, payload);
    },
    onListenerFailure(handler) {
      failureHandlers = [...failureHandlers, handler];
      return () => {
        failureHandlers = without(failureHandlers, handler);
      };
    },
  };
}
