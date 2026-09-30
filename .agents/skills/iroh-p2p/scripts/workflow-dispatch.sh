#!/usr/bin/env bash
# Dispatch hook point. Records the event; a real dispatcher (KBD workflow
# engine) can replace the body without changing hooks.json.
set -euo pipefail
EVENT="${1:?usage: workflow-dispatch.sh <event> [arg]}"
ARG="${2:-}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"event":%s,"arg":%s,"at":"%s"}\n' \
  "$(node -p "JSON.stringify(process.argv[1])" "$EVENT")" \
  "$(node -p "JSON.stringify(process.argv[1])" "$ARG")" \
  "$NOW" >> "$(dirname "$0")/../.creator-state/dispatch.log"
echo "dispatched: $EVENT ${ARG}"
