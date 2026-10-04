import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeLockContext, createNodeLockFile } from "../../cli/publish-lock-file";
import { acquirePublishLock } from "../../src/sync/publish-lock";
import { MFS_ROOT, NOW, createCliPullRig, historyNames, publishedFiles, summary, vaultFiles, type CliPullRig } from "../helpers/cli-pull-rig";

/**
 * `ipfs-sync pull` over the encrypted layout (mvp-07a task 5.1), through `runCli`: device A publishes a fixture vault, device B
 * pulls it. Both use the real kubo client against one fake node, so the request trace is what the node would see.
 */

const BLOB_GET = /^GET \/ipfs\/[^/]+\/[a-z2-7]{2}\/[a-z2-7]{52}$/;
const FLOOR_FILE = "sequence-floor.json";

let rig: CliPullRig;

beforeEach(async () => {
  rig = await createCliPullRig();
});

afterEach(async () => {
  await rig.dispose();
});

const blobGets = (): string[] => rig.requests.filter((request) => BLOB_GET.test(request));
const yes = async (): Promise<boolean> => true;
const no = async (): Promise<boolean> => false;
const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/** Nothing of a pull is on device B: no vault file, no marker, no record, no key-slot copy, no floor. */
async function expectNothingPulled(): Promise<void> {
  expect((await vaultFiles(rig.vaultB)) ?? {}).toEqual({});
  expect(await exists(join(rig.vaultB, ".ipfs-sync-fixture"))).toBe(false);
  const state = (await readdir(join(rig.vaultB, ".ipfs-sync")).catch(() => [])).filter((name) => name !== "tmp");
  expect(state).toEqual([]);
  expect(await exists(join(rig.stateB, "ipfs-sync", FLOOR_FILE))).toBe(false);
  expect(blobGets()).toEqual([]);
}

describe("pull --help", () => {
  it("shows every flag of the decrypting pull and the exit codes", async () => {
    const result = await rig.pull(["--help"], { bare: true });
    expect(result.code).toBe(0);
    for (const flag of [
      "--root-cid",
      "--manifest ",
      "--allow-rollback",
      "--resolve-fork",
      "--expect-min-sequence",
      "--expect-vault-id",
      "--accept-first-pull",
      "--max-bytes",
      "--accept-large",
      "--list-versions",
    ]) {
      expect(result.out).toContain(flag);
    }
    for (const removed of ["--allow-plaintext-v1", "--manifest-file"]) expect(result.out).not.toContain(removed);
    expect(result.out).not.toContain("pull is not supported yet");
    expect(result.out).not.toContain("Only plaintext (version 1) publications can be pulled");
  });
});

describe("first pull", () => {
  it("refuses a non-interactive first pull without --accept-first-pull and writes nothing", async () => {
    const result = await rig.pull();
    expect(result.code).toBe(1);
    expect(result.err).toContain("--accept-first-pull");
    await expectNothingPulled();
  });

  it("shows the authenticated sequence, date and device and asks; a no writes nothing", async () => {
    const result = await rig.pull([], { confirm: no });
    expect(result.code).toBe(1);
    expect(result.err).toContain("declined");
    expect(rig.questions).toHaveLength(1);
    const shown = `${result.out}\n${result.err}`;
    expect(shown).toMatch(/sequence\s+1\b/);
    expect(shown).toContain("2026-");
    expect(shown).toContain("whoever holds the vault key");
    await expectNothingPulled();
  });

  it("pulls the vault after a yes at the prompt, byte for byte, reading the node only", async () => {
    const result = await rig.pull([], { confirm: yes });
    expect(result.code).toBe(0);
    expect(await vaultFiles(rig.vaultB)).toEqual(await publishedFiles(rig.vaultA));
    expect(result.out).toMatch(/\d+ fetched, 0 unchanged, 0 conflicts, 0 integrity-failed, 0 unfetched/);
    expect(result.out).toContain("sequence  1");
    expect(rig.requests.filter((request) => /^(files\/(write|rm)|key\/gen|pin\/add|name\/publish)$/.test(request))).toEqual([]);
    expect(await readFile(join(rig.vaultB, ".ipfs-sync-fixture"), "utf8")).toContain("pulled-fixture");
    expect(await readdir(join(rig.vaultB, ".ipfs-sync", "tmp"))).toEqual([]);
    expect(await exists(join(rig.stateB, "ipfs-sync", FLOOR_FILE))).toBe(true);
  });

  it("pulls with --accept-first-pull and no terminal, and a second pull needs neither", async () => {
    expect(summary(await rig.pull(["--accept-first-pull"]))).toEqual({ code: 0, err: "" });
    const again = await rig.pull();
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/0 fetched, \d+ unchanged/);
  });

  it("sweeps stale part files in .ipfs-sync/tmp/ at the start of the pull", async () => {
    await mkdir(join(rig.vaultB, ".ipfs-sync", "tmp"), { recursive: true });
    await writeFile(join(rig.vaultB, ".ipfs-sync-fixture"), "fixture\n");
    await writeFile(join(rig.vaultB, ".ipfs-sync", "tmp", "stale-1.part"), "plaintext left by a crash");
    const result = await rig.pull(["--accept-first-pull"]);
    expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: "" });
    expect(await readdir(join(rig.vaultB, ".ipfs-sync", "tmp"))).toEqual([]);
  });
});

