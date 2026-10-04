import type { CanonicalPassphrase } from "../crypto";

/**
 * Values the plugin instance reads but that no other plugin may reach. They are held here, in module scope, keyed by
 * the plugin object, instead of as public properties on it: another plugin can enumerate and assign `app.plugins`
 * members, but it cannot import this module. `passphraseSource` is no longer read by the publish path (nothing in
 * `src/` reads it now), and plugin-pull-entry.test.ts still sets it. The seam is kept; only tests set these.
 */
export interface PluginSeams {
  readonly passphraseSource?: () => CanonicalPassphrase | undefined;
  /**
   * The derivation the "Measure key derivation time" command times. Production leaves it out and the command runs one key-slot creation at the
   * default cost (several seconds); a test sets a stand-in so the command can be driven at the plugin entry without that cost.
   */
  readonly measureDerive?: () => Promise<void>;
}

const seams = new WeakMap<object, PluginSeams>();

export function readPluginSeams(owner: object): PluginSeams {
  return seams.get(owner) ?? {};
}

export function setPluginSeams(owner: object, next: PluginSeams): void {
  seams.set(owner, { ...readPluginSeams(owner), ...next });
}
