// Pure helpers of the machine steps (task 4.7a): the verdict of a list of checks, tree comparison, the ciphertext-only judgement, the blob
// names a pull fetched and the 20 MiB floor of the multi-segment assertion. No I/O: tests drive these with crafted inputs.
const MIB = 1024 * 1024;
/** The multi-segment assertion needs a blob of at least this size (spec release-2: "a file of at least 20 MiB"). */
export const LARGE_BLOB_MIN_BYTES = 20 * MIB;
/** The size the run writes: just over the floor, so a segment boundary is not the file's end. */
export const LARGE_BLOB_BYTES = LARGE_BLOB_MIN_BYTES + 1;
// A pull reads a blob below the root's current/ folder, or below the CID of that folder itself: /ipfs/<cid>[/current]/<xx>/<52 characters>.
const BLOB_GATEWAY_PATH = /^\/ipfs\/[^/]+(?:\/current)?\/[a-z2-7]{2}\/([a-z2-7]{52})$/;
const DETAIL_MAX_CHARS = 600;

/** One assertion from its checks: passed only when there is at least one check and every one holds. */
export function verdict(id, checks) {
  const failed = checks.filter((check) => !check.ok);
  const detail = checks.length === 0 ? "no check ran" : failed.length > 0 ? failed.map((check) => `${check.label}${check.detail ? ` (${check.detail})` : ""}`).join("; ") : `${checks.length} checks: ${checks.map((check) => check.label).join("; ")}`;
  return { id, passed: checks.length > 0 && failed.length === 0, detail: detail.slice(0, DETAIL_MAX_CHARS) };
}

/** Maps of path to sha256: one line per path that differs, is missing or is extra. */
export function treeMismatches(expected, actual) {
  const lines = [];
  for (const [path, hash] of expected) {
    if (!actual.has(path)) lines.push(`missing ${path}`);
    else if (actual.get(path) !== hash) lines.push(`differs ${path}`);
  }
  for (const path of actual.keys()) if (!expected.has(path)) lines.push(`extra ${path}`);
  return lines;
}

/** True when two path-to-hash maps hold the same paths with the same hashes. */
export const sameDigestMap = (a, b) => treeMismatches(a, b).length === 0;

/** "Ciphertext only on the node": no proxied request carried a plaintext needle, the node scan found none, and the scan read something. */
export function scanProblems({ log, scan, minFiles, minBytes }) {
  const problems = [];
  const wire = log.filter((entry) => entry.needle !== undefined);
  if (wire.length > 0) problems.push(`${wire.length} proxied request(s) carried plaintext: ${wire[0].needle} (${wire[0].command})`);
  if (scan.hit !== null) problems.push(`the node holds plaintext: ${scan.hit}`);
  if (scan.files < minFiles || scan.bytes < minBytes) problems.push(`the node scan read ${scan.files} file(s) and ${scan.bytes} byte(s), expected at least ${minFiles} and ${minBytes}`);
  return problems;
}

/** The distinct blob names a pull fetched from the gateway (proxy log entries of command "gateway" for current/<xx>/<blob>). */
export function blobNamesFetched(trace) {
  return [...new Set(trace.flatMap((entry) => (entry.command === "gateway" ? [BLOB_GATEWAY_PATH.exec(entry.arg ?? "")?.[1]] : [])).filter((name) => name !== undefined))];
}

export const blobSizeProblem = (bytes, minBytes) => (bytes >= minBytes ? undefined : `the large blob is ${bytes} bytes, below the ${minBytes / MIB} MiB floor of the multi-segment assertion`);
