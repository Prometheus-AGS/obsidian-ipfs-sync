import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Pure helpers of tools/feature-op-mvp-06.mjs: the proxy policy, the fault schedule, the layout rule, the needle scanners
 * and the argument rules. Nothing here starts a process, opens a socket or talks to a node.
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
interface Entry {
  readonly name: string;
  readonly type: "file" | "directory";
}
interface FaultState {
  readonly kind: string;
  readonly manifestSeen: boolean;
  readonly historySeen: boolean;
  readonly fired: boolean;
}
interface Helpers {
  readonly KEY: string;
  readonly DEMO_PARENT: string;
  readonly RPC_ALLOWLIST: readonly string[];
  isValidRunId(id: unknown): boolean;
  demoRootFor(id: string): string;
  normalizeMfsPath(path: string): string | undefined;
  isWithin(path: string, root: string, options?: { allowEqual?: boolean }): boolean;
  isLoopbackUrl(url: string): boolean;
  isAllowedUpstream(url: string, localStub: boolean): boolean;
  decideRequest(request: { method: string; pathname: string; params: URLSearchParams }, context: { demoRoot: string; knownCids: Set<string> }): Verdict;
  faultStep(state: FaultState | undefined, info: { command: string; arg?: string }, demoRoot: string): { drop: boolean; state: FaultState | undefined };
  canonicalJson(value: unknown): string;
  byteEntropy(bytes: Uint8Array): number;
  findNeedle(haystack: Uint8Array, needles: readonly Needle[]): string | undefined;
  createNeedleScanner(needles: readonly Needle[]): { push(chunk: Buffer): string | undefined };
  keyMaterialNeedles(name: string, bytes: Uint8Array): Needle[];
  buildLargeNote(size?: number): string;
  plaintextNeedles(files: readonly { path: string; text?: string }[]): Needle[];
  checkNodeLayout(input: { root: Entry[]; current: Entry[]; prefixes: Map<string, Entry[]>; manifests: Entry[] }): string[];
  parsePublishOutput(text: string): { written?: number; removed?: number; sequence?: number; rootCid?: string };
  childEnv(base: Record<string, string | undefined>, extra: Record<string, string>): Record<string, string>;
  redact(text: string, secrets: readonly string[]): string;
  vetRequestUrl(raw: unknown): { ok: boolean; reason: string; url?: URL; forwardPath?: string };
  formatPointerLine(keyId: string | undefined, pointer: string | null): string;
  staleBuildRefusal(opts: { allowStaleBuild: boolean; localStub: boolean; dryRun: boolean }): string | undefined;
  scrubbedDetail(result: { stdout?: string; stderr?: string }, secrets: readonly string[]): string;
  parseArguments(argv: readonly string[]): { out: string; tamper?: string; cleanup?: string; localStub: boolean; dryRun: boolean };
}

const SCRIPT = resolve(__dirname, "..", "..", "tools", "feature-op-mvp-06.mjs");
let h: Helpers;

beforeAll(async () => {
  h = (await import(/* @vite-ignore */ pathToFileURL(SCRIPT).href)) as Helpers;
});

const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const RUN = "mvp6test-0123abcd";
const params = (init: Record<string, string | string[]>): URLSearchParams => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(init)) for (const each of Array.isArray(value) ? value : [value]) search.append(name, each);
  return search;
};
const rpc = (command: string, init: Record<string, string | string[]>, known: string[] = []): Verdict =>
  h.decideRequest({ method: "POST", pathname: `/api/v0/${command}`, params: params(init) }, { demoRoot: h.demoRootFor(RUN), knownCids: new Set(known) });

describe("run identifiers and demo root", () => {
  it("accepts only ^[a-z0-9-]{8,}$", () => {
    expect(h.isValidRunId("abcd1234")).toBe(true);
    expect(h.isValidRunId("mfvx0k1a-0badf00d")).toBe(true);
    for (const bad of ["short", "ABCDEFGH", "abcd 1234", "abcd/1234", "../../etc", "abcd1234\n", "", undefined, 12345678]) expect(h.isValidRunId(bad)).toBe(false);
  });

  it("builds the demo root only from a valid identifier", () => {
    expect(h.demoRootFor(RUN)).toBe(`/obsidian-vault-sync/mvp06-demo/${RUN}`);
    expect(() => h.demoRootFor("../x")).toThrow(/does not match/);
  });
});

