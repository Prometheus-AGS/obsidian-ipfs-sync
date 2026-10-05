// Delta review A-L2, A-L3, A-L11: the help text states the behavior the review found missing from it. Each sentence is looked for by what it must
// say (flag names, exit codes, the thing that is ignored), over whitespace changes, not by a fixed line.
import { describe, expect, it } from "vitest";
import { HELP_TEXT } from "../../cli/help-text";
import { expectDiscardCaveat } from "../helpers/abandon-discard-text";

const flat = HELP_TEXT.replace(/\s+/g, " ");

/** The option entry that starts at `flag` and runs to the next option line. */
function optionEntry(flag: string): string {
  const start = HELP_TEXT.indexOf(`\n  ${flag}`);
  expect(start, `${flag} has an option entry`).toBeGreaterThan(-1);
  const next = HELP_TEXT.slice(start + 1).search(/\n {2}(?:--|-h)/);
  return HELP_TEXT.slice(start, next === -1 ? undefined : start + 1 + next).replace(/\s+/g, " ");
}

describe("--accept-first-pull and --accept-replace (A-L2)", () => {
  it("lists --accept-replace as a pull flag, with the question it answers", () => {
    const entry = optionEntry("--accept-replace");
    expect(entry).toMatch(/pull:/);
    expect(entry).toMatch(/no state/i);
    expect(entry).toMatch(/without a terminal/i);
  });

  it("limits --accept-first-pull to the first-pull question and points at --accept-replace for the other", () => {
    const entry = optionEntry("--accept-first-pull");
    expect(entry).toMatch(/first-pull question/);
    expect(entry).toContain("--accept-replace");
  });

  it("the pull entry says a pull into a directory with no state asks, replaces differing files and keeps a dated copy", () => {
    expect(flat).toMatch(/no state for a vault this device already knows/);
    expect(flat).toMatch(/dated copy of the local text/);
    expect(flat).toMatch(/needs --accept-replace \(not --accept-first-pull\)/);
  });
});

describe("a pending rewrap or prune is resumed by running again (A-L3)", () => {
  it("keys change-passphrase and increase-cost: the rerun needs no confirming flag and ignores the rest of the command line", () => {
    expect(flat).toMatch(/run the same command again, which finishes it[^.]*\./);
    expect(flat).toMatch(/rerun needs none of the confirming flags \(--accept-no-revocation, --allow-downgrade\)/);
    expect(flat).toMatch(/everything else on that command line \(--cost, --passphrase-file\) is ignored/);
  });

  it("prune-history: the rerun needs no --yes-prune and ignores --keep", () => {
    expect(flat).toMatch(/rerun needs no --yes-prune/);
    expect(flat).toMatch(/--keep[^.]*ignored/);
  });
});

describe("the default config file and the exit codes (A-L11)", () => {
  it("--config says the default file is refused when it sets an address while a credential is configured", () => {
    const entry = optionEntry("--config <path>");
    expect(entry).toContain("rpc.url");
    expect(entry).toContain("gateway.url");
    expect(entry).toMatch(/credential/);
    expect(entry).toMatch(/exit 2/);
    expect(entry).toContain("--config <path>");
  });

  it("the exit-code section says a missing terminal with no flag exits 2 for keys, prune-history and abandon, and a declined confirmation exits 1", () => {
    const exit = flat.slice(flat.indexOf("Exit codes:"));
    expect(exit).toMatch(/keys change-passphrase, keys increase-cost, keys discard, prune-history, pull --resolve-fork and abandon/);
    // R6-L6: --resolve-fork has no confirming flag, so a terminal is the only way; the sentence says so.
    expect(exit).toMatch(/pull --resolve-fork has no confirming flag[^.]*exits 2/);
    expect(exit).toMatch(/neither a terminal[^.]*nor its confirming flag exits 2 before any request/);
    expect(exit).toMatch(/standard input, standard output and standard error must all be one/);
    expect(exit).toMatch(/asked and declined exits 1/);
  });
});

describe("--accept-first-pull covers the replace consequence on a true first pull (R5-L4)", () => {
  const entry = (): string => optionEntry("--accept-first-pull");
  const pullEntry = (): string => flat.slice(flat.indexOf("pull <vault> Bring"), flat.indexOf("abandon <vault> Abandon"));

  it("the option entry says a true first pull into a non-empty directory replaces differing files, keeps dated copies, and is covered by this flag", () => {
    expect(entry()).toMatch(/true first pull/i);
    expect(entry()).toMatch(/non-empty directory/);
    expect(entry()).toMatch(/replace/);
    expect(entry()).toMatch(/dated cop(y|ies)/);
    expect(entry()).toMatch(/covers/);
  });

  it("the pull entry says the same and still sends the no-state case to --accept-replace", () => {
    const pull = pullEntry();
    expect(pull).toMatch(/true first pull[^.]*non-empty directory[^.]*--accept-first-pull[^.]*(replace|replaces)/);
    expect(pull).toMatch(/dated cop(y|ies)/);
    expect(pull).toMatch(/needs --accept-replace \(not --accept-first-pull\)/);
  });
});

describe("R7-L2: abandon needs no node URL", () => {
  it("says in the opening paragraph that abandon needs neither the RPC URL nor the gateway URL", () => {
    const opening = flat.slice(0, flat.indexOf("Usage:"));
    expect(opening).toContain("The abandon command needs neither the RPC URL nor the gateway URL");
  });
});

describe("abandon: what it moves and what it leaves (R5-M1)", () => {
  const abandon = (): string => flat.slice(flat.indexOf("abandon <vault> Abandon"), flat.indexOf("keys change-passphrase <vault> Replace"));

  it("names all four local files, maintenance included", () => {
    const text = abandon();
    for (const name of ["keyslots.<h>.json", "state.<h>.json", "journal.<h>.json", "maintenance.<h>.json"]) expect(text).toContain(name);
  });

  it("says a pending rewrap or prune is dropped, its node write is not withdrawn, and keys discard withdraws only an unpublished rewrap, so run it first (R6-M2)", () => {
    expectDiscardCaveat(abandon());
  });
});
