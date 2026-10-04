// mvp-07a task 5.3: the plugin's decrypting pull, Restore and Resolve fork, through the real runner (`createPullRunner`) and the real
// engine (`pullEncryptedVault`). Device A is the publish rig over a recording fake node; device B is a plugin over a memory vault.
// Dialogs and the passphrase prompt are scripted; the node's `Range` answers are the ones a gateway gives. Nothing here ran in Obsidian.
import { describe, expect, it } from "vitest";
import { createSyncEventBus } from "../../src/core/events";
import { formatPassphrase, generatePassphrase } from "../../src/crypto";
import type { PullReport } from "../../src/plugin/pull-notices";
import type { PullOutcome } from "../../src/plugin/pull-runner";
import { createPublishRunner, type PublishOutcome } from "../../src/plugin/publish-runner";
import { FIRST_PULL_GATEWAY_STATEMENT } from "../../src/sync/encrypted-pull";
import { encodeLock } from "../../src/sync/publish-lock";
import { currentRoot, forgeManifest, pointNameAt, publishAgain, publishedOnce, resetNodeTrace, servedRoot } from "../helpers/encrypted-pull-rig";
import { REFERENCE_TEXT, heldVault, pluginOver, type EncryptedPluginRig } from "../helpers/plugin-pull-encrypted-rig";
import { NOW, storeWith } from "../helpers/plugin-pull-rig";
import { sessionRig } from "../helpers/plugin-session";
import { ROOT, SECRET_TITLE, SECRET_WORD, restoreRig, snapshotRig } from "../helpers/publish-rig";
import { sourceTexts } from "../helpers/pull-stage-rig";

const DAILY = "Daily/2026-09-30.md";
const ORIGINAL_DAILY = `# Notes\nCall about ${SECRET_WORD}.\n`;
/** A read of a blob: `GET <tree cid>/<two letters>/<52-character blob name>`. */
const BLOB_READ = /^GET \S+\/[a-z2-7]{2}\/[a-z2-7]{52}/;

const filesOf = (b: EncryptedPluginRig): string[] => [...b.adapter.files.keys()].sort();

/** The report of a finished pull, whichever of the two finished kinds it ended as. */
function reportOf(outcome: PullOutcome): PullReport {
  if (outcome.kind !== "completed" && outcome.kind !== "unfinished") throw new Error(`expected a finished pull, got ${outcome.kind}`);
  return outcome.report;
}

async function publishFromPlugin(b: EncryptedPluginRig): Promise<PublishOutcome> {
  const client = b.publisher.node.client;
  const session = sessionRig({ store: b.store, adapter: b.adapter, createClient: () => client, typed: [REFERENCE_TEXT] }).session;
  return createPublishRunner({ store: b.store, adapter: b.adapter, bus: createSyncEventBus(), session, createClient: () => client, now: () => NOW }).run();
}

