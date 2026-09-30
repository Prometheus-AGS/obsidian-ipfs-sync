import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseMultipart } from "../helpers/multipart";
import type { AuthConfig, ResolvedEndpoint } from "../../src/core/config";
import { ConfigError } from "../../src/core/config";
import {
  KuboAuthError,
  KuboHttpError,
  KuboNetworkError,
  MULTIPART_FIELD,
  createKuboClient,
  type KuboClient,
} from "../../src/kubo";

const PEER_ID = "QmSrPmbaUKA3ZodhzPWZnpFgcPMFWF4QsxXbkWfEptTBJd";
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";

interface Captured {
  readonly url: URL;
  readonly init: RequestInit;
}

function endpoint(name: "rpc" | "gateway", baseUrl: string, auth: AuthConfig = { kind: "none" }): ResolvedEndpoint {
  return { name, baseUrl, auth };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function headerValue(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe("shared kubo client", () => {
  let calls: Captured[];
  let respond: (url: URL) => Response | Promise<Response>;
  let client: KuboClient;
  const bearer: AuthConfig = { kind: "bearer", token: "tok" };

  beforeEach(() => {
    calls = [];
    respond = () => json({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        calls.push({ url, init });
        return respond(url);
      }),
    );
    client = createKuboClient({
      rpc: endpoint("rpc", "https://rpc.example.org:5001", bearer),
      gateway: endpoint("gateway", "https://gw.example.org:8080", { kind: "basic", user: "u", password: "p" }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends id with auth and no body", async () => {
    respond = () => json({ ID: PEER_ID, AgentVersion: "kubo/0.40.0", Addresses: [], Protocols: [] });
    const identity = await client.id();
    expect(identity).toEqual({ peerId: PEER_ID, agentVersion: "kubo/0.40.0" });
    expect(calls[0]?.url.origin).toBe("https://rpc.example.org:5001");
    expect(calls[0]?.url.pathname).toBe("/api/v0/id");
    expect(calls[0]?.init.body ?? undefined).toBeUndefined();
    expect(headerValue(calls[0]?.init ?? {}, "authorization")).toBe("Bearer tok");
  });

  it("reads the node version", async () => {
    respond = () => json({ Version: "0.40.0", Commit: "abc123", Repo: "18", System: "arm64/darwin", Golang: "go1" });
    expect(await client.version()).toEqual({ version: "0.40.0", commit: "abc123" });
  });

  it("puts the files/ls path in the query string and nothing in the body", async () => {
    respond = () =>
      new Response(`${JSON.stringify({ Entries: [{ Name: "a.md", Type: 0, Size: 5, Hash: CID }] })}\n`, { status: 200 });
    const entries = await client.filesLs("/obsidian-vault-sync/dir name");
    expect(entries).toEqual([{ name: "a.md", type: "file", size: 5, cid: CID }]);
    const call = calls[0];
    expect(call?.url.pathname).toBe("/api/v0/files/ls");
    expect(call?.url.searchParams.getAll("arg")).toEqual(["/obsidian-vault-sync/dir name"]);
    expect(call?.init.body ?? undefined).toBeUndefined();
  });

  it("puts the files/stat path in the query string", async () => {
    respond = () => json({ Hash: CID, Size: 5, CumulativeSize: 5, Blocks: 0, Type: "file" });
    const stat = await client.filesStat("/obsidian-vault-sync/.probe/p.txt");
    expect(stat).toEqual({ cid: CID, size: 5, cumulativeSize: 5, type: "file" });
    expect(calls[0]?.url.searchParams.get("arg")).toBe("/obsidian-vault-sync/.probe/p.txt");
    expect(calls[0]?.init.body ?? undefined).toBeUndefined();
  });

  it("puts files/rm args in the query string", async () => {
    respond = () => new Response("", { status: 200 });
    await client.filesRm("/obsidian-vault-sync/.probe/p.txt");
    expect(calls[0]?.url.pathname).toBe("/api/v0/files/rm");
    expect(calls[0]?.url.searchParams.get("arg")).toBe("/obsidian-vault-sync/.probe/p.txt");
    expect(calls[0]?.url.searchParams.get("recursive")).toBe("false");
    expect(calls[0]?.init.body ?? undefined).toBeUndefined();
  });

  it("refuses files/rm outside the project namespace before any request", async () => {
    for (const path of ["/obsidian-vault-staging/x", "/obsidian-vault-sync", "/obsidian-vault-sync/../x"]) {
      await expect(client.filesRm(path)).rejects.toBeInstanceOf(ConfigError);
    }
    expect(calls).toHaveLength(0);
  });

  it("lists keys read-only and keeps names and IDs", async () => {
    respond = () => json({ Keys: [{ Name: "self", Id: "k51self" }, { Name: "obsidian-vault", Id: "k51mine" }] });
    expect(await client.keyList()).toEqual([
      { name: "self", id: "k51self" },
      { name: "obsidian-vault", id: "k51mine" },
    ]);
    expect(calls[0]?.url.pathname).toBe("/api/v0/key/list");
  });

  it("maps 401 and 403 from a library call to a typed auth error naming the endpoint", async () => {
    for (const status of [401, 403]) {
      respond = () => new Response("<html>denied</html>", { status, headers: { "content-type": "text/html" } });
      const failure = await client.id().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(KuboAuthError);
      expect((failure as KuboAuthError).endpoint).toBe("rpc");
      expect((failure as KuboAuthError).message).toContain("https://rpc.example.org:5001");
      expect((failure as KuboAuthError).message).toContain(String(status));
      expect((failure as KuboAuthError).message).not.toContain("tok");
    }
  });

  it("maps other HTTP failures and network failures", async () => {
    respond = () => json({ Message: "file does not exist", Code: 0, Type: "error" }, 500);
    const httpFailure = await client.filesStat("/obsidian-vault-sync/none").catch((error: unknown) => error);
    expect(httpFailure).toBeInstanceOf(KuboHttpError);
    expect((httpFailure as KuboHttpError).status).toBe(500);
    expect((httpFailure as KuboHttpError).message).toContain("file does not exist");

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const netFailure = await client.id().catch((error: unknown) => error);
    expect(netFailure).toBeInstanceOf(KuboNetworkError);
  });

  describe("files/write", () => {
    it("sends multipart field `data` with every argument in the query string", async () => {
      respond = () => new Response("", { status: 200 });
      await client.filesWrite("/obsidian-vault-sync/.probe/p.txt", new TextEncoder().encode("hello"));
      const call = calls[0];
      expect(call?.init.method).toBe("POST");
      expect(call?.url.pathname).toBe("/api/v0/files/write");
      const query = call?.url.searchParams;
      expect(query?.get("arg")).toBe("/obsidian-vault-sync/.probe/p.txt");
      expect(query?.get("create")).toBe("true");
      expect(query?.get("parents")).toBe("true");
      expect(query?.get("truncate")).toBe("true");
      expect(query?.get("cid-version")).toBe("1");
      const form = await parseMultipart(call?.init ?? {});
      expect(MULTIPART_FIELD).toBe("data");
      expect([...form.keys()]).toEqual(["data"]);
      expect(form.has("file")).toBe(false);
      expect(await (form.get("data") as Blob).text()).toBe("hello");
      expect(headerValue(call?.init ?? {}, "content-type")).toMatch(/^multipart\/form-data; boundary=/);
      expect(headerValue(call?.init ?? {}, "authorization")).toBe("Bearer tok");
    });

    it("refuses paths outside the project namespace before any request", async () => {
      const bytes = new TextEncoder().encode("x");
      for (const path of ["/obsidian-vault-staging/x", "/obsidian-vault-sync", "/obsidian-vault-sync/../y", "relative"]) {
        await expect(client.filesWrite(path, bytes)).rejects.toBeInstanceOf(ConfigError);
      }
      expect(calls).toHaveLength(0);
    });

    it("raises the typed auth error on 401", async () => {
      respond = () => new Response("", { status: 401 });
      await expect(client.filesWrite("/obsidian-vault-sync/a", new TextEncoder().encode("x"))).rejects.toBeInstanceOf(
        KuboAuthError,
      );
    });
  });

  describe("gateway reads", () => {
    it("fetches /ipfs/<cid> with the gateway's own auth", async () => {
      respond = () => new Response("bytes", { status: 200 });
      const data = await client.gatewayFetch(CID);
      expect(new TextDecoder().decode(data)).toBe("bytes");
      expect(calls[0]?.url.href).toBe(`https://gw.example.org:8080/ipfs/${CID}`);
      expect(headerValue(calls[0]?.init ?? {}, "authorization")).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
    });

    it("appends an encoded path and refuses traversal and malformed CIDs", async () => {
      respond = () => new Response("x", { status: 200 });
      await client.gatewayFetch(CID, "dir/a b.md");
      expect(calls[0]?.url.pathname).toBe(`/ipfs/${CID}/dir/a%20b.md`);
      await expect(client.gatewayFetch(CID, "../x")).rejects.toThrowError(/must not contain/);
      await expect(client.gatewayFetch("../etc", "")).rejects.toThrowError(/not a valid CID/);
      expect(calls).toHaveLength(1);
    });

    it("raises the typed auth error naming the gateway endpoint", async () => {
      respond = () => new Response("", { status: 403 });
      const failure = await client.gatewayFetch(CID).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(KuboAuthError);
      expect((failure as KuboAuthError).endpoint).toBe("gateway");
    });
  });
});
