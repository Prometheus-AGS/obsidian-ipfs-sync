#!/usr/bin/env bash
# Finalize: mark the skill creation/refinement run complete.
set -euo pipefail
SKILL="${1:?usage: state-finalize.sh <skill-name>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.creator-state/$SKILL/state.json"
[ -f "$STATE" ] || { echo "state missing" >&2; exit 1; }
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node -e '
  const [statePath, now] = process.argv.slice(1);
  const fs = require("fs");
  const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
  s.phase = "finalized";
  s.finalizedAt = now;
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2) + "\n");
' "$STATE" "$NOW"
echo "finalized: $SKILL @ $NOW"
