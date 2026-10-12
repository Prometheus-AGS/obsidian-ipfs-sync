import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HISTORY_REFUSE_AT, HISTORY_WARN_AT, assessHistoryCount, type HistoryView } from "../../src/sync/history-check";
import { historyFull } from "../../src/sync/publish-refusals";
import { defaultSettings } from "../../src/plugin/settings-model";
import { MIN_AUTO_PUBLISH_INTERVAL_MINUTES, createAutoPublishTick } from "../../src/plugin/auto-publish-gate";

const MINUTE = 60_000;
const THIRTY_DAYS_MINUTES = 30 * 24 * 60;

/** A clock the test moves; the tick reads it and nothing else. */
function simulate(intervalMinutes: number, days = 30, publishMinutes = 0): { manifests: number; ticks: number } {
  let clock = 0;
  let manifests = 0;
  const tick = createAutoPublishTick({
    now: () => clock,
    publish: async () => {
      manifests += 1; // the vault changes on every tick, so every run that happens adds one history file
      clock += publishMinutes * MINUTE;
    },
  });
  let ticks = 0;
  const end = days * 24 * 60 * MINUTE;
  for (clock = intervalMinutes * MINUTE; clock <= end; clock += intervalMinutes * MINUTE) {
    ticks += 1;
    void tick();
  }
  return { manifests, ticks };
}

async function simulateAsync(intervalMinutes: number): Promise<number> {
  let clock = 0;
  let manifests = 0;
  const tick = createAutoPublishTick({ now: () => clock, publish: async () => void (manifests += 1) });
  for (clock = intervalMinutes * MINUTE; clock <= THIRTY_DAYS_MINUTES * MINUTE; clock += intervalMinutes * MINUTE) await tick();
  return manifests;
}

describe("auto-publish minimum interval (task 1.8 a)", () => {
  it("the minimum is a named constant of at least 29 minutes, the least that keeps 30 days under the warning level", () => {
    expect(MIN_AUTO_PUBLISH_INTERVAL_MINUTES).toBeGreaterThanOrEqual(Math.ceil(THIRTY_DAYS_MINUTES / (HISTORY_WARN_AT - 1)));
  });

  it("30 days at the shortest interval the setting accepts (1 minute), vault changed on every tick, stays under 1,500 manifests", async () => {
    const manifests = await simulateAsync(1);
    expect(manifests).toBeLessThan(HISTORY_WARN_AT);
    expect(manifests).toBeGreaterThan(0);
  });

  it("every interval from 1 to 120 minutes stays under the warning level over 30 days", async () => {
    for (const minutes of [1, 2, 5, 10, 15, 29, 30, 31, 45, 60, 120]) {
      const manifests = await simulateAsync(minutes);
      if (minutes <= MIN_AUTO_PUBLISH_INTERVAL_MINUTES) expect(manifests).toBeLessThan(HISTORY_WARN_AT);
    }
  });

  it("the shipped default is no timer: 30 days adds no manifest", () => {
    expect(defaultSettings().publishIntervalMinutes).toBe(0);
  });

  it("an interval longer than the minimum is not slowed down", async () => {
    const hourly = await simulateAsync(60);
    expect(hourly).toBe(THIRTY_DAYS_MINUTES / 60);
  });

  it("a tick that comes sooner than the minimum after the last completed run is skipped, not queued", async () => {
    let clock = 0;
    let runs = 0;
    const tick = createAutoPublishTick({ now: () => clock, publish: async () => void (runs += 1) });
    clock = 1 * MINUTE;
    expect(await tick()).toBe("ran");
    clock = (MIN_AUTO_PUBLISH_INTERVAL_MINUTES - 1) * MINUTE + MINUTE;
    expect(await tick()).toBe("skipped");
    expect(runs).toBe(1);
    clock = (1 + MIN_AUTO_PUBLISH_INTERVAL_MINUTES) * MINUTE;
    expect(await tick()).toBe("ran");
    expect(runs).toBe(2);
  });

  it("the minimum counts from when the run completed, not when it started", async () => {
    let clock = 0;
    let runs = 0;
    const tick = createAutoPublishTick({
      now: () => clock,
      publish: async () => {
        runs += 1;
        clock += 20 * MINUTE;
      },
    });
    clock = MINUTE;
    await tick();
    clock = (MIN_AUTO_PUBLISH_INTERVAL_MINUTES + 1) * MINUTE; // more than MIN after the start, less than MIN after the end
    expect(await tick()).toBe("skipped");
    expect(runs).toBe(1);
  });

  it("a run that throws still starts the wait, and the tick does not reject", async () => {
    let clock = MINUTE;
    let runs = 0;
    const tick = createAutoPublishTick({
      now: () => clock,
      publish: async () => {
        runs += 1;
        throw new Error("node unreachable");
      },
    });
    await expect(tick()).resolves.toBe("ran");
    clock += MINUTE;
    await expect(tick()).resolves.toBe("skipped");
    expect(runs).toBe(1);
  });

  it("a tick while a run is still going is skipped", async () => {
    let release: () => void = () => undefined;
    let runs = 0;
    const tick = createAutoPublishTick({ now: () => 0, publish: () => new Promise<void>((resolve) => { runs += 1; release = resolve; }) });
    const first = tick();
    expect(await tick()).toBe("skipped");
    release();
    await first;
    expect(runs).toBe(1);
  });

  it("the first tick after load is not delayed", async () => {
    let runs = 0;
    const tick = createAutoPublishTick({ now: () => 0, publish: async () => void (runs += 1) });
    expect(await tick()).toBe("ran");
    expect(runs).toBe(1);
  });

  it("simulate() with fire-and-forget ticks agrees with the awaited run", () => {
    expect(simulate(1).manifests).toBeLessThan(HISTORY_WARN_AT);
  });
});

