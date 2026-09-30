import type { SyncConfig } from "../src/core/config";
import { redactHeaderEntries } from "../src/kubo";
import type { CliIo } from "./io";

type FetchFn = typeof fetch;

function authFor(config: SyncConfig, url: string) {
  return url.startsWith(config.gateway.baseUrl) && !url.startsWith(config.rpc.baseUrl)
    ? config.gateway.auth
    : config.rpc.auth;
}

/**
 * Wrap the global `fetch` so every request the shared client sends is printed
 * (method, URL, headers) with credential values redacted. Returns a restore function.
 */
export function installRequestTrace(config: SyncConfig, io: CliIo): () => void {
  const original: FetchFn = globalThis.fetch;
  const traced: FetchFn = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = redactHeaderEntries(new Headers(init?.headers).entries(), authFor(config, url));
    io.out(`request ${method} ${url}`);
    for (const [name, value] of headers) io.out(`  ${name}: ${value}`);
    if (headers.length === 0) io.out("  (no headers)");
    return original(input, init);
  };
  globalThis.fetch = traced;
  return () => {
    globalThis.fetch = original;
  };
}
