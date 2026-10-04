// mvp-07b task 4.2: the tools/ allow-list entry for operator-run scripts, the sentinel-per-module check, and the two
// placement decisions the lint forces on other tasks (2.2 measure-derivation, 2.3 desktop streaming transport).
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as publicCrypto from "../../src/crypto";
import {
  TOOL_TESTING_IMPORT_ALLOWLIST,
  findBoundaryImports,
  findInjectionLeaks,
  findTestingImports,
  isToolTestingImportAllowed,
  lintTestingImports,
  loadSentinels,
} from "../../tools/hook-isolation.mjs";

const TESTING_IMPORT = 'import { argon2idRaw } from "../src/crypto/testing/argon2id-raw.ts";';

async function fixtureRoot(modules: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hook-isolation-"));
  for (const [path, text] of Object.entries(modules)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, text);
  }
  return root;
}

describe("sentinel coverage of src/crypto/testing (spec guard-evidence item D)", () => {
  it("a testing module with no sentinel fails the check", async () => {
    const root = await fixtureRoot({
      "src/crypto/testing/a.ts": 'export const A = "IPFS_SYNC_TEST_ONLY_SENTINEL_A";',
      "src/crypto/testing/b.ts": "export const B = 1;",
    });
    await expect(loadSentinels(root)).rejects.toThrow("src/crypto/testing/b.ts must declare exactly one sentinel string, found 0");
  });

  it("a nested testing module with no sentinel fails, and two modules sharing one sentinel fail", async () => {
    const nested = await fixtureRoot({
      "src/crypto/testing/a.ts": 'export const A = "IPFS_SYNC_TEST_ONLY_SENTINEL_A";',
      "src/crypto/testing/deep/c.ts": "export const C = 1;",
    });
    await expect(loadSentinels(nested)).rejects.toThrow("src/crypto/testing/deep/c.ts");
    const shared = await fixtureRoot({
      "src/crypto/testing/a.ts": 'export const A = "IPFS_SYNC_TEST_ONLY_SENTINEL_SAME";',
      "src/crypto/testing/b.ts": 'export const B = "IPFS_SYNC_TEST_ONLY_SENTINEL_SAME";',
    });
    await expect(loadSentinels(shared)).rejects.toThrow("must not share a sentinel string");
  });

  it("a module declaring two different sentinels fails", async () => {
    const root = await fixtureRoot({
      "src/crypto/testing/a.ts": 'export const A = "IPFS_SYNC_TEST_ONLY_SENTINEL_A"; export const B = "IPFS_SYNC_TEST_ONLY_SENTINEL_B";',
    });
    await expect(loadSentinels(root)).rejects.toThrow("found 2");
  });
});

describe("tools/feature-op-*.mjs allow-list entry (R5-11)", () => {
  it("is exactly one documented pattern, matching only flat tools/feature-op-<name>.mjs files", () => {
    expect(TOOL_TESTING_IMPORT_ALLOWLIST).toEqual(["tools/feature-op-*.mjs"]);
    for (const path of ["tools/feature-op-mvp-07.mjs", "tools/feature-op-mvp-07a.mjs", "tools\\feature-op-mvp-07.mjs"]) {
      expect(isToolTestingImportAllowed(path), path).toBe(true);
    }
    for (const path of [
      "tools/feature-op-mvp-07/toolbox.mjs", // a subfolder is not listed: helpers keep the R5-11 name-building workaround
      "tools/feature-op-.mjs",
      "tools/feature-op-x.ts",
      "tools/check-guard-preconditions.mjs",
      "tools/hook-isolation.mjs",
      "tools/release/plan.mjs",
      "tools/../src/feature-op-x.mjs",
      "tools/feature-op-../x.mjs",
      "src/feature-op-mvp-07.mjs",
      "cli/feature-op-mvp-07.mjs",
      "src/plugin/tools/feature-op-mvp-07.mjs",
      "tests/unit/tools/feature-op-mvp-07.mjs",
    ]) {
      expect(isToolTestingImportAllowed(path), path).toBe(false);
    }
  });

  it("a feature-op script importing the testing folder passes only through the allow-list entry", () => {
    expect(findTestingImports([{ path: "tools/feature-op-mvp-07.mjs", text: TESTING_IMPORT }], process.cwd(), { shipped: false })).toEqual([]);
  });

  it("a tool that is not on the list still fails, by every import form", () => {
    const forms = [
      TESTING_IMPORT,
      'const m = await import("../src/crypto/testing/unwrap-vck.ts");',
      'const m = require("../src/crypto/testing/unwrap-vck");',
      "const m = await import(`../src/crypto/testing/${name}`);",
      'import x from "@ipfs/crypto/testing/argon2id-raw";',
    ];
    for (const text of forms) {
      const offences = findTestingImports([{ path: "tools/check-guard-preconditions.mjs", text }], process.cwd(), { shipped: false });
      expect(offences, text).toHaveLength(1);
    }
    expect(findTestingImports([{ path: "tools/release/plan.mjs", text: TESTING_IMPORT.replace("../src", "../../src") }], process.cwd(), { shipped: false })).toHaveLength(1);
  });

  it("the entry does not reach shipped code: a feature-op-named file under src/ or cli/ still fails", () => {
    for (const path of ["src/feature-op-mvp-07.mjs", "cli/feature-op-mvp-07.mjs", "src/sync/feature-op-x.mjs"]) {
      expect(findTestingImports([{ path, text: TESTING_IMPORT }]), path).toHaveLength(1);
    }
  });

  it("the entry exempts the testing-folder import only: the injection lint and the boundary lint still see the script's other names", () => {
    const path = "tools/feature-op-mvp-07.mjs";
    // Boundary and injection lints already scope to src/cli; a tool is outside both, which is what the entry relies on.
    expect(findBoundaryImports([{ path, text: 'import { a } from "../src/crypto/blob.ts";' }])).toEqual([]);
    expect(findInjectionLeaks([{ path: "src/plugin/feature-op-mvp-07.mjs", text: "const k = deriveKek;" }])).toHaveLength(1);
  });

  it("the entry is documented in the file that carries it", async () => {
    const source = await readFile(join(process.cwd(), "tools/hook-isolation.mjs"), "utf8");
    expect(source).toMatch(/TOOL_TESTING_IMPORT_ALLOWLIST[\s\S]{0,40}=/);
    expect(source).toMatch(/R5-11/);
    expect(source).toMatch(/never bundled/i);
  });

  it("the real repository lints clean with the entry in place (no shipped file uses it)", async () => {
    expect(await lintTestingImports()).toEqual([]);
  });
});

