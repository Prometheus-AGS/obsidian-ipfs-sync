// Pure helpers: proxy policy, fault schedule, layout rule, needle scanners, output parsing. Exported through the entry for tests/unit/feature-op-mvp-06-helpers.test.ts.
import { createHash, randomBytes } from "node:crypto";
import { ALLOWED_HOSTS, CANARY, DEMO_PARENT, KEY, LARGE_NOTE_BYTES, NEEDLE_MIN_BYTES, RUN_ID_PATTERN, Refusal, STAGING_ROOT, WORDS } from "./constants.mjs";

// ======================================================================================================================
// Pure helpers (exported for tests/unit/feature-op-mvp-06-helpers.test.ts)
// ======================================================================================================================

export const isValidRunId = (id) => typeof id === "string" && RUN_ID_PATTERN.test(id);
export const newRunId = () => `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

export function demoRootFor(runId) {
  if (!isValidRunId(runId)) throw new Refusal(`run identifier "${String(runId).slice(0, 40)}" does not match ${RUN_ID_PATTERN}`);
  return `${DEMO_PARENT}/${runId}`;
}

/** An absolute MFS path without empty-segment tricks; `.` and `..` segments, control characters and backslashes are refused (not resolved). */
export function normalizeMfsPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(path)) return undefined;
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "." || segment === "..")) return undefined;
  return `/${segments.join("/")}`;
}

export function isWithin(path, root, { allowEqual = false } = {}) {
  const target = normalizeMfsPath(path);
  const base = normalizeMfsPath(root);
  if (target === undefined || base === undefined) return false;
  return target === base ? allowEqual : target.startsWith(`${base}/`);
}

export function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** The upstream the forwarding proxy may talk to: the shared node's host, or loopback when a local stub stands in. */
export function isAllowedUpstream(value, localStub) {
  try {
    const url = new URL(value);
    return ALLOWED_HOSTS.includes(url.hostname) || (localStub && isLoopbackUrl(value));
  } catch {
    return false;
  }
}

const CID_SHAPE = /^[A-Za-z0-9]{10,}$/;
export const MUTATING_COMMANDS = new Set(["files/write", "files/mkdir", "files/rm", "key/gen", "pin/add", "name/publish"]);
/** Every /api/v0 command the proxy forwards. Anything else, notably key/rm, key/rename, key/import, pin/rm and files/mv, is refused. */
export const RPC_ALLOWLIST = Object.freeze(["files/stat", "files/ls", "ls", "key/list", "name/resolve", ...MUTATING_COMMANDS]);
export const isMutating = (command) => MUTATING_COMMANDS.has(command);

function safeSegments(path) {
  let segments;
  try {
    segments = path.split("/").filter((segment) => segment !== "").map(decodeURIComponent);
  } catch {
    return undefined;
  }
  return segments.every((segment) => segment !== "." && segment !== ".." && !/[\u0000-\u001f\\/]/.test(segment)) ? segments : undefined;
}

const isIpfsPath = (value) => {
  const segments = value.startsWith("/ipfs/") ? safeSegments(value) : undefined;
  return segments !== undefined && segments[0] === "ipfs" && CID_SHAPE.test(segments[1] ?? "");
};
const cidOfIpfsPath = (value) => (value !== undefined && isIpfsPath(value) ? value.split("/")[2] : undefined);

function argumentProblem(command, args, params, { demoRoot, knownCids }) {
  const one = args.length === 1 ? args[0] : undefined;
  const within = (opts) => one !== undefined && isWithin(one, demoRoot, opts);
  switch (command) {
    case "files/stat":
    case "files/ls":
      return within({ allowEqual: true }) || (one !== undefined && isIpfsPath(one)) ? undefined : "path must be the demo root, below it, or an /ipfs/<cid> path";
    case "ls":
      return one !== undefined && isIpfsPath(one) ? undefined : "ls needs exactly one /ipfs/<cid> path";
    case "key/list":
      return args.length === 0 ? undefined : "key/list takes no path";
    case "name/resolve":
      return one !== undefined && /^(?:\/ipns\/)?[A-Za-z0-9]{10,}$/.test(one) ? undefined : "name/resolve needs exactly one key ID";
    case "files/write":
    case "files/rm":
      return within({}) ? undefined : "a mutation path must lie strictly below the demo root";
    case "files/mkdir":
      return within({ allowEqual: true }) ? undefined : "a mutation path must lie below or at the demo root";
    case "key/gen":
      return one === KEY ? undefined : `key/gen is limited to the key ${KEY}`;
    case "name/publish": {
      const cid = cidOfIpfsPath(one);
      const keys = params.getAll("key");
      return cid !== undefined && knownCids.has(cid) && keys.length === 1 && keys[0] === KEY ? undefined : `name/publish needs key=${KEY} and a CID the node reported for the demo root`;
    }
    case "pin/add": {
      const cid = cidOfIpfsPath(one) ?? (one !== undefined && CID_SHAPE.test(one) ? one : undefined);
      return cid !== undefined && knownCids.has(cid) ? undefined : "pin/add is limited to CIDs the node reported for the demo root";
    }
    default:
      return "command is not on the allowlist";
  }
}

/**
 * The proxy's whole policy. `request` = { method, pathname, params: URLSearchParams }; `context` = { demoRoot, knownCids: Set }.
 * Returns { allowed, command, kind: "rpc" | "gateway", mutating, reason }.
 */
export function decideRequest(request, context) {
  const { method, pathname, params } = request;
  const verdict = (allowed, command, reason = "") => ({ allowed, command, kind: command === "gateway" ? "gateway" : "rpc", mutating: allowed && isMutating(command), reason });
  if (pathname.startsWith("/ipfs/")) {
    const segments = safeSegments(pathname);
    const ok = (method === "GET" || method === "HEAD") && segments !== undefined && segments[0] === "ipfs" && CID_SHAPE.test(segments[1] ?? "");
    return ok ? verdict(true, "gateway") : verdict(false, "gateway", "gateway access is limited to GET or HEAD of /ipfs/<cid>[/path]");
  }
  if (!pathname.startsWith("/api/v0/") || method !== "POST") return verdict(false, pathname, "only POST /api/v0/<command> and GET /ipfs/<cid> are forwarded");
  const command = pathname.slice("/api/v0/".length);
  if ([...params.values()].some((value) => value.includes(STAGING_ROOT))) return verdict(false, command, `${STAGING_ROOT} is never touched`);
  if (!RPC_ALLOWLIST.includes(command)) return verdict(false, command, "command is not on the allowlist");
  const problem = argumentProblem(command, params.getAll("arg"), params, context);
  return problem === undefined ? verdict(true, command) : verdict(false, command, problem);
}

/**
 * Mid-publish connection drops. `state` = { kind, manifestSeen, historySeen, fired }. Returns { drop, state }.
 *   before-manifest: drop the manifest.enc write itself (changed blobs are already on the node)
 *   between:         forward manifest.enc, drop the history-file write
 *   after-history:   forward manifest.enc and the history file, drop the first pin/add or name/publish
 * Once fired, every later request is dropped too.
 */
export function faultStep(state, info, demoRoot) {
  if (state === undefined) return { drop: false, state };
  if (state.fired) return { drop: true, state };
  const isWrite = info.command === "files/write";
  const manifest = isWrite && info.arg === `${demoRoot}/manifest.enc`;
  const history = isWrite && typeof info.arg === "string" && info.arg.startsWith(`${demoRoot}/manifests/`);
  const next = { ...state };
  let drop = false;
  if (state.kind === "before-manifest" && manifest) drop = true;
  else if (manifest) next.manifestSeen = true;
  else if (history && state.manifestSeen) {
    if (state.kind === "between") drop = true;
    else next.historySeen = true;
  } else if (state.kind === "after-history" && state.historySeen && (info.command === "pin/add" || info.command === "name/publish")) drop = true;
  if (drop) next.fired = true;
  return { drop, state: next };
}

/** Sorted-key, two-space, LF-terminated JSON: the canonical form of keyslots.json. */
export function canonicalJson(value) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

export function byteEntropy(bytes) {
  if (bytes.length === 0) return 0;
  const counts = new Array(256).fill(0);
  for (const byte of bytes) counts[byte] += 1;
  return counts.reduce((sum, count) => (count === 0 ? sum : sum - (count / bytes.length) * Math.log2(count / bytes.length)), 0);
}

/** The label of the first needle found in `haystack`, or undefined. `needles` = [{ label, bytes: Buffer }]. */
export function findNeedle(haystack, needles) {
  const buffer = Buffer.isBuffer(haystack) ? haystack : Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength);
  return needles.find((needle) => needle.bytes.length > 0 && buffer.indexOf(needle.bytes) !== -1)?.label;
}

/** A streaming scanner: chunk boundaries cannot hide a needle. `push` returns the label once found. */
export function createNeedleScanner(needles) {
  const keep = Math.max(1, ...needles.map((needle) => needle.bytes.length)) - 1;
  let tail = Buffer.alloc(0);
  let hit;
  return {
    push(chunk) {
      if (hit !== undefined) return hit;
      const window = Buffer.concat([tail, chunk]);
      hit = findNeedle(window, needles);
      tail = window.subarray(Math.max(0, window.length - keep));
      return hit;
    },
  };
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32Lower(bytes) {
  let bits = 0;
  let value = 0;
  let text = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      text += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? text + BASE32[(value << (5 - bits)) & 31] : text;
}

/** Every spelling of a secret the search looks for: raw, hex (both cases), base64 (padded, unpadded, URL-safe), base32. */
export function keyMaterialNeedles(name, bytes) {
  const raw = Buffer.from(bytes);
  const b64 = raw.toString("base64");
  const forms = [["raw", raw], ["hex", Buffer.from(raw.toString("hex"))], ["HEX", Buffer.from(raw.toString("hex").toUpperCase())], ["base64", Buffer.from(b64)], ["base64-unpadded", Buffer.from(b64.replace(/=+$/, ""))], ["base64url", Buffer.from(raw.toString("base64url"))], ["base32", Buffer.from(base32Lower(raw))]];
  return forms.map(([form, formBytes]) => ({ label: `${name} (${form})`, bytes: formBytes }));
}

export function buildLargeNote(size = LARGE_NOTE_BYTES) {
  const unit = `the quick harbor lantern repeats exactly this sentence again and again ${CANARY}.\n`;
  const head = "# Large repetitive note\n\n";
  return `${head}${unit.repeat(Math.ceil(size / unit.length))}`.slice(0, size);
}

/** Needles for "no plaintext anywhere": paths, path segments, file stems, titles, body words and the canary. files = [{ path, text? }]. */
export function plaintextNeedles(files) {
  const found = new Map();
  const add = (kind, value) => {
    if (Buffer.byteLength(value) >= NEEDLE_MIN_BYTES) found.set(value, kind);
  };
  for (const file of files) {
    add("path", file.path);
    for (const segment of file.path.split("/")) {
      add("path segment", segment);
      const dot = segment.lastIndexOf(".");
      if (dot > 0) add("file stem", segment.slice(0, dot));
    }
    const title = /^# (.+)$/m.exec(file.text ?? "")?.[1];
    if (title !== undefined) add("title", title);
  }
  for (const word of WORDS) add("body word", word);
  add("canary", CANARY);
  return [...found].map(([value, kind]) => ({ label: `${kind} "${value}"`, bytes: Buffer.from(value, "utf8") }));
}

/** Layout rule for a published root, from one-level listings: [{ name, type }] each. Returns the list of problems. */
export function checkNodeLayout({ root, current, prefixes, manifests }) {
  const problems = [];
  const expected = ["current", "keyslots.json", "manifest.enc", "manifests"];
  const names = root.map((entry) => entry.name).sort();
  if (names.join("|") !== expected.join("|")) problems.push(`root lists [${names.join(", ")}], expected [${expected.join(", ")}]`);
  for (const entry of root) {
    const wantDirectory = entry.name === "current" || entry.name === "manifests";
    if (expected.includes(entry.name) && (entry.type === "directory") !== wantDirectory) problems.push(`root entry ${entry.name} is a ${entry.type}`);
  }
  for (const entry of current) {
    if (entry.type !== "directory" || !/^[a-z2-7]{2}$/.test(entry.name)) problems.push(`current/ holds ${entry.type} "${entry.name}", expected two-character prefix folders`);
  }
  for (const [prefix, entries] of prefixes) {
    for (const entry of entries) {
      if (entry.type !== "file" || !/^[a-z2-7]{52}$/.test(entry.name) || !entry.name.startsWith(prefix)) problems.push(`anomaly in current/${prefix}/: ${entry.type} "${entry.name}"`);
    }
  }
  for (const entry of manifests) {
    if (entry.type !== "file" || !/^[A-Za-z0-9]+\.enc$/.test(entry.name)) problems.push(`anomaly in manifests/: ${entry.type} "${entry.name}"`);
  }
  return problems.map(stripControl);
}

export function parsePublishOutput(text) {
  const written = /^(\d+) written, (\d+) removed$/m.exec(text);
  const sequence = /^sequence\s+(\d+)$/m.exec(text);
  const root = /^root CID\s+(\S+)/m.exec(text);
  return { written: written ? Number(written[1]) : undefined, removed: written ? Number(written[2]) : undefined, sequence: sequence ? Number(sequence[1]) : undefined, rootCid: root?.[1] };
}

export const stripControl = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
export const firstLine = (text) => stripControl(String(text).trim().split("\n")[0] ?? "").slice(0, 220);
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const rootDigest = (mfsRoot) => sha256(mfsRoot).slice(0, 16);

export function redact(text, secrets) {
  return secrets.reduce((current, secret) => (secret === "" ? current : current.split(secret).join("[redacted]")), text);
}

/** The environment of a child: everything except IPFS_SYNC_* other than the auth variables, plus `extra`. */
export function childEnv(base, extra) {
  const kept = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (name.startsWith("IPFS_SYNC_") && !/^IPFS_SYNC_(?:RPC_|GATEWAY_)?AUTH_/.test(name)) continue;
    kept[name] = value;
  }
  return { ...kept, ...extra };
}

export function decodeSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Vets a raw request target before the policy decides and returns the exact path that is forwarded (F-01). The decision and the
 * forward use the same parsed URL: a target that does not start with a single "/", or whose path holds "//" or a backslash
 * (raw or percent-encoded), is refused instead of being normalised into something the node might read differently.
 */
export function vetRequestUrl(rawUrl) {
  const refuse = (reason) => ({ ok: false, reason, url: undefined, forwardPath: undefined });
  if (typeof rawUrl !== "string" || !rawUrl.startsWith("/")) return refuse("request target does not start with '/'");
  const rawPath = rawUrl.split(/[?#]/, 1)[0];
  if (rawPath.includes("//") || rawPath.includes("\\")) return refuse("request path holds '//' or a backslash");
  let url;
  try {
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return refuse("request target does not parse");
  }
  const decoded = decodeSafe(url.pathname);
  if (url.host !== "127.0.0.1" || url.pathname.includes("//") || decoded.includes("//") || decoded.includes("\\") || /%5c|%2f%2f/i.test(url.pathname)) return refuse("request path holds '//' or a backslash after parsing");
  return { ok: true, reason: "", url, forwardPath: `${url.pathname}${url.search}` };
}

/** The stdout line printed before the first mutation (R5-09). `keyId` undefined means the key is not on the node. */
export function formatPointerLine(keyId, pointer) {
  return `previous IPNS pointer of ${KEY}: ${keyId === undefined ? "key absent -> none" : `${keyId} -> ${pointer}`}`;
}

/** Shared-node runs must not skip the build-freshness guard (R5-10). Returns a refusal message or undefined. */
export function staleBuildRefusal({ allowStaleBuild, localStub, dryRun }) {
  return allowStaleBuild && !localStub && !dryRun ? "--allow-stale-build is refused on the shared-node path; run `pnpm build` and re-run without it" : undefined;
}

/** First line of a child's output with every known secret redacted (F-02): re-scrub at print time, not at spawn time. */
export const scrubbedDetail = (result, secrets) => firstLine(redact(result.stderr ?? "", secrets)) || firstLine(redact(result.stdout ?? "", secrets));
