#!/usr/bin/env bash
# Initialize (or resume) PMPO state for a skill. Prints the state file path.
set -euo pipefail
SKILL="${1:?usage: state-init.sh <skill-name> [mode]}"
MODE="${2:-create}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/.creator-state/$SKILL"
mkdir -p "$DIR"
STATE="$DIR/state.json"
if [ ! -f "$STATE" ]; then
  NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"skill":%s,"mode":%s,"phase":"specify","created":"%s","phases":{}}\n' \
    "$(node -p "JSON.stringify(process.argv[1])" "$SKILL")" \
    "$(node -p "JSON.stringify(process.argv[1])" "$MODE")" \
    "$NOW" > "$STATE"
  echo "initialized: $STATE"
else
  echo "resumed: $STATE"
fi
echo "$STATE"
