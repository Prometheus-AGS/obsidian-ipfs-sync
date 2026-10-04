// Reads from the node, and the script-hosted stub node, WITHOUT loading project code into this process.
// The shared kubo client (src/kubo) is bundled by esbuild into a temporary file outside the repository and RUN AS A CHILD PROCESS
// (`node <bundle> <op> <json>`), with the scrubbed environment; this process never loads it as a module, so every import
// specifier in the harness is a literal one and the checker's import scan can hash everything the harness loads.
// The bundle's text is made here from files in the tree-hash scope (src/, tests/helpers/fake-kubo*.ts for the stub only).
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { join } from "node:path";
import process from "node:process";
import { REPO, Refusal } from "./constants.mjs";
import { childEnv, firstLine } from "./policy.mjs";

const READ_METHODS = ["filesLs", "filesStat", "keyList", "nameResolve"];
const START_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 60_000;

function readerSource() {
  const at = (...parts) => JSON.stringify(join(REPO, ...parts));
  return [
    `import { createServer } from "node:http";`,
    `import { createKuboClient } from ${at("src", "kubo", "index.ts")};`,
    `import { envLayer, resolveSyncConfig } from ${at("src", "core", "config", "index.ts")};`,
    `import { createFakeNode } from ${at("tests", "helpers", "fake-kubo.ts")};`,
    `import { fakeNodeFetch } from ${at("tests", "helpers", "fake-kubo-http.ts")};`,
    `const READ = ${JSON.stringify(READ_METHODS)};`,
    "const print = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    "async function stub() {",
    "  const node = createFakeNode([]);",
    "  const requests = [];",
    "  const server = createServer(async (req, res) => {",
    "    const chunks = [];",
    "    for await (const chunk of req) chunks.push(chunk);",
    "    const body = Buffer.concat(chunks);",
    "    const url = new URL(req.url ?? '/', 'http://127.0.0.1');",
    "    try {",
    "      let response;",
    "      if (url.pathname === '/api/v0/name/resolve') {",
    "        const value = node.published.get((url.searchParams.get('arg') ?? '').replace('/ipns/', ''));",
    "        response = value === undefined ? new Response(JSON.stringify({ Message: 'could not resolve name' }), { status: 500 }) : new Response(JSON.stringify({ Path: value }));",
    "      } else {",
    "        response = await fakeNodeFetch(node, requests)('http://127.0.0.1' + req.url, { method: req.method, headers: req.headers, body: req.method === 'GET' || body.length === 0 ? undefined : body });",
    "      }",
    "      res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));",
    "    } catch (error) {",
    "      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ Message: error instanceof Error ? error.message : String(error), Code: 0, Type: 'error' }));",
    "    }",
    "  });",
    "  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));",
    "  print({ url: 'http://127.0.0.1:' + server.address().port });",
    "}",
    "async function main() {",
    "  const [op, raw] = process.argv.slice(2);",
    "  const input = JSON.parse(raw ?? '{}');",
    "  if (op === 'stub') return stub();",
    "  if (op === 'target') {",
    "    const config = resolveSyncConfig([envLayer(process.env)], new Date());",
    "    return print({ rpc: config.rpc.baseUrl, gateway: config.gateway.baseUrl });",
    "  }",
    "  if (op === 'scan') {",
    "    const config = resolveSyncConfig([envLayer(process.env), { rpc: { url: input.rpc }, gateway: { url: input.gateway }, mfsRoot: input.mfsRoot }], new Date());",
    "    const client = createKuboClient({ rpc: config.rpc, gateway: config.gateway });",
    "    const needles = input.needles.map((needle) => ({ label: needle.label, bytes: Buffer.from(needle.b64, 'base64') }));",
    "    const found = { files: 0, bytes: 0, hit: null };",
    "    const look = (haystack, where) => {",
    "      if (found.hit !== null) return;",
    "      const buffer = Buffer.from(haystack);",
    "      for (const needle of needles) if (needle.bytes.length > 0 && buffer.includes(needle.bytes)) { found.hit = needle.label + ' in ' + where; return; }",
    "    };",
    "    const walk = async (relative) => {",
    "      for (const entry of await client.ipfsLs('/ipfs/' + input.root + relative)) {",
    "        const next = relative + '/' + entry.name;",
    "        look(Buffer.from(entry.name), 'a name');",
    "        if (entry.type === 'directory') { await walk(next); continue; }",
    "        const bytes = await client.gatewayFetch(input.root, next.slice(1));",
    "        found.files += 1;",
    "        found.bytes += bytes.length;",
    "        look(bytes, 'the bytes of ' + next);",
    "      }",
    "    };",
    "    await walk('');",
    "    return print({ ok: found });",
    "  }",
    "  if (op !== 'call' || !READ.includes(input.method)) throw new Error('unknown or non-read operation ' + String(op) + ' ' + String(input.method));",
    "  const config = resolveSyncConfig([envLayer(process.env), { rpc: { url: input.rpc }, gateway: { url: input.gateway }, mfsRoot: input.mfsRoot }], new Date());",
    "  const client = createKuboClient({ rpc: config.rpc, gateway: config.gateway });",
    "  try {",
    "    print({ ok: await client[input.method](...input.args) });",
    "  } catch (error) {",
    "    print({ error: { message: error instanceof Error ? error.message : String(error), status: error?.status, nodeMessage: error?.nodeMessage } });",
    "  }",
    "}",
    "main().catch((error) => { process.stderr.write(String(error?.message ?? error) + '\\n'); process.exit(1); });",
  ].join("\n");
}

/** Bundles the reader into `<work>/reader.mjs` (outside the repository) and returns its path. */
export async function buildReader(work) {
  const outfile = join(work, "reader.mjs");
  await build({
    stdin: { contents: readerSource(), resolveDir: REPO, loader: "ts", sourcefile: "reader-entry.ts" },
    absWorkingDir: REPO,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile,
    logLevel: "silent",
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  });
  return outfile;
}

/** The scrubbed environment (07a's allowlist); `extra` is added last. */
function readerEnv(env, localStub, extra = {}) {
  return childEnv(env, extra, { localStub });
}

function runOnce(bundle, op, input, env, localStub, extra) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [bundle, op, JSON.stringify(input)], { env: readerEnv(env, localStub, extra), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), CALL_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split("\n").at(-1) ?? "";
      try {
        done(JSON.parse(line));
      } catch {
        fail(new Error(`node reader ${op} failed (exit ${code}): ${firstLine(stderr || stdout)}`));
      }
    });
  });
}

