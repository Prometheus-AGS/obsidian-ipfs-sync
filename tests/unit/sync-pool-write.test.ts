import { describe, expect, it } from "vitest";
import { POOL_MAX_CONCURRENCY, runPool } from "../../src/sync/pool";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("runPool", () => {
  it("never exceeds 6 in flight and keeps at least 4 running while work remains", async () => {
    let inFlight = 0;
    let maxSeen = 0;
    const samplesWhileWorkRemains: number[] = [];
    const items = Array.from({ length: 100 }, (_, index) => index);
    const outcome = await runPool(items, async (item) => {
      inFlight += 1;
      maxSeen = Math.max(maxSeen, inFlight);
      // Ramp-up (the first lane starts) and drain-down (the last items) are excluded.
      if (item >= POOL_MAX_CONCURRENCY && item < items.length - POOL_MAX_CONCURRENCY) samplesWhileWorkRemains.push(inFlight);
      await delay(1 + (item % 3));
      inFlight -= 1;
      return item * 2;
    });
    expect(maxSeen).toBe(6);
    expect(Math.min(...samplesWhileWorkRemains)).toBeGreaterThanOrEqual(4);
    expect(outcome.failures).toEqual([]);
    expect(outcome.completed.map((c) => c.value)).toEqual(items.map((i) => i * 2));
  });

  it("clamps a larger request to 6", async () => {
    let inFlight = 0;
    let maxSeen = 0;
    await runPool(
      Array.from({ length: 30 }, (_, i) => i),
      async () => {
        inFlight += 1;
        maxSeen = Math.max(maxSeen, inFlight);
        await delay(2);
        inFlight -= 1;
      },
      50,
    );
    expect(maxSeen).toBe(6);
  });

  it("starts no new work after the first failure and lets running items finish", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const outcome = await runPool(
      Array.from({ length: 40 }, (_, i) => i),
      async (item) => {
        started.push(item);
        await delay(3);
        if (item === 2) throw new Error("node said no");
        finished.push(item);
        return item;
      },
    );
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.item).toBe(2);
    expect(started.length).toBeLessThan(40);
    expect(started.length).toBeLessThanOrEqual(2 + POOL_MAX_CONCURRENCY);
    expect(finished).toEqual(expect.arrayContaining([0, 1]));
  });
});
