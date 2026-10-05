Planned, not active. Requires slice 05 closed. Ownership follows `vault-agent-ui-00-phase-overview/tasks.md`: uiux-lead owns the hosts, `src/ui/quick-ask/`, copy and design copies; data-engineer owns `src/data/quick-ask/` if a store is needed; bdd-engineer owns scenarios. Reviewers dormant until the phase gate.

## 0. Design

- [ ] 0.1 (uiux-lead, through Open Design) Draw the missing states (model loading, error, no index, nothing found, no provider, offline) and the mobile binding instruction. Requires: `vault-agent-ui-00` tasks 0.3. Files: Open Design project, then `docs/design/` copies with the slice commit. Verify: states exist; `cmp` shows the copies equal the Open Design files

## 1. Hosts and flow

- [ ] 1.1 (uiux-lead) Desktop host. Requires: 0.1, slice 05 2.2, slice 04 A2.1. Files: `src/plugin/quick-ask-modal.ts`, `src/ui/quick-ask/*`, command registration (ipfs-engineer approves the wiring diff). Command "Vault agent: quick ask", no `hotkeys`. Lazy mount; unmount on close. Verify: stub-obsidian run: the command opens the modal and the chat bundle first executes then and not at `onload`; closing unmounts and aborts any stream; `grep -rn "hotkeys" src` shows none
- [ ] 1.2 (uiux-lead) Answer mode and hand-off. Requires: 1.1, slice 05 3.2. Files: `src/ui/quick-ask/*`, host callback. Answer through the Notes pipeline; citations; lane chip with visible detail; Continue in panel opens the view on the Chat tab in Notes mode with the conversation; Ask the agent instead opens Agent mode. Verify: through the real mount with stubs: the answer goes through the Notes pipeline stub (refusal below the floor shows the refusal with both exits); Continue calls the host once with the conversation; Escape resets; there is no composer in the popup (DOM asserted); the footer shows Cmd on macOS and Ctrl elsewhere
- [ ] 1.3 (uiux-lead) Mobile sheet. Requires: 1.2. Files: `src/plugin/quick-ask-sheet.ts`, `src/ui/quick-ask/sheet.tsx`. `Platform.isMobile` picks the host; half height, expand, grabber, input at the top, 44 px controls, scrim closes. Verify: stub run picks the sheet when `isMobile` is true; layout capture at 320 and 375 widths in light and dark; operator step on an iPhone and an Android phone: keyboard does not cover the input, focus stays, sheet closes cleanly (device rows or "not run")
- [ ] 1.4 (uiux-lead; documentation-specialist) Mobile entry copy. Requires: 1.1. Files: copy file, settings link. States how to add the command to the mobile toolbar and that no button is added by the plugin. Verify: copy contains the instruction (grep listed); Settings links to the command

## 2. Proof

- [ ] 2.1 (bdd-engineer) Scenarios. Requires: 1.3. Files: `features/quick-ask.feature`. Search as you type, answer, refusal, hand-off, escape resets, no composer, sheet host on mobile. Verify: output pasted; the file states it covers stubs and Chromium, not Obsidian or a phone
