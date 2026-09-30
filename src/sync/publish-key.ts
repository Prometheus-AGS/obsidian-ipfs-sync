import { assertKeyOwnedForPublish, classifyKey } from "../core/config";
import type { KuboClient } from "../kubo";
import { OwnedKeyNotRecordedError } from "./publish-errors";

export interface KeyResolution {
  readonly id: string;
  /** True when this run generated the key. */
  readonly created: boolean;
}

/**
 * Establish which IPNS key a publish may use. Owned: use it. Absent: generate it,
 * then record the ID before anything else happens (a failed record stops the publish
 * and reports the ID). Foreign: refuse; `name/publish` is never sent for it.
 */
export async function resolvePublicationKey(
  client: Pick<KuboClient, "keyList" | "keyGen">,
  name: string,
  ownedIds: readonly string[],
  recordOwnedKey: (keyId: string) => Promise<void>,
): Promise<KeyResolution> {
  const nodeKeys = (await client.keyList()).map((key) => ({ name: key.name, id: key.id === "" ? undefined : key.id }));
  const found = classifyKey(name, nodeKeys, ownedIds);
  if (found.state !== "absent") {
    assertKeyOwnedForPublish(name, found);
    return { id: found.id ?? "", created: false };
  }
  const generated = await client.keyGen(name);
  try {
    await recordOwnedKey(generated.id);
  } catch (cause) {
    throw new OwnedKeyNotRecordedError(name, generated.id, cause);
  }
  return { id: generated.id, created: true };
}
