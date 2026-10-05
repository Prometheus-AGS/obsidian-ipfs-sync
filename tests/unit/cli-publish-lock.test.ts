import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../cli/io";
import { readTextIfPresent } from "../../cli/load-config";
import { createNodeLockContext, createNodeLockFile, isProcessAlive } from "../../cli/publish-lock-file";
import { runCli, type CliDeps } from "../../cli/run";
import { writeFixtureVault } from "../../fixtures/generate-fixture-vault";
import { acquirePublishLock, decodeLock, encodeLock, LOCK_STALE_MS } from "../../src/sync/publish-lock";
import { createFakeNode, type FakeNode } from "../helpers/fake-kubo";
import { fakeNodeFetch } from "../helpers/fake-kubo-http";
import { initDiskVault, referencePassphraseSource } from "../helpers/cli-vault";
import { stateEnv } from "../helpers/cli-state-env";

const NOW = new Date("2026-09-30T12:00:00Z");

interface Sink {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
  readonly questions: string[];
}

function sink(answer: boolean | undefined): Sink {
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const io: CliIo = {
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    ...(answer === undefined ? {} : { confirm: async (q: string) => (questions.push(q), answer) }),
  };
  return { io, out, err, questions };
}

function deps(): CliDeps {
  return { env: stateEnv(), now: () => NOW, readText: readTextIfPresent, passphrase: referencePassphraseSource };
}

