import type { SyncConfig } from "../src/core/config";
import { redactHeaderEntries } from "../src/kubo";
import type { CliIo } from "./io";

type FetchFn = typeof fetch;

/**
 * Redact the credential header names of both endpoints on every request. Choosing one endpoint by URL prefix fails when one base URL is a
 * prefix of the other (`https://host` and `https://host:8443`): the request to the longer address would be redacted under the wrong names.
 */
function redactBoth(entries: Iterable<readonly [string, string]>, config: SyncConfig): readonly (readonly [string, string])[] {
  return redactHeaderEntries(redactHeaderEntries(entries, config.rpc.auth), config.gateway.auth);
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
    const headers = redactBoth(new Headers(init?.headers).entries(), config);
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
