# PLAN: docs-site

Project: IPFS Sync for Obsidian
Date: 2026-10-12
OpenSpec available: YES (`openspec/` at root; managed CLI v1.14.1 refreshed this phase)
Changes to implement: 4

## Recalled lessons applied (from prior-context.md)

- **"Avoid repo checkouts inside .ipfs-sync state directories"** — the repo checkout IS the vault's `.ipfs-sync/` state path; `keyslots.*.json` and `state.*.json` sit at the repo root. Consequence for docs-02: the sanitizer must forbid `keyslots.*.json` / `state.*.json` content from entering `site/`, and scaffold must not copy repo-root files.
- **"Record gitleaks byte coverage" / "Preserve production evidence in dated folders"** — the site's evidence page cites the demo record; it never mirrors raw scan artifacts.
- **"Default MVP verification demos to agent-run with recorded authorization"** — the evidence page describes the mvp-10 demo exactly as run (agent-run CLI, decision D-E), not as an operator or plugin run.
- **"External integrations require at least one real-service test"** — docs-04's exit gate is a real HTTP 200 against the deployed Pages URL, not a green workflow badge.

## CHANGE LIST (ordered)

### 1. docs-01-readme-accuracy-pass: README corrected and claim-verified against the shipped v0.4.0
- Scope: docs (README.md + evidence file)
- Depends on: NONE
- Owner role: documentation-specialist
- Est. complexity: M
- Complexity score: Medium
- Model class: frontier
- Customer value: HIGH
- Details: Fix the four stale statements found in assessment (L11 v0.4.0 "being cut", L18/L907 "main keeps the old guard", L960 branch binding). Then the full pass the adversarial vet demanded: enumerate every verifiable claim in README (commands, flags, defaults, limits, exit codes, paths, versions, timings) into an inventory, check each against `src/`, `cli/`, `manifest.json` and the demo record, correct mismatches, and store the inventory + results as committed evidence under the change folder.

### 2. docs-02-docusaurus-scaffold-branding: branded Docusaurus site skeleton with KnowMe tokens and sanitizer
- Scope: site/ (new), .gitignore
- Depends on: NONE
- Owner role: documentation-specialist
- Est. complexity: M
- Complexity score: Medium
- Model class: frontier
- Customer value: HIGH
- Details: Scaffold `site/` per `build-branded-docusaurus` (scaffold.mjs), pinning the donor's exact dependency set (Docusaurus 3.10.2, preset-classic, theme-mermaid, `@easyops-cn/docusaurus-search-local` 0.55.2, React 18.0.0, node>=20, npm lockfile inside `site/` only — repo root stays pnpm). Port the KnowMe tokens and logos from the donor (`--knowme-*` custom.css, `knowme-conviction.svg` pair), configure `SITE_URL`/`BASE_URL` env pattern for `https://prometheus-ags.github.io/obsidian-ipfs-sync/`, adapt the donor sanitizer with this repo's extra rules (keyslots/state files, home paths, bearer creds, raw wiki paths), wire it as prebuild, and pass `verify.mjs` + a production build. Reuses the donor rather than rebuilding: assessed input, verified by direct reads on 2026-10-12.

### 3. docs-03-site-content-guides: the actual documentation — how it works, desktop and mobile setup, CLI reference, security, limitations, evidence
- Scope: site/ docs content
- Depends on: docs-02
- Owner role: documentation-specialist
- Est. complexity: L
- Complexity score: High
- Model class: frontier
- Customer value: HIGH
- Details: Start from a coverage matrix (topics × source × status) that separates shipped behavior from designed-not-built, per the vet warning. Pages: home; how it works (snapshot sync, encryption, threat model normalized from DESIGN.md §8, conflict policy); desktop setup (plugin from release + CLI); mobile setup (BRAT path with the unverified/Android-untested caveats verbatim); CLI reference; security (open-RPC warning, keyslot publicity, no-recovery); limitations & troubleshooting; evidence (v0.4.0 demo summary citing `docs/operator/mvp-10-demo-record.md`, agent-run under D-E). No page may imply a default node exists. Gate: sanitizer + link check + mermaid check + production build all green.

