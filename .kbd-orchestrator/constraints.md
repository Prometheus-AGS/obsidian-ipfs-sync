# KBD Constraint Configuration — IPFS Sync for Obsidian

Project-specific rules derived from the stack (TypeScript Obsidian plugin, esbuild,
bash CLI scripts) and `DESIGN.md`. KBD and all executing tools read this file
during verification.

---

## Blocking Constraints (prevent archiving until resolved)

Universal + stack-specific:

```yaml
constraints:
  - id: no-console-log-in-commits
    severity: blocking
    description: 'No console.log statements in committed TypeScript/JavaScript'
    check: "grep -r 'console\\.log' src/ --include='*.ts' --include='*.tsx' --include='*.js'"

  - id: no-any-type
    severity: blocking
    description: 'No `any` type usage in TypeScript source (tsconfig strict is on)'
    check: "grep -rn ': any' src/ --include='*.ts' --include='*.tsx'"

  - id: no-hardcoded-secrets
    severity: blocking
    description: 'No hardcoded API keys, tokens, or passwords in source or scripts'
    check: "grep -rn 'sk-\\|api_key\\|API_KEY\\|secret.*=.*[\"\\x27][A-Za-z0-9]' src/ scripts/"

  - id: build-passes
    severity: blocking
    description: 'Plugin bundle must build without errors'
    command: 'npm run build'

  - id: webview-safe-bundle
    severity: blocking
    description: 'Plugin must run in Obsidian mobile WebView — no Node built-ins, no child_process, no native modules in src/'
    check: "grep -rn \"require('child_process')\\|require('fs')\\|require('path')\\|from 'node:\\|from 'fs'\\|from 'child_process'\" src/"

  - id: bash-32-compatible-scripts
    severity: blocking
    description: 'scripts/*.sh must run on macOS stock bash 3.2 (no mapfile; empty arrays guarded under set -u)'
    check: "grep -n 'mapfile' scripts/*.sh; grep -n '\\"\\${[A-Z_]*\\[@\\]}\\"' scripts/*.sh"

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
  check: "grep -rn 'TODO\\|FIXME\\|STUB\\|HACK' src/ scripts/"

- id: design-doc-sync
  severity: warning
  description: 'DESIGN.md reflects the implemented behavior (schema changes, MFS layout, conflict policy)'
  note: 'Manual review required at archive time'

- id: never-sync-workspace-state
  severity: warning
  description: 'Default exclusions keep .trash/, workspace.json churn, and this dev folder out of sync payloads'
  check: "grep -c 'workspace.json' scripts/excludes.txt"
```

---

## Workflow Triggers

These run after each change iteration:

```yaml
workflow_triggers:
  - event: on_iteration_complete
    action:
      type: command
      target: 'npm run build'

  - event: on_change_complete
    action:
      type: command
      target: 'bash -n scripts/publish.sh && bash -n scripts/pull.sh'

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
