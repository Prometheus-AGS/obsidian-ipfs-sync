import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError, parseCliArgs } from "../../cli/args";
import { HELP_TEXT } from "../../cli/help-text";
import { HISTORY_DEFAULT_LIMIT, HISTORY_EMPTY_LINE } from "../../cli/history-command";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { runCli, type CliDeps } from "../../cli/run";
import { openHistoryStore } from "../../cli/store/pglite-store";
import { SCHEMA_VERSION } from "../../cli/store/schema";
import type { ConflictRecord, PublishRecord, PullRecord } from "../../src/core/store/types";
import { stateEnv } from "../helpers/cli-state-env";

/**
 * `ipfs-sync history [--limit <n>]` through `runCli` (mvp-08 task 4.1), against a PGlite database seeded in a
 * temporary per-user state directory. The command is device-local: no config, no client, no request, no passphrase.
 */

const TEST_TIMEOUT_MS = 30_000;

let root: string;
let directory: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ipfs-sync-cli-history-"));
  directory = join(root, "ipfs-sync", "history");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface CliResult {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
}

async function history(args: readonly string[] = [], env: Record<string, string> = stateEnv({ XDG_STATE_HOME: root })): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (text) => void out.push(text), err: (text) => void err.push(text) };
  const deps: CliDeps = { env, now: () => new Date(0), readText: readTextIfPresent };
  const code = await runCli(["history", ...args], deps, io);
  return { code, out, err };
}

function publishRecord(rootCid: string, occurredAtMs: number): PublishRecord {
  return { kind: "publish", occurredAtMs, rootCid, manifestCid: `manifest-of-${rootCid}`, written: 3, removed: 1, durationMs: 12 };
}

function pullRecord(rootCid: string, occurredAtMs: number): PullRecord {
  return {
    kind: "pull",
    occurredAtMs,
    rootCid,
    manifestCid: `manifest-of-${rootCid}`,
    fetched: 2,
    unchanged: 5,
    conflicted: 1,
    failed: 0,
    remoteDeleted: 1,
    locallyModified: 1,
    durationMs: 30,
  };
}

function conflictRecord(rootCid: string, occurredAtMs: number): ConflictRecord {
  return { kind: "conflict", occurredAtMs, rootCid, localSha256: "aa".repeat(32), remoteSha256: "bb".repeat(32) };
}

async function seed(...records: readonly (PublishRecord | PullRecord | ConflictRecord)[]): Promise<void> {
  const store = await openHistoryStore({ directory });
  try {
    for (const record of records) await store.append(record);
  } finally {
    await store.close();
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

describe("the arguments", () => {
  it("knows --limit, only for history", () => {
    expect(parseCliArgs(["history"]).history).toEqual({ limit: undefined });
    expect(parseCliArgs(["history", "--limit", "5"]).history).toEqual({ limit: 5 });
    expect(parseCliArgs(["history", "--limit", "0"]).history).toEqual({ limit: 0 });
    expect(() => parseCliArgs(["history", "--limit", "abc"])).toThrow(UsageError);
    expect(() => parseCliArgs(["history", "--limit", "-1"])).toThrow(UsageError);
    expect(() => parseCliArgs(["history", "--limit", "1.5"])).toThrow(UsageError);
  });

  it("exits 2 for a bad --limit, for --limit on another command, and for an operand", async () => {
    for (const [args, pattern] of [
      [["--limit", "abc"], /--limit needs a non-negative whole number/],
      // `--limit -1` is refused by parseArgs itself (ambiguous option argument, exit 2); the `=` spelling reaches our check.
      [["--limit=-1"], /--limit needs a non-negative whole number/],
      [["--limit", "-1"], /usage error/],
      [["/vault"], /unexpected argument/],
    ] as const) {
      const result = await history(args);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.err.join("\n")).toMatch(pattern);
    }
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["status", "--limit", "3"], { env: stateEnv(), now: () => new Date(0), readText: readTextIfPresent }, { out: (t) => void out.push(t), err: (t) => void err.push(t) });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--limit is only valid for the history command");
  });

  it("documents the command, the flag and the prune-history distinction in the help text", () => {
    for (const phrase of ["ipfs-sync history [--limit <n>]", "--limit <n>", "history is NOT prune-history", "mutates the node", "no sync operations recorded on this device"]) {
      expect(HELP_TEXT, phrase).toContain(phrase);
    }
  });
});

