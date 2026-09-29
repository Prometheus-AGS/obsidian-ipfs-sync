#!/usr/bin/env bash
# PreToolUse:Bash — block final artifact commands outside a deliberate release gate.
#
# Contract: exit 0 allows, exit 2 blocks and feeds stderr back to the model.
# Any other exit is a hook error and does not block, so every failure path
# below exits 0 deliberately. A guard that blocks because jq is missing is
# worse than one that does not fire.
#
# Waypoint schema note (measured across the estate 2026-08-09): `.phase` holds
# a phase IDENTITY ("uar-uiux-full-migration-2026-08"), not a lifecycle state.
# `.status` holds the lifecycle ("running", "execute_ready", "completed").
# An earlier version matched .phase against milestone|release|certify, which no
# real waypoint could ever satisfy — it blocked release commands unconditionally with no
# reachable unblock path. Read .status, and provide explicit opt-ins.

set -uo pipefail

input="$(cat 2>/dev/null || true)"

if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || true)"
else
  cmd="$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -1)"
fi
[[ -n "$cmd" ]] || exit 0

t3='cargo build.*--release|cargo test.*--release|tauri build|flutter build (ios|apk|appbundle)|go test.*-race|wasm-pack test --headless|playwright test'
printf '%s' "$cmd" | grep -Eq "$t3" || exit 0

root="${CLAUDE_PROJECT_DIR:-$PWD}"
waypoint="$root/.kbd-orchestrator/current-waypoint.json"

# --- explicit opt-ins, checked first: both are deliberate and reversible ---
[[ "${PROMETHEUS_TIER3:-0}" == "1" ]] && exit 0
[[ -f "$root/.kbd-orchestrator/tier3.allow" ]] && exit 0

status=""; phase=""
if [[ -f "$waypoint" ]] && command -v jq >/dev/null 2>&1; then
  status="$(jq -r '.status // ""' "$waypoint" 2>/dev/null || true)"
  phase="$(jq -r '.phase // ""' "$waypoint" 2>/dev/null || true)"
fi

# Lifecycle states in which final artifact production is expected.
if printf '%s' "$status" | grep -qiE '^(completed|complete|release|releasing|certify|certified|milestone|delivery)'; then
  exit 0
fi

cat >&2 <<EOF
FINAL ARTIFACT GATE — release command outside a completed change or release boundary.

  command: $cmd
  status:  ${status:-<unknown>}
  phase:   ${phase:-<unknown>}
  source:  $waypoint

Release and cross-platform artifact commands run at milestone, release, or certification. A release build during
implementation invalidates the incremental cache and pays full optimization
for code that is about to change.

Finish the coherent implementation and run the smallest relevant integration gate,
or open the final-artifact gate deliberately:

  PROMETHEUS_TIER3=1 <command>          # one command
  touch .kbd-orchestrator/tier3.allow   # this session; delete when done

Do not edit the waypoint to get past this — it is the position record, not a
permission switch.
EOF
exit 2
