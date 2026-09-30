import { classifyKey } from "../core/config";
import { KuboHttpError, type KuboClient } from "../kubo";
import { parseManifest, type Manifest } from "./manifest";
import { PullSourceError, PullTargetError } from "./pull-errors";

/** IPNS key IDs and CIDs: a plain alphanumeric token. Anything else never reaches a request. */
const TOKEN = /^[A-Za-z0-9]{10,}$/;
const ROOT_PATH = /^\/ipfs\/([A-Za-z0-9]{10,})$/;

export type ReadClient = Pick<KuboClient, "nameResolve" | "keyList" | "gatewayFetch">;

export type ManifestSelector =
  | { readonly kind: "latest" }
  /** `manifests/<currentCID>.json`: the snapshot published when `current/` had this CID. */
  | { readonly kind: "historical"; readonly currentCid: string }
  /** Manifest text the caller read from a local file. */
  | { readonly kind: "text"; readonly text: string };

export function isIpnsName(value: string): boolean {
  return TOKEN.test(value);
}

export function isCid(value: string): boolean {
  return TOKEN.test(value);
}

export interface TargetInput {
  /** `--name`: used as given. */
  readonly name?: string;
  readonly keyName: string;
  readonly ownedKeys: readonly string[];
}

/** The IPNS name to pull from: `--name`, or the ID of the owned publication key (read-only `key/list`). */
export async function chooseIpnsName(client: Pick<KuboClient, "keyList">, input: TargetInput): Promise<string> {
  if (input.name !== undefined) return input.name;
  const nodeKeys = (await client.keyList()).map((key) => ({ name: key.name, id: key.id === "" ? undefined : key.id }));
  const found = classifyKey(input.keyName, nodeKeys, input.ownedKeys);
  if (found.state === "owned" && found.id !== undefined) return found.id;
  throw new PullTargetError(
    `publication key "${input.keyName}" is ${found.state} (${found.reason}); pass --name <IPNS key ID> to pull from a specific name`,
  );
}

/** Resolve the name to the CID of the published root (`current/`, `manifest.json`, `manifests/`). */
export async function resolveRootCid(client: Pick<KuboClient, "nameResolve">, ipnsName: string): Promise<string> {
  const resolved = await client.nameResolve(ipnsName);
  const match = ROOT_PATH.exec(resolved);
  if (match?.[1] === undefined) throw new PullSourceError(`name ${ipnsName} resolved to "${resolved}", which is not a published root`);
  return match[1];
}

async function readGatewayText(client: Pick<KuboClient, "gatewayFetch">, rootCid: string, path: string): Promise<string> {
  try {
    return new TextDecoder().decode(await client.gatewayFetch(rootCid, path));
  } catch (error) {
    if (error instanceof KuboHttpError) throw new PullSourceError(`cannot read ${path} under the published root: ${error.message}`, { cause: error });
    throw error;
  }
}

/** Read and validate the selected manifest. Nothing is written yet. */
export async function loadManifest(
  client: Pick<KuboClient, "gatewayFetch">,
  rootCid: string,
  selector: ManifestSelector,
): Promise<Manifest> {
  switch (selector.kind) {
    case "text":
      return parseManifest(selector.text);
    case "latest":
      return parseManifest(await readGatewayText(client, rootCid, "manifest.json"));
    case "historical":
      if (!isCid(selector.currentCid)) throw new PullSourceError(`"${selector.currentCid}" is not a CID`);
      return parseManifest(await readGatewayText(client, rootCid, `manifests/${selector.currentCid}.json`));
  }
}
