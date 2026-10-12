import { beforeAll, describe, expect, it } from "vitest";
import { isMutating, loadDecideRequest, MUTATING_COMMANDS, PULL_READ_COMMANDS, RPC_ALLOWLIST, STAGING_ROOT, type DecideRequest, type PolicyContext, type Verdict } from "../e2e/harness/policy";
import { DEAD_UPSTREAM, createProxy, runProxySelfCheck } from "../e2e/harness/proxy";
import { BASE_PATH, runRootFor, SUITE_KEY } from "../e2e/harness/run-context";
import { loadTools07a } from "../e2e/harness/tools-07a";

/**
 * Offline pinning of the e2e confinement policy (task 1.3, design decision 3): the full allow/refuse matrix of the
 * suite-bound decision function, plus the proxy's live behavior against a dead loopback upstream (127.0.0.1:9), so no
 * request here can reach a node. The run root is derived through run-context, never written by hand.
 */
const RUN_ID = "unittest-0001abcd";
const ROOT = runRootFor(RUN_ID);
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const OTHER_CID = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

const post = (command: string, params: Record<string, string> = {}): { method: string; pathname: string; params: URLSearchParams } => ({ method: "POST", pathname: `/api/v0/${command}`, params: new URLSearchParams(params) });
const gateway = (method: string, path: string): { method: string; pathname: string; params: URLSearchParams } => ({ method, pathname: path, params: new URLSearchParams() });

let decide: DecideRequest;
const known = (...cids: string[]): PolicyContext => ({ runRoot: ROOT, knownCids: new Set(cids) });

beforeAll(async () => {
  decide = await loadDecideRequest();
});

const allowed = (verdict: Verdict): void => {
  expect(verdict.allowed).toBe(true);
  expect(verdict.reason).toBe("");
};
const refused = (verdict: Verdict, reason: RegExp): void => {
  expect(verdict.allowed).toBe(false);
  expect(verdict.mutating).toBe(false);
  expect(verdict.reason).toMatch(reason);
};

describe("allowlist constants", () => {
  it("pins the RPC allowlist, the mutating set and the pull read set", () => {
    expect([...RPC_ALLOWLIST].sort()).toEqual(["files/ls", "files/mkdir", "files/rm", "files/stat", "files/write", "key/gen", "key/list", "ls", "name/publish", "name/resolve", "pin/add"].sort());
    expect([...MUTATING_COMMANDS].sort()).toEqual(["files/mkdir", "files/rm", "files/write", "key/gen", "name/publish", "pin/add"].sort());
    expect([...PULL_READ_COMMANDS].sort()).toEqual(["files/ls", "files/stat", "gateway", "key/list", "ls", "name/resolve"].sort());
    for (const command of MUTATING_COMMANDS) expect(isMutating(command)).toBe(true);
    expect(isMutating("files/stat")).toBe(false);
    expect(ROOT).toBe(`${BASE_PATH}/e2e-${RUN_ID}`);
    expect(SUITE_KEY).toBe("obsidian-vault-e2e");
  });
});

