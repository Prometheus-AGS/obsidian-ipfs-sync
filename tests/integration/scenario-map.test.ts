// mvp-07a task 6.1: the map from the integration suite's tests to the scenarios of the six specs, kept here (a header table in the suite, not a
// separate document) and CHECKED by this file: every test title below must exist in the named file, every scenario must exist in its spec, and
// the scenarios no integration test names must equal the declared list `NOT_EXERCISED_HERE`, so the table cannot drift from either side.
//
// Reading the table: `spec: Scenario` is a `#### Scenario:` of openspec/changes/mvp-07-encrypted-pull-second-device/specs/<spec>/spec.md;
// `requirement:` entries name a `### Requirement:` that has no scenario of its own; `task:` entries name a line of tasks.md.
// Tests named `witness-*.test.ts` run the same driver and assertion as the guarded test with one guard removed by an in-test module seam
// (see the header of each witness file) and require the assertion to throw: they show that the scenario can fail.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SPEC_DIR = new URL("../../openspec/changes/mvp-07-encrypted-pull-second-device/", import.meta.url);
const SPECS = ["encrypted-pull", "rollback-detection", "second-device-publish", "history-naming", "path-hardening", "plugin-pull-ui"] as const;

interface Entry {
  readonly file: string;
  /** A substring of the test's title as written in the source. */
  readonly test: string;
  readonly covers: readonly string[];
}

