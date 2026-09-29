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
