// Delta review A-M1: ONE CID rule (`isCidToken`, the local record's `CID_TOKEN`) is applied where a node value becomes a CID (a name's value, a root
// stat, a current stat) and where a CID is persisted (publish journal, maintenance journal, root state). Every variant of the rule is covered, not
// one example: too short, too long, other path shapes, characters outside the alphabet, whitespace. A refused value is never echoed.
import { describe, expect, it } from "vitest";
import { createCommitNode, type CommitClient } from "../../src/sync/commit-node";
import { buildJournal, writeJournal } from "../../src/sync/journal";
import { CID_TOKEN, isCidToken } from "../../src/sync/local-record";
import { buildPruneJournal, buildRewrapJournal, writeMaintenanceJournal } from "../../src/sync/maintenance-journal";
import { PublishRefusedError } from "../../src/sync/publish-refusals";
import { buildRootState, writeRootState } from "../../src/sync/root-state";
import { isCid, isIpnsName } from "../../src/sync/target-resolution";
import { KEY, ROOT } from "../helpers/publish-rig";
import { MFS_ROOT, scenario } from "../helpers/commit-scenario";

const OK = `bafy${"a".repeat(55)}`;
const MARK = "ZQXMARK";
const SHORT = `${MARK}12345`.slice(0, 9);
const LONG = `${MARK}${"a".repeat(122)}`;

/** Values the rule refuses, each carrying the marker so an echo is visible. */
const BAD_CIDS: readonly (readonly [string, string])[] = [
  ["9 characters", SHORT],
  ["129 characters", LONG],
  ["a hyphen", `${MARK}-aaaaaaaaaaaa`],
  ["a slash", `${MARK}/aaaaaaaaaaaa`],
  ["a dot", `${MARK}.aaaaaaaaaaaa`],
  ["leading whitespace", ` ${MARK}aaaaaaaaaaaa`],
  ["trailing whitespace", `${MARK}aaaaaaaaaaaa `],
  ["a newline", `${MARK}aaaaaa\naaaaaa`],
  ["a non-ASCII letter", `${MARK}aaaaaaaaaaaé`],
  ["an empty string", ""],
];

describe("the one CID rule", () => {
  it("accepts 10 to 128 alphanumeric characters and nothing else", () => {
    expect(isCidToken("a".repeat(10))).toBe(true);
    expect(isCidToken("a".repeat(128))).toBe(true);
    expect(isCidToken(OK)).toBe(true);
    expect(isCidToken("a".repeat(9))).toBe(false);
    expect(isCidToken("a".repeat(129))).toBe(false);
    for (const [, value] of BAD_CIDS) expect(isCidToken(value)).toBe(false);
    for (const value of [undefined, null, 5, {}, ["a".repeat(20)]]) expect(isCidToken(value)).toBe(false);
  });

  it("is the same rule as the record's token, the target check and the IPNS name check", () => {
    for (const value of [OK, "a".repeat(10), "a".repeat(128), ...BAD_CIDS.map(([, v]) => v)]) {
      expect(isCidToken(value)).toBe(CID_TOKEN.test(value));
      expect(isCid(value)).toBe(CID_TOKEN.test(value));
      expect(isIpnsName(value)).toBe(CID_TOKEN.test(value));
    }
  });
});

function commitNodeWith(overrides: Partial<CommitClient>): ReturnType<typeof createCommitNode> {
  const client = {
    filesStat: async () => ({ cid: OK, size: 0, cumulativeSize: 0, type: "directory" as const }),
    nameResolve: async () => `/ipfs/${OK}`,
    ...overrides,
  } as unknown as CommitClient;
  return createCommitNode({ client, mfsRoot: ROOT, key: KEY, ttl: "5m", keyId: () => "k51abc", keyCreated: () => false, beforeWrite: () => undefined });
}

async function refusal(read: () => Promise<unknown>): Promise<PublishRefusedError> {
  const error = await read().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PublishRefusedError);
  expect((error as PublishRefusedError).code).toBe("remote-object-invalid");
  expect((error as Error).message).not.toContain(MARK);
  return error as PublishRefusedError;
}

describe("a name's value: only /ipfs/<cid> with a valid cid", () => {
  const BAD_NAME_VALUES: readonly (readonly [string, string])[] = [
    ["an /ipns/ path", `/ipns/${OK}`],
    ["a path below the root", `/ipfs/${OK}/sub`],
    ["a path below the root with the marker", `/ipfs/${MARK}aaaaaaaaaaaa/sub`],
    ["a bare token that passes the rule", OK],
    ["a bare token that fails the rule", SHORT],
    ["the prefix alone", "/ipfs/"],
    ["an empty value", ""],
    ["a trailing slash", `/ipfs/${OK}/`],
    ...BAD_CIDS.map(([label, value]) => [`a cid with ${label}`, `/ipfs/${value}`] as const),
  ];

  it.each(BAD_NAME_VALUES)("refuses %s", async (_label, value) => {
    const node = commitNodeWith({ nameResolve: async () => value });
    await refusal(() => node.resolveName());
  });

  it("returns the cid of a valid /ipfs/ path", async () => {
    expect(await commitNodeWith({}).resolveName()).toEqual({ kind: "value", root: OK });
    const edge = "a".repeat(128);
    expect(await commitNodeWith({ nameResolve: async () => `/ipfs/${edge}` }).resolveName()).toEqual({ kind: "value", root: edge });
  });
});

