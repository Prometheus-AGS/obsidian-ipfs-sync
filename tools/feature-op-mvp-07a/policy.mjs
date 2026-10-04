// Pure helpers: proxy policy, pull read audit, needle scanners, output parsing. Exported through the entry for tests/unit/feature-op-mvp-07a-helpers.test.ts.
import { createHash, randomBytes } from "node:crypto";
import { readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ALLOWED_HOSTS, CHILD_ENV_ALLOWLIST, DEMO_PARENT, KEY, NEEDLE_MIN_BYTES, NEVER_PUBLISHED_MESSAGES, PRE_RUN_RESOLVE_ATTEMPTS, PRE_RUN_RESOLVE_DELAY_MS, REPO, REPO_REAL, RUN_ID_PATTERN, Refusal, STAGING_ROOT, WORDS } from "./constants.mjs";

// ======================================================================================================================
// Pure helpers (exported for tests/unit/feature-op-mvp-07a-helpers.test.ts)
// ======================================================================================================================

export const isValidRunId = (id) => typeof id === "string" && RUN_ID_PATTERN.test(id);
export const newRunId = () => `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

export function demoRootFor(runId) {
  if (!isValidRunId(runId)) throw new Refusal(`run identifier "${String(runId).slice(0, 40)}" does not match ${RUN_ID_PATTERN}`);
  return `${DEMO_PARENT}/${runId}`;
}

/** The one folder `--cleanup` may remove: strictly below the demo parent, from a valid run identifier only. */
export function cleanupTarget(runId) {
  const target = demoRootFor(runId);
  if (!isWithin(target, DEMO_PARENT)) throw new Refusal(`${target} is not below ${DEMO_PARENT}`);
  return target;
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

/**
 * The upstream the forwarding proxy may talk to: the shared node's host over https only (the Authorization header is forwarded, so
 * cleartext http to a non-loopback host is refused), or loopback when a local stub stands in.
 */
export function isAllowedUpstream(value, localStub) {
  try {
    const url = new URL(value);
    return (ALLOWED_HOSTS.includes(url.hostname) && url.protocol === "https:") || (localStub && isLoopbackUrl(value));
  } catch {
    return false;
  }
}

const CID_SHAPE = /^[A-Za-z0-9]{10,}$/;
export const MUTATING_COMMANDS = new Set(["files/write", "files/mkdir", "files/rm", "key/gen", "pin/add", "name/publish"]);
/** Every /api/v0 command the proxy forwards. Anything else, notably key/rm, key/rename, key/import, pin/rm and files/mv, is refused. Unchanged from mvp-06: pull adds no command. */
export const RPC_ALLOWLIST = Object.freeze(["files/stat", "files/ls", "ls", "key/list", "name/resolve", ...MUTATING_COMMANDS]);
/** What a pull may send (the proxy log's `command` values): the reads of the allowlist and the gateway. Anything else in a pull's trace is a finding. */
export const PULL_READ_COMMANDS = Object.freeze(["key/list", "name/resolve", "ls", "files/stat", "files/ls", "gateway"]);
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
 * The audit of a pull's slice of the proxy log: every entry must be allowed, not mutating and one of the pull read commands.
 * Returns one line per problem; an empty list means the pull was read-only.
 */
export function pullTraceProblems(trace) {
  return trace.flatMap((entry) => {
    const where = `${entry.command}${entry.arg === undefined ? "" : ` ${stripControl(entry.arg)}`}`;
    if (entry.mutating) return [`mutating request ${where}`];
    if (!entry.allowed) return [`refused request ${where}`];
    return PULL_READ_COMMANDS.includes(entry.command) ? [] : [`command outside the pull read set: ${where}`];
  });
}

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

/** Needles for "no plaintext on the wire": paths, path segments, file stems, titles and body words. files = [{ path, text? }]. */
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
  return [...found].map(([value, kind]) => ({ label: `${kind} "${value}"`, bytes: Buffer.from(value, "utf8") }));
}

export function parsePublishOutput(text) {
  const written = /^(\d+) written, (\d+) removed$/m.exec(text);
  const sequence = /^sequence\s+(\d+)$/m.exec(text);
  const root = /^root CID\s+(\S+)/m.exec(text);
  return { written: written ? Number(written[1]) : undefined, removed: written ? Number(written[2]) : undefined, sequence: sequence ? Number(sequence[1]) : undefined, rootCid: root?.[1] };
}

const PULL_SUMMARY = /^(\d+) fetched, (\d+) unchanged, (\d+) conflicts, (\d+) integrity-failed, (\d+) unfetched, (\d+) skipped, (\d+) remote-deleted, (\d+) locally modified$/m;

/** The summary line, `sequence`, `root CID` and the `conflict <path> -> <copy>` lines of a completed encrypted pull. */
export function parsePullOutput(text) {
  const summary = PULL_SUMMARY.exec(text);
  const number = (index) => (summary ? Number(summary[index]) : undefined);
  const sequence = /^sequence\s+(\d+)$/m.exec(text);
  const root = /^root CID\s+(\S+)/m.exec(text);
  const conflictPairs = [...text.matchAll(/^ {2}conflict (.+) -> (.+)$/gm)].map((match) => ({ path: match[1], copy: match[2] }));
  return {
    fetched: number(1),
    unchanged: number(2),
    conflicts: number(3),
    integrityFailed: number(4),
    unfetched: number(5),
    skipped: number(6),
    remoteDeleted: number(7),
    locallyModified: number(8),
    sequence: sequence ? Number(sequence[1]) : undefined,
    rootCid: root?.[1],
    conflictPairs,
  };
}

export function parseInitOutput(text) {
  const created = /^vault created\s+([0-9a-f]{32})$/m.exec(text);
  return { vaultId: created?.[1] };
}

export const stripControl = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
export const firstLine = (text) => stripControl(String(text).trim().split("\n")[0] ?? "").slice(0, 220);
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const rootDigest = (mfsRoot) => sha256(mfsRoot).slice(0, 16);

export function redact(text, secrets) {
  return secrets.reduce((current, secret) => (secret === "" ? current : current.split(secret).join("[redacted]")), text);
}

const AUTH_VARIABLE = /^IPFS_SYNC_(?:RPC_|GATEWAY_)?AUTH_/;

/**
 * The environment of a child: the allowlisted names (PATH, HOME, TMPDIR, LANG, LC_ALL), the IPFS_SYNC_* auth variables on the
 * shared-node path only (the child authenticates to the shared node through the proxy; the stub needs none), plus `extra`.
 * NODE_OPTIONS, NODE_PATH, proxy variables and every other IPFS_SYNC_* variable are dropped.
 */
export function childEnv(base, extra, { localStub = false } = {}) {
  const kept = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (CHILD_ENV_ALLOWLIST.includes(name) || (!localStub && AUTH_VARIABLE.test(name))) kept[name] = value;
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
 * Vets a raw request target before the policy decides and returns the exact path that is forwarded. The decision and the
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

/** The stdout line printed before the first mutation. `keyId` undefined means the key is not on the node. */
export function formatPointerLine(keyId, pointer) {
  return `previous IPNS pointer of ${KEY}: ${keyId === undefined ? "key absent -> none" : `${keyId} -> ${pointer}`}`;
}

/** Shared-node runs must not skip the build-freshness guard. Returns a refusal message or undefined. */
export function staleBuildRefusal({ allowStaleBuild, localStub, dryRun }) {
  return allowStaleBuild && !localStub && !dryRun ? "--allow-stale-build is refused on the shared-node path; run `pnpm build` and re-run without it" : undefined;
}

/** First line of a child's output with every known secret redacted: re-scrub at print time, not at spawn time. */
export const scrubbedDetail = (result, secrets) => firstLine(redact(result.stderr ?? "", secrets)) || firstLine(redact(result.stdout ?? "", secrets));

// ======================================================================================================================
// Review findings M-01, M-02, L-03, L-05, L-07, L-08 (pure helpers, exported for the helper test)
// ======================================================================================================================

/** The node's recorded "never published" answer (HTTP 500 with the node's own JSON message). Duck-typed: the error comes from the toolbox bundle. */
export const isNeverPublishedError = (error) => typeof error === "object" && error !== null && error.status === 500 && NEVER_PUBLISHED_MESSAGES.includes(error.nodeMessage);

const sleepMs = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * The pointer the owned key has before the run (M-01). `resolveName` is one name/resolve call. On the shared-node path (`strict`)
 * only the node's never-published answer becomes "unresolved"; any other failure is retried and then refused, because publish #1
 * repoints the key and an unread pointer would be lost. `acceptUnresolved` (--accept-unresolved-pointer) is the explicit opt-in.
 * The stub path (`strict` false) keeps the old behaviour: any failure is "unresolved".
 */
export async function resolvePreviousPointer(resolveName, { strict, acceptUnresolved = false, attempts = PRE_RUN_RESOLVE_ATTEMPTS, delayMs = PRE_RUN_RESOLVE_DELAY_MS, sleep = sleepMs, onPointerUnknown = () => undefined }) {
  if (!strict) return resolveName().catch(() => "unresolved");
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await resolveName();
    } catch (error) {
      if (isNeverPublishedError(error)) return "unresolved";
      last = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  if (acceptUnresolved) {
    onPointerUnknown();
    return "unresolved";
  }
  throw new Refusal(`cannot read the previous IPNS pointer of ${KEY} (${firstLine(last instanceof Error ? last.message : String(last))}) after ${attempts} attempts; publish #1 would repoint the key and the old pointer would be lost. Re-run when the node answers, or pass --accept-unresolved-pointer to continue without it.`);
}

