#!/usr/bin/env bash
# Publish the vault to your kubo node: stage → MFS → CID → pin → IPNS.
# Uses only the HTTP RPC API — no local ipfs daemon required.
#
# NOTE: this reverse proxy drops form-encoded args; every kubo arg is sent
# in the query string, which this node's proxy passes through correctly.
set -euo pipefail

RPC="${IPFS_RPC_URL:-https://ipfs.prometheusags.ai}"
RPC="${RPC%/}"
KEY="${IPFS_KEY:-obsidian-vault}"
VAULT_DIR="${VAULT_DIR:-$HOME/obsidian}"
EXCLUDE_FILE="$(cd "$(dirname "$0")" && pwd)/excludes.txt"
AUTH_HEADER=()
[ -n "${IPFS_RPC_TOKEN:-}" ] && AUTH_HEADER=(-H "Authorization: Bearer ${IPFS_RPC_TOKEN}")

# Per-run MFS staging area — never touches anything else in MFS.
# Override to resume an interrupted publish into the same staging dir.
MFS_ROOT="${MFS_ROOT_OVERRIDE:-/obsidian-vault-sync/publish-$(date +%Y%m%d-%H%M%S)}"

enc() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$1"; }

rpc() { # rpc <endpoint> [query args as k=v...]  → args go in the query string
  local endpoint="$1"; shift
  local qs=()
  for kv in "$@"; do qs+=(--data-urlencode "$kv"); done
  curl -sS ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} -G -X POST "$RPC/api/v0/$endpoint" ${qs[@]+"${qs[@]}"}
}

echo "→ staging vault from $VAULT_DIR"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
rsync -a --exclude-from="$EXCLUDE_FILE" "$VAULT_DIR/" "$STAGING/vault/"

FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(cd "$STAGING/vault" && find . -type f | sed 's|^\./||')
echo "→ writing ${#FILES[@]} files into MFS at $MFS_ROOT"

export RPC MFS_ROOT IPFS_RPC_TOKEN STAGING
printf '%s\0' "${FILES[@]}" | xargs -0 -n 1 -P 8 bash -c '
  rel="$1"
  hdr=(); [ -n "${IPFS_RPC_TOKEN:-}" ] && hdr=(-H "Authorization: Bearer $IPFS_RPC_TOKEN")
  enc() { python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$1"; }
  url="$RPC/api/v0/files/write?arg=$(enc "$MFS_ROOT/$rel")&create=true&parents=true&truncate=true&cid-version=1"
  out=$(curl -sS "${hdr[@]}" -X POST "$url" -F "data=@$STAGING/vault/$rel" 2>&1)
  if echo "$out" | grep -qi error; then echo "FAILED: $rel — $out" >&2; exit 1; fi
' _ 

echo "→ hashing root"
ROOT_CID="$(rpc files/stat "arg=$MFS_ROOT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Hash"])')"
echo "→ root CID: $ROOT_CID"

echo "→ pinning"
rpc pin/add "arg=$ROOT_CID" progress=false >/dev/null

echo "→ publishing to IPNS key '$KEY'"
rpc name/publish "arg=$ROOT_CID" "key=$KEY" ttl=5m >/dev/null

echo "→ cleaning MFS staging area"
rpc files/rm "arg=$MFS_ROOT" recursive=true force=true >/dev/null || true

echo "✔ published. root=$ROOT_CID key=$KEY"
