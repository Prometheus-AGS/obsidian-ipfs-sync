---
name: ucan-identity
description: >
  Entry point for PMPO lifecycle operations on the ucan-identity skill
  (specify / plan / execute / reflect). Use when refining this skill's
  content through the phase loop.
---

# /ucan-identity lifecycle

Phases (see `prompts/` for acceptance criteria):

1. `prompts/specify.md` — scope and boundaries
2. `prompts/plan.md` — file map and verification plan
3. `prompts/execute.md` — content generation
4. `prompts/reflect.md` — validation against live behavior + spec

State: `bash scripts/state-init.sh ucan-identity` first, then checkpoint per phase.
