// Generates src/sync/path-fold-table.ts (mvp-07a task 3.1a, design decision 11).
// Node built-ins only. Reads two Unicode Character Database files of one pinned version, given by path or https URL and
// the expected sha256 of each, and writes the case-fold table (CaseFolding.txt statuses C and F) and the
// Default_Ignorable_Code_Point ranges (DerivedCoreProperties.txt). The output has no timestamp, so the same inputs give
// the same bytes. The generated file is never imported by this script.
//
// Usage:
//   node tools/gen-path-fold-table.mjs --unicode-version 17.0.0 \
//     --case-folding <path|url> --case-folding-sha256 <hex> \
//     --derived-core <path|url> --derived-core-sha256 <hex> [--out src/sync/path-fold-table.ts]
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BODY_MARKER = "// ---- body (sha256 above covers every byte after this line) ----\n";
const DEFAULT_OUT = fileURLToPath(new URL("../src/sync/path-fold-table.ts", import.meta.url));
const ENTRIES_PER_LINE = 5;
const RANGES_PER_LINE = 6;
const FOLD_STATUSES = new Set(["C", "F"]);
const IGNORABLE_PROPERTY = "Default_Ignorable_Code_Point";

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`bad arguments near ${JSON.stringify(flag)}`);
    values.set(flag.slice(2), value);
  }
  const need = (name) => {
    const value = values.get(name);
    if (value === undefined || value === "") throw new Error(`missing --${name}`);
    return value;
  };
  return {
    version: need("unicode-version"),
    caseFolding: need("case-folding"),
    caseFoldingSha256: need("case-folding-sha256").toLowerCase(),
    derivedCore: need("derived-core"),
    derivedCoreSha256: need("derived-core-sha256").toLowerCase(),
    out: resolve(values.get("out") ?? DEFAULT_OUT),
  };
}

async function readSource(location) {
  if (/^https?:\/\//.test(location)) {
    const response = await fetch(location);
    if (!response.ok) throw new Error(`fetch ${location} failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return readFile(location);
}

async function loadVerified(location, expectedSha256, expectedFirstLinePrefix, version) {
  const bytes = await readSource(location);
  const actual = sha256Hex(bytes);
  if (actual !== expectedSha256) throw new Error(`${location}: sha256 ${actual} does not match the pinned ${expectedSha256}`);
  const text = bytes.toString("utf8");
  const expectedFirst = `# ${expectedFirstLinePrefix}-${version}.txt`;
  const firstLine = text.split("\n", 1)[0].trim();
  if (firstLine !== expectedFirst) throw new Error(`${location}: first line ${JSON.stringify(firstLine)} is not ${JSON.stringify(expectedFirst)}`);
  return { text, sha256: actual };
}

function parseCaseFolding(text) {
  const entries = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.split("#", 1)[0].trim();
    if (line === "") continue;
    const fields = line.split(";").map((field) => field.trim());
    if (fields.length < 3) throw new Error(`CaseFolding.txt: malformed line ${JSON.stringify(raw)}`);
    const [code, status, mapping] = fields;
    if (!FOLD_STATUSES.has(status)) continue;
    const codePoint = Number.parseInt(code, 16);
    if (entries.has(codePoint)) throw new Error(`CaseFolding.txt: duplicate entry for ${code}`);
    entries.set(codePoint, mapping.split(/\s+/).map((part) => Number.parseInt(part, 16)));
  }
  if (entries.size === 0) throw new Error("CaseFolding.txt: no C or F entries found");
  return [...entries.entries()].sort((a, b) => a[0] - b[0]);
}

function parseIgnorableRanges(text) {
  const ranges = [];
  for (const raw of text.split("\n")) {
    const line = raw.split("#", 1)[0].trim();
    if (line === "") continue;
    const fields = line.split(";").map((field) => field.trim());
    if (fields.length < 2 || fields[1] !== IGNORABLE_PROPERTY) continue;
    const [first, last = first] = fields[0].split("..");
    ranges.push([Number.parseInt(first, 16), Number.parseInt(last, 16)]);
  }
  if (ranges.length === 0) throw new Error(`DerivedCoreProperties.txt: no ${IGNORABLE_PROPERTY} lines found`);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [first, last] of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
    else merged.push([first, last]);
  }
  return merged;
}

const hex = (value) => `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;

function chunk(items, size) {
  const lines = [];
  for (let i = 0; i < items.length; i += size) lines.push(items.slice(i, i + size));
  return lines;
}

function renderBody(version, foldEntries, ignorableRanges) {
  const foldLines = chunk(foldEntries.map(([code, mapping]) => `[${hex(code)}, [${mapping.map(hex).join(", ")}]]`), ENTRIES_PER_LINE);
  const rangeLines = chunk(ignorableRanges.map(([first, last]) => `[${hex(first)}, ${hex(last)}]`), RANGES_PER_LINE);
  return [
    `export const PATH_FOLD_UNICODE_VERSION = ${JSON.stringify(version)};`,
    "",
    "/** Full case folding, Unicode CaseFolding.txt statuses C and F: code point to its replacement code points. */",
    "export const CASE_FOLD_ENTRIES: readonly (readonly [number, readonly number[]])[] = [",
    ...foldLines.map((line) => `  ${line.join(", ")},`),
    "];",
    "",
    "/** Default_Ignorable_Code_Point, DerivedCoreProperties.txt: inclusive, sorted, non-overlapping ranges. */",
    "export const DEFAULT_IGNORABLE_RANGES: readonly (readonly [number, number])[] = [",
    ...rangeLines.map((line) => `  ${line.join(", ")},`),
    "];",
    "",
  ].join("\n");
}

function renderFile(version, caseFoldingName, caseFolding, derivedCoreName, derivedCore, body) {
  return [
    "// GENERATED by tools/gen-path-fold-table.mjs. Do not edit by hand; regenerate from the pinned Unicode files.",
    `// unicode-version: ${version}`,
    `// source ${caseFoldingName} sha256: ${caseFolding}`,
    `// source ${derivedCoreName} sha256: ${derivedCore}`,
    `// body-sha256: ${sha256Hex(body)}`,
    BODY_MARKER + body,
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const caseFolding = await loadVerified(args.caseFolding, args.caseFoldingSha256, "CaseFolding", args.version);
  const derivedCore = await loadVerified(args.derivedCore, args.derivedCoreSha256, "DerivedCoreProperties", args.version);
  const body = renderBody(args.version, parseCaseFolding(caseFolding.text), parseIgnorableRanges(derivedCore.text));
  const file = renderFile(args.version, "CaseFolding.txt", caseFolding.sha256, "DerivedCoreProperties.txt", derivedCore.sha256, body);
  await writeFile(args.out, file, "utf8");
  console.log(`wrote ${basename(args.out)} unicode=${args.version} bodySha256=${sha256Hex(body)} fileSha256=${sha256Hex(file)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