describe("placement of the plugin's measure-derivation module (task 2.2)", () => {
  const PATH = "src/plugin/measure-derivation.ts";
  const SANCTIONED = [
    'import { createKeySlots, generatePassphrase } from "../crypto";',
    "export async function measureDerivation(onProgress?: (n: number) => void) {",
    "  const started = performance.now();",
    "  const created = await createKeySlots({ passphrase: generatePassphrase(), onProgress });",
    "  void created;",
    "  return performance.now() - started;",
    "}",
  ].join("\n");

  it("the sanctioned public path (generatePassphrase + createKeySlots through the crypto index) passes every lint with no allow-list entry", () => {
    expect(findInjectionLeaks([{ path: PATH, text: SANCTIONED }])).toEqual([]);
    expect(findBoundaryImports([{ path: PATH, text: SANCTIONED }])).toEqual([]);
    expect(findTestingImports([{ path: PATH, text: SANCTIONED }])).toEqual([]);
    expect(publicCrypto.createKeySlots).toBeTypeOf("function");
    expect(publicCrypto.generatePassphrase).toBeTypeOf("function");
  });

  it("naming deriveKek, a random source, createVaultKeys or a deep crypto import from that module is refused", () => {
    for (const text of [
      'import { deriveKek } from "../crypto/argon2";',
      "const kek = await deriveKek(p, salt, params);",
      "const bytes = secureRandom(32);",
      "const bytes = randomBytes(16);",
      "const keys = createVaultKeys(x);",
    ]) {
      expect(findInjectionLeaks([{ path: PATH, text }]), text).not.toEqual([]);
    }
    expect(findBoundaryImports([{ path: PATH, text: 'import { deriveKek } from "../crypto/argon2";' }])).toHaveLength(1);
  });

  it("the allow-list for deriveKek is unchanged: only argon2.ts and key-slots.ts", async () => {
    const { RESTRICTED_SYMBOLS } = await import("../../tools/hook-isolation.mjs");
    expect(RESTRICTED_SYMBOLS.deriveKek).toEqual(["src/crypto/argon2.ts", "src/crypto/key-slots.ts"]);
  });
});

describe("desktop streaming transport vs the WebView import probe (task 2.3)", () => {
  it("the probe's external allow-list stays exactly obsidian and electron: no Node built-in is sanctioned", async () => {
    const probe = await readFile(join(process.cwd(), "tools/webview-import-probe.mjs"), "utf8");
    expect(probe).toMatch(/const ALLOWED_EXTERNALS = new Set\(\["obsidian", "electron"\]\);/);
  });

  it("a Node-only import in the plugin graph is an external that is not on that list", async () => {
    const esbuild = (await import("esbuild")).default;
    const builtins = (await import("builtin-modules")).default;
    const result = await esbuild.build({
      stdin: { contents: 'import { request } from "node:https"; import { net } from "electron"; Object.assign(globalThis, { request, net });', resolveDir: process.cwd(), loader: "ts" },
      bundle: true,
      write: false,
      metafile: true,
      logLevel: "silent",
      format: "cjs",
      target: "es2022",
      external: ["obsidian", "electron", "node:*", ...builtins],
    });
    const externals = Object.values(result.metafile.outputs).flatMap((o) => o.imports.filter((i) => i.external).map((i) => i.path));
    expect(externals.sort()).toEqual(["electron", "node:https"]);
  });
});
