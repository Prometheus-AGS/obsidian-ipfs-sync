## Why

The operator wants desktop users to be able to use an existing Claude Code or Codex installation, which means the plugin detects them and sets them up. Decided 2026-10-04: **REST first, desktop CLI later.** Slice 02 ships REST only; this slice is the later one, numbered after the Notes and Agent slices. Facts are in `vault-agent-ui-00-phase-overview/assessment-llm-connections.md` (cited "assessment s.N").

The uncomfortable parts:
- **It may be against the vendor's terms.** Anthropic's text bars third-party developers from routing requests through Free, Pro or Max credentials on behalf of users, and from collecting, storing or intermediating Claude.ai credentials; it allows an end user to sign in to the unmodified binary with their own subscription. Whether a plugin that drives that binary as a chat backend counts as routing is a legal judgment; the assessment says to ask Anthropic before shipping (s.8 items 1 and 2). Nobody has asked. Claude branding rules differ between two pages (s.8 item 4). Codex terms for ChatGPT logins in third-party apps are unverified (s.8 item 7).
- **Plan limits can be exceeded.** A chat that makes many calls an hour can pass "ordinary, individual usage"; the user's account bears the enforcement (s.8 item 3).
- **Spawning a process is a privilege.** The binary path is a code-execution setting. The adapter must use `spawn(file, argv, {shell:false})`, never a shell string, never take a path from vault content or a synced file, and re-verify on change (s.7.5).
- **A vault can carry hooks.** `claude -p` without `--bare` loads the working directory's hooks and `.mcp.json` with no trust prompt (s.2.2, s.7.5). A vault cloned from elsewhere could run commands. A neutral working directory and empty setting sources are required; whether `--setting-sources ""` behaves as intended on the installed version is unverified (s.9 item 11).
- **A silent key switch.** If the Obsidian process has `ANTHROPIC_API_KEY`, `claude -p` always uses it (s.2.3). The child environment is built from an allow-list.
- **Bundling is a trap.** The vendor SDK imports `child_process` and fails `pnpm probe:webview` (s.6); the SDK's licence text for redistribution was not read (s.8 item 6). The route is the user's installed CLI, reached through a run-time `require` lookup like `desktopNodeModules` (`src/plugin/range-streaming-transport.ts:134-139`).
- **Codex streams coarsely at best** (s.3.1); its event schema is unverified.
- **Review risk.** How community-plugin review treats child-process use is unverified (s.5, s.9 item 3).

## What Changes

- Desktop-only adapters `desktop-claude` and `desktop-codex` implementing slice 02's provider interface in `src/agents/llm/`, reached through a gated run-time lookup, never imported.
- A detection and setup panel, desktop only, hidden on mobile: found or not found, path, version, signed-in state, a setup checklist. Detection is read-only. Setup records the path the user confirms and shows the sign-in command to run in a terminal.
- Default auth is an API key. Subscription use only if Anthropic confirms in writing.
- Per-provider consent that names the binary, the working directory and what is sent.

## Capabilities

### New Capabilities
- `desktop-cli-adapters`: gated spawn, detection and setup, auth defaults, working directory and environment rules, consent.

### Modified Capabilities
<!-- none -->

## Impact

- Code: `src/agents/llm/desktop-claude.ts`, `desktop-codex.ts`, `detect.ts`; gated lookup in `src/plugin/desktop-process.ts`; `src/ui/providers/` detection panel and the `desktop-detection` slot slice 02 reserved; `tests/`, `features/`.
- Dependencies: none; no vendor SDK bundled.
- Cadence: reviewers dormant until the phase gate; this slice has its own security review as a blocker, not only a gate.

Blocked on all four: (a) a recorded answer from Anthropic about launching the user's own signed-in `claude` binary; (b) the detection and setup panel design (a gap in the concept); (c) a security review of child-process use and of vault-borne `.claude/settings.json` hooks and `.mcp.json`; (d) on-install verification of the unverified items of assessment s.9 and s.10. Also slice 02 (interface, consent, store), slices 05 and 06 shipped.
