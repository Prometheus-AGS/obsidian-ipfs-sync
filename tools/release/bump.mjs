// Pure text bumps that keep the files' formatting. Each field must match exactly once at the top level.
import { MIN_APP_VERSION, VERSION } from "./constants.mjs";

function replaceOnce(text, key, value) {
  const pattern = new RegExp(`^(\\s{2}"${key}"\\s*:\\s*")[^"]*(")`, "m");
  if (!pattern.test(text)) throw new Error(`top-level "${key}" not found`);
  return text.replace(pattern, `$1${value}$2`);
}

export const bumpManifestText = (text) => replaceOnce(replaceOnce(text, "version", VERSION), "minAppVersion", MIN_APP_VERSION);
export const bumpPackageText = (text) => replaceOnce(text, "version", VERSION);