describe("path confinement", () => {
  const root = `/obsidian-vault-sync/mvp06-demo/${RUN}`;

  it("refuses dot segments, backslashes, control characters and relative paths instead of resolving them", () => {
    for (const bad of [`${root}/../x`, `${root}/./x`, "relative/path", `${root}\\x`, `${root}/x\u0000`]) expect(h.normalizeMfsPath(bad)).toBeUndefined();
    expect(h.normalizeMfsPath(`${root}//a///b/`)).toBe(`${root}/a/b`);
  });

  it("treats a sibling with the same prefix as outside", () => {
    expect(h.isWithin(`${root}/manifest.enc`, root)).toBe(true);
    expect(h.isWithin(root, root)).toBe(false);
    expect(h.isWithin(root, root, { allowEqual: true })).toBe(true);
    expect(h.isWithin(`${root}-other/x`, root)).toBe(false);
    expect(h.isWithin("/obsidian-vault-sync/mvp06-demo/other/x", root)).toBe(false);
    expect(h.isWithin("/obsidian-vault-staging/x", root)).toBe(false);
  });

  it("only the shared node's host, or loopback with --local-stub, is an upstream; children only ever get loopback", () => {
    expect(h.isAllowedUpstream("https://ipfs.prometheusags.ai", false)).toBe(true);
    expect(h.isAllowedUpstream("https://ipfs.prometheusags.ai.evil.example", false)).toBe(false);
    expect(h.isAllowedUpstream("http://127.0.0.1:5001", false)).toBe(false);
    expect(h.isAllowedUpstream("http://127.0.0.1:5001", true)).toBe(true);
    expect(h.isLoopbackUrl("http://127.0.0.1:1234")).toBe(true);
    expect(h.isLoopbackUrl("https://127.0.0.1:1234")).toBe(false);
    expect(h.isLoopbackUrl("http://10.0.0.1:1234")).toBe(false);
  });
});

describe("proxy policy (decideRequest)", () => {
  const root = `/obsidian-vault-sync/mvp06-demo/${RUN}`;

  it("forwards the reads and writes the CLI needs, below the demo root", () => {
    expect(rpc("files/write", { arg: `${root}/current/ab/${"a".repeat(52)}`, create: "true" })).toMatchObject({ allowed: true, mutating: true });
    expect(rpc("files/write", { arg: `${root}/manifest.enc` }).allowed).toBe(true);
    expect(rpc("files/rm", { arg: `${root}/current/ab/${"a".repeat(52)}`, recursive: "false" }).allowed).toBe(true);
    expect(rpc("files/stat", { arg: root })).toMatchObject({ allowed: true, mutating: false });
    expect(rpc("files/ls", { arg: `${root}/manifests` }).allowed).toBe(true);
    expect(rpc("files/stat", { arg: `/ipfs/${CID}/current` }).allowed).toBe(true);
    expect(rpc("ls", { arg: `/ipfs/${CID}/manifests` }).allowed).toBe(true);
    expect(rpc("key/list", {}).allowed).toBe(true);
    expect(rpc("name/resolve", { arg: "/ipns/k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8", nocache: "true" }).allowed).toBe(true);
    expect(rpc("key/gen", { arg: h.KEY, type: "ed25519" })).toMatchObject({ allowed: true, mutating: true });
  });

  it("refuses key/rm, key/rename, pin/rm, files/mv and every command not on the list", () => {
    for (const command of ["key/rm", "key/rename", "key/rotate", "key/import", "key/export", "pin/rm", "pin/update", "files/mv", "files/cp", "files/chcid", "repo/gc", "add", "config", "swarm/connect", "id"]) {
      expect(rpc(command, { arg: `/obsidian-vault-sync/mvp06-demo/${RUN}/x` })).toMatchObject({ allowed: false, reason: "command is not on the allowlist" });
    }
    expect(h.RPC_ALLOWLIST).not.toContain("key/rm");
    expect(h.RPC_ALLOWLIST).not.toContain("pin/rm");
  });

  it("refuses mutations outside the demo root, on the root itself, by dot segments, on other projects and on the staging root", () => {
    for (const arg of [`/obsidian-vault-sync/other-project/x`, "/obsidian-vault-sync/mvp06-demo/other-run/x", `${root}/../escape`, `${root}-other/x`, "/obsidian-vault-staging/x", "/", root]) {
      expect(rpc("files/write", { arg }).allowed).toBe(false);
      expect(rpc("files/rm", { arg }).allowed).toBe(false);
    }
    expect(rpc("files/ls", { arg: "/obsidian-vault-sync" }).allowed).toBe(false);
    expect(rpc("files/stat", { arg: "/obsidian-vault-staging" }).reason).toMatch(/never touched/);
    expect(rpc("files/write", { arg: [`${root}/a`, `${root}/b`] }).allowed).toBe(false);
    expect(rpc("files/write", {}).allowed).toBe(false);
  });

  it("names nothing on the staging root in any parameter", () => {
    expect(rpc("name/resolve", { arg: "k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8", note: "/obsidian-vault-staging" }).allowed).toBe(false);
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
    const gateway = (method: string, pathname: string): Verdict => h.decideRequest({ method, pathname, params: params({}) }, { demoRoot: `/obsidian-vault-sync/mvp06-demo/${RUN}`, knownCids: new Set() });
    expect(gateway("GET", `/ipfs/${CID}/current/ab/${"a".repeat(52)}`)).toMatchObject({ allowed: true, kind: "gateway", mutating: false });
    expect(gateway("HEAD", `/ipfs/${CID}`).allowed).toBe(true);
    expect(gateway("POST", `/ipfs/${CID}`).allowed).toBe(false);
    expect(gateway("GET", `/ipfs/${CID}/../x`).allowed).toBe(false);
    expect(gateway("GET", `/ipfs/${CID}/%2e%2e/x`).allowed).toBe(false);
    expect(gateway("GET", `/ipfs/${CID}/a%2Fb`).allowed).toBe(false);
    expect(gateway("GET", "/ipfs/short").allowed).toBe(false);
    expect(gateway("GET", "/ipns/k51abc").allowed).toBe(false);
    expect(h.decideRequest({ method: "GET", pathname: "/api/v0/key/list", params: params({}) }, { demoRoot: "/x", knownCids: new Set() }).allowed).toBe(false);
  });
});

