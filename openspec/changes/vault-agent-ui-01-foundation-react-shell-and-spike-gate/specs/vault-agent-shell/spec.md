## Purpose

Defines the Vault agent view host, how the React code is loaded, the preview gate that keeps unfinished surfaces out of releases, the stub index state and the status chip.

## ADDED Requirements

### Requirement: Lazy mount
The plugin SHALL register the view cheaply in `onload` and SHALL evaluate and mount the React bundle only when the view opens. The view SHALL unmount and abort pending work on close. No React, assistant-ui or shadcn import SHALL appear in the sync core.

#### Scenario: Plugin load
- **WHEN** the plugin loads with no view open
- **THEN** the chat bundle has not executed

### Requirement: Preview gate
Until the operator lifts it, the view, its commands and the status chip SHALL NOT be registered. The gate SHALL be a boolean in plugin data defaulting to false.

#### Scenario: Gate off
- **WHEN** the plugin loads with the gate off
- **THEN** no Vault agent command, view type or status item exists

### Requirement: Tabs as view state
The view SHALL have tabs Search, Chat and Index. The active tab SHALL be view state restored by the workspace, and the view state SHALL be its only writable source; any store copy SHALL be a read projection. A tab whose slice has not shipped SHALL say so and SHALL NOT show scripted data.

#### Scenario: Reopen
- **WHEN** the view is closed and reopened with Index active
- **THEN** Index is active

### Requirement: Honest stub
Until a real index service exists the Index tab SHALL show an `unavailable` state with no counts, model name or sizes. Production code SHALL contain no scripted index numbers.

#### Scenario: Stub state
- **WHEN** the Index tab renders against the stub
- **THEN** its text contains no count and states that no index exists on this device

### Requirement: Status chip
The chip SHALL derive its text only from the index store, SHALL open the Index tab on click, and SHALL NOT be created when the gate is off. On a device without a status bar the Index tab SHALL carry the same facts.

#### Scenario: Gate on, stub
- **WHEN** the gate is on and the index is unavailable
- **THEN** the chip states that fact and click opens the Index tab

### Requirement: Layering
Components SHALL import only hooks, hooks SHALL import stores, stores SHALL call services, services SHALL import no React, zustand or store. Components SHALL NOT import `obsidian`. Entry points SHALL be commands with no default hotkeys.

#### Scenario: Component imports a store
- **WHEN** a component file imports from `src/data`
- **THEN** `check:layering` exits non-zero
