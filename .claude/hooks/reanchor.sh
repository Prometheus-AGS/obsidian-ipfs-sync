#!/usr/bin/env bash
# SessionStart + PreCompact — re-inject position, not payload.
#
# stdout is injected into context, so this prints pointers and a handful of
# facts. It must not print file contents: re-injecting the rules on every
# compaction would defeat the reason they were made lean.

set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$PWD}"

echo "## RE-ANCHOR"

# Select only fields schemaVersion 5 actually carries. This asked for
# `{phase, task, waypoint}` until 2026-09-18; `task` and `waypoint` are not in
# that schema, so every session re-anchored on two nulls and no next step.
#
# `nextChange`/`nextTask` are derived from task state on every projection, so
# they follow completion. `exactNextCommand` is a stored operator string that
# only a plan revision or an explicit path change rewrites — it can name work
# five changes stale, so it is intent, not a selector. Print it labelled.
wp="$root/.kbd-orchestrator/current-waypoint.json"
if [[ -f "$wp" ]]; then
  if command -v jq >/dev/null 2>&1; then
    echo "Waypoint: $(jq -c '{phase, childPointer, change, currentTask, nextChange, nextTask, status}' "$wp" 2>/dev/null || echo '<unparseable>')"
    note="$(jq -r '.exactNextCommand // empty' "$wp" 2>/dev/null)"
    [[ -n "$note" ]] && echo "Operator note (intent, NOT a work selector): $note"
  else
    echo "Waypoint: $wp (jq absent; read it directly)"
  fi
else
  echo "Waypoint: none — run /kbd-init"
fi

[[ -f "$root/versions.toml" ]] && \
  echo "Pins: versions.toml is authoritative for architecture and dependencies."

echo "Authority: waypoint for position, versions.toml for decisions. READMEs go stale."

# Surface the most recent learned constraints. Three lines, not the file.
g="$root/.prometheus/gotchas.md"
if [[ -s "$g" ]]; then
  echo "Recent gotchas:"
  grep -E '^[-*] ' "$g" 2>/dev/null | tail -3 | sed 's/^/  /'
fi

echo "Rules: AGENTS.md is resident. Stack detail loads from .claude/rules/ on file read."
exit 0
