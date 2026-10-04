import { beforeAll, describe, expect, it } from "vitest";
import type { Bytes } from "../../src/core/host-bridge";
import type { VaultKeys } from "../../src/crypto";
import { decodeManifestFile, encodeManifestFile } from "../../src/sync/encrypted-manifest";
import { PublishRefusedError } from "../../src/sync/publish-refusals";
import { readRootState, type RootState } from "../../src/sync/root-state";
import { assertUpToDate } from "../../src/sync/up-to-date-check";
import { MANIFEST_PATH, publishedRig } from "../helpers/maintenance-rig";
import { ROOT, type Rig } from "../helpers/publish-rig";

/** The shared up-to-date and floor check (task 1.3 (e)): in sync with the node's authenticated manifest, and not below the device's sequence floor. */

let rig: Rig;
let keys: VaultKeys;
let state: RootState;
let manifestFile: Bytes;

beforeAll(async () => {
  rig = await publishedRig();
  keys = await rig.keys();
  state = (await readRootState(rig.host.kv, ROOT)) as RootState;
  manifestFile = rig.node.files.get(MANIFEST_PATH) as Bytes;
});

const decodeManifest = (bytes: Bytes) => decodeManifestFile(keys, bytes);
const nodeServing = (bytes: Bytes | undefined) => ({ readManifestFile: async () => bytes });
const floor = (sequence: number) => ({ sequence, identity: "f".repeat(64), at: 1 });
const code = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(PublishRefusedError);
  return (error as PublishRefusedError).code;
};

describe("assertUpToDate", () => {
  it("returns the node's manifest and bytes when the record is in sync and at the floor", async () => {
    const result = await assertUpToDate({ node: nodeServing(manifestFile), decodeManifest, state, floor: floor(state.sequence) });
    expect(result.manifest.sequence).toBe(state.sequence);
    expect(result.manifestFile).toBe(manifestFile);
  });

  it("does not require the last pull to have been complete", async () => {
    await expect(assertUpToDate({ node: nodeServing(manifestFile), decodeManifest, state: { ...state, complete: false }, floor: undefined })).resolves.toBeDefined();
  });

  it("refuses a record below the floor even though it equals the node's manifest (a rolled-back node)", async () => {
    expect(await code(assertUpToDate({ node: nodeServing(manifestFile), decodeManifest, state, floor: floor(state.sequence + 1) }))).toBe("sequence-below-floor");
  });

  it("refuses when there is no record but a floor", async () => {
    expect(await code(assertUpToDate({ node: nodeServing(manifestFile), decodeManifest, state: undefined, floor: floor(1) }))).toBe("sequence-below-floor");
  });

  it("refuses when the node is ahead of the record", async () => {
    expect(await code(assertUpToDate({ node: nodeServing(manifestFile), decodeManifest, state: { ...state, sequence: state.sequence - 1, manifest: { ...state.manifest, sequence: state.sequence - 1 } }, floor: undefined }))).toBe("sequence-ahead");
  });

  it("refuses when the node serves an older manifest than the record", async () => {
    expect(await code(assertUpToDate({ node: nodeServing(manifestFile), decodeManifest, state: { ...state, sequence: state.sequence + 1, manifest: { ...state.manifest, sequence: state.sequence + 1 } }, floor: undefined }))).toBe("sequence-behind");
  });

  it("refuses a fork: the same sequence over another snapshot", async () => {
    const other = { ...state.manifest, rootCID: `${state.manifest.rootCID.slice(0, -2)}aa` };
    expect(await code(assertUpToDate({ node: nodeServing(manifestFile), decodeManifest, state: { ...state, manifest: other }, floor: undefined }))).toBe("sequence-fork");
  });

  it("refuses a manifest.enc that does not authenticate", async () => {
    const forged = (await encodeManifestFile(keys, { ...state.manifest })).file;
    forged[forged.length - 1] = (forged[forged.length - 1] ?? 0) ^ 1;
    expect(await code(assertUpToDate({ node: nodeServing(forged), decodeManifest, state, floor: undefined }))).toBe("node-manifest-unreadable");
  });

  it("refuses a node that shows no manifest.enc to a device that published", async () => {
    expect(await code(assertUpToDate({ node: nodeServing(undefined), decodeManifest, state, floor: undefined }))).toBe("node-manifest-missing");
  });

  it("refuses when nothing was ever published and nothing is recorded", async () => {
    expect(await code(assertUpToDate({ node: nodeServing(undefined), decodeManifest, state: undefined, floor: undefined }))).toBe("no-vault");
  });
});
