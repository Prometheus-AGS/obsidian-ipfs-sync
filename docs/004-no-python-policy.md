# Spec 004 — Toolchain Policy: No Python

Status: **spec for later reference — no phases started.**

## The rule

**No Python anywhere in this project**: not in scripts, not in tooling, not in
CI, not as a "temporary" helper. If a problem looks like it needs Python, the
answer is TypeScript (Node 24+) or Rust (CLI/WASM).

## Rationale

Python is the fragile option across this project's target platforms: Windows
has no system Python and `py` launcher roulette; macOS's system Python is a
version trap managed differently per macOS release; "just venv it" doesn't
survive contact with users' machines. One runtime (Node 24+) with native TS
type-stripping gives us one install command on every desktop OS, and the plugin
surface is TypeScript anyway — fewer languages, fewer failure modes.

## Current violations and their migration

| Where | Python use | Replacement (per spec 001) |
|---|---|---|
| `scripts/publish.sh` | `python3` URL-encoding + JSON parsing | `URLSearchParams` / `JSON.parse` in Node scripts |
| `scripts/pull.sh` | `python3` JSON parsing | same |

Both shell scripts are deleted wholesale in the migration phase — the Python
goes with them.

## Enforcement

When phases start, add to `.kbd-orchestrator/constraints.md` (blocking):

```yaml
- id: no-python
  severity: blocking
  description: 'No Python files or python invocations in this repo'
  check: "find . -name '*.py' -not -path './node_modules/*' | grep . ; grep -rn 'python' scripts/ package.json --include='*.json' --include='*.sh'"
```

CI gate: a workflow step that fails on `*.py` outside `node_modules`.

## Approved toolchains (complete list)

1. **TypeScript / JavaScript on Node 24+** — scripts, CLI, plugin, CI logic.
2. **Rust** — compiled to WASM (spec 003) or, only when OS access is genuinely
   required, per-platform CLI binaries distributed via GitHub Releases.
3. **Bash** — permitted only as one-line npm script wrappers
   (`"build": "node esbuild.config.mjs production"`); no logic, no conditionals,
   no pipelines.

Everything else (including Python, and including "tiny" Python one-liners in
docs examples) is out of policy.
