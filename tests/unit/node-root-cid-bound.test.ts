// Review round 3, S-M2: a root CID supplied by the node is bounded at 128 characters where it enters, with the same bound the local
// record applies when it reads a state or journal file back (`CID_TOKEN`), so a hostile endpoint cannot make this build write a file
// it later refuses. The refusal is a fixed message that does not echo the value.
import { describe, expect, it, vi } from "vitest";
import { createCommitNode, type CommitClient } from "../../src/sync/commit-node";
import { PullSourceError } from "../../src/sync/pull-errors";
import { PublishRefusedError } from "../../src/sync/publish-refusals";
import { isCid, resolveRootCid } from "../../src/sync/target-resolution";
import { CID_TOKEN } from "../../src/sync/local-record";
import type { ResolvedEndpoint } from "../../src/core/config";
import { createKuboClient } from "../../src/kubo";
import { KEY, ROOT } from "../helpers/publish-rig";
import { expectNothingWritten, newPuller, publishedOnce, runPull, stopOf } from "../helpers/encrypted-pull-rig";

const LONG = `bafy${"a".repeat(196)}`;
const OK = `bafy${"a".repeat(55)}`;

function commitNodeWith(overrides: Partial<CommitClient>): ReturnType<typeof createCommitNode> {
  const client = {
    filesStat: async () => ({ cid: OK, size: 0, cumulativeSize: 0, type: "directory" as const }),
    nameResolve: async () => `/ipfs/${OK}`,
    ...overrides,
  } as unknown as CommitClient;
  return createCommitNode({ client, mfsRoot: ROOT, key: KEY, ttl: "5m", keyId: () => "k51abc", keyCreated: () => false, beforeWrite: () => undefined });
}

describe("the bound matches the local record's", () => {
  it("accepts 128 characters and refuses 129 in the token the record reads back", () => {
    expect(CID_TOKEN.test("a".repeat(128))).toBe(true);
    expect(CID_TOKEN.test("a".repeat(129))).toBe(false);
    expect(isCid("a".repeat(128))).toBe(true);
    expect(isCid("a".repeat(129))).toBe(false);
  });
});

describe("a name that resolves to a root longer than a CID", () => {
  it("resolveRootCid refuses with a fixed message that does not carry the value", async () => {
    const error = await resolveRootCid({ nameResolve: async () => `/ipfs/${LONG}` }, "k51abc").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PullSourceError);
    expect((error as Error).message).not.toContain("aaaa");
    expect(await resolveRootCid({ nameResolve: async () => `/ipfs/${OK}` }, "k51abc")).toBe(OK);
  });

  it("the commit adapter refuses a name value, a root stat and a current stat above the bound, and echoes nothing", async () => {
    const node = commitNodeWith({
      nameResolve: async () => `/ipfs/${LONG}`,
      filesStat: async () => ({ cid: LONG, size: 0, cumulativeSize: 0, type: "directory" as const }),
    });
    for (const read of [() => node.resolveName(), () => node.rootCid(), () => node.currentCid()]) {
      const error = await read().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PublishRefusedError);
      expect((error as PublishRefusedError).code).toBe("remote-object-invalid");
      expect((error as Error).message).not.toContain("aaaa");
    }
  });

  it("the commit adapter still returns a CID within the bound", async () => {
    const node = commitNodeWith({});
    expect(await node.rootCid()).toBe(OK);
    expect(await node.resolveName()).toEqual({ kind: "value", root: OK });
  });
});

describe("the kubo client's own CID check", () => {
  it("refuses a pin or a publish of a CID above 128 characters before any request, without echoing it", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const rpc: ResolvedEndpoint = { name: "rpc", baseUrl: "https://rpc.example.org", auth: { kind: "none" } };
      const client = createKuboClient({ rpc, gateway: { ...rpc, name: "gateway", baseUrl: "https://gw.example.org" } });
      for (const call of [() => client.pinAdd(LONG), () => client.namePublish("obsidian-vault-sync", LONG)]) {
        const error = await call().catch((caught: unknown) => caught);
        expect((error as Error).message).toMatch(/not a valid CID/);
        expect((error as Error).message).not.toContain("aaaaaaaa");
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a pull from a name that serves a 200-character root", () => {
  it("is refused as an unresolved target and writes nothing", async () => {
    const rig = await publishedOnce();
    rig.node.published.set(rig.node.keys.find((key) => key.name === KEY)?.id ?? "", `/ipfs/${LONG}`);
    const b = newPuller();
    const stop = stopOf(await runPull(rig, b));
    expect(stop.reason).toBe("target-unresolved");
    expect(stop.message).not.toContain("aaaaaaaa");
    expectNothingWritten(b);
  });
});
