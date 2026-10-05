// mvp-07b task 6.2: the fixture-only guard is gone on the removal branch. The suite that asserted the refusals stays on
// `main` (fixture-marker.test.ts); this one asserts the permissive behaviour and the protections that stay.
import { describe, expect, it } from "vitest";
import { HELP_TEXT } from "../../cli/help-text";
import { FIXTURE_NOTICE_TITLE } from "../../src/plugin/settings-tab-copy";
import { FIXTURE_MARKER } from "../../src/sync/fixture-constants";
import { PullGuardError } from "../../src/sync/pull-errors";
import { assertPullDestination, assertVaultPullDestination, FIXTURE_ONLY_PULL_NOTICE, PULL_SCOPE_HELP, writeFixtureMarker } from "../../src/sync/pull-guard";
import { assertFixtureVault, assertPublishMarker, FIXTURE_ONLY_NOTICE, PUBLISH_SCOPE_HELP, PUBLISH_SCOPE_SETTINGS_COPY } from "../../src/sync/publish-guard";
import { newPuller, publishedOnce, runPull, verifiedOf } from "../helpers/encrypted-pull-rig";
import { createMemoryHost } from "../helpers/memory-host";
import { createRig } from "../helpers/publish-rig";

const MUTATING = /^(write|rm|pin|publish|keyGen) /;
const FIXTURE_WORDING = /fixture|independently reviewed|review/i;

/** Every marker content the removed guard used to refuse, plus no marker at all. */
const MARKERS: readonly (readonly [string, string | undefined])[] = [
  ["no marker", undefined],
  ["an empty marker", ""],
  ["a marker written by pull", "pulled-fixture\n"],
  ["an unrecognised marker", "marker"],
  ["the pull marker of release 0.2.0", "fixture copy created by ipfs-sync pull\n"],
];

describe("publish without a marker", () => {
  it.each(MARKERS)("publishes a vault with %s, encrypted", async (_label, marker) => {
    const rig = createRig({ marker: false });
    if (marker !== undefined) rig.host.put(FIXTURE_MARKER, marker);
    rig.host.put("notes/private.md", "my real notes", 1000);
    await rig.init();

    const result = await rig.publish();

    expect(result.published).toBe(true);
    expect([...rig.node.files.keys()].some((path) => path.endsWith("notes/private.md"))).toBe(false);
  });

  it("the gate functions return without looking at the vault", async () => {
    const host = createMemoryHost();
    await expect(assertPublishMarker(host.fs)).resolves.toBeUndefined();
    expect(() => assertFixtureVault("absent")).not.toThrow();
    expect(() => assertFixtureVault("pulled-fixture")).not.toThrow();
    expect(host.reads.count).toBe(0);
  });
});

describe("pull into a non-empty directory", () => {
  it("both destination rules allow a populated directory with no marker and ask for none", async () => {
    const host = createMemoryHost();
    host.put("notes/keep.md", "keep");
    host.put("private.md", "my real notes");
    await expect(assertPullDestination(host.fs)).resolves.toEqual({ needsMarker: false });
    await expect(assertVaultPullDestination(host.fs)).resolves.toEqual({ needsMarker: false });
    expect(host.mutations).toEqual([]);
  });

  it("an absent or empty destination needs no marker either, and writing the marker does nothing", async () => {
    const host = createMemoryHost();
    await expect(assertPullDestination(host.fs)).resolves.toEqual({ needsMarker: false });
    await writeFixtureMarker(host.fs);
    expect(host.mutations).toEqual([]);
  });

  it("a pull into a directory that holds notes and no marker completes and writes no marker", async () => {
    const rig = await publishedOnce();
    const host = createMemoryHost();
    host.put("private.md", "my real notes");
    const puller = newPuller(host);

    const verified = verifiedOf(await runPull(rig, puller));

    expect(verified.needsMarker).toBe(false);
    expect(host.mutations.some((path) => String(path).includes(FIXTURE_MARKER))).toBe(false);
  });
});

describe("what stays refused", () => {
  it("a destination that is not a directory is still refused", async () => {
    const fs = { ...createMemoryHost().fs, stat: async () => ({ kind: "file" as const, size: 1, mtimeMs: 0 }) };
    await expect(assertPullDestination(fs)).rejects.toBeInstanceOf(PullGuardError);
    await expect(assertVaultPullDestination(fs)).rejects.toBeInstanceOf(PullGuardError);
  });

  it("a symbolic-link state folder is still refused by the destination rules", async () => {
    const host = createMemoryHost();
    host.put(".ipfs-sync/state.json", "{}");
    host.link(".ipfs-sync");
    await expect(assertPullDestination(host.fs)).rejects.toBeInstanceOf(PullGuardError);
    await expect(assertVaultPullDestination(host.fs)).rejects.toBeInstanceOf(PullGuardError);
  });

  it("a symbolic-link state folder is refused by the pull before any write, with no marker present", async () => {
    const rig = await publishedOnce();
    const host = createMemoryHost();
    host.put("private.md", "my real notes");
    host.put(".ipfs-sync/state.json", "{}");
    host.link(".ipfs-sync");
    const puller = newPuller(host);

    const error = await runPull(rig, puller).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PullGuardError);
    expect((error as Error).message).toMatch(/is a symbolic link; pull will not write its state through it/);
    expect(host.mutations).toEqual([]);
  });

  it("the mass-removal guard still stops a publish of an emptied vault, with no marker", async () => {
    const rig = createRig({ marker: false });
    const names = Array.from({ length: 10 }, (_, index) => `note-${index}.md`);
    for (const name of names) rig.host.put(name, `content of ${name}`, 1000);
    await rig.init();
    await rig.publish();
    rig.node.calls.length = 0;
    for (const name of names) rig.host.drop(name);

    await expect(rig.publish()).rejects.toMatchObject({ code: "mass-removal" });
    expect(rig.node.calls.filter((call) => MUTATING.test(call))).toEqual([]);
  });

  it("encryption stays mandatory: a publish without a passphrase is still refused", async () => {
    const rig = createRig({ marker: false });
    rig.host.put("notes/private.md", "my real notes", 1000);
    await rig.init();
    await expect(rig.publish({ passphrase: undefined })).rejects.toMatchObject({ code: "passphrase-required" });
  });
});

describe("the fixture-only copy is gone", () => {
  it("the notices, settings copy and settings title no longer say that only fixture vaults can be used", () => {
    for (const text of [FIXTURE_ONLY_NOTICE, FIXTURE_ONLY_PULL_NOTICE, PUBLISH_SCOPE_SETTINGS_COPY, FIXTURE_NOTICE_TITLE]) {
      expect(text).not.toMatch(FIXTURE_WORDING);
    }
  });

  it("the CLI help does not say that only fixture vaults are accepted", () => {
    expect(PUBLISH_SCOPE_HELP).not.toMatch(FIXTURE_WORDING);
    expect(PULL_SCOPE_HELP).not.toMatch(FIXTURE_WORDING);
    expect(HELP_TEXT).not.toMatch(/only fixture vaults|pulled-fixture|independently reviewed|\.ipfs-sync-fixture/);
  });
});
