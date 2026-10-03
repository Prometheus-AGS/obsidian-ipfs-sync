// mvp-07a task 6.1, the six safety-critical scenarios against the real guards: forged manifest, flipped blob, replayed manifest by
// name, the sequence floor after abandon, overlapping publishes, crash and resume. Each runs through `publishVault` and the
// decrypting pull with real state, floor and locks over the recording fake node (drivers and assertions: helpers/safety-scenarios.ts).
// The same drivers run with one guard removed in tests/integration/witness-*.test.ts, where the same assertions must throw.
import { describe, expect, it } from "vitest";
import { readJournal } from "../../src/sync/journal";
import { ROOT } from "../helpers/publish-rig";
import { pointNameAt, servedRoot } from "../helpers/encrypted-pull-rig";
import { DAILY, PLAN, createDevices, editAndPublish } from "../helpers/integration-devices";
import {
  assertCrashResumeRefused,
  assertFlippedBlobFailsAlone,
  assertFloorRefusesOlderAfterAbandon,
  assertForgedManifestRefused,
  assertOverlapRefused,
  assertReplayRefused,
  runCrashForeignPublishResume,
  runFlippedBlob,
  runFloorAfterAbandon,
  runForgedManifest,
  runOverlappingPublishes,
  runReplayByName,
} from "../helpers/safety-scenarios";

describe("forged manifest", () => {
  it.each(["plaintext", "bit-flip", "other-vault-key"] as const)("a manifest.enc that the vault key did not produce (%s) aborts the pull: no blob requested, nothing written", async (forgery) => {
    assertForgedManifestRefused(await runForgedManifest(forgery));
  });
});

describe("flipped blob", () => {
  it("one flipped bit fails only that file: destination absent, no part file, state incomplete, the others arrive", async () => {
    assertFlippedBlobFailsAlone(await runFlippedBlob());
  });
});

describe("replayed older manifest", () => {
  it("served by name it is refused with both sequences named and no rollback flag offered; vault, state and floor are unchanged", async () => {
    const observed = await runReplayByName();
    assertReplayRefused(observed);
    // Control: the name pointing at the newest root again pulls normally and moves nothing backwards.
    const { devices } = observed;
    pointNameAt(devices.node);
    const again = await devices.b.pull();
    expect(again.kind).toBe("completed");
    if (again.kind === "completed") expect(again.result.verdict).toBe("same");
    expect((await devices.b.state())?.sequence).toBe(2);
  });
});

describe("the sequence floor", () => {
  it("abandon moves the directory's records but not the floor: an older first pull into it is refused naming the recorded sequence", async () => {
    const observed = await runFloorAfterAbandon();
    assertFloorRefusesOlderAfterAbandon(observed);
  });
});

describe("the floor without the directory's records", () => {
  it("deleting the state folder does not make an older manifest acceptable: the floor still refuses it", async () => {
    const devices = await createDevices();
    const { rig, node, a, b } = devices;
    const olderRoot = servedRoot(node);
    await editAndPublish(rig, a, { [DAILY]: "A second edition of the daily note.\n" });
    pointNameAt(node);
    const first = await b.pull();
    expect(first.kind).toBe("completed");
    const texts = b.texts();
    // The state folder is gone (the key-slot copy with it); the per-user store, where the floor lives, is not.
    for (const key of [...b.host.kvStore.keys()]) b.host.kvStore.delete(key);
    for (const path of [...b.host.files.keys()]) if (path.startsWith(".ipfs-sync/")) b.host.drop(path);
    pointNameAt(node, olderRoot);

    const outcome = await b.pull();

    expect(outcome.kind).toBe("stopped");
    if (outcome.kind === "stopped") {
      expect(outcome.stop.reason).toBe("older");
      expect(outcome.stop.message).toContain("recorded sequence 2");
    }
    expect(b.texts()).toEqual(texts);
  });
});

describe("overlapping publishes", () => {
  it.each(["adds-a-file", "replaces-a-file"] as const)(
    "another device completes a publish (it %s) while this one is writing: the loser refuses at the name re-check, publishes nothing, keeps its journal",
    async (winnerEdit) => {
      assertOverlapRefused(await runOverlappingPublishes(winnerEdit));
    },
  );

  it("the loser's next pull brings the winner's sequence in, sets the journal aside and keeps its unpublished edit", async () => {
    const { devices } = await runOverlappingPublishes("adds-a-file");
    const { b } = devices;
    const pulled = await b.pull();
    expect(pulled.kind).toBe("completed");
    if (pulled.kind !== "completed") return;
    expect(pulled.result.verdict).toBe("newer");
    expect(pulled.result.journalSetAside).toEqual({ name: "journal-set-aside.2.json", sequence: 2 });
    expect((await readJournal(b.host.kv, ROOT)).kind).toBe("none");
    expect(b.texts()["Inbox/from-the-winner.md"]).toBe("A added this note.\n");
    expect(b.texts()[PLAN]).toBe("B's edition, still being written.\n");
    expect(pulled.result.settlement.locallyModified).toEqual([PLAN]);
  });

});

