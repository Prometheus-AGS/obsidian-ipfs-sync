# Phase: reflect — kubo-sync

Acceptance: re-read SKILL.md against the live node behavior (files/ls the
staging trees, stat a known file, resolve IPNS). Flag anything stale. Check
agentskills.io compliance: frontmatter present, under 500 lines, description
states use-cases, no dangling file references.

Checkpoint after this phase:
`bash scripts/state-checkpoint.sh kubo-sync reflect`
Finalize: `bash scripts/state-finalize.sh kubo-sync`
