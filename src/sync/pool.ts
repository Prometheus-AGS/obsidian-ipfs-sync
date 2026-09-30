/** Concurrent writes allowed by the plan: never above 6, and 6 keeps at least 4 in flight while work remains. */
export const POOL_MAX_CONCURRENCY = 6;
export const POOL_DEFAULT_CONCURRENCY = 6;

export interface PoolFailure<T> {
  readonly item: T;
  readonly error: unknown;
}

export interface PoolOutcome<T, R> {
  /** Successful items with their results, in input order. */
  readonly completed: readonly { readonly item: T; readonly value: R }[];
  /** Failures in the order they happened. The pool schedules no new work after the first. */
  readonly failures: readonly PoolFailure<T>[];
}

/**
 * Run `worker` over `items` with a bounded number in flight. After the first
 * failure no new item starts; items already running finish.
 */
export async function runPool<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  concurrency: number = POOL_DEFAULT_CONCURRENCY,
): Promise<PoolOutcome<T, R>> {
  const limit = Math.max(1, Math.min(Math.floor(concurrency), POOL_MAX_CONCURRENCY));
  const results = new Map<number, R>();
  const failures: PoolFailure<T>[] = [];
  let next = 0;

  async function lane(): Promise<void> {
    while (failures.length === 0 && next < items.length) {
      const index = next;
      next += 1;
      const item = items[index] as T;
      try {
        results.set(index, await worker(item));
      } catch (error) {
        failures.push({ item, error });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  const completed = [...results.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, value]) => ({ item: items[index] as T, value }));
  return { completed, failures };
}
