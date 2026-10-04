import { mkdtempSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Pure helpers of tools/feature-op-mvp-07a.mjs: the proxy policy (the mvp-06 allowlist with the mvp07a-demo prefix), the pull read
 * set, the argument rules, the cleanup confinement, the output parsers and the redaction. Nothing here starts a process, opens a
 * socket or talks to a node. The one exception is the proxy self-test: it starts a loopback proxy whose upstream is the dead address
 * 127.0.0.1:9, so no request can reach any node.
 */
interface Verdict {
  readonly allowed: boolean;
  readonly command: string;
  readonly kind: string;
  readonly mutating: boolean;
  readonly reason: string;
}
interface Needle {
  readonly label: string;
  readonly bytes: Buffer;
}
interface TraceEntry {
  readonly command: string;
  readonly mutating: boolean;
  readonly allowed: boolean;
  readonly arg?: string;
}
interface Options {
  readonly acceptUnresolvedPointer?: boolean;
  readonly out: string;
  readonly tamper?: string;
  readonly cleanup?: string;
  readonly cli?: string;
  readonly localStub: boolean;
  readonly dryRun: boolean;
  readonly allowStaleBuild: boolean;
}
interface Helpers {
  readonly KEY: string;
  readonly BASE: string;
  readonly DEMO_PARENT: string;
  readonly TAMPER_KINDS: readonly string[];
  readonly RPC_ALLOWLIST: readonly string[];
  readonly MUTATING_COMMANDS: ReadonlySet<string>;
  readonly PULL_READ_COMMANDS: readonly string[];
  isValidRunId(id: unknown): boolean;
  demoRootFor(id: string): string;
  cleanupTarget(id: string): string;
  normalizeMfsPath(path: string): string | undefined;
  isWithin(path: string, root: string, options?: { allowEqual?: boolean }): boolean;
  isLoopbackUrl(url: string): boolean;
  isAllowedUpstream(url: string, localStub: boolean): boolean;
  decideRequest(request: { method: string; pathname: string; params: URLSearchParams }, context: { demoRoot: string; knownCids: Set<string> }): Verdict;
  pullTraceProblems(trace: readonly TraceEntry[]): string[];
  findNeedle(haystack: Uint8Array, needles: readonly Needle[]): string | undefined;
  createNeedleScanner(needles: readonly Needle[]): { push(chunk: Buffer): string | undefined };
  plaintextNeedles(files: readonly { path: string; text?: string }[]): Needle[];
  parsePublishOutput(text: string): { written?: number; removed?: number; sequence?: number; rootCid?: string };
  parsePullOutput(text: string): { fetched?: number; unchanged?: number; conflicts?: number; integrityFailed?: number; unfetched?: number; skipped?: number; remoteDeleted?: number; locallyModified?: number; sequence?: number; rootCid?: string; conflictPairs: { path: string; copy: string }[] };
  parseInitOutput(text: string): { vaultId?: string };
  childEnv(base: Record<string, string | undefined>, extra: Record<string, string>, options?: { localStub?: boolean }): Record<string, string>;
  redact(text: string, secrets: readonly string[]): string;
  vetRequestUrl(raw: unknown): { ok: boolean; reason: string; url?: URL; forwardPath?: string };
  formatPointerLine(keyId: string | undefined, pointer: string | null): string;
  staleBuildRefusal(opts: { allowStaleBuild: boolean; localStub: boolean; dryRun: boolean }): string | undefined;
  scrubbedDetail(result: { stdout?: string; stderr?: string }, secrets: readonly string[]): string;
  parseArguments(argv: readonly string[]): Options;
  readonly DEAD_UPSTREAM: { readonly rpc: string; readonly gateway: string };
  readonly SIGNAL_EXIT_CODES: Readonly<Record<string, number>>;
  isNeverPublishedError(error: unknown): boolean;
  resolvePreviousPointer(resolve: () => Promise<string>, options: { strict: boolean; acceptUnresolved?: boolean; attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<string>;
  formatPostRunLine(keyId: string | undefined, pointer: string | null): string;
  restoreInstruction(preRun: { keyId: string | null; previousPointer: string | null; pointerUnknown?: boolean }): string;
  bestEffortPostRun(record: () => Promise<unknown>, options: { timeoutMs: number }): Promise<{ ok: boolean; reason?: string }>;
  readonly SIGNAL_POST_RUN_TIMEOUT_MS: number;
  win32Refusal(platform: string): string | undefined;
  withPassphraseSpellings(known: readonly string[], fileText: string): string[];
  mutationLogProblems(log: readonly Record<string, unknown>[], demoRoot: string): string[];
  realpathLoose(path: string): string;
  isOutsideRepo(path: string): boolean;
}
interface SelfTestResult {
  readonly upstream: string;
  readonly total: number;
  readonly refused: number;
  readonly forwardedByPolicy: number;
  readonly controlStatus: number;
}

const SCRIPT = resolve(__dirname, "..", "..", "tools", "feature-op-mvp-07a.mjs");
let h: Helpers;

beforeAll(async () => {
  h = (await import(/* @vite-ignore */ pathToFileURL(SCRIPT).href)) as Helpers;
});

const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const NAME = "k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8";
const RUN = "mvp7atest-0123abcd";
const ROOT = `/obsidian-vault-sync/mvp07a-demo/${RUN}`;
const params = (init: Record<string, string | string[]>): URLSearchParams => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(init)) for (const each of Array.isArray(value) ? value : [value]) search.append(name, each);
  return search;
};
const rpc = (command: string, init: Record<string, string | string[]>, known: string[] = []): Verdict =>
  h.decideRequest({ method: "POST", pathname: `/api/v0/${command}`, params: params(init) }, { demoRoot: h.demoRootFor(RUN), knownCids: new Set(known) });
const gateway = (method: string, pathname: string): Verdict => h.decideRequest({ method, pathname, params: params({}) }, { demoRoot: ROOT, knownCids: new Set() });

describe("run identifiers and demo root", () => {
  it("accepts only ^[a-z0-9-]{8,}$", () => {
    expect(h.isValidRunId("abcd1234")).toBe(true);
    expect(h.isValidRunId("mfvx0k1a-0badf00d")).toBe(true);
    for (const bad of ["short", "ABCDEFGH", "abcd 1234", "abcd/1234", "../../etc", "abcd1234\n", "", undefined, 12345678]) expect(h.isValidRunId(bad)).toBe(false);
  });

  it("builds the demo root only from a valid identifier, under mvp07a-demo and never under mvp06-demo", () => {
    expect(h.demoRootFor(RUN)).toBe(ROOT);
    expect(h.DEMO_PARENT).toBe("/obsidian-vault-sync/mvp07a-demo");
    expect(h.KEY).toBe("obsidian-vault-sync");
    expect(() => h.demoRootFor("../x")).toThrow(/does not match/);
    expect(h.isWithin(`/obsidian-vault-sync/mvp06-demo/${RUN}/x`, ROOT)).toBe(false);
  });
});

describe("path confinement", () => {
  it("refuses dot segments, backslashes, control characters and relative paths instead of resolving them", () => {
    for (const bad of [`${ROOT}/../x`, `${ROOT}/./x`, "relative/path", `${ROOT}\\x`, `${ROOT}/x\u0000`]) expect(h.normalizeMfsPath(bad)).toBeUndefined();
    expect(h.normalizeMfsPath(`${ROOT}//a///b/`)).toBe(`${ROOT}/a/b`);
  });

  it("treats a sibling with the same prefix as outside", () => {
    expect(h.isWithin(`${ROOT}/manifest.enc`, ROOT)).toBe(true);
    expect(h.isWithin(ROOT, ROOT)).toBe(false);
    expect(h.isWithin(ROOT, ROOT, { allowEqual: true })).toBe(true);
    expect(h.isWithin(`${ROOT}-other/x`, ROOT)).toBe(false);
    expect(h.isWithin("/obsidian-vault-sync/mvp07a-demo/other/x", ROOT)).toBe(false);
    expect(h.isWithin("/obsidian-vault-staging/x", ROOT)).toBe(false);
  });

  it("only the shared node's host, or loopback with --local-stub, is an upstream; children only ever get loopback", () => {
    expect(h.isAllowedUpstream("https://ipfs.prometheusags.ai", false)).toBe(true);
    expect(h.isAllowedUpstream("https://ipfs.prometheusags.ai.evil.example", false)).toBe(false);
    // L-06: the Authorization header must never travel in cleartext to the shared host.
    expect(h.isAllowedUpstream("http://ipfs.prometheusags.ai", false)).toBe(false);
    expect(h.isAllowedUpstream("http://ipfs.prometheusags.ai", true)).toBe(false);
    expect(h.isAllowedUpstream("ftp://ipfs.prometheusags.ai", false)).toBe(false);
    expect(h.isAllowedUpstream("http://127.0.0.1:5001", false)).toBe(false);
    expect(h.isAllowedUpstream("http://127.0.0.1:5001", true)).toBe(true);
    expect(h.isLoopbackUrl("http://127.0.0.1:1234")).toBe(true);
    expect(h.isLoopbackUrl("https://127.0.0.1:1234")).toBe(false);
    expect(h.isLoopbackUrl("http://10.0.0.1:1234")).toBe(false);
  });
});

describe("proxy policy (decideRequest): the mvp-06 allowlist with the mvp07a-demo prefix", () => {
  it("forwards the reads and writes the CLI needs, below the demo root", () => {
    expect(rpc("files/write", { arg: `${ROOT}/current/ab/${"a".repeat(52)}`, create: "true" })).toMatchObject({ allowed: true, mutating: true });
    expect(rpc("files/write", { arg: `${ROOT}/manifest.enc` }).allowed).toBe(true);
    expect(rpc("files/rm", { arg: `${ROOT}/current/ab/${"a".repeat(52)}`, recursive: "false" }).allowed).toBe(true);
    expect(rpc("files/mkdir", { arg: ROOT, parents: "true" })).toMatchObject({ allowed: true, mutating: true });
    expect(rpc("files/stat", { arg: ROOT })).toMatchObject({ allowed: true, mutating: false });
    expect(rpc("files/ls", { arg: `${ROOT}/manifests` }).allowed).toBe(true);
    expect(rpc("files/stat", { arg: `/ipfs/${CID}/current` }).allowed).toBe(true);
    expect(rpc("ls", { arg: `/ipfs/${CID}/manifests` }).allowed).toBe(true);
    expect(rpc("key/list", {}).allowed).toBe(true);
    expect(rpc("name/resolve", { arg: `/ipns/${NAME}`, nocache: "true" }).allowed).toBe(true);
    expect(rpc("key/gen", { arg: h.KEY, type: "ed25519" })).toMatchObject({ allowed: true, mutating: true });
  });

  it("refuses key/rm, key/rename, pin/rm, files/mv and every command not on the list", () => {
    for (const command of ["key/rm", "key/rename", "key/rotate", "key/import", "key/export", "pin/rm", "pin/update", "files/mv", "files/cp", "files/chcid", "repo/gc", "add", "config", "swarm/connect", "id"]) {
      expect(rpc(command, { arg: `${ROOT}/x` })).toMatchObject({ allowed: false, reason: "command is not on the allowlist" });
    }
    expect(h.RPC_ALLOWLIST).not.toContain("key/rm");
    expect(h.RPC_ALLOWLIST).not.toContain("pin/rm");
    expect(h.RPC_ALLOWLIST).not.toContain("files/mv");
  });

  it("refuses mutations outside the demo root, on the root itself, by dot segments, on other projects, on mvp06-demo and on the staging root", () => {
    for (const arg of ["/obsidian-vault-sync/other-project/x", "/obsidian-vault-sync/mvp07a-demo/other-run/x", `/obsidian-vault-sync/mvp06-demo/${RUN}/x`, `${ROOT}/../escape`, `${ROOT}-other/x`, "/obsidian-vault-staging/x", "/", ROOT]) {
      expect(rpc("files/write", { arg }).allowed).toBe(false);
      expect(rpc("files/rm", { arg }).allowed).toBe(false);
    }
    expect(rpc("files/ls", { arg: "/obsidian-vault-sync" }).allowed).toBe(false);
    expect(rpc("files/ls", { arg: "/obsidian-vault-sync/mvp07a-demo" }).allowed).toBe(false);
    expect(rpc("files/stat", { arg: "/obsidian-vault-staging" }).reason).toMatch(/never touched/);
    expect(rpc("files/write", { arg: [`${ROOT}/a`, `${ROOT}/b`] }).allowed).toBe(false);
    expect(rpc("files/write", {}).allowed).toBe(false);
  });

  it("names nothing on the staging root in any parameter", () => {
    expect(rpc("name/resolve", { arg: NAME, note: "/obsidian-vault-staging" }).allowed).toBe(false);
    expect(rpc("files/stat", { arg: ROOT, other: "x/obsidian-vault-staging/y" }).allowed).toBe(false);
  });

  it("key/gen and name/publish only for the owned key; foreign key names are refused", () => {
    for (const key of ["obsidian-vault", "consult-capture", "gomark-relay-lab", "prince-live", "self", "obsidian-vault-sync-2", ""]) {
      expect(rpc("key/gen", { arg: key }).allowed).toBe(false);
      expect(rpc("name/publish", { arg: `/ipfs/${CID}`, key, ttl: "5m" }, [CID]).allowed).toBe(false);
    }
    expect(rpc("name/publish", { arg: `/ipfs/${CID}`, key: h.KEY, ttl: "5m" }, [CID]).allowed).toBe(true);
    expect(rpc("name/publish", { arg: `/ipfs/${CID}`, key: [h.KEY, "obsidian-vault"] }, [CID]).allowed).toBe(false);
  });

  it("pin/add and name/publish only for a CID the node reported for the demo root", () => {
    expect(rpc("pin/add", { arg: CID, recursive: "true" }, [CID])).toMatchObject({ allowed: true, mutating: true });
    expect(rpc("pin/add", { arg: `/ipfs/${CID}` }, [CID]).allowed).toBe(true);
    expect(rpc("pin/add", { arg: CID }, []).allowed).toBe(false);
    expect(rpc("pin/add", { arg: "bafkreifoo1234567890" }, [CID]).allowed).toBe(false);
    expect(rpc("name/publish", { arg: `/ipfs/${CID}`, key: h.KEY }, []).allowed).toBe(false);
  });

  it("gateway access is GET or HEAD of /ipfs/<cid>[/path] with no dot segments, nothing else", () => {
    expect(gateway("GET", `/ipfs/${CID}/ab/${"a".repeat(52)}`)).toMatchObject({ allowed: true, kind: "gateway", mutating: false });
    expect(gateway("HEAD", `/ipfs/${CID}`).allowed).toBe(true);
    expect(gateway("POST", `/ipfs/${CID}`).allowed).toBe(false);
    expect(gateway("GET", `/ipfs/${CID}/../x`).allowed).toBe(false);
    expect(gateway("GET", `/ipfs/${CID}/%2e%2e/x`).allowed).toBe(false);
    expect(gateway("GET", `/ipfs/${CID}/a%2Fb`).allowed).toBe(false);
    expect(gateway("GET", "/ipfs/short").allowed).toBe(false);
    expect(gateway("GET", "/ipns/k51abc").allowed).toBe(false);
    expect(h.decideRequest({ method: "GET", pathname: "/api/v0/key/list", params: params({}) }, { demoRoot: "/x", knownCids: new Set() }).allowed).toBe(false);
  });

  it("pins the reads pull sends (task notes list): each is allowed, read-only and adds no command to the mvp-06 allowlist", () => {
    const reads: Verdict[] = [
      rpc("key/list", {}),
      rpc("name/resolve", { arg: `/ipns/${NAME}`, nocache: "true" }),
      rpc("name/resolve", { arg: NAME, nocache: "true", "dht-timeout": "10s" }),
      rpc("ls", { arg: `/ipfs/${CID}`, resolve: "false" }),
      rpc("ls", { arg: `/ipfs/${CID}/manifests` }),
      rpc("ls", { arg: `/ipfs/${CID}/ab` }),
      rpc("files/stat", { arg: ROOT }),
      rpc("files/ls", { arg: `${ROOT}/manifests` }),
      gateway("GET", `/ipfs/${CID}/keyslots.json`),
      gateway("GET", `/ipfs/${CID}/manifest.enc`),
      gateway("GET", `/ipfs/${CID}/manifests/0000000000000002-${CID}.enc`),
      gateway("GET", `/ipfs/${CID}/ab/${"a".repeat(52)}`),
      gateway("HEAD", `/ipfs/${CID}/manifest.enc`),
    ];
    for (const verdict of reads) expect(verdict).toMatchObject({ allowed: true, mutating: false });
    expect(h.PULL_READ_COMMANDS).toEqual(["key/list", "name/resolve", "ls", "files/stat", "files/ls", "gateway"]);
    for (const command of h.PULL_READ_COMMANDS) expect(command === "gateway" || h.RPC_ALLOWLIST.includes(command)).toBe(true);
    for (const command of h.PULL_READ_COMMANDS) expect(h.MUTATING_COMMANDS.has(command)).toBe(false);
    expect([...h.MUTATING_COMMANDS].sort()).toEqual(["files/mkdir", "files/rm", "files/write", "key/gen", "name/publish", "pin/add"]);
  });
});

describe("pull trace audit (pullTraceProblems)", () => {
  const read = (command: string): TraceEntry => ({ command, mutating: false, allowed: true });

  it("accepts a trace of reads only", () => {
    expect(h.pullTraceProblems([read("key/list"), read("name/resolve"), read("ls"), read("gateway"), read("files/stat"), read("files/ls")])).toEqual([]);
    expect(h.pullTraceProblems([])).toEqual([]);
  });

  it("reports a mutating request, a refused request and a read command outside the pull read set", () => {
    expect(h.pullTraceProblems([read("key/list"), { command: "files/write", mutating: true, allowed: true, arg: `${ROOT}/x` }]).join("\n")).toMatch(/files\/write/);
    expect(h.pullTraceProblems([{ command: "pin/rm", mutating: false, allowed: false }]).join("\n")).toMatch(/pin\/rm/);
    expect(h.pullTraceProblems([read("key/rm")]).join("\n")).toMatch(/key\/rm/);
    expect(h.pullTraceProblems([read("key/gen")]).join("\n")).toMatch(/key\/gen/);
  });
});

describe("needles and scanners", () => {
  it("finds a needle in bytes and across chunk boundaries of a stream", () => {
    const needles: Needle[] = [{ label: "title", bytes: Buffer.from("Welcome home") }];
    expect(h.findNeedle(Buffer.from("xx Welcome home yy"), needles)).toBe("title");
    expect(h.findNeedle(Buffer.from("nothing here"), needles)).toBeUndefined();
    const scanner = h.createNeedleScanner(needles);
    expect(scanner.push(Buffer.from("aaaa Welc"))).toBeUndefined();
    expect(scanner.push(Buffer.from("ome ho"))).toBeUndefined();
    expect(scanner.push(Buffer.from("me zzz"))).toBe("title");
    expect(scanner.push(Buffer.from("later"))).toBe("title");
  });

  it("lists titles, paths, path segments, file stems and body words as needles", () => {
    const labels = h.plaintextNeedles([{ path: "notes/welcome.md", text: "# Welcome\n\nharbor lantern.\n" }, { path: "a/b.md", text: "# Hi\n" }]).map((needle) => needle.label);
    expect(labels).toContain('path "notes/welcome.md"');
    expect(labels).toContain('title "Welcome"');
    expect(labels).toContain('path segment "notes"');
    expect(labels).toContain('file stem "welcome"');
    expect(labels).toContain('body word "harbor"');
    expect(labels.some((label) => label.includes('"Hi"'))).toBe(false);
  });
});

describe("command output parsers", () => {
  it("parses the publish summary, the sequence and the root CID", () => {
    expect(h.parsePublishOutput("ipfs-sync publish\nroot CID   bafyroot123456\nsnapshot  bafycur\nsequence  2\n1 written, 0 removed\n")).toEqual({ written: 1, removed: 0, sequence: 2, rootCid: "bafyroot123456" });
    expect(h.parsePublishOutput("nothing changed")).toEqual({ written: undefined, removed: undefined, sequence: undefined, rootCid: undefined });
  });

  it("parses the pull summary line, the sequence, the root CID and the conflict pairs", () => {
    const text = [
      "ipfs-sync pull",
      "  conflict projects/alpha/tasks.md -> projects/alpha/tasks (ipfs conflict 2026-10-02).md",
      "  locally modified notes/daily/2026-01-02.md (left as is)",
      "root CID   bafyroot123456  (IPNS value)",
      "snapshot  bafycur  (manifest rootCID)",
      "sequence  2",
      "3 fetched, 7 unchanged, 1 conflicts, 0 integrity-failed, 0 unfetched, 2 skipped, 1 remote-deleted, 1 locally modified",
    ].join("\n");
    expect(h.parsePullOutput(text)).toEqual({
      fetched: 3,
      unchanged: 7,
      conflicts: 1,
      integrityFailed: 0,
      unfetched: 0,
      skipped: 2,
      remoteDeleted: 1,
      locallyModified: 1,
      sequence: 2,
      rootCid: "bafyroot123456",
      conflictPairs: [{ path: "projects/alpha/tasks.md", copy: "projects/alpha/tasks (ipfs conflict 2026-10-02).md" }],
    });
    expect(h.parsePullOutput("ipfs-sync: pull stopped: nope")).toMatchObject({ fetched: undefined, sequence: undefined, conflictPairs: [] });
  });

  it("parses the vault id init prints", () => {
    expect(h.parseInitOutput("ipfs-sync init\nvault created    0123456789abcdef0123456789abcdef\nkey slots        /x/keyslots.json\n")).toEqual({ vaultId: "0123456789abcdef0123456789abcdef" });
    expect(h.parseInitOutput("vault created    NOTHEX")).toEqual({ vaultId: undefined });
  });
});

describe("environment, redaction, arguments", () => {
  const dirty = {
    PATH: "/bin",
    HOME: "/home/x",
    TMPDIR: "/tmp",
    LANG: "en_US.UTF-8",
    NODE_OPTIONS: "--require /evil.js",
    NODE_PATH: "/evil",
    HTTPS_PROXY: "http://proxy.example",
    http_proxy: "http://proxy.example",
    NODE_EXTRA_CA_CERTS: "/evil.pem",
    IPFS_SYNC_RPC_URL: "https://elsewhere",
    IPFS_SYNC_MFS_ROOT: "/x",
    IPFS_SYNC_PASSPHRASE: "secret",
    IPFS_SYNC_PASSPHRASE_FILE: "/f",
    IPFS_SYNC_KEY: "k",
    IPFS_SYNC_AUTH_TOKEN: "t",
    IPFS_SYNC_RPC_AUTH_USER: "u",
    SSH_AUTH_SOCK: "/sock",
  };

  it("passes an allowlist of environment names, drops NODE_OPTIONS, NODE_PATH, proxy variables and IPFS_SYNC_* except auth, and adds the extras last (L-02)", () => {
    const env = h.childEnv({ ...dirty, EMPTY: undefined }, { IPFS_SYNC_DEVICE: "d", XDG_STATE_HOME: "/tmp/state" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/x", TMPDIR: "/tmp", LANG: "en_US.UTF-8", IPFS_SYNC_AUTH_TOKEN: "t", IPFS_SYNC_RPC_AUTH_USER: "u", IPFS_SYNC_DEVICE: "d", XDG_STATE_HOME: "/tmp/state" });
  });

  it("drops the auth variables as well with the local stub (L-02), also for a --cli binary", () => {
    const env = h.childEnv(dirty, { IPFS_SYNC_DEVICE: "d" }, { localStub: true });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/x", TMPDIR: "/tmp", LANG: "en_US.UTF-8", IPFS_SYNC_DEVICE: "d" });
  });

  it("an extra cannot be overridden by the base environment", () => {
    expect(h.childEnv({ PATH: "/bin", HOME: "/a" }, { HOME: "/b" })).toEqual({ PATH: "/bin", HOME: "/b" });
  });

  it("redacts every spelling of a secret and ignores empty secrets", () => {
    expect(h.redact("a ABCDE-FGHIJ b ABCDEFGHIJ c", ["ABCDE-FGHIJ", "ABCDEFGHIJ", ""])).toBe("a [redacted] b [redacted] c");
  });

  it("refuses --tamper without --local-stub, a bad --cleanup identifier, an unknown option, and a result path inside the repository", () => {
    expect(() => h.parseArguments(["--tamper", "pull-writes"])).toThrow(/--local-stub/);
    expect(() => h.parseArguments(["--local-stub", "--tamper", "nope"])).toThrow(/must be one of/);
    expect(() => h.parseArguments(["--cleanup", "../../x"])).toThrow(/run identifier/);
    expect(() => h.parseArguments(["--cleanup", "short"])).toThrow(/run identifier/);
    expect(() => h.parseArguments(["--cleanup", RUN, "--local-stub"])).toThrow(/cannot be combined/);
    expect(() => h.parseArguments(["--cleanup", RUN, "--local-stub", "--tamper", "pull-writes"])).toThrow(/cannot be combined/);
    expect(() => h.parseArguments(["--bogus"])).toThrow(/unknown option/);
    expect(() => h.parseArguments(["--out", join(SCRIPT, "..", "..", "result.json")])).toThrow(/repository/);
    expect(() => h.parseArguments(["--tamper"])).toThrow(/needs a value/);
  });

  it("knows exactly the six tamper kinds of the task", () => {
    expect([...h.TAMPER_KINDS]).toEqual(["pull-writes", "hash-mismatch", "replay-accepted", "declined-writes", "outside-allowlist", "base-changed"]);
    for (const kind of h.TAMPER_KINDS) expect(h.parseArguments(["--local-stub", "--tamper", kind]).tamper).toBe(kind);
  });

  it("accepts the documented options", () => {
    expect(h.parseArguments(["--dry-run"]).dryRun).toBe(true);
    expect(h.parseArguments(["--local-stub", "--tamper=hash-mismatch"])).toMatchObject({ localStub: true, tamper: "hash-mismatch" });
    expect(h.parseArguments(["--cleanup", RUN]).cleanup).toBe(RUN);
    expect(h.parseArguments([]).out).toMatch(/feature-op-mvp-07a\.json$/);
  });

  it("--accept-unresolved-pointer is an explicit opt-in for the shared-node run only (M-01)", () => {
    expect(h.parseArguments([]).acceptUnresolvedPointer).toBe(false);
    expect(h.parseArguments(["--accept-unresolved-pointer"]).acceptUnresolvedPointer).toBe(true);
    expect(() => h.parseArguments(["--local-stub", "--accept-unresolved-pointer"])).toThrow(/shared-node run/);
    expect(() => h.parseArguments(["--dry-run", "--accept-unresolved-pointer"])).toThrow(/shared-node run/);
    expect(() => h.parseArguments(["--cleanup", RUN, "--accept-unresolved-pointer"])).toThrow(/shared-node run|cannot be combined/);
  });

  it("--cli (a build outside dist) is accepted only with --local-stub", () => {
    expect(h.parseArguments(["--local-stub", "--cli", "/tmp/elsewhere/ipfs-sync.mjs"]).cli).toBe("/tmp/elsewhere/ipfs-sync.mjs");
    expect(() => h.parseArguments(["--cli", "/tmp/elsewhere/ipfs-sync.mjs"])).toThrow(/--local-stub/);
    expect(() => h.parseArguments(["--dry-run", "--cli", "/tmp/elsewhere/ipfs-sync.mjs"])).toThrow(/--local-stub/);
    expect(() => h.parseArguments(["--cleanup", RUN, "--cli", "/tmp/x.mjs"])).toThrow(/--local-stub|cannot be combined/);
  });
});

describe("realpath guards (L-08)", () => {
  const repo = resolve(SCRIPT, "..", "..");
  const made: string[] = [];
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "fop07a-test-"));
    made.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of made) {
      for (const name of ["link", "dangling"]) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          // Not created in this test.
        }
      }
      rmdirSync(dir);
    }
  });

  it("realpathLoose resolves the nearest existing ancestor through symlinks and keeps the missing tail", () => {
    const dir = scratch();
    symlinkSync(join(repo, "tools"), join(dir, "link"));
    expect(h.realpathLoose(join(dir, "link", "not", "there.json"))).toBe(join(h.realpathLoose(join(repo, "tools")), "not", "there.json"));
    expect(h.realpathLoose(join(dir, "plain", "x.json"))).toBe(join(h.realpathLoose(dir), "plain", "x.json"));
  });

  it("follows a dangling symlink to where a write through it would land", () => {
    const dir = scratch();
    symlinkSync(join(repo, "tools", "not-yet-created-result.json"), join(dir, "dangling"));
    expect(h.realpathLoose(join(dir, "dangling"))).toBe(join(h.realpathLoose(join(repo, "tools")), "not-yet-created-result.json"));
    expect(h.isOutsideRepo(join(dir, "dangling"))).toBe(false);
  });

  it("isOutsideRepo is false for the repository, a path below it and a symlink into it, true elsewhere", () => {
    const dir = scratch();
    symlinkSync(join(repo, "tools"), join(dir, "link"));
    expect(h.isOutsideRepo(repo)).toBe(false);
    expect(h.isOutsideRepo(join(repo, "tools", "x.json"))).toBe(false);
    expect(h.isOutsideRepo(join(dir, "link", "x.json"))).toBe(false);
    expect(h.isOutsideRepo(join(dir, "x.json"))).toBe(true);
  });

  it("--out through a symlink into the repository is refused; the written path is the real one", () => {
    const dir = scratch();
    symlinkSync(join(repo, "tools"), join(dir, "link"));
    expect(() => h.parseArguments(["--out", join(dir, "link", "result.json")])).toThrow(/repository/);
    expect(h.parseArguments(["--out", join(dir, "result.json")]).out).toBe(join(h.realpathLoose(dir), "result.json"));
  });

  it("maps the three termination signals to their conventional exit codes", () => {
    expect(h.SIGNAL_EXIT_CODES).toEqual({ SIGINT: 130, SIGHUP: 129, SIGTERM: 143 });
  });
});

