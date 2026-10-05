import {
  classifyKey,
  describeAuth,
  type KeyClassification,
  type SyncConfig,
} from "../src/core/config";
import { KuboAuthError, KuboNetworkError, escapeNodeText, isMissingPathError, type KuboClient } from "../src/kubo";
import { EXIT_CHECK_FAILED, EXIT_OK, type CliIo } from "./io";

interface StatusContext {
  readonly config: SyncConfig;
  readonly client: KuboClient;
  readonly io: CliIo;
}

/** A check failed. `abort` means the endpoint rejected our credentials or is unreachable, so more calls are pointless. */
interface CheckFailure {
  readonly abort: boolean;
}

/** Everything the node answers is printed escaped: a name, a version or a key ID could otherwise drive the terminal. */
const safe = escapeNodeText;

function messageOf(error: unknown): string {
  return safe(error instanceof Error ? error.message : String(error));
}

function failure(io: CliIo, label: string, error: unknown): CheckFailure {
  io.out(`${label} FAILED: ${messageOf(error)}`);
  return { abort: error instanceof KuboAuthError || error instanceof KuboNetworkError };
}

function printHeader({ config, io }: StatusContext): void {
  io.out("ipfs-sync status");
  io.out(`  rpc       ${config.rpc.baseUrl}  (auth: ${describeAuth(config.rpc.auth)})`);
  io.out(`  gateway   ${config.gateway.baseUrl}  (auth: ${describeAuth(config.gateway.auth)})`);
  io.out(`  mfs root  ${config.mfsRoot}`);
  io.out(`  key       ${config.publicationKey}`);
}

async function checkNode({ client, io }: StatusContext): Promise<CheckFailure | undefined> {
  try {
    const [identity, version] = await Promise.all([client.id(), client.version()]);
    io.out(`peer id   ${safe(identity.peerId)}`);
    io.out(`version   ${safe(version.version)} (${safe(version.commit) || "no commit"})  ${safe(identity.agentVersion)}`);
    return undefined;
  } catch (error) {
    return failure(io, "node", error);
  }
}

async function checkMfsListing({ config, client, io }: StatusContext): Promise<CheckFailure | undefined> {
  try {
    const entries = await client.filesLs(config.mfsRoot);
    io.out(`mfs ${config.mfsRoot}: ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`);
    for (const entry of entries) io.out(`  ${safe(entry.type).padEnd(9)} ${safe(entry.name)}  ${safe(entry.cid)}  ${entry.size} bytes`);
    return undefined;
  } catch (error) {
    if (isMissingPathError(error)) {
      io.out(`mfs ${config.mfsRoot}: absent (the write probe creates it)`);
      return undefined;
    }
    return failure(io, "mfs listing", error);
  }
}

async function pathExists(client: KuboClient, path: string): Promise<boolean> {
  try {
    await client.filesStat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

async function verifyProbe(
  { config, client, io }: StatusContext,
  path: string,
  payload: Uint8Array<ArrayBuffer>,
): Promise<CheckFailure | undefined> {
  const stat = await client.filesStat(path);
  if (stat.size !== payload.length) {
    throw new Error(`wrote ${payload.length} bytes but files/stat reports ${stat.size}`);
  }
  io.out(`probe OK  (files/write field "data" -> files/stat ${stat.size} bytes -> cid ${safe(stat.cid)})`);
  try {
    const fetched = await client.gatewayFetch(stat.cid);
    if (!sameBytes(fetched, payload)) throw new Error("gateway returned different bytes than were written");
    io.out(`gateway fetch OK  (${config.gateway.baseUrl}/ipfs/${safe(stat.cid)}, ${fetched.length} bytes)`);
    return undefined;
  } catch (error) {
    return failure(io, "gateway fetch", error);
  }
}

async function cleanupProbe(
  { client, io }: StatusContext,
  file: string,
  dir: string,
  dirExisted: boolean,
): Promise<CheckFailure | undefined> {
  try {
    await client.filesRm(file);
    if (!dirExisted) await client.filesRm(dir, { recursive: true });
    io.out("probe cleanup OK  (files/rm of everything the probe wrote)");
    return undefined;
  } catch (error) {
    io.out(`probe cleanup FAILED: ${messageOf(error)}; leftover under ${dir}`);
    return { abort: false };
  }
}

/** Write, stat, gateway-read and remove one small file under `<mfsRoot>/.probe/`. */
async function checkProbe(ctx: StatusContext): Promise<readonly CheckFailure[]> {
  const { config, client, io } = ctx;
  const dir = `${config.mfsRoot}/.probe`;
  const file = `${dir}/probe-${crypto.randomUUID()}.txt`;
  const payload = new TextEncoder().encode(`ipfs-sync status probe ${new Date().toISOString()}\n`);
  const failures: CheckFailure[] = [];
  let dirExisted = true;
  let wrote = false;
  try {
    dirExisted = await pathExists(client, dir);
    await client.filesWrite(file, payload);
    wrote = true;
    const verified = await verifyProbe(ctx, file, payload);
    if (verified !== undefined) failures.push(verified);
  } catch (error) {
    failures.push(failure(io, "probe", error));
    if (!wrote) io.out("gateway fetch SKIPPED  (no probe file was written)");
  }
  if (wrote || !dirExisted) {
    const cleaned = await cleanupProbe(ctx, file, dir, dirExisted);
    if (cleaned !== undefined) failures.push(cleaned);
  }
  return failures;
}

function describeKey(name: string, result: KeyClassification): string {
  const id = result.id === undefined ? "" : ` id ${safe(result.id)}`;
  return `key ${safe(name)}: ${result.state}${id}  (${safe(result.reason)})`;
}

async function checkKey({ config, client, io }: StatusContext): Promise<CheckFailure | undefined> {
  try {
    const keys = await client.keyList();
    const nodeKeys = keys.map((key) => ({ name: key.name, id: key.id === "" ? undefined : key.id }));
    io.out(describeKey(config.publicationKey, classifyKey(config.publicationKey, nodeKeys, config.ownedKeys)));
    return undefined;
  } catch (error) {
    return failure(io, "key state", error);
  }
}

/**
 * `ipfs-sync status`. Read-only except for the probe, which writes and removes one
 * file under `<mfsRoot>/.probe/`. Key state comes from `key/list` only.
 */
export async function runStatus(ctx: StatusContext): Promise<number> {
  printHeader(ctx);
  const failures: CheckFailure[] = [];
  const node = await checkNode(ctx);
  if (node !== undefined) failures.push(node);
  if (node?.abort !== true) {
    for (const check of [checkMfsListing, checkKey]) {
      const result = await check(ctx);
      if (result !== undefined) failures.push(result);
      if (result?.abort === true) break;
    }
  }
  if (!failures.some((f) => f.abort)) failures.push(...(await checkProbe(ctx)));
  return failures.length === 0 ? EXIT_OK : EXIT_CHECK_FAILED;
}
