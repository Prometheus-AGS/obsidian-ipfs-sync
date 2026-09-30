import { KuboHttpError } from "../../src/kubo";
import type { FakeNode } from "./fake-kubo";
import { NodeKilled } from "./fake-kubo";
import { dataPart } from "./multipart";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A gateway read: `/ipfs/<cid>[/<path>]`, with an optional `Range` header. */
async function gateway(node: FakeNode, pathname: string, init: RequestInit): Promise<Response> {
  const [cid, ...rest] = pathname.slice("/ipfs/".length).split("/").map(decodeURIComponent);
  try {
    const bytes = await node.client.gatewayFetch(cid ?? "", rest.join("/"));
    const range = new Headers(init.headers).get("range");
    const match = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
    // Observed: an empty file answers 200 with no body even to a Range request; a Range past the end is clamped (206).
    if (match === null || bytes.length === 0) return new Response(new Uint8Array(bytes), { status: 200 });
    const end = Math.min(Number(match[2]), bytes.length - 1);
    return new Response(new Uint8Array(bytes.slice(Number(match[1]), end + 1)), { status: 206, headers: { "content-range": `bytes ${match[1]}-${end}/${bytes.length}` } });
  } catch (error) {
    if (error instanceof KuboHttpError) return new Response("not found", { status: 404 });
    throw error;
  }
}

/**
 * Serve a FakeNode over the kubo HTTP RPC and the gateway, for tests that go through the real `src/kubo` client.
 * Requests seen (the command, or `GET <path>` for the gateway) are appended to `requests`. A `NodeKilled` thrown by
 * the fake propagates, like a process that dies mid-request.
 */
export function fakeNodeFetch(node: FakeNode, requests: string[]): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/ipfs/")) {
      requests.push(`GET ${url.pathname}`);
      return gateway(node, url.pathname, init);
    }
    const command = url.pathname.replace("/api/v0/", "");
    requests.push(command);
    const arg = url.searchParams.get("arg") ?? "";
    try {
      switch (command) {
        case "key/list":
          return json({ Keys: (await node.client.keyList()).map((k) => ({ Name: k.name, Id: k.id })) });
        case "key/gen": {
          const key = await node.client.keyGen(arg);
          return json({ Name: key.name, Id: key.id });
        }
        case "files/write": {
          const offset = url.searchParams.get("offset");
          await node.client.filesWrite(arg, await dataPart(init), {
            truncate: url.searchParams.get("truncate") !== "false",
            offset: offset === null ? undefined : Number(offset),
          });
          return new Response("");
        }
        case "files/stat": {
          const stat = await node.client.filesStat(arg);
          return json({ Hash: stat.cid, Size: stat.size, CumulativeSize: stat.cumulativeSize, Blocks: 0, Type: stat.type });
        }
        case "files/ls": {
          const entries = await node.client.filesLs(arg);
          // Observed on the shared node (probe, mvp-06 3.7): one JSON object {"Entries":[...]} even with stream=true.
          return json({ Entries: entries.map((e) => ({ Name: e.name, Type: e.type === "directory" ? 1 : 0, Size: e.size, Hash: e.cid })) });
        }
        case "ls": {
          const entries = await node.client.ipfsLs(arg);
          const links = entries.map((e) => ({ Name: e.name, Hash: e.cid, Size: e.size, Type: e.type === "directory" ? 1 : 2, Target: "" }));
          // Observed: the object Hash is "/ipfs/<cid>", an empty directory has "Links":[], and each link also carries Mode and ModTime.
          return json({ Objects: [{ Hash: arg.split("/").slice(0, 3).join("/"), Links: links }] });
        }
        case "files/rm":
          await node.client.filesRm(arg, { recursive: url.searchParams.get("recursive") === "true" });
          return new Response("");
        case "pin/add":
          await node.client.pinAdd(arg);
          return json({ Pins: [arg] });
        case "name/publish": {
          const published = await node.client.namePublish(url.searchParams.get("key") ?? "", arg.replace("/ipfs/", ""), url.searchParams.get("ttl") ?? undefined);
          return json({ Name: published.name, Value: published.value });
        }
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (error) {
      if (error instanceof NodeKilled) throw error;
      if (error instanceof KuboHttpError) return json({ Message: "file does not exist", Code: 0, Type: "error" }, 500);
      return json({ Message: error instanceof Error ? error.message : String(error), Code: 0, Type: "error" }, 500);
    }
  };
}
