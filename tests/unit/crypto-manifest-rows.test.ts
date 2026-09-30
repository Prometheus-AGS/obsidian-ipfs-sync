// G-06 frozen readings, one production row each (the reference decryptor has the same rows in crypto-reference-crosscheck).
import { describe, expect, it } from "vitest";
import { CryptoError, utf8 } from "../../src/crypto";
import { parseStrictJson } from "../../src/crypto/strict-json";
import { parseManifestV2, serializeManifestV2 } from "../../src/sync/encrypted-manifest";
import { keysFrom, manifestFor } from "../vectors/manifest-helpers";

type Edit = (o: Record<string, any>) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

const ROWS: readonly (readonly [string, Edit, ((text: string) => string) | undefined, boolean])[] = [
  ["device empty", (o) => { o["device"] = ""; }, undefined, false],
  ["device 1 code point", (o) => { o["device"] = "x"; }, undefined, true],
  ["device 64 code points", (o) => { o["device"] = "x".repeat(64); }, undefined, true],
  ["device 65 code points", (o) => { o["device"] = "x".repeat(65); }, undefined, false],
  ["device 64 astral characters", (o) => { o["device"] = "\u{1F600}".repeat(64); }, undefined, true],
  ["device 65 astral characters", (o) => { o["device"] = "\u{1F600}".repeat(65); }, undefined, false],
  ["device lone surrogate", (o) => { o["device"] = "a\ud800b"; }, undefined, false],
  ["device U+0000", (o) => { o["device"] = "a\u0000b"; }, undefined, false],
  ["device U+001F", (o) => { o["device"] = "a\u001fb"; }, undefined, false],
  ["device U+007F", (o) => { o["device"] = "a\u007fb"; }, undefined, false],
  ["device newline", (o) => { o["device"] = "a\nb"; }, undefined, false],
  ["device U+0080 (not a refused control)", (o) => { o["device"] = "a\u0080b"; }, undefined, true],
  ["publishedAt 2026-02-30", (o) => { o["publishedAt"] = "2026-02-30T00:00:00Z"; }, undefined, false],
  ["publishedAt 24:00:00", (o) => { o["publishedAt"] = "2026-09-30T24:00:00Z"; }, undefined, false],
  ["publishedAt 2024-02-29", (o) => { o["publishedAt"] = "2024-02-29T12:00:00Z"; }, undefined, true],
  ["publishedAt 2023-02-29", (o) => { o["publishedAt"] = "2023-02-29T00:00:00Z"; }, undefined, false],
  ["publishedAt 1900-02-29", (o) => { o["publishedAt"] = "1900-02-29T00:00:00Z"; }, undefined, false],
  ["publishedAt 2000-02-29", (o) => { o["publishedAt"] = "2000-02-29T00:00:00Z"; }, undefined, true],
  ["publishedAt April 31", (o) => { o["publishedAt"] = "2026-04-31T00:00:00Z"; }, undefined, false],
  ["publishedAt day 00", (o) => { o["publishedAt"] = "2026-04-00T00:00:00Z"; }, undefined, false],
  ["publishedAt month 00", (o) => { o["publishedAt"] = "2026-00-10T00:00:00Z"; }, undefined, false],
  ["publishedAt month 13", (o) => { o["publishedAt"] = "2026-13-01T00:00:00Z"; }, undefined, false],
  ["publishedAt minute 60", (o) => { o["publishedAt"] = "2026-09-30T00:60:00Z"; }, undefined, false],
  ["publishedAt second 60", (o) => { o["publishedAt"] = "2026-09-30T00:00:60Z"; }, undefined, false],
  ["publishedAt 23:59:59", (o) => { o["publishedAt"] = "2026-09-30T23:59:59Z"; }, undefined, true],
  ["publishedAt 3 fractional digits", (o) => { o["publishedAt"] = "2026-09-30T00:00:00.123Z"; }, undefined, true],
  ["publishedAt 4 fractional digits", (o) => { o["publishedAt"] = "2026-09-30T00:00:00.1234Z"; }, undefined, false],
  ["publishedAt empty fraction", (o) => { o["publishedAt"] = "2026-09-30T00:00:00.Z"; }, undefined, false],
  ["publishedAt offset", (o) => { o["publishedAt"] = "2026-09-30T00:00:00+00:00"; }, undefined, false],
  ["publishedAt lower-case t and z", (o) => { o["publishedAt"] = "2026-09-30t00:00:00z"; }, undefined, false],
  ["sequence 1e2", (o) => { o["sequence"] = 0; }, (t) => t.replace('"sequence":0', '"sequence":1e2'), false],
  ["sequence 1.0", (o) => { o["sequence"] = 0; }, (t) => t.replace('"sequence":0', '"sequence":1.0'), false],
  ["sequence -0", (o) => { o["sequence"] = 0; }, (t) => t.replace('"sequence":0', '"sequence":-0'), false],
  ["sequence 01", (o) => { o["sequence"] = 0; }, (t) => t.replace('"sequence":0', '"sequence":01'), false],
  ["sequence +1", (o) => { o["sequence"] = 0; }, (t) => t.replace('"sequence":0', '"sequence":+1'), false],
  ["sequence 100", (o) => { o["sequence"] = 100; }, undefined, true],
  ["sequence 2^53", (o) => { o["sequence"] = 0; }, (t) => t.replace('"sequence":0', '"sequence":9007199254740992'), false],
  ["sequence 2^53-1", (o) => { o["sequence"] = 9007199254740991; }, undefined, true],
  ["entry size 2e1", (o) => { o["files"]["a.md"]["size"] = 0; }, (t) => t.replace('"size":0', '"size":2e1'), false],
  ["entry size 1.5", (o) => { o["files"]["a.md"]["size"] = 0; }, (t) => t.replace('"size":0', '"size":1.5'), false],
  ["entry size 0", (o) => { o["files"]["a.md"]["size"] = 0; }, undefined, true],
  ["entry cid 128 chars", (o) => { o["files"]["a.md"]["cid"] = `b${"a".repeat(127)}`; }, undefined, true],
  ["entry cid 129 chars", (o) => { o["files"]["a.md"]["cid"] = `b${"a".repeat(128)}`; }, undefined, false],
  ["rootCID 128 chars", (o) => { o["rootCID"] = `b${"a".repeat(127)}`; }, undefined, true],
  ["rootCID 129 chars", (o) => { o["rootCID"] = `b${"a".repeat(128)}`; }, undefined, false],
];

