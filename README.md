# Open Poly

An open source, locally runnable, in-browser CAD application, that stores your work locally.

Open Poly runs entirely in your browser — modeling is powered by the OpenCASCADE geometry kernel (via [replicad](https://replicad.xyz/)) compiled to WebAssembly, rendered with [three.js](https://threejs.org/), with parametric sketch constraints handled by [planegcs](https://github.com/Salusoft89/planegcs). Documents autosave to your browser's IndexedDB — nothing leaves your machine.

## Requirements

- [Node.js](https://nodejs.org/) 20.19+ or 22.12+ (required by Vite 8)
- npm (ships with Node.js)

## Run

```bash
npm install
npm run dev
```

Vite prints a local URL (default http://localhost:5173) — open it in your browser.

## Create models using your favorite agent

Open Poly comes with a built-in MCP server, so it can be driven by a local LLM agent while you watch it build geometries live in the browser.

**Claude Code** (already wired):

1. Run the app: `npm run dev`, then open the printed URL and leave the tab open.
2. In a Claude Code session for this repo, run `/mcp` to connect `open-poly` (project servers prompt on first use).
3. The app's top bar shows **● Agent connected**. Now ask it to model something:
   > Using the open-poly tools, read the modeling guide, then make a 40×40×10 plate with an 8 mm hole through the middle, and fillet the top edges 2 mm.

**Other clients** (Claude Desktop, Cursor, Cline, …): point them at the same command — `npx -y tsx <absolute-path>/mcp-server/src/index.ts`. See [`mcp-server/README.md`](mcp-server/README.md) for per-client config, the full tool list, and troubleshooting.

Everything stays local: the agent talks to your browser tab over `127.0.0.1`, and every action routes through undo, so you can revert anything it does.

## Deploy

Open Poly is a fully static, client-side app, so it can be hosted on any static
host. The public build is served from **Cloudflare Pages** at
<https://open-poly.pages.dev>.

Deploys use Wrangler's **direct upload** — only the built `dist/` folder is
uploaded, so the source repository stays private and is never connected to
Cloudflare.

One-time setup:

```bash
npx wrangler login                                 # browser OAuth, once per machine
npx wrangler pages project create open-poly --production-branch main
```

Deploy (or re-deploy after changes):

```bash
npm run build
npx wrangler pages deploy dist --project-name open-poly
```

Notes:

- The agent/MCP bridge auto-disables on deployed builds (it only dials the local
  hub on `127.0.0.1`), so the public site never attempts to connect to an agent.
- `public/_redirects` sends unknown paths to `index.html` so deep links and hard
  refreshes resolve to the app.
- Documents still live in each visitor's own browser IndexedDB — the deployment
  is a shared app, not shared storage.

## Other scripts

| Command              | Description                                       |
| -------------------- | ------------------------------------------------- |
| `npm run build`      | Type-check and build a production bundle.          |
| `npm run preview`    | Serve the production build locally to preview it.  |
| `npm test`           | Run the unit tests once (Vitest).                  |
| `npm run test:watch` | Run the unit tests in watch mode (Vitest).         |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the codebase layout, dev
workflow, and PR process. Design/architecture notes and the feature
backlog live in [`docs/`](docs/).

## License

GPL-3.0-or-later — see [`LICENSE`](LICENSE). Third-party license notes
(including the LGPL constraint solver and the OCCT geometry kernel) are in
[`NOTICE.md`](NOTICE.md).
