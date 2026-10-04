import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { measureDerivation, type HeartbeatTimers } from "../../src/plugin/measure-derivation";
import { measurementNoticeText } from "../../src/plugin/measure-notice";

const BUILD = new TextEncoder().encode("// the installed plugin main.js\n");
const BUILD_HASH = bytesToHex(sha256(BUILD));
const buildBuffer = (): Promise<ArrayBuffer> => Promise.resolve(BUILD.buffer.slice(0) as ArrayBuffer);

/** A clock and a heartbeat the test drives by hand. */
function manualTime(): { readonly now: () => number; readonly advance: (ms: number) => void; readonly timers: HeartbeatTimers; readonly tick: () => void; readonly running: () => boolean } {
  let clock = 1_000;
  let callback: (() => void) | undefined;
  return {
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    tick: () => callback?.(),
    running: () => callback !== undefined,
    timers: {
      setInterval: (next) => {
        callback = next;
        return 1;
      },
      clearInterval: () => {
        callback = undefined;
      },
    },
  };
}

describe("measureDerivation", () => {
  it("records seconds, platform, completed and the first 16 hex characters of the build hash", async () => {
    const time = manualTime();
    const record = await measureDerivation({
      readBuild: buildBuffer,
      platform: "ios",
      now: time.now,
      timers: time.timers,
      derive: async () => time.advance(2_500),
    });
    expect(record.seconds).toBeCloseTo(2.5, 5);
    expect(record.platform).toBe("ios");
    expect(record.completed).toBe(true);
    expect(record.buildHashPrefix).toBe(BUILD_HASH.slice(0, 16));
    const notice = measurementNoticeText(record);
    const grouped = BUILD_HASH.slice(0, 16).replace(/(.{4})(?=.)/g, "$1 ");
    expect(notice).toContain(`Build hash (first 16 characters): ${grouped}`);
  });

  it("says the build hash is unavailable when the plugin file cannot be read", async () => {
    const time = manualTime();
    const record = await measureDerivation({
      readBuild: () => Promise.reject(new Error("ENOENT main.js")),
      platform: "android",
      now: time.now,
      timers: time.timers,
      derive: async () => undefined,
    });
    expect(record.buildHashPrefix).toBeUndefined();
    expect(record.completed).toBe(true);
    expect(measurementNoticeText(record)).toContain("Build hash: unavailable");
  });

  it("does not count the file read in the elapsed time", async () => {
    const time = manualTime();
    const record = await measureDerivation({
      readBuild: async () => {
        time.advance(9_000);
        return buildBuffer();
      },
      platform: "desktop",
      now: time.now,
      timers: time.timers,
      derive: async () => time.advance(1_000),
    });
    expect(record.seconds).toBeCloseTo(1, 5);
  });

  it("reports an unfinished derivation as not completed, with the time it ran", async () => {
    const time = manualTime();
    const record = await measureDerivation({
      readBuild: buildBuffer,
      platform: "ios",
      now: time.now,
      timers: time.timers,
      derive: async () => {
        time.advance(400);
        throw new Error("out of memory");
      },
    });
    expect(record.completed).toBe(false);
    expect(record.seconds).toBeCloseTo(0.4, 5);
    expect(measurementNoticeText(record)).toContain("Completed: no");
  });

  it("records the longest gap between heartbeat ticks, including the stretch up to the end", async () => {
    const time = manualTime();
    const record = await measureDerivation({
      readBuild: buildBuffer,
      platform: "ios",
      now: time.now,
      timers: time.timers,
      derive: async () => {
        time.advance(10);
        time.tick();
        time.advance(80);
        time.tick();
        time.advance(30);
      },
    });
    expect(record.longestGapMs).toBe(80);
    const blocked = manualTime();
    const whole = await measureDerivation({ readBuild: buildBuffer, platform: "ios", now: blocked.now, timers: blocked.timers, derive: async () => blocked.advance(3_000) });
    expect(whole.longestGapMs).toBe(3_000);
  });

  it("stops the heartbeat when the derivation ends, however it ends", async () => {
    const time = manualTime();
    await measureDerivation({ readBuild: buildBuffer, platform: "ios", now: time.now, timers: time.timers, derive: async () => expect(time.running()).toBe(true) });
    expect(time.running()).toBe(false);
    await measureDerivation({
      readBuild: buildBuffer,
      platform: "ios",
      now: time.now,
      timers: time.timers,
      derive: async () => {
        throw new Error("failed");
      },
    });
    expect(time.running()).toBe(false);
  });

  it("runs the public key-slot creation path at the default cost on a generated passphrase, with no input from the caller", async () => {
    // No `derive` override: this is the production path (generatePassphrase + createKeySlots), one Argon2id derivation at 64 MiB, t=3.
    const record = await measureDerivation({ readBuild: buildBuffer, platform: "desktop" });
    expect(record.completed).toBe(true);
    expect(record.seconds).toBeGreaterThan(0);
    expect(record.buildHashPrefix).toBe(BUILD_HASH.slice(0, 16));
  });
});