const SCENARIO_MAP: readonly Entry[] = [
  // ---- two-device-turns -----------------------------------------------------------------------------------------------------
  { file: "two-device-turns.test.ts", test: "a declined first pull shows the authenticated sequence", covers: ["encrypted-pull: Fresh device, right passphrase", "encrypted-pull: Request audit", "rollback-detection: First pull records", "rollback-detection: Declined"] },
  { file: "two-device-turns.test.ts", test: "B cannot publish before it pulls", covers: ["second-device-publish: Other device published in between", "second-device-publish: Pull resolves it", "second-device-publish: Both edited", "second-device-publish: Unique identifiers", "second-device-publish: Stale publish", "rollback-detection: Newer state", "encrypted-pull: Conflict", "encrypted-pull: Only changes transfer"] },
  { file: "two-device-turns.test.ts", test: "a directory made by a pull publishes only after its marker", covers: ["second-device-publish: Pull then publish", "second-device-publish: Pulled marker refuses publish"] },
  { file: "two-device-turns.test.ts", test: "the pull reads it, computes the identity from its manifest", covers: ["rollback-detection: Format 2 state"] },
  { file: "two-device-turns.test.ts", test: "a publish from it goes through as sequence 2", covers: ["rollback-detection: Format 2 state", "rollback-detection: Publish advances the record"] },
  { file: "two-device-turns.test.ts", test: "a vault holding Smart Connections files publishes none of them", covers: ["task: 1.3 .smart-env/ default exclusion"] },
  { file: "two-device-turns.test.ts", test: "rewriting the embeddings makes no new sequence", covers: ["task: 1.3 .smart-env/ default exclusion"] },
  { file: "two-device-turns.test.ts", test: "an older build's manifest that lists them is skipped as expected", covers: ["task: 1.3 .smart-env/ default exclusion", "encrypted-pull: Expected skips only"] },
  { file: "two-device-turns.test.ts", test: "first pull, newer pull, same pull and restore", covers: ["encrypted-pull: Request audit"] },

  // ---- safety-guards (guarded) and the witnesses --------------------------------------------------------------------------------
  { file: "safety-guards.test.ts", test: "aborts the pull: no blob requested, nothing written", covers: ["encrypted-pull: Forged manifest", "encrypted-pull: Copy stored only after authentication"] },
  { file: "witness-forged-manifest.test.ts", test: "a plain-text manifest served as manifest.enc is accepted", covers: ["encrypted-pull: Forged manifest"] },
  { file: "safety-guards.test.ts", test: "one flipped bit fails only that file", covers: ["encrypted-pull: Tampered blob"] },
  { file: "witness-flipped-blob.test.ts", test: "the tampered blob is written to the vault", covers: ["encrypted-pull: Tampered blob"] },
  { file: "safety-guards.test.ts", test: "served by name it is refused with both sequences named", covers: ["rollback-detection: Older root served by name"] },
  { file: "witness-replayed-manifest.test.ts", test: "the older state is pulled over the newer one", covers: ["rollback-detection: Older root served by name"] },
  { file: "safety-guards.test.ts", test: "abandon moves the directory's records but not the floor", covers: ["rollback-detection: Abandon then pull older"] },
  { file: "witness-sequence-floor.test.ts", test: "the older manifest is accepted as a first pull into the abandoned directory", covers: ["rollback-detection: Abandon then pull older"] },
  { file: "safety-guards.test.ts", test: "the loser refuses at the name re-check, publishes nothing, keeps its journal", covers: ["second-device-publish: Name moved during the publish"] },
  { file: "witness-name-recheck.test.ts", test: "the loser publishes over the winner's name", covers: ["second-device-publish: Name moved during the publish"] },
  { file: "safety-guards.test.ts", test: "the loser's next pull brings the winner's sequence in", covers: ["encrypted-pull: Lost publish is set aside"] },
  { file: "safety-guards.test.ts", test: "the rerun neither publishes nor adopts", covers: ["second-device-publish: Crash, foreign publish, resume"] },
  { file: "witness-resume-recheck.test.ts", test: "the rerun no longer ends in the overlapping-publish refusal", covers: ["second-device-publish: Crash, foreign publish, resume"] },
  { file: "safety-guards.test.ts", test: "the next pull sets the journal aside, keeps this device's unpublished edit", covers: ["second-device-publish: Crash, foreign publish, resume", "encrypted-pull: Lost publish is set aside"] },
  { file: "safety-guards.test.ts", test: "the loser, after pulling the winner's sequence and running pull --resolve-fork", covers: ["second-device-publish: Loser recovers"] },
  { file: "safety-guards.test.ts", test: "the winner, whose publish completed", covers: ["second-device-publish: Loser recovers"] },

  // ---- carry-restore-history ------------------------------------------------------------------------------------------------------
  { file: "carry-restore-history.test.ts", test: "an older root by --root-cid is refused and names the flag", covers: ["rollback-detection: Restore refused by default", "rollback-detection: Restore with the flag", "rollback-detection: Publish after restore", "rollback-detection: Restore keeps newer files", "rollback-detection: Plain pull does not undo a restore", "encrypted-pull: Explicit root"] },
  { file: "carry-restore-history.test.ts", test: "the publish succeeds and carries the failed entry unchanged", covers: ["encrypted-pull: One bad blob then publish", "encrypted-pull: Retry completes", "second-device-publish: Failed file is not dropped"] },
  { file: "carry-restore-history.test.ts", test: "survives the publish of a device that skips it", covers: ["second-device-publish: Linux-only name survives a Windows device", "encrypted-pull: Platform skip is kept in the baseline"] },
  { file: "carry-restore-history.test.ts", test: "the publisher is warned that other devices will not restore the path", covers: ["path-hardening: Linux-only name"] },
  { file: "carry-restore-history.test.ts", test: "a fresh device on Linux does not write CON.md either", covers: ["second-device-publish: Windows-form name is not restored on Linux either", "path-hardening: Windows-form name survives another device"] },
  { file: "carry-restore-history.test.ts", test: "an .obsidian/ entry is skipped as expected (exit 0)", covers: ["encrypted-pull: Expected skips only", "path-hardening: Configuration file from an older build", "second-device-publish: Excluded entries are not carried"] },
  { file: "carry-restore-history.test.ts", test: "an .obsidian/plugins/ entry is skipped as unsafe (exit 1)", covers: ["encrypted-pull: Unsafe skip is loud", "path-hardening: Plugin code"] },
  { file: "carry-restore-history.test.ts", test: "a folder holding both forms is accepted by the next publish", covers: ["history-naming: Name form", "history-naming: Order without decrypting", "history-naming: Legacy accepted", "history-naming: Mixed folder"] },

  { file: "two-device-turns.test.ts", test: "a declined large pull asks before any blob", covers: ["encrypted-pull: Large pull needs a yes"] },
  { file: "two-device-turns.test.ts", test: "warns once and verifies every local file by content", covers: ["encrypted-pull: Exclusion lists differ"] },
  { file: "carry-restore-history.test.ts", test: "is not published (the carried entry is unchanged) and the next pull keeps it as a conflict copy", covers: ["second-device-publish: Local edit of an unrestored path", "encrypted-pull: Stale local copy of an unfetched file"] },
  { file: "carry-restore-history.test.ts", test: "a Note.md and note.md pair is skipped on the pulling device", covers: ["second-device-publish: Collision pair survives", "path-hardening: Case collision"] },
  { file: "hostile-node.test.ts", test: "a planted manifest.json next to the encrypted layout is never read", covers: ["encrypted-pull: Planted plaintext manifest"] },
  { file: "hostile-node.test.ts", test: "key slots without a manifest are refused", covers: ["encrypted-pull: Slots without a manifest"] },
  { file: "hostile-node.test.ts", test: "a manifest above the cap is refused without being downloaded", covers: ["encrypted-pull: Oversize manifest"] },
  { file: "hostile-node.test.ts", test: "a history entry whose manifest names another tree", covers: ["encrypted-pull: History file mismatch"] },
  { file: "hostile-node.test.ts", test: "a directory recorded for one vault does not pull another vault", covers: ["rollback-detection: Other vault"] },
  { file: "hostile-node.test.ts", test: "refuses another vault's slots, names the accept action", covers: ["encrypted-pull: Differing slots on a device with a copy"] },
  { file: "hostile-node.test.ts", test: "an expectation that fails stops the pull", covers: ["rollback-detection: Expectation failed"] },
  { file: "hostile-node.test.ts", test: "a first pull that cannot ask and was not told to accept", covers: ["rollback-detection: Non-interactive"] },
  { file: "hostile-node.test.ts", test: "--allow-rollback with a name target is refused before any request", covers: ["rollback-detection: Rollback flag with a name"] },
  { file: "hostile-node.test.ts", test: "each refused path is skipped with its class", covers: ["path-hardening: Folded folder names", "path-hardening: Windows forms", "path-hardening: Short names", "path-hardening: Ordinary tilde name", "path-hardening: Case collision", "encrypted-pull: Platform skip is kept in the baseline", "encrypted-pull: Unsafe skip is loud"] },
  { file: "plugin-ranged-pull.test.ts", test: "a plugin device that could not fetch the large file still publishes", covers: ["second-device-publish: Gateway that ignores Range"] },
  { file: "cli-two-device.test.ts", test: "a path with a C1 control character or a bidi override is skipped as unsafe and shown escaped", covers: ["encrypted-pull: Hostile path text", "path-hardening: Control characters (policy level)"] },

  { file: "hostile-node.test.ts", test: "a wrong passphrase and a damaged slot give the same stop", covers: ["encrypted-pull: Damaged slot", "encrypted-pull: Wrong passphrase"] },
  { file: "hostile-node.test.ts", test: "a root with no key-slot file is a different outcome from a wrong passphrase", covers: ["encrypted-pull: Missing slot file is different"] },
  { file: "safety-guards.test.ts", test: "deleting the state folder does not make an older manifest acceptable", covers: ["rollback-detection: Deleted state folder"] },

  // ---- fork-locks-token ---------------------------------------------------------------------------------------------------------------
  { file: "fork-locks-token.test.ts", test: "a plain pull refuses the fork and names the flag", covers: ["rollback-detection: Both devices edited the same note", "rollback-detection: Edited only here", "rollback-detection: Same sequence, different content"] },
  { file: "fork-locks-token.test.ts", test: "the record and the floor take the node manifest's identity", covers: ["rollback-detection: Both devices edited the same note", "second-device-publish: Loser recovers"] },
  { file: "fork-locks-token.test.ts", test: "with --allow-rollback and an explicit target it is still refused as a fork", covers: ["rollback-detection: Not overridable elsewhere"] },
  { file: "fork-locks-token.test.ts", test: "without a recorded ancestor every differing file gets a copy", covers: ["rollback-detection: No ancestor"] },
  { file: "fork-locks-token.test.ts", test: "is refused while a floor exists for the vault", covers: ["second-device-publish: Other device published in between", "second-device-publish: Repair ahead after the state folder was deleted", "second-device-publish: New device without a pull", "second-device-publish: Pull resolves it"] },
  { file: "fork-locks-token.test.ts", test: "with no floor for the vault the ahead case is offered", covers: ["second-device-publish: Repair ahead for a corrupt state with no floor"] },
  { file: "fork-locks-token.test.ts", test: "a pull refuses with publish's text while a publish holds the lock", covers: ["encrypted-pull: Publish in progress"] },
  { file: "fork-locks-token.test.ts", test: "a publish refuses with the lock-held error while a pull holds the lock", covers: ["encrypted-pull: Publish in progress", "requirement: Locks and read-only behaviour"] },
  { file: "fork-locks-token.test.ts", test: "releases the lock on every path of a pull", covers: ["requirement: Locks and read-only behaviour"] },
  { file: "fork-locks-token.test.ts", test: "is awaited twice by a plain publish", covers: ["requirement: Token check before the first write"] },
  { file: "fork-locks-token.test.ts", test: "before the resume of an interrupted publish: refused", covers: ["second-device-publish: Lock file replaced"] },
  { file: "fork-locks-token.test.ts", test: "before the junk in manifests/ is removed under --repair", covers: ["second-device-publish: Lock file replaced"] },
  { file: "fork-locks-token.test.ts", test: "before the publication key is ensured and the first blob is written", covers: ["second-device-publish: Lock file replaced"] },

  // ---- cli-two-device (through runCli) ------------------------------------------------------------------------------------------------
  { file: "cli-two-device.test.ts", test: "shows the authenticated sequence and device and, on a no at the prompt", covers: ["rollback-detection: Declined", "encrypted-pull: Fresh device, right passphrase", "encrypted-pull: Request audit"] },
  { file: "cli-two-device.test.ts", test: "is one failure that changes nothing", covers: ["encrypted-pull: Wrong passphrase"] },
  { file: "cli-two-device.test.ts", test: "two publishes at one sequence, then pull --resolve-fork", covers: ["rollback-detection: Both devices edited the same note", "second-device-publish: Loser recovers"] },
  { file: "cli-two-device.test.ts", test: "a no-state restore by --manifest is accepted with the flag", covers: ["rollback-detection: Restore refused by default", "rollback-detection: Restore with the flag", "task: 4.6c restore semantics"] },
  { file: "cli-two-device.test.ts", test: "the floor survives abandon and refuses the older state", covers: ["rollback-detection: Abandon then pull older", "rollback-detection: Abandon reports the floor"] },
  { file: "cli-two-device.test.ts", test: "is refused without --allow-rollback, restored with it", covers: ["rollback-detection: Restore refused by default", "rollback-detection: Restore with the flag", "rollback-detection: Publish after restore"] },
  { file: "cli-two-device.test.ts", test: "an older build's .obsidian/ entry is expected: exit 0", covers: ["encrypted-pull: Expected skips only"] },
  { file: "cli-two-device.test.ts", test: "a plugin path is unsafe: exit 1", covers: ["encrypted-pull: Unsafe skip is loud", "path-hardening: Plugin code"] },
  { file: "cli-two-device.test.ts", test: "--list-versions puts the legacy name last", covers: ["history-naming: Mixed folder", "history-naming: Legacy accepted"] },
  { file: "cli-two-device.test.ts", test: "first pull, newer pull, restore and listing send only", covers: ["encrypted-pull: Request audit"] },

  // ---- the plugin ------------------------------------------------------------------------------------------------------------------------
  { file: "plugin-ranged-pull.test.ts", test: "probes the smallest blob alone first", covers: ["encrypted-pull: Range honoured", "encrypted-pull: Probe on the smallest blob"] },
  { file: "plugin-ranged-pull.test.ts", test: "a file within the whole-body limit is fetched whole", covers: ["encrypted-pull: Gateway ignores Range, large file", "encrypted-pull: Probe on the smallest blob"] },
  { file: "plugin-second-device.test.ts", test: "pulls the vault, publishes a note as sequence 2", covers: ["second-device-publish: Pull then publish", "second-device-publish: Unique identifiers"] },
  { file: "plugin-second-device.test.ts", test: "a plugin publish before it pulls a newer sequence is refused", covers: ["second-device-publish: Other device published in between"] },
];

