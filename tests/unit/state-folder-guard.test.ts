// mvp-07b task 3.2: the symlinked-state-folder refusal lives in state-folder-guard.ts alone and is called from the
// first step of the pull engine, so it still fires when both destination policy functions are permissive.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/sync/pull-guard", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/sync/pull-guard")>();
  return {
    ...original,
    assertPullDestination: async () => ({ needsMarker: false }),
    assertVaultPullDestination: async () => ({ needsMarker: false }),
  };
});

import { PullGuardError } from "../../src/sync/pull-errors";
import { assertStateFolderSafe } from "../../src/sync/state-folder-guard";
import { assertPullDestination, assertVaultPullDestination } from "../../src/sync/pull-guard";
import { createMemoryHost } from "../helpers/memory-host";
import { newPuller, publishedOnce, runPull } from "../helpers/encrypted-pull-rig";

const SYMLINK_MESSAGE = /"\.ipfs-sync" is a symbolic link; pull will not write its state through it/;

function linkedHost() {
  const host = createMemoryHost();
  host.put(".ipfs-sync/state.json", "{}");
  host.link(".ipfs-sync");
  return host;
}

describe("assertStateFolderSafe", () => {
  it("passes when the state folder is absent or a real directory", async () => {
    await expect(assertStateFolderSafe(createMemoryHost().fs)).resolves.toBeUndefined();
    const host = createMemoryHost();
    host.put(".ipfs-sync/state.json", "{}");
    await expect(assertStateFolderSafe(host.fs)).resolves.toBeUndefined();
  });

  it("refuses a symbolic link on the way to the state folder with a PullGuardError", async () => {
    const error = await assertStateFolderSafe(linkedHost().fs).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PullGuardError);
    expect((error as Error).message).toMatch(SYMLINK_MESSAGE);
  });
});

describe("the pull engine calls it first, whatever the policy functions do", () => {
  it("the mocked policy functions are permissive", async () => {
    const host = createMemoryHost();
    host.put("private.md", "my real notes");
    expect(await assertPullDestination(host.fs)).toEqual({ needsMarker: false });
    expect(await assertVaultPullDestination(host.fs)).toEqual({ needsMarker: false });
  });

  it("refuses with the default destination rule replaced by a permissive double", async () => {
    const rig = await publishedOnce();
    const host = linkedHost();
    const error = await runPull(rig, newPuller(host)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PullGuardError);
    expect((error as Error).message).toMatch(SYMLINK_MESSAGE);
    expect(rig.node.calls).toEqual([]);
    expect(host.mutations).toEqual([]);
  });

  it("refuses with an injected permissive assertDestination", async () => {
    const rig = await publishedOnce();
    const host = linkedHost();
    const permissive = async () => ({ needsMarker: false });
    const error = await runPull(rig, newPuller(host), { deps: { assertDestination: permissive } }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PullGuardError);
    expect((error as Error).message).toMatch(SYMLINK_MESSAGE);
    expect(rig.node.calls).toEqual([]);
    expect(host.mutations).toEqual([]);
  });
});
