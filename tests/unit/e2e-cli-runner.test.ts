import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertEffectiveTarget, CHILD_TIMEOUT_MS, isLoopbackUrl, makeCliRunner, makeDevice, type DeviceSpec } from "../e2e/harness/cli-runner";
import { createRunContext, removeRunDir, SUITE_KEY, SuiteRefusal, type RunContext } from "../e2e/harness/run-context";
import { loadTools07a } from "../e2e/harness/tools-07a";

/**
 * Offline unit tests of the e2e CLI child runner (task 1.4): the child environment allowlist and per-device state
 * home, the state-home refusal rules, the effective-target assertion before spawn, and the passphrase/plaintext
 * needle scanning of child output. Nothing here talks to a node: the children spawned are fixture scripts in the
 * per-run temp dir, and the effective config is computed with the CLI's own loader against a `{}` config file.
 */
const PROXY = "http://127.0.0.1:9";

const contexts: RunContext[] = [];
async function runContext(): Promise<RunContext> {
  const context = await createRunContext();
  contexts.push(context);
  return context;
}
afterEach(async () => {
  for (const context of contexts.splice(0)) await removeRunDir(context);
});

async function deviceWithConfig(context: RunContext, name: string): Promise<DeviceSpec> {
  const device = await makeDevice(context, name);
  await writeFile(device.configFile, "{}\n");
  return device;
}

/** A fixture "CLI" in the per-run temp dir: optionally appends to a marker file, prints the given text and exits 0. */
async function fakeCli(context: RunContext, name: string, print: string, marker?: string): Promise<string> {
  const path = join(context.tempDir, name);
  const lines = ["import { appendFileSync } from \"node:fs\";"];
  if (marker !== undefined) lines.push(`appendFileSync(${JSON.stringify(marker)}, "spawned\\n");`);
  lines.push(`console.log(${JSON.stringify(print)});`);
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

/** libuv injects __CF_USER_TEXT_ENCODING into every spawned child on macOS; the runner cannot strip it. */
function childEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter((key) => key !== "__CF_USER_TEXT_ENCODING").sort();
}

describe("child environment", () => {
  it("a spawned child sees only the allowlisted environment and the per-run state home", async () => {
    const context = await runContext();
    const device = await deviceWithConfig(context, "device-a");
    const cli = join(context.tempDir, "env-dump-cli.mjs");
    await writeFile(cli, "console.log(JSON.stringify(process.env));\n");
    const runner = await makeCliRunner({
      context,
      device,
      proxyUrl: PROXY,
      secrets: () => [],
      cli,
      baseEnv: {
        PATH: "/bin",
        HOME: "/operator/home",
        TMPDIR: "/tmp",
        LANG: "en_US.UTF-8",
        LC_ALL: undefined,
        NODE_OPTIONS: "--require /evil.js",
        NODE_PATH: "/evil",
        HTTPS_PROXY: "http://proxy.example",
        IPFS_SYNC_RPC_URL: "https://elsewhere.example",
        IPFS_SYNC_MFS_ROOT: "/obsidian-vault-sync/other",
        IPFS_SYNC_PASSPHRASE: "operator-secret",
        IPFS_SYNC_PASSPHRASE_FILE: "/operator/passphrase.txt",
        IPFS_SYNC_KEY: "obsidian-vault-sync",
        IPFS_SYNC_DEVICE: "operator-device",
        XDG_STATE_HOME: "/operator/state",
        IPFS_SYNC_AUTH_TOKEN: "auth-token",
      },
    });
    const result = await runner("status", [], { passphraseFile: context.passphraseFile });
    expect(result.code).toBe(0);
    const env = JSON.parse(result.stdout) as Record<string, string>;
    expect(childEnvKeys(env)).toEqual(["HOME", "IPFS_SYNC_AUTH_TOKEN", "IPFS_SYNC_DEVICE", "IPFS_SYNC_PASSPHRASE_FILE", "LANG", "PATH", "TMPDIR", "XDG_STATE_HOME"]);
    expect(env.PATH).toBe("/bin");
    expect(env.IPFS_SYNC_AUTH_TOKEN).toBe("auth-token");
    expect(env.IPFS_SYNC_DEVICE).toBe("device-a");
    expect(env.XDG_STATE_HOME).toBe(device.stateHome);
    expect(env.HOME).toBe(device.homeDir);
    expect(env.IPFS_SYNC_PASSPHRASE_FILE).toBe(context.passphraseFile);
    expect(env.XDG_STATE_HOME.startsWith(`${context.tempDir}/`)).toBe(true);
    expect(env.HOME.startsWith(`${context.tempDir}/`)).toBe(true);
  });

  it("omits IPFS_SYNC_PASSPHRASE_FILE when no passphrase file is given", async () => {
    const context = await runContext();
    const device = await deviceWithConfig(context, "device-b");
    const cli = join(context.tempDir, "env-dump-cli.mjs");
    await writeFile(cli, "console.log(JSON.stringify(process.env));\n");
    const runner = await makeCliRunner({ context, device, proxyUrl: PROXY, secrets: () => [], cli, baseEnv: { PATH: "/bin", HOME: "/h", TMPDIR: "/tmp" } });
    const result = await runner("status");
    const env = JSON.parse(result.stdout) as Record<string, string>;
    expect(childEnvKeys(env)).toEqual(["HOME", "IPFS_SYNC_DEVICE", "PATH", "TMPDIR", "XDG_STATE_HOME"]);
  });
});