describe("the listing", () => {
  it(
    "prints one line per record, newest first, with ISO timestamp, kind, root CID, counts and duration",
    async () => {
      await seed(publishRecord("bafy-oldest", 1_000_000), pullRecord("bafy-middle", 3_000_000), conflictRecord("bafy-newest", 2_000_000));
      const result = await history();
      expect(result.code).toBe(0);
      expect(result.err).toEqual([]);
      expect(result.out).toEqual([
        `${iso(3_000_000)}  pull      bafy-middle  fetched 2, unchanged 5, conflicted 1, failed 0, removed remotely 1, kept locally 1, 30 ms`,
        `${iso(2_000_000)}  conflict  bafy-newest  local sha256 ${"aa".repeat(32)}, remote sha256 ${"bb".repeat(32)}`,
        `${iso(1_000_000)}  publish   bafy-oldest  written 3, removed 1, 12 ms`,
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "--limit 1 prints exactly one row; the default caps at 20 and --limit 0 prints all",
    async () => {
      const records = Array.from({ length: HISTORY_DEFAULT_LIMIT + 5 }, (_, index) => publishRecord(`bafy-${index}`, 1_000_000 + index));
      await seed(...records);

      const one = await history(["--limit", "1"]);
      expect(one.code).toBe(0);
      expect(one.out).toHaveLength(1);
      expect(one.out[0]).toContain(`bafy-${HISTORY_DEFAULT_LIMIT + 4}`);

      const capped = await history();
      expect(capped.out).toHaveLength(HISTORY_DEFAULT_LIMIT);

      const all = await history(["--limit", "0"]);
      expect(all.out).toHaveLength(HISTORY_DEFAULT_LIMIT + 5);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "an empty database prints the empty line and exits 0",
    async () => {
      const store = await openHistoryStore({ directory });
      await store.close();
      const result = await history();
      expect(result.code).toBe(0);
      expect(result.out).toEqual([HISTORY_EMPTY_LINE]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a fresh device (no database at all) prints the empty line, exits 0 and creates nothing",
    async () => {
      // No node environment either: history needs no config, no node, no passphrase.
      const result = await history([], { XDG_STATE_HOME: root, HOME: "/nonexistent-home" });
      expect(result.code).toBe(0);
      expect(result.out).toEqual([HISTORY_EMPTY_LINE]);
      expect(result.err).toEqual([]);
      await expect(stat(directory)).rejects.toThrow();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "an existing database with an unknown schema version is a real error, fail-closed",
    async () => {
      await seed(publishRecord("bafy-kept", 1_000_000));
      const tamper = new PGlite(directory);
      await tamper.waitReady;
      await tamper.query("UPDATE schema_version SET version = $1", [SCHEMA_VERSION + 1]);
      await tamper.close();

      const result = await history();
      expect(result.code).toBe(1);
      expect(result.out).toEqual([]);
      expect(result.err.join("\n")).toMatch(/schema version/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "sends no request, even with --show-request",
    async () => {
      await seed(publishRecord("bafy-root", 1_000_000));
      const original = globalThis.fetch;
      const calls: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        throw new Error("history must never reach the network");
      }) as typeof fetch;
      try {
        const result = await history(["--show-request"]);
        expect(result.code).toBe(0);
        expect(calls).toEqual([]);
        expect(result.out.filter((line) => line.startsWith("request "))).toEqual([]);
        expect(result.out).toHaveLength(1);
      } finally {
        globalThis.fetch = original;
      }
    },
    TEST_TIMEOUT_MS,
  );
});