### 4. docs-04-pages-deploy-repo-link: GitHub Pages deployment workflow, first deploy verified, repository About link
- Scope: .github/workflows/ (new), repo settings (outward)
- Depends on: docs-03
- Owner role: release-deployment-lead (sole publisher)
- Est. complexity: S
- Complexity score: Low
- Model class: medium
- Customer value: HIGH
- Details: Add a deployment-only `docs-pages.yml` adapted from the donor (pinned action SHAs, `paths: site/**`, concurrency group, no tests in CI — local gates only, per the donor's own policy comment). Enable Pages, run the first deploy, verify a real HTTP 200 on the Pages URL. **About link:** `GITHUB_TOKEN` cannot edit repo metadata (Administration write required); recommended route is a one-time operator-authorized `gh repo edit --homepage <pages-url>` after the first green deploy; a PAT-backed workflow step is the fallback only if the operator rejects the one-time step. Also record whether the deployed site satisfies the first-party-page condition for the pending v0.2.0/v0.3.0/v0.4.0 publication receipts — evaluation and recording only, no fabricated receipts.

## TASK MODEL ASSIGNMENTS

Harness: Kimi Code CLI (this session). Discovery: the Agent tool dispatches subagents with `subagent_type` only — no model or reasoning-effort control exists in the tool schema (inspected this session), so reasoning effort is **unsupported on this harness** and every route is the session's native model. Subagent dispatch verified working this session (explore agent for the skill-pack audit).

| Phase path | Change ID | Backend task ID | Requirements | Provider/model | Reasoning effort | Rationale and dated evidence | Harness and route | Worker launch and handoff | Native alternative | Availability and verification | Prerequisites |
|---|---|---|---|---|---|---|---|---|---|---|---|
| docs-site | docs-01-readme-accuracy-pass | 1.1–1.3 | high-precision prose diffing against code; moderate context (README 1,085 lines + cli/src spot checks) | kimi-code/kimi-for-coding (session native) | unsupported on harness | doc accuracy work needs careful claim-by-claim verification; session model demonstrated this in the mvp docs pass (2026-10-05 lesson) | Kimi Code, native Agent subagent | documentation-specialist role instructions; scope: README.md + change evidence dir; returns claim inventory | same | configured; verified this session | none |
| docs-site | docs-02-docusaurus-scaffold-branding | 2.1–2.5 | tool-driven scaffolding + config porting; low ambiguity; large context (donor files) | kimi-code/kimi-for-coding | unsupported | donor pins are exact and read on disk 2026-10-12; scaffold/verify scripts exist in the installed skill | Kimi Code, native Agent subagent | documentation-specialist; scope: site/, .gitignore; must not touch package.json/pnpm lockfile at root | same | configured | none |
| docs-site | docs-03-site-content-guides | 3.1–3.9 | long-form technical writing with strict accuracy constraints; largest context (README, DESIGN §8, runbook, demo record) | kimi-code/kimi-for-coding | unsupported | content must preserve exact behavioral claims (caveats verbatim); session model holds the project context | Kimi Code, native Agent subagent | documentation-specialist; scope: site/docs, site/src/pages; reads README/DESIGN/operator docs; writes coverage matrix first | same | configured | docs-02 merged |
| docs-site | docs-04-pages-deploy-repo-link | 4.1–4.4 | deterministic YAML + outward steps; low reasoning, high care on auth boundaries | kimi-code/kimi-for-coding | unsupported | donor workflow is pinned and copied with path changes; outward steps need operator authorization, not model power | Kimi Code, native Agent subagent | release-deployment-lead (sole publisher); scope: .github/workflows/, gh CLI for Pages/About | same | configured | docs-03 merged; operator authorization for outward steps |

## EXECUTION ROUND ORDER

- Round 1 (parallel, disjoint paths): docs-01 (README.md), docs-02 (site/)
- Round 2: docs-03
- Round 3: docs-04

## COMMANDS TO RUN

```
/opsx:new docs-01-readme-accuracy-pass
/opsx:new docs-02-docusaurus-scaffold-branding
/opsx:new docs-03-site-content-guides
/opsx:new docs-04-pages-deploy-repo-link
```

## Scope cuts and trade-offs (S-03)

- **Not in this phase:** OpenSpec verify/archive backlog (11 changes), cadence iteration-9 recovery, demo-root cleanup on the node, mobile sync verification (T3), CLI read cap/exclusion option. All recorded as debt; none is docs work.
- **Trade-off surfaced:** the About link cannot be set by a GitHub Action with `GITHUB_TOKEN` as the request literally asked ("the github action sets up a link in About"). The plan substitutes a one-time authorized `gh repo edit` and records the PAT fallback. If the operator insists on in-workflow automation, docs-04 task 4.3 changes shape and gains a secret-management prerequisite.
- **Trade-off surfaced:** the README will remain the deep operator-grade reference; the site restructures rather than mirrors it. Duplicating 1,085 lines into the portal would serve no reader.

PLAN COMPLETE