describe("plugin decrypting pull: unlock and first pull", () => {
  it("asks for the passphrase only once the root proves encrypted, confirms the first pull, restores every file and closes the dialog", async () => {
    const publisher = await publishedOnce();
    const b = pluginOver(publisher);

    const outcome = await b.pull();

    expect(outcome.kind).toBe("completed");
    expect(reportOf(outcome)).toMatchObject({ mode: "pull", sequence: 1 });
    expect(outcome.notice).toContain("Pull complete (sequence 1)");
    expect(b.passphrase.requests).toEqual([{ attempt: 1 }]);
    expect(b.passphrase.verdicts).toEqual([{ ok: true }]);
    expect(b.dialogs.firstPulls).toHaveLength(1);
    expect(b.dialogs.firstPulls[0]).toMatchObject({ sequence: 1, fileCount: 3, target: "name" });
    expect(b.texts()).toEqual(sourceTexts(publisher));
    expect(b.adapter.text(".ipfs-sync-fixture")).toBeUndefined();
    expect(await b.state()).toMatchObject({ highestSequence: 1, complete: true, unmaterialized: [] });
    expect(b.store.get().lastPull).toMatchObject({ fetched: 3, unchanged: 0, conflicts: 0, failed: 0 });
  });

  it("a wrong passphrase writes nothing and asks again with the failure; the right one proceeds", async () => {
    const publisher = await publishedOnce();
    const wrong = formatPassphrase(generatePassphrase());
    const b = pluginOver(publisher, { typed: [wrong, REFERENCE_TEXT] });
    const before = filesOf(b);
    const seen: { files: string[]; deviceStore: unknown; dialogs: number }[] = [];
    b.passphrase.onAsk = (request) => {
      if (request.attempt === 2) seen.push({ files: filesOf(b), deviceStore: b.store.get().deviceStore, dialogs: b.dialogs.firstPulls.length });
    };

    const outcome = await b.pull();

    expect(b.passphrase.requests.map((request) => request.failure)).toEqual([undefined, "wrong-passphrase"]);
    // Between the attempts: no vault file, no state, no key-slot copy, no marker, no floor, no first-pull dialog (the lock file is gone again).
    expect(seen).toEqual([{ files: before, deviceStore: {}, dialogs: 0 }]);
    expect(outcome.kind).toBe("completed");
    expect(b.dialogs.firstPulls).toHaveLength(1);
    expect(b.texts()).toEqual(sourceTexts(publisher));
  });

  it("a cancelled passphrase dialog ends the pull with nothing written", async () => {
    const publisher = await publishedOnce();
    const b = pluginOver(publisher, { typed: [undefined] });
    const before = filesOf(b);
    const outcome = await b.pull();
    expect(outcome).toMatchObject({ kind: "refused", reason: "cancelled" });
    expect(filesOf(b)).toEqual(before);
    expect(b.dialogs.firstPulls).toEqual([]);
    expect(b.passphrase.verdicts).toEqual([]);
  });

  it("an unattended pull never asks: a locked vault is a refusal that sends nothing to the vault", async () => {
    const publisher = await publishedOnce();
    const b = pluginOver(publisher);
    const before = filesOf(b);
    const outcome = await b.pull({ unattended: true });
    expect(outcome).toMatchObject({ kind: "refused", reason: "locked" });
    expect(outcome.notice).toContain("could not ask");
    expect(b.passphrase.requests).toEqual([]);
    expect(b.dialogs.firstPulls).toEqual([]);
    expect(filesOf(b)).toEqual(before);
  });

  it("an unlocked session saves the prompt; an unattended first pull still needs its confirmation and writes nothing without it", async () => {
    const publisher = await publishedOnce();
    const held = await heldVault(publisher);
    const quiet = pluginOver(publisher, { session: { provider: () => held } });
    const before = filesOf(quiet);
    const refused = await quiet.pull({ unattended: true });
    expect(refused).toMatchObject({ kind: "stopped", reason: "first-pull-not-confirmed" });
    expect(filesOf(quiet)).toEqual(before);

    const b = pluginOver(publisher, { session: { provider: () => held } });
    expect((await b.pull()).kind).toBe("completed");
    expect(b.passphrase.requests).toEqual([]);
    expect(b.dialogs.firstPulls).toHaveLength(1);
    expect(b.texts()).toEqual(sourceTexts(publisher));
  });

  it("declining the first pull writes no file, no state, no floor entry and no key-slot copy", async () => {
    const publisher = await publishedOnce();
    const b = pluginOver(publisher, { answers: { firstPull: false } });
    const before = filesOf(b);

    const outcome = await b.pull();

    expect(outcome).toMatchObject({ kind: "stopped", reason: "first-pull-declined", action: undefined });
    expect(outcome.notice).toContain("Nothing was written");
    expect(filesOf(b)).toEqual(before);
    expect(b.store.get().deviceStore).toEqual({});
    expect(await b.state()).toBeUndefined();
    expect(b.store.get().lastPull).toBeUndefined();
  });

  it("a manifest that does not authenticate is reported as a failure before any dialog or write, never as a success", async () => {
    const publisher = await publishedOnce();
    publisher.node.files.set(`${ROOT}/manifest.enc`, new Uint8Array(300).fill(7));
    pointNameAt(publisher.node);
    const b = pluginOver(publisher);
    const before = filesOf(b);

    const outcome = await b.pull();

    expect(outcome).toMatchObject({ kind: "stopped", reason: "manifest-not-authentic" });
    expect(outcome.notice).toContain("does not authenticate");
    expect(outcome.notice).not.toMatch(/complete|finished/i);
    expect(b.dialogs.firstPulls).toEqual([]);
    expect(filesOf(b)).toEqual(before);
  });

  it("an explicit root is pulled by its CID with no name lookup, and the first-pull dialog says the client does not verify it against the CID", async () => {
    const publisher = await publishedOnce();
    const root = currentRoot(publisher.node);
    resetNodeTrace(publisher.node);
    const b = pluginOver(publisher, { settings: { pullName: `/ipfs/${root}` } });

    const outcome = await b.pull();

    expect(outcome.kind).toBe("completed");
    expect(b.dialogs.firstPulls[0]?.target).toBe("root-cid");
    expect(b.dialogs.firstPulls[0]?.statements).toContain(FIRST_PULL_GATEWAY_STATEMENT);
    expect(publisher.node.calls.filter((call) => call === "keyList" || call.startsWith("nameResolve"))).toEqual([]);
  });

  it("asks before pulling more than the ceiling and fetches nothing when the answer is no; the files stay unfinished", async () => {
    const publisher = await publishedOnce({ seed: (rig) => rig.host.put("big.bin", new Uint8Array(1_200_000).fill(9), 1000) });
    const b = pluginOver(publisher, { settings: { pullConfirmAboveMb: 1 }, answers: { large: false } });

    const outcome = await b.pull();

    expect(b.dialogs.larges).toHaveLength(1);
    expect(b.dialogs.larges[0]).toMatchObject({ fileCount: 4, ceilingMb: 1 });
    expect(b.dialogs.larges[0]?.totalBytes).toBeGreaterThan(1_200_000);
    expect(outcome.kind).toBe("unfinished");
    expect(b.texts()).toEqual({});
    expect(publisher.node.calls.filter((call) => BLOB_READ.test(call))).toEqual([]);
    expect(await b.state()).toMatchObject({ complete: false });
  });
});

