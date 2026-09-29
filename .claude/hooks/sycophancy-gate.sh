#!/usr/bin/env bash
# Stop — hold completion until a pending review passes the sycophancy gate.
#
# Fires only when .prometheus/.review-pending exists. Something must create
# that marker (a phase-completion step, or the operator) or this hook is inert
# by design — a Stop hook that fires on every turn is a tax, not a gate.
#
# exit 2 forces the model to keep working. The harness overrides a Stop hook
# after ~8 consecutive blocks, so this cannot wedge a session permanently.

set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$PWD}"
marker="$root/.prometheus/.review-pending"
[[ -f "$marker" ]] || exit 0

# Locate the checker. Absent binary degrades to a warning, never a hard block.
checker=""
for c in \
  "$root/scripts/check-findings-sycophancy.sh" \
  "$root/.claude/hooks/check-findings-sycophancy.sh" \
  "$(command -v sycophancy-correction 2>/dev/null || true)"
do
  [[ -n "$c" && -x "$c" ]] && { checker="$c"; break; }
done

if [[ -z "$checker" ]]; then
  echo "sycophancy-gate: no checker found; review NOT verified (marker: $marker)" >&2
  rm -f "$marker" 2>/dev/null || true
  exit 0
fi

err="$(mktemp 2>/dev/null || echo /tmp/syco.$$)"
if "$checker" >"$err" 2>&1; then
  rm -f "$marker" "$err" 2>/dev/null || true
  exit 0
fi

{
  echo "ANTI-SYCOPHANCY GATE — the pending review did not pass."
  echo
  sed -n '1,40p' "$err"
  echo
  echo "Fix the findings. Do not delete the marker to get past this."
  echo "A reflection leads with the delta, not with what worked."
} >&2
rm -f "$err" 2>/dev/null || true
exit 2
