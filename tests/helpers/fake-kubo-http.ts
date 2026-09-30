import { KuboHttpError } from "../../src/kubo";
import type { FakeNode } from "./fake-kubo";
import { dataPart } from "./multipart";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Serve a FakeNode over the kubo HTTP RPC, for tests that go through the real
 * `src/kubo` client. Requests seen (method and path) are appended to `requests`.
 */
export function fakeNodeFetch(node: FakeNode, requests: string[]): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const url = new URL(String(input));
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
        case "files/rm":
          await node.client.filesRm(arg);
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
      if (error instanceof KuboHttpError) return json({ Message: "file does not exist", Code: 0, Type: "error" }, 500);
      return json({ Message: error instanceof Error ? error.message : String(error), Code: 0, Type: "error" }, 500);
    }
  };
}
