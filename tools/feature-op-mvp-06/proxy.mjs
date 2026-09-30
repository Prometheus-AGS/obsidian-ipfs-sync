// The forwarding-only proxy in front of the node, its self-test and the proxy-outside-allowlist tamper.
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BASE, KEY, STAGING_ROOT } from "./constants.mjs";
import { createNeedleScanner, decideRequest, decodeSafe, faultStep, findNeedle, isWithin, vetRequestUrl } from "./policy.mjs";
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
  let fault;
  let persist = false;

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
      const refused = { n: log.length + 1, method: req.method, command: "malformed-url", arg: undefined, key: undefined, mutating: false, allowed: false, reason: vetted.reason, status: undefined, dropped: false, needle: undefined };
      log.push(refused);
      violations.push(refused);
      req.resume();
      res.writeHead(403, JSON_HEADERS).end(JSON.stringify({ Message: `blocked by feature-op-mvp-06: ${vetted.reason}`, Code: 0, Type: "error" }));
      return;
    }
    const url = vetted.url;
    const decision = decideRequest({ method: req.method ?? "GET", pathname: url.pathname, params: url.searchParams }, { demoRoot, knownCids });
    const entry = {
      n: log.length + 1,
      method: req.method,
      command: decision.command,
      arg: url.searchParams.get("arg") ?? undefined,
      key: url.searchParams.get("key") ?? undefined,
      mutating: decision.mutating,
      allowed: decision.allowed,
      reason: decision.reason,
      status: undefined,
      dropped: false,
      needle: findNeedle(Buffer.from(`${url.pathname}\n${decodeSafe(url.search)}`), needles),
    };
    log.push(entry);
    if (!decision.allowed) {
      violations.push(entry);
      req.resume();
      res.writeHead(403, JSON_HEADERS).end(JSON.stringify({ Message: `blocked by feature-op-mvp-06: ${decision.reason}`, Code: 0, Type: "error" }));
      return;
    }
    const step = faultStep(fault, entry, demoRoot);
    fault = step.state;
    if (step.drop) {
      entry.dropped = true;
      req.socket.destroy();
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
    setFault(kind, keep = false) {
      fault = { kind, manifestSeen: false, historySeen: false, fired: false };
      persist = keep;
    },
    clearFault() {
      if (!persist) fault = undefined;
    },
    liftFault() {
      fault = undefined;
      persist = false;
    },
    faultFired: () => fault?.fired === true,
    resetLog() {
      log.length = 0;
      violations.length = 0;
    },
  };
}

/** Tamper "proxy-outside-allowlist": one request the CLI must never send (pin/rm) arrives at the proxy, which refuses and records it. */
export async function plantOutsideRequest(proxy) {
  const response = await fetch(`${proxy.url}/api/v0/pin/rm?${new URLSearchParams({ arg: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" })}`, { method: "POST" });
  note(`tamper "proxy-outside-allowlist": one pin/rm request sent to the proxy (HTTP ${response.status}); a nonzero exit is the expected result`);
}

/** Requests the proxy must refuse. They target the proxy on loopback and are never forwarded. */
export async function proxySelfTest(proxy, demoRoot) {
  const cases = [
    ["pin/rm", { arg: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" }],
    ["key/rm", { arg: KEY }],
    ["key/gen", { arg: "obsidian-vault" }],
    ["files/rm", { arg: `${BASE}/other-project/x` }],
    ["files/write", { arg: `${STAGING_ROOT}/x` }],
    ["files/write", { arg: `${demoRoot}/../escape` }],
    ["name/publish", { arg: "/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", key: "obsidian-vault" }],
    ["files/ls", { arg: BASE }],
  ];
  let refused = 0;
  for (const [command, params] of cases) {
    const response = await fetch(`${proxy.url}/api/v0/${command}?${new URLSearchParams(params)}`, { method: "POST" });
    if (response.status === 403) refused += 1;
  }
  const forwarded = proxy.log.filter((entry) => entry.status !== undefined || entry.dropped).length;
  check(`proxy self-test: ${cases.length} out-of-policy requests (pin/rm, key/rm, foreign key, other project, staging root, .. escape, root listing) are refused and none is forwarded`, refused === cases.length && forwarded === 0, `${refused}/${cases.length} refused, ${forwarded} forwarded`);
  proxy.resetLog();
}