describe("fault schedule (faultStep)", () => {
  const root = `/obsidian-vault-sync/mvp06-demo/${RUN}`;
  const start = (kind: string): FaultState => ({ kind, manifestSeen: false, historySeen: false, fired: false });
  const run = (kind: string, requests: { command: string; arg?: string }[]): string[] => {
    let state: FaultState | undefined = start(kind);
    return requests.map((request) => {
      const step = h.faultStep(state, request, root);
      state = step.state;
      return step.drop ? "drop" : "forward";
    });
  };
  const publish = [
    { command: "files/write", arg: `${root}/current/ab/${"a".repeat(52)}` },
    { command: "files/stat", arg: `${root}/current` },
    { command: "files/write", arg: `${root}/manifest.enc` },
    { command: "files/write", arg: `${root}/manifests/${CID}.enc` },
    { command: "files/stat", arg: root },
    { command: "pin/add", arg: CID },
    { command: "name/publish", arg: `/ipfs/${CID}` },
  ];

  it("before-manifest drops the manifest.enc write and everything after it", () => {
    expect(run("before-manifest", publish)).toEqual(["forward", "forward", "drop", "drop", "drop", "drop", "drop"]);
  });

  it("between forwards manifest.enc and drops the history write and everything after it", () => {
    expect(run("between", publish)).toEqual(["forward", "forward", "forward", "drop", "drop", "drop", "drop"]);
  });

  it("after-history forwards manifest and history and the reads, and drops the first pin/add", () => {
    expect(run("after-history", publish)).toEqual(["forward", "forward", "forward", "forward", "forward", "drop", "drop"]);
  });

  it("no fault forwards everything, and a history write before any manifest write does not arm between", () => {
    expect(h.faultStep(undefined, publish[3] as { command: string }, root).drop).toBe(false);
    expect(run("between", [publish[3] as { command: string }, publish[5] as { command: string }])).toEqual(["forward", "forward"]);
  });
});