/**
 * Spec scenarios that no test of this suite names. The integration suite does not repeat them: each is verified, if at all, by the unit tests that
 * the owning task's Verify line in tasks.md names (the plugin-pull-ui scenarios by tests/unit/plugin-pull-*.test.ts and the dialog model tests). They are
 * listed so that a scenario cannot be forgotten silently: this test fails when a scenario is neither named above nor listed here.
 */
const NOT_EXERCISED_HERE: readonly string[] = [
  // encrypted-pull
  "encrypted-pull: Vault identifier mismatch",
  "encrypted-pull: Typo is a format error, not an oracle",
  "encrypted-pull: Blob from another path",
  "encrypted-pull: Replayed older blob",
  "encrypted-pull: Interrupted stream",
  "encrypted-pull: Files streamed in the CLI",
  "encrypted-pull: Disk write failure",
  "encrypted-pull: Restore failure does not touch the record",
  "encrypted-pull: Conflict copy cannot be written",
  "encrypted-pull: Newer journal is left",
  "encrypted-pull: Small segment size in the plugin",
  "encrypted-pull: Wrong Content-Range",
  "encrypted-pull: Payload inspection",
  "encrypted-pull: Encrypted root",
  // rollback-detection
  "rollback-detection: Re-encryption is not a fork",
  "rollback-detection: Format 3 file missing a field",
  "rollback-detection: Adopted publish",
  "rollback-detection: Statement of limits",
  "rollback-detection: Settings save cannot lower the floor",
  "rollback-detection: Two genuine entries at the ancestor prefix",
  "rollback-detection: Wrong genuine base is not used",
  "rollback-detection: Documentation",
  // second-device-publish
  "second-device-publish: Restart below the floor after the state was lost",
  "second-device-publish: Rebuild or in-step publish below the floor",
  "second-device-publish: Behind repair above the floor",
  "second-device-publish: Winner completes before the name start",
  "second-device-publish: Winner's manifest.enc found at the commit",
  "second-device-publish: Withdrawal is matched to the moved name",
  "second-device-publish: Resolution fails",
  "second-device-publish: Not found is not a failure",
  "second-device-publish: Timeout on the first publish",
  "second-device-publish: New key",
  "second-device-publish: Statement of limits",
  "second-device-publish: Other device's in-flight blobs",
  "second-device-publish: Single publisher",
  "second-device-publish: Dialog hint",
  // history-naming
  "history-naming: Junk still refused",
  "history-naming: The mvp-06 operator script",
  "history-naming: Reverted edit",
  "history-naming: Resume rewrite",
  "history-naming: Planted file",
  "history-naming: Ordering source",
  // path-hardening
  "path-hardening: Publisher exclusions unchanged",
  "path-hardening: Traversal (policy level)",
  "path-hardening: Traversal in an authentic manifest (production decode path)",
  "path-hardening: Over-long path (policy level)",
  "path-hardening: Over-long segment (policy level)",
  "path-hardening: Too many segments (policy level)",
  "path-hardening: Path over a limit in an authentic manifest (production decode path)",
  // Covered at the unit level: tests/unit/publish-path-limit-refusal.test.ts (engine) and tests/unit/cli-publish-path-limit.test.ts (CLI).
  "path-hardening: Over-limit local path on the publisher side",
  "path-hardening: One malformed path refuses the manifest",
  "path-hardening: Passing the decoder, refused by the policy",
  "path-hardening: Renamed configuration folder",
  "path-hardening: Invisible characters",
  "path-hardening: Ordinary names are not caught",
  "path-hardening: Normalisation collision",
  "path-hardening: File and directory",
  "path-hardening: Symlinked folder",
  // plugin-pull-ui
  "plugin-pull-ui: Wrong passphrase then right",
  "plugin-pull-ui: Typo detected locally",
  "plugin-pull-ui: Tampered content",
  "plugin-pull-ui: Decline",
  "plugin-pull-ui: Explicit root",
  "plugin-pull-ui: Malformed root",
  "plugin-pull-ui: Cancel",
  "plugin-pull-ui: Label does not match",
  "plugin-pull-ui: Large entry",
  "plugin-pull-ui: Only the Restore action rolls back",
  "plugin-pull-ui: Legacy entries",
  "plugin-pull-ui: Fork notice",
  "plugin-pull-ui: Ceiling",
  "plugin-pull-ui: Unfinished files are carried",
  "plugin-pull-ui: Sweep skipped while a pull holds the lock",
  "plugin-pull-ui: File edited during upload",
  "plugin-pull-ui: Sweep on load",
  "plugin-pull-ui: State display",
  "plugin-pull-ui: Hostile text in a dialog",
  "plugin-pull-ui: Keyboard",
];

