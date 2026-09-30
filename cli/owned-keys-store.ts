import type { HostBridge } from "../src/core/host-bridge";

export class ConfigWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigWriteError";
  }
}

async function readDocument(host: HostBridge, fileName: string): Promise<Readonly<Record<string, unknown>>> {
  if ((await host.fs.stat(fileName)) === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await host.fs.read(fileName)));
  } catch (error) {
    throw new ConfigWriteError(`${fileName} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigWriteError(`${fileName} does not contain a JSON object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

/**
 * Add a key ID to `ownedKeys` in the CLI config file (created with only `ownedKeys` when
 * missing) and leave every other field as it was. `host` is rooted at the config file's directory.
 */
export async function recordOwnedKey(host: HostBridge, fileName: string, keyId: string): Promise<void> {
  const document = await readDocument(host, fileName);
  const existing = Array.isArray(document["ownedKeys"]) ? document["ownedKeys"].filter((v): v is string => typeof v === "string") : [];
  const ownedKeys = existing.includes(keyId) ? existing : [...existing, keyId];
  const text = `${JSON.stringify({ ...document, ownedKeys }, null, 2)}\n`;
  await host.fs.write(fileName, new TextEncoder().encode(text));
}
