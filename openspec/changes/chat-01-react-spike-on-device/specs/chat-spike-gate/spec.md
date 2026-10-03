## Purpose

Defines how the spike's device results are recorded and when they count, so the startup threshold cannot be fitted to the answer and no go decision rests on an unobserved claim.

## ADDED Requirements

### Requirement: Evidence rule
Every check row in `device-results.md` SHALL carry the build tag, the device and OS versions, a result of `pass`, `fail`, `not run` or `operator-reported`, and an evidence name (screenshot, recording, report file or a note written by the spike command). A row without evidence SHALL read `not run`. A check an agent cannot perform SHALL NOT be recorded by an agent as run.

#### Scenario: Missing evidence
- **WHEN** a row has a result and no evidence name
- **THEN** the gate treats the row as `not run`

### Requirement: Threshold fixed from the baseline
The startup threshold SHALL be written and signed by the operator after the B0 baseline runs are recorded and before any B1 or B2 number is read. The threshold SHALL be stated as a rule with numbers derived from the baseline. The plan SHALL NOT supply a number.

#### Scenario: Threshold after the numbers
- **WHEN** the signed threshold carries a timestamp later than any B1 or B2 cold-start row
- **THEN** the startup-budget decision is invalid and the B1 and B2 runs are repeated under a threshold signed first

### Requirement: Valid cold-start measurement
A with-chat cold-start run SHALL count only if the chat-evaluation mark is absent at the end of `onload`, except in the labelled eager control and the labelled app-killed-with-view-open case. Each counted run SHALL record the in-plugin marks and the screen-recording launch-to-workspace-visible time. A variant SHALL be counted from at least 5 force-quit cold launches.

#### Scenario: Lazy variant evaluates in onload
- **WHEN** the chat-evaluation mark is present before `onload` ends in a lazy-variant run
- **THEN** the run is not counted as lazy and the variant is reported as eager

### Requirement: Decisions and outcomes
G1 SHALL record three decisions, persistence, startup budget and UI feasibility, each as `go`, `go with fallback` or `no-go`, the evidence rows each rests on, and what stays unverified. A `go with fallback` for the startup budget means the second-plugin split. A `no-go` SHALL name the option the operator chose. The operator SHALL sign G1. chat-02 SHALL NOT start without it.

#### Scenario: Persistence fails
- **WHEN** S5 shows messages missing after force-quit and relaunch
- **THEN** the persistence decision is `no-go` and the operator picks one of the recorded options before chat-03 is planned

### Requirement: Outward actions
Each spike build SHALL be its own pre-release with a tag that has no `v` prefix and equals the manifest version. The operator's explicit approval for that exact action SHALL precede each creation and each deletion. The list of created pre-releases SHALL be kept in `device-results.md`.

#### Scenario: Two builds in one release
- **WHEN** a release would carry two spike builds
- **THEN** the release is refused and each build gets its own
