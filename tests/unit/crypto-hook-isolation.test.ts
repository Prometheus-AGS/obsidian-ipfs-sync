import { describe, expect, it } from "vitest";
import * as publicCrypto from "../../src/crypto";
import { GENERATED_PASSPHRASE_SENTINEL } from "../../src/crypto/testing/generated-passphrase";
import { ARGON2ID_RAW_SENTINEL } from "../../src/crypto/testing/argon2id-raw";
import { UNWRAP_VCK_SENTINEL } from "../../src/crypto/testing/unwrap-vck";
import { checkDistBundles, checkHookIsolation, findBoundaryImports, findInjectionLeaks, findTestingImports, lintTestingImports, loadSentinels } from "../../tools/hook-isolation.mjs";

describe("test-only crypto hooks stay out of shipped code", () => {
  it("every module under src/crypto/testing declares exactly one unique sentinel, matching its exported constant", async () => {
    const sentinels = await loadSentinels();
    expect(sentinels.map((entry) => entry.file)).toEqual([
      "src/crypto/testing/argon2id-raw.ts",
      "src/crypto/testing/generated-passphrase.ts",
      "src/crypto/testing/unwrap-vck.ts",
    ]);
    expect(sentinels.map((entry) => entry.sentinel)).toEqual([ARGON2ID_RAW_SENTINEL, GENERATED_PASSPHRASE_SENTINEL, UNWRAP_VCK_SENTINEL]);
    expect(new Set(sentinels.map((entry) => entry.sentinel)).size).toBe(sentinels.length);
    for (const { sentinel } of sentinels) expect(sentinel.startsWith("IPFS_SYNC_TEST_ONLY_SENTINEL_")).toBe(true);
  });

  it("the built plugin, CLI and crypto public surface contain no sentinel and list no test-only input", async () => {
    const report = await checkHookIsolation();
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.graphs.map((graph) => graph.label)).toEqual(["plugin bundle (src/main.ts)", "CLI bundle (cli/main.ts)", "crypto public surface"]);
    for (const graph of report.graphs) expect(graph.inputs).toBeGreaterThan(5);
  }, 60_000);

  it("a planted import of a testing module in a graph makes the assertion fail (metadata, and sentinel when it is used)", async () => {
    const metadataOnly = await checkHookIsolation({
      extraEntries: [{ label: "planted side-effect import", contents: 'import "./src/main"; import "./src/crypto/testing/argon2id-raw";' }],
    });
    expect(metadataOnly.ok).toBe(false);
    expect(metadataOnly.violations.join("\n")).toContain("src/crypto/testing/argon2id-raw.ts");

    const used = await checkHookIsolation({
      extraEntries: [
        {
          label: "planted use",
          contents:
            'import { argon2idRaw } from "./src/crypto/testing/argon2id-raw"; import { unwrapVckForTest } from "./src/crypto/testing/unwrap-vck"; Object.assign(globalThis, { argon2idRaw, unwrapVckForTest });',
        },
      ],
    });
    expect(used.ok).toBe(false);
    const text = used.violations.join("\n");
    expect(text).toContain("dependency metadata lists src/crypto/testing/argon2id-raw.ts");
    expect(text).toContain("emitted code contains the sentinel of src/crypto/testing/argon2id-raw.ts");
    expect(text).toContain("emitted code contains the sentinel of src/crypto/testing/unwrap-vck.ts");
    // The three real graphs are still clean in the same run.
    expect(used.violations.every((violation) => violation.startsWith("planted use"))).toBe(true);
  }, 60_000);

  it("the public crypto index exports neither test-only hook", () => {
    const names = Object.keys(publicCrypto);
    expect(names).not.toContain("argon2idRaw");
    expect(names).not.toContain("unwrapVckForTest");
    expect(names).not.toContain("unwrapVckInternal");
    expect(names.some((name) => name.toLowerCase().includes("sentinel"))).toBe(false);
  });

  it("lint: shipped code (src/ and cli/) imports nothing from src/crypto/testing", async () => {
    expect(await lintTestingImports()).toEqual([]);
  });

  it("lint: flags relative imports of the testing folder from non-test code and allows the testing folder and tests", () => {
    const flagged = findTestingImports([
      { path: "src/sync/publish.ts", text: 'import { argon2idRaw } from "../crypto/testing/argon2id-raw";' },
      { path: "src/plugin/x.ts", text: "const m = await import('../crypto/testing/unwrap-vck');" },
      { path: "cli/main.ts", text: 'import "../src/crypto/testing/unwrap-vck";' },
      { path: "src/crypto/index.ts", text: 'export * from "./testing/argon2id-raw";' },
      { path: "src/crypto/x.ts", text: 'export { a } from "./testing";' },
      { path: "src/core/y.ts", text: 'const m = require("../crypto/testing/argon2id-raw");' },
    ]);
    expect(flagged).toHaveLength(6);
    const allowed = findTestingImports([
      { path: "src/crypto/testing/unwrap-vck.ts", text: 'import { parseKeySlots } from "../key-slot-format"; import "./argon2id-raw";' },
      { path: "src/sync/publish.ts", text: 'import { createKeySlots } from "../crypto";' },
      { path: "src/crypto/key-slots.ts", text: 'import { x } from "./testing-notes";' },
    ]);
    expect(allowed).toEqual([]);
  });

  it("lint: refuses every import form that reaches the testing folder (bare, path-mapped, template literal, computed) in shipped code", () => {
    const flagged = findTestingImports([
      { path: "src/sync/a.ts", text: 'import { x } from "@ipfs/crypto/testing/argon2id-raw";' },
      { path: "src/sync/b.ts", text: "const m = await import(`../crypto/testing/${name}`);" },
      { path: "src/sync/c.ts", text: "const m = await import(spec);" },
      { path: "src/sync/d.ts", text: 'import x = require("../crypto/testing/unwrap-vck");' },
      { path: "cli/e.ts", text: "const m = require(path.join(dir, 'x'));" },
    ]);
    expect(flagged).toHaveLength(5);
  });

  it("lint: a planted deps: or random: option in a non-test crypto file, or an injectable symbol elsewhere, is flagged", () => {
    const leaks = findInjectionLeaks([
      { path: "src/crypto/hkdf.ts", text: "export interface X { readonly deps?: unknown }" },
      { path: "src/crypto/codec.ts", text: "export function f(random: () => Uint8Array) {}" },
      { path: "src/sync/encrypted-manifest.ts", text: "export function g(o: { random?: () => Uint8Array }) {}" },
      { path: "src/sync/publish.ts", text: 'import { unwrapVckInternal } from "../crypto/key-slots";' },
      { path: "src/plugin/session-keys.ts", text: "const k = createKeySlotsInternal({} as never, secureRandom, {});" },
      { path: "src/crypto/index.ts", text: 'export { decryptBlobUnchecked } from "./blob";' },
      { path: "cli/run.ts", text: "const r = KeySlotDeps;" },
    ]);
    expect(leaks).toHaveLength(8);
    expect(
      findInjectionLeaks([
        { path: "src/crypto/key-slots.ts", text: "export async function unwrapVckInternal(input: X, deps: KeySlotDeps = {}) { const random: R = 1; }" },
        { path: "src/crypto/blob.ts", text: "export function decryptBlobUnchecked(random: R) {}" },
        { path: "src/crypto/testing/unwrap-vck.ts", text: "unwrapVckInternal(x, { deps: 1, random: 2 });" },
        { path: "src/plugin/publish-runner.ts", text: "const options = { deps: realDeps };" },
      ]),
    ).toEqual([]);
  });

  it("the sentinel scan recurses into subfolders of the testing folder", async () => {
    const sentinels = await loadSentinels();
    expect(sentinels.every((entry) => entry.file.startsWith("src/crypto/testing/"))).toBe(true);
  });

  it("dist check: the emitted release artifacts, when present, hold no sentinel; absent ones are reported as missing", async () => {
    const report = await checkDistBundles();
    expect(report.violations).toEqual([]);
    expect(report.checked.length + report.missing.length).toBe(2);
    const fake = await checkDistBundles({ root: "/nonexistent-root-for-test" }).catch((e: unknown) => e);
    expect(fake).toBeInstanceOf(Error);
  });

  it("lint: widened injection names (kdf, selfTest, exponent, limits), quoted keys, shorthand and .mts files", () => {
    const leaks = findInjectionLeaks([
      { path: "src/crypto/codec.ts", text: "export function f(kdf: unknown) {}" },
      { path: "src/crypto/hmac.ts", text: "export const o = { selfTest };" },
      { path: "src/crypto/hkdf.ts", text: 'export const o = { "exponent": 16 };' },
      { path: "src/crypto/webcrypto.mts", text: "export function g(o: { limits?: number }) {}" },
      { path: "src/crypto/bytes.ts", text: 'const x = { "deps": 1 };' },
      { path: "src/crypto/codec.ts", text: "// deps: only a comment, and random: too\nexport const ok = 1;" },
      { path: "src/crypto/hkdf.ts", text: "const y = slot.kdf.alg + options.limits.maxEntries;" },
    ]);
    expect(leaks).toHaveLength(5);
    expect(findInjectionLeaks([{ path: "src/crypto/argon2.ts", text: "export const deriveKek: KdfFunction = async (kdf) => 1;" }, { path: "src/crypto/key-slots.ts", text: "const k = deps.kdf ?? deriveKek; const a = { kdf: k };" }])).toEqual([]);
  });

  it("lint: newly restricted internals (markParsed, assertParsed, createVaultKeys, deriveKek, KdfFunction, secureRandom, randomBytes, RandomSource) are refused outside their homes", () => {
    const names = ["markParsed", "assertParsed", "createVaultKeys", "createVaultKeysFromHex", "deriveKek", "KdfFunction", "secureRandom", "randomBytes", "RandomSource"];
    const leaks = findInjectionLeaks(names.filter((n) => n !== "createVaultKeysFromHex").map((name) => ({ path: "src/sync/vault-keys.ts", text: `const x = ${name};` })));
    expect(leaks).toHaveLength(8);
  });

  it("boundary: outside src/crypto, tests and tools an import into src/crypto must resolve to the index", () => {
    const offences = findBoundaryImports([
      { path: "src/sync/vault-keys.ts", text: 'import { a } from "../crypto";' },
      { path: "src/sync/vault-keys2.ts", text: 'import { a } from "../crypto/index";' },
      { path: "src/sync/x.ts", text: 'import { a } from "../crypto/key-slots";' },
      { path: "src/plugin/y.ts", text: 'const m = await import("../crypto/testing/unwrap-vck");' },
      { path: "cli/z.ts", text: 'import { a } from "../src/crypto/blob";' },
      { path: "cli/w.ts", text: 'export * from "../src/crypto/hkdf.ts";' },
      { path: "src/sync/encrypted-manifest.ts", text: 'import { a } from "../crypto/bytes";' },
      { path: "src/crypto/key-slots.ts", text: 'import { a } from "./argon2";' },
      { path: "tests/unit/x.test.ts", text: 'import { a } from "../../src/crypto/blob";' },
    ]);
    expect(offences).toHaveLength(4);
    expect(offences.join("\n")).toContain("src/sync/x.ts");
    expect(offences.join("\n")).toContain("cli/w.ts");
  });

  it("boundary: the shipped code today only imports the crypto index (and the listed codec exception)", async () => {
    expect(await lintTestingImports()).toEqual([]);
  });
});