describe("manual publish is not throttled", () => {
  const index = readFileSync("src/plugin/index.ts", "utf8");

  it("the command and the ribbon icon call publishVault without the gate", () => {
    expect(index).toMatch(/id: "publish-vault"[^\n]*callback: \(\) => void this\.publishVault\(\)/);
    expect(index).toMatch(/addRibbonIcon\("network", "IPFS Sync: publish vault", \(\) => void this\.publishVault\(\)\)/);
  });

  it("only the timer goes through createAutoPublishTick, and publishVault itself does not consult it", () => {
    expect(index).toMatch(/createAutoPublishTick\(/);
    const publishVault = index.slice(index.indexOf("async publishVault("), index.indexOf("async pullVault("));
    expect(publishVault).not.toMatch(/autoPublishTick|createAutoPublishTick|MIN_AUTO_PUBLISH/);
  });
});

describe("the history refusal and warning name the supported recovery (task 1.8 b)", () => {
  const folder = (count: number): HistoryView => ({
    entries: Array.from({ length: count }, (_, i) => ({ name: `${String(i + 1).padStart(16, "0")}-b${i.toString(32).padStart(58, "w")}.enc`, type: "file" as const, size: 1, cid: "x" })),
    overflow: false,
  });

  it("the refusal at 1,999 names the CLI command and the plugin action", () => {
    expect(() => assessHistoryCount(folder(HISTORY_REFUSE_AT))).toThrowError(/ipfs-sync prune-history <vault> --keep <n>/);
    const text = historyFull(HISTORY_REFUSE_AT).message;
    expect(text).toContain("ipfs-sync prune-history");
    expect(text).toContain("Prune history");
  });

  it("the warning at 1,500 names the same two", () => {
    const warning = assessHistoryCount(folder(HISTORY_WARN_AT)) ?? "";
    expect(warning).toContain("ipfs-sync prune-history");
    expect(warning).toContain("Prune history");
  });
});
