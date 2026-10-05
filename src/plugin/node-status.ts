import { isRetiredDefaultHost, RETIRED_DEFAULT_WARNING } from "../core/config";
import type { PluginSettings } from "./settings-model";

/** The words of every refusal and the settings line while no node is set. */
export const NODE_NOT_SET_NOTICE = "Set your IPFS node in settings";

export const NOT_CONFIGURED_SUMMARY = "Not configured";

export const NOT_CONFIGURED_EXPLANATION =
  "This plugin has no default IPFS node. Enter the RPC URL and the gateway URL of a kubo node you run or trust. Until both are set, publish, pull, the key actions and the auto-publish timer do nothing and send no request.";

const CONFIGURED_SUMMARY = "Configured";

export interface NodeStatus {
  /** Both the RPC URL and the gateway URL are non-empty. */
  readonly configured: boolean;
  /** "Not configured" or "Configured". */
  readonly summary: string;
  /** Why it matters; empty once configured. */
  readonly explanation: string;
  /** Present when a configured URL names a retired default host (a saved 0.2.0 setting). */
  readonly retiredWarning?: string;
}

/** True when a URL field holds text. Whitespace is empty. */
export function isSet(url: string): boolean {
  return url.trim() !== "";
}

export function retiredDefaultInUse(settings: Pick<PluginSettings, "rpc" | "gateway">): boolean {
  return isRetiredDefaultHost(settings.rpc.url) || isRetiredDefaultHost(settings.gateway.url);
}

/** What the settings tab shows about the node, from the stored settings. */
export function describeNode(settings: Pick<PluginSettings, "rpc" | "gateway">): NodeStatus {
  const configured = isSet(settings.rpc.url) && isSet(settings.gateway.url);
  const retired = retiredDefaultInUse(settings) ? { retiredWarning: RETIRED_DEFAULT_WARNING } : {};
  return configured
    ? { configured, summary: CONFIGURED_SUMMARY, explanation: "", ...retired }
    : { configured, summary: NOT_CONFIGURED_SUMMARY, explanation: NOT_CONFIGURED_EXPLANATION, ...retired };
}

/**
 * The one-time notice at load: the text when a saved URL names a retired default host and the notice was not
 * shown before, otherwise undefined. The caller shows it and records `retiredDefaultNoticeShown`.
 */
export function retiredDefaultNotice(settings: Pick<PluginSettings, "rpc" | "gateway" | "retiredDefaultNoticeShown">): string | undefined {
  if (settings.retiredDefaultNoticeShown === true || !retiredDefaultInUse(settings)) return undefined;
  return `IPFS Sync: ${RETIRED_DEFAULT_WARNING}`;
}
