import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertParentInsideRoot } from "../../cli/realpath-guard";
import { HostPathError } from "../../src/sync/host-errors";

/**
 * The containment guard against a directory that appears between its two probes (mvp-07a 5.1). The pull's fetch pool writes
 * sibling files at the same time; the first of them creates `notes/daily` after another one saw `realpath` fail and before its
 * `lstat`. That `lstat` then found an entry `realpath` had not, which the guard took for a link that does not resolve, and the
 * file was skipped as unsafe (observed as a flaky exit 1 of the CLI pull tests). The guard now looks once more before refusing.
 */

const realpathMock = vi.fn<(path: string) => Promise<string>>();
const lstatMock = vi.fn<(path: string) => Promise<object>>();

vi.mock("node:fs/promises", () => ({
  realpath: (path: string) => realpathMock(path),
  lstat: (path: string) => lstatMock(path),
}));

const errno = (code: string): Error => Object.assign(new Error(code), { code });
const ROOT = "/vault";
const PARENT = "/vault/notes/daily";
const TARGET = "/vault/notes/daily/a.md";

beforeEach(() => {
  realpathMock.mockReset();
  lstatMock.mockReset();
});

describe("a parent directory that is created between the realpath and the lstat", () => {
  it("is accepted: the second look finds the directory", async () => {
    let parentLooks = 0;
    realpathMock.mockImplementation(async (path) => {
      if (path === ROOT) return ROOT;
      if (path === PARENT && (parentLooks += 1) === 1) throw errno("ENOENT");
      if (path === PARENT) return PARENT;
      throw errno("ENOENT");
    });
    lstatMock.mockResolvedValue({});
    await expect(assertParentInsideRoot(ROOT, TARGET, "notes/daily/a.md")).resolves.toBeUndefined();
    expect(parentLooks).toBe(2);
  });

  it("is still refused when the entry is a link that does not resolve", async () => {
    realpathMock.mockImplementation(async (path) => {
      if (path === ROOT) return ROOT;
      throw errno("ENOENT");
    });
    lstatMock.mockResolvedValue({});
    const refusal = assertParentInsideRoot(ROOT, TARGET, "notes/daily/a.md");
    await expect(refusal).rejects.toBeInstanceOf(HostPathError);
    await expect(refusal).rejects.toThrow(/does not resolve/);
  });

  it("is unchanged for a parent that does not exist: the nearest existing ancestor decides", async () => {
    realpathMock.mockImplementation(async (path) => {
      if (path === ROOT) return ROOT;
      throw errno("ENOENT");
    });
    lstatMock.mockImplementation(async (path) => {
      if (path === ROOT) return {};
      throw errno("ENOENT");
    });
    await expect(assertParentInsideRoot(ROOT, TARGET, "notes/daily/a.md")).resolves.toBeUndefined();
  });
});
