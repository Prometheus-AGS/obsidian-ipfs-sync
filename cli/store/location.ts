import { posix, win32 } from "node:path";
import type { EnvMap } from "../../src/core/config";
import { deviceStoreDirectory } from "../device-store-node";

/**
 * The history database lives in the per-user state directory under `history/`,
 * resolved by exactly the same rule as the CLI device store
 * (`deviceStoreDirectory` in `cli/device-store-node.ts`): `$XDG_STATE_HOME`
 * is honoured on every platform but Windows, macOS falls back to
 * `~/Library/Application Support`, Windows to `%LOCALAPPDATA%`, other systems
 * to `~/.local/state`. It is device-local: never synced, never published.
 */
export function historyStoreDirectory(env: EnvMap, platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? win32 : posix).join(deviceStoreDirectory(env, platform), "history");
}
