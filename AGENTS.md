<!-- prometheus-base:start v1 -->
# Agent Operating Rules

This region is the standing contract. It holds only invariants that must
survive compaction. Everything else lives in on-demand rules, skills, hooks,
and reference files. Where a hook enforces a rule stated here, the hook wins.

Managed by `prometheus-context-bootstrap`. Edits inside these markers are
overwritten on re-run. Write project prose outside them.

## Position and authority

- `.kbd-orchestrator/current-waypoint.json` is authoritative for position.
- `versions.toml` is authoritative for architecture decisions and dependency pins.
- READMEs go stale. Do not trust one over the two files above.
- Read the waypoint at session start. State the current phase before executing.

## Capability inversion

Agent kernels do not write. Mutating actions are gated in the trusted host
layer only, never in an agent kernel. Where the language allows it, this is
enforced at the dependency graph as a compile-time guarantee rather than a
runtime check. If a task appears to require a write from a kernel, stop and
surface the conflict instead of routing around it.

## Phase order

Task loop: Spec, Plan, Execute, Reflect.
Evolution loop: Compile, Evaluate, Optimize, Promote.

Running a phase out of order is a quality failure, not a shortcut. Name the
phase you are in. Do not execute before a plan exists.

## Verification boundaries

Finish a coherent implementation set before testing it. During implementation,
use static inspection and reasoning; use a narrow compiler check only when it is
required to unblock progress. Finish every planned production change in the phase,
then run one integration gate through the real production path and collaborators at
the final phase boundary. When the harness provides an agent team, keep reviewer,
auditor, verifier, and integration-checker roles dormant until that boundary. Unit,
mock-only, filtered-function, and per-edit tests are not completion evidence.
Per-stack commands live in `.claude/rules/`, loaded only when a matching file is read.

- `.claude/rules/typescript.md` — typescript tiers and hard rules
- `.claude/rules/rust.md` — rust tiers and hard rules

## Evidentiary standard

Address observed problems. An observed problem comes from an operator report, a
visible error or log, a failing test, or an explicit requirement. A concern that
is none of those gets one sentence and a question, never speculative code.

Defensive code — validation, guards, fallbacks, retries, timeouts — requires a
named failure scenario. Hardening at a real trust boundary present in the code
is a standing exception and is named in the completion summary, never added
silently.

## Evidence over assertion

Show the command and its output, the test result, or the artifact. "Looks done"
is not done. Report what was actually run and at which boundary. If a check could
not run, say which claims are therefore unverified. An unverified claim reported
as verified is worse than no check at all.

## Anti-sycophancy

Critics never see generation history. Review through the `artifact-critic`
subagent, which receives the artifact alone. The model that produced the work is
not the sole judge of whether it is good.

A reflection leads with the delta between plan and delivery, not with what
worked. The sycophancy gate may block a turn; fix the finding rather than
bypassing it.

## Learning and memory

Learning is append-only under `.prometheus/`: `session-log.md`, `decisions.md`,
`gotchas.md`, `postmortems/`, `knowledge/`. Never rewrite history; append, and
mark superseded entries rather than deleting them.

Write on a decision with a rationale, a defect and its root cause, a learned
constraint, a phase boundary, and a session summary. Read `gotchas.md` before
touching a subsystem.

Where a memory server is configured, it is the primary store and its write path
may time out. On failure, log to the markdown files above and continue. Never
block a task on the memory server.

## Architecture

- Single-writer build discipline within one build or target directory.
- Feature-based organization by capability, not by technical layer.
- Strict layering: UI, then hooks or view models, then stores, then services,
  then external. Reverse flow only through reactive state or events.
- Business state lives in explicit, inspectable systems, never in UI components
  or agent-only memory.
- Open standards first. Avoid lock-in unless explicitly required.
- Verify dependency versions against official sources before introducing them.
  Do not rely on training-era version knowledge.

## Scope

Minimum change that solves the problem. Do not refactor adjacent working code;
treat its current state as intentional. Mention unrelated issues, do not fix
them unasked. Before destructive or hard-to-reverse actions, confirm intent and
prefer a reversible path.

## Skills may be absent