describe("plugin decrypting pull: locks and secrets", () => {
  it("takes publish.lock and the in-process lock for the whole pull and releases both on every path", async () => {
    const publisher = await publishedOnce();
    const b = pluginOver(publisher);
    let during: { file: boolean; holder: string | undefined } | undefined;
    b.dialogs.onFirstPull = () => {
      during = { file: b.adapter.files.has(".ipfs-sync/publish.lock"), holder: b.lock.holder() };
    };
    expect((await b.pull()).kind).toBe("completed");
    expect(during).toEqual({ file: true, holder: "pull" });
    expect(b.adapter.files.has(".ipfs-sync/publish.lock")).toBe(false);
    expect(b.lock.holder()).toBeUndefined();

    const declined = pluginOver(publisher, { answers: { firstPull: false } });
    expect((await declined.pull()).kind).toBe("stopped");
    expect(declined.adapter.files.has(".ipfs-sync/publish.lock")).toBe(false);
    expect(declined.lock.holder()).toBeUndefined();

    const failing = pluginOver(publisher, { settings: { pullName: "k51doesnotresolve" } });
    expect((await failing.pull()).kind).toBe("failed");
    expect(failing.adapter.files.has(".ipfs-sync/publish.lock")).toBe(false);
    expect(failing.lock.holder()).toBeUndefined();
  });

  it("refuses as busy, before any request or prompt, while another process holds publish.lock", async () => {
    const publisher = await publishedOnce();
    const keyId = currentKeyId(publisher);
    const b = pluginOver(publisher, { settings: { pullName: keyId } });
    b.adapter.put(".ipfs-sync/publish.lock", encodeLock({ token: "someone-else", pid: 99, host: "other-host", time: NOW.getTime() }));
    resetNodeTrace(publisher.node);

    const outcome = await b.pull();

    expect(outcome).toMatchObject({ kind: "refused", reason: "busy" });
    expect(publisher.node.calls).toEqual([]);
    expect(b.passphrase.requests).toEqual([]);
    expect(b.adapter.files.has(".ipfs-sync/publish.lock")).toBe(true);
  });

  it("keeps the passphrase, the paths and the file names out of the stored data and out of every outcome", async () => {
    const publisher = await publishedOnce();
    const b = pluginOver(publisher);
    const outcome = await b.pull();
    const stored = JSON.stringify(b.store.port.data);
    for (const secret of [REFERENCE_TEXT, SECRET_TITLE, SECRET_WORD, "Secret Merger", "Daily"]) {
      expect(stored, secret).not.toContain(secret);
      expect(JSON.stringify(outcome), secret).not.toContain(secret);
    }
    expect(Object.keys(b.store.get().lastPull ?? {}).sort()).toEqual(["at", "conflicts", "failed", "fetched", "manifestCid", "remoteDeleted", "rootCid", "unchanged"]);
  });

  it("sends only reads to the node", async () => {
    const publisher = await publishedOnce();
    const b = pluginOver(publisher);
    await b.pull();
    expect(publisher.node.calls.filter((call) => /^(write|rm|pin|publish|keyGen) /.test(call))).toEqual([]);
  });
});

