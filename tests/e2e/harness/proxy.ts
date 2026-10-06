// The loopback forwarding proxy in front of the node (task 1.3, design decision 3), modeled on
// tools/feature-op-mvp-07a/proxy.mjs: a request log, a violation list, a plaintext needle scan, CID learning from
// files/stat and files/ls answers, and a self-test against a dead loopback upstream. The policy is the suite's own
// (./policy.ts, bound to SUITE_KEY and the run root); URL vetting, needle scanners and path helpers come from 07a
// through ./tools-07a. Nothing here hardcodes a node address — the upstream is always supplied by the caller.
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { loadDecideRequest, STAGING_ROOT, type Verdict } from "./policy";
import { BASE_PATH, SUITE_KEY, SuiteRefusal } from "./run-context";
import { loadTools07a, type Needle, type Tools07a } from "./tools-07a";

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"];
const JSON_HEADERS = { "content-type": "application/json" };

export interface ProxyUpstream {
  readonly rpc: string;
  readonly gateway: string;
}

/** An address nothing listens on (the discard port on loopback): the self-test's upstream, so a request that slips through the policy cannot reach any node. */
export const DEAD_UPSTREAM: ProxyUpstream = Object.freeze({ rpc: "http://127.0.0.1:9", gateway: "http://127.0.0.1:9" });

export interface ProxyEntry {
  readonly n: number;
  readonly method: string;
  readonly command: string;
  readonly arg?: string;
  readonly key?: string;
  readonly mutating: boolean;
  readonly allowed: boolean;
  readonly reason: string;
  status?: number;
  needle?: string;
  error?: string;
}

export interface Proxy {
  /** Set by start(). */
  url?: string;
  readonly log: ProxyEntry[];
  readonly violations: ProxyEntry[];
  /** CIDs the node reported under the run root; name/publish and pin/add are limited to these. */
  readonly knownCids: Set<string>;
  setNeedles(needles: readonly Needle[]): void;
  start(): Promise<string>;
  stop(): Promise<void>;
  mark(): number;
  since(mark: number): ProxyEntry[];
  resetLog(): void;
}

/** Learns CIDs from a files/stat or files/ls answer (a single JSON document or newline-delimited documents). */
function learnCids(bytes: Buffer, into: Set<string>): void {
  const text = bytes.toString("utf8");
  let documents: unknown[];
  try {
    documents = [JSON.parse(text)];
  } catch {
    documents = text.split("\n").flatMap((line) => {
      try {
        return line.trim() === "" ? [] : [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }
  for (const document of documents) {
    const hash = (document as { Hash?: unknown })?.Hash;
    if (typeof hash === "string") into.add(hash);
    const entries = (document as { Entries?: unknown })?.Entries;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const entryHash = (entry as { Hash?: unknown })?.Hash;
      if (typeof entryHash === "string") into.add(entryHash);
    }
  }
}

export async function createProxy(options: { upstream: ProxyUpstream; runRoot: string }): Promise<Proxy> {
  const tools: Tools07a = await loadTools07a();
  const decide = await loadDecideRequest();
  const { upstream, runRoot } = options;
  const log: ProxyEntry[] = [];
  const violations: ProxyEntry[] = [];
  const knownCids = new Set<string>();
  let needles: readonly Needle[] = [];

  const blocked = (res: ServerResponse, reason: string): void => {
    res.writeHead(403, JSON_HEADERS).end(JSON.stringify({ Message: `blocked by the ipfs-sync e2e suite: ${reason}`, Code: 0, Type: "error" }));
  };

  function forward(req: IncomingMessage, res: ServerResponse, entry: ProxyEntry, decision: Verdict, forwardPath: string): void {
    const target = new URL(`${decision.kind === "gateway" ? upstream.gateway : upstream.rpc}${forwardPath}`);
    const headers: OutgoingHttpHeaders = { ...req.headers, host: target.host, "accept-encoding": "identity" };
    for (const name of HOP_BY_HOP) delete headers[name];
    const scanner = tools.createNeedleScanner(needles);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const learn = (decision.command === "files/stat" || decision.command === "files/ls") && tools.isWithin(entry.arg ?? "", runRoot, { allowEqual: true });
    const upstreamRequest = send(target, { method: req.method, headers }, (response) => {
      entry.status = response.statusCode;
      const answered = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !HOP_BY_HOP.includes(name)));
      const kept: Buffer[] = [];
      res.writeHead(response.statusCode ?? 502, answered);
      response.on("data", (chunk: Buffer) => {
        if (learn) kept.push(chunk);
        res.write(chunk);
      });
      response.on("end", () => {
        if (learn && response.statusCode === 200) learnCids(Buffer.concat(kept), knownCids);
        res.end();
      });
      response.on("error", () => res.destroy());
    });
    upstreamRequest.on("error", (error) => {
      entry.error = error.message;
      if (res.headersSent) res.destroy();
      else res.writeHead(502, JSON_HEADERS).end(JSON.stringify({ Message: `e2e proxy: upstream error: ${error.message}`, Code: 0, Type: "error" }));
    });
    req.on("data", (chunk: Buffer) => {
      const hit = scanner.push(chunk);
      if (hit !== undefined && entry.needle === undefined) entry.needle = hit;
    });
    req.on("close", () => {
      if (!req.complete) upstreamRequest.destroy();
    });
    req.pipe(upstreamRequest);
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const vetted = tools.vetRequestUrl(req.url);
    if (!vetted.ok || vetted.url === undefined || vetted.forwardPath === undefined) {
      const refused: ProxyEntry = { n: log.length + 1, method: req.method ?? "", command: "malformed-url", arg: undefined, key: undefined, mutating: false, allowed: false, reason: vetted.reason, status: undefined, needle: undefined };
      log.push(refused);
      violations.push(refused);
      req.resume();
      blocked(res, vetted.reason);
      return;
    }
    const url = vetted.url;
    const decision = decide({ method: req.method ?? "GET", pathname: url.pathname, params: url.searchParams }, { runRoot, knownCids });
    const entry: ProxyEntry = {
      n: log.length + 1,
      method: req.method ?? "",
      command: decision.command,
      arg: url.searchParams.get("arg") ?? (decision.kind === "gateway" ? url.pathname : undefined),
      key: url.searchParams.get("key") ?? undefined,
      mutating: decision.mutating,
      allowed: decision.allowed,
      reason: decision.reason,
      status: undefined,
      needle: tools.findNeedle(Buffer.from(`${url.pathname}\n${tools.decodeSafe(url.search)}`), needles),
    };
    log.push(entry);
    if (!decision.allowed) {
      violations.push(entry);
      req.resume();
      blocked(res, decision.reason);
      return;
    }
    forward(req, res, entry, decision, vetted.forwardPath);
  }

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      req.socket.destroy();
    }
  });

  const proxy: Proxy = {
    url: undefined,
    log,
    violations,
    knownCids,
    setNeedles(list) {
      needles = list;
    },
    async start() {
      await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
      const address = server.address();
      if (address === null || typeof address === "string") throw new SuiteRefusal("the e2e proxy did not bind a loopback port");
      proxy.url = `http://127.0.0.1:${address.port}`;
      return proxy.url;
    },
    stop: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
    mark: () => log.length,
    since: (mark) => log.slice(mark),
    resetLog() {
      log.length = 0;
      violations.length = 0;
    },
  };
  return proxy;
}