describe("frozen readings of the manifest specification", () => {
  for (const [name, edit, raw, accept] of ROWS) {
    it(`${name}: ${accept ? "accepted" : "refused"}`, async () => {
      const keys = await keysFrom(1, 2);
      const base = await manifestFor(keys, ["a.md"]);
      const object = JSON.parse(new TextDecoder().decode(serializeManifestV2(base))) as Record<string, unknown>;
      edit(object);
      const text = raw === undefined ? JSON.stringify(object) : raw(JSON.stringify(object));
      const result = await parseManifestV2(keys, utf8(text)).then(
        () => "accept",
        (error: unknown) => (error instanceof CryptoError ? "refuse" : `raw:${String(error)}`),
      );
      expect(result).toBe(accept ? "accept" : "refuse");
    });
  }

  it("JSON nesting depth: 32 containers accepted, 33 refused, in both modes", () => {
    const nest = (n: number): string => "[".repeat(n) + "]".repeat(n);
    for (const options of [{}, { integersOnly: true }]) {
      expect(() => parseStrictJson(nest(32), options)).not.toThrow();
      expect(() => parseStrictJson(nest(33), options)).toThrowError(CryptoError);
    }
    expect(() => parseStrictJson(`${"{\"a\":".repeat(32)}1${"}".repeat(32)}`)).not.toThrow();
    expect(() => parseStrictJson(`${"{\"a\":".repeat(33)}1${"}".repeat(33)}`)).toThrowError(CryptoError);
  });

  it("integersOnly mode refuses -0, 1e2, 1.0, leading zeros and accepts plain integers", () => {
    for (const bad of ["-0", "1e2", "1.0", "1.5", "01", "1E2", "[1e0]", '{"a":-0}']) expect(() => parseStrictJson(bad, { integersOnly: true }), bad).toThrowError(CryptoError);
    for (const good of ["0", "-5", "123456789", '{"a":[0,1,-2]}']) expect(() => parseStrictJson(good, { integersOnly: true }), good).not.toThrow();
    expect(() => parseStrictJson("1.5")).not.toThrow();
  });
});
