#!/usr/bin/env bash
# PostToolUse:Edit|Write — warn when a second session writes the same tree.
#
# The tool has already run by the time this fires, so exit 2 cannot prevent
# the write. It surfaces the collision to the model loudly, which is the only
# useful action left at this point. Prevention belongs in worktrees.
#
# Lock is advisory and stale after 4 hours, so an abandoned session does not
# wedge the next one.

set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$PWD}"
lock="$root/.prometheus/.writer.lock"
me="${CLAUDE_SESSION_ID:-pid-$PPID}"
now="$(date +%s)"
stale_after=14400

mkdir -p "$(dirname "$lock")" 2>/dev/null || exit 0

if [[ -f "$lock" ]]; then
  holder="$(head -1 "$lock" 2>/dev/null || true)"
  since="$(sed -n '2p' "$lock" 2>/dev/null || echo 0)"
  [[ "$since" =~ ^[0-9]+$ ]] || since=0
  age=$(( now - since ))

  if [[ -n "$holder" && "$holder" != "$me" && "$age" -lt "$stale_after" ]]; then
    cat >&2 <<EOF
SINGLE-WRITER COLLISION — another session holds the writer lock on this tree.

  holder:  $holder
  held:    ${age}s ago
  lock:    $lock

Two agents writing one tree produce interleaved edits and a build that
belongs to neither. Stop and move to a git worktree with its own build
directory, or confirm the other session has ended and remove the lock.
EOF
    exit 2
  fi
fi

printf '%s\n%s\n' "$me" "$now" > "$lock" 2>/dev/null || true
exit 0