describe("allow matrix", () => {
  it("allows files/write, files/mkdir, files/rm, files/stat and files/ls at or below the run root", () => {
    for (const command of ["files/write", "files/mkdir", "files/rm", "files/stat", "files/ls"]) {
      allowed(decide(post(command, { arg: ROOT }), known()));
      allowed(decide(post(command, { arg: `${ROOT}/notes/a.md` }), known()));
    }
    expect(decide(post("files/write", { arg: `${ROOT}/notes/a.md` }), known()).mutating).toBe(true);
    expect(decide(post("files/rm", { arg: ROOT }), known()).mutating).toBe(true);
    expect(decide(post("files/stat", { arg: ROOT }), known()).mutating).toBe(false);
  });

  it("allows key/gen of obsidian-vault-e2e, key/list, name/resolve, ls and /ipfs/<cid> stat/ls", () => {
    const gen = decide(post("key/gen", { arg: SUITE_KEY }), known());
    allowed(gen);
    expect(gen.mutating).toBe(true);
    allowed(decide(post("key/list"), known()));
    allowed(decide(post("name/resolve", { arg: "k51qzi5uqu5dkwz3mvpv97rjqfpsx1bf6m9cjlhnzq0fy9yj5y9lzv8yk2abc1" }), known()));
    allowed(decide(post("name/resolve", { arg: "/ipns/k51qzi5uqu5dkwz3mvpv97rjqfpsx1bf6m9cjlhnzq0fy9yj5y9lzv8yk2abc1" }), known()));
    allowed(decide(post("ls", { arg: `/ipfs/${CID}` }), known()));
    allowed(decide(post("files/stat", { arg: `/ipfs/${CID}` }), known()));
    allowed(decide(post("files/ls", { arg: `/ipfs/${CID}/notes` }), known()));
  });

  it("allows name/publish with key=obsidian-vault-e2e of a CID the node reported under the run root", () => {
    const verdict = decide(post("name/publish", { arg: `/ipfs/${CID}`, key: SUITE_KEY }), known(CID));
    allowed(verdict);
    expect(verdict.mutating).toBe(true);
  });

  it("allows pin/add of a reported CID, as a bare CID or an /ipfs/<cid> path", () => {
    allowed(decide(post("pin/add", { arg: CID }), known(CID)));
    allowed(decide(post("pin/add", { arg: `/ipfs/${CID}` }), known(CID)));
    expect(decide(post("pin/add", { arg: CID }), known(CID)).mutating).toBe(true);
  });

  it("allows gateway GET and HEAD of /ipfs/<cid>[/path]", () => {
    for (const method of ["GET", "HEAD"]) {
      const verdict = decide(gateway(method, `/ipfs/${CID}`), known());
      allowed(verdict);
      expect(verdict.kind).toBe("gateway");
      expect(verdict.mutating).toBe(false);
      allowed(decide(gateway(method, `/ipfs/${CID}/notes/a.md`), known()));
    }
  });
});

describe("refuse matrix: forbidden commands", () => {
  it("refuses key/rm, key/rename, key/import and key/export, even of the suite key", () => {
    for (const command of ["key/rm", "key/rename", "key/import", "key/export"]) {
      refused(decide(post(command, { arg: SUITE_KEY }), known()), /not on the allowlist/);
    }
  });

  it("refuses pin/rm, files/mv and files/cp, even inside the run root", () => {
    refused(decide(post("pin/rm", { arg: CID }), known(CID)), /not on the allowlist/);
    refused(decide(post("files/mv", { arg: `${ROOT}/a`, "arg-2": `${ROOT}/b` }), known()), /not on the allowlist/);
    refused(decide(post("files/cp", { arg: `${ROOT}/a`, "arg-2": `${ROOT}/b` }), known()), /not on the allowlist/);
  });

  it("refuses any other command, and non-POST RPC or non-/api/v0 paths", () => {
    refused(decide(post("repo/gc"), known()), /not on the allowlist/);
    refused(decide(post("shutdown"), known()), /not on the allowlist/);
    refused(decide({ method: "GET", pathname: "/api/v0/key/list", params: new URLSearchParams() }, known()), /only POST/);
    refused(decide(gateway("POST", `/ipfs/${CID}`), known()), /GET or HEAD/);
    refused(decide(gateway("GET", `/ipfs/not a cid!`), known()), /GET or HEAD/);
    refused(decide(gateway("GET", `/ipfs/${CID}/../escape`), known()), /GET or HEAD/);
  });
});

describe("refuse matrix: paths outside the run root", () => {
  it("refuses mutations and reads outside the run root, including the base itself", () => {
    for (const command of ["files/write", "files/mkdir", "files/rm", "files/stat", "files/ls"]) {
      refused(decide(post(command, { arg: `${BASE_PATH}/other-project/x` }), known()), /run root/);
    }
    refused(decide(post("files/ls", { arg: BASE_PATH }), known()), /run root/);
    refused(decide(post("files/rm", { arg: BASE_PATH }), known()), /run root/);
    refused(decide(post("files/stat", { arg: "/" }), known()), /run root/);
  });

  it("refuses a sibling e2e-<other> root, at and below it", () => {
    const sibling = `${BASE_PATH}/e2e-staletest00`;
    refused(decide(post("files/rm", { arg: sibling }), known()), /run root/);
    refused(decide(post("files/rm", { arg: `${sibling}/x` }), known()), /run root/);
    refused(decide(post("files/write", { arg: `${sibling}/x` }), known()), /run root/);
    refused(decide(post("files/ls", { arg: sibling }), known()), /run root/);
  });

  it("refuses escapes, backslashes, control characters and relative paths", () => {
    refused(decide(post("files/write", { arg: `${ROOT}/../escape` }), known()), /run root/);
    refused(decide(post("files/write", { arg: `${ROOT}/./x/../../escape` }), known()), /run root/);
    refused(decide(post("files/write", { arg: `${ROOT}\\x` }), known()), /run root/);
    refused(decide(post("files/write", { arg: `${ROOT}/\u0007x` }), known()), /run root/);
    refused(decide(post("files/write", { arg: "relative/path" }), known()), /run root/);
    refused(decide(post("files/write", { arg: "" }), known()), /run root/);
    refused(decide(post("files/write"), known()), /run root/);
  });
});

