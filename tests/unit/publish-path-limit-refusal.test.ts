import { describe, expect, it } from "vitest";
import { PATH_LIMITS } from "../../src/sync/path-limits";
import { PublishRefusedError } from "../../src/sync/publish-refusals";
import { createRig, seedVault } from "../helpers/publish-rig";

/**
 * review-final N-01: the path limits (4096 bytes per path, 255 per segment, 128 segments) bind the publisher's own manifest. A local
 * file over a limit is refused on the writer side, by name (the path is the user's own, not node-supplied), before anything is sent;
 * it is not reported as a manifest "written by a newer or incompatible version". Policy: refuse and name the path, never exclude.
 */

const MUTATING = /^(write|rm|pin|publish|keyGen) /;
const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

async function refusedPublish(path: string): Promise<{ readonly error: unknown; readonly sent: string[] }> {
  const rig = createRig();
  seedVault(rig.host);
  await rig.init();
  rig.host.put(path, "body", 2000);
  rig.node.calls.length = 0;
  const error = await rejection(rig.publish());
  return { error, sent: rig.node.calls.filter((call) => MUTATING.test(call)) };
}

describe("a local path over a limit is refused by name on the publisher side (N-01)", () => {
  const cjkTitle = `${"笔记".repeat(43)}.md`; // 43 x 2 characters x 3 bytes + 3 = 261 bytes
  const cases: readonly { readonly label: string; readonly path: string; readonly limit: RegExp }[] = [
    { label: "a name segment over 255 bytes (a long CJK title)", path: `Journal/${cjkTitle}`, limit: /255 bytes/ },
    { label: "a path over 4096 bytes", path: `${Array.from({ length: 20 }, (_, i) => `${"d".repeat(250)}${i}`).join("/")}/n.md`, limit: /4096 bytes/ },
    { label: "a path of more than 128 segments", path: `${"a/".repeat(129)}n.md`, limit: /128 segments/ },
  ];

  for (const { label, path, limit } of cases) {
    it(`${label}: refused before anything is sent, the local path named, the limit named, and not blamed on the node`, async () => {
      const { error, sent } = await refusedPublish(path);
      expect(error).toBeInstanceOf(PublishRefusedError);
      expect(error).toMatchObject({ code: "path-limit" });
      const message = (error as Error).message;
      expect(message).toMatch(limit);
      expect(message).toMatch(/not published/);
      expect(message).not.toMatch(/newer or incompatible|update ipfs-sync/i);
      expect(message).toContain(path.slice(0, 40));
      expect(message.length).toBeLessThan(900);
      expect(sent).toEqual([]);
    });
  }

  it("shows the path escaped: a control character in a local name cannot forge terminal output", async () => {
    const { error } = await refusedPublish(`x/\u001b[31mred${"a".repeat(PATH_LIMITS.maxSegmentBytes)}.md`);
    expect(error).toMatchObject({ code: "path-limit" });
    expect((error as Error).message).not.toContain("\u001b");
  });

  it("names the first three offenders and counts the rest", async () => {
    const rig = createRig();
    seedVault(rig.host);
    await rig.init();
    for (let i = 0; i < 5; i += 1) rig.host.put(`n/${"z".repeat(PATH_LIMITS.maxSegmentBytes + 1)}${i}.md`, "b", 2000);
    const error = await rejection(rig.publish());
    expect(error).toMatchObject({ code: "path-limit" });
    expect((error as Error).message).toMatch(/and 2 more/);
  });

  it("a path exactly at the limits still publishes", async () => {
    const rig = createRig();
    seedVault(rig.host);
    await rig.init();
    rig.host.put(`n/${"y".repeat(PATH_LIMITS.maxSegmentBytes - 3)}.md`, "b", 2000);
    await expect(rig.publish()).resolves.toMatchObject({ published: true });
  });
});