describe("the lock and the passphrase", () => {
  it("refuses with publish's text while publish.lock is held, before any blob request or write", async () => {
    await mkdir(rig.vaultB, { recursive: true });
    const lock = await acquirePublishLock(createNodeLockFile(rig.vaultB), createNodeLockContext(() => NOW.getTime()));
    const result = await rig.pull(["--accept-first-pull"]);
    await lock.release();
    expect(result.code).toBe(1);
    expect(result.err).toContain("another publish is running in this vault");
    expect(blobGets()).toEqual([]);
    expect((await vaultFiles(rig.vaultB)) ?? {}).toEqual({});
    expect(await exists(join(rig.vaultB, ".ipfs-sync", "publish.lock"))).toBe(false);
  });

  it("releases the lock after a stop and after a completed pull", async () => {
    await rig.pull();
    expect(await exists(join(rig.vaultB, ".ipfs-sync", "publish.lock"))).toBe(false);
    await rig.pull(["--accept-first-pull"]);
    expect(await exists(join(rig.vaultB, ".ipfs-sync", "publish.lock"))).toBe(false);
  });

  it("reports both passphrase variables set, as publish does, and a per-user directory that cannot be located", async () => {
    const both = await rig.pull(["--accept-first-pull"], {
      deps: { passphrase: undefined, env: { XDG_STATE_HOME: rig.stateB, IPFS_SYNC_PASSPHRASE: "x", IPFS_SYNC_PASSPHRASE_FILE: join(rig.dir, "none") } },
    });
    expect(both.code).toBe(1);
    expect(both.err).toContain("set exactly one");
    const homeless = await rig.pull(["--accept-first-pull"], { deps: { env: {} } });
    expect(homeless.code).toBe(1);
    expect(homeless.err).toContain("cannot locate the per-user state directory");
    expect(await exists(join(rig.vaultB, ".ipfs-sync", "publish.lock"))).toBe(false);
    expect(blobGets()).toEqual([]);
  });

  it("stops with a plain message when no passphrase source exists, and prints no passphrase", async () => {
    const result = await rig.pull(["--accept-first-pull"], { deps: { passphrase: async () => undefined } });
    expect(result.code).toBe(1);
    expect(result.err).toContain("no passphrase");
    await expectNothingPulled();
  });
});

