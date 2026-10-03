import { KuboHttpError, type KuboClient } from "../kubo";
import { parseManifest, type Manifest } from "./manifest";
import { PullSourceError } from "./pull-errors";
import { isCid } from "./target-resolution";

export type ReadClient = Pick<KuboClient, "nameResolve" | "keyList" | "gatewayFetch">;

export type ManifestSelector =
  | { readonly kind: "latest" }
  /** `manifests/<currentCID>.json`: the snapshot published when `current/` had this CID. */
  | { readonly kind: "historical"; readonly currentCid: string }
  /** Manifest text the caller read from a local file. */
  | { readonly kind: "text"; readonly text: string };

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
