// Pure text bumps that keep the files' formatting. Each field must match exactly once at the top level.
// Used only by a descriptor whose record.bumpVersions is true.
function replaceOnce(text, key, value) {
  const pattern = new RegExp(`^(\\s{2}"${key}"\\s*:\\s*")[^"]*(")`, "m");
  if (!pattern.test(text)) throw new Error(`top-level "${key}" not found`);
  return text.replace(pattern, `$1${value}$2`);
}

export const bumpManifestText = (text, descriptor) => replaceOnce(replaceOnce(text, "version", descriptor.version), "minAppVersion", descriptor.minAppVersion);
export const bumpPackageText = (text, descriptor) => replaceOnce(text, "version", descriptor.version);
