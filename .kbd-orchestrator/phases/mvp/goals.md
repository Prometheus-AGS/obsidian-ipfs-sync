# Goals

- replace shell scripts with cross-platform Node 24+ CLI (spec 001, 004)
- delta sync: manifest + persistent MFS tree, mobile-safe publish and delta pull (DESIGN §4, spec 001)
- one shared kubo RPC client consumed by plugin and CLI
- plugin stays WebView-safe; conflict policy unchanged (remote wins, dated local copy)
- define framework seams for future phases: event bus, host-bridge interface, store adapters behind interfaces
- E2E fixture test green; real 1GB vault published via the new pipeline
- client-side encryption before content reaches the node: content, paths and manifest encrypted; second device unlocks by passphrase; tamper fails closed (operator decision 2026-09-29, plan rev 2)
