// The script-hosted stub node: the recording fake from tests/helpers behind a loopback HTTP server.
import { createServer } from "node:http";
import { MUTATING_COMMANDS } from "./policy.mjs";
import { JSON_HEADERS } from "./proxy.mjs";

// ======================================================================================================================
// Stub node (hostile-object phase, and --local-stub): the recording fake from tests/helpers behind a loopback HTTP server
// ======================================================================================================================

export async function startStub(tb) {
  const state = { node: tb.createFakeNode([]), requests: [] };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      let response;
      if (url.pathname === "/api/v0/name/resolve") {
        state.requests.push("name/resolve");
        const value = state.node.published.get((url.searchParams.get("arg") ?? "").replace("/ipns/", ""));
        response = value === undefined ? new Response(JSON.stringify({ Message: "could not resolve name" }), { status: 500 }) : new Response(JSON.stringify({ Path: value }));
      } else {
        response = await tb.fakeNodeFetch(state.node, state.requests)(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers, body: req.method === "GET" || body.length === 0 ? undefined : body });
      }
      res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ Message: error instanceof Error ? error.message : String(error), Code: 0, Type: "error" }));
    }
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests: state.requests,
    get node() {
      return state.node;
    },
    swap: (node) => {
      state.node = node;
    },
    mutationsSince: (mark) => state.requests.slice(mark).filter((line) => MUTATING_COMMANDS.has(line)),
    stop: () => new Promise((done) => {
      server.closeAllConnections();
      server.close(() => done());
    }),
  };
}