describe("cleanup validation", () => {
  it("builds the target strictly below mvp07a-demo from a valid run identifier only", () => {
    expect(h.cleanupTarget(RUN)).toBe(ROOT);
    expect(h.isWithin(h.cleanupTarget(RUN), h.DEMO_PARENT)).toBe(true);
    for (const bad of ["../x", "short", "ABCDEFGH", "abcd/efgh", "..", "abcd1234/..", ""]) expect(() => h.cleanupTarget(bad)).toThrow();
  });

  it("the cleanup target is never the parent, the base or another project", () => {
    expect(h.isWithin(h.DEMO_PARENT, h.DEMO_PARENT)).toBe(false);
    expect(h.isWithin(h.BASE, h.DEMO_PARENT)).toBe(false);
    expect(h.isWithin("/obsidian-vault-sync/mvp06-demo/abcd1234", h.DEMO_PARENT)).toBe(false);
  });
});

describe("request-target vetting and forwarding (F-01)", () => {
  it("forwards pathname plus search of the same parsed URL that was vetted", () => {
    const vetted = h.vetRequestUrl("/api/v0/files/stat?arg=%2Fx&hash=true");
    expect(vetted.ok).toBe(true);
    expect(vetted.forwardPath).toBe("/api/v0/files/stat?arg=%2Fx&hash=true");
    expect(vetted.url?.searchParams.get("arg")).toBe("/x");
  });

  it("normalises dot segments identically for the decision and the forward", () => {
    const vetted = h.vetRequestUrl("/api/v0/a/../files/rm?arg=/y");
    expect(vetted.ok).toBe(true);
    expect(vetted.forwardPath).toBe("/api/v0/files/rm?arg=/y");
    expect(vetted.url?.pathname).toBe("/api/v0/files/rm");
  });

  it("refuses a target that does not start with '/' and non-string targets", () => {
    for (const bad of ["api/v0/key/list", "http://evil.example/api/v0/key/list", "*", "", undefined, 7]) expect(h.vetRequestUrl(bad).ok).toBe(false);
  });

  it("refuses '//' and backslashes in the path, raw or percent-encoded, but not in the query", () => {
    for (const bad of ["//x/api/v0/files/write", "/api/v0//files/write", "/api\\v0/files/write", "/api/v0/files\\write", "/api/v0/files%5cwrite", "/api/v0/files%2f%2fwrite"]) expect(h.vetRequestUrl(bad).ok, bad).toBe(false);
    expect(h.vetRequestUrl("/api/v0/files/stat?arg=//x\\y").ok).toBe(true);
  });
});

