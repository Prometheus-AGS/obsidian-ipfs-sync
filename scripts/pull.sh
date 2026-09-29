#!/usr/bin/env bash
# Pull the published vault snapshot from your kubo node, conflict-safe.
# Never deletes local files; differing newer files are kept, remote versions
# land as " (ipfs conflict YYYY-MM-DD)" copies via rsync backup semantics.
set -euo pipefail

RPC="${IPFS_RPC_URL:-https://ipfs.prometheusags.ai}"
RPC="${RPC%/}"
KEY="${IPFS_KEY:-obsidian-vault}"
VAULT_DIR="${VAULT_DIR:-$HOME/obsidian}"
EXCLUDE_FILE="$(cd "$(dirname "$0")" && pwd)/excludes.txt"
AUTH_HEADER=()
[ -n "${IPFS_RPC_TOKEN:-}" ] && AUTH_HEADER=(-H "Authorization: Bearer ${IPFS_RPC_TOKEN}")

rpc() {
  local endpoint="$1"; shift
  local qs=()
  for kv in "$@"; do qs+=(--data-urlencode "$kv"); done
  curl -sS ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} -G -X POST "$RPC/api/v0/$endpoint" ${qs[@]+"${qs[@]}"}
}

KEY_ID="$(rpc key/list | python3 -c 'import json,sys; ks=json.load(sys.stdin)["Keys"]; print(next((k["Id"] for k in ks if k["Name"]=="'"$KEY"'"), ""))')"
[ -n "$KEY_ID" ] || { echo "✘ IPNS key '$KEY' not found on node"; exit 1; }

ROOT_CID="$(rpc name/resolve "arg=/ipns/$KEY_ID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Path"].removeprefix("/ipfs/"))')"
echo "→ resolved /ipns/$KEY_ID → $ROOT_CID"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ downloading snapshot"
curl -sS ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} -G -X POST "$RPC/api/v0/get" \
  --data-urlencode "arg=$ROOT_CID" --data-urlencode archive=true -o "$TMP/vault.tar"
tar -xf "$TMP/vault.tar" -C "$TMP"
rm "$TMP/vault.tar"

echo "→ merging into $VAULT_DIR (conflict-safe, no deletions)"
rsync -a -b --suffix=" (ipfs conflict $(date +%Y-%m-%d))" --exclude-from="$EXCLUDE_FILE" "$TMP/$ROOT_CID/" "$VAULT_DIR/"

echo "✔ pull complete. root=$ROOT_CID"
