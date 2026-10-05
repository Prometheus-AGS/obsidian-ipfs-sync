import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dataPart } from "../helpers/multipart";
import { UsageError, parseCliArgs } from "../../cli/args";
import type { CliIo } from "../../cli/io";
import type { ConfigDeps } from "../../cli/load-config";
import { runCli } from "../../cli/run";
import { NODE_ENV } from "../helpers/cli-state-env";
import { TEST_RPC_URL } from "../helpers/test-node-settings";

const PEER_ID = "QmSrPmbaUKA3ZodhzPWZnpFgcPMFWF4QsxXbkWfEptTBJd";
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

interface Sink {
  readonly io: CliIo;
  readonly out: string[];
  readonly err: string[];
}

function sink(): Sink {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => void out.push(t), err: (t) => void err.push(t) }, out, err };
}

function deps(env: Record<string, string> = {}, files: Record<string, string> = {}): ConfigDeps {
  return {
    env: { ...NODE_ENV, ...env },
    now: () => new Date("2026-09-29T12:00:00Z"),
    readText: async (path) => files[path],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A minimal in-memory node behind a stub fetch. */
function fakeNode(options: { readonly keys?: readonly { Name: string; Id: string }[]; readonly authStatus?: number; readonly rootMissing?: boolean } = {}) {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const requests: string[] = [];
  const handler = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    requests.push(`${init.method ?? "GET"} ${url.pathname}`);
    if (options.authStatus !== undefined) return new Response("denied", { status: options.authStatus });
    const arg = url.searchParams.get("arg") ?? "";
    switch (url.pathname) {
      case "/api/v0/id":
        return json({ ID: PEER_ID, AgentVersion: "kubo/0.40.0" });
      case "/api/v0/version":
        return json({ Version: "0.40.0", Commit: "abc" });
      case "/api/v0/key/list":
        return json({ Keys: options.keys ?? [{ Name: "self", Id: "k51self" }] });
      case "/api/v0/files/ls":
        if (options.rootMissing === true) return json({ Message: "file does not exist", Code: 0, Type: "error" }, 500);
        return new Response(`${JSON.stringify({ Entries: [{ Name: "publish-real", Type: 1, Size: 0, Hash: CID }] })}\n`);
      case "/api/v0/files/write": {
        files.set(arg, await dataPart(init));
        return new Response("");
      }
      case "/api/v0/files/stat": {
        const data = files.get(arg);
        if (data === undefined) return json({ Message: "file does not exist", Code: 0, Type: "error" }, 500);
        return json({ Hash: CID, Size: data.length, CumulativeSize: data.length, Blocks: 0, Type: "file" });
      }
      case "/api/v0/files/rm":
        for (const key of [...files.keys()]) if (key === arg || key.startsWith(`${arg}/`)) files.delete(key);
        return new Response("");
      default:
        if (url.pathname === `/ipfs/${CID}`) return new Response([...files.values()][0] ?? new Uint8Array());
        return new Response("not found", { status: 404 });
    }
  };
  return { handler, files, requests };
}

describe("cli argument parsing", () => {
  it("builds the flags layer", () => {
    const args = parseCliArgs(["status", "--rpc-url", "https://a", "--rpc-port", "5001", "--auth", "bearer", "--show-request"]);
    expect(args.command).toBe("status");
    expect(args.showRequest).toBe(true);
    expect(args.flagsLayer.rpc).toEqual({ url: "https://a", port: "5001" });
    expect(args.flagsLayer.auth?.scheme).toBe("bearer");
  });

  it("rejects unknown flags, and collects operands for the command to check", () => {
    expect(() => parseCliArgs(["status", "--nope"])).toThrowError(UsageError);
    expect(parseCliArgs(["publish", "./vault"]).operands).toEqual(["./vault"]);
  });
});

describe("runCli", () => {
  let node: ReturnType<typeof fakeNode>;
  let fetchStub: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    node = fakeNode();
    fetchStub = vi.fn(node.handler);
    vi.stubGlobal("fetch", fetchStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prints help and exits 0", async () => {
    const s = sink();
    expect(await runCli(["--help"], deps(), s.io)).toBe(0);
    expect(s.out.join("\n")).toContain("ipfs-sync status");
  });

  it("exits 2 for an operand that status does not take", async () => {
    const s = sink();
    expect(await runCli(["status", "extra"], deps(), s.io)).toBe(2);
    expect(s.err.join("\n")).toContain('unexpected argument "extra"');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("exits 2 for a missing or unknown command", async () => {
    expect(await runCli([], deps(), sink().io)).toBe(2);
    expect(await runCli(["publish"], deps(), sink().io)).toBe(2);
  });

  it.each([
    [["status", "--mfs-root", "/obsidian-vault-staging"], /outside \/obsidian-vault-sync/],
    [["status", "--mfs-root", "/obsidian-vault-sync/../other"], /outside \/obsidian-vault-sync/],
    [["status", "--key", "consult-capture"], /another project/],
    [["status", "--key", "gomark-relay-lab"], /another project/],
    [["status", "--key", "prince-live"], /another project/],
    [["status", "--rpc-url", "ftp://host"], /http or https/],
    [["status", "--rpc-url", "https://host:8443", "--rpc-port", "5001"], /already carries port 8443/],
  ])("exits nonzero before any request for %j", async (argv, message) => {
    const s = sink();
    expect(await runCli(argv, deps(), s.io)).toBe(2);
    expect(s.err.join("\n")).toMatch(message);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("rejects a config file containing a secret before any request", async () => {
    const s = sink();
    const files = { "ipfs-sync.config.json": JSON.stringify({ auth: { scheme: "bearer", token: "x" } }) };
    expect(await runCli(["status"], deps({}, files), s.io)).toBe(2);
    expect(s.err.join("\n")).toContain("secret");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("reports a healthy node, removes its probe, and reports an absent key", async () => {
    const s = sink();
    const code = await runCli(["status", "--rpc-url", "https://rpc.example.org", "--rpc-port", "5001"], deps(), s.io);
    const text = s.out.join("\n");
    expect(code).toBe(0);
    expect(text).toContain(`peer id   ${PEER_ID}`);
    expect(text).toContain("mfs /obsidian-vault-sync/default: 1 entry");
    expect(text).toContain("gateway fetch OK");
    expect(text).toContain("probe OK");
    expect(text).toContain("key obsidian-vault-sync: absent");
    expect(node.files.size).toBe(0);
    expect(node.requests).toContain("POST /api/v0/files/write");
    expect(node.requests.some((r) => r.includes("key/gen") || r.includes("key/rm") || r.includes("name/publish"))).toBe(false);
  });

  it("tolerates a default root that does not exist yet", async () => {
    node = fakeNode({ rootMissing: true });
    fetchStub.mockImplementation(node.handler);
    const s = sink();
    const code = await runCli(["status"], deps(), s.io);
    expect(code).toBe(0);
    expect(s.out.join("\n")).toContain("mfs /obsidian-vault-sync/default: absent");
    expect(node.files.size).toBe(0);
  });

  it("accepts the confinement base as an explicit root and still rejects the staging root", async () => {
    const accepted = sink();
    expect(await runCli(["status", "--mfs-root", "/obsidian-vault-sync"], deps(), accepted.io)).toBe(0);
    expect(accepted.out.join("\n")).toContain("mfs /obsidian-vault-sync: 1 entry");
    fetchStub.mockClear();
    const rejected = sink();
    expect(await runCli(["status", "--mfs-root", "/obsidian-vault-staging"], deps(), rejected.io)).toBe(2);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("classifies a name match without a recorded ID as foreign", async () => {
    node = fakeNode({ keys: [{ Name: "obsidian-vault", Id: "k51mine" }] });
    fetchStub.mockImplementation(node.handler);
    const s = sink();
    await runCli(["status", "--key", "obsidian-vault"], deps(), s.io);
    expect(s.out.join("\n")).toContain("key obsidian-vault: foreign id k51mine");
    const owned = sink();
    await runCli(["status", "--key", "obsidian-vault", "--owned-key", "k51mine"], deps(), owned.io);
    expect(owned.out.join("\n")).toContain("key obsidian-vault: owned id k51mine");
  });

  it("names the endpoint and stops on rejected credentials, with a nonzero exit", async () => {
    node = fakeNode({ authStatus: 401 });
    fetchStub.mockImplementation(node.handler);
    const s = sink();
    const code = await runCli(["status"], deps({ IPFS_SYNC_AUTH_SCHEME: "bearer", IPFS_SYNC_AUTH_TOKEN: "tok" }), s.io);
    const text = s.out.join("\n");
    expect(code).toBe(1);
    expect(text).toContain(`credentials rejected by the rpc endpoint ${TEST_RPC_URL} (HTTP 401)`);
    expect(text).not.toContain("tok");
    expect(node.requests.every((r) => !r.includes("files/write"))).toBe(true);
  });

  it("stops after the first check when the node is unreachable and sends nothing else", async () => {
    fetchStub.mockImplementation(async () => Promise.reject(new TypeError("fetch failed")));
    const s = sink();
    expect(await runCli(["status"], deps(), s.io)).toBe(1);
    expect(s.out.join("\n")).toContain("cannot reach the rpc endpoint");
    expect(fetchStub.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("--show-request prints method, URL and header names with credentials redacted", async () => {
    const schemes: Record<string, string>[] = [
      { IPFS_SYNC_AUTH_SCHEME: "basic", IPFS_SYNC_AUTH_USER: "u", IPFS_SYNC_AUTH_PASSWORD: "hunter2" },
      { IPFS_SYNC_AUTH_SCHEME: "bearer", IPFS_SYNC_AUTH_TOKEN: "hunter2" },
      { IPFS_SYNC_AUTH_SCHEME: "header", IPFS_SYNC_AUTH_HEADER_NAME: "X-Api-Key", IPFS_SYNC_AUTH_HEADER_VALUE: "hunter2" },
    ];
    const expected = ["authorization: <redacted>", "authorization: <redacted>", "x-api-key: <redacted>"];
    for (const [index, env] of schemes.entries()) {
      const s = sink();
      await runCli(["status", "--show-request"], deps(env), s.io);
      const text = s.out.join("\n");
      expect(text).toContain(`request POST ${TEST_RPC_URL}/api/v0/id`);
      expect(text).toContain(expected[index] ?? "");
      expect(text).not.toContain("hunter2");
    }
  });
});