Harnesses drop skill descriptions past a context budget, so a skill you expect
may not be listed. If one is missing, invoke it by name or say plainly that it
is unavailable and proceed from these rules. Never invent what an absent skill
would have done.

## Communication

Direct and execution-first. Structure claims as statement, mechanism, stakes.
Short declarative sentences. No marketing language.

Avoid: leverage as a verb, utilize, synergy, roadmap as a verb, journey,
harness as a verb, delve, revolutionary.

Every significant document names the uncomfortable thing — the scenario that
hurts the author's own position.

## Done

A task is done when its stated integration exit criteria pass at the applicable boundary, not when
the output looks plausible. Before declaring completion: remove anything added
that was not requested, confirm each guard traces to an observed problem or a
real boundary, and summarize what changed, how it was verified, and what remains
at risk.

## Execution scaffold

This section exists because the fleet is mixed. Frontier models supply most of
it by default; smaller and older models do not, and the failure is silent —
plausible output with a fabricated call in it. Omit this section only when
every model that reads this file is known to supply the behavior on its own.

### Before executing

Restate the task in one sentence, and name the phase. If the restatement does
not match what was asked, stop and ask rather than proceeding on the closer
reading. Name the files you intend to touch before touching them.

### Do not fabricate

Never invent an API, a file path, a package name, a command flag, or a
configuration key. If you have not read it in this session or it is not pinned
in `versions.toml`, verify it before using it. "I could not confirm this
exists" is a correct answer. A plausible identifier that does not exist costs
more than the question would have.

Do not guess at a tool's parameters. Read its schema. A tool call with invented
arguments fails in a way that looks like the tool is broken.

### Verification is explicit

Run the check. Paste the command and its actual output. Do not report a result
you did not observe, and do not describe what a test "should" produce.

If a check cannot run, say which specific claims are therefore unverified, and
why. Skipping a check silently and summarizing as if it passed is the failure
this rule exists to prevent.

### Code output

Never elide code with `...`, `// rest unchanged`, or a similar placeholder in a
file you are writing. Emit the complete content of every file you write.

When editing, change the minimum span. Do not reformat, reorder imports, or
rename adjacent symbols while making an unrelated change.

Match the file's existing conventions over your own defaults.

### Complete coherent sets

Batch related implementation work until a meaningful production path is complete.
Do not interrupt every edit with a build or test. Keep unrelated changes separate,
then validate the completed set through the smallest real integration boundary.

Do not start an unrelated subsystem while the current implementation set is partial.

### Stop conditions

Stop and ask when: the requirement is ambiguous in a way that changes the
design, two readings of the task lead to different files, the change would
break an existing behavior, or you are about to do something hard to reverse.

Stop when the goal is met. Do not continue into adjacent improvements.

### Format contracts

When a specific output format is requested — JSON, a table, a diff, a schema —
emit exactly that format with no preamble, no trailing commentary, and no
markdown fence unless the fence was asked for. A parser is often reading it.

### Self-check before reporting completion

State each of these explicitly, not as a claim that you did them:

1. What changed, file by file.
2. What was run to verify it, and the observed output.
3. What was added that was not requested — remove it, or list it and ask.
4. Which guards trace to an observed failure, and which do not.
5. What remains unverified, and why.

<!-- profile: mixed — see references/MODEL-PROFILES.md before changing -->
<!-- prometheus-base:end -->

<!-- uiux-routing:start v1 -->
## UI/UX routing
UI, styles, tokens, motion or copy → `prometheus-ui-ux`. Read `.agents/UI_UX_PROTOCOL.md` or its bundled default; preserve design authority.
All code: detect `.agent-team/project-routing.json` and real team manifests. Preserve selection; adopt a sole team; ask if ambiguous. Use relevant roles, disclosing sequential fallback.
Backend work loads no UI guidance. Review respects user-only skills and the completed-phase boundary.
<!-- uiux-routing:end -->

