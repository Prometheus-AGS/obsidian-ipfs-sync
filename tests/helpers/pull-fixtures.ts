import { excludesHash } from "../../src/sync/exclusions";
import { sha256Hex } from "../../src/sync/hash";
import { buildManifest, type Manifest, type ManifestFile } from "../../src/sync/manifest";

export const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);
export const decode = (data: Uint8Array | undefined): string => new TextDecoder().decode(data ?? new Uint8Array());

export async function sha(text: string | Uint8Array): Promise<string> {
  return sha256Hex(typeof text === "string" ? encode(text) : Uint8Array.from(text));
}

/** A syntactically valid CID-looking token (the client only checks the shape). */
export const FAKE_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

/** Manifest v1 over file texts. Sizes and hashes are real, CIDs are placeholders. */
export async function manifestFor(
  files: Readonly<Record<string, string>>,
  overrides: { readonly rootCid?: string; readonly excludes?: string } = {},
): Promise<Manifest> {
  const entries: [string, ManifestFile][] = [];
  for (const [path, text] of Object.entries(files)) {
    entries.push([path, { sha256: await sha(text), size: encode(text).length, cid: FAKE_CID }]);
  }
  return buildManifest({
    rootCid: overrides.rootCid ?? FAKE_CID,
    publishedAt: "2026-09-30T00:00:00.000Z",
    device: "test",
    files: Object.fromEntries(entries),
    excludesHash: overrides.excludes ?? (await excludesHash()),
  });
}

export const IPNS_NAME = "k51qzi5uqu5dtestpullname0000000000000000000000000000";

export interface SeedOptions {
  /** CID of the `current/` tree (the manifest's rootCID). */
  readonly tree: string;
  /** CID of the published root the IPNS name points at. */
  readonly root: string;
  /** Root of the previous publish: its `manifests/` history is carried over, like MFS does. */
  readonly previousRoot?: string;
  readonly excludes?: string;
  /** Replace the manifest after it is built (for hostile or divergent manifests). */
  readonly alter?: (manifest: Manifest) => Manifest;
}

/**
 * Lay out what a publish leaves on the node: `<tree>/<path>` file objects, `<root>/manifest.json`,
 * `<root>/manifests/<tree>.json` (plus earlier history) and the IPNS name pointing at `<root>`.
 */
export async function seedRemote(
  gateway: {
    readonly objects: Map<string, Uint8Array>;
    readonly names: Map<string, string>;
  },
  files: Readonly<Record<string, string>>,
  options: SeedOptions,
): Promise<Manifest> {
  const built = await manifestFor(files, { rootCid: options.tree, excludes: options.excludes });
  const manifest = options.alter === undefined ? built : options.alter(built);
  for (const [path, text] of Object.entries(files)) gateway.objects.set(`${options.tree}/${path}`, encode(text));
  if (options.previousRoot !== undefined) {
    const prefix = `${options.previousRoot}/manifests/`;
    for (const [key, value] of [...gateway.objects]) {
      if (key.startsWith(prefix)) gateway.objects.set(`${options.root}/manifests/${key.slice(prefix.length)}`, value);
    }
  }
  const bytes = encode(`${JSON.stringify(manifest, null, 2)}\n`);
  gateway.objects.set(`${options.root}/manifest.json`, bytes);
  gateway.objects.set(`${options.root}/manifests/${options.tree}.json`, bytes);
  gateway.names.set(IPNS_NAME, `/ipfs/${options.root}`);
  return manifest;
}