describe("previous IPNS pointer line", () => {
  it("prints key ID and resolved path, unresolved, or key absent", () => {
    expect(h.formatPointerLine("k51abc", `/ipfs/${CID}`)).toBe(`previous IPNS pointer of obsidian-vault-sync: k51abc -> /ipfs/${CID}`);
    expect(h.formatPointerLine("k51abc", "unresolved")).toBe("previous IPNS pointer of obsidian-vault-sync: k51abc -> unresolved");
    expect(h.formatPointerLine(undefined, null)).toBe("previous IPNS pointer of obsidian-vault-sync: key absent -> none");
  });
});

describe("pre-run IPNS pointer resolution (M-01)", () => {
  const never = Object.assign(new Error("rpc endpoint answered HTTP 500: could not resolve name"), { status: 500, nodeMessage: "could not resolve name" });
  const transient = (message: string, status = 500): Error => Object.assign(new Error(message), { status, nodeMessage: undefined });
  const instant = async (): Promise<void> => undefined;

  it("only the node's recorded never-published answer counts as never published", () => {
    expect(h.isNeverPublishedError(never)).toBe(true);
    expect(h.isNeverPublishedError(Object.assign(new Error("x"), { status: 500, nodeMessage: "context deadline exceeded" }))).toBe(false);
    expect(h.isNeverPublishedError(Object.assign(new Error("x"), { status: 502, nodeMessage: "could not resolve name" }))).toBe(false);
    expect(h.isNeverPublishedError(transient("fetch failed", 0))).toBe(false);
    expect(h.isNeverPublishedError(undefined)).toBe(false);
    expect(h.isNeverPublishedError("could not resolve name")).toBe(false);
  });

  it("returns the resolved path on success without retrying", async () => {
    let calls = 0;
    const pointer = await h.resolvePreviousPointer(async () => (calls += 1, `/ipfs/${CID}`), { strict: true, sleep: instant });
    expect(pointer).toBe(`/ipfs/${CID}`);
    expect(calls).toBe(1);
  });

  it("shared-node path: a never-published answer is accepted as unresolved immediately", async () => {
    let calls = 0;
    const pointer = await h.resolvePreviousPointer(async () => { calls += 1; throw never; }, { strict: true, sleep: instant });
    expect(pointer).toBe("unresolved");
    expect(calls).toBe(1);
  });

  it("shared-node path: a transient failure is retried and a later success is used", async () => {
    let calls = 0;
    const slept: number[] = [];
    const pointer = await h.resolvePreviousPointer(
      async () => { calls += 1; if (calls < 3) throw transient("timeout"); return `/ipfs/${CID}`; },
      { strict: true, attempts: 3, delayMs: 7, sleep: async (ms) => { slept.push(ms); } },
    );
    expect(pointer).toBe(`/ipfs/${CID}`);
    expect(calls).toBe(3);
    expect(slept).toEqual([7, 7]);
  });

  it("shared-node path: a failure that persists is refused, naming the opt-in, never turned into 'unresolved'", async () => {
    let calls = 0;
    const attempt = h.resolvePreviousPointer(async () => { calls += 1; throw transient("connection reset"); }, { strict: true, attempts: 3, sleep: instant });
    await expect(attempt).rejects.toThrow(/--accept-unresolved-pointer/);
    expect(calls).toBe(3);
  });

  it("shared-node path: the explicit opt-in accepts a persistent failure as unresolved", async () => {
    const pointer = await h.resolvePreviousPointer(async () => { throw transient("connection reset"); }, { strict: true, acceptUnresolved: true, attempts: 2, sleep: instant });
    expect(pointer).toBe("unresolved");
  });

  it("stub path is unchanged: any failure is unresolved, at once", async () => {
    let calls = 0;
    const pointer = await h.resolvePreviousPointer(async () => { calls += 1; throw transient("anything"); }, { strict: false, sleep: instant });
    expect(pointer).toBe("unresolved");
    expect(calls).toBe(1);
  });
});