<!-- prometheus-team-routing:start v1 -->
For every code task, read `.agent-team/project-routing.json`, then its active team manifest and the relevant role instructions. Default to that team, selecting only roles whose responsibilities and ownership match the work. Preserve native permissions, models, concurrency limits and existing project instructions.
For UI work, load the role-bound `prometheus-ui-ux` or `prometheus-ui-review` skill. Prefer `.agents/UI_UX_PROTOCOL.md` when present; otherwise use the installed `prometheus-ui-ux/references/UI_UX_PROTOCOL.md`. Backend work must not load UI guidance.
Use native delegation when available. If unavailable, follow the selected role instructions sequentially and report that limitation. Review in the builder context is not independent review. Keep reviewers dormant until the complete implementation phase; allow one batched correction/confirmation cycle. Respect user-only skill invocation restrictions. Zed external ACP agents use their own native configuration; parallel UI threads are not an automatic delegation API.
<!-- prometheus-team-routing:end -->

## Project: agent team is the default (operator rule, 2026-09-29)

This section is project prose outside the managed regions; re-running the bootstrap does not touch it.

The `ipfs-sync` team (`.agent-team/project-routing.json` → `.agent-team/ipfs-sync/team.json`, definitions in `.claude/agents/`) does the work by default. Doing it in the lead session instead needs a stated reason.

- **Assign by ownership.** Each role owns disjoint paths in `team.json`. Dispatch a change or task to the role whose `owns` matches the files touched. Work that spans roles is split by path and run in sequence, or in parallel only when the paths are disjoint.
- **Specs and acceptance go to `product-manager`**: OpenSpec proposal, specs and tasks, acceptance criteria, backlog.
- **Docs go to `documentation-specialist`**: README, CHANGELOG, `docs/operator/`, DESIGN.md sync.
- **Plan and integration coordination go to `workflow-lead`**: handoffs, integration review scheduling.
- **Implementation goes to the owning engineer**: `ipfs-engineer` (sync core, kubo, CLI, plugin paths), `identity-security-engineer` (crypto, identity), `data-engineer` (stores), `uiux-lead` (UI, settings), `p2p-engineer`, `uar-engineer`, `bdd-engineer` (tests), `release-deployment-lead` (CI, packaging, releases; sole publisher).
- **Reviewers stay dormant until the final phase gate**, then run once: `security-reviewer` (independent of the builder), `bdd-engineer` for the integration gate. Never review in the builder's own context and call it independent.
- **The lead session orchestrates**: it selects roles, writes dispatch contracts, owns cadence and KBD state transitions, and integrates results. It does not implement work a role owns.
- **One writer per shared build directory and per shared file** (package.json, lockfile, esbuild and tsconfig included). Parallel roles must have disjoint `owns` paths.
- **Fallback.** If delegation is unavailable or blocked, run the selected role's instructions sequentially in the lead session, and say so in the dispatch record and the completion summary. A sequential fallback is not independent review.
- **Record it.** Every dispatch names the role and the reason for any deviation in `execution.md`. Say which role actually did the work; never describe lead-session work as team work.

## Project: UI/UX design authority (operator decision, 2026-10-04)

Project prose outside the managed regions.

- `docs/design/` is the design authority for everything the user sees in the agentic layer: the Vault agent sidebar view (Search, Chat in **Notes** and **Agent** modes, Index), the quick-ask popup, the control center and the status chip. Read `docs/design/README.md` first, then `docs/design/vault-agent-ui-concept.md`, then the screens. Spec `docs/012-vault-agent-ui.md` is the pointer in the numbered series.
- The screens encode operator-reviewed decisions, not inspiration: native Obsidian DOM (no React in the plugin), Obsidian CSS variables only through `ipfs-sync-` classes in one `styles.css`, Notes mode as the default chat that never answers from model knowledge, a lane chip (Local / Remote / Offline) on every agent surface, skill activations never hidden, consequence dialogs with Cancel focused, no default hotkeys, sentence case.
- `uiux-lead` owns `src/ui/`, `styles.css` and `docs/design/`. A conflict between the concept and a numbered spec is a spec delta raised through `product-manager`, never a silent deviation. Roles that feed the UI (`data-engineer` for retrieval and index state, `uar-engineer` for the AG-UI stream and lanes) read the concept before shaping their interfaces.
- Iterations are drafted in the Open Design project named in `docs/operator/open-design-mcp.md` and copied into `docs/design/` in the same commit as the change they justify. Do not hand-edit the copies alone.