/** The upstream URLs the environment names (IPFS_SYNC_RPC_URL and friends), resolved by the project's own config loader. */
export const readTarget = (bundle, env, localStub) => {
  const urls = Object.fromEntries(["IPFS_SYNC_RPC_URL", "IPFS_SYNC_GATEWAY_URL"].filter((name) => typeof env[name] === "string").map((name) => [name, env[name]]));
  return runOnce(bundle, "target", {}, env, localStub, urls);
};

/** A read-only client: only the four read calls exist on it. Errors keep `status` and `nodeMessage` for the never-published test. */
export function makeReadClient({ bundle, env, rpc, gateway, mfsRoot, localStub }) {
  const call = async (method, args) => {
    const answer = await runOnce(bundle, "call", { method, args, rpc, gateway, mfsRoot }, env, localStub);
    if (answer.error !== undefined) throw Object.assign(new Error(answer.error.message), { status: answer.error.status, nodeMessage: answer.error.nodeMessage });
    return answer.ok;
  };
  return Object.freeze(Object.fromEntries(READ_METHODS.map((method) => [method, (...args) => call(method, args)])));
}

/**
 * Walks the immutable tree of `root` (one-level listings and gateway reads, read-only) through `rpc`/`gateway` (the confinement proxy) and
 * looks for each needle in every name and every file's bytes. `needles` = [{ label, bytes: Buffer }]. Returns { files, bytes, hit }, where
 * `hit` is the label of the first needle found and where, or null. The child holds the tree in memory one file at a time.
 */
export async function scanTree({ bundle, env, localStub, rpc, gateway, mfsRoot, root, needles }) {
  const answer = await runOnce(bundle, "scan", { rpc, gateway, mfsRoot, root, needles: needles.map((needle) => ({ label: needle.label, b64: needle.bytes.toString("base64") })) }, env, localStub);
  if (answer.error !== undefined) throw new Error(answer.error.message);
  return answer.ok;
}

/** The stub node, hosted by a child process of the bundle. `stop` ends it. */
export function startStubChild(bundle, env) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [bundle, "stub", "{}"], { env: readerEnv(env, true), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Refusal("the stub node did not start in time"));
    }, START_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("close", () => {
      clearTimeout(timer);
      fail(new Error(`the stub node exited before it was ready: ${firstLine(stderr)}`));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!stdout.includes("\n")) return;
      clearTimeout(timer);
      child.removeAllListeners("close");
      let stopping;
      const stop = () => {
        stopping ??= new Promise((stopped) => {
          child.once("close", () => stopped());
          child.kill("SIGTERM");
        });
        return stopping;
      };
      done({ url: JSON.parse(stdout.split("\n")[0]).url, stop });
    });
  });
}
