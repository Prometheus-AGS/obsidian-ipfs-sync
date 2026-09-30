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