/** The stdout line after the run: where the owned key points now (M-02). `keyId` undefined means the key is not on the node. */
export function formatPostRunLine(keyId, pointer) {
  return `IPNS pointer of ${KEY} after the run: ${keyId === undefined ? "key absent -> none" : `${keyId} -> ${pointer}`}`;
}

const RESTORABLE_POINTER = /^\/ipfs\/[A-Za-z0-9]{10,}$/;
const NO_PUBLISH_DURING_RUN = "The real vault must not publish with this key during the run, and should not publish before the pointer is restored: that publish would repoint the key as well.";
/** The shared node's exec wrapper, as the operator runbook names it (docs/operator/encrypted-vault.md; gotchas 2026-10-03). */
const NODE_EXEC = "kubectl --context know-me -n ipfs exec ipfs-0 -c ipfs --";
/** The words of the operator runbook's restore section (docs/operator/encrypted-vault.md): the kubo CLI form, on the node, saved pointer only, --ttl 5m, verified with default options and explicit --ttl 5m --lifetime 24h on a throwaway key. */
const RESTORE_CAVEATS = "Run on the node with access to its keystore, with the saved pointer only. The default lifetime and TTL differ from the product's 5m TTL, so the form passes --ttl 5m (lifetime stays at kubo's 24h default); verified on kubo v0.42.0: default lifetime and TTL, and explicit --ttl 5m --lifetime 24h on a throwaway key (accepted; the pointer resolved); the TTL a remote resolver sees was not checked.";

