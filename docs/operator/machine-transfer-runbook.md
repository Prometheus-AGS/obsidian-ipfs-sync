# Operator runbook: transfer all work to the Mac Pro

Audience: the operator moving day-to-day work off the MacBook onto a Mac Pro 2019 (96 GB RAM, Obsidian desktop
already installed). Written 2026-10-12 from a same-day inventory of the source machine; the commands below were
not run end-to-end on the target — where a message differs from what you see, the code and the shell output win
and this file is stale.

Scope: the git repo, the vault's ipfs-sync device identity and sync state, the vault content, the toolchain, and
the Prometheus agent substrate in the home directory. The goal is resource offload, not credential rotation.

**The uncomfortable part.** This runbook has never been executed. Every command is grounded in the 2026-10-12
inventory or in standard macOS/git/rsync/launchctl behaviour, but no step has been observed on the Mac Pro. And
the recommended identity path (adopt, below) deliberately leaves a second, live copy of the vault's key slots on
the source machine until you retire it — two machines can open the vault for as long as both copies exist.

## 1. Scope and decision summary

What moves:

- **The repo** — via git. Remote `git@github.com:Prometheus-AGS/obsidian-ipfs-sync.git`, main HEAD `1e53e71`,
  fully pushed, zero unpushed commits (verified 2026-10-12). Nothing is carried by hand.
- **Vault sync state** — via the staged transfer bundle
  `~/ipfs-sync-transfer-2026-10-12/vault-sync-state-f6720bcd22c0ded6.tar.gz` (5,537,660 bytes, directory mode
  700), tarred anchored at `$HOME` so paths are self-documenting on restore. It holds
  `obsidian/.ipfs-sync/keyslots.f6720bcd22c0ded6.json` (594 bytes, mode 600 — this device's identity for vault
  `f6720bcd22c0ded6`), `obsidian/.ipfs-sync/state.f6720bcd22c0ded6.json` (2.3 MB),
  `obsidian/.ipfs-sync/.opencode/opencode-loop/` (one 4 KB session file), and the CLI per-user state directory
  `Library/Application Support/ipfs-sync/` (38 MB — `device-id`, `sequence-floor.json`, `feature-ops/`, and the
  `history/` operation database). SHA-256
  `408365354b9ff9934c54412c01b4e62d8a17a52fcbd83455f388c470a45c01e9` is recorded in
  `~/ipfs-sync-transfer-2026-10-12/SHA256SUMS`.
- **Vault content** — ≈1 GB of actual notes (the vault totals 2.3 GB, of which 1.3 GB is the `.ipfs-sync/` repo
  checkout that does not move as part of the vault).
- **The CLI per-user state directory** — `~/Library/Application Support/ipfs-sync/` on the source holds
  `device-id`, `sequence-floor.json`, `feature-ops/` and the `history/` operation database. It is device-local
  (never synced, never published, `$XDG_STATE_HOME/ipfs-sync` overrides the location per
  `cli/device-store-node.ts`) and it IS in the bundle. Adopting the device identity (decision (a)) requires it —
  otherwise the Mac Pro is a fresh CLI device with no device-id, no sequence floor, and an empty operation log.
- **Toolchain** — fresh installs on the target (§3), not copies.
- **Agent substrate** — `~/.kimi-code`, selected `~/.prometheus` subtrees, `~/.local/bin` binaries, and the
  LaunchAgents fleet (§5).

What does NOT move:

- **The local kubo repo** (`~/.ipfs`, 694 MB, `~/go/bin/ipfs` v0.44.0-dev, API 127.0.0.1:5001, gateway 8082).
  No ipfs daemon is running on the source and it is not the sync target — the sync node is the remote
  `https://ipfs.prometheusags.ai`. The local kubo is dev/test residue. Optional; skip it unless you want local
  testing on the Mac Pro too.
- `~/.prometheus/backups` (13G), `~/.prometheus/recovery` (6.6G), `~/.prometheus/repair-backups` (4.9G) — ≈24.5G
  of history. Excluded below; archive separately only if wanted.
- `*.bak` / `*.deprecated` LaunchAgent files. Do not transfer.
- `~/.kimi-code/sessions/` — session logs; optional, excluded by default below.

