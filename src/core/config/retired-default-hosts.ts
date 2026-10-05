/**
 * Hosts that releases up to 0.2.0 used as the built-in node. They are NOT defaults any more: nothing here
 * is ever used to fill in a URL. The list exists only so the plugin can warn an operator whose saved
 * settings still name one of them. It is the only place under `src/` and `cli/` that holds such a host
 * (a test scans for that).
 */
export const RETIRED_DEFAULT_HOSTS: readonly string[] = ["ipfs.prometheusags.ai"];

/** The warning shown beside the settings and once at load when a configured URL names a retired default host. */
export const RETIRED_DEFAULT_WARNING =
  "This URL is the project maintainer's own node and is open to anyone. Use your own IPFS node instead.";

function hostOf(url: string): string | undefined {
  try {
    // A trailing dot is the absolute (FQDN) form of the same host.
    return new URL(url.trim()).hostname.replace(/\.+$/, "").toLowerCase();
  } catch {
    return undefined;
  }
}

/** True when `url` parses and its host is a retired default host. Comparison only; never a fallback. */
export function isRetiredDefaultHost(url: string): boolean {
  const host = hostOf(url);
  return host !== undefined && RETIRED_DEFAULT_HOSTS.includes(host);
}
