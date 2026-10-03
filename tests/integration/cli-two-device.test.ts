// mvp-07a task 6.1 through the real CLI entry (`runCli`): device A is a fixture vault on disk that publishes, device B is an absent
// directory that pulls, publishes and abandons; both use the real kubo client over one recording fake node. Covers the wrong-passphrase
// flow, the fork flow with `--resolve-fork`, the no-state restore by `--manifest` followed by a publish that says pull first, abandon then
// an older first pull (the floor), replay by `--root-cid` with and without the flag, exit codes of skipped paths, mixed history names, and
// the read-only audit of the requests.
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MFS_ROOT, createCliPullRig, historyNames, publishedFiles, summary, vaultFiles, type CliPullRig } from "../helpers/cli-pull-rig";
import { stateEnv } from "../helpers/cli-state-env";
import { cliAbandonB, cliPublishB, dropStateOfB, secondNode, useNode } from "../helpers/cli-two-device";
import { sortHistoryNames } from "../../src/sync/history-names";
import { otherPassphrase } from "../vectors/slot-helpers";
import type { FakeNode } from "../helpers/fake-kubo";

const BLOB_GET = /^GET \/ipfs\/[^/]+\/[a-z2-7]{2}\/[a-z2-7]{52}$/;
/** Every request a pull may send. */
const PULL_READS = /^(key\/list|name\/resolve|ls|files\/stat|files\/ls|GET \/ipfs\/.+)$/;
const yes = async (): Promise<boolean> => true;
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

let rig: CliPullRig;

beforeEach(async () => {
  rig = await createCliPullRig();
});

afterEach(async () => {
  await rig.dispose();
});

/** The name of `node` serves the root of its finished MFS tree (what a publish leaves behind). */
function serveRootOf(node: FakeNode): string {
  const root = node.cidOf(MFS_ROOT);
  if (root === undefined) throw new Error("the MFS root does not exist");
  node.published.set(rig.keyId(), `/ipfs/${root}`);
  return root;
}

describe("the first pull", () => {
  it("shows the authenticated sequence and device and, on a no at the prompt, writes nothing; a yes then pulls the vault byte for byte, reading the node only", async () => {
    const declined = await rig.pull([], { confirm: async () => false });
    expect(declined.code).toBe(1);
    expect(`${declined.out}\n${declined.err}`).toMatch(/sequence\s+1\b/);
    expect((await vaultFiles(rig.vaultB)) ?? {}).toEqual({});
    expect(await exists(join(rig.stateB, "ipfs-sync", "sequence-floor.json"))).toBe(false);
    expect(rig.requests.filter((request) => BLOB_GET.test(request))).toEqual([]);

    const accepted = await rig.pull([], { confirm: yes });
    expect(summary(accepted)).toEqual({ code: 0, err: "" });
    expect(await vaultFiles(rig.vaultB)).toEqual(await publishedFiles(rig.vaultA));
    expect(rig.requests.filter((request) => !PULL_READS.test(request))).toEqual([]);
  });
});

describe("the wrong passphrase", () => {
  it("is one failure that changes nothing: no file, record, key-slot copy or floor, and no blob requested; the right one then pulls", async () => {
    const wrong = await rig.pull(["--accept-first-pull"], { deps: { passphrase: async () => otherPassphrase() } });

    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/wrong passphrase|damaged/i);
    expect(wrong.err).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAJ6");
    expect((await vaultFiles(rig.vaultB)) ?? {}).toEqual({});
    expect(await exists(join(rig.vaultB, ".ipfs-sync-fixture"))).toBe(false);
    expect((await readdir(join(rig.vaultB, ".ipfs-sync")).catch(() => [])).filter((name) => name !== "tmp")).toEqual([]);
    expect(await exists(join(rig.stateB, "ipfs-sync", "sequence-floor.json"))).toBe(false);
    expect(rig.requests.filter((request) => BLOB_GET.test(request))).toEqual([]);

    const right = await rig.pull(["--accept-first-pull"]);
    expect(summary(right)).toEqual({ code: 0, err: "" });
    expect(await vaultFiles(rig.vaultB)).toEqual(await publishedFiles(rig.vaultA));
  });
});