describe("plugin decrypting pull: unfinished files", () => {
  it("records the unfinished file, says so, and the next publish succeeds and carries it unchanged", async () => {
    const publisher = await publishedOnce();
    const before = await publisher.manifest();
    const b = pluginOver(publisher, { corruptSegments: 1 });

    const outcome = await b.pull();

    expect(outcome.kind).toBe("unfinished");
    const report = reportOf(outcome);
    expect(report.integrityFailed).toHaveLength(1);
    const unfinished = report.integrityFailed[0]?.path ?? "";
    expect(outcome.notice).toContain("Pull incomplete");
    expect(outcome.notice).toContain("Your next publish keeps it as the node has it");
    expect(outcome.notice).not.toContain("Pull complete");
    expect(await b.state()).toMatchObject({ complete: false, highestSequence: 1, unmaterialized: [unfinished] });
    expect(await b.runner.record()).toEqual({ highestSequence: 1, complete: false, unfinished: 1, restoredFrom: undefined });
    expect(b.store.get().lastPull?.failed).toBe(1);

    // A pulled directory publishes with no hand step (the guard is removed); the carried entry goes along unchanged.
    b.adapter.put("Second device.md", "written here", 9000);
    const published = await publishFromPlugin(b);
    expect(published.kind).toBe("published");
    const after = await publisher.manifest();
    expect(after.sequence).toBe(2);
    expect(after.files[unfinished]).toEqual(before.files[unfinished]);
    expect(Object.keys(after.files)).toContain("Second device.md");
  });

  it("reports nothing for a device with no state, and the record of a finished pull afterwards", async () => {
    const publisher = await publishedOnce();
    const b = pluginOver(publisher);
    expect(await b.runner.record()).toBeUndefined();
    await b.pull();
    expect(await b.runner.record()).toEqual({ highestSequence: 1, complete: true, unfinished: 0, restoredFrom: undefined });
  });
});

/** Three published versions; the plugin device pulled the third. */
async function threeVersions(): Promise<{ readonly publisher: Awaited<ReturnType<typeof publishedOnce>>; readonly b: EncryptedPluginRig; readonly rootOne: string }> {
  const publisher = await publishedOnce();
  const rootOne = currentRoot(publisher.node);
  await publishAgain(publisher, "Second edition.\n");
  await publishAgain(publisher, "Third edition.\n");
  const b = pluginOver(publisher);
  expect((await b.pull()).kind).toBe("completed");
  expect(b.texts()[DAILY]).toBe("Third edition.\n");
  resetNodeTrace(publisher.node);
  return { publisher, b, rootOne };
}