interface SpecIndex {
  readonly scenarios: ReadonlySet<string>;
  readonly requirements: ReadonlySet<string>;
}

async function readSpec(name: string): Promise<SpecIndex> {
  const text = await readFile(new URL(`specs/${name}/spec.md`, SPEC_DIR), "utf8");
  const scenarios = new Set<string>();
  const requirements = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.startsWith("#### Scenario: ")) scenarios.add(`${name}: ${line.slice("#### Scenario: ".length).trim()}`);
    if (line.startsWith("### Requirement: ")) requirements.add(line.slice("### Requirement: ".length).trim());
  }
  return { scenarios, requirements };
}

describe("the map from this suite's tests to the six specs", () => {
  it("names only tests that exist: every title is in its file, and no test is named twice for one scenario list", async () => {
    const missing: string[] = [];
    for (const entry of SCENARIO_MAP) {
      const source = await readFile(new URL(entry.file, import.meta.url), "utf8");
      if (!source.includes(entry.test)) missing.push(`${entry.file}: ${entry.test}`);
    }
    expect(missing).toEqual([]);
    expect(new Set(SCENARIO_MAP.map((entry) => `${entry.file}|${entry.test}`)).size).toBe(SCENARIO_MAP.length);
  });

  it("names only scenarios, requirements and tasks that exist", async () => {
    const indexes = new Map<string, SpecIndex>();
    for (const name of SPECS) indexes.set(name, await readSpec(name));
    const allScenarios = new Set([...indexes.values()].flatMap((index) => [...index.scenarios]));
    const allRequirements = new Set([...indexes.values()].flatMap((index) => [...index.requirements]));
    const tasks = await readFile(new URL("tasks.md", SPEC_DIR), "utf8");
    const unknown: string[] = [];
    for (const covered of SCENARIO_MAP.flatMap((entry) => entry.covers)) {
      if (covered.startsWith("requirement: ")) {
        if (!allRequirements.has(covered.slice("requirement: ".length))) unknown.push(covered);
      } else if (covered.startsWith("task: ")) {
        const [, id, ...words] = covered.split(" ");
        if (!tasks.includes(`- [x] ${id} `) && !tasks.includes(`- [ ] ${id} `)) unknown.push(covered);
        if (!tasks.toLowerCase().includes(words[0]?.toLowerCase() ?? "")) unknown.push(covered);
      } else if (!allScenarios.has(covered)) {
        unknown.push(covered);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("leaves exactly the declared scenarios unnamed", async () => {
    const named = new Set(SCENARIO_MAP.flatMap((entry) => entry.covers));
    const unnamed: string[] = [];
    for (const name of SPECS) for (const scenario of (await readSpec(name)).scenarios) if (!named.has(scenario)) unnamed.push(scenario);
    expect(unnamed).toEqual(NOT_EXERCISED_HERE);
  });
});