/**
 * The exact text printed and stored after the run: how to put the recorded pointer back. The script never does it (name/publish is
 * limited to the demo root's CIDs). Three cases are told apart: a recorded pointer (the command), no key or a never-published name
 * (nothing to restore), and a pointer accepted as unresolved after a read failure (UNKNOWN, cannot be restored from this run).
 */
export function restoreInstruction(preRun) {
  const pointer = preRun.previousPointer;
  if (typeof pointer === "string" && RESTORABLE_POINTER.test(pointer)) return `restore: the run leaves ${KEY} pointing at the demo vault. To put the recorded pointer back, run on the node with access to its keystore: ipfs name publish --key=${KEY} --ttl 5m ${pointer} ; on the shared node: ${NODE_EXEC} ipfs name publish --key=${KEY} --ttl 5m ${pointer}  ${RESTORE_CAVEATS} ${NO_PUBLISH_DURING_RUN}`;
  if (typeof pointer === "string" && pointer !== "unresolved") return `restore: the recorded pointer is not a plain /ipfs/<cid> path; see the previous-pointer line above and restore it by hand. ${NO_PUBLISH_DURING_RUN}`;
  if (preRun.pointerUnknown === true) return `restore: the previous pointer is UNKNOWN and could not be recorded, so it cannot be restored from this run (the pre-run name/resolve failed and --accept-unresolved-pointer was passed). Look for an earlier saved \`previous IPNS pointer\` line from a former run. ${NO_PUBLISH_DURING_RUN}`;
  const why = preRun.keyId === null || preRun.keyId === undefined ? "no key on the node" : "the name had never been published";
  return `restore: nothing to restore: the key did not exist before this run (${why}; no earlier pointer was recorded). The key points at the demo vault until the real vault publishes again. ${NO_PUBLISH_DURING_RUN}`;
}

/**
 * Runs `record` (an async post-run record) for at most `timeoutMs`; never rejects. Used by the signal handlers so a hung node cannot keep
 * the process alive (N-02 c). Returns { ok: true } or { ok: false, reason }.
 */
