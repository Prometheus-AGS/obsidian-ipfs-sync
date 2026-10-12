## Purpose

Defines the publish-during-churn hardening: a file that vanishes between the scan and its read is skipped — like a file that changed — on every read path, in both hosts, so a publish or pull of a live vault never aborts over one deleted note.

## ADDED Requirements

### Requirement: Whole-file reads raise FileRemovedDuringReadError
When a file is deleted or renamed between the scan and a whole-file `read`, the CLI host (`cli/node-host-bridge.ts`) and the Obsidian host (`src/plugin/obsidian-fs.ts`) SHALL raise `FileRemovedDuringReadError` — the same error the ranged read paths already raise — and SHALL NOT pass the raw OS or adapter error through. A host raises it only when the file is really gone (ENOENT, or a stat that finds nothing), never for a read that failed for another reason.

#### Scenario: CLI host, small file deleted
- **WHEN** the CLI host's whole-file `read` is called for a file deleted since the scan
- **THEN** it throws `FileRemovedDuringReadError` naming the path, not an ENOENT

#### Scenario: Plugin host, small file deleted
- **WHEN** the plugin host's whole-file `read` is called for a file deleted since the scan
- **THEN** it throws `FileRemovedDuringReadError` naming the path, not the adapter's error

#### Scenario: Real read failure still surfaces
- **WHEN** a whole-file `read` fails for a reason other than the file being gone
- **THEN** the original error propagates unchanged

### Requirement: Publish skips removed small files instead of aborting
A publish whose scan-to-hash window loses a file of any size SHALL complete with that file in the skipped list and its reason, SHALL NOT write that file's content, and SHALL pick it up (or record its removal) on the next run. The existing skip path (`src/sync/diff.ts`) already treats `FileChangedDuringReadError` this way; this requirement extends no engine code — it makes the hosts feed the path.

#### Scenario: Publish completes over churn
- **WHEN** a file below the whole-file limit is deleted between the scan and its hash during a publish
- **THEN** the publish completes, the file appears in the skipped list with the removal reason, and the exit path is the ordinary success path

#### Scenario: Next run converges
- **WHEN** the next publish runs after a removed-file skip
- **THEN** the removed file is handled as an ordinary removal (or re-added file, if it returned) with no residual state from the skip

### Requirement: No new surface
The fix SHALL be confined to the two host `read` implementations and their tests: no new error type, no engine change, no signature change, and no new import into the WebView bundle beyond what `src/plugin/obsidian-fs.ts` already imports.

#### Scenario: Bundle unchanged
- **WHEN** `pnpm probe:webview` runs after the change
- **THEN** the plugin bundle carries no new Node import
