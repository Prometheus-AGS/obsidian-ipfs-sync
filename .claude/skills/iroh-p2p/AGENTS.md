# iroh-p2p — contributing

Agent Skills spec: `SKILL.md` requires `name` + `description` frontmatter.
Description must state what the skill does AND when to use it — triggering
depends on it.

- Add new RPC endpoints to the API-surface table with the observed request
  shape, not the documented one, when they differ.
- Code examples must be Node 24 + TypeScript 7, kebab-case files, no Node-only
  APIs in anything that ships to the plugin WebView.
- Run `bash scripts/state-init.sh iroh-p2p` before a content pass and
  `scripts/state-checkpoint.sh iroh-p2p <phase>` between phases; the PMPO
  loop prompts in `prompts/` describe each phase's acceptance check.
