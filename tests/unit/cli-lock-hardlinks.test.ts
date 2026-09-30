import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: vi.fn(async () => {
      throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
    }),
  };
});

const { createNodeLockContext, createNodeLockFile } = await import("../../cli/publish-lock-file");
const { acquirePublishLock } = await import("../../src/sync/publish-lock");

describe("W-18: a file system without hard links", () => {
  let vault = "";
  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  it("gives a typed refusal naming hard links, not a raw EPERM", async () => {
    vault = await mkdtemp(join(tmpdir(), "ipfs-sync-nolink-"));
    const failure = await acquirePublishLock(createNodeLockFile(vault), createNodeLockContext(() => 1_800_000_000_000)).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "PublishRefusedError", code: "lock-unsupported" });
    expect((failure as Error).message).toMatch(/hard links/);
    expect((failure as Error).message).toContain("EPERM");
    expect((failure as Error).message).not.toContain(vault);
  });
});
