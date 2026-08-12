# Open Poly MCP server

A local **stdio MCP server** that lets an LLM agent (Claude Desktop, Cursor,
Cline, Zed, …) **drive a live Open Poly browser tab** — sketch, extrude,
transform, combine — while you watch it happen, and **read** state (document,
scene summary, screenshot) so it can plan and self-correct. Part of Phase 9; see
[`../docs/PLAN.md`](../docs/PLAN.md) and `src/agent/modeling-guide.md`.

## Try it (manual test, with Claude Desktop)

The MCP **client launches this server itself** (which starts the hub). You only
have to (1) run the app and (2) point the client at the server. Order doesn't
matter — the tab reconnects until the hub is up.

1. **Run the app and open it.** From the repo root:

   ```sh
   npm run dev
   ```

   Open the printed URL (e.g. http://localhost:5173/) in a browser and **leave
   the tab open**.

2. **Tell Claude Desktop about the server.** Edit
   `~/Library/Application Support/Claude/claude_desktop_config.json` (create it if
   missing) and add:

   ```json
   {
     "mcpServers": {
       "open-poly": {
         "command": "npx",
         "args": ["-y", "tsx", "/Users/eitan/Developer/open-shape/mcp-server/src/index.ts"]
       }
     }
   }
   ```

3. **Restart Claude Desktop** (fully quit and reopen) so it picks up the config
   and spawns the server.

4. **Confirm the link.** The app's top bar should show **● Agent connected**, and
   in Claude Desktop the `open-poly` tools should appear (plug/tools icon).

5. **Drive it.** Ask, e.g.:

   > Using the open-poly tools, read the modeling guide, then make a 40×40×10
   > plate with an 8 mm hole through the middle and fillet the top edges 2 mm.
   > Screenshot it when done.

   Watch the geometry build live in the browser. If something's off, the agent
   sees the error/screenshot and self-corrects. Gaps it hits land in
   `mcp-server/issues.log.jsonl`.

**If the tools don't show up:** check Claude Desktop's MCP logs
(`~/Library/Logs/Claude/mcp*.log`), make sure the absolute path is correct, and
confirm `node`/`npx` are on the PATH the app launches with. **If the badge never
turns on:** make sure the app tab is open and nothing else is bound to port 7373.

> Prefer a no-LLM smoke test? `node scripts/mcp-e2e.mjs` (with `npm run dev`
> running) exercises the whole pipeline headlessly. Or inspect tools interactively
> with `npx @modelcontextprotocol/inspector npx tsx mcp-server/src/index.ts`.

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

**Claude Code** — already wired via the committed `.mcp.json` at the repo root
(relative path; Claude Code runs it with the repo as the working directory). In a
session for this repo, run `/mcp` to approve/connect `open-poly` (project-scoped
servers prompt on first use); `claude mcp list` shows status. To configure it
yourself instead of using the committed file:

```sh
claude mcp add open-poly -- npx -y tsx "$PWD/mcp-server/src/index.ts"
```

> MCP servers load at session start, so a session that was already open won't see
> `open-poly` until you restart it (or reconnect via `/mcp`). Then run the app
> (`npm run dev`) and open the tab as in the walkthrough above.

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
