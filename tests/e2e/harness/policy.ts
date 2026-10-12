// The suite's confinement policy (task 1.3, design decision 3): a pure decision function bound to SUITE_KEY and the
// per-run root. Modeled on tools/feature-op-mvp-07a/policy.mjs `decideRequest`, which is NOT imported — it hardcodes
// `obsidian-vault-sync` and the mvp07a demo parent. The key-agnostic path containment helper (`isWithin`) comes from
// 07a through ./tools-07a; the IPFS-path helpers are re-declared here because 07a keeps them module-private.
// One deliberate difference from 07a: `files/write|rm|mkdir` allow the run root itself (07a requires strictly below),
// because the run's own cleanup — `files/rm -r` of exactly the run root (design decision 6) — goes through the proxy.
import { SUITE_KEY } from "./run-context";
import { loadTools07a } from "./tools-07a";

/** The staging root of the feature operations. Any request parameter naming it is refused outright. */
export const STAGING_ROOT = "/obsidian-vault-staging";

const CID_SHAPE = /^[A-Za-z0-9]{10,}$/;
const BAD_SEGMENT = /[\u0000-\u001f\\/]/;

export const MUTATING_COMMANDS: ReadonlySet<string> = new Set(["files/write", "files/mkdir", "files/rm", "key/gen", "pin/add", "name/publish"]);
/**
 * Every /api/v0 command the proxy forwards. Anything else — notably key/rm, key/rename, key/import, key/export,
 * pin/rm, files/mv and files/cp — is refused before its arguments are even read.
 */
export const RPC_ALLOWLIST: readonly string[] = Object.freeze(["files/stat", "files/ls", "ls", "key/list", "name/resolve", ...MUTATING_COMMANDS]);
/** What a pull may send (the proxy log's `command` values): the reads of the allowlist and the gateway. */
export const PULL_READ_COMMANDS: readonly string[] = Object.freeze(["key/list", "name/resolve", "ls", "files/stat", "files/ls", "gateway"]);
export const isMutating = (command: string): boolean => MUTATING_COMMANDS.has(command);

/** Decoded path segments, or undefined when any segment is `.`, `..`, or holds a control character or separator. */
function safeSegments(path: string): string[] | undefined {
  let segments: string[];
  try {
    segments = path
      .split("/")
      .filter((segment) => segment !== "")
      .map(decodeURIComponent);
  } catch {
    return undefined;
  }
  return segments.every((segment) => segment !== "." && segment !== ".." && !BAD_SEGMENT.test(segment)) ? segments : undefined;
}

const isIpfsPath = (value: string): boolean => {
  const segments = value.startsWith("/ipfs/") ? safeSegments(value) : undefined;
  return segments !== undefined && segments[0] === "ipfs" && CID_SHAPE.test(segments[1] ?? "");
};
const cidOfIpfsPath = (value: string): string | undefined => (isIpfsPath(value) ? value.split("/")[2] : undefined);

export interface PolicyRequest {
  readonly method: string;
  readonly pathname: string;
  readonly params: URLSearchParams;
}

export interface PolicyContext {
  /** This run's root, e.g. /obsidian-vault-sync/e2e-<runId>. */
  readonly runRoot: string;
  /** CIDs the node has reported under the run root (learned from files/stat and files/ls answers by the proxy). */
  readonly knownCids: ReadonlySet<string>;
}

export interface Verdict {
  readonly allowed: boolean;
  readonly command: string;
  readonly kind: "rpc" | "gateway";
  readonly mutating: boolean;
  readonly reason: string;
}

export type IsWithin = (path: unknown, root: unknown, options?: { allowEqual?: boolean }) => boolean;
export type DecideRequest = (request: PolicyRequest, context: PolicyContext) => Verdict;

/**
 * Builds the decision function from the key-agnostic `isWithin` helper. Everything else is declared here so the
 * policy stays a pure function of (request, context) with no I/O — the full matrix is pinned by offline unit tests.
 */
export function makeDecideRequest(isWithin: IsWithin): DecideRequest {
  const argumentProblem = (command: string, args: string[], params: URLSearchParams, context: PolicyContext): string | undefined => {
    const one = args.length === 1 ? args[0] : undefined;
    const atOrBelow = () => one !== undefined && isWithin(one, context.runRoot, { allowEqual: true });
    switch (command) {
      case "files/stat":
      case "files/ls":
        return atOrBelow() || (one !== undefined && isIpfsPath(one)) ? undefined : "path must be the run root, below it, or an /ipfs/<cid> path";
      case "ls":
        return one !== undefined && isIpfsPath(one) ? undefined : "ls needs exactly one /ipfs/<cid> path";
      case "key/list":
        return args.length === 0 ? undefined : "key/list takes no path";
      case "name/resolve":
        return one !== undefined && /^(?:\/ipns\/)?[A-Za-z0-9]{10,}$/.test(one) ? undefined : "name/resolve needs exactly one key ID";
      case "files/write":
      case "files/mkdir":
      case "files/rm":
        return atOrBelow() ? undefined : "a mutation path must lie at or below the run root";
      case "key/gen":
        return one === SUITE_KEY ? undefined : `key/gen is limited to the key ${SUITE_KEY}`;
      case "name/publish": {
        const cid = one === undefined ? undefined : cidOfIpfsPath(one);
        const keys = params.getAll("key");
        return cid !== undefined && context.knownCids.has(cid) && keys.length === 1 && keys[0] === SUITE_KEY
          ? undefined
          : `name/publish needs key=${SUITE_KEY} and a CID the node reported under the run root`;
      }
      case "pin/add": {
        const cid = (one === undefined ? undefined : cidOfIpfsPath(one)) ?? (one !== undefined && CID_SHAPE.test(one) ? one : undefined);
        return cid !== undefined && context.knownCids.has(cid) ? undefined : "pin/add is limited to CIDs the node reported under the run root";
      }
      default:
        return "command is not on the allowlist";
    }
  };
  return (request, context) => {
    const verdict = (allowed: boolean, command: string, reason = ""): Verdict => ({ allowed, command, kind: command === "gateway" ? "gateway" : "rpc", mutating: allowed && isMutating(command), reason });
    const { method, pathname, params } = request;
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
  };
}

/** The decision function wired to the 07a `isWithin` (the loader caches the module, so repeat calls are cheap). */
export async function loadDecideRequest(): Promise<DecideRequest> {
  const tools = await loadTools07a();
  return makeDecideRequest(tools.isWithin);
}