Two decisions the operator makes before starting:

**(a) Device identity: adopt vs pair as new.**

- **Adopt (recommended)** — restore the bundle's keyslots and state onto the Mac Pro. The Mac Pro becomes the
  same device as far as the vault is concerned: sequence continuity is preserved, the single-writer record
  carries over, no new key slot is written. This matches the goal (offload resources), not a rotation.
- **Pair as new device** — cleaner security posture (the MacBook's key material never lands on the Mac Pro), but
  it requires the SPAKE2 pairing flow and the second-device adoption steps in
  `docs/operator/encrypted-vault.md` ("Second device": same MFS root and publication key name, the owned key
  adopted, pull before publish). Choose this only if you also intend to revoke the MacBook's slot afterwards.

**(b) Vault content: LAN copy vs fresh encrypted pull.**

- **LAN copy (recommended)** — rsync the ≈1 GB of notes over the LAN. Fast. Then run one pull on the target to
  verify sync health against the remote node.
- **Fresh encrypted pull** — `ipfs-sync pull` from `https://ipfs.prometheusags.ai` into an empty directory.
  Slower, but it exercises the product's restore path on a second desktop host. A legitimate verification choice
  if you have the time; the runbook covers the LAN path and notes the pull as its verification step either way.

## 2. Target layout (retires the repo-in-state-dir smell)

On the source machine the repo checkout *is* the vault's `.ipfs-sync/` state directory. That is a known
structural smell, and the recalled lesson is explicit: **do not place repo checkouts inside `.ipfs-sync/`.**
The transfer retires it on the target:

| What | Source (MacBook) | Target (Mac Pro) |
|---|---|---|
| Repo checkout | `/Users/gqadonis/obsidian/.ipfs-sync` | `~/Projects/obsidian-ipfs-sync` (NOT inside the vault) |
| Vault | `/Users/gqadonis/obsidian` | `~/obsidian` (or operator's choice) |
| Plugin state dir | same as repo checkout | `<vault>/.ipfs-sync/` — a pure state directory created by the plugin; the bundle's keyslots + state are restored into it |
| Passphrase file | outside the vault (operator's encrypted `Keys and Stuff.md` record) | outside the vault, mode 600 |

Nothing on the target should make `<vault>/.ipfs-sync/` a git worktree again.

## 3. Prerequisites on the Mac Pro

Install Xcode Command Line Tools and Homebrew if absent, then the toolchain at the source-machine versions
(inventory 2026-10-12):

```bash
xcode-select --install        # if needed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"  # if needed

brew install node jq gh git
brew install pnpm             # or: npm install -g pnpm@12.8.1
```

Reference versions from the source: node v26.8.2 (Homebrew, `/opt/homebrew/bin`), pnpm 12.8.1, npm 11.16.0,
git 2.54.0, gh 2.102.0, jq 1.8.2. Exact version parity is not required for brew packages; the one hard rule is
PATH order below.

**PATH rule.** On the source the shell-default node is v24.11.1 via the "TheBoss" commands path and it breaks
some test spawns; the working node is Homebrew's v26.8.2. Put `/opt/homebrew/bin` first in PATH on the target
(in `~/.zshrc`), and verify:

```bash
export PATH="/opt/homebrew/bin:$PATH"
node --version    # expect v26.x, NOT v24.x
```

GitHub access:

```bash
gh auth login     # or export GITHUB_TOKEN from your records — never paste it into a file that syncs
```

The repo clones over ssh (`git protocol ssh` on the source), so the Mac Pro needs an ssh key registered with
GitHub: `ssh-keygen -t ed25519` if none exists, add the public key at github.com, then
`ssh -T git@github.com` to confirm.

**Prometheus substrate binaries (optional for first sync; required for the agent fleet).** `pk` 1.11.0,
`prometheus` 1.11.3, and `liter-llm` 2.1.1 live in `~/.local/bin` (with `~/.prometheus/bin` alongside). Preferred:
reinstall them per the substrate installer so the target gets a clean, tracked install. Fallback: copy the
binaries with the rsync in §5 and keep the configs that travel with them (`~/.prometheus/kbd/models.toml`,
`~/.prometheus/liter-llm/liter-llm-proxy.toml`). Mark which path you took in §8.

## 4. Step-by-step transfer

Commands are labelled **[source]** or **[target]**. The passphrase and every auth value move over a secure
channel (in person, or the operator's encrypted records) — this runbook never prints them, and neither should
you.

1. **[source] Pre-flight, read-only.** Confirm nothing changed since staging:

   ```bash
   cd /Users/gqadonis/obsidian/.ipfs-sync
   git status --short && git log origin/main..HEAD --oneline   # expect: empty, empty
   shasum -a 256 keyslots.f6720bcd22c0ded6.json state.f6720bcd22c0ded6.json
   ```

   Record both hashes in the §8 table now — they are the before-transfer baseline.

2. **[source → target] Move the bundle.** Either AirDrop the whole `~/ipfs-sync-transfer-2026-10-12/` directory
   (it is mode 700, 5.5 MB), or:

   ```bash
   # [target]
   mkdir -p ~/ipfs-sync-transfer-2026-10-12 && chmod 700 ~/ipfs-sync-transfer-2026-10-12
   # [source]
   scp ~/ipfs-sync-transfer-2026-10-12/vault-sync-state-f6720bcd22c0ded6.tar.gz \
       ~/ipfs-sync-transfer-2026-10-12/SHA256SUMS \
       <macpro-host>:ipfs-sync-transfer-2026-10-12/
   ```

3. **[target] Verify the bundle before touching anything else:**

   ```bash
   cd ~/ipfs-sync-transfer-2026-10-12
   shasum -a 256 -c SHA256SUMS    # expect: ... OK
   tar tzf vault-sync-state-f6720bcd22c0ded6.tar.gz   # read the actual paths inside
   ```

   If the checksum fails, stop. Do not extract; re-copy the file.

4. **[target] Clone and build the repo:**

   ```bash
   mkdir -p ~/Projects
   git clone git@github.com:Prometheus-AGS/obsidian-ipfs-sync.git ~/Projects/obsidian-ipfs-sync
   cd ~/Projects/obsidian-ipfs-sync
   git rev-parse --short HEAD    # expect 1e53e71
   export PATH="/opt/homebrew/bin:$PATH"
   pnpm install
   pnpm build                    # produces dist/plugin/main.js and the CLI
   ```

5. **[target] Move the vault content.** Exclude the old repo checkout — it does not move with the vault:

   ```bash
   # [target]
   rsync -a --exclude '.ipfs-sync/' \
       <macbook-host>:obsidian/ ~/obsidian/
   ```

   (The exclusion drops the 1.3 GB checkout; the remaining ≈1 GB is the notes. `.obsidian/` plugin config comes
   along with the copy, which is what you want — installed plugins: ipfs-sync dev build, local-gpt,
   multi-column-markdown, table-extended, vault-chat.)

6. **[target] Restore the sync state into the vault's state directory.** Extract to staging first, then place
   the two JSON files with their permissions intact. The bundle is anchored at `$HOME`, so extracted paths carry
   their full relative layout:

   ```bash
   mkdir -p ~/ipfs-sync-transfer-2026-10-12/extracted
   tar xzf ~/ipfs-sync-transfer-2026-10-12/vault-sync-state-f6720bcd22c0ded6.tar.gz \
       -C ~/ipfs-sync-transfer-2026-10-12/extracted
   mkdir -p ~/obsidian/.ipfs-sync
   cp -p ~/ipfs-sync-transfer-2026-10-12/extracted/obsidian/.ipfs-sync/keyslots.f6720bcd22c0ded6.json \
         ~/ipfs-sync-transfer-2026-10-12/extracted/obsidian/.ipfs-sync/state.f6720bcd22c0ded6.json \
         ~/obsidian/.ipfs-sync/
   chmod 600 ~/obsidian/.ipfs-sync/keyslots.f6720bcd22c0ded6.json
   ```

   The `.opencode/opencode-loop/` session file in the bundle (under `extracted/obsidian/.ipfs-sync/.opencode/`)
   is repo-side residue, not vault state. Put it at the new repo root
   (`~/Projects/obsidian-ipfs-sync/.opencode/opencode-loop/`) or drop it; it is 4 KB of session log and nothing
   depends on it.

   **Also restore the CLI per-user state directory from the same bundle** (device-id, sequence floor, history —
   see §1). It is what makes the Mac Pro the same CLI device, not a fresh one:

   ```bash
   # [target]
   mkdir -p "$HOME/Library/Application Support"
   rsync -a ~/ipfs-sync-transfer-2026-10-12/extracted/Library/"Application Support"/ipfs-sync/ \
       "$HOME/Library/Application Support/ipfs-sync/"
   ```

   (If the bundle is not at hand, a direct `rsync -a "<macbook-host>:Library/Application Support/ipfs-sync/"
   "$HOME/Library/Application Support/ipfs-sync/"` does the same job.)

   Skip this only if you chose pair-as-new in decision (a).

7. **[target] Install the plugin into the vault.** Two options; pick one.

   Dev build from the clone (matches the source, which runs a dev build — main.js 13 KB, manifest v0.1.0):

   ```bash
   mkdir -p ~/obsidian/.obsidian/plugins/ipfs-sync
   cp ~/Projects/obsidian-ipfs-sync/dist/plugin/main.js ~/obsidian/.obsidian/plugins/ipfs-sync/
   cp ~/Projects/obsidian-ipfs-sync/dist/plugin/manifest.json ~/obsidian/.obsidian/plugins/ipfs-sync/
   ```

   Or the Release 3 artifact (v0.4.0) from GitHub releases:

   ```bash
   cd ~/obsidian/.obsidian/plugins/ipfs-sync
   gh release download v0.4.0 --repo Prometheus-AGS/obsidian-ipfs-sync
   ```

8. **[target] Place the passphrase file outside the vault** (project rule), mode 600, from the operator's
   encrypted `Keys and Stuff.md` record — carried over a secure channel, never printed, never typed into a file
   inside the vault:

   ```bash
   chmod 600 <path-to-passphrase-file>   # wherever you placed it, outside ~/obsidian
   ```

9. **[target] Set the node environment.** Both endpoints are the remote node; auth comes only from the
   environment, never from CLI flags (the CLI refuses credential flags with exit 2):

   ```bash
   # in ~/.zshrc or a mode-600 file your shell sources:
   export IPFS_SYNC_RPC_URL="https://ipfs.prometheusags.ai"
   export IPFS_SYNC_GATEWAY_URL="https://ipfs.prometheusags.ai"
   # plus exactly one auth variable from your records:
   #   IPFS_SYNC_AUTH_PASSWORD / IPFS_SYNC_AUTH_TOKEN / IPFS_SYNC_AUTH_HEADER_VALUE
   #   (per-endpoint overrides: IPFS_SYNC_RPC_AUTH_* / IPFS_SYNC_GATEWAY_AUTH_*)
   ```

10. **[target] First read-only identity check.** `ipfs-sync history` sends no request, needs no node and no
    passphrase — it reads this device's own operation log from the per-user state directory copied in step 6:

    ```bash
    ipfs-sync history --limit 5
    ```

    Expect the device's recent publishes/pulls, newest first — proof the per-user store was recognized. If it
    prints `no sync operations recorded on this device`, the per-user directory did not land where the CLI looks
    (`~/Library/Application Support/ipfs-sync/`); fix that before continuing. (`ipfs-sync status` also exists,
    but it is not fully read-only: it writes and removes one probe object on the node. Run it later, once cutover
    is done.) Then confirm the vault state agrees with the bundle:

    ```bash
    jq '{vaultId, sequence, rootCid}' ~/obsidian/.ipfs-sync/state.f6720bcd22c0ded6.json
    ```

    `vaultId` must be `f6720bcd22c0ded6`; `sequence` and `rootCid` must equal the source machine's values
    (compare against the same command on the source).

11. **[target] One pull to verify sync health:**

    ```bash
    IPFS_SYNC_PASSPHRASE_FILE=<path-to-passphrase-file> ipfs-sync pull ~/obsidian
    ```

    `pull` is read-only against the node (it takes the `publish.lock` locally and writes nothing to the node).
    If the vault content arrived intact by rsync, expect verification against the manifest and no mass download.

12. **[target] Open the vault in Obsidian** and enable the ipfs-sync plugin only after step 11 passes.

## 5. Agent substrate transfer

Run on the **[target]**, pulling from the source over ssh (substitute `<macbook-host>`). Sizes are the
2026-10-12 inventory.

**kimi-code** (506 MB; `sessions/` excluded — drop the exclude if you want the logs):

```bash
rsync -a --exclude 'sessions/' <macbook-host>:.kimi-code/ ~/.kimi-code/
```

This carries 281 skills, `config.toml`, `credentials/`, `oauth/`, `hooks/`, `mcp.json`. It contains credentials;
the transfer is host-to-host over ssh — do not stage it through any cloud folder.

**Prometheus substrate** (32 GB total; the ≈24.5G of backups/recovery/repair-backups history is excluded, and
every `.bak`/`.deprecated` file):

```bash
rsync -a \
  --exclude 'backups/' --exclude 'recovery/' --exclude 'repair-backups/' \
  --exclude '*.bak' --exclude '*.bak.*' --exclude '*.deprecated' \
  --exclude 'kbd/secrets.env' \
  <macbook-host>:.prometheus/ ~/.prometheus/
```

What survives the filter: releases 2.5G, plugins 2.4G, openspec 1.0G, data 575M, install 396M, logs 323M,
bin 288M, knowledge 152M, learning-queue 133M, plus `kbd/models.toml`, `cadence/`, `events.jsonl`.

**secrets.env separately.** `~/.prometheus/kbd/secrets.env` holds the LLM keys used for adversarial review.
It moves on its own, directly, never via a sync or cloud folder:

```bash
scp <macbook-host>:.prometheus/kbd/secrets.env ~/.prometheus/kbd/secrets.env
chmod 600 ~/.prometheus/kbd/secrets.env
```

**Substrate binaries** (if you chose copy-over-install in §3):

```bash
rsync -a <macbook-host>:.local/bin/pk <macbook-host>:.local/bin/prometheus <macbook-host>:.local/bin/liter-llm ~/.local/bin/
```

**LaunchAgents.** Copy only the live plists (never the `.bak`/`.deprecated` ones):

```
ai.prometheus.liter-llm-api.plist
dev.prometheusags.openai-proxy.plist
ai.prometheus.surreal-memory-native.plist
ai.prometheus.surrealdb-native.plist
ai.prometheus.pk-cherry.plist
ai.prometheus.sovereign-sync.plist
ai.prometheus.surface-bridge.plist
ai.prometheus.exec.plist
ai.prometheus.ferrox.plist
ai.prometheus.forge-mcp.plist
ai.prometheus.hooks-logrotate.plist
ai.prometheus.learning-worker.plist
ai.prometheus.prometheus-nudge.plist
com.prometheus.universal-agent-runtime.plist
com.prometheus.cortex-cleanup.plist
com.prometheus.research.plist
```

```bash
rsync -a --exclude '*.bak*' --exclude '*.deprecated' \
  <macbook-host>:Library/LaunchAgents/ ~/Library/LaunchAgents/
# then load each one:
for p in ~/Library/LaunchAgents/*.plist; do launchctl bootstrap "gui/$UID" "$p"; done
```

Note the plist contents reference home-directory paths; if the target username differs from `gqadonis`, edit
each plist's paths before bootstrapping.

**liter-llm proxy and openai-proxy.** The liter-llm proxy config is `~/.prometheus/liter-llm/liter-llm-proxy.toml`
(carried by the rsync above; listening port :4000). openai-proxy is the LaunchAgent
`dev.prometheusags.openai-proxy.plist` (listening :8181, attaches to Codex, needs no API key). Both come up with
the `launchctl bootstrap` loop once their binaries and configs are in place.

**Verification list:**

```bash
lsof -iTCP:4000 -sTCP:LISTEN     # liter-llm proxy
lsof -iTCP:8181 -sTCP:LISTEN     # openai-proxy
cd ~/Projects/obsidian-ipfs-sync && prometheus kbd --path . status    # substrate smoke check
```

## 6. Cutover checklist

In order. Do not reorder — the single-writer rule depends on it.

1. Target git state clean: `cd ~/Projects/obsidian-ipfs-sync && git status --short && git rev-parse --short HEAD` — empty status, HEAD `1e53e71`.
2. Target sync state recognized: §4 step 10 output matches the source (`vaultId` `f6720bcd22c0ded6`, same
   `sequence`, same `rootCid`).
3. First pull completed (§4 step 11).
4. Docs site: nothing to do. It is GitHub Pages — it does not live on either machine.
5. **Disable the plugin on the source.** In Obsidian on the MacBook, turn off (or unload) ipfs-sync. Only after
   this is the target allowed to go live.
6. Target goes live: enable the plugin in Obsidian on the Mac Pro.

**Single-writer warning.** Never run the plugin or the CLI against vaultId `f6720bcd22c0ded6` from both
machines at once. The publish path narrows concurrent publishes but does not prevent them — kubo has no
compare-and-swap, and a write race on the shared MFS tree is not detected (`docs/operator/encrypted-vault.md`,
"Second device"). Adopted identity makes both machines *the same* device, so there is no fork protection either.
One live writer, always.

**Rollback.** This runbook deletes nothing on the source machine. If anything on the target misbehaves, disable
the plugin there, re-enable it on the MacBook, and you are back where you started. The source stays the fallback
until you explicitly retire it.

## 7. What stays behind / cleanup deferred

- The source machine keeps everything — repo, state, substrate, local kubo — as fallback. Cleanup of the source
  is a separate task, deliberately not in this runbook.
- Old demo roots on the remote node and source-machine cleanup are debts already recorded in the docs-site
  reflection. They are not folded into this transfer; do not attempt them "while you're in there".
- `~/.prometheus/backups`, `recovery`, `repair-backups` (≈24.5G) stay on the source. Archive or delete them only
  as a separate, decided operation.

## 8. Verification evidence block

Fill in on the target. The transfer is not done until every row has an observed value, not an expected one.

| Check | Command | Expected | Observed |
|---|---|---|---|
| Bundle checksum | `shasum -a 256 -c ~/ipfs-sync-transfer-2026-10-12/SHA256SUMS` | `OK` | |
| Git HEAD | `git -C ~/Projects/obsidian-ipfs-sync rev-parse --short HEAD` | `1e53e71` | |
| Git clean | `git -C ~/Projects/obsidian-ipfs-sync status --short` | empty | |
| keyslots sha256 (source, before transfer) | `shasum -a 256 keyslots.f6720bcd22c0ded6.json` in the source repo root | (record) | |
| keyslots sha256 (target) | `shasum -a 256 ~/obsidian/.ipfs-sync/keyslots.f6720bcd22c0ded6.json` | = source value | |
| state sha256 (source, before transfer) | `shasum -a 256 state.f6720bcd22c0ded6.json` in the source repo root | (record) | |
| state sha256 (target) | `shasum -a 256 ~/obsidian/.ipfs-sync/state.f6720bcd22c0ded6.json` | = source value | |
| State identity | `jq '{vaultId, sequence, rootCid}' ~/obsidian/.ipfs-sync/state.f6720bcd22c0ded6.json` | vaultId `f6720bcd22c0ded6`; sequence/rootCid = source | |
| Per-user CLI store | `ls "$HOME/Library/Application Support/ipfs-sync/"` | `device-id`, `history/`, `sequence-floor.json`, `feature-ops/` | |
| First history | `ipfs-sync history --limit 5` | this device's recent operations, newest first | |
| First pull | `IPFS_SYNC_PASSPHRASE_FILE=<path> ipfs-sync pull ~/obsidian` | exit 0; no mass download | |
| liter-llm proxy | `lsof -iTCP:4000 -sTCP:LISTEN` | one listener | |
| openai-proxy | `lsof -iTCP:8181 -sTCP:LISTEN` | one listener | |
| Substrate smoke | `prometheus kbd --path . status` in the cloned repo | status output | |
| Substrate install path taken | §3 note | reinstall / copied binaries | |
| Source plugin disabled | Obsidian on MacBook | ipfs-sync off | |
