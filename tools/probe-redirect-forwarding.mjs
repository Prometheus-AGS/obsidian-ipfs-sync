#!/usr/bin/env node
// Redirect-forwarding probe for the Obsidian plugin's transport.
//
// Question it answers: when the node the plugin talks to answers with a redirect to a DIFFERENT origin, does the device follow it,
// and what does it send to the redirect target (method, body, credential headers)?
//
//   node tools/probe-redirect-forwarding.mjs --host <this machine's LAN address> [--port-a 5101] [--port-b 5102] [--loopback]
//
// It starts two plain-http servers:
//   A (--port-a)  the "node": every request is answered with the next redirect status in the cycle
//                 307, 308, 302, 301, 303, with a Location that points at B on the same path.
//   B (--port-b)  the "target": it records what arrived and answers 200 with an empty JSON object.
// With --loopback the Location points at http://127.0.0.1:<port-b> (the case where a redirect reaches the machine itself).
//
// For every request the plugin makes it prints one VERDICT line, then the raw detail. It prints header NAMES and a short hash of
// each credential header value, never the value. It answers nothing but redirects and an empty 200. Stop it with Ctrl-C.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    host: { type: "string" },
    "port-a": { type: "string", default: "5101" },
    "port-b": { type: "string", default: "5102" },
    loopback: { type: "boolean", default: false },
    "wait-ms": { type: "string", default: "2500" },
  },
});
if (values.host === undefined && !values.loopback) {
  console.error("pass --host <this machine's LAN address> (or --loopback for a desktop run)");
  process.exit(2);
}
const portA = Number(values["port-a"]);
const portB = Number(values["port-b"]);
const waitMs = Number(values["wait-ms"]);
const targetHost = values.loopback ? "127.0.0.1" : values.host;
const cycle = [307, 308, 302, 301, 303];
const CREDENTIAL = (name) => ["authorization", "proxy-authorization", "cookie"].includes(name) || /key|token|secret|auth/i.test(name);
let next = 0;
let ids = 0;
const pending = new Map();
const stamp = () => new Date().toISOString().slice(11, 23);
const short = (text) => createHash("sha256").update(text).digest("hex").slice(0, 8);

const credentialNames = (headers) => Object.keys(headers).filter(CREDENTIAL).sort();

function describeHeaders(headers) {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${CREDENTIAL(name) ? `<present sha256:${short(String(value))}>` : String(value).slice(0, name === "user-agent" ? 240 : 80)}`)
    .sort();
}

function readBody(request) {
  return new Promise((resolve) => {
    let length = 0;
    request.on("data", (chunk) => (length += chunk.length));
    request.on("end", () => resolve(length));
    request.on("error", () => resolve(length));
  });
}

function verdictForReached(sent, reached) {
  const carried = credentialNames(sent.headers);
  const forwarded = carried.filter((name) => name in reached.headers);
  const stripped = carried.filter((name) => !(name in reached.headers));
  const method = reached.method === sent.method ? `method kept (${reached.method})` : `method changed (${sent.method} -> ${reached.method})`;
  const body = `body ${sent.bodyBytes} B -> ${reached.bodyBytes} B`;
  const credentials = carried.length === 0 ? "no credential header was sent to the node in this request" : `credential headers forwarded to the target: ${forwarded.join(", ") || "none"}; stripped: ${stripped.join(", ") || "none"}`;
  return `redirect FOLLOWED to ${values.loopback ? "the machine's own loopback" : "another origin"}; ${method}; ${body}; ${credentials}`;
}

createServer(async (request, response) => {
  const bodyBytes = await readBody(request);
  const status = cycle[next % cycle.length];
  next += 1;
  const isPage = request.headers["sec-fetch-mode"] === "navigate";
  const id = ids + 1;
  if (!isPage) ids = id;
  const location = `http://${targetHost}:${portB}${request.url}${request.url.includes("?") ? "&" : "?"}s=${status}&id=${isPage ? 0 : id}`;
  console.log(`[${stamp()}] A  #${isPage ? "-" : id} ${request.method} ${request.url}  body ${bodyBytes} B  -> ${status}`);
  if (isPage) console.log("            NOTE: a page visit by a browser (sec-fetch-mode: navigate), not a request made by the plugin");
  else {
    const sent = { method: request.method, bodyBytes, headers: request.headers, status };
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      console.log(`[${stamp()}] VERDICT #${id}: redirect NOT followed; the redirect target was not reached (the request was answered with ${status} and stopped there)`);
    }, waitMs);
    pending.set(id, { sent, timer });
  }
  console.log(`            headers A received: ${describeHeaders(request.headers).join(" | ")}`);
  response.writeHead(status, { Location: location, "Content-Length": "0" });
  response.end();
}).listen(portA, "0.0.0.0", () => console.log(`A (the redirecting 'node') listening on 0.0.0.0:${portA}`));

createServer(async (request, response) => {
  const bodyBytes = await readBody(request);
  const query = new URL(request.url, "http://x").searchParams;
  const status = query.get("s") ?? "?";
  const id = Number(query.get("id") ?? 0);
  console.log(`[${stamp()}] B  REACHED via redirect ${status}: ${request.method} ${request.url.split("?")[0]}  body ${bodyBytes} B`);
  const entry = pending.get(id);
  if (entry !== undefined) {
    clearTimeout(entry.timer);
    pending.delete(id);
    console.log(`[${stamp()}] VERDICT #${id}: ${verdictForReached(entry.sent, { method: request.method, bodyBytes, headers: request.headers })}`);
  }
  console.log(`            headers B received: ${describeHeaders(request.headers).join(" | ")}`);
  response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "2" });
  response.end("{}");
}).listen(portB, "0.0.0.0", () => console.log(`B (the redirect target) listening on 0.0.0.0:${portB}; A redirects to http://${targetHost}:${portB}`));