describe("canonical JSON, entropy, needles", () => {
  it("sorts keys at every level, uses two spaces and ends with one line feed", () => {
    expect(h.canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe('{\n  "a": {\n    "c": "x",\n    "d": [\n      3,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n');
  });

  it("measures byte entropy: random data is near 8 bits, repetitive text is far below", () => {
    expect(h.byteEntropy(randomBytes(256 * 1024))).toBeGreaterThan(7.99);
    expect(h.byteEntropy(Buffer.from(h.buildLargeNote()))).toBeLessThan(5);
    expect(h.byteEntropy(new Uint8Array(0))).toBe(0);
  });

  it("finds a needle in bytes and across chunk boundaries of a stream", () => {
    const needles: Needle[] = [{ label: "title", bytes: Buffer.from("Welcome home") }];
    expect(h.findNeedle(Buffer.from("xx Welcome home yy"), needles)).toBe("title");
    expect(h.findNeedle(randomBytes(4096), needles)).toBeUndefined();
    const scanner = h.createNeedleScanner(needles);
    expect(scanner.push(Buffer.from("aaaa Welc"))).toBeUndefined();
    expect(scanner.push(Buffer.from("ome ho"))).toBeUndefined();
    expect(scanner.push(Buffer.from("me zzz"))).toBe("title");
    expect(scanner.push(Buffer.from("later"))).toBe("title");
  });

  it("searches a secret in raw, hex, upper hex, base64, unpadded base64, base64url and base32 form", () => {
    const secret = randomBytes(32);
    const needles = h.keyMaterialNeedles("vck", secret);
    expect(needles.map((needle) => needle.label)).toEqual(["vck (raw)", "vck (hex)", "vck (HEX)", "vck (base64)", "vck (base64-unpadded)", "vck (base64url)", "vck (base32)"]);
    expect(h.findNeedle(Buffer.concat([Buffer.from("junk"), secret]), needles)).toBe("vck (raw)");
    expect(h.findNeedle(Buffer.from(`k=${secret.toString("hex")}`), needles)).toBe("vck (hex)");
    expect(h.findNeedle(Buffer.from(`k=${secret.toString("base64")}`), needles)).toBe("vck (base64)");
    expect(h.findNeedle(Buffer.from(`k=${secret.toString("base64url")}`), needles)).toMatch(/base64/);
    expect(h.findNeedle(randomBytes(8192), needles)).toBeUndefined();
    const base32 = needles.find((needle) => needle.label === "vck (base32)")?.bytes.toString();
    expect(base32).toMatch(/^[a-z2-7]{52}$/);
  });

  it("builds the repetitive note at exactly 256 KiB with the canary, and lists titles, paths and body words as needles", () => {
    const note = h.buildLargeNote();
    expect(Buffer.byteLength(note)).toBe(256 * 1024);
    expect(note).toContain("canary-phrase-zx91-ipfs");
    const labels = h.plaintextNeedles([{ path: "notes/welcome.md", text: "# Welcome\n\nharbor lantern.\n" }, { path: "a/b.md", text: "# Hi\n" }]).map((needle) => needle.label);
    expect(labels).toContain('path "notes/welcome.md"');
    expect(labels).toContain('title "Welcome"');
    expect(labels).toContain('path segment "notes"');
    expect(labels).toContain('file stem "welcome"');
    expect(labels).toContain('body word "harbor"');
    expect(labels).toContain('canary "canary-phrase-zx91-ipfs"');
    expect(labels.some((label) => label.includes('"Hi"'))).toBe(false);
  });
});

describe("layout rule (checkNodeLayout)", () => {
  const name = "abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst".slice(0, 52);
  const good = () => ({
    root: [
      { name: "current", type: "directory" as const },
      { name: "manifests", type: "directory" as const },
      { name: "manifest.enc", type: "file" as const },
      { name: "keyslots.json", type: "file" as const },
    ],
    current: [{ name: "ab", type: "directory" as const }],
    prefixes: new Map([["ab", [{ name: `ab${name.slice(2)}`, type: "file" as const }]]]),
    manifests: [{ name: `${CID}.enc`, type: "file" as const }],
  });

  it("accepts the encrypted layout", () => {
    expect(h.checkNodeLayout(good())).toEqual([]);
  });

  it("reports a flipped listing name, a stray file in a prefix folder, an extra root entry and a plaintext-looking name", () => {
    const flipped = good();
    flipped.prefixes = new Map([["ab", [{ name: `ab${name.slice(2, 51)}A`, type: "file" as const }]]]);
    expect(h.checkNodeLayout(flipped).join("\n")).toMatch(/anomaly in current\/ab\//);
    const stray = good();
    stray.prefixes = new Map([["ab", [...(stray.prefixes.get("ab") ?? []), { name: "notes.md", type: "file" as const }]]]);
    expect(h.checkNodeLayout(stray).join("\n")).toMatch(/notes\.md/);
    const extra = good();
    extra.root.push({ name: "manifest.json", type: "file" as const });
    expect(h.checkNodeLayout(extra).join("\n")).toMatch(/root lists/);
    const wrongPrefix = good();
    wrongPrefix.prefixes = new Map([["cd", [{ name: `ab${name.slice(2)}`, type: "file" as const }]]]);
    expect(h.checkNodeLayout(wrongPrefix).length).toBeGreaterThan(0);
    const folder = good();
    folder.current.push({ name: "notes", type: "directory" as const });
    expect(h.checkNodeLayout(folder).join("\n")).toMatch(/current\/ holds directory "notes"/);
    const history = good();
    history.manifests.push({ name: "manifest.json", type: "file" as const });
    expect(h.checkNodeLayout(history).join("\n")).toMatch(/anomaly in manifests\//);
  });
});

describe("publish output, environment, redaction, arguments", () => {
  it("parses the summary, the sequence and the root CID", () => {
    expect(h.parsePublishOutput("ipfs-sync publish\nroot CID   bafyroot123456\nsnapshot  bafycur\nsequence  2\n1 written, 0 removed\n")).toEqual({ written: 1, removed: 0, sequence: 2, rootCid: "bafyroot123456" });
    expect(h.parsePublishOutput("nothing changed")).toEqual({ written: undefined, removed: undefined, sequence: undefined, rootCid: undefined });
  });

  it("strips IPFS_SYNC_* from a child's environment except auth, and adds the extras last", () => {
    const env = h.childEnv(
      { PATH: "/bin", IPFS_SYNC_RPC_URL: "https://elsewhere", IPFS_SYNC_MFS_ROOT: "/x", IPFS_SYNC_PASSPHRASE: "secret", IPFS_SYNC_PASSPHRASE_FILE: "/f", IPFS_SYNC_KEY: "k", IPFS_SYNC_AUTH_TOKEN: "t", IPFS_SYNC_RPC_AUTH_USER: "u", HOME: undefined },
      { IPFS_SYNC_DEVICE: "d" },
    );
    expect(env).toEqual({ PATH: "/bin", IPFS_SYNC_AUTH_TOKEN: "t", IPFS_SYNC_RPC_AUTH_USER: "u", IPFS_SYNC_DEVICE: "d" });
  });

  it("redacts every spelling of a secret and ignores empty secrets", () => {
    expect(h.redact("a ABCDE-FGHIJ b ABCDEFGHIJ c", ["ABCDE-FGHIJ", "ABCDEFGHIJ", ""])).toBe("a [redacted] b [redacted] c");
  });

  it("refuses --tamper without --local-stub, a bad --cleanup identifier, an unknown option, and a result path inside the repository", () => {
    expect(() => h.parseArguments(["--tamper", "title-in-blob"])).toThrow(/--local-stub/);
    expect(() => h.parseArguments(["--local-stub", "--tamper", "nope"])).toThrow(/must be one of/);
    expect(() => h.parseArguments(["--cleanup", "../../x"])).toThrow(/run identifier/);
    expect(() => h.parseArguments(["--cleanup", "short"])).toThrow(/run identifier/);
    expect(() => h.parseArguments(["--cleanup", RUN, "--local-stub"])).toThrow(/cannot be combined/);
    expect(() => h.parseArguments(["--bogus"])).toThrow(/unknown option/);
    expect(() => h.parseArguments(["--out", join(SCRIPT, "..", "..", "result.json")])).toThrow(/repository/);
    expect(() => h.parseArguments(["--tamper"])).toThrow(/needs a value/);
  });

  it("accepts the documented options", () => {
    expect(h.parseArguments(["--dry-run"]).dryRun).toBe(true);
    expect(h.parseArguments(["--local-stub", "--tamper=resume-fails"])).toMatchObject({ localStub: true, tamper: "resume-fails" });
    expect(h.parseArguments(["--cleanup", RUN]).cleanup).toBe(RUN);
    expect(h.parseArguments([]).out).toMatch(/feature-op-mvp-06\.json$/);
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

describe("previous IPNS pointer line (R5-09)", () => {
  it("prints key ID and resolved path, unresolved, or key absent", () => {
    expect(h.formatPointerLine("k51abc", "/ipfs/" + CID)).toBe("previous IPNS pointer of obsidian-vault-sync: k51abc -> /ipfs/" + CID);
    expect(h.formatPointerLine("k51abc", "unresolved")).toBe("previous IPNS pointer of obsidian-vault-sync: k51abc -> unresolved");
    expect(h.formatPointerLine(undefined, null)).toBe("previous IPNS pointer of obsidian-vault-sync: key absent -> none");
  });
});

describe("stale-build refusal (R5-10)", () => {
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

describe("re-scrubbed failure detail (F-02)", () => {
  it("redacts secrets learned after the child ran", () => {
    expect(h.scrubbedDetail({ stdout: "", stderr: "bad ABCDE-FGHIJ here\nnext" }, ["ABCDE-FGHIJ"])).toBe("bad [redacted] here");
    expect(h.scrubbedDetail({ stdout: "out ABCDEFGHIJ", stderr: "" }, ["ABCDEFGHIJ"])).toBe("out [redacted]");
  });
});