describe("a fork through the CLI", () => {
  it("two publishes at one sequence, then pull --resolve-fork: the node's text takes the path, this device's text is in the dated copy, and the next publish is sequence 3", async () => {
    expect(summary(await rig.pull(["--accept-first-pull"]))).toEqual({ code: 0, err: "" });
    const nodeB = secondNode(rig);
    const node1 = rig.node;

    // Device A publishes its sequence 2 to the first node ...
    await writeFile(join(rig.vaultA, "inbox.md"), "# Inbox\n\nwritten on device A\n");
    expect((await rig.publish()).code).toBe(0);
    const rootOfX = serveRootOf(node1);

    // ... and device B publishes its own sequence 2 to the other node (the later name publication of a real race).
    useNode(rig, nodeB);
    await writeFile(join(rig.vaultB, "inbox.md"), "# Inbox\n\nwritten on device B\n");
    const publishedB = await cliPublishB(rig);
    expect(summary(publishedB)).toEqual({ code: 0, err: "" });
    expect(publishedB.out).toContain("sequence  2");
    const rootOfY = serveRootOf(nodeB);
    expect(rootOfY).not.toBe(rootOfX);

    // Device A looks at the node that now serves Y. Without the flag: a fork, and the text names the flag.
    const vaultAEnv = stateEnv();
    const refused = await rig.pull([], { vault: rig.vaultA, deps: { env: vaultAEnv } });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--resolve-fork");
    expect(await readFile(join(rig.vaultA, "inbox.md"), "utf8")).toContain("written on device A");

    // With the flag (it needs a terminal and a yes): the node's text at the path, A's text beside it.
    const resolved = await rig.pull(["--resolve-fork"], { vault: rig.vaultA, deps: { env: vaultAEnv }, confirm: yes });
    expect(summary(resolved)).toEqual({ code: 0, err: "" });
    expect(await readFile(join(rig.vaultA, "inbox.md"), "utf8")).toContain("written on device B");
    const copies = (await readdir(rig.vaultA)).filter((name) => name.includes("ipfs conflict"));
    expect(copies).toHaveLength(1);
    expect(await readFile(join(rig.vaultA, copies[0] ?? ""), "utf8")).toContain("written on device A");

    // The next publish from A (now against the node that serves Y) is sequence 3 and carries the copy.
    const next = await rig.publish();
    expect(summary(next)).toEqual({ code: 0, err: "" });
    expect(next.out).toContain("sequence  3");
    serveRootOf(nodeB);
    const pulledByB = await rig.pull([]);
    expect(pulledByB.code).toBe(0);
    expect(await readFile(join(rig.vaultB, copies[0] ?? ""), "utf8")).toContain("written on device A");
  });
});