describe("a stat's cid: the same rule for the vault root and the current tree", () => {
  it.each(BAD_CIDS)("refuses %s in rootCid and currentCid", async (_label, value) => {
    const node = commitNodeWith({ filesStat: async () => ({ cid: value, size: 0, cumulativeSize: 0, type: "directory" as const }) });
    await refusal(() => node.rootCid());
    await refusal(() => node.currentCid());
  });

  it("returns a valid cid, including the 10 and 128 character edges", async () => {
    for (const cid of [OK, "a".repeat(10), "a".repeat(128)]) {
      const node = commitNodeWith({ filesStat: async () => ({ cid, size: 0, cumulativeSize: 0, type: "directory" as const }) });
      expect(await node.rootCid()).toBe(cid);
      expect(await node.currentCid()).toBe(cid);
    }
  });
});

function recordingKv(): { readonly sets: string[]; readonly kv: { set(key: string, value: Uint8Array<ArrayBuffer>): Promise<void> } } {
  const sets: string[] = [];
  return {
    sets,
    kv: {
      set: async (key) => {
        sets.push(key);
      },
    },
  };
}

const FACTS = {
  mfsRoot: MFS_ROOT,
  key: KEY,
  vaultId: "a".repeat(32),
  keyslotsSha256: "b".repeat(64),
  startRoot: OK as string | null,
  nodeSequence: 1,
  manifestSha256: "c".repeat(64),
  startedAt: "2026-10-05T00:00:00.000Z",
};

async function writeRefused(write: () => Promise<void>, sets: readonly string[]): Promise<void> {
  const error = await write().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(MARK);
  expect(sets).toEqual([]);
}

describe("the writers refuse what the readers would refuse, before any write", () => {
  it.each(BAD_CIDS)("the publish journal refuses a startRoot with %s", async (_label, value) => {
    const s = await scenario();
    const { manifest } = await s.next(2, ["notes/a.md"]);
    const { sets, kv } = recordingKv();
    const journal = buildJournal({
      mfsRoot: MFS_ROOT,
      key: KEY,
      vaultId: manifest.vaultId,
      keyslotsSha256: "b".repeat(64),
      sequence: 2,
      manifestSha256: "c".repeat(64),
      pending: { manifest, mtimes: {} },
      startedAt: "2026-10-05T00:00:00.000Z",
      startRoot: value,
    });
    await writeRefused(() => writeJournal(kv, journal), sets);
  });

  it("the publish journal still writes a valid startRoot, null and an unknown (format 1) one", async () => {
    const s = await scenario();
    const { manifest } = await s.next(2, ["notes/a.md"]);
    const base = { mfsRoot: MFS_ROOT, key: KEY, vaultId: manifest.vaultId, keyslotsSha256: "b".repeat(64), sequence: 2, manifestSha256: "c".repeat(64), pending: { manifest, mtimes: {} }, startedAt: "2026-10-05T00:00:00.000Z" };
    for (const startRoot of [OK, null, undefined]) {
      const { sets, kv } = recordingKv();
      await writeJournal(kv, buildJournal({ ...base, startRoot }));
      expect(sets).toHaveLength(1);
    }
  });

  it.each(BAD_CIDS)("the maintenance journal refuses a startRoot with %s", async (_label, value) => {
    const { sets, kv } = recordingKv();
    const journal = buildPruneJournal({ ...FACTS, startRoot: value }, []);
    await writeRefused(() => writeMaintenanceJournal(kv, journal), sets);
  });

  it.each(BAD_CIDS)("the maintenance journal refuses a snapshotRoot with %s", async (_label, value) => {
    const { sets, kv } = recordingKv();
    const journal = { ...buildRewrapJournal(FACTS, { oldKeySlots: new Uint8Array([1]), newKeySlots: new Uint8Array([2]) }), phase: "snapshotted" as const, snapshotRoot: value };
    await writeRefused(() => writeMaintenanceJournal(kv, journal), sets);
  });

  it("the maintenance journal still writes valid roots and null", async () => {
    for (const startRoot of [OK, null, "a".repeat(128)]) {
      const { sets, kv } = recordingKv();
      await writeMaintenanceJournal(kv, buildPruneJournal({ ...FACTS, startRoot }, []));
      expect(sets).toHaveLength(1);
    }
    const { sets, kv } = recordingKv();
    await writeMaintenanceJournal(kv, { ...buildPruneJournal(FACTS, []), phase: "snapshotted", snapshotRoot: OK });
    expect(sets).toHaveLength(1);
  });

  it.each(BAD_CIDS)("the root state refuses a rootCid with %s", async (_label, value) => {
    const s = await scenario();
    const { sets, kv } = recordingKv();
    await writeRefused(() => writeRootState(kv, buildRootState({ ...s.state1, rootCid: value })), sets);
  });

  it("the root state still writes a valid rootCid and null", async () => {
    const s = await scenario();
    for (const rootCid of [OK, null]) {
      const { sets, kv } = recordingKv();
      await writeRootState(kv, buildRootState({ ...s.state1, rootCid }));
      expect(sets).toHaveLength(1);
    }
  });
});