export async function bestEffortPostRun(record, { timeoutMs }) {
  let timer;
  const expired = new Promise((done) => {
    timer = setTimeout(() => done({ ok: false, reason: `timed out after ${timeoutMs} ms` }), timeoutMs);
  });
  const finished = Promise.resolve()
    .then(record)
    .then(() => ({ ok: true }), (error) => ({ ok: false, reason: firstLine(error instanceof Error ? error.message : String(error)) }));
  try {
    return await Promise.race([finished, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** The platform guard (L-03): on win32 the device store reads LOCALAPPDATA and ignores XDG_STATE_HOME, so a child could reach the real device id and floor. */
export const win32Refusal = (platform) => (platform === "win32" ? "refusing to run on win32: the per-user device store reads LOCALAPPDATA there and ignores XDG_STATE_HOME, so a child could touch the real device id and sequence floor" : undefined);

/** The known secrets plus both spellings of the passphrase file's text, once each (L-05). An empty file adds nothing. */
export function withPassphraseSpellings(known, fileText) {
  const grouped = String(fileText).trimEnd();
  return grouped === "" ? [...known] : [...new Set([...known, grouped, grouped.replaceAll("-", "")])];
}

/** What init and publish may send that changes the node. An explicit list, not derived from the policy's own verdicts (L-07). */
export const EXPECTED_MUTATIONS = Object.freeze(["files/write", "files/mkdir", "files/rm", "key/gen", "pin/add", "name/publish"]);
const READ_ONLY_COMMANDS = new Set(PULL_READ_COMMANDS);

/**
 * Re-checks the proxy's own log against the explicit expectation: every allowed request that is not a known read is one of
 * EXPECTED_MUTATIONS with its argument inside the demo root (or the owned key, or a CID), and no entry names the staging root.
 * Refused entries are left to the violations check. Returns one line per problem.
 */
export function mutationLogProblems(log, demoRoot) {
  const problems = [];
  for (const entry of log) {
    const arg = `${entry.arg ?? ""}`;
    const where = `${stripControl(entry.command)} ${stripControl(arg)}`.trim();
    if (arg.includes(STAGING_ROOT)) problems.push(`names the staging root: ${where}`);
    if (entry.allowed === false || READ_ONLY_COMMANDS.has(entry.command)) continue;
    if (!EXPECTED_MUTATIONS.includes(entry.command)) {
      problems.push(`unexpected command: ${where}`);
      continue;
    }
    const inside = entry.command === "files/mkdir" ? isWithin(arg, demoRoot, { allowEqual: true }) : isWithin(arg, demoRoot);
    if (entry.command.startsWith("files/") && !inside) problems.push(`mutation path outside the demo root (strictly below required): ${where}`);
    if (entry.command === "key/gen" && arg !== KEY) problems.push(`key/gen for a key other than ${KEY}: ${where}`);
    if (entry.command === "name/publish" && (entry.key !== KEY || !/^\/ipfs\/[A-Za-z0-9]{10,}$/.test(arg))) problems.push(`name/publish without key ${KEY} and an /ipfs/<cid> value: ${where}`);
    if (entry.command === "pin/add" && !/^(?:\/ipfs\/)?[A-Za-z0-9]{10,}$/.test(arg)) problems.push(`pin/add of something that is not a CID: ${where}`);
  }
  return problems;
}

/**
 * Absolute path with symlinks resolved as far as the path exists (L-08). The missing tail is kept, and a dangling symlink is
 * followed to where a write through it would land. The nearest existing ancestor decides, so a not-yet-created --out file is judged
 * by the real directory it will be created in.
 */
export function realpathLoose(path) {
  let current = resolve(path);
  const tail = [];
  for (let hops = 0; hops < 64; hops += 1) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...[...tail].reverse());
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw new Refusal(`cannot resolve ${stripControl(current)}: ${error.code ?? firstLine(error.message)}`);
    }
    let link;
    try {
      link = readlinkSync(current);
    } catch {
      link = undefined;
    }
    if (link !== undefined) {
      current = resolve(dirname(current), link);
      continue;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    tail.push(basename(current));
    current = parent;
  }
  throw new Refusal(`too many symbolic links while resolving ${stripControl(String(path))}`);
}

/** True when neither the path as written nor its real path lies in the repository (the delivery freeze fingerprints the repo). */
export function isOutsideRepo(path) {
  const candidates = [resolve(path), realpathLoose(path)];
  return !candidates.some((candidate) => [REPO, REPO_REAL].some((root) => candidate === root || candidate.startsWith(`${root}${sep}`)));
}