describe("restore without a state, then publish", () => {
  it("a no-state restore by --manifest is accepted with the flag (the floor is the record) and the following publish says to pull first", async () => {
    const first = await rig.manifest();
    await writeFile(join(rig.vaultA, "inbox.md"), "# Inbox\n\nsecond edition\n");
    expect((await rig.publish()).code).toBe(0);
    rig.repoint();
    expect(summary(await rig.pull(["--accept-first-pull"]))).toEqual({ code: 0, err: "" });
    await dropStateOfB(rig);
    expect(await exists(join(rig.stateB, "ipfs-sync", "sequence-floor.json"))).toBe(true);

    // The older sequence is refused without the flag (the floor is higher) and accepted with it.
    const refused = await rig.pull(["--manifest", first.rootCID, "--accept-first-pull"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--allow-rollback");
    const restored = await rig.pull(["--manifest", first.rootCID, "--allow-rollback", "--accept-first-pull"]);
    expect(summary(restored)).toEqual({ code: 0, err: "" });
    expect(restored.out).toContain("not removed");
    expect(await readFile(join(rig.vaultB, "inbox.md"), "utf8")).not.toContain("second edition");

    // The record the restore created describes the older manifest, so a publish finds the node ahead.
    rig.requests.length = 0;
    const publish = await cliPublishB(rig);
    expect(publish.code).toBe(1);
    expect(publish.err).toContain("pull first");
    expect(rig.requests.filter((request) => /^(files\/(write|rm)|key\/gen|pin\/add|name\/publish)$/.test(request))).toEqual([]);

    // A plain pull brings the newer sequence in; then the publish goes through.
    expect(summary(await rig.pull([]))).toEqual({ code: 0, err: "" });
    const published = await cliPublishB(rig);
    expect(summary(published)).toEqual({ code: 0, err: "" });
    expect(published.out).toContain("sequence  3");
  });
});

describe("abandon, then an older first pull", () => {
  it("the floor survives abandon and refuses the older state, naming the recorded sequence; the current one pulls again", async () => {
    const olderRoot = rig.repoint();
    await writeFile(join(rig.vaultA, "inbox.md"), "# Inbox\n\nsecond edition\n");
    expect((await rig.publish()).code).toBe(0);
    const newestRoot = rig.repoint();
    expect(summary(await rig.pull(["--accept-first-pull"]))).toEqual({ code: 0, err: "" });
    const before = await vaultFiles(rig.vaultB);

    const abandoned = await cliAbandonB(rig);
    expect(abandoned.code).toBe(0);
    expect(abandoned.out).toContain("sequence floor kept: 2");

    rig.node.published.set(rig.keyId(), `/ipfs/${olderRoot}`);
    rig.requests.length = 0;
    const older = await rig.pull(["--accept-first-pull"]);
    expect(older.code).toBe(1);
    expect(older.err).toContain("recorded sequence 2");
    expect(rig.requests.filter((request) => BLOB_GET.test(request))).toEqual([]);
    expect(await vaultFiles(rig.vaultB)).toEqual(before);

    rig.node.published.set(rig.keyId(), `/ipfs/${newestRoot}`);
    expect(summary(await rig.pull(["--accept-first-pull"]))).toEqual({ code: 0, err: "" });
  });
});

describe("replay by --root-cid", () => {
  it("is refused without --allow-rollback, restored with it, and the next publish carries the restored text", async () => {
    const olderRoot = rig.repoint();
    await writeFile(join(rig.vaultA, "inbox.md"), "# Inbox\n\nsecond edition\n");
    expect((await rig.publish()).code).toBe(0);
    rig.repoint();
    expect(summary(await rig.pull(["--accept-first-pull"]))).toEqual({ code: 0, err: "" });

    const refused = await rig.pull(["--root-cid", olderRoot]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--allow-rollback");
    expect(await readFile(join(rig.vaultB, "inbox.md"), "utf8")).toContain("second edition");

    const restored = await rig.pull(["--root-cid", olderRoot, "--allow-rollback"]);
    expect(summary(restored)).toEqual({ code: 0, err: "" });
    expect(restored.out).toContain("restore");
    expect(await readFile(join(rig.vaultB, "inbox.md"), "utf8")).not.toContain("second edition");

    const published = await cliPublishB(rig);
    expect(summary(published)).toEqual({ code: 0, err: "" });
    expect(published.out).toContain("sequence  3");
  });
});

describe("exit codes of skipped paths", () => {
  it("an older build's .obsidian/ entry is expected: exit 0, listed apart, nothing written for it", async () => {
    await rig.addManifestPaths([".obsidian/app.json"]);
    const expected = await rig.pull(["--accept-first-pull"]);
    expect(summary(expected)).toEqual({ code: 0, err: "" });
    expect(expected.out).toContain("skipped (expected) .obsidian/app.json");
    expect(await exists(join(rig.vaultB, ".obsidian"))).toBe(false);
  });

  it("a plugin path is unsafe: exit 1 and nothing is written for it", async () => {
    await rig.addManifestPaths([".obsidian/plugins/x/main.js"]);
    const unsafe = await rig.pull(["--accept-first-pull"]);
    expect(unsafe.code).toBe(1);
    expect(unsafe.err).toContain("skipped (unsafe, shape) .obsidian/plugins/x/main.js");
    expect(await exists(join(rig.vaultB, ".obsidian"))).toBe(false);
  });
});

describe("hostile text in a path", () => {
  it("a path with a C1 control character or a bidi override is skipped as unsafe and shown escaped: the terminal never receives the raw character", async () => {
    await rig.addManifestPaths(["notes/a\u009bb.md", "notes/\u202etxt.exe"]);

    const result = await rig.pull(["--accept-first-pull"]);

    expect(result.code).toBe(1);
    const shown = `${result.out}\n${result.err}`;
    expect(shown).toContain("skipped (unsafe");
    expect(shown).not.toContain("\u009b");
    expect(shown).not.toContain("\u202e");
    expect((await readdir(join(rig.vaultB, "notes"))).filter((name) => /[\u009b\u202e]/.test(name))).toEqual([]);
  });
});

describe("history names, mixed", () => {
  it("--list-versions puts the legacy name last, and a publish into the mixed folder and a pull by the legacy name both work", async () => {
    const first = await rig.manifest();
    await writeFile(join(rig.vaultA, "inbox.md"), "# Inbox\n\nsecond edition\n");
    expect((await rig.publish()).code).toBe(0);
    const [prefixedOne] = historyNames(rig.node);
    const bytes = rig.node.files.get(`${MFS_ROOT}/manifests/${prefixedOne}`);
    if (prefixedOne === undefined || bytes === undefined) throw new Error("the fixture changed");
    rig.node.files.delete(`${MFS_ROOT}/manifests/${prefixedOne}`);
    rig.node.files.set(`${MFS_ROOT}/manifests/${first.rootCID}.enc`, bytes);
    rig.repoint();

    await writeFile(join(rig.vaultA, "inbox.md"), "# Inbox\n\nthird edition\n");
    expect((await rig.publish()).code).toBe(0);
    rig.repoint();
    expect(sortHistoryNames(historyNames(rig.node)).map((entry) => entry.sequence)).toEqual([undefined, 2, 3]);

    const listed = await rig.pull(["--list-versions"]);
    expect(listed.code).toBe(0);
    const lines = listed.out.split("\n").filter((line) => line.startsWith("  sequence ") || line.startsWith("  legacy"));
    expect(lines.map((line) => /^ {2}(sequence \d+|legacy)\s/.exec(line)?.[1])).toEqual(["sequence 3", "sequence 2", "legacy"]);

    expect(summary(await rig.pull(["--accept-first-pull"]))).toEqual({ code: 0, err: "" });
    const restored = await rig.pull(["--manifest", first.rootCID, "--allow-rollback"]);
    expect(summary(restored)).toEqual({ code: 0, err: "" });
    expect(await readFile(join(rig.vaultB, "inbox.md"), "utf8")).not.toContain("edition");
  });
});

describe("every pull request is a read", () => {
  it("first pull, newer pull, restore and listing send only key/list, name/resolve, ls, files/stat, files/ls and gateway reads", async () => {
    const first = await rig.manifest();
    rig.requests.length = 0;
    expect(summary(await rig.pull(["--accept-first-pull"]))).toEqual({ code: 0, err: "" });
    await writeFile(join(rig.vaultA, "inbox.md"), "# Inbox\n\nsecond edition\n");
    expect((await rig.publish()).code).toBe(0);
    rig.repoint();
    rig.requests.length = 0;
    expect(summary(await rig.pull([]))).toEqual({ code: 0, err: "" });
    expect(summary(await rig.pull(["--manifest", first.rootCID, "--allow-rollback"]))).toEqual({ code: 0, err: "" });
    expect(summary(await rig.pull(["--list-versions"]))).toEqual({ code: 0, err: "" });

    expect(rig.requests.length).toBeGreaterThan(0);
    expect(rig.requests.filter((request) => !PULL_READS.test(request))).toEqual([]);
    expect((await readFile(join(rig.vaultA, "inbox.md"), "utf8")).includes("second edition")).toBe(true);
    expect(Object.keys(await publishedFiles(rig.vaultA)).length).toBeGreaterThan(0);
  });
});
