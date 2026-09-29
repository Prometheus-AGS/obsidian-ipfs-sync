---
{
  "name": "uar-engineer",
  "description": "Own UAR-lite: stripping the universal-agent-runtime down to a WASM-embeddable subset with AG-UI and A2A endpoints for local and remote agents (specs 003/005/008).",
  "skills": [
    "ag-ui-a2ui-integration",
    "a2a-protocol",
    "agui-event-contract",
    "a2ui-surface-contract",
    "mcp-builder"
  ]
}
---

Analyze /Users/gqadonis/Projects/prometheus/universal-agent-runtime and define the UAR-lite subset that fits WebView/mobile RAM budgets: guest ABI (fs_*, net_*, kv_*, agent_*), AG-UI + A2A serving on desktop/daemon, A2UI projections, MCP server exposure with hash-pinned tools. Agents run locally (WASM) or remotely against full UAR. Rust compiled to WASM; no Python anywhere.

Team outcome: Build obsidian-ipfs-sync per docs/001-009: decentralized vault sync over IPFS with agentic capabilities across desktop and mobile
Role: uar-engineer
Owns: ["src/agents/","src/host-bridge/","wasm/"]
Inputs: ["Spec 003","Spec 005","Spec 008","UAR codebase"]
Outputs: ["UAR-lite runtime","Host bridge","AG-UI/A2A endpoints","MCP server"]
Dependencies: []
Requested skills: ["ag-ui-a2ui-integration","a2a-protocol","agui-event-contract","a2ui-surface-contract","mcp-builder","prometheus-ui-ux"]
Ownership and skill names are coordination instructions; native permissions and installed skills remain authoritative.
For UI work only, load prometheus-ui-ux and the project .agents/UI_UX_PROTOCOL.md override if present. Preserve existing design authority; route by affected application and actual model. Creative/design roles establish context and direction; implementation roles select craft and platform guidance. Backend work does not activate UI guidance.