describe("per-device state home refusal", () => {
  it("refuses a state home inside the repository", async () => {
    const tools = await loadTools07a();
    const context = await runContext();
    const device = await deviceWithConfig(context, "device-c");
    const inside: DeviceSpec = { ...device, stateHome: join(tools.repoRoot, "e2e-state-should-not-exist") };
    await expect(makeCliRunner({ context, device: inside, proxyUrl: PROXY, secrets: () => [] })).rejects.toThrow(/inside the repository/);
  });

  it("refuses a relative state home and a relative HOME", async () => {
    const context = await runContext();
    const device = await deviceWithConfig(context, "device-d");
    await expect(makeCliRunner({ context, device: { ...device, stateHome: "state" }, proxyUrl: PROXY, secrets: () => [] })).rejects.toThrow(/must be absolute/);
    await expect(makeCliRunner({ context, device: { ...device, homeDir: "home" }, proxyUrl: PROXY, secrets: () => [] })).rejects.toThrow(/must be absolute/);
  });

  it("refuses a state home that is absolute and outside the repository but not under the per-run temp dir", async () => {
    const context = await runContext();
    const device = await deviceWithConfig(context, "device-e");
    await expect(makeCliRunner({ context, device: { ...device, stateHome: join(tmpdir(), "e2e-elsewhere") }, proxyUrl: PROXY, secrets: () => [] })).rejects.toThrow(/under the per-run temp dir/);
    // The temp dir itself does not qualify either: the state home must be its own directory below it.
    await expect(makeCliRunner({ context, device: { ...device, stateHome: context.tempDir }, proxyUrl: PROXY, secrets: () => [] })).rejects.toThrow(/under the per-run temp dir/);
  });

  it("accepts the layout makeDevice produces", async () => {
    const context = await runContext();
    const device = await deviceWithConfig(context, "device-f");
    await expect(makeCliRunner({ context, device, proxyUrl: PROXY, secrets: () => [] })).resolves.toBeTypeOf("function");
  });
});

