import { describe, expect, it } from "vitest";
import { defaultSettings, type PluginSettings } from "../../src/plugin/settings-model";
import { createSettingsStore } from "../../src/plugin/settings-store";
import { collectStatus, formatStatus } from "../../src/plugin/sync-status";
import { MemoryAdapter } from "../support/memory-adapter";

const NOW = new Date("2026-10-05T12:00:00Z");

function storeFor(patch: Partial<PluginSettings>) {
  return createSettingsStore(
    { loadData: async () => null, saveData: async () => undefined },
    { settings: { ...defaultSettings(), ...patch }, outcome: "current", notices: [], persist: false },
  );
}

async function statusText(patch: Partial<PluginSettings>): Promise<string> {
  const report = await collectStatus({ store: storeFor(patch), adapter: new MemoryAdapter(), now: () => NOW });
  return formatStatus(report);
}

describe("status when the settings cannot be turned into a configuration", () => {
  it("prints the addresses without userinfo, query or fragment", async () => {
    const text = await statusText({
      rpc: { url: "https://alice:hunter2@node.example.org/base?token=t0k#frag" },
      gateway: { url: "https://bob:s3cret@gw.example.org:8080" },
    });
    expect(text).not.toMatch(/hunter2|alice|s3cret|bob|t0k|frag/);
    expect(text).toContain("RPC: https://node.example.org/base");
    expect(text).toContain("Gateway: https://gw.example.org:8080");
  });

  it("shows no part of a password that holds / ? or #", async () => {
    for (const url of ["https://u:pa#ss@host", "https://u:pa/ss@host", "https://u:pa?ss@host"]) {
      const text = await statusText({ rpc: { url }, gateway: { url } });
      expect(text).not.toMatch(/pa#ss|pa\/ss|pa\?ss|u:pa|ss@/);
    }
  });

  it("prints a fixed text for an address that does not parse", async () => {
    const text = await statusText({ rpc: { url: "not a url at all" }, gateway: { url: "http://[bad" } });
    expect(text).toContain("RPC: invalid address");
    expect(text).toContain("Gateway: invalid address");
  });

  it("leaves an empty address empty", async () => {
    const text = await statusText({});
    expect(text).toContain("RPC: \n");
  });
});