const SELF_TEST_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

/** Out-of-policy requests the proxy must refuse: pins, key operations, foreign keys, foreign paths, a sibling run root, the staging root, escapes. */
const selfTestCases = (runRoot: string): [string, Record<string, string>][] => [
  ["pin/rm", { arg: SELF_TEST_CID }],
  ["key/rm", { arg: SUITE_KEY }],
  ["key/gen", { arg: "obsidian-vault-sync" }],
  ["files/mv", { arg: `${runRoot}/a`, "arg-2": `${runRoot}/b` }],
  ["files/rm", { arg: `${BASE_PATH}/other-project/x` }],
  ["files/rm", { arg: `${BASE_PATH}/e2e-staletest00/x` }],
  ["files/write", { arg: `${STAGING_ROOT}/x` }],
  ["files/write", { arg: `${runRoot}/../escape` }],
  ["name/publish", { arg: `/ipfs/${SELF_TEST_CID}`, key: "obsidian-vault-sync" }],
  ["files/ls", { arg: BASE_PATH }],
];

// Named "SelfCheck", not "SelfTest": vitest 5's static collector treats any call whose callee name ends in "Test"
// as a test definition, and the SSR transform keys calls by the original export name, so a *Test export would
// register a phantom test in `vitest list`.
export interface ProxySelfCheckResult {
  readonly upstream: string;
  readonly total: number;
  readonly refused: number;
  readonly forwardedByPolicy: number;
  readonly controlStatus: number;
}

/**
 * The self-test: a second proxy with the same policy whose upstream is a dead loopback address. None of its requests
 * can reach any node, so an out-of-policy request that slipped through the policy would be answered 502 by the dead
 * upstream instead of 403 and be counted as forwarded. The in-policy control (key/list) must be answered 502, which
 * shows the upstream is dead and the proxy would have forwarded.
 */
export async function runProxySelfCheck(runRoot: string): Promise<ProxySelfCheckResult> {
  const cases = selfTestCases(runRoot);
  const probe = await createProxy({ upstream: DEAD_UPSTREAM, runRoot });
  const url = await probe.start();
  try {
    let refused = 0;
    for (const [command, params] of cases) {
      const response = await fetch(`${url}/api/v0/${command}?${new URLSearchParams(params)}`, { method: "POST" });
      if (response.status === 403) refused += 1;
    }
    const forwardedByPolicy = probe.log.filter((entry) => entry.allowed).length;
    const control = await fetch(`${url}/api/v0/key/list`, { method: "POST" });
    return { upstream: DEAD_UPSTREAM.rpc, total: cases.length, refused, forwardedByPolicy, controlStatus: control.status };
  } finally {
    await probe.stop();
  }
}

/** The preflight form of the self-test: any deviation fails the suite with the numbers named (design decision 5). */
export async function assertProxySelfCheck(runRoot: string): Promise<void> {
  const result = await runProxySelfCheck(runRoot);
  if (result.refused !== result.total || result.forwardedByPolicy !== 0 || result.controlStatus !== 502) {
    throw new SuiteRefusal(
      `proxy self-test failed against the dead upstream ${result.upstream}: ${result.refused}/${result.total} out-of-policy requests refused, ${result.forwardedByPolicy} allowed to forward, in-policy control answered HTTP ${result.controlStatus} (expected all refused, none forwarded, control 502)`,
    );
  }
}
