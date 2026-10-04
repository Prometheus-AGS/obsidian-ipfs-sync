## Context

Everything here comes from `assessment-llm-connections.md` (read in full 2026-10-04) unless tagged repo. Its UNVERIFIED items stay unverified until task 1.4. Repo: `src/plugin/range-streaming-transport.ts:134-139` (run-time `require`), `tools/webview-import-probe.mjs` and `tools/hook-isolation.mjs` (fail on Node built-in imports; assessment s.6). Not verified by anyone: any behaviour of an installed binary beyond `--version` outputs recorded in the assessment (Claude 2.1.289 and Codex 0.158.0 on the assessor's machine).

## Gated process access

`Platform.isDesktopApp` gates everything. `child_process` is obtained by a run-time lookup in a try/catch, as `desktopNodeModules` does for `http`; if it is missing the adapters and the panel do not register. The services in `src/agents/llm/` receive a `spawn` function through a port and import no Node built-in, so the probe passes. The lookup lives in one host file the security review reads first. Mobile never reaches it.

## Detection (read-only; assessment s.2.4, s.3.3)

1. Binary candidates: user-set absolute path; known locations; PATH. A GUI-launched Obsidian may have a short PATH on macOS (unverified); the panel shows the resolved path and lets the user set one.
2. `--version`, short timeout, no prompt; parse (`^(\d+\.\d+\.\d+) \(Claude Code\)` for Claude; `codex-cli X.Y.Z` for Codex).
3. Sign-in state: `claude auth status` keeping only the exit code and `authMethod`; `codex login status` keeping only the first line. The plugin never opens `~/.claude` or `~/.codex`. `codex doctor` is never called.
4. Compare to a declared minimum version (Claude 2.1.205 for `capabilities`; the Codex minimum is unverified).

## Spawn shape (to be device-tested; assessment s.7.2)

Claude: print mode, `stream-json` with partial messages, text input on stdin, no session persistence, no tools, restrictive permission mode, empty setting sources, model chosen, working directory an empty temporary folder, not the vault. Tools from the plugin's own MCP server only if ever needed, with strict MCP config. Codex: `exec --json`, ephemeral, read-only sandbox, prompt on stdin, an empty working directory; the working-directory flag was not seen in the help text read, so it is verified first. `spawn(file, argv, {shell:false})`; never a shell string; keys never on the command line.

Environment: allow-list (`PATH`, `HOME`, locale). Provider keys (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY`) removed unless the user chose key auth for that provider; then the key comes from the key store and is set only for that child.

Cancel: SIGINT, then SIGTERM after a grace period (assessment s.2.2: SIGINT ends a Claude turn; SIGTERM leaves it unfinished). Output limits and idle timeouts as in slice 02. Tool permissions never include a dangerous bypass.

## Auth default and consent

API key by default. Subscription sign-in use is offered only if Anthropic's written answer permits it, and then labelled advanced. Codex: a user-supplied API key, not a ChatGPT login. The consent names the binary, its path, the working directory, what is sent in that mode, that a local process starts with the user's credentials, and that vendor terms apply to the account. Labels are neutral ("Claude (local install)") per assessment s.8 item 4.

## Panel

A named slot, desktop only, hidden on mobile, reserved empty by slice 02. This slice fills it. Its design is a prerequisite and is drawn through Open Design.
