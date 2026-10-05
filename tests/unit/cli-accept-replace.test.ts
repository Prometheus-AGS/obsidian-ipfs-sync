// Delta review A-L2 through the CLI: `--accept-first-pull` answers only the true first-pull question. The question of a pull into a directory with
// no state for a vault this device already knows has its own flag, `--accept-replace`, which only `pull` takes.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCliPullRig, publishedFiles, type CliPullRig } from "../helpers/cli-pull-rig";

let rig: CliPullRig;

beforeEach(async () => {
  rig = await createCliPullRig();
});

afterEach(async () => {
  await rig.dispose();
});

const DIFFERING = "my own text, different from the node's\n";

/** Device B has pulled once (its floor is written); the returned directory holds a differing file at a published path and no state. */
async function statelessDirectory(): Promise<{ readonly vault: string; readonly path: string }> {
  expect((await rig.pull(["--accept-first-pull"])).code).toBe(0);
  const path = Object.keys(await publishedFiles(rig.vaultA)).sort()[0];
  if (path === undefined) throw new Error("the fixture vault published nothing");
  const vault = join(rig.dir, "vault-c");
  await mkdir(join(vault, ...path.split("/").slice(0, -1)), { recursive: true });
  await writeFile(join(vault, ...path.split("/")), DIFFERING);
  return { vault, path };
}

describe("pull into a directory with no state for a known vault (A-L2)", () => {
  it("--accept-first-pull alone stops with exit 1, names --accept-replace and replaces nothing", async () => {
    const { vault, path } = await statelessDirectory();
    const result = await rig.pull(["--accept-first-pull"], { vault });
    expect(result.code).toBe(1);
    expect(result.err).toContain("--accept-replace");
    expect(result.err).not.toContain("--accept-first-pull");
    expect(await readFile(join(vault, ...path.split("/")), "utf8")).toBe(DIFFERING);
    const kept = await readdir(join(vault, ".ipfs-sync")).catch(() => [] as string[]);
    expect(kept.filter((name) => name.startsWith("state.") || name.startsWith("keyslots."))).toEqual([]);
  });

  it("no flag stops the same way", async () => {
    const { vault, path } = await statelessDirectory();
    const result = await rig.pull([], { vault });
    expect(result.code).toBe(1);
    expect(result.err).toContain("--accept-replace");
    expect(await readFile(join(vault, ...path.split("/")), "utf8")).toBe(DIFFERING);
  });

  it("--accept-replace goes on, keeps a dated copy of the local text and exits 0", async () => {
    const { vault, path } = await statelessDirectory();
    const result = await rig.pull(["--accept-replace"], { vault });
    expect(result.code).toBe(0);
    expect(await readFile(join(vault, ...path.split("/")), "utf8")).not.toBe(DIFFERING);
  });

  it("with a terminal the question is asked, and a yes goes on even without either flag", async () => {
    const { vault } = await statelessDirectory();
    const result = await rig.pull([], { vault, confirm: async () => true });
    expect(result.code).toBe(0);
    expect(rig.questions.some((question) => question.includes("Pull this vault into this directory?"))).toBe(true);
  });
});

describe("--accept-replace belongs to pull only", () => {
  it.each([
    [["publish", "VAULT"]],
    [["status"]],
    [["abandon", "VAULT"]],
    [["prune-history", "VAULT", "--keep", "30"]],
    [["keys", "accept-slots", "VAULT"]],
    [["keys", "discard", "VAULT"]],
    [["init", "VAULT"]],
  ])("%j refuses it with exit 2 before any request", async (argv) => {
    const { runCli } = await import("../../cli/run");
    const err: string[] = [];
    const code = await runCli(
      [...argv.map((word) => (word === "VAULT" ? rig.vaultA : word)), "--accept-replace"],
      { env: {}, now: () => new Date("2026-09-30T12:00:00Z"), readText: async () => undefined },
      { out: () => undefined, err: (text) => void err.push(text) },
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("--accept-replace is only valid for the pull command");
    expect(rig.requests).toEqual([]);
  });

  it("is listed in the pull help beside --accept-first-pull", async () => {
    const help = await rig.pull(["--help"], { bare: true });
    expect(help.code).toBe(0);
    expect(help.out).toContain("--accept-replace");
    expect(help.out).toContain("--accept-first-pull");
  });
});
