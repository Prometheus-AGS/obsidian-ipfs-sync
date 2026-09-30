// One-shot probe of the kubo node behaviours the encrypted publish path assumes (mvp-06 task 3.7, review-3 question 7).
//
//   node tools/probe-node-assumptions.mjs [--rpc-url https://ipfs.prometheusags.ai]
//
// It talks to the node with plain HTTP only (no project code), and changes the node ONLY under
// /obsidian-vault-sync/mvp06-probe/<runid>/ (files/mkdir, files/write, files/rm). It sends no key/*, pin/* or name/* call.
// Reads (files/stat, files/ls, files/read, ls, gateway GET) touch only that folder. Everything under its own run folder
// is removed at the end. Each check prints PASS, FAIL or OBSERVED (no assumption to test, the value is recorded).
import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

const argv = process.argv.slice(2);
const rpcFlag = argv.indexOf("--rpc-url");
const BASE = (rpcFlag >= 0 ? argv[rpcFlag + 1] : "https://ipfs.prometheusags.ai").replace(/\/+$/, "");
const RUN_ID = `probe-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const ROOT = `/obsidian-vault-sync/mvp06-probe/${RUN_ID}`;
const results = [];

function record(id, status, what, detail = "") {
  results.push({ id, status, what, detail });
  process.stdout.write(`${status.padEnd(8)} ${id}  ${what}${detail === "" ? "" : `  -> ${detail}`}\n`);
}

/** Mutations may only name paths inside this run's folder. */
function guard(path) {
  if (!path.startsWith(`${ROOT}/`) && path !== ROOT) throw new Error(`refusing a path outside the probe folder: ${path}`);
  if (path.includes("..")) throw new Error("refusing a path with ..");
  return path;
}

const ALLOWED_RPC = new Set(["files/mkdir", "files/write", "files/rm", "files/stat", "files/ls", "files/read", "ls"]);

function rpcUrl(command, args) {
  if (!ALLOWED_RPC.has(command)) throw new Error(`command not allowed by the probe: ${command}`);
  const query = Object.entries(args).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  return `${BASE}/api/v0/${command}${query === "" ? "" : `?${query}`}`;
}

async function rpc(command, args = {}, body) {
  const headers = {};
  let payload;
  if (body !== undefined) {
    const boundary = `probe${randomBytes(6).toString("hex")}`;
    payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="data"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
  }
  const response = await fetch(rpcUrl(command, args), { method: "POST", headers, body: payload });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: Object.fromEntries(response.headers), bytes, text: bytes.toString("utf8") };
}

async function json(command, args) {
  const r = await rpc(command, args);
  let value;
  try {
    value = JSON.parse(r.text);
  } catch {
    value = undefined;
  }
  return { ...r, value };
}

const write = (path, data, extra = {}) =>
  rpc("files/write", { arg: guard(path), create: true, parents: true, truncate: true, "cid-version": 1, ...extra }, Buffer.from(data));

async function gateway(path, range) {
  const response = await fetch(`${BASE}/ipfs/${path}`, { headers: range === undefined ? {} : { Range: range } });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, contentRange: response.headers.get("content-range"), length: bytes.length, bytes };
}

/** A raw request whose body is cut off: `declared` bytes promised, `sent` bytes delivered, then the socket is destroyed. */
function abortedWrite(path, declared, sent, extra = {}) {
  return new Promise((resolve) => {
    const url = new URL(rpcUrl("files/write", { arg: guard(path), create: true, parents: true, truncate: true, "cid-version": 1, ...extra }));
    const boundary = `probe${randomBytes(6).toString("hex")}`;
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="data"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const body = Buffer.concat([head, randomBytes(declared)]);
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length } },
      (response) => {
        response.resume();
        resolve({ answered: response.statusCode });
      },
    );
    request.on("error", () => resolve({ answered: "socket error (expected)" }));
    request.write(body.subarray(0, head.length + sent));
    setTimeout(() => {
      request.destroy();
      setTimeout(() => resolve({ answered: "destroyed" }), 200);
    }, 500);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isCidV1 = (cid) => /^b[a-z2-7]{20,}$/.test(cid);

async function probeLs() {
  await rpc("files/mkdir", { arg: guard(`${ROOT}/dir`), parents: true, "cid-version": 1 });
  await rpc("files/mkdir", { arg: guard(`${ROOT}/dir/sub`), parents: true, "cid-version": 1 });
  await write(`${ROOT}/dir/a.txt`, "alpha");
  await write(`${ROOT}/dir/sub/b.txt`, "bravo");
  const dirStat = await json("files/stat", { arg: `${ROOT}/dir` });
  const fileStat = await json("files/stat", { arg: `${ROOT}/dir/a.txt` });
  const dirCid = dirStat.value?.Hash;
  record("e1", isCidV1(dirCid ?? "") ? "PASS" : "FAIL", "files/stat of a directory made with cid-version=1 is a CIDv1", String(dirCid));
  record("e2", isCidV1(fileStat.value?.Hash ?? "") ? "PASS" : "FAIL", "files/stat of a file written with cid-version=1 is a CIDv1", `${fileStat.value?.Hash} size=${fileStat.value?.Size} type=${fileStat.value?.Type}`);

  const ls = await json("ls", { arg: `/ipfs/${dirCid}`, "resolve-type": true, size: true, stream: false });
  const links = ls.value?.Objects?.[0]?.Links;
  const shapeOk = ls.status === 200 && Array.isArray(links) && links.every((l) => "Name" in l && "Hash" in l && "Size" in l && "Type" in l);
  record("a1", shapeOk ? "PASS" : "FAIL", "ls on /ipfs/<dirCid> answers Objects[].Links[] with Name/Hash/Size/Type", `status=${ls.status} ${ls.text.slice(0, 260).replace(/\s+/g, " ")}`);
  const a = links?.find((l) => l.Name === "a.txt");
  const sub = links?.find((l) => l.Name === "sub");
  record("a2", "OBSERVED", "ls Type numbers", `file a.txt Type=${a?.Type} Size=${a?.Size}; directory sub Type=${sub?.Type} Size=${sub?.Size}`);
  record("a3", a?.Hash === fileStat.value?.Hash ? "PASS" : "FAIL", "the CID string in ls equals files/stat of the same file (same base and version)", `${a?.Hash} vs ${fileStat.value?.Hash}`);
  const subStat = await json("files/stat", { arg: `${ROOT}/dir/sub` });
  record("a4", sub?.Hash === subStat.value?.Hash ? "PASS" : "FAIL", "the CID string in ls equals files/stat of a directory", `${sub?.Hash} vs ${subStat.value?.Hash}`);
  record("a5", a?.Size === 5 ? "PASS" : "OBSERVED", "ls Size of a 5-byte raw-leaf file equals its content size", `Size=${a?.Size}`);

  await rpc("files/mkdir", { arg: guard(`${ROOT}/empty`), parents: true, "cid-version": 1 });
  const emptyStat = await json("files/stat", { arg: `${ROOT}/empty` });
  const emptyLs = await json("ls", { arg: `/ipfs/${emptyStat.value?.Hash}`, "resolve-type": true, size: true, stream: false });
  record("a6", "OBSERVED", "ls of an empty directory", `status=${emptyLs.status} ${emptyLs.text.trim().slice(0, 200)}`);
  const missing = await json("ls", { arg: `/ipfs/${dirCid}/nope`, "resolve-type": true, size: true });
  record("a7", "OBSERVED", "ls of a missing name under a directory (error text the client matches)", `status=${missing.status} ${missing.text.trim().slice(0, 200)}`);

  const mfsLs = await json("files/ls", { arg: `/ipfs/${dirCid}`, long: true, stream: true });
  record("b1", mfsLs.status === 200 && mfsLs.text.includes("a.txt") ? "OBSERVED" : "OBSERVED", "files/ls on an /ipfs/<cid> path", `status=${mfsLs.status} ${mfsLs.text.trim().slice(0, 200)}`);
  const mfsLsOk = await json("files/ls", { arg: `${ROOT}/dir`, long: true, stream: true });
  record("b2", "OBSERVED", "files/ls -l on the MFS path (entry fields)", `status=${mfsLsOk.status} ${mfsLsOk.text.trim().split("\n")[0]?.slice(0, 200)}`);
  const statIpfs = await json("files/stat", { arg: `/ipfs/${dirCid}` });
  record("b3", "OBSERVED", "files/stat on an /ipfs/<cid> path", `status=${statIpfs.status} ${statIpfs.text.trim().slice(0, 160)}`);
  return dirCid;
}

async function probeMany() {
  for (let index = 0; index < 30; index += 1) await write(`${ROOT}/many/f${String(index).padStart(2, "0")}.bin`, `entry ${index}`);
  const stat = await json("files/stat", { arg: `${ROOT}/many` });
  const raw = await rpc("ls", { arg: `/ipfs/${stat.value?.Hash}`, "resolve-type": true, size: true, stream: false });
  const links = JSON.parse(raw.text)?.Objects?.[0]?.Links ?? [];
  record("f1", links.length === 30 ? "PASS" : "FAIL", "ls of a 30-entry directory returns 30 links", `links=${links.length} bodyBytes=${raw.bytes.length} content-type=${raw.headers["content-type"]} content-length=${raw.headers["content-length"] ?? "(none)"} transfer-encoding=${raw.headers["transfer-encoding"] ?? "(none)"}`);
  const mfs = await rpc("files/ls", { arg: `${ROOT}/many`, long: true, stream: true });
  record("f2", "OBSERVED", "files/ls -l stream of the same directory", `bodyBytes=${mfs.bytes.length} lines=${mfs.text.trim().split("\n").length} content-length=${mfs.headers["content-length"] ?? "(none)"} transfer-encoding=${mfs.headers["transfer-encoding"] ?? "(none)"}`);
}

async function probeSegments() {
  const path = `${ROOT}/seg/blob`;
  const header = randomBytes(22);
  const seg1 = randomBytes(5000);
  const seg2 = randomBytes(3000);
  const first = await write(path, header);
  const second = await write(path, seg1, { truncate: false, offset: 22, create: false });
  const third = await write(path, seg2, { truncate: false, offset: 22 + seg1.length, create: false });
  const stat = await json("files/stat", { arg: path });
  const expected = Buffer.concat([header, seg1, seg2]);
  const read = await rpc("files/read", { arg: path });
  const gw = await gateway(stat.value?.Hash);
  record("c1", [first, second, third].every((r) => r.status === 200) && stat.value?.Size === expected.length ? "PASS" : "FAIL", "header, then segments at offsets with truncate=false, build one file of the right size", `statuses=${first.status},${second.status},${third.status} size=${stat.value?.Size} expected=${expected.length}`);
  record("c2", read.bytes.equals(expected) && gw.bytes.equals(expected) ? "PASS" : "FAIL", "files/read and the gateway return exactly the written bytes", `files/read=${read.bytes.length}B gateway=${gw.length}B`);
  const rewrite = await write(path, header);
  const rewritten = await json("files/stat", { arg: path });
  record("c3", rewritten.value?.Size === header.length ? "PASS" : "FAIL", "a write with truncate=true (header alone) replaces the older longer content", `status=${rewrite.status} size=${rewritten.value?.Size}`);

  // Client abort mid-body.
  await write(`${ROOT}/abort/existing`, randomBytes(4000));
  const before = await json("files/stat", { arg: `${ROOT}/abort/existing` });
  const outcome = await abortedWrite(`${ROOT}/abort/existing`, 100_000, 30_000);
  await sleep(1500);
  const after = await json("files/stat", { arg: `${ROOT}/abort/existing` });
  record("c4", "OBSERVED", "abort mid-body over an EXISTING file (truncate=true, 100000 declared, 30000 sent)", `client=${outcome.answered}; before size=${before.value?.Size}; after status=${after.status} size=${after.value?.Size ?? "(absent)"} ${after.value === undefined ? after.text.trim().slice(0, 100) : ""}`);
  const fresh = await abortedWrite(`${ROOT}/abort/fresh`, 100_000, 30_000);
  await sleep(1500);
  const freshStat = await json("files/stat", { arg: `${ROOT}/abort/fresh` });
  record("c5", "OBSERVED", "abort mid-body creating a NEW file", `client=${fresh.answered}; after status=${freshStat.status} size=${freshStat.value?.Size ?? "(absent)"} ${freshStat.value === undefined ? freshStat.text.trim().slice(0, 100) : ""}`);
  const offsetAbort = await abortedWrite(`${ROOT}/abort/existing`, 50_000, 10_000, { truncate: false, offset: 4000, create: false });
  await sleep(1500);
  const offsetStat = await json("files/stat", { arg: `${ROOT}/abort/existing` });
  record("c6", "OBSERVED", "abort mid-body of an offset write (truncate=false, offset=4000)", `client=${offsetAbort.answered}; size before=${after.value?.Size} after=${offsetStat.value?.Size}`);
}

async function probeGateway() {
  const file = await json("files/stat", { arg: `${ROOT}/dir/a.txt` });
  await write(`${ROOT}/gw/empty`, "");
  const empty = await json("files/stat", { arg: `${ROOT}/gw/empty` });
  const dir = await json("files/stat", { arg: `${ROOT}/dir` });
  const cases = [
    ["d1", `${file.value?.Hash}`, "bytes=0-0", "existing 5-byte file, Range 0-0"],
    ["d2", `${file.value?.Hash}`, "bytes=0-99999", "existing 5-byte file, Range beyond its end (the cap+1 form)"],
    ["d3", `${file.value?.Hash}`, undefined, "existing file, no Range"],
    ["d4", `${dir.value?.Hash}/nope`, "bytes=0-0", "missing name under a directory, Range 0-0"],
    ["d5", `${empty.value?.Hash}`, "bytes=0-0", "empty file, Range 0-0"],
    ["d6", `${empty.value?.Hash}`, undefined, "empty file, no Range"],
    ["d7", `${dir.value?.Hash}/a.txt`, "bytes=0-0", "existing file by directory path, Range 0-0"],
  ];
  for (const [id, path, range, what] of cases) {
    const r = await gateway(path, range);
    record(id, "OBSERVED", `gateway ${what}`, `status=${r.status} content-range=${r.contentRange ?? "(none)"} bodyBytes=${r.length}`);
  }
  const ranged = await gateway(file.value?.Hash, "bytes=0-0");
  record("d8", ranged.status === 206 && ranged.length === 1 ? "PASS" : "OBSERVED", "the proxy honours Range (206 with one byte)", `status=${ranged.status} bodyBytes=${ranged.length}`);
}

async function cleanup() {
  const removed = await rpc("files/rm", { arg: guard(ROOT), recursive: true });
  const after = await json("files/stat", { arg: ROOT });
  const gone = after.status !== 200;
  record("z1", gone ? "PASS" : "FAIL", "the probe folder was removed", `rm status=${removed.status} body=${removed.text.trim().slice(0, 80) || "(empty)"}; stat after status=${after.status}`);
}

process.stdout.write(`probe run ${RUN_ID} against ${BASE}\nfolder ${ROOT}\n\n`);
try {
  await probeLs();
  await probeMany();
  await probeSegments();
  await probeGateway();
} catch (error) {
  record("error", "FAIL", "the probe stopped", error instanceof Error ? error.message : String(error));
} finally {
  await cleanup().catch((error) => record("z1", "FAIL", "cleanup failed", error instanceof Error ? error.message : String(error)));
}
process.stdout.write("\nSUMMARY\n");
for (const r of results) process.stdout.write(`${r.id.padEnd(6)} ${r.status.padEnd(9)} ${r.what}\n`);
process.exitCode = results.some((r) => r.status === "FAIL") ? 1 : 0;