/** A process id that is certainly gone: a child that already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (child.pid === undefined) throw new Error("no pid");
  return child.pid;
}

describe("ipfs-sync publish: the cross-process lock", () => {
  let dir: string;
  let vault: string;
  let configPath: string;
  let node: FakeNode;
  let requests: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ipfs-sync-lock-"));
    vault = join(dir, "vault");
    configPath = join(dir, "cfg", "config.json");
    await writeFixtureVault(vault, 3);
    node = createFakeNode([{ name: "self", id: "k51self" }]);
    await initDiskVault(vault, "/obsidian-vault-sync/lock-test", node);
    requests = [];
    vi.stubGlobal("fetch", vi.fn(fakeNodeFetch(node, requests)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const publish = async (answer: boolean | undefined, extra: string[] = []) => {
    const s = sink(answer);
    const code = await runCli(["publish", vault, "--config", configPath, "--mfs-root", "/obsidian-vault-sync/lock-test", ...extra], deps(), s.io);
    return { code, out: s.out.join("\n"), err: s.err.join("\n"), questions: s.questions };
  };

  const lockPath = (): string => join(vault, ".ipfs-sync", "publish.lock");
  const lockExists = (): Promise<boolean> => stat(lockPath()).then(() => true, () => false);
  const holder = () => acquirePublishLock(createNodeLockFile(vault), createNodeLockContext(() => NOW.getTime()));

  it("takes the lock for the publish and removes it afterwards, also when the publish fails", async () => {
    expect((await publish(undefined)).code).toBe(0);
    expect(await lockExists()).toBe(false);
    const failing = await publish(undefined, ["--mfs-root", "/obsidian-vault-staging"]);
    expect(failing.code).toBe(2);
    expect(await lockExists()).toBe(false);
    expect((await readdir(join(vault, ".ipfs-sync"))).filter((name) => name.includes("lock"))).toEqual([]);
  });

  it("stops a second publish while a live holder has a fresh heartbeat, naming the lock, and sends nothing", async () => {
    const lock = await holder();
    const result = await publish(undefined);
    await lock.release();
    expect(result.code).toBe(1);
    expect(result.err).toContain("another publish is running in this vault");
    expect(result.err).toContain(`process ${process.pid} on ${hostname()}`);
    expect(result.err).toContain("--break-lock");
    expect(requests).toEqual([]);
  });

  it("replaces a lock at once when its process is gone from this host, even with a fresh heartbeat", async () => {
    await mkdir(join(vault, ".ipfs-sync"), { recursive: true });
    const crashed = { token: "stale-token", pid: deadPid(), host: hostname(), time: NOW.getTime() - 1000 };
    await writeFile(lockPath(), encodeLock(crashed));
    expect(isProcessAlive(crashed.pid)).toBe(false);
    const result = await publish(undefined);
    expect(result.code).toBe(0);
    expect(await lockExists()).toBe(false);
  });

  it("replaces a lock from another host that has had no heartbeat for 15 minutes, and not one that is younger", async () => {
    await mkdir(join(vault, ".ipfs-sync"), { recursive: true });
    await writeFile(lockPath(), encodeLock({ token: "t", pid: process.pid, host: "some-other-host", time: NOW.getTime() - LOCK_STALE_MS + 60_000 }));
    expect((await publish(undefined)).code).toBe(1);
    expect(requests).toEqual([]);

    await writeFile(lockPath(), encodeLock({ token: "t", pid: process.pid, host: "some-other-host", time: NOW.getTime() - LOCK_STALE_MS - 1000 }));
    expect((await publish(undefined)).code).toBe(0);
  });

  it("does not replace a lock whose process is alive here and whose heartbeat is fresh", async () => {
    await mkdir(join(vault, ".ipfs-sync"), { recursive: true });
    await writeFile(lockPath(), encodeLock({ token: "t", pid: process.pid, host: hostname(), time: NOW.getTime() - 60_000 }));
    expect((await publish(undefined)).code).toBe(1);
    expect(requests).toEqual([]);
  });

  it("--break-lock removes the lock after a yes and the publish continues; a no leaves it and stops", async () => {
    const lock = await holder();
    const declined = await publish(false, ["--break-lock"]);
    expect(declined.code).toBe(1);
    expect(declined.questions[0]).toContain(`process ${process.pid} on ${hostname()}`);
    expect(await lockExists()).toBe(true);
    expect(requests).toEqual([]);

    const accepted = await publish(true, ["--break-lock"]);
    await lock.release();
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain("publish lock removed");
    expect(requests.length).toBeGreaterThan(0);
    expect(await lockExists()).toBe(false);
  });

  it("--break-lock cannot ask when there is no terminal, so it leaves the lock alone", async () => {
    const lock = await holder();
    const result = await publish(undefined, ["--break-lock"]);
    await lock.release();
    expect(result.code).toBe(1);
    expect(result.out).toContain("publish lock left in place");
  });

  it("--break-lock with no lock says so and publishes", async () => {
    const result = await publish(true, ["--break-lock"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("no publish lock to remove");
  });

  it("--break-lock is only valid for publish", async () => {
    const s = sink(undefined);
    expect(await runCli(["status", "--break-lock"], deps(), s.io)).toBe(2);
    expect(s.err.join("\n")).toContain("--break-lock is only valid for the publish command");
  });

  it("a publish that refuses before doing work (no encrypted vault at the MFS root, no marker needed) writes nothing: no lock file, no state folder, no node write", async () => {
    const real = join(dir, "real");
    await mkdir(real);
    await writeFile(join(real, "note.md"), "private");
    const s = sink(undefined);
    expect(await runCli(["publish", real, "--config", configPath], deps(), s.io)).toBe(1);
    expect(s.err.join("\n")).toContain("this MFS root holds no encrypted vault yet");
    // The lock is taken before the vault check (the marker guard that used to refuse first is gone), so an empty .ipfs-sync folder may remain; the lock file and any state may not.
    expect((await readdir(real)).filter((name) => name !== ".ipfs-sync")).toEqual(["note.md"]);
    expect(await readdir(join(real, ".ipfs-sync")).catch(() => [])).toEqual([]);
    expect(requests.filter((r) => /\/api\/v0\/(files\/(write|mkdir|rm|cp|mv|flush)|add|name\/publish|pin)/.test(r))).toEqual([]);
  });

  it("the lock file holds the token, process id, host and time, and is private to the user", async () => {
    const lock = await holder();
    const record = decodeLock(new Uint8Array(await readFile(lockPath())));
    expect(record).toMatchObject({ pid: process.pid, host: hostname(), time: NOW.getTime() });
    expect(record?.token).toMatch(/^[0-9a-f]{32}$/);
    if (process.platform !== "win32") expect((await stat(lockPath())).mode & 0o077).toBe(0);
    await lock.release();
  });

  it("W-05: two real takers that saw the same stale lock: one wins, the other is refused, the winner's file survives", async () => {
    await mkdir(join(vault, ".ipfs-sync"), { recursive: true });
    await writeFile(lockPath(), encodeLock({ token: "stale-token", pid: deadPid(), host: hostname(), time: NOW.getTime() - LOCK_STALE_MS * 2 }));
    const settled = await Promise.allSettled([holder(), holder()]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect((settled.find((s) => s.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "lock-held" });
    expect(await lockExists()).toBe(true);
    expect((await readdir(join(vault, ".ipfs-sync"))).filter((name) => name.endsWith(".taken") || name.endsWith(".tmp"))).toEqual([]);
    const winner = settled.find((s) => s.status === "fulfilled") as PromiseFulfilledResult<{ release(): Promise<void> }>;
    await winner.value.release();
  });

  it("N3-03: writeIfToken replaces the lock only while it still holds the expected token, and leaves no temporary file", async () => {
    const file = createNodeLockFile(vault);
    const mine = encodeLock({ token: "mine", pid: process.pid, host: hostname(), time: NOW.getTime() });
    const refreshed = encodeLock({ token: "mine", pid: process.pid, host: hostname(), time: NOW.getTime() + 60_000 });
    const theirs = encodeLock({ token: "theirs", pid: 1, host: "elsewhere", time: NOW.getTime() });
    expect(await file.writeIfToken?.("mine", refreshed)).toBe(false); // no lock file yet
    expect(await lockExists()).toBe(false);
    expect(await file.createExclusive(mine)).toBe(true);
    expect(await file.writeIfToken?.("mine", refreshed)).toBe(true);
    expect(decodeLock(new Uint8Array(await readFile(lockPath())))?.time).toBe(NOW.getTime() + 60_000);
    await writeFile(lockPath(), theirs);
    expect(await file.writeIfToken?.("mine", refreshed)).toBe(false);
    expect(decodeLock(new Uint8Array(await readFile(lockPath())))?.token).toBe("theirs");
    expect((await readdir(join(vault, ".ipfs-sync"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    if (process.platform !== "win32") expect((await stat(lockPath())).mode & 0o077).toBe(0);
  });
});
