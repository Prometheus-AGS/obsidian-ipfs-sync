# Open Design MCP server for this repository

Status: operator note, 2026-10-04. Machine-local; nothing here is a product
dependency.

## What is registered

`.mcp.json` at the repository root registers one project-scoped MCP server,
`open-design`, for agent sessions started inside this repository. It is the
local Open Design daemon's own MCP bridge, launched over stdio. The file is
gitignored because it holds absolute application paths and per-launch socket
paths.

The content is exactly the install payload the daemon publishes. Regenerate it
when Open Design is reinstalled or its data directory moves:

```sh
curl -s http://127.0.0.1:60185/api/mcp/install-info \
  | python3 -c 'import json,sys; p=json.load(sys.stdin); print(json.dumps({"mcpServers":{"open-design":{"type":"stdio","command":p["command"],"args":p["args"],"env":p["env"]}}},indent=2))' \
  > .mcp.json
```

The port is the daemon's port for the current session; read it from the Open
Design app's MCP install panel if it has changed.

## The project this repository points at

| Field | Value |
|---|---|
| Project name | `Obsidian agentic search UI concept` |
| Project id | `aca77082-f254-4ccf-96da-66844bd88e46` |
| Kind | prototype |
| Linked code folder | `/Users/gqadonis/obsidian/.ipfs-sync` (this repository, read-only to the project) |
| Resolved directory | `/Users/gqadonis/Projects/references/open-design/.tmp/tools-pack/runtime/mac/namespaces/default/data/projects/aca77082-f254-4ccf-96da-66844bd88e46` |

The daemon's MCP tools (`get_project`, `get_artifact`, `get_file`,
`search_files`, `list_files`, `write_file`, `create_artifact`, `start_run`)
default to whichever project is open in Open Design. The bridge has no
environment variable that pins a project, so a session that must not depend on
what the operator has open passes `project` explicitly, by id or by a name
substring:

```json
{ "name": "get_artifact", "arguments": { "project": "aca77082-f254-4ccf-96da-66844bd88e46" } }
```

The binding is bidirectional: the Open Design project lists this repository as
a linked folder, so design runs there can read `README.md`, `docs/` and `src/`
without copying them.

## Verified

The registration was checked on 2026-10-04 by spawning the configured command
with the configured environment, sending `initialize`, then calling
`get_project` with the id above over stdio. The server answered with the
project record (name, kind `prototype`, resolved directory). The check is a
handshake, not a tool-coverage test.

## What this does not do

- It does not start Open Design. If the app is not running, the bridge's
  bootstrap command launches it headless on first use; that is the daemon's
  behaviour, not this repository's.
- It does not carry secrets. The environment holds paths only.
- It is not part of the plugin, the CLI, or any build. Deleting `.mcp.json`
  changes nothing for users.
