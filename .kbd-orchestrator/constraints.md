# KBD Constraint Configuration — IPFS Sync for Obsidian

Project-specific rules derived from the stack (TypeScript Obsidian plugin, esbuild,
Node 24 CLI) and `DESIGN.md`. KBD and all executing tools read this file
during verification.

---

## Blocking Constraints (prevent archiving until resolved)

Universal + stack-specific:

```yaml
constraints:
  - id: no-console-log-in-commits
    severity: blocking
    description: 'No console.log statements in committed TypeScript/JavaScript'
    check: "grep -r 'console\\.log' src/ cli/ --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs'"

  - id: no-any-type
    severity: blocking
    description: 'No `any` type usage in TypeScript source (tsconfig strict is on)'
    check: "grep -rn ': any\\|as any\\|<any>' src/ cli/ --include='*.ts' --include='*.tsx'"

  - id: no-hardcoded-secrets
    severity: blocking
    description: 'No hardcoded API keys, tokens, or passwords in source'
    check: "grep -rn 'sk-\\|api_key\\|API_KEY\\|secret.*=.*[\"\\x27][A-Za-z0-9]' src/ cli/"

  - id: build-passes
    severity: blocking
    description: 'Plugin bundle must build without errors'
    command: 'pnpm build'

  - id: webview-safe-bundle
    severity: blocking
    description: 'Plugin must run in Obsidian mobile WebView — no Node built-ins, no child_process, no native modules in src/'
    check: "grep -rn \"require('child_process')\\|require('fs')\\|require('path')\\|from 'node:\\|from 'fs'\\|from 'child_process'\" src/"

  - id: no-python
    severity: blocking
    description: 'No Python in this project: no *.py files, no python invocations in scripts, hooks or package scripts (spec 004)'
    check: "git ls-files '*.py' | grep . ; grep -rIn 'python' package.json cli/ tools/ .github/ 2>/dev/null"

  - id: kubo-args-in-query-string
    severity: blocking
    description: 'All kubo RPC args must travel in the query string (the prometheusags proxy drops form-encoded args)'
    note: 'Review every fetch/curl against the node; see README §node-quirks'
```

---

## Warning Constraints (acknowledge before archiving)

```yaml
- id: tests-for-new-features
  severity: warning
  description: 'Tests exist for all new features added in this change'
  note: 'No test runner wired yet; add one before Phase 1.1 implementation'

- id: no-stub-comments
  severity: warning
  description: 'No TODO/FIXME/STUB/HACK comments in committed code'
  check: "grep -rn 'TODO\\|FIXME\\|STUB\\|HACK' src/"

- id: design-doc-sync
  severity: warning
  description: 'DESIGN.md reflects the implemented behavior (schema changes, MFS layout, conflict policy)'
  note: 'Manual review required at archive time'

- id: never-sync-workspace-state
  severity: warning
  description: 'The exclusion definition (src/sync/exclusions.ts) keeps .trash/, workspace.json churn, and this dev folder out of sync payloads'
  check: "test \"$(grep -ohE '\"\\.trash/\"|\"\\.ipfs-sync/\"|\"\\.obsidian/\"' src/sync/exclusions.ts | sort -u | wc -l | tr -d ' ')\" = 3"
  note: 'Moved from scripts/excludes.txt in mvp-02 (task 2.2); passes whether or not scripts/excludes.txt exists. Updated 2026-10-03 (operator decision): mvp-07a task 1.3 replaced the individual .obsidian/workspace*.json, graph.json, cache and plugins/ entries with one ".obsidian/" entry that excludes the whole configuration folder (stricter, workspace state still never syncs), so the check now looks for that literal instead of ".obsidian/workspace.json"'
```

---

## Workflow Triggers

These run after each change iteration:

```yaml
workflow_triggers:
  - event: on_iteration_complete
    action:
      type: command
      target: 'pnpm build'

  - event: on_refinement_complete
    action:
      type: command
      target: "git add -A && git commit -m 'kbd: refine <change-id>'"
```

---

## Project-Specific Overrides

# Project: IPFS Sync for Obsidian
# Added: 2026-09-29
#
# Notes for executing agents:
# - The kubo node at ipfs.prometheusags.ai is production infra shared with other
#   projects (existing IPNS keys: consult-capture, gomark-relay-lab, prince-live).
#   Never key/rm, pin/rm, or name/publish to keys you did not create.
# - MFS path /obsidian-vault-staging holds pre-existing content from a prior
#   attempt — do not delete it. This project uses /obsidian-vault-sync/* only.
# - The RPC endpoint is unauthenticated as of init; treat all published content
#   as public until DESIGN.md §5 server hardening lands.
# - Conflict policy (Phase 1/1.1): on pull, remote wins; local content preserved
#   as `name (ipfs conflict YYYY-MM-DD)`. Never silently lose local data.
constraints:
  - id: no-destructive-node-ops
    severity: blocking
    description: 'No key/rm, pin/rm, or files/rm outside /obsidian-vault-sync/* on the shared node'
    note: 'All node mutations must target paths/keys created by this project'
