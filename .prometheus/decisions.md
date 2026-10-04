# decisions

Append-only. Dated entries. Mark superseded entries; do not delete them.

## 2026-09-29
- Initialized by prometheus-context-bootstrap.

## 2026-09-29 — Toolchain + conventions pinned (operator decisions)

- TypeScript 7.0.2 pinned in versions.toml; package.json devDependency moved
  ^5.8.0 → ^7.0.2. TS 7 removed `moduleResolution: node10`; tsconfig now uses
  `module: Node16` + `moduleResolution: node16`.
- First real `tsc --noEmit` gate run surfaced latent type errors esbuild had
  always stripped: `settings` field now `declare` (TS2612 overwrite of Plugin
  base), and pull path used `create`/`modify` (string) with ArrayBuffer data —
  corrected to `createBinary`/`modifyBinary`. These were genuine API-misuse
  bugs, not cosmetic.
- Kebab-case file naming for all TS/JS files; clean architecture layering
  (inward-pointing, shared kubo RPC client as sole external boundary,
  EventBus for cross-feature communication). Recorded in
  .claude/rules/typescript.md (path-scoped) + versions.toml decisions.
- prometheus-context-bootstrap applied (mixed profile): AGENTS.md resident
  invariants, CLAUDE.md symlink, 4 hooks, artifact-critic, .prometheus/
  learning store. verify.sh: 11 PASS, 2 WARN (machine-wide skill budget
  56x over — repo cannot fix alone; 10 skills with empty descriptions).

## 2026-09-29 — Four project skills authored + MVP open questions resolved

- Created agentskills.io skills (PMPO lifecycle): kubo-sync, iroh-p2p,
  ucan-identity, ui-markdown-agents — installed to .agents/skills,
  .claude/skills, .minimax/skills (codex/opencode/kimi read .agents).
- spec 010: agentic UI rendering contract (markdown everywhere, full AG-UI
  chunk coverage, mermaid/SVG/image/video, message+block copy, collapsible
  thinking/citations/memory/errors, always-visible skill activations).
- spec 011: MVP decisions — pnpm (corepack), vitest, per-file files/write,
  per-platform KeyStore (keychain/Keystore/Capacitor), keep excludesHash,
  ucanto + @noble/curves SPAKE2 + didcomm-node, searchable settings center
  with first-class security section.

## 2026-09-30 — mvp-06 task 5.1 documentation (documentation-specialist)
- DESIGN.md section 8 replaced (only section 8); README, CHANGELOG rewritten for the encrypted tree; new operator runbook `docs/operator/encrypted-vault.md`. Constants in section 8 were checked against the code by a grep script (87 of 88 matched; the one miss was a regex on an unquoted key, confirmed by hand).
- Documented as the code behaves, not as the spec scenario reads: (1) a release-0.2.0 pulled marker is refused by `publish` and `pull` with a generic "does not hold the text" / "not one of the accepted words" message, not a message that says the marker predates this version (spec "Legacy pulled markers" is not met in code); (2) the abandon action (`abandonVault`, `AbandonVaultDialog`) is not reachable from the CLI or the settings tab, though refusal messages name it; (3) the plugin's Pull cannot read a plaintext root (no setting for `allowPlaintextV1`) and refuses an encrypted one, so plugin Pull brings no files in this tree; (4) the old pull demo (publish then pull) no longer works; (5) `tools/feature-op-mvp-06.mjs` is not in the repository, so the shared-node feature operation is listed as not run.
- Stale text found and NOT fixed (outside owned scope): DESIGN.md sections 1 to 7, 9 and 10 still describe the pre-implementation plaintext design; `VaultKeysError creation-not-requested` still says `--init`; `.kbd-orchestrator/phases/mvp/tasks.md` items 23/24 still say `publish --init`.
- Every review of this change (0.1, 0.2, 2, 2b, 3, 3b, 4-1) is stated in the docs as a static read by one model, and review 5 as not run.

## 2026-10-04 — Vault agent UI concept adopted as design authority (lead session, operator-directed)
- Concept brief and five working screens produced in the Open Design project `Obsidian agentic search UI concept` (aca77082-f254-4ccf-96da-66844bd88e46) and copied to `docs/design/`; spec 012 added as the pointer in the numbered series; `uiux-lead` role (team.json + .claude/agents) re-pointed at it and given `styles.css` and `docs/design/` ownership; AGENTS.md project prose, README "Agentic layer" section and the UI_UX_PROTOCOL project brief updated.
- Decisions: right-sidebar ItemView with Search / Chat / Index; Chat has Notes (RAG, default) and Agent modes; quick ask is a one-shot popup (modal / bottom sheet); settings move to a control center view; native Obsidian DOM, no React in the plugin; Obsidian CSS variables only via `ipfs-sync-` classes; lane chip and "index is a cache" statement mandatory; skill activations never hidden; consequence dialogs with Cancel focused; no default hotkeys.
- Rationale: Obsidian's plugin review guidelines and the leading AI plugins (Smart Connections, Copilot) set user expectations for sidebar views, Obsidian-variable styling and visible local indexing; the project's differentiator is provenance honesty (cache, lane, skills), not chrome. Research sources are cited in the brief.
- Known gaps: the concept is scripted; the Notes-mode retrieval floor (0.60) and passage budget (8) are placeholders to be set by measurement; the screens were render-checked once each on desktop, not on a phone; the last stylesheet fix (pane overflow) was not visually re-verified.
- Repository-local MCP registration (`.mcp.json`, gitignored) binds agent sessions here to that Open Design project; see `docs/operator/open-design-mcp.md`.

