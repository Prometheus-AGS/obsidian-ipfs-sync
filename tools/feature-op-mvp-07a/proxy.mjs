// The forwarding-only proxy in front of the node, its self-test and the proxy-outside-allowlist tamper.
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BASE, DEAD_UPSTREAM, KEY, STAGING_ROOT } from "./constants.mjs";
import { createNeedleScanner, decideRequest, decodeSafe, findNeedle, isWithin, vetRequestUrl } from "./policy.mjs";
import { check, note } from "./report.mjs";

// ======================================================================================================================
// The forwarding-only proxy in front of the shared node
// ======================================================================================================================

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"];
export const JSON_HEADERS = { "content-type": "application/json" };

function learnCids(bytes, into) {
  const text = bytes.toString("utf8");
  let documents;
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
    if (typeof document?.Hash === "string") into.add(document.Hash);
    for (const entry of Array.isArray(document?.Entries) ? document.Entries : []) if (typeof entry?.Hash === "string") into.add(entry.Hash);
  }
}

export function createProxy({ upstream, demoRoot }) {
  const log = [];
  const violations = [];
  const knownCids = new Set();
  let needles = [];

  function forward(req, res, entry, decision, forwardPath) {
    const target = new URL(`${decision.kind === "gateway" ? upstream.gateway : upstream.rpc}${forwardPath}`);
    const headers = { ...req.headers, host: target.host, "accept-encoding": "identity" };
    for (const name of HOP_BY_HOP) delete headers[name];
    const scanner = createNeedleScanner(needles);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const learn = (decision.command === "files/stat" || decision.command === "files/ls") && isWithin(entry.arg ?? "", demoRoot, { allowEqual: true });
    const upstreamRequest = send(target, { method: req.method, headers }, (response) => {
      entry.status = response.statusCode;
      const answered = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !HOP_BY_HOP.includes(name)));
      const kept = [];
      res.writeHead(response.statusCode ?? 502, answered);
      response.on("data", (chunk) => {
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
      else res.writeHead(502, JSON_HEADERS).end(JSON.stringify({ Message: `feature-op proxy: upstream error: ${error.message}`, Code: 0, Type: "error" }));
    });
    req.on("data", (chunk) => {
      const hit = scanner.push(chunk);
      if (hit !== undefined && entry.needle === undefined) entry.needle = hit;
    });
    req.on("close", () => {
      if (!req.complete) upstreamRequest.destroy();
    });
    req.pipe(upstreamRequest);
  }

  function handle(req, res) {
    const vetted = vetRequestUrl(req.url);
    if (!vetted.ok) {
      const refused = { n: log.length + 1, method: req.method, command: "malformed-url", arg: undefined, key: undefined, mutating: false, allowed: false, reason: vetted.reason, status: undefined, needle: undefined };
      log.push(refused);
      violations.push(refused);
      req.resume();
      res.writeHead(403, JSON_HEADERS).end(JSON.stringify({ Message: `blocked by feature-op-mvp-07a: ${vetted.reason}`, Code: 0, Type: "error" }));
      return;
    }
    const url = vetted.url;
    const decision = decideRequest({ method: req.method ?? "GET", pathname: url.pathname, params: url.searchParams }, { demoRoot, knownCids });
    const entry = {
      n: log.length + 1,
      method: req.method,
      command: decision.command,
      arg: url.searchParams.get("arg") ?? (decision.kind === "gateway" ? url.pathname : undefined),
      key: url.searchParams.get("key") ?? undefined,
      mutating: decision.mutating,
      allowed: decision.allowed,
      reason: decision.reason,
      status: undefined,
      needle: findNeedle(Buffer.from(`${url.pathname}\n${decodeSafe(url.search)}`), needles),
    };
    log.push(entry);
    if (!decision.allowed) {
      violations.push(entry);
      req.resume();
      res.writeHead(403, JSON_HEADERS).end(JSON.stringify({ Message: `blocked by feature-op-mvp-07a: ${decision.reason}`, Code: 0, Type: "error" }));
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
  return {
    log,
    violations,
    knownCids,
    setNeedles(list) {
      needles = list;
    },
    async start() {
      await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
      this.url = `http://127.0.0.1:${server.address().port}`;
      return this.url;
    },
    stop: () => new Promise((done) => {
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
}

/** Tamper "outside-allowlist": one request the CLI must never send (pin/rm) arrives at the proxy, which refuses and records it. */
export async function plantOutsideRequest(proxy) {
  const response = await fetch(`${proxy.url}/api/v0/pin/rm?${new URLSearchParams({ arg: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" })}`, { method: "POST" });
  note(`tamper "outside-allowlist": one pin/rm request sent to the proxy (HTTP ${response.status}); a nonzero exit is the expected result`);
}

/** Out-of-policy requests the proxy must refuse (the production key, pins, foreign paths, the staging root, escapes). */
const SELF_TEST_CASES = (demoRoot) => [
    ["pin/rm", { arg: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" }],
    ["key/rm", { arg: KEY }],
    ["key/gen", { arg: "obsidian-vault" }],
    ["files/mv", { arg: `${demoRoot}/a`, "arg-2": `${demoRoot}/b` }],
    ["files/rm", { arg: `${BASE}/other-project/x` }],
    ["files/rm", { arg: `${BASE}/mvp06-demo/x` }],
    ["files/write", { arg: `${STAGING_ROOT}/x` }],
    ["files/write", { arg: `${demoRoot}/../escape` }],
    ["name/publish", { arg: "/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", key: "obsidian-vault" }],
    ["files/ls", { arg: BASE }],
  ];

/**
 * The self-test (L-01): a second proxy, with the same policy, whose upstream is a dead loopback address. None of its requests can reach
 * any node, so an out-of-policy request that slipped through the policy would be answered 502 by the dead upstream instead of 403 and
 * be counted as forwarded. A control request that the policy allows (key/list) must be answered 502, which shows the upstream is dead and
 * the proxy would have forwarded.
 */
export async function runProxySelfTest(demoRoot) {
  const cases = SELF_TEST_CASES(demoRoot);
  const probe = createProxy({ upstream: DEAD_UPSTREAM, demoRoot });
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

export async function proxySelfTest(demoRoot) {
  const result = await runProxySelfTest(demoRoot);
  check(`proxy self-test (second proxy, dead upstream ${result.upstream}): ${result.total} out-of-policy requests (pin/rm, key/rm, files/mv, foreign key, other project, mvp06-demo, staging root, .. escape, root listing) are refused and none is allowed to forward; an in-policy control read reaches only the dead upstream (HTTP ${result.controlStatus}, expected 502)`, result.refused === result.total && result.forwardedByPolicy === 0 && result.controlStatus === 502, `${result.refused}/${result.total} refused, ${result.forwardedByPolicy} allowed to forward, control ${result.controlStatus}`);
}
