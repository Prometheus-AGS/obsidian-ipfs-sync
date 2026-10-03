import { OversizeInputError, wipe } from "../src/crypto";
import { KuboError, type MfsEntry } from "../src/kubo";
import { ManifestFormatError, decodeManifestFile } from "../src/sync/encrypted-manifest";
import { stateRecordOf } from "../src/sync/encrypted-pull";
import { parseHistoryName, prefixMatchesSequence, sortHistoryNames, type HistoryName } from "../src/sync/history-names";
import { isUnreadableManifest } from "../src/sync/manifest-auth";
import { KEYSLOTS_READ_CAP, readRemoteFile } from "../src/sync/node-reader";
import { escapeForDisplay } from "../src/sync/path-policy";
import { PublishRefusedError } from "../src/sync/publish-refusals";
import { recordLookup, unlockForPull, type PullUnlock } from "../src/sync/pull-unlock";
import { readRootState } from "../src/sync/root-state";
import { chooseIpnsName, resolveRootCid } from "../src/sync/target-resolution";
import { createLazyDeviceStore } from "./device-store-node";
import { EXIT_OK, type CliIo } from "./io";
import { createNodeHostBridge } from "./node-host-bridge";
import type { PullContext } from "./pull-context";
import { costQuestion } from "./pull-encrypted-command";

/** The newest history entries `--list-versions` shows. */
export const LIST_VERSIONS_LIMIT = 20;
/** A history file above this is listed by name only: it is not downloaded or decrypted. */
export const LIST_VERSIONS_MAX_BYTES = 8 * 1024 * 1024;

type Client = PullContext["client"];

/** The text of a history file that cannot be shown, or `undefined` for an error that is not about the file. */
function unreadableReason(error: unknown): string | undefined {
  if (isUnreadableManifest(error)) return "it does not authenticate under this vault's key";
  if (error instanceof ManifestFormatError || error instanceof OversizeInputError) return "it holds something this build does not read";
  if (error instanceof PublishRefusedError && (error.code === "remote-object-too-large" || error.code === "remote-object-invalid")) return "the node served it in a form that was refused";
  if (error instanceof KuboError) return "the node did not serve it";
  return undefined;
}

/** `sequence 12`, or `legacy` for a name written before the sequence prefix. */
const labelOf = (name: HistoryName): string => (name.sequence === undefined ? "legacy" : `sequence ${name.sequence}`);

interface Described {
  /** The line to print, or `undefined` when the entry is skipped. */
  readonly line: string | undefined;
  readonly warning?: string;
}

async function describeEntry(client: Client, unlock: PullUnlock, name: HistoryName, entry: MfsEntry): Promise<Described> {
  const head = `  ${labelOf(name).padEnd(14)}`;
  if (entry.size > LIST_VERSIONS_MAX_BYTES) return { line: `${head}(not decrypted: ${entry.size} bytes is above 8 MiB)  ${name.name}` };
  try {
    const manifest = await decodeManifestFile(unlock.keys, await readRemoteFile(client, entry, "a history entry", LIST_VERSIONS_MAX_BYTES));
    if (manifest.vaultId !== unlock.vaultId || !prefixMatchesSequence(name, manifest.sequence)) {
      return { line: undefined, warning: `history entry ${name.name} was skipped: its manifest does not match its name (another vault or another sequence than the name says)` };
    }
    return { line: `${head}${manifest.publishedAt}  ${escapeForDisplay(manifest.device)}  ${name.name}` };
  } catch (error) {
    const reason = unreadableReason(error);
    if (reason === undefined) throw error;
    return { line: `${head}(not readable: ${reason})  ${name.name}` };
  }
}

/** The one entry of this name in a listing; a listing that names it twice is not a layout this tool wrote. */
function entryNamed(entries: readonly MfsEntry[], name: string): MfsEntry | undefined {
  const found = entries.filter((entry) => entry.name === name);
  return found.length === 1 ? found[0] : undefined;
}

async function unlockVault(ctx: PullContext, client: Client, entries: readonly MfsEntry[], vault: string): Promise<PullUnlock> {
  const host = createNodeHostBridge({ root: vault, env: ctx.env, now: () => ctx.now().getTime() });
  const state = await readRootState(host.kv, ctx.config.mfsRoot);
  const passphrase = await ctx.passphrase();
  const { confirm } = ctx.io;
  try {
    return await unlockForPull({
      fs: host.fs,
      mfsRoot: ctx.config.mfsRoot,
      passphrase,
      local: state === undefined ? { hasState: false } : { hasState: true, vaultId: state.vaultId, keyslotsSha256: state.keyslotsSha256 },
      node: {
        fetchKeySlots: async () => {
          const slots = entryNamed(entries, "keyslots.json");
          return slots === undefined ? undefined : readRemoteFile(client, slots, "keyslots.json", KEYSLOTS_READ_CAP);
        },
        manifestPresent: async () => entryNamed(entries, "manifest.enc")?.type === "file",
      },
      recordFor: recordLookup({ state: stateRecordOf(state, undefined, undefined), deviceStore: createLazyDeviceStore(ctx.env) }),
      ...(ctx.flags.expectVaultId === undefined ? {} : { expectVaultId: ctx.flags.expectVaultId }),
      ...(confirm === undefined ? {} : { confirmCost: (costs) => confirm(costQuestion(costs)) }),
    });
  } finally {
    wipe(passphrase);
  }
}

function printEntries(io: CliIo, shownCount: number, total: number, lines: readonly string[]): void {
  io.out(`history (newest first; ${shownCount} of ${total}):`);
  for (const line of lines) io.out(line);
}

/**
 * `pull --list-versions`: the newest 20 history entries of the root by name (the sequence comes from the name; legacy names
 * sort last), with the date and device after unlocking for each file of at most 8 MiB. A prefixed name whose manifest carries
 * another sequence is skipped with a warning. Reads only; writes nothing, takes no lock and creates no directory.
 */
export async function runListVersions(ctx: PullContext, vault: string): Promise<number> {
  const { client, flags, config, io } = ctx;
  const rootCid =
    flags.rootCid ?? (await resolveRootCid(client, await chooseIpnsName(client, { name: flags.name, keyName: config.publicationKey, ownedKeys: config.ownedKeys })));
  const entries = await client.ipfsLs(`/ipfs/${rootCid}`);
  const unlock = await unlockVault(ctx, client, entries, vault);
  const folder = entryNamed(entries, "manifests");
  const listed = folder?.type === "directory" ? await client.ipfsLs(`/ipfs/${rootCid}/manifests`) : [];
  const files = new Map(listed.filter((entry) => entry.type === "file" && parseHistoryName(entry.name) !== undefined).map((entry) => [entry.name, entry] as const));
  const names = sortHistoryNames([...files.keys()]);
  const newest = names.slice(-LIST_VERSIONS_LIMIT).reverse();
  const lines: string[] = [];
  for (const name of newest) {
    const described = await describeEntry(client, unlock, name, files.get(name.name) as MfsEntry);
    if (described.warning !== undefined) io.err(`warning: ${described.warning}`);
    if (described.line !== undefined) lines.push(described.line);
  }
  printEntries(io, lines.length, names.length, lines);
  return EXIT_OK;
}