describe("post-run IPNS pointer and the restore instruction (M-02)", () => {
  it("prints the pointer after the run in the same shape as the pre-run line", () => {
    expect(h.formatPostRunLine("k51abc", `/ipfs/${CID}`)).toBe(`IPNS pointer of obsidian-vault-sync after the run: k51abc -> /ipfs/${CID}`);
    expect(h.formatPostRunLine(undefined, null)).toBe("IPNS pointer of obsidian-vault-sync after the run: key absent -> none");
  });

  it("recorded pointer: prints the kubo CLI form with the runbook's words (on the node, keystore, TTL, unverified)", () => {
    const text = h.restoreInstruction({ keyId: "k51abc", previousPointer: `/ipfs/${CID}` });
    expect(text).toContain(`ipfs name publish --key=obsidian-vault-sync --ttl 5m /ipfs/${CID}`);
    expect(text).toMatch(/run on the node with access to its keystore/);
    expect(text).toMatch(/default lifetime and TTL differ from the product's 5m TTL/);
    expect(text).toMatch(/lifetime stays at kubo's 24h default/);
    expect(text).toContain(`kubectl --context know-me -n ipfs exec ipfs-0 -c ipfs -- ipfs name publish --key=obsidian-vault-sync --ttl 5m /ipfs/${CID}`);
    expect(text).toContain("verified on kubo v0.42.0: default lifetime and TTL, and explicit --ttl 5m --lifetime 24h on a throwaway key (accepted; the pointer resolved); the TTL a remote resolver sees was not checked");
    expect(text).not.toMatch(/options untested/);
    expect(text).not.toMatch(/unverified: test this form/);
    expect(text).toMatch(/must not publish with this key during the run/);
    expect(text).not.toMatch(/is not available yet/);
  });

  it("key absent or never published: says nothing to restore because the key did not exist before this run, with no command", () => {
    for (const pre of [{ keyId: null, previousPointer: null }, { keyId: "k51abc", previousPointer: "unresolved" }]) {
      const text = h.restoreInstruction(pre);
      expect(text).toMatch(/nothing to restore: the key did not exist before this run/);
      expect(text).not.toContain("ipfs name publish");
      expect(text).not.toMatch(/UNKNOWN/);
    }
  });

  it("accepted-unresolved after a read failure: says plainly the previous pointer is UNKNOWN and cannot be restored from this run", () => {
    const text = h.restoreInstruction({ keyId: "k51abc", previousPointer: "unresolved", pointerUnknown: true });
    expect(text).toMatch(/previous pointer is UNKNOWN and could not be recorded, so it cannot be restored from this run/);
    expect(text).not.toMatch(/nothing to restore/);
    expect(text).not.toContain("ipfs name publish");
  });

  it("never prints a command built from an untrusted pointer", () => {
    const hostile = h.restoreInstruction({ keyId: "k51abc", previousPointer: "/ipfs/x; rm -rf ~" });
    expect(hostile).not.toContain("ipfs name publish");
  });
});

describe("signal-exit post-run record is best effort and bounded", () => {
  it("reports ok when the record finishes in time", async () => {
    await expect(h.bestEffortPostRun(async () => "done", { timeoutMs: 1000 })).resolves.toEqual({ ok: true });
  });

  it("reports the failure when the record throws", async () => {
    const result = await h.bestEffortPostRun(async () => { throw new Error("node down"); }, { timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/node down/);
  });

  it("gives up after the timeout when the record never settles, so the handler cannot hang", async () => {
    const result = await h.bestEffortPostRun(() => new Promise(() => undefined), { timeoutMs: 20 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timed out/);
    expect(h.SIGNAL_POST_RUN_TIMEOUT_MS).toBeGreaterThan(0);
    expect(h.SIGNAL_POST_RUN_TIMEOUT_MS).toBeLessThanOrEqual(10000);
  });
});

describe("platform guard (L-03)", () => {
  it("refuses win32, where the device store ignores XDG_STATE_HOME, and nothing else", () => {
    expect(h.win32Refusal("win32")).toMatch(/win32/);
    expect(h.win32Refusal("darwin")).toBeUndefined();
    expect(h.win32Refusal("linux")).toBeUndefined();
  });
});

describe("mutation log audit (L-07)", () => {
  const entry = (command: string, arg: string | undefined, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ command, arg, allowed: true, mutating: true, ...extra });

  it("accepts the writes the CLI sends, judged from the command names and arguments, not from the policy's own flag", () => {
    const log = [
      entry("files/mkdir", ROOT),
      entry("files/write", `${ROOT}/keyslots.json`),
      entry("files/rm", `${ROOT}/current/ab/${"a".repeat(52)}`),
      entry("key/gen", h.KEY),
      entry("pin/add", CID),
      entry("name/publish", `/ipfs/${CID}`, { key: h.KEY }),
      entry("key/list", undefined, { mutating: false }),
      entry("gateway", `/ipfs/${CID}/manifest.enc`, { mutating: false }),
    ];
    expect(h.mutationLogProblems(log, ROOT)).toEqual([]);
  });

  it("flags a mutating command whose 'mutating' flag is false, an unexpected command and a path outside the demo root", () => {
    expect(h.mutationLogProblems([entry("key/rm", h.KEY, { mutating: false })], ROOT).join("\n")).toMatch(/key\/rm/);
    expect(h.mutationLogProblems([entry("files/write", "/obsidian-vault-sync/other/x")], ROOT).join("\n")).toMatch(/outside/);
    expect(h.mutationLogProblems([entry("files/write", ROOT)], ROOT).join("\n")).toMatch(/outside|strictly/);
    expect(h.mutationLogProblems([entry("files/rm", ROOT)], ROOT)).not.toEqual([]);
  });

  it("flags a foreign key for key/gen and name/publish", () => {
    expect(h.mutationLogProblems([entry("key/gen", "obsidian-vault")], ROOT)).not.toEqual([]);
    expect(h.mutationLogProblems([entry("name/publish", `/ipfs/${CID}`, { key: "obsidian-vault" })], ROOT)).not.toEqual([]);
    expect(h.mutationLogProblems([entry("name/publish", `/ipfs/${CID}`)], ROOT)).not.toEqual([]);
  });

  it("flags any entry, read or write, that names the staging root; refused entries are left to the violations check", () => {
    expect(h.mutationLogProblems([entry("files/stat", "/obsidian-vault-staging/x", { mutating: false })], ROOT).join("\n")).toMatch(/staging/);
    expect(h.mutationLogProblems([entry("pin/rm", CID, { allowed: false, mutating: false })], ROOT)).toEqual([]);
  });
});

describe("proxy self-test against a dead upstream (L-01)", () => {
  it("the upstream is a dead loopback address, never the shared node", () => {
    expect(h.DEAD_UPSTREAM.rpc).toBe("http://127.0.0.1:9");
    expect(h.DEAD_UPSTREAM.gateway).toBe("http://127.0.0.1:9");
    expect(h.isLoopbackUrl(h.DEAD_UPSTREAM.rpc)).toBe(true);
  });

  it("refuses every out-of-policy request without forwarding one, and an in-policy control request only reaches the dead upstream", async () => {
    const proxyModule = (await import(/* @vite-ignore */ pathToFileURL(join(SCRIPT, "..", "feature-op-mvp-07a", "proxy.mjs")).href)) as { runProxySelfTest(demoRoot: string): Promise<SelfTestResult> };
    const result = await proxyModule.runProxySelfTest(ROOT);
    expect(result.upstream).toBe("http://127.0.0.1:9");
    expect(result.total).toBeGreaterThanOrEqual(10);
    expect(result.refused).toBe(result.total);
    expect(result.forwardedByPolicy).toBe(0);
    expect(result.controlStatus).toBe(502);
  });
});

describe("stale-build refusal on the shared-node path", () => {
  it("refuses --allow-stale-build on the shared-node path only", () => {
    expect(h.staleBuildRefusal({ allowStaleBuild: true, localStub: false, dryRun: false })).toMatch(/shared-node/);
    expect(h.staleBuildRefusal({ allowStaleBuild: true, localStub: true, dryRun: false })).toBeUndefined();
    expect(h.staleBuildRefusal({ allowStaleBuild: true, localStub: false, dryRun: true })).toBeUndefined();
    expect(h.staleBuildRefusal({ allowStaleBuild: false, localStub: false, dryRun: false })).toBeUndefined();
  });

  it("parseArguments applies it", () => {
    expect(() => h.parseArguments(["--allow-stale-build"])).toThrow(/shared-node/);
    expect(() => h.parseArguments(["--local-stub", "--allow-stale-build"])).not.toThrow();
  });
});

describe("passphrase spellings read from the file (L-05)", () => {
  it("adds the grouped and the canonical spelling of the file's text to the known secrets, once, without empties", () => {
    expect(h.withPassphraseSpellings(["x"], "ABCDE-FGHIJ\n")).toEqual(["x", "ABCDE-FGHIJ", "ABCDEFGHIJ"]);
    expect(h.withPassphraseSpellings(["ABCDE-FGHIJ"], "ABCDE-FGHIJ\n")).toEqual(["ABCDE-FGHIJ", "ABCDEFGHIJ"]);
    expect(h.withPassphraseSpellings(["x"], "")).toEqual(["x"]);
  });

  it("a detail built from stdout alone is redacted with them even when the secrets list was still empty", () => {
    const secrets = h.withPassphraseSpellings([], "ABCDE-FGHIJ\n");
    expect(h.scrubbedDetail({ stdout: "vault ABCDE-FGHIJ and ABCDEFGHIJ", stderr: "" }, secrets)).toBe("vault [redacted] and [redacted]");
  });
});

describe("re-scrubbed failure detail", () => {
  it("redacts secrets learned after the child ran", () => {
    expect(h.scrubbedDetail({ stdout: "", stderr: "bad ABCDE-FGHIJ here\nnext" }, ["ABCDE-FGHIJ"])).toBe("bad [redacted] here");
    expect(h.scrubbedDetail({ stdout: "out ABCDEFGHIJ", stderr: "" }, ["ABCDEFGHIJ"])).toBe("out [redacted]");
  });
});