describe("refuse matrix: staging root and foreign keys", () => {
  it("refuses anything naming /obsidian-vault-staging, in any parameter of any command", () => {
    expect(STAGING_ROOT).toBe("/obsidian-vault-staging");
    refused(decide(post("files/write", { arg: `${STAGING_ROOT}/x` }), known()), /never touched/);
    refused(decide(post("files/stat", { arg: STAGING_ROOT }), known()), /never touched/);
    refused(decide(post("files/ls", { arg: `${STAGING_ROOT}/` }), known()), /never touched/);
    refused(decide(post("key/gen", { arg: SUITE_KEY, note: `see ${STAGING_ROOT}` }), known()), /never touched/);
    refused(decide(post("pin/rm", { arg: `${STAGING_ROOT}/x` }), known()), /never touched/);
  });

  it("refuses key/gen of any other key name, including obsidian-vault-sync", () => {
    refused(decide(post("key/gen", { arg: "obsidian-vault-sync" }), known()), new RegExp(`limited to the key ${SUITE_KEY}`));
    refused(decide(post("key/gen", { arg: "obsidian-vault" }), known()), /limited to the key/);
    refused(decide(post("key/gen"), known()), /limited to the key/);
  });

  it("refuses name/publish with a foreign key, a CID the node never reported, or no single key", () => {
    refused(decide(post("name/publish", { arg: `/ipfs/${CID}`, key: "obsidian-vault-sync" }), known(CID)), new RegExp(`key=${SUITE_KEY}`));
    refused(decide(post("name/publish", { arg: `/ipfs/${CID}` }), known(CID)), new RegExp(`key=${SUITE_KEY}`));
    refused(decide(post("name/publish", { arg: `/ipfs/${CID}`, key: SUITE_KEY }), known(OTHER_CID)), /reported under the run root/);
    refused(decide(post("name/publish", { arg: CID, key: SUITE_KEY }), known(CID)), /key=/);
    const twoKeys = new URLSearchParams();
    twoKeys.append("arg", `/ipfs/${CID}`);
    twoKeys.append("key", SUITE_KEY);
    twoKeys.append("key", SUITE_KEY);
    refused(decide({ method: "POST", pathname: "/api/v0/name/publish", params: twoKeys }, known(CID)), /key=/);
    const foreignValue = decide(post("name/publish", { arg: `/ipfs/${CID}`, key: `${SUITE_KEY}&key=${SUITE_KEY}` }), known(CID));
    refused(foreignValue, /key=/);
  });

  it("refuses pin/add of a CID the node never reported under the run root", () => {
    refused(decide(post("pin/add", { arg: OTHER_CID }), known(CID)), /reported under the run root/);
    refused(decide(post("pin/add", { arg: `/ipfs/${OTHER_CID}` }), known(CID)), /reported under the run root/);
    refused(decide(post("pin/add", { arg: "not-a-cid" }), known(CID)), /reported under the run root/);
  });

  it("refuses malformed read arguments", () => {
    refused(decide(post("key/list", { arg: ROOT }), known()), /takes no path/);
    refused(decide(post("ls", { arg: ROOT }), known()), /ls needs/);
    refused(decide(post("name/resolve", { arg: "not a key id!" }), known()), /needs exactly one key ID/);
    refused(decide(post("name/resolve"), known()), /needs exactly one key ID/);
  });
});

describe("needle scanning helpers (07a, via the loader)", () => {
  it("finds a needle across chunk boundaries and in a URL string", async () => {
    const tools = await loadTools07a();
    const needles = [{ label: 'path "notes/secret.md"', bytes: Buffer.from("notes/secret.md", "utf8") }];
    expect(tools.findNeedle(Buffer.from("/api/v0/files/write\narg=...notes/secret.md..."), needles)).toBe('path "notes/secret.md"');
    expect(tools.findNeedle(Buffer.from("nothing here"), needles)).toBeUndefined();
    const scanner = tools.createNeedleScanner(needles);
    expect(scanner.push(Buffer.from("chunk one notes/sec"))).toBeUndefined();
    expect(scanner.push(Buffer.from("ret.md chunk two"))).toBe('path "notes/secret.md"');
  });
});

