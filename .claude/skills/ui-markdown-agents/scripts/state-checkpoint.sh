#!/usr/bin/env bash
# Checkpoint: mark a PMPO phase complete in the skill state file.
set -euo pipefail
SKILL="${1:?usage: state-checkpoint.sh <skill-name> <phase>}"
PHASE="${2:?usage: state-checkpoint.sh <skill-name> <phase>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.creator-state/$SKILL/state.json"
[ -f "$STATE" ] || { echo "state missing — run state-init.sh first" >&2; exit 1; }
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node -e '
  const [statePath, phase, now] = process.argv.slice(1);
  const fs = require("fs");
  const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
  s.phases[phase] = { completedAt: now };
  const order = ["specify", "plan", "execute", "reflect"];
  const idx = order.indexOf(phase);
  if (idx >= 0 && idx < order.length - 1) s.phase = order[idx + 1];
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2) + "\n");
' "$STATE" "$PHASE" "$NOW"
echo "checkpoint: $SKILL $PHASE @ $NOW"
