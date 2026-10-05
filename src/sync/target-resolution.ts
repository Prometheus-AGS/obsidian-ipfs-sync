import { classifyKey } from "../core/config";
import type { KuboClient } from "../kubo";
import { isCidToken } from "./local-record";
import { PullSourceError, PullTargetError } from "./pull-errors";

/** The longest CID the local record reads back (`CID_TOKEN` in `local-record.ts`): a longer one would be written to a state or journal file this build then refuses. */
export const CID_MAX_LENGTH = 128;
/** A resolved root path is captured at any length so a too-long identifier gets its own fixed refusal below. */
const ROOT_PATH = /^\/ipfs\/([A-Za-z0-9]{10,})$/;

/** IPNS key IDs and CIDs share one alphanumeric token rule (`isCidToken`). Anything else never reaches a request. */
export function isIpnsName(value: string): boolean {
  return isCidToken(value);
}

export function isCid(value: string): boolean {
  return isCidToken(value);
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
  if (match[1].length > CID_MAX_LENGTH) throw new PullSourceError("the name resolved to a root identifier longer than a CID can be; nothing was written");
  return match[1];
}
