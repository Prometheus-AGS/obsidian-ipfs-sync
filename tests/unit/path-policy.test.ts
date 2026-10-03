// mvp-07a task 3.1b: path policy (spec path-hardening). Expectations come from tests/vectors/path-policy.json, reasoned by hand.
// Invisible characters are built from code points here (never typed into the source) so that review can see them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createExclusionMatcher } from "../../src/sync/exclusions";
import { foldKey } from "../../src/sync/path-fold";
import {
  SUMMARY_NAME_LIMIT,
  adviseUnrestorablePaths,
  createPullExclusionMatcher,
  escapeForDisplay,
  evaluatePathPolicy,
  refusePath,
  summarizeRefusals,
  type PathPolicyOptions,
  type PolicyRefusal,
} from "../../src/sync/path-policy";

const repoFile = (relative: string): string => fileURLToPath(new URL(`../../${relative}`, import.meta.url));
const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

const CSI = cp(0x9b);
const RLO = cp(0x202e);
const FULLWIDTH_N = cp(0xff2e);
const SUPERSCRIPT_ONE = cp(0xb9);

interface Expectation {
  readonly severity: "expected" | "unsafe";
  readonly class?: "shape" | "platform";
  readonly code: string;
}
interface SingleVector {
  readonly name: string;
  readonly path: string;
  readonly configDir?: string;
  readonly extra?: readonly string[];
  readonly expect: "accepted" | Expectation;
}
interface SetVector {
  readonly name: string;
  readonly paths: readonly string[];
  readonly refused: Readonly<Record<string, Expectation>>;
  readonly accepted: readonly string[];
}
interface MatcherVectors {
  readonly extra: readonly string[];
  readonly answers: readonly (readonly [string, boolean])[];
}
interface PolicyVectors {
  readonly single: readonly SingleVector[];
  readonly sets: readonly SetVector[];
  readonly publisherMatcher: MatcherVectors;
  readonly pullMatcher: MatcherVectors;
}
interface FoldVectors {
  readonly vectors: readonly { readonly name: string; readonly input: string; readonly key: string }[];
  readonly protected: readonly { readonly name: string; readonly key: string; readonly aliases: readonly string[] }[];
  readonly notProtected: readonly string[];
}

const policy = JSON.parse(readFileSync(repoFile("tests/vectors/path-policy.json"), "utf8")) as PolicyVectors;
const fold = JSON.parse(readFileSync(repoFile("tests/vectors/path-fold.json"), "utf8")) as FoldVectors;

const optionsOf = (vector: Pick<SingleVector, "configDir" | "extra">): PathPolicyOptions => ({
  ...(vector.configDir === undefined ? {} : { configDir: vector.configDir }),
  ...(vector.extra === undefined ? {} : { extraExclusions: vector.extra }),
});

/** Severity, class (unsafe only) and code of a refusal, in the shape the vector file uses. */
function shapeOf(refusal: PolicyRefusal): Expectation {
  return refusal.severity === "unsafe"
    ? { severity: "unsafe", class: refusal.class, code: refusal.code }
    : { severity: "expected", code: refusal.code };
}

describe("single-path vectors", () => {
  for (const vector of policy.single) {
    it(vector.name, () => {
      const options = optionsOf(vector);
      const verdict = evaluatePathPolicy([vector.path], options);
      if (vector.expect === "accepted") {
        expect(verdict.refusals).toEqual([]);
        expect(verdict.accepted).toEqual([vector.path]);
        expect(refusePath(vector.path, options)).toBeUndefined();
        return;
      }
      expect(verdict.accepted).toEqual([]);
      expect(verdict.refusals).toHaveLength(1);
      const refusal = verdict.refusals[0]!;
      expect(refusal.path).toBe(vector.path);
      expect(shapeOf(refusal)).toEqual(vector.expect);
      // The single-path entry point (write-time re-check) gives the same answer.
      expect(refusePath(vector.path, options)).toEqual(refusal);
    });
  }

  it("every refusal has a fixed reason that never repeats the path", () => {
    for (const vector of policy.single) {
      const refusal = refusePath(vector.path, optionsOf(vector));
      if (refusal === undefined) continue;
      expect(refusal.reason.length).toBeGreaterThan(0);
      expect(/[\u0000-\u001f\u007f-\u009f]/.test(refusal.reason)).toBe(false);
      if (vector.path !== "") expect(refusal.reason.includes(vector.path)).toBe(false);
    }
  });

  it("an unsafe refusal always names a class and an expected one never does", () => {
    for (const vector of policy.single) {
      const refusal = refusePath(vector.path, optionsOf(vector));
      if (refusal === undefined) continue;
      if (refusal.severity === "unsafe") expect(["shape", "platform"]).toContain(refusal.class);
      else expect("class" in refusal).toBe(false);
    }
  });
});