describe("effective-target assertion before spawn", () => {
  it("pins the per-child timeout at 300_000 ms", () => {
    expect(CHILD_TIMEOUT_MS).toBe(300_000);
  });

  it("accepts the loopback proxy, the run root and the suite key", async () => {
    const context = await runContext();
    const device = await deviceWithConfig(context, "device-g");
    const argv = ["status", "--config", device.configFile, "--rpc-url", PROXY, "--gateway-url", PROXY, "--mfs-root", context.runRoot, "--key", SUITE_KEY];
    await expect(assertEffectiveTarget(argv, {}, { url: PROXY, runRoot: context.runRoot })).resolves.toBeUndefined();
  });

  it("refuses a foreign publication key", async () => {
    const context = await runContext();
    const device = await deviceWithConfig(context, "device-h");
    const argv = ["status", "--config", device.configFile, "--rpc-url", PROXY, "--gateway-url", PROXY, "--mfs-root", context.runRoot, "--key", "obsidian-vault-sync"];
    await expect(assertEffectiveTarget(argv, {}, { url: PROXY, runRoot: context.runRoot })).rejects.toThrow(/expected obsidian-vault-e2e/);
  });

  it("refuses an effective root outside the run root", async () => {
    const context = await runContext();
    const device = await deviceWithConfig(context, "device-i");
    for (const mfsRoot of ["/obsidian-vault-sync", "/obsidian-vault-sync/e2e-foreign00", `${context.runRoot}/../e2e-foreign00`]) {
      const argv = ["status", "--config", device.configFile, "--rpc-url", PROXY, "--gateway-url", PROXY, "--mfs-root", mfsRoot, "--key", SUITE_KEY];
      await expect(assertEffectiveTarget(argv, {}, { url: PROXY, runRoot: context.runRoot })).rejects.toThrow(SuiteRefusal);
    }
    const sibling = ["status", "--config", device.configFile, "--rpc-url", PROXY, "--gateway-url", PROXY, "--mfs-root", "/obsidian-vault-sync/e2e-foreign00", "--key", SUITE_KEY];
    await expect(assertEffectiveTarget(sibling, {}, { url: PROXY, runRoot: context.runRoot })).rejects.toThrow(/outside/);
  });

  it("refuses a non-loopback intended URL even when the configuration matches it", async () => {
    const context = await runContext();
    const device = await deviceWithConfig(context, "device-j");
    const argv = ["status", "--config", device.configFile, "--rpc-url", "https://ipfs.prometheusags.ai", "--gateway-url", "https://ipfs.prometheusags.ai", "--mfs-root", context.runRoot, "--key", SUITE_KEY];
    await expect(assertEffectiveTarget(argv, {}, { url: "https://ipfs.prometheusags.ai", runRoot: context.runRoot })).rejects.toThrow(/not a loopback URL/);
  });

  it("refuses a configuration that does not load", async () => {
    const context = await runContext();
    // The config file was never written: every command but publish needs it.
    const device = await makeDevice(context, "device-k");
    const argv = ["status", "--config", device.configFile, "--rpc-url", PROXY, "--gateway-url", PROXY, "--mfs-root", context.runRoot, "--key", SUITE_KEY];
    await expect(assertEffectiveTarget(argv, {}, { url: PROXY, runRoot: context.runRoot })).rejects.toThrow(/configuration does not load/);
  });

  it("the runner refuses the mismatch BEFORE the child is spawned", async () => {
    const context = await runContext();
    const device = await deviceWithConfig(context, "device-l");
    const marker = join(context.tempDir, "spawned-marker.txt");
    const cli = await fakeCli(context, "marker-cli.mjs", "ran", marker);
    const runner = await makeCliRunner({ context, device, proxyUrl: PROXY, secrets: () => [], cli });
    await expect(runner("status", [], { mfsRoot: "/obsidian-vault-sync/e2e-foreign00" })).rejects.toThrow(/refusing to start a child/);
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });
});

describe("output scanning and scrubbing", () => {
  it("redacts both passphrase spellings from child output and flags the leak", async () => {
    const context = await runContext();
    const device = await deviceWithConfig(context, "device-m");
    const cli = await fakeCli(context, "leak-cli.mjs", "unlock ABCDE-FGHIJ or ABCDEFGHIJ failed");
    const runner = await makeCliRunner({ context, device, proxyUrl: PROXY, secrets: () => ["ABCDE-FGHIJ", "ABCDEFGHIJ"], cli });
    const result = await runner("status");
    expect(result.code).toBe(0);
    expect(result.leaked).toBe(true);
    expect(result.stdout).toBe("unlock [redacted] or [redacted] failed\n");
    expect(result.stdout).not.toContain("ABCDE-FGHIJ");
    expect(result.stdout).not.toContain("ABCDEFGHIJ");
  });

  it("catches a fixture plaintext needle printed by a child", async () => {
    const context = await runContext();
    const device = await deviceWithConfig(context, "device-n");
    const cli = await fakeCli(context, "needle-cli.mjs", "the harbor lantern phrase");
    const runner = await makeCliRunner({
      context,
      device,
      proxyUrl: PROXY,
      secrets: () => [],
      needles: () => [{ label: 'body word "harbor lantern"', bytes: new TextEncoder().encode("harbor lantern") }],
      cli,
    });
    const result = await runner("status");
    expect(result.leaked).toBe(true);
    expect(result.needle).toBe('body word "harbor lantern"');
  });

  it("a clean child is not flagged", async () => {
    const context = await runContext();
    const device = await deviceWithConfig(context, "device-o");
    const cli = await fakeCli(context, "clean-cli.mjs", "ipfs-sync status: nothing to report");
    const runner = await makeCliRunner({
      context,
      device,
      proxyUrl: PROXY,
      secrets: () => ["ABCDE-FGHIJ", "ABCDEFGHIJ"],
      needles: () => [{ label: 'body word "harbor lantern"', bytes: new TextEncoder().encode("harbor lantern") }],
      cli,
    });
    const result = await runner("status");
    expect(result.code).toBe(0);
    expect(result.leaked).toBe(false);
    expect(result.needle).toBeUndefined();
    expect(result.stdout).toBe("ipfs-sync status: nothing to report\n");
  });
});

describe("loopback check (re-declared from 07a)", () => {
  it("accepts http loopback only", () => {
    expect(isLoopbackUrl("http://127.0.0.1:1234")).toBe(true);
    expect(isLoopbackUrl("http://localhost:5001")).toBe(true);
    expect(isLoopbackUrl("https://127.0.0.1:1234")).toBe(false);
    expect(isLoopbackUrl("http://10.0.0.1:5001")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
