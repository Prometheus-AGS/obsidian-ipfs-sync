import { readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRepo, loadChecker, removeRepos, type CheckerModule } from "../helpers/guard-repo.ts";

/**
 * mvp-07b task 4.6 follow-up: the checker's own import scan (resolveImportScope, reached through computeTreeHash) run over the REAL text
 * of the operator-run harness and of every tools/ module it reaches, in a temporary git repository. A computed import() anywhere in that
 * graph (for example the 07a toolbox loading an esbuild bundle) is an `import-non-literal` failure and would fail item T on the real tree.
 */
const ROOT = resolve(__dirname, "..", "..");
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;
const ROOTS = ["tools/feature-op-mvp-07.mjs", "tools/check-guard-preconditions.mjs"];

/** The tools/ files and root files reachable from `roots` by relative literal imports. */
function reachable(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    if (!path.endsWith(".mjs")) return;
    for (const match of readFileSync(join(ROOT, path), "utf8").matchAll(RELATIVE_IMPORT)) visit(posix.normalize(posix.join(dirname(path), match[1])));
  };
  roots.forEach(visit);
  return [...seen].sort();
}

let checker: CheckerModule;
beforeAll(async () => {
  checker = await loadChecker();
});
afterAll(removeRepos);

describe("the checker's import scan over the real operator-run harness", () => {
  it("reaches the harness modules, and finds no import-* failure in any of them", () => {
    const paths = reachable(ROOTS);
    expect(paths).toContain("tools/feature-op-mvp-07/run.mjs");
    expect(paths).toContain("tools/hook-isolation.mjs");
    const files: Record<string, string> = { "package.json": "{}\n" };
    for (const path of paths) files[path] = readFileSync(join(ROOT, path), "utf8");
    const result = checker.computeTreeHash({ root: createRepo(files) });
    const failures = result.ok ? [] : result.failures.filter((failure) => failure.code.startsWith("import-"));
    expect(failures, "import failures").toEqual([]);
    expect(result.ok, JSON.stringify(result.ok ? [] : result.failures)).toBe(true);
  });

  it("adds the reached 07a modules to T by exact path (and still no subfolder of 07a by glob)", () => {
    const paths = reachable(ROOTS);
    const files: Record<string, string> = { "package.json": "{}\n" };
    for (const path of paths) files[path] = readFileSync(join(ROOT, path), "utf8");
    const result = checker.computeTreeHash({ root: createRepo(files) });
    expect(result.ok).toBe(true);
    const hashed = result.ok ? result.entries.map((entry) => entry.path) : [];
    for (const path of paths.filter((candidate) => candidate.startsWith("tools/feature-op-mvp-07a/"))) expect(hashed).toContain(path);
  });
});
