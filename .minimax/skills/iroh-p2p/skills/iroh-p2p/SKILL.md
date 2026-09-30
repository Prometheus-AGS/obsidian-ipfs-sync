---
name: iroh-p2p
description: >
  Entry point for PMPO lifecycle operations on the iroh-p2p skill
  (specify / plan / execute / reflect). Use when refining this skill's
  content through the phase loop.
---

# /iroh-p2p lifecycle

Phases (see `prompts/` for acceptance criteria):

1. `prompts/specify.md` — scope and boundaries
2. `prompts/plan.md` — file map and verification plan
3. `prompts/execute.md` — content generation
4. `prompts/reflect.md` — validation against live behavior + spec

State: `bash scripts/state-init.sh iroh-p2p` first, then checkpoint per phase.
