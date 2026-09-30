# Phase: specify — kubo-sync

Acceptance: the skill's scope statement names every surface it covers (RPC
client, MFS layout, delta manifest, publish/pull flows, quirks) and names
explicitly what it does NOT cover (IPNS key management, token gating,
encryption — owned by `ucan-identity`; UI — owned by `ui-markdown-agents`).

Checkpoint after this phase:
`bash scripts/state-checkpoint.sh kubo-sync specify`