describe("sets: collisions and file/directory prefixes", () => {
  for (const vector of policy.sets) {
    it(vector.name, () => {
      const verdict = evaluatePathPolicy(vector.paths);
      expect(Object.fromEntries(verdict.refusals.map((refusal) => [refusal.path, shapeOf(refusal)]))).toEqual(vector.refused);
      expect(verdict.accepted).toEqual([...vector.accepted].sort());
    });
  }

  it("is independent of input order", () => {
    const paths = ["Note.md", "a", "note.md", "a/b.md", "CON.md", "ok.md"];
    expect(evaluatePathPolicy([...paths].reverse())).toEqual(evaluatePathPolicy(paths));
  });

  it("a collision group names every member, sorted", () => {
    const verdict = evaluatePathPolicy(["note.md", "Note.md", "ok.md"]);
    for (const refusal of verdict.refusals) expect(refusal.group).toEqual(["Note.md", "note.md"]);
    expect(verdict.refusals[0]!.reason).toContain("rename one on the originating device");
  });

  it("a file/directory group holds the file and everything beneath it", () => {
    const verdict = evaluatePathPolicy(["a", "a/b.md", "a/c/d.md", "z.md"]);
    expect(verdict.refusals.map((refusal) => refusal.path)).toEqual(["a", "a/b.md", "a/c/d.md"]);
    for (const refusal of verdict.refusals) expect(refusal.group).toEqual(["a", "a/b.md", "a/c/d.md"]);
  });

  it("the summary names at most three members and counts the rest", () => {
    const verdict = evaluatePathPolicy(["n.md", "N.md", "N.MD", `${FULLWIDTH_N}.md`, "ok.md"]);
    expect(verdict.refusals).toHaveLength(4);
    const summary = summarizeRefusals(verdict.refusals);
    expect(summary.match(/"/g)?.length).toBe(SUMMARY_NAME_LIMIT * 2);
    expect(summary).toContain("and 1 more");
  });
});

describe("the 3.1a fold vectors as path segments", () => {
  const protectedKeys = new Set(fold.protected.map((entry) => entry.key));

  for (const entry of fold.protected) {
    for (const alias of entry.aliases) {
      it(`${JSON.stringify(alias)} as a first segment and as a nested segment`, () => {
        for (const path of [`${alias}/x.md`, `${alias}`]) {
          const refusal = refusePath(path);
          expect(refusal, path).toBeDefined();
          // `.obsidian/x.md` is the configuration folder (expected); everything else protected is unsafe/shape.
          if (entry.key === ".obsidian" && path.endsWith("/x.md")) expect(shapeOf(refusal!)).toEqual({ severity: "expected", code: "config-folder" });
          else expect(refusal!.severity).toBe("unsafe");
        }
        const nested = refusePath(`notes/${alias}/x.md`);
        if (entry.key === ".git") expect(nested).toMatchObject({ severity: "unsafe", class: "shape", code: "vcs-folder" });
        // .ipfs-sync and .obsidian are protected as the first segment; nested, the exclusion list (any depth) answers.
        if (entry.key !== ".git") expect(nested).toMatchObject({ severity: "expected", code: "excluded" });
      });
    }
  }

  it("ordinary names from the fold vectors stay accepted", () => {
    for (const name of fold.notProtected) {
      const path = `${name}/x.md`;
      expect(refusePath(path), path).toBeUndefined();
    }
    expect(refusePath(".gitignore")).toBeUndefined();
    expect(refusePath("notes/ipfs-sync.md")).toBeUndefined();
  });

  it("every vector input, used as a folder name, is judged by its fold key", () => {
    const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/;
    for (const vector of fold.vectors) {
      if (vector.input === "") continue; // "/x.md" is an absolute path; covered in the single vectors.
      const refusal = refusePath(`dir/${vector.input}/x.md`);
      const key = foldKey(vector.input);
      if (key === ".git") expect(refusal, vector.name).toMatchObject({ code: "vcs-folder" });
      else if (key === ".ipfs-sync" || key === ".obsidian") expect(refusal, vector.name).toMatchObject({ severity: "expected", code: "excluded" });
      else if (reserved.test(key)) expect(refusal, vector.name).toMatchObject({ code: "reserved-name" });
      else if (vector.input === "OBSIDI~1") expect(refusal, vector.name).toMatchObject({ code: "short-name" });
      else expect(refusal, vector.name).toBeUndefined();
    }
    // The same inputs as a FIRST segment: the protected ones are refused whichever way they are spelled.
    for (const vector of fold.vectors) {
      if (!protectedKeys.has(foldKey(vector.input))) continue;
      expect(refusePath(`${vector.input}/x.md`), vector.name).toBeDefined();
    }
  });

  it("the NFC and NFD forms from the fold vectors collide as paths", () => {
    const pair = fold.vectors.filter((vector) => vector.name.startsWith("NFC form") || vector.name.startsWith("NFD form"));
    expect(pair).toHaveLength(2);
    expect(pair[0]!.input).not.toBe(pair[1]!.input);
    const verdict = evaluatePathPolicy(pair.map((vector) => `${vector.input}.md`));
    expect(verdict.refusals.map((refusal) => refusal.code)).toEqual(["case-collision", "case-collision"]);
  });

  it("the case pair from the fold vectors collides as paths", () => {
    const pair = fold.vectors.filter((vector) => vector.name.startsWith("case pair"));
    expect(pair).toHaveLength(2);
    const verdict = evaluatePathPolicy(pair.map((vector) => vector.input));
    expect(verdict.refusals).toHaveLength(2);
  });
});

describe("matchers", () => {
  it("the publisher's matcher answers the fixed vector list as recorded (it is not changed by this task)", () => {
    const matcher = createExclusionMatcher(policy.publisherMatcher.extra);
    for (const [path, expected] of policy.publisherMatcher.answers) expect(matcher(path), path).toBe(expected);
  });

  it("the publisher's matcher excludes Private/ and not private/", () => {
    const matcher = createExclusionMatcher(["Private/"]);
    expect(matcher("Private/a.md")).toBe(true);
    expect(matcher("private/a.md")).toBe(false);
  });

  it("the pull matcher answers the fixed vector list as recorded", () => {
    const matcher = createPullExclusionMatcher(policy.pullMatcher.extra);
    for (const [path, expected] of policy.pullMatcher.answers) expect(matcher(path), path).toBe(expected);
  });

  it("the pull matcher is fold-aware where the publisher's is not, and agrees with it on exact spellings", () => {
    const publisher = createExclusionMatcher(["Private/"]);
    const pull = createPullExclusionMatcher(["Private/"]);
    expect(pull("private/a.md")).toBe(true);
    expect(publisher("private/a.md")).toBe(false);
    for (const [path, expected] of policy.publisherMatcher.answers) if (expected) expect(pull(path), path).toBe(true);
  });

  it("an anchored rule and a directory-only rule keep their meaning in the pull matcher", () => {
    const pull = createPullExclusionMatcher(["Archive/Old/", "scratch/"]);
    expect(pull("archive/old/a.md")).toBe(true);
    expect(pull("notes/archive/old/a.md")).toBe(false);
    expect(pull("scratch")).toBe(false);
    expect(pull("scratch", true)).toBe(true);
    expect(pull("notes/SCRATCH/x")).toBe(true);
  });
});

describe("output escaping", () => {
  it("escapes U+009B and the other C0 and C1 controls", () => {
    expect(escapeForDisplay(`a${CSI}b`)).toBe("a\\u009bb");
    expect(escapeForDisplay(`a${cp(0)}b${cp(0x1b)}c${cp(0x7f)}d${cp(0x85)}e`)).toBe("a\\u0000b\\u001bc\\u007fd\\u0085e");
    expect(escapeForDisplay("a\nb")).toBe("a\\u000ab");
  });

  it("escapes bidirectional overrides, isolates and marks", () => {
    expect(escapeForDisplay(`evil${RLO}txt.exe`)).toBe("evil\\u202etxt.exe");
    expect(escapeForDisplay(cp(0x202a, 0x202b, 0x202c, 0x202d, 0x2066, 0x2067, 0x2068, 0x2069))).toBe(
      "\\u202a\\u202b\\u202c\\u202d\\u2066\\u2067\\u2068\\u2069",
    );
    expect(escapeForDisplay(cp(0x200e, 0x200f, 0x061c))).toBe("\\u200e\\u200f\\u061c");
    expect(escapeForDisplay(`a${cp(0x2028)}b${cp(0x2029)}c`)).toBe("a\\u2028b\\u2029c");
  });

  it("leaves ordinary text, including accents, CJK and astral letters, alone", () => {
    const text = `notes/${cp(0x63, 0x61, 0x66, 0xe9)}/${cp(0x65e5, 0x672c, 0x8a9e)}${cp(0x1f600)}.md`;
    expect(escapeForDisplay(text)).toBe(text);
  });

  it("a shown skip line carries the escaped path, never the raw control character", () => {
    const refusals = evaluatePathPolicy([`a${CSI}b.md`, `gnp.${RLO}txt${cp(1)}`]).refusals;
    expect(refusals).toHaveLength(2);
    const line = summarizeRefusals(refusals);
    expect(line).toContain("a\\u009bb.md");
    expect(line).toContain("\\u202e");
    for (const char of line) expect(char === CSI || char === RLO || char.charCodeAt(0) < 0x20).toBe(false);
  });
});

describe("publisher advisory", () => {
  it("warns for CON.md and names at most three paths and a count", () => {
    const lines = adviseUnrestorablePaths(["ok.md", "CON.md", `com${SUPERSCRIPT_ONE}.txt`, "a./b.md", "x:y.md", "PRN"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("5 path(s)");
    expect(lines[0]).toContain("will not be restored");
    expect(lines[0]).toContain("and 2 more");
    expect(lines[0]).not.toContain("ok.md");
  });

  it("is silent for ordinary names", () => {
    expect(adviseUnrestorablePaths([".gitignore", "notes/ipfs-sync.md", "abc~1.md", "a/b.md"])).toEqual([]);
  });

  it("escapes a hostile path in the warning", () => {
    const [line] = adviseUnrestorablePaths([`a${CSI}b${RLO}.md`]);
    expect(line).toContain("a\\u009bb\\u202e.md");
    expect(line!.includes(CSI) || line!.includes(RLO)).toBe(false);
  });
});
