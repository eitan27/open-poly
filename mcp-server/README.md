# Open Poly MCP server

A local **stdio MCP server** that lets an LLM agent (Claude Desktop, Cursor,
Cline, Zed, …) **drive a live Open Poly browser tab** — sketch, extrude,
transform, combine — while you watch it happen, and **read** state (document,
scene summary, screenshot) so it can plan and self-correct. Part of Phase 9; see
`PLAN.md` and `src/agent/modeling-guide.md`.

## How it works

```
LLM client ⟷ (stdio MCP) ⟷  this server + WS hub (one Node process)  ⟷ (WebSocket) ⟷  browser tab
```

The browser tab holds the document and renders it, so it **connects out** to the
hub on `ws://127.0.0.1:7373`. An MCP tool call is forwarded over the WebSocket to
the tab, applied via the vendor-neutral command layer (`src/agent/`, routed
through undo), and the result (ids/errors, or a PNG for `screenshot`) comes back
to the LLM. **Conventions: millimetres, world is Z-up; reference geometry by the
stable ids/names from `get_scene_summary`.**

## Run it

The server runs straight from TypeScript with [`tsx`](https://tsx.is) (installed
at the repo root). From the repo root:

```sh
npx tsx mcp-server/src/index.ts
```

Then open the Open Poly app in your browser — the tab dials the hub automatically
and the top bar shows **● Agent connected**.

## Client config

Point your MCP client at the same command. Use an **absolute path** to
`index.ts` and run with the repo as the working directory.

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "open-poly": {
      "command": "npx",
      "args": ["-y", "tsx", "/ABS/PATH/TO/open-shape/mcp-server/src/index.ts"]
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`) / **Cline** use the same `command` + `args` shape.

## Tools

- **One per document operation** (snake_case): `add_primitive`, `add_sketch`,
  `add_extrude`, `add_plane`, `transform`, `boolean`, `dress_up`, `set_param`,
  `set_variable`, `set_appearance`, `rename`, `delete`, `set_rollback`, `select`,
  `import_step`.
- **Reads:** `get_document`, `get_scene_summary`, `get_selection`, `screenshot`
  (returns a PNG image).
- **`get_modeling_guide`** — the modeling playbook (also exposed as the
  `openpoly://modeling-guide` resource and the `modeling_guide` prompt).
- **`report_issue`** — the agent's feedback loop: `missing_feature` | `bug` |
  `friction`, appended to `mcp-server/issues.log.jsonl` (gitignored) for review.

Tool input schemas are derived from the **shared zod schemas** in
`src/agent/operations.ts`, so the wire contract can't drift from the browser.

## Validate

With the dev server running (`npm run dev`):

```sh
node scripts/mcp-e2e.mjs            # spawns this server + a headless tab, drives tools
```

or inspect interactively with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```sh
npx @modelcontextprotocol/inspector npx tsx mcp-server/src/index.ts
```

> **v1 scope:** local, single-user, single active tab (last-connected wins), no
> auth token yet (planned for L4). The hub binds `127.0.0.1` only.
