import { assertKeyOwnedForPublish, classifyKey } from "../core/config";
import type { KuboClient } from "../kubo";
import { OwnedKeyNotRecordedError } from "./publish-errors";

export interface KeyResolution {
  readonly id: string;
  /** True when this run generated the key. */
  readonly created: boolean;
}

/**
 * The publication key of one publish, established in two steps so that a refusal never leaves a new key behind.
 * `openPublicationKey` only reads (`key/list`): an owned key is used, a foreign one is refused (`name/publish` is
 * never sent for it), an absent one is remembered as absent. `ensure` generates an absent key, then records its ID
 * before anything else happens (a failed record stops the publish and reports the ID); it is called just before the
 * first request that changes the node, and is safe to call again.
 */
export interface PublicationKey {
  /** The key does not exist yet: this publish has to create it, and publishes even if no file changed. */
  readonly absent: boolean;
  /** The ID of the key, or an empty string while it is absent and not yet ensured. */
  id(): string;
  /** Whether this run generated the key. */
  created(): boolean;
  ensure(): Promise<KeyResolution>;
}

export async function openPublicationKey(
  client: Pick<KuboClient, "keyList" | "keyGen">,
  name: string,
  ownedIds: readonly string[],
  recordOwnedKey: (keyId: string) => Promise<void>,
): Promise<PublicationKey> {
  const nodeKeys = (await client.keyList()).map((key) => ({ name: key.name, id: key.id === "" ? undefined : key.id }));
  const found = classifyKey(name, nodeKeys, ownedIds);
  if (found.state !== "absent") assertKeyOwnedForPublish(name, found);
  let resolved: KeyResolution | undefined = found.state === "absent" ? undefined : { id: found.id ?? "", created: false };

  const generate = async (): Promise<KeyResolution> => {
    const generated = await client.keyGen(name);
    try {
      await recordOwnedKey(generated.id);
    } catch (cause) {
      throw new OwnedKeyNotRecordedError(name, generated.id, cause);
    }
    return { id: generated.id, created: true };
  };

  return {
    absent: found.state === "absent",
    id: () => resolved?.id ?? "",
    created: () => resolved?.created ?? false,
    ensure: async () => (resolved ??= await generate()),
  };
}
