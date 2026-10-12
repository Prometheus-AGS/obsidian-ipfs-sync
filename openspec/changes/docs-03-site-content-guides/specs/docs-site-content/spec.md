## Purpose

Defines the published documentation set for the IPFS Sync site: topic coverage, per-page accuracy rules, the content gate over the coverage matrix, and the invariants (no default node, verbatim mobile caveats, honest evidence framing) that keep a polished site from overstating a partially verified product.

## ADDED Requirements

### Requirement: Coverage matrix tracks every required topic
A coverage matrix SHALL be maintained (published as a site page) with one row per required topic — install, desktop setup, mobile setup, concepts/how-it-works, encryption & threat model, conflict policy, CLI reference, security model, limitations, troubleshooting, evidence/demo, roadmap — and columns for source file, shipped-vs-designed status, page mapping, and checked flag.

#### Scenario: Matrix exists before content
- **WHEN** any content page task begins
- **THEN** the coverage matrix exists with all twelve topics enumerated

### Requirement: Content gate
Before deployment (docs-04) the following SHALL all hold: every required topic maps to a published page; every behavioral claim on a page has a checked source recorded in the matrix; every designed-but-unbuilt feature is explicitly labeled as designed-not-built; and all unchecked coverage-matrix entries are resolved or explicitly disclosed.

#### Scenario: Unresolved entry blocks deploy
- **WHEN** the matrix contains an unchecked row with no disclosure
- **THEN** docs-04 SHALL NOT deploy, and the row is either resolved or explicitly disclosed first

### Requirement: No page implies a default node exists
No site page SHALL state or imply that a default sync node exists. The desktop setup guide SHALL state that the user must enter RPC and gateway URLs. References to the maintainer's test node SHALL describe it as open-to-anyone and not a default.

#### Scenario: Default-node sweep
- **WHEN** `grep -rn 'default node' site/docs/` runs at the gate
- **THEN** matches are only explicit no-default statements

### Requirement: Mobile caveats verbatim
The mobile setup guide SHALL carry the caveats verbatim: mobile sync never run; Android untested; `requestUrl` buffers whole bodies and follows redirects; no iCloud vaults. The guide SHALL NOT imply mobile support.

#### Scenario: Caveat presence
- **WHEN** the mobile guide is grepped for the four caveats
- **THEN** all four appear, worded as above

### Requirement: Evidence page states what actually ran
The evidence page SHALL present the v0.4.0 demo numbers exactly as recorded — 4,825 files, 4825/4825 sha256 equal, publish 652 s, pull 343 s, root CID `bafybeihoemb6amr2txinn4w4oabcttv3wpcufxbmmsyej6xxpeu54qzzwa` — SHALL state explicitly that it was an agent-run CLI demo under operator decision D-E (2026-10-11) and not an Obsidian-desktop publish, SHALL cite `docs/operator/mvp-10-demo-record.md`, and SHALL NOT mirror raw scan artifacts.

#### Scenario: No desktop-publish implication
- **WHEN** the evidence page is read
- **THEN** the agent-run CLI framing and the D-E decision are stated on the page, and no raw artifact paths appear

### Requirement: Behavioral claims match the code
Pages describing CLI behavior (commands, flags, env vars, config precedence, exit codes) SHALL be checked against `cli/`; pages describing security and limits SHALL match README §Security, "Limits that stay" and "Not verified" and DESIGN.md §8. The CLI reference SHALL state that credentials never come from the command line and that the CLI has no read cap and no exclusion option.

#### Scenario: CLI reference conformance
- **WHEN** a command or flag named on the CLI reference page is grepped in `cli/`
- **THEN** it exists with the documented behavior
