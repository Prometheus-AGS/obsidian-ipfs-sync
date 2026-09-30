## Purpose

Defines the typed in-process events that decouple sync features, and the host-capability contract through which shared code reaches files, network and storage without importing runtime-specific modules.

## ADDED Requirements

### Requirement: Typed event bus
The core SHALL provide an event bus whose event names and payloads are statically typed. This change SHALL define two events: `file.changed` (vault-relative path, change kind of `added`, `modified` or `removed`, sha256 when known) and `publish.complete` (root CID, manifest CID, counts written and removed, duration). Listeners SHALL be removable, and a throwing listener SHALL NOT stop other listeners or the publish.

#### Scenario: Publish emits completion
- **WHEN** a publish succeeds
- **THEN** one `publish.complete` event is emitted carrying the root CID, and one `file.changed` event was emitted per written or removed file

#### Scenario: Failing listener
- **WHEN** a listener throws while handling `file.changed`
- **THEN** other listeners still receive the event and the publish completes

#### Scenario: No completion on failure
- **WHEN** a publish fails before `name/publish`
- **THEN** no `publish.complete` event is emitted

### Requirement: Event payloads carry no secrets or content
Event payloads SHALL NOT contain credentials or file contents.

#### Scenario: Payload inspection
- **WHEN** events from a publish with bearer auth are captured
- **THEN** none contains the token or file bytes

### Requirement: Host capability contract
The core SHALL declare the host capability interface in full, covering the file system (`fs_*`), network (`net_*`), key-value storage (`kv_*`) and agent (`agent_*`) families, as types only. The core SHALL contain no implementation of it and SHALL import neither Obsidian nor Node modules.

#### Scenario: Core stays implementation-free
- **WHEN** the `src/` tree is scanned for Node built-in or Obsidian imports
- **THEN** none is found

### Requirement: Node host implementation
The CLI SHALL provide a Node implementation of the file-system and key-value capabilities that publish uses (read, list, stat, write for the last-published record and config; key-value for local state). The network and agent families SHALL be left unimplemented in the CLI, and calling them SHALL fail with a clear "not implemented in this host" error.

#### Scenario: Unimplemented family
- **WHEN** a network or agent capability is invoked on the Node host
- **THEN** it raises a typed not-implemented error naming the capability

### Requirement: Core freeze
After this change, files under `src/core` other than `src/core/store/` SHALL NOT be modified by later phase-mvp changes without a new spec delta approved by the product owner.

#### Scenario: Later change
- **WHEN** mvp-03 or later needs a new event
- **THEN** the event is added in the feature that produces it or in a spec delta, not by silently editing frozen files
