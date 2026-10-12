## Why

v0.4.0 shipped on 2026-10-11 as a GitHub pre-release and PR #2 merged the release branch to `main` on 2026-10-12, but the README still speaks as if the release is in flight: line ~11 says "Release 3 (v0.4.0) is being cut from this tree", lines ~18 and ~907 say "`main` keeps the old guard until the release merge", and line ~960 binds evidence "to the tree of branch `mvp-07b-guard-removal` … not to `main`". The README is the project's primary public document and the source the docs site (docs-02/docs-03) will normalize from; normalizing from a stale source would ship the staleness to a second surface.

The uncomfortable part: the assessment verified only a sample of README claims (manifest version, styles.css absence, command inventory) and found four stale statements in that sample. A README that describes itself as operator-grade has never had a claim-by-claim verification, so "fix the four known lines" is not evidence of correctness — it is evidence of the four we happened to look at. The adversarial vet therefore demanded a full inventory: every verifiable factual claim (commands, flags, defaults, limits, exit codes, file paths, versions, timings, counts) enumerated, checked against the code and the demo record, and corrected, with the inventory committed as evidence. That pass will likely surface more mismatches than the four known ones, and this proposal commits to publishing that count rather than hiding it.

## What Changes

- Fix the four stale statements identified in the docs-site assessment: L11 v0.4.0 "being cut" → shipped 2026-10-11 as a GitHub pre-release; L18/L907 "`main` keeps the old guard until the release merge" → PR #2 merged to main on 2026-10-12; L960 branch binding to `mvp-07b-guard-removal` → superseded by the merge.
- Enumerate every verifiable factual claim in README.md into a committed claim-inventory checklist under this change folder, each claim carrying its source section and line reference.
- Verify each claim against `src/`, `cli/`, `manifest.json` and `docs/operator/mvp-10-demo-record.md`; correct mismatches in README.md; record per-claim results (pass / fixed, with grep evidence for corrections) in the inventory.
- No code changes. No changes outside README.md and this change folder.

## Capabilities

### New Capabilities
- `readme-accuracy`: the README reflects the shipped release state, and every verifiable factual claim in it is enumerated, source-referenced and checked against the code of record, with results committed as evidence.

### Modified Capabilities
<!-- none: openspec/specs/ is empty; the delta is ADDED -->

## Impact

- Docs: `README.md` (corrections only, no restructuring — the site restructures it in docs-03).
- Evidence: new `openspec/changes/docs-01-readme-accuracy-pass/evidence/claim-inventory.md` (the committed checklist and its results).
- Code: none. Node: none. Dependencies: none.
- Downstream: docs-03 reads the corrected README as its normalization source; this change gates nothing in docs-02 (disjoint paths, parallel round 1 per the phase plan).
