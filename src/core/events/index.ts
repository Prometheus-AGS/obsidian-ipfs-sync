import { createEventBus, type EventBus } from "./event-bus";
import type { SyncEventMap } from "./event-types";

export * from "./event-bus";
export type * from "./event-types";

export type SyncEventBus = EventBus<SyncEventMap>;

export function createSyncEventBus(): SyncEventBus {
  return createEventBus<SyncEventMap>();
}
