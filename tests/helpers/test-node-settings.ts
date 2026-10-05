import { defaultSettings, type PluginSettings } from "../../src/plugin/settings-model";

/**
 * Plugin settings for a test that runs an action through a fake node. The product has no default node
 * (`defaultSettings()` leaves both URLs empty and every action refuses), so a test that wants an action to
 * proceed names a node. Both hosts are `.test` names that nothing resolves; the tests inject their own client or transport.
 */
export const TEST_RPC_URL = "https://node.test";
export const TEST_GATEWAY_URL = "https://gw.test";

export function testNodeSettings(patch: Partial<PluginSettings> = {}): PluginSettings {
  return { ...defaultSettings(), rpc: { url: TEST_RPC_URL }, gateway: { url: TEST_GATEWAY_URL }, ...patch };
}
