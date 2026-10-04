## Purpose

Defines the provider settings: list, add, edit, remove, test, model selection, default per mode, key entry, consent, lane semantics, and the absence of the desktop panel in the first release.

## ADDED Requirements

### Requirement: Provider list
The settings SHALL list providers with label, kind, host, model, lane chip and a streaming label, and SHALL offer add, edit, remove and test. Test connection SHALL send no note text.

#### Scenario: Test
- **WHEN** the user tests a provider
- **THEN** the result is one of ok, unreachable, unauthorized or model missing, and no vault content was sent

### Requirement: Model selection
The user SHALL choose a model from the provider's list, and SHALL be able to type one when listing fails.

#### Scenario: Listing fails
- **WHEN** the model list call fails
- **THEN** a manual entry field is offered and the failure is stated

### Requirement: Default per mode and consent
A default provider SHALL be set per mode (Notes, Agent). A default SHALL NOT be settable until the user has accepted a consent that names the host, what that mode sends, that it leaves the encrypted-vault boundary, and that the provider's retention applies. Consent SHALL be stored per provider and mode and SHALL be asked again when the host changes. No provider SHALL be a default on first run.

#### Scenario: Host changes
- **WHEN** the user edits a provider's base URL to a different host
- **THEN** its consent is cleared and any default that relied on it is cleared

### Requirement: Key entry
The key field SHALL be masked, SHALL write to the key store and SHALL NOT place the key in plugin data, the DOM value attribute or component state where the mechanism avoids it. Removing a provider SHALL remove its stored key where the mechanism allows and SHALL say plainly where it cannot.

#### Scenario: After saving
- **WHEN** a provider is saved
- **THEN** plugin data holds a secret id and no key

### Requirement: Lane semantics
A provider SHALL show `Local` only when its host is loopback and `Remote` otherwise. The chip SHALL carry visible text and SHALL add a connectivity suffix when the device is offline.

#### Scenario: LAN host
- **WHEN** a provider's host is a LAN address
- **THEN** its chip reads Remote

### Requirement: Desktop panel absent
The first release SHALL NOT render a desktop detection panel, empty, disabled or otherwise. The layout SHALL reserve a named slot that is absent from the DOM until the desktop adapters ship, and that is hidden on mobile when it does.

#### Scenario: Desktop and mobile
- **WHEN** the provider settings render on desktop or mobile
- **THEN** no desktop detection element exists in the DOM

### Requirement: Mobile statement
On mobile the settings SHALL state that only the two REST kinds are available and that a Claude or Codex subscription cannot be used there.

#### Scenario: Phone
- **WHEN** the settings open on a phone
- **THEN** the statement is visible
