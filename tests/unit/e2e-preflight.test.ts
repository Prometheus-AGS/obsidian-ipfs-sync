import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adoptSuiteKey, enginesNodeRequirement, nodeVersionRefusal, probeNode, staleBuildRefusal, type PreflightClient } from "../e2e/harness/preflight";
import { SUITE_KEY, SuiteRefusal } from "../e2e/harness/run-context";

/**
 * Offline unit tests of the e2e preflights (task 1.2, design decision 5): the node-version floor, the build-freshness
 * refusal on a fixture tree, the bounded node probe (fail, never skip), and suite-key adoption against a fixture
 * owned-keys config. No node is contacted; probe clients are fakes.
 */
const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

describe("node version floor", () => {
  it("reads the engines.node floor from package.json", async () => {
    expect(await enginesNodeRequirement(REPO)).toBe(">=24.15.0");
  });

  it("refuses a node below the floor and names the PATH fix", () => {
    const refusal = nodeVersionRefusal("v24.11.1", ">=24.15.0");
    expect(refusal).toBeDefined();
    expect(refusal).toContain("PATH=/opt/homebrew/bin");
    expect(refusal).toContain("v24.11.1");
    expect(refusal).toContain(">=24.15.0");
  });

  it("accepts the floor and anything above it", () => {
    expect(nodeVersionRefusal("v24.15.0", ">=24.15.0")).toBeUndefined();
    expect(nodeVersionRefusal("v24.15.7", ">=24.15.0")).toBeUndefined();
    expect(nodeVersionRefusal("v25.0.0", ">=24.15.0")).toBeUndefined();
    expect(nodeVersionRefusal("v23.99.99", ">=24.15.0")).toBeDefined();
    expect(nodeVersionRefusal("v24.14.9", ">=24.15.0")).toBeDefined();
  });

  it("refuses an unparseable version or requirement instead of passing silently", () => {
    expect(nodeVersionRefusal("not-a-version", ">=24.15.0")).toBeDefined();
    expect(nodeVersionRefusal("v24.15.0", "^24.15.0")).toBeDefined();
  });
});

describe("build freshness (the 07a checkBuildFresh pattern; the suite never builds)", () => {
  const fixtureRepo = async (): Promise<string> => {
    const repo = await mkdtemp(join(tmpdir(), "e2e-preflight-repo-"));
    await mkdir(join(repo, "cli"), { recursive: true });
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "dist", "cli"), { recursive: true });
    await writeFile(join(repo, "cli", "run.ts"), "// cli source\n");
    await writeFile(join(repo, "src", "main.ts"), "// src source\n");
    return repo;
  };
  const setMtime = async (path: string, date: Date): Promise<void> => utimes(path, date, date);

  it("refuses a missing dist/cli/ipfs-sync.mjs", async () => {
    const repo = await fixtureRepo();
    try {
      const refusal = await staleBuildRefusal(repo);
      expect(refusal).toContain("dist/cli/ipfs-sync.mjs does not exist");
      expect(refusal).toContain("pnpm build");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("refuses a build older than a cli/ or src/ source", async () => {
    const repo = await fixtureRepo();
    try {
      const cli = join(repo, "dist", "cli", "ipfs-sync.mjs");
      await writeFile(cli, "// built\n");
      await setMtime(cli, new Date("2026-01-01T00:00:00Z"));
      await setMtime(join(repo, "cli", "run.ts"), new Date("2026-01-01T00:00:00Z"));
      await setMtime(join(repo, "src", "main.ts"), new Date("2026-02-01T00:00:00Z"));
      const refusal = await staleBuildRefusal(repo);
      expect(refusal).toContain("is older than src/main.ts");
      expect(refusal).toContain("the suite never builds");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("accepts a build newer than every source", async () => {
    const repo = await fixtureRepo();
    try {
      await setMtime(join(repo, "cli", "run.ts"), new Date("2026-01-01T00:00:00Z"));
      await setMtime(join(repo, "src", "main.ts"), new Date("2026-01-01T00:00:00Z"));
      await writeFile(join(repo, "dist", "cli", "ipfs-sync.mjs"), "// built\n");
      expect(await staleBuildRefusal(repo)).toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("node probe (fail, never skip)", () => {
  const okClient = (): PreflightClient => ({
    version: () => Promise.resolve({ Version: "0.42.0" }),
    keyList: () => Promise.resolve([{ name: "self", id: "k51self" }]),
    keyGen: () => Promise.resolve({}),
  });

  it("returns version and keys when the node answers", async () => {
    const probe = await probeNode(okClient(), "https://node.example");
    expect(probe.keys).toHaveLength(1);
  });

  it("fails naming the node address and the error when the probe rejects", async () => {
    const down: PreflightClient = { ...okClient(), version: () => Promise.reject(new Error("connect ECONNREFUSED")) };
    await expect(probeNode(down, "https://node.example")).rejects.toThrow(/node probe failed against https:\/\/node\.example: connect ECONNREFUSED/);
  });

  it("fails on a bounded timeout instead of hanging", async () => {
    const slow: PreflightClient = { ...okClient(), version: () => new Promise(() => undefined) };
    await expect(probeNode(slow, "https://node.example", { timeoutMs: 25 })).rejects.toThrow(/timed out after 25 ms/);
  });
});

describe("suite key adoption", () => {
  const configDir = async (): Promise<string> => mkdtemp(join(tmpdir(), "e2e-owned-keys-"));

  it("generates the key only when absent and records its ID in the per-machine config", async () => {
    const dir = await configDir();
    try {
      const configFile = join(dir, "config.json");
      let generated = 0;
      const client: PreflightClient = {
        version: () => Promise.resolve({}),
        keyGen: (name) => {
          generated += 1;
          expect(name).toBe(SUITE_KEY);
          return Promise.resolve({});
        },
        keyList: () => Promise.resolve(generated === 0 ? [] : [{ name: SUITE_KEY, id: "k51suitekey" }]),
      };
      const adoption = await adoptSuiteKey(client, configFile);
      expect(adoption).toEqual({ created: true, keyId: "k51suitekey" });
      expect(generated).toBe(1);
      expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({ ownedKeys: ["k51suitekey"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("adopts a present key whose ID is recorded", async () => {
    const dir = await configDir();
    try {
      const configFile = join(dir, "config.json");
      await writeFile(configFile, `${JSON.stringify({ ownedKeys: ["k51suitekey"] })}\n`);
      const client: PreflightClient = {
        version: () => Promise.resolve({}),
        keyGen: () => Promise.reject(new Error("key/gen must not run when the key is present")),
        keyList: () => Promise.resolve([{ name: SUITE_KEY, id: "k51suitekey" }]),
      };
      expect(await adoptSuiteKey(client, configFile)).toEqual({ created: false, keyId: "k51suitekey" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a present key whose ID is not recorded — never adopted silently", async () => {
    const dir = await configDir();
    try {
      const configFile = join(dir, "config.json");
      const client: PreflightClient = {
        version: () => Promise.resolve({}),
        keyGen: () => Promise.reject(new Error("key/gen must not run when the key is present")),
        keyList: () => Promise.resolve([{ name: SUITE_KEY, id: "k51foreign" }]),
      };
      await expect(adoptSuiteKey(client, configFile)).rejects.toThrow(SuiteRefusal);
      await expect(adoptSuiteKey(client, configFile)).rejects.toThrow(/never adopted silently/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
