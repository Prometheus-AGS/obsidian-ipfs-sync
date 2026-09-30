import type { NodeKey } from "../../src/kubo";
import { stubResponse, type RequestUrlParam, type RequestUrlResponse } from "../support/obsidian-stub";
import type { FakeGateway } from "./fake-gateway";

/**
 * The HTTP face of a fake gateway, for the `requestUrl` stub: `key/list`, `name/resolve` and `/ipfs/<cid>/<path>`
 * reads. Any other RPC command is answered with an error, so a test fails if the plugin tries to mutate the node.
 * Every request path is recorded.
 */
export function serveGateway(gateway: FakeGateway, keys: readonly NodeKey[]): { readonly handler: (params: RequestUrlParam) => RequestUrlResponse; readonly paths: string[] } {
  const paths: string[] = [];
  const handler = (params: RequestUrlParam): RequestUrlResponse => {
    const url = new URL(params.url);
    paths.push(`${params.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/v0/key/list") {
      return stubResponse(200, JSON.stringify({ Keys: keys.map((key) => ({ Name: key.name, Id: key.id })) }));
    }
    if (url.pathname === "/api/v0/name/resolve") {
      const resolved = gateway.names.get((url.searchParams.get("arg") ?? "").replace("/ipns/", ""));
      return resolved === undefined ? stubResponse(500, '{"Message":"could not resolve name"}') : stubResponse(200, `${JSON.stringify({ Path: resolved })}\n`);
    }
    if (url.pathname.startsWith("/ipfs/")) {
      const found = gateway.objects.get(decodeURIComponent(url.pathname.slice("/ipfs/".length)));
      return found === undefined ? stubResponse(404, "not found") : stubResponse(200, found);
    }
    return stubResponse(500, `{"Message":"unexpected request ${url.pathname}"}`);
  };
  return { handler, paths };
}