describe("plugin Restore", () => {
  it("lists the newest versions with authenticated dates, confirms with the entry's own values, and restores only after the yes", async () => {
    const { publisher, b } = await threeVersions();
    b.dialogs.answers.restoreIndex = 2;

    const outcome = await b.runner.restore();

    const [list] = b.dialogs.lists;
    expect(list?.map((entry) => entry.sequence)).toEqual([3, 2, 1]);
    expect(list?.every((entry) => entry.detail !== undefined && !entry.legacy)).toBe(true);
    expect(b.dialogs.restores).toHaveLength(1);
    expect(b.dialogs.restores[0]).toMatchObject({ authenticated: { sequence: 1 }, highestSequence: 3, labelMismatch: undefined });
    expect(b.dialogs.restores[0]?.authenticated.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(outcome.kind).toBe("completed");
    expect(reportOf(outcome)).toMatchObject({ mode: "restore", sequence: 1 });
    expect(outcome.notice).toContain("Restore finished (sequence 1)");
    expect(outcome.notice).toContain("were not removed");
    expect(b.texts()[DAILY]).toBe(ORIGINAL_DAILY);
    // The record is not lowered; the restore is recorded and a restore never deletes.
    expect(await b.state()).toMatchObject({ highestSequence: 3, restoredFrom: 1 });
    expect(await b.runner.record()).toMatchObject({ highestSequence: 3, restoredFrom: 1 });
    expect(publisher.node.calls.filter((call) => /^(write|rm|pin|publish|keyGen) /.test(call))).toEqual([]);
  });

  it("does nothing without the confirmation: no blob is requested and no file or state changes", async () => {
    const { publisher, b } = await threeVersions();
    b.dialogs.answers.restoreIndex = 2;
    b.dialogs.answers.restore = false;
    const before = b.texts();
    const filesBefore = filesOf(b);

    const outcome = await b.runner.restore();

    expect(outcome).toMatchObject({ kind: "refused", reason: "cancelled" });
    expect(b.dialogs.restores).toHaveLength(1);
    expect(publisher.node.calls.filter((call) => BLOB_READ.test(call))).toEqual([]);
    expect(b.texts()).toEqual(before);
    expect(filesOf(b)).toEqual(filesBefore);
    expect((await b.state())?.restoredFrom).toBeUndefined();
  });

  it("does nothing when the list is closed without a choice", async () => {
    const { publisher, b } = await threeVersions();
    b.dialogs.answers.restoreIndex = undefined;
    const outcome = await b.runner.restore();
    expect(outcome).toMatchObject({ kind: "refused", reason: "cancelled" });
    expect(b.dialogs.restores).toEqual([]);
    expect(publisher.node.calls.filter((call) => BLOB_READ.test(call))).toEqual([]);
  });

  it("refuses before the confirmation when a history file named for sequence 12 decrypts to sequence 2", async () => {
    const { publisher, b } = await threeVersions();
    const key = [...publisher.node.files.keys()].find((candidate) => candidate.startsWith(`${ROOT}/manifests/0000000000000002-`));
    const bytes = key === undefined ? undefined : publisher.node.files.get(key);
    if (key === undefined || bytes === undefined) throw new Error("fixture changed");
    publisher.node.files.set(key.replace("0000000000000002-", "0000000000000012-"), bytes);
    pointNameAt(publisher.node);
    resetNodeTrace(publisher.node);
    b.dialogs.answers.restoreIndex = 0;

    const outcome = await b.runner.restore();

    const [list] = b.dialogs.lists;
    expect(list?.[0]).toMatchObject({ sequence: 12, detail: undefined });
    expect(outcome).toMatchObject({ kind: "refused", reason: "restore-refused" });
    expect(outcome.notice).toContain("listed as sequence 12 holds sequence 2");
    expect(outcome.notice).toContain("does not match its name");
    expect(b.dialogs.restores).toEqual([]);
    expect(publisher.node.calls.filter((call) => BLOB_READ.test(call))).toEqual([]);
    expect(b.texts()[DAILY]).toBe("Third edition.\n");
  });

  it("says so when the node holds no history, and works from a name only", async () => {
    const publisher = await publishedOnce();
    for (const key of [...publisher.node.files.keys()]) if (key.startsWith(`${ROOT}/manifests/`)) publisher.node.files.delete(key);
    pointNameAt(publisher.node);
    const b = pluginOver(publisher, { answers: { firstPull: true } });
    expect(await b.runner.restore()).toMatchObject({ kind: "refused", reason: "restore-refused" });

    const explicit = pluginOver(publisher, { settings: { pullName: `/ipfs/${currentRoot(publisher.node)}` } });
    expect(await explicit.runner.restore()).toMatchObject({ kind: "refused", reason: "needs-name" });
    expect(await explicit.runner.resolveFork()).toMatchObject({ kind: "refused", reason: "needs-name" });
  });

  it("the plain Pull never rolls back: an older version is refused with no way to accept it", async () => {
    const { publisher, b, rootOne } = await threeVersions();
    pointNameAt(publisher.node, rootOne);
    const before = b.texts();

    const outcome = await b.pull();

    expect(outcome).toMatchObject({ kind: "stopped", reason: "older", action: undefined });
    expect(outcome.notice).not.toMatch(/rollback|restore/i);
    expect(b.texts()).toEqual(before);
  });
});

describe("plugin Resolve fork", () => {
  /** Device P pulled B's sequence 2 (identity Y); A's node now serves another sequence 2 (identity X). */
  async function forked(answers: { fork?: boolean } = {}): Promise<{ readonly a: Awaited<ReturnType<typeof publishedOnce>>; readonly p: EncryptedPluginRig }> {
    const a = await publishedOnce();
    const bNode = restoreRig(snapshotRig(a));
    servedRoot(bNode.node);
    bNode.host.clock += 60_000;
    bNode.host.put(DAILY, "B wrote this daily note.\n");
    expect((await bNode.publish()).sequence).toBe(2);
    servedRoot(bNode.node);
    await publishAgain(a, "A wrote this daily note.\n");

    const store = storeWith({ mfsRoot: ROOT, ownedKeys: [currentKeyId(a)] });
    const first = pluginOver(bNode, { store });
    expect((await first.pull()).kind).toBe("completed");
    expect(first.texts()[DAILY]).toBe("B wrote this daily note.\n");
    const p = pluginOver(a, { store, adapter: first.adapter, answers });
    return { a, p };
  }

  it("a fork shows the notice and offers the action; the action confirms, brings the node's version in and keeps this device's text", async () => {
    const { a, p } = await forked();

    const stopped = await p.pull();
    expect(stopped).toMatchObject({ kind: "stopped", reason: "fork", action: "resolve-fork" });
    expect(stopped.notice).toContain("fork");
    expect(stopped.notice).toContain("Resolve fork");
    expect(p.texts()[DAILY]).toBe("B wrote this daily note.\n");

    resetNodeTrace(a.node);
    const outcome = await p.runner.resolveFork();

    expect(p.dialogs.forks).toHaveLength(1);
    expect(outcome.kind).toBe("completed");
    expect(reportOf(outcome)).toMatchObject({ mode: "fork-resolution", sequence: 2 });
    expect(outcome.notice).toContain("Fork resolution finished");
    // This device has no recorded ancestor, so the note says why every differing file got a copy.
    expect(outcome.notice).toContain("Note:");
    expect(p.texts()[DAILY]).toBe("A wrote this daily note.\n");
    const copies = reportOf(outcome).conflictCopies;
    expect(copies).toHaveLength(1);
    expect(p.texts()[copies[0] ?? ""]).toBe("B wrote this daily note.\n");
    expect(a.node.calls.filter((call) => /^(write|rm|pin|publish|keyGen) /.test(call))).toEqual([]);
  });

  it("does nothing without the confirmation: nothing is fetched or written", async () => {
    const { a, p } = await forked({ fork: false });
    const before = p.texts();
    resetNodeTrace(a.node);

    const outcome = await p.runner.resolveFork();

    expect(outcome).toMatchObject({ kind: "refused", reason: "cancelled" });
    expect(a.node.calls).toEqual([]);
    expect(p.texts()).toEqual(before);
    expect(p.passphrase.requests).toEqual([]);
  });
});

describe("plugin forged manifest through a held vault", () => {
  it("a forged sequence-1 manifest at a recorded sequence is a fork, not a success", async () => {
    const publisher = await publishedOnce();
    const held = await heldVault(publisher);
    const b = pluginOver(publisher, { session: { provider: () => held } });
    await b.pull();
    await forgeManifest(publisher, [DAILY], { sequence: 1 });
    const outcome = await b.pull();
    expect(outcome).toMatchObject({ kind: "stopped", reason: "fork", action: "resolve-fork" });
    expect(outcome.notice).not.toMatch(/Pull complete/);
  });
});

function currentKeyId(rig: Awaited<ReturnType<typeof publishedOnce>>): string {
  const key = rig.node.keys[0];
  if (key === undefined) throw new Error("the publication key was not created");
  return key.id;
}
