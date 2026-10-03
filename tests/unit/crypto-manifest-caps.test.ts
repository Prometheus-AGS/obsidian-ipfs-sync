import { describe, expect, it } from "vitest";
import { MANIFEST_MAX_FILE_BYTES, OversizeInputError } from "../../src/crypto";
import { blobNameFromKey } from "../../src/crypto/blob-names";
import { MANIFEST_LIMITS, MANIFEST_MAX_ENTRIES, checkManifestCaps, createFilesMap, decodeManifestFile, encodeManifestFile, serializeManifestV2, type EncryptedManifest, type EncryptedManifestFile , checkManifestCapsWith, encodeManifestFileWith } from "../../src/sync/encrypted-manifest";

import { ROOT_CID, SHA, keysFrom, entryFor, manifestFor, seal, refusal } from "../vectors/manifest-helpers";

describe("manifest caps", () => {
  it("refuses 100,001 entries after authentication, by the entry cap", async () => {
    const keys = await keysFrom(1, 2);
    const entry = JSON.stringify(await entryFor(keys, "x"));
    const files = Array.from({ length: MANIFEST_MAX_ENTRIES + 1 }, (_, i) => `"p${i}":${entry}`).join(",");
    const base = JSON.parse(new TextDecoder().decode(serializeManifestV2(await manifestFor(keys, [])))) as Record<string, unknown>;
    const text = JSON.stringify({ ...base, files: null }).replace('"files":null', `"files":{${files}}`);
    const error = await refusal(decodeManifestFile(keys, await seal(keys, text)));
    expect(error).toBeInstanceOf(OversizeInputError);
    expect((error as OversizeInputError).cap).toBe("manifest-entries");
  }, 120_000);

  it("the writer refuses each cap by name before producing bytes", async () => {
    const keys = await keysFrom(1, 2);
    const small = await manifestFor(keys, ["a.md", "b.md", "c.md"]);
    const tight = { ...MANIFEST_LIMITS, maxEntries: 2 };
    const entries = await refusal(encodeManifestFileWith(keys, small, tight));
    expect((entries as OversizeInputError).cap).toBe("manifest-entries");
    const bytes = await refusal(encodeManifestFileWith(keys, small, { ...MANIFEST_LIMITS, maxPathBytes: 10 }));
    expect((bytes as OversizeInputError).cap).toBe("manifest-path-bytes");
    const size = await refusal(encodeManifestFileWith(keys, small, { ...MANIFEST_LIMITS, maxFileBytes: 500 }));
    expect((size as OversizeInputError).cap).toBe("manifest-file-size");
    expect(() => checkManifestCapsWith(small, tight)).toThrowError(OversizeInputError);
    expect(checkManifestCaps(small).sizes.entries).toBe(3);
    // And with the real limits, 100,001 entries are refused by the entry cap before any serialisation.
    const many = createFilesMap();
    const template = small.files["a.md"] as EncryptedManifestFile;
    for (let i = 0; i <= MANIFEST_MAX_ENTRIES; i++) many[`f${i}`] = template;
    const overEntries = (() => { try { checkManifestCaps({ ...small, files: many }); } catch (error) { return error; } return undefined; })();
    expect((overEntries as OversizeInputError).cap).toBe("manifest-entries");
    // Nine paths of 1 MiB exceed the 8 MiB path-byte cap.
    const heavy = createFilesMap();
    for (let i = 0; i < 9; i++) heavy[`${i}${"x".repeat(1024 * 1024)}`] = template;
    const overBytes = (() => { try { checkManifestCaps({ ...small, files: heavy }); } catch (error) { return error; } return undefined; })();
    expect((overBytes as OversizeInputError).cap).toBe("manifest-path-bytes");
  });

  it("the reader refuses more than 8 MiB of total path bytes after authentication", async () => {
    const keys = await keysFrom(1, 2);
    const template = await entryFor(keys, "x");
    const heavy = createFilesMap();
    // Each path is within the 4096-byte path limit (B1-01), so it is the 8 MiB total that trips: 2,400 paths of about 3,600 bytes.
    const deep = Array.from({ length: 14 }, () => "y".repeat(255)).join("/");
    for (let i = 0; i < 2400; i++) heavy[`${i}/${deep}`] = template;
    const text = new TextDecoder().decode(serializeManifestV2({ ...(await manifestFor(keys, [])), files: heavy }));
    const error = await refusal(decodeManifestFile(keys, await seal(keys, text)));
    expect((error as OversizeInputError).cap).toBe("manifest-path-bytes");
  }, 60_000);

  it("a synthetic manifest at 100,000 entries with typical entries encrypts to under 64 MiB and reads back", async () => {
    const keys = await keysFrom(1, 2);
    const nameKey = await keys.nameKey();
    const files = createFilesMap();
    const paths = Array.from({ length: MANIFEST_MAX_ENTRIES }, (_, i) => `notes/projects/2026/quarter-${String(i % 4)}/document-number-${String(i).padStart(6, "0")}-with-a-long-title.md`);
    for (let start = 0; start < paths.length; start += 2000) {
      const slice = paths.slice(start, start + 2000);
      const names = await Promise.all(slice.map((path) => blobNameFromKey(nameKey, path)));
      slice.forEach((path, index) => {
        files[path] = { sha256: SHA, size: 123_456, blob: names[index] as string, fileId: "c".repeat(32), cid: ROOT_CID };
      });
    }
    const manifest: EncryptedManifest = { ...(await manifestFor(keys, [])), sequence: 42, files };
    const { file, sizes } = await encodeManifestFile(keys, manifest);
    expect(sizes.entries).toBe(MANIFEST_MAX_ENTRIES);
    expect(file.length).toBeLessThan(MANIFEST_MAX_FILE_BYTES);
    expect(file.length).toBe(sizes.fileBytes);
    const megabytes = (file.length / (1024 * 1024)).toFixed(1);
    expect(Number(megabytes)).toBeGreaterThan(20);
    const decoded = await decodeManifestFile(keys, file);
    expect(Object.keys(decoded.files)).toHaveLength(MANIFEST_MAX_ENTRIES);
    expect(decoded.sequence).toBe(42);
  }, 180_000);
});
