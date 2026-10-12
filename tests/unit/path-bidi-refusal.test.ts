// mvp-07b task 7.6 (operator decision, decision-log 2026-10-05): a path with a bidirectional override or isolate
// (U+202A to U+202E, U+2066 to U+2069) is refused as unsafe/shape on the pull and refused by name on the publish.
// The implicit marks U+200E and U+200F, and ordinary Arabic and Hebrew names, stay accepted. Code points are built
// from numbers so no invisible character sits in the source.
import { describe, expect, it } from "vitest";
import { escapeForDisplay, evaluatePathPolicy, refusePath } from "../../src/sync/path-policy";
import { PublishRefusedError } from "../../src/sync/publish-refusals";
import { createRig, seedVault } from "../helpers/publish-rig";

const cp = (...codePoints: number[]): string => String.fromCodePoint(...codePoints);

const BIDI_CODE_POINTS = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069] as const;
const hexOf = (codePoint: number): string => `U+${codePoint.toString(16).toUpperCase()}`;

describe("the pull policy refuses bidirectional overrides and isolates as unsafe/shape", () => {
  it("refuses the spoofed extension from the review finding", () => {
    expect(refusePath(`invoice${cp(0x202e)}txt.exe`)).toMatchObject({ severity: "unsafe", class: "shape", code: "bidi-control" });
  });

  for (const codePoint of BIDI_CODE_POINTS) {
    it(`${hexOf(codePoint)} is refused in a file name, at the start, and in a folder segment`, () => {
      const mark = cp(codePoint);
      for (const path of [`a${mark}b.md`, `${mark}a.md`, `a.md${mark}`, `Folder${mark}x/note.md`]) {
        expect(refusePath(path), path).toMatchObject({ severity: "unsafe", class: "shape", code: "bidi-control" });
      }
    });
  }

  it("evaluates a manifest: the bidi paths are refused with a fixed reason that never echoes the path, the others are accepted", () => {
    const hostile = BIDI_CODE_POINTS.map((codePoint) => `n${cp(codePoint)}.md`);
    const result = evaluatePathPolicy(["ok.md", ...hostile]);
    expect(result.accepted).toEqual(["ok.md"]);
    expect(result.refusals.map((refusal) => refusal.path).sort()).toEqual([...hostile].sort());
    for (const refusal of result.refusals) {
      expect(refusal).toMatchObject({ severity: "unsafe", class: "shape", code: "bidi-control" });
      for (const codePoint of BIDI_CODE_POINTS) expect(refusal.reason).not.toContain(cp(codePoint));
    }
  });

  it("still accepts the implicit marks U+200E and U+200F", () => {
    expect(refusePath(`a${cp(0x200e)}b.md`)).toBeUndefined();
    expect(refusePath(`a${cp(0x200f)}b.md`)).toBeUndefined();
  });

  it("still accepts ordinary Arabic and Hebrew names, with and without implicit marks", () => {
    const names = [
      "ملاحظات/مذكرة اجتماع.md",
      "הערות/סיכום פגישה.md",
      `הערות/${cp(0x200f)}סיכום${cp(0x200f)} (2026).md`,
      `ملاحظات/${cp(0x200e)}Plan${cp(0x200e)} خطة.md`,
    ];
    for (const name of names) expect(refusePath(name), name).toBeUndefined();
    expect(evaluatePathPolicy(names).refusals).toEqual([]);
  });

  it("does not change what is shown: every one of the nine is still escaped for display", () => {
    for (const codePoint of BIDI_CODE_POINTS) {
      expect(escapeForDisplay(`a${cp(codePoint)}b`)).toBe(`a\\u${codePoint.toString(16)}b`);
    }
    expect(escapeForDisplay(`evil${cp(0x202e)}txt.exe`)).toBe("evil\\u202etxt.exe");
    expect(escapeForDisplay(`a${cp(0x200e)}b${cp(0x200f)}`)).toBe("a\\u200eb\\u200f");
  });
});

describe("the publisher refuses a local file with a bidirectional override or isolate, by escaped name, before anything is sent", () => {
  const MUTATING = /^(write|rm|pin|publish|keyGen) /;
  const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

  async function refusedPublish(paths: readonly string[]): Promise<{ readonly error: unknown; readonly sent: string[] }> {
    const rig = createRig();
    seedVault(rig.host);
    await rig.init();
    for (const path of paths) rig.host.put(path, "body", 2000);
    rig.node.calls.length = 0;
    const error = await rejection(rig.publish());
    return { error, sent: rig.node.calls.filter((call) => MUTATING.test(call)) };
  }

  it("names the file with the override shown as an escape, never as the raw character", async () => {
    const { error, sent } = await refusedPublish([`Invoices/invoice${cp(0x202e)}txt.exe`]);
    expect(error).toBeInstanceOf(PublishRefusedError);
    expect(error).toMatchObject({ code: "path-bidi-control" });
    const message = (error as Error).message;
    expect(message).toContain("invoice\\u202etxt.exe");
    expect(message).toMatch(/not published/);
    expect(message).toMatch(/Rename/);
    expect(message).not.toContain(cp(0x202e));
    expect(sent).toEqual([]);
  });

  for (const codePoint of BIDI_CODE_POINTS) {
    it(`${hexOf(codePoint)} in a local name refuses the publish`, async () => {
      const { error, sent } = await refusedPublish([`n/a${cp(codePoint)}b.md`]);
      expect(error).toMatchObject({ code: "path-bidi-control" });
      expect((error as Error).message).toContain(`a\\u${codePoint.toString(16)}b.md`);
      expect(sent).toEqual([]);
    });
  }

  it("names the first three offenders and counts the rest", async () => {
    const { error } = await refusedPublish([1, 2, 3, 4, 5].map((n) => `n/x${cp(0x202e)}${n}.md`));
    expect(error).toMatchObject({ code: "path-bidi-control" });
    expect((error as Error).message).toMatch(/and 2 more/);
  });

  it("U+200E, U+200F and Arabic and Hebrew names still publish", async () => {
    const rig = createRig();
    seedVault(rig.host);
    await rig.init();
    rig.host.put(`n/a${cp(0x200e)}b${cp(0x200f)}.md`, "b", 2000);
    rig.host.put("n/ملاحظات.md", "b", 2000);
    rig.host.put("n/הערות.md", "b", 2000);
    await expect(rig.publish()).resolves.toMatchObject({ published: true });
  });
});