describe("proxy against a dead loopback upstream", () => {
  it("the dead upstream is the discard port on loopback, never a node", () => {
    expect(DEAD_UPSTREAM.rpc).toBe("http://127.0.0.1:9");
    expect(DEAD_UPSTREAM.gateway).toBe("http://127.0.0.1:9");
  });

  it("self-test: every out-of-policy request is refused, none is forwarded, the in-policy control reaches only the dead upstream", async () => {
    const result = await runProxySelfCheck(ROOT);
    expect(result.upstream).toBe("http://127.0.0.1:9");
    expect(result.total).toBe(10);
    expect(result.refused).toBe(result.total);
    expect(result.forwardedByPolicy).toBe(0);
    expect(result.controlStatus).toBe(502);
  });

  it("refusals answer 403 and land in the violation list; allowed requests forward (502 from the dead upstream) and land only in the log", async () => {
    const proxy = await createProxy({ upstream: DEAD_UPSTREAM, runRoot: ROOT });
    const url = await proxy.start();
    try {
      const refusedResponse = await fetch(`${url}/api/v0/pin/rm?${new URLSearchParams({ arg: CID })}`, { method: "POST" });
      expect(refusedResponse.status).toBe(403);
      const body = (await refusedResponse.json()) as { Message?: string };
      expect(body.Message).toMatch(/blocked by the ipfs-sync e2e suite/);
      expect(proxy.violations).toHaveLength(1);
      expect(proxy.violations[0]?.command).toBe("pin/rm");
      expect(proxy.violations[0]?.allowed).toBe(false);

      const forwardedResponse = await fetch(`${url}/api/v0/files/write?${new URLSearchParams({ arg: `${ROOT}/notes/a.md`, create: "true" })}`, { method: "POST" });
      expect(forwardedResponse.status).toBe(502);
      const entry = proxy.log.find((item) => item.command === "files/write");
      expect(entry?.allowed).toBe(true);
      expect(entry?.mutating).toBe(true);
      expect(entry?.arg).toBe(`${ROOT}/notes/a.md`);
      expect(proxy.violations).toHaveLength(1);

      const slice = proxy.since(proxy.mark() - 2);
      expect(slice.map((item) => item.command)).toEqual(["pin/rm", "files/write"]);
      proxy.resetLog();
      expect(proxy.log).toHaveLength(0);
      expect(proxy.violations).toHaveLength(0);
    } finally {
      await proxy.stop();
    }
  });

  it("flags a plaintext needle in the request URL and in the request body, and learns CIDs only from run-root stat/ls answers", async () => {
    const proxy = await createProxy({ upstream: DEAD_UPSTREAM, runRoot: ROOT });
    const url = await proxy.start();
    proxy.setNeedles([{ label: 'path "notes/secret.md"', bytes: Buffer.from("notes/secret.md", "utf8") }]);
    try {
      await fetch(`${url}/api/v0/files/write?${new URLSearchParams({ arg: `${ROOT}/notes/secret.md` })}`, { method: "POST" });
      const inUrl = proxy.log.find((item) => item.command === "files/write");
      expect(inUrl?.needle).toBe('path "notes/secret.md"');

      const before = proxy.mark();
      await fetch(`${url}/api/v0/files/stat?${new URLSearchParams({ arg: `${ROOT}/notes` })}`, { method: "POST", body: Buffer.from("prefix notes/secret.md suffix") });
      const inBody = proxy.since(before).find((item) => item.command === "files/stat");
      expect(inBody?.allowed).toBe(true);
      expect(inBody?.needle).toBe('path "notes/secret.md"');
      // The dead upstream never answers, so nothing is learned; CID learning is exercised against the live node in the e2e run.
      expect(proxy.knownCids.size).toBe(0);
    } finally {
      await proxy.stop();
    }
  });

  it("a malformed request target is refused before the policy decides", async () => {
    const proxy = await createProxy({ upstream: DEAD_UPSTREAM, runRoot: ROOT });
    const url = await proxy.start();
    try {
      const response = await fetch(`${url}//api/v0/key/list`, { method: "POST" });
      expect(response.status).toBe(403);
      expect(proxy.violations[0]?.command).toBe("malformed-url");
      expect(proxy.violations[0]?.reason).toMatch(/backslash|request path/);
    } finally {
      await proxy.stop();
    }
  });
});