describe("flags that are refused before any request", () => {
  it("--allow-rollback without --root-cid or --manifest fails before any request and before the passphrase is asked", async () => {
    let asked = 0;
    const result = await rig.pull(["--allow-rollback"], { deps: { passphrase: async () => (asked += 1, undefined) } });
    expect(result.code).toBe(2);
    expect(result.err).toContain("--allow-rollback needs an explicit target");
    expect(rig.requests).toEqual([]);
    expect(asked).toBe(0);
    expect(await exists(rig.vaultB)).toBe(false);
  });

  it.each([
    [["--resolve-fork", "--allow-rollback", "--root-cid", "bafyrootcid0000000000"], "cannot be combined with --allow-rollback"],
    [["--resolve-fork", "--root-cid", "bafyrootcid0000000000"], "works only on a name target"],
    [["--root-cid", "bafyrootcid0000000000", "--manifest", "bafytreecid0000000000"], "mutually exclusive"],
    [["--expect-min-sequence", "0"], "--expect-min-sequence needs a positive whole number"],
    [["--expect-min-sequence", "abc"], "--expect-min-sequence needs a positive whole number"],
    [["--expect-vault-id", "XYZ"], "--expect-vault-id needs 32 lowercase hexadecimal characters"],
    [["--max-bytes", "0"], "--max-bytes needs a positive whole number"],
    [["--root-cid", "../x"], "--root-cid needs a CID"],
  ] as const)("%j exits 2 without a request: %s", async (flags, text) => {
    const result = await rig.pull(flags);
    expect(result.code).toBe(2);
    expect(result.err).toContain(text);
    expect(rig.requests).toEqual([]);
  });

  it("refuses the pull-only flags on publish", async () => {
    const result = await rig.publish(["--accept-first-pull"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--accept-first-pull is only valid for the pull command");
  });

  it("refuses --resolve-fork without a terminal and declines it on a no, before any request", async () => {
    const quiet = await rig.pull(["--resolve-fork"]);
    expect(quiet.code).toBe(2);
    expect(quiet.err).toContain("--resolve-fork needs a terminal");
    const declined = await rig.pull(["--resolve-fork"], { confirm: no });
    expect(declined.code).toBe(1);
    expect(rig.questions).toHaveLength(1);
    expect(rig.questions[0]).toContain("conflict copy");
    expect(rig.requests).toEqual([]);
  });

  it("an expectation that fails stops the pull and writes nothing", async () => {
    const result = await rig.pull(["--accept-first-pull", "--expect-min-sequence", "5"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--expect-min-sequence");
    await expectNothingPulled();
    const wrongVault = await rig.pull(["--accept-first-pull", "--expect-vault-id", "0".repeat(32)]);
    expect(wrongVault.code).toBe(1);
    expect(wrongVault.err).toContain("--expect-vault-id");
    await expectNothingPulled();
  });
});

describe("removed plaintext flags and a plaintext root (mvp-07b 3.1b)", () => {
  /** The node serves a root that holds a `manifest.json` and neither key slots nor `manifest.enc`. */
  function servePlaintextRoot(): void {
    for (const path of [...rig.node.files.keys()]) {
      if (path.startsWith(`${MFS_ROOT}/manifests/`) || path === `${MFS_ROOT}/keyslots.json` || path === `${MFS_ROOT}/manifest.enc`) rig.node.files.delete(path);
    }
    rig.node.files.set(`${MFS_ROOT}/manifest.json`, new TextEncoder().encode(JSON.stringify({ version: 1, files: {} })));
    rig.repoint();
    rig.requests.length = 0;
  }
  const manifestJsonReads = (): string[] => rig.requests.filter((request) => request.endsWith("manifest.json"));

  it.each([["--allow-plaintext-v1"], ["--manifest-file", "manifest.json"]])("%s is an unknown option: exit 2, no request, nothing written", async (...flags: string[]) => {
    const result = await rig.pull(flags);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/[Uu]nknown option/);
    expect(rig.requests).toEqual([]);
    expect(await exists(rig.vaultB)).toBe(false);
  });

  it("refuses a root that serves a plaintext manifest.json and no key slots: exit 2, the no-longer-supported text, nothing written, the manifest never read", async () => {
    servePlaintextRoot();
    const result = await rig.pull(["--accept-first-pull"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("pull refused: plaintext publications are no longer supported");
    expect(result.err).not.toMatch(/--allow|--manifest-file|downgrade/);
    expect(manifestJsonReads()).toEqual([]);
    await expectNothingPulled();
  });

  it("refuses the same root for a name target whatever else was recorded here: a device that holds a floor and a state is refused the same way", async () => {
    expect((await rig.pull(["--accept-first-pull"])).code).toBe(0);
    servePlaintextRoot();
    const result = await rig.pull();
    expect(result.code).toBe(2);
    expect(result.err).toContain("plaintext publications are no longer supported");
    expect(manifestJsonReads()).toEqual([]);
    expect(await exists(join(rig.vaultB, ".ipfs-sync", "publish.lock"))).toBe(false);
  });
});

describe("exit codes and the three lists", () => {
  it("exits 1 for an integrity failure, listing it apart, and still pulls the other files", async () => {
    const manifest = await rig.manifest();
    const [path, entry] = Object.entries(manifest.files)[0] ?? [];
    if (path === undefined || entry === undefined) throw new Error("the fixture published nothing");
    const blob = rig.node.cidOf(`${MFS_ROOT}/current/${entry.blob.slice(0, 2)}/${entry.blob}`) as string;
    const original = rig.node.bytesOf(blob) as Uint8Array;
    rig.node.corruptRead = (cid) => {
      if (cid !== blob) return undefined;
      const flipped = Uint8Array.from(original);
      flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
      return flipped;
    };
    const result = await rig.pull(["--accept-first-pull"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`integrity-failed ${path}`);
    expect(result.err).not.toContain("unfetched ");
    expect(result.out).toMatch(/1 integrity-failed, 0 unfetched/);
    const pulled = (await vaultFiles(rig.vaultB)) ?? {};
    expect(Object.keys(pulled)).not.toContain(path);
    expect(Object.keys(pulled).length).toBe(Object.keys(manifest.files).length - 1);
  });

  it("exits 1 for unfetched files when the pull is above --max-bytes and not confirmed, fetching nothing", async () => {
    const result = await rig.pull(["--accept-first-pull", "--max-bytes", "1"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("unfetched ");
    expect(result.err).toContain("--accept-large");
    expect(result.out).toMatch(/0 fetched, 0 unchanged, 0 conflicts, 0 integrity-failed, \d+ unfetched/);
    expect(blobGets()).toEqual([]);
    expect((await vaultFiles(rig.vaultB)) ?? {}).toEqual({});
  });

  it("--accept-large answers the question, and a yes at the prompt does too", async () => {
    expect((await rig.pull(["--accept-first-pull", "--max-bytes", "1", "--accept-large"])).code).toBe(0);
    expect(await vaultFiles(rig.vaultB)).toEqual(await publishedFiles(rig.vaultA));
  });

  it("asks before a pull above the ceiling on a terminal and fetches nothing on a no", async () => {
    const declined = await rig.pull(["--accept-first-pull", "--max-bytes", "1"], { confirm: no });
    expect(declined.code).toBe(1);
    expect(rig.questions[0]).toMatch(/\d+ files, \d+ bytes, must be downloaded, above the ceiling of 1 byte\./);
    expect(blobGets()).toEqual([]);
    const accepted = await rig.pull(["--max-bytes", "1"], { confirm: yes });
    expect(accepted.code).toBe(0);
    expect(await vaultFiles(rig.vaultB)).toEqual(await publishedFiles(rig.vaultA));
  });

  it("exits 0 when the only skips are expected ones (an old build's .obsidian/ entry), and lists them apart", async () => {
    await rig.addManifestPaths([".obsidian/app.json"]);
    const result = await rig.pull(["--accept-first-pull"]);
    expect(summary(result)).toEqual({ code: 0, err: "" });
    expect(result.out).toContain("skipped (expected) .obsidian/app.json");
    expect(result.err).not.toContain("skipped (unsafe");
    expect(result.out).toMatch(/1 skipped/);
  });

  it("exits 1 for an unsafe skip (a name only another platform can write), and lists it apart from the expected one", async () => {
    await rig.addManifestPaths([".obsidian/app.json", "CON.md"]);
    const result = await rig.pull(["--accept-first-pull"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("skipped (unsafe, platform) CON.md");
    expect(result.out).toContain("skipped (expected) .obsidian/app.json");
    expect(await exists(join(rig.vaultB, "CON.md"))).toBe(false);
  });

  it("exits 1 for files that do not fit on the disk (the freeBytes port), as unfetched", async () => {
    const result = await rig.pull(["--accept-first-pull"], { deps: { freeBytes: async () => 1 } });
    expect(result.code).toBe(1);
    expect(result.err).toContain("not enough free disk space");
    expect(result.out).toMatch(/\d+ unfetched/);
  });
});

describe("restore and explicit targets", () => {
  it("refuses an older manifest without --allow-rollback and restores it with the flag, saying nothing is removed", async () => {
    const first = await rig.manifest();
    await writeFile(join(rig.vaultA, "inbox.md"), "# Inbox\n\nan edit made after the first publish\n");
    await writeFile(join(rig.vaultA, "created-later.md"), "made at sequence 2\n");
    expect((await rig.publish()).code).toBe(0);
    rig.repoint();
    expect(summary(await rig.pull(["--accept-first-pull"]))).toEqual({ code: 0, err: "" });
    expect(await readFile(join(rig.vaultB, "created-later.md"), "utf8")).toBe("made at sequence 2\n");

    const refused = await rig.pull(["--manifest", first.rootCID]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--allow-rollback");
    expect(await readFile(join(rig.vaultB, "inbox.md"), "utf8")).toContain("an edit made after the first publish");

    const restored = await rig.pull(["--manifest", first.rootCID, "--allow-rollback"]);
    expect(restored.code).toBe(0);
    expect(restored.out).toContain("restore");
    expect(restored.out).toContain("not removed");
    expect(await readFile(join(rig.vaultB, "inbox.md"), "utf8")).not.toContain("an edit made after the first publish");
    expect(await readFile(join(rig.vaultB, "created-later.md"), "utf8")).toBe("made at sequence 2\n");
  });

  it("pulls by --root-cid, and says that the CID is not verified against the returned bytes", async () => {
    const root = rig.repoint();
    const result = await rig.pull(["--root-cid", root], { confirm: yes });
    expect(result.code).toBe(0);
    expect(await vaultFiles(rig.vaultB)).toEqual(await publishedFiles(rig.vaultA));
    expect(result.out).toContain("does not verify the returned bytes");
    expect(result.out).toContain(`root CID   ${root}`);
    expect(result.out).not.toContain("(IPNS value)");
  });
});

describe("--list-versions", () => {
  it("lists the history newest first by the sequence in the name, with date and device, and legacy names last", async () => {
    await writeFile(join(rig.vaultA, "inbox.md"), "# Inbox\n\nsecond\n");
    expect((await rig.publish()).code).toBe(0);
    const names = historyNames(rig.node);
    expect(names).toHaveLength(2);
    const [oldest] = names;
    const bytes = rig.node.files.get(`${MFS_ROOT}/manifests/${oldest}`) as Uint8Array;
    rig.node.files.set(`${MFS_ROOT}/manifests/bafylegacyname000001.enc`, bytes);
    rig.repoint();
    rig.requests.length = 0;

    const result = await rig.pull(["--list-versions"]);
    expect(result.code).toBe(0);
    const lines = result.out.split("\n").filter((line) => line.startsWith("  sequence ") || line.startsWith("  legacy"));
    expect(lines.map((line) => /^ {2}(sequence \d+|legacy)\s/.exec(line)?.[1])).toEqual(["sequence 2", "sequence 1", "legacy"]);
    expect(lines[0]).toContain("2026-");
    expect(lines[0]).toContain("0000000000000002-");
    expect(lines[2]).toContain("bafylegacyname000001.enc");
    expect(lines[2]).toContain("2026-");
    expect(await exists(rig.vaultB)).toBe(false);
    expect(await exists(join(rig.stateB, "ipfs-sync", FLOOR_FILE))).toBe(false);
    expect(rig.requests.filter((request) => /^(files\/(write|rm)|key\/gen|pin\/add|name\/publish)$/.test(request))).toEqual([]);
  });

  it("shows only the newest 20 names and does not decrypt a file above 8 MiB", async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    for (let sequence = 3; sequence <= 26; sequence += 1) {
      rig.node.files.set(`${MFS_ROOT}/manifests/${String(sequence).padStart(16, "0")}-bafyplanted${String(sequence).padStart(8, "0")}.enc`, big);
    }
    rig.repoint();
    const bigCid = rig.node.cidOf(`${MFS_ROOT}/manifests/0000000000000026-bafyplanted00000026.enc`) as string;
    rig.requests.length = 0;
    const result = await rig.pull(["--list-versions"]);
    expect(result.code).toBe(0);
    const lines = result.out.split("\n").filter((line) => line.startsWith("  sequence "));
    expect(lines).toHaveLength(20);
    expect(lines[0]).toContain("sequence 26");
    expect(lines[19]).toContain("sequence 7");
    expect(lines[0]).toContain("above 8 MiB");
    expect(rig.requests.filter((request) => request.includes(bigCid) || BLOB_GET.test(request))).toEqual([]);
  });

  it("skips a prefixed name whose manifest carries another sequence, with a warning", async () => {
    const [name] = historyNames(rig.node);
    const bytes = rig.node.files.get(`${MFS_ROOT}/manifests/${name}`) as Uint8Array;
    rig.node.files.set(`${MFS_ROOT}/manifests/0000000000000009-bafyplanted00000009.enc`, bytes);
    rig.repoint();
    const result = await rig.pull(["--list-versions"]);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("sequence 9");
    expect(result.err).toContain("0000000000000009-bafyplanted00000009.enc");
    expect(result.err).toContain("does not match its name");
  });
});