/*
 * Defect D-1 (found by this suite, fixed in src/sync/publish-commit.ts: a refused name re-check withdraws the loser's own manifest.enc).
 * What it was, kept for the record. Spec second-device-publish, "Fork recovery is available": after an overlapping publish the losing device SHALL be able to recover
 * with `pull --resolve-fork`. What happens on the production path: the loser's refused publish has already overwritten
 * `<mfsRoot>/manifest.enc` in the shared MFS tree with its own pending manifest (journal, then `manifest.enc`, then the name
 * re-check refuses; nothing restores the file). The publisher classifies the node by that MFS file (`classifySequence`: equal
 * sequence, different `rootCID` is a fork), not by the name, so after the loser has pulled the winner's sequence 2, BOTH devices
 * refuse every publish with `sequence-fork` ("Run pull --resolve-fork"). The pull compares the NAME's manifest with the record,
 * finds the same identity and answers `same`, so `--resolve-fork` has nothing to resolve. No command in this build clears the state.
 * Probe output: winner publish refused: sequence-fork; loser pull -> newer; loser publish refused: sequence-fork;
 * loser pull --resolve-fork -> same; loser publish refused: sequence-fork; winner pull --resolve-fork -> same; winner publish refused.
 * These two tests assert the specified behaviour.
 */
describe("fork recovery after an overlapping publish", () => {
  it("the loser, after pulling the winner's sequence and running pull --resolve-fork, publishes its edit as sequence 3", async () => {
    const { devices } = await runOverlappingPublishes("adds-a-file");
    const { b, rig } = devices;
    expect((await b.pull()).kind).toBe("completed");
    const resolved = await b.pull({ options: { flags: { resolveFork: true } } });
    expect(resolved.kind).toBe("completed");
    const refusal = await editAndPublish(rig, b, {}).then(() => undefined, (error: unknown) => error as Error & { code?: string });
    expect(refusal?.code, refusal?.message).toBeUndefined();
  });

  it("the winner, whose publish completed, is not locked out by the loser's leftover manifest.enc", async () => {
    const { devices } = await runOverlappingPublishes("adds-a-file");
    const { a, rig } = devices;
    const refusal = await editAndPublish(rig, a, { "Inbox/from-the-winner.md": "A added this note, then edited it.\n" }).then(() => undefined, (error: unknown) => error as Error & { code?: string });
    expect(refusal?.code, refusal?.message).toBeUndefined();
  });
});

describe("crash, foreign publish, resume", () => {
  it("the rerun neither publishes nor adopts over the other device's manifest; the refusal names an overlapping publish", async () => {
    assertCrashResumeRefused(await runCrashForeignPublishResume());
  });

  it("the next pull sets the journal aside, keeps this device's unpublished edit, and the following publish is sequence 3 with both edits", async () => {
    const observed = await runCrashForeignPublishResume();
    const { a, rig, node } = observed.devices;
    const pulled = await a.pull();
    expect(pulled.kind).toBe("completed");
    if (pulled.kind !== "completed") return;
    expect(pulled.result.verdict).toBe("newer");
    expect(pulled.result.journalSetAside).toEqual({ name: "journal-set-aside.2.json", sequence: 2 });
    expect((await readJournal(a.host.kv, ROOT)).kind).toBe("none");
    expect(a.host.kvStore.has("journal-set-aside.2.json")).toBe(true);
    // A's own edit was never published: the pull leaves it (it differs from the baseline and the node's text did not change).
    expect(pulled.result.settlement.locallyModified).toContain(DAILY);
    expect(a.texts()[DAILY]).toBe("A's edition, written before the crash.\n");
    expect(a.texts()[PLAN]).toBe("B published sequence 2 while A was down.\n");

    const published = await editAndPublish(rig, a, {});
    expect(published.published).toBe(true);
    expect(published.sequence).toBe(3);
    const manifest = await rig.manifest();
    expect(manifest.sequence).toBe(3);
    servedRoot(node);
  });
});
