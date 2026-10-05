#!/usr/bin/env node
// Redirect-forwarding probe for the Obsidian plugin's requestUrl transport.
//
// Question it answers: when the node the plugin talks to answers with a redirect to a DIFFERENT origin, what does the
// device send to the redirect target? (method, body length, Authorization, X-Api-Key, other headers).
//
//   node tools/probe-redirect-forwarding.mjs --host <this machine's LAN address> [--port-a 5101] [--port-b 5102] [--loopback]
//
// It starts two plain-http servers:
//   A (--port-a)  the "node": every request is answered with the next redirect status in the cycle
//                 307, 308, 302, 301, 303 and a Location that points at B on the same path, plus ?s=<status>.
//   B (--port-b)  the "target": it logs what arrived and answers 200 with an empty JSON object.
// With --loopback the Location points at http://127.0.0.1:<port-b> instead of --host (the confused-deputy case on a desktop,
// where the loopback address is the machine running Obsidian).
//
// Use it from the plugin settings: set the node RPC URL to http://<host>:<port-a>, the gateway to the same, pick a credential
// kind (Bearer, Basic, Custom header X-Api-Key) with a made-up value, and press "Check again" or run a publish. The plugin will
// then report an error (the stub is not a node). That is expected: the evidence is in the log lines printed here.
//
// It prints header NAMES and a short hash of each credential header value, never the value itself. It binds to all
// interfaces, only for the lifetime of the run, and answers nothing but redirects and an empty 200. Stop it with Ctrl-C.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    host: { type: "string" },
    "port-a": { type: "string", default: "5101" },
    "port-b": { type: "string", default: "5102" },
    loopback: { type: "boolean", default: false },
  },
});
if (values.host === undefined && !values.loopback) {
  console.error("pass --host <this machine's LAN address> (or --loopback for a desktop run)");
  process.exit(2);
}
const portA = Number(values["port-a"]);
const portB = Number(values["port-b"]);
const targetHost = values.loopback ? "127.0.0.1" : values.host;
const cycle = [307, 308, 302, 301, 303];
let next = 0;
const stamp = () => new Date().toISOString().slice(11, 23);
const short = (text) => createHash("sha256").update(text).digest("hex").slice(0, 8);
const SECRET_HEADERS = ["authorization", "x-api-key", "cookie", "proxy-authorization"];

function describeHeaders(headers) {
  const lines = [];
  for (const [name, value] of Object.entries(headers)) {
    const limit = name === "user-agent" ? 240 : 80;
    const shown = SECRET_HEADERS.includes(name) || /key|token|secret|auth/i.test(name) ? `<present sha256:${short(String(value))}>` : String(value).slice(0, limit);
    lines.push(`${name}: ${shown}`);
  }
  return lines.sort();
}

function readBody(request) {
  return new Promise((resolve) => {
    let length = 0;
    request.on("data", (chunk) => (length += chunk.length));
    request.on("end", () => resolve(length));
    request.on("error", () => resolve(length));
  });
}

createServer(async (request, response) => {
  const bodyBytes = await readBody(request);
  const status = cycle[next % cycle.length];
  next += 1;
  const location = `http://${targetHost}:${portB}${request.url}${request.url.includes("?") ? "&" : "?"}s=${status}`;
  console.log(`[${stamp()}] A  ${request.method} ${request.url}  body ${bodyBytes} B  -> ${status} to ${location}`);
  if (request.headers["sec-fetch-mode"] === "navigate") console.log("            NOTE: a page visit by a browser (sec-fetch-mode: navigate), not a request made by the plugin");
  console.log(`            headers A received: ${describeHeaders(request.headers).join(" | ")}`);
  response.writeHead(status, { Location: location, "Content-Length": "0" });
  response.end();
}).listen(portA, "0.0.0.0", () => console.log(`A (the redirecting 'node') listening on 0.0.0.0:${portA}`));

createServer(async (request, response) => {
  const bodyBytes = await readBody(request);
  const status = new URL(request.url, "http://x").searchParams.get("s") ?? "?";
  console.log(`[${stamp()}] B  REACHED via redirect ${status}: ${request.method} ${request.url.split("?")[0]}  body ${bodyBytes} B`);
  console.log(`            headers B received: ${describeHeaders(request.headers).join(" | ")}`);
  response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "2" });
  response.end("{}");
}).listen(portB, "0.0.0.0", () => console.log(`B (the redirect target) listening on 0.0.0.0:${portB}; A redirects to http://${targetHost}:${portB}`));
