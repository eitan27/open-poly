# Third-party licenses

Open Poly is licensed under the GNU General Public License v3.0 or later
(see [`LICENSE`](./LICENSE)). It depends on a small number of third-party
packages with their own licenses, most of which are MIT. One is worth
calling out explicitly:

- **[`@salusoft89/planegcs`](https://github.com/Salusoft89/planegcs)**
  (the 2D sketch constraint solver, a TypeScript/WASM port of FreeCAD's
  geometric constraint solver) is licensed **LGPL-2.0-or-later**. It is
  consumed unmodified as an ordinary npm dependency (dynamically loaded,
  not vendored or statically linked into this repository's own source), so
  it can be inspected, replaced, or relinked independently of Open Poly's
  own GPL-3.0 code — the standard arrangement for using an LGPL library
  from an application.

All other runtime dependencies (`replicad`, `replicad-opencascadejs`,
`replicad-threejs-helper`, `three`, `react`, `react-dom`, `zod`,
`dxf-parser`, `opentype.js`, `polygon-clipping`) are MIT-licensed. Run
`npm ls` / check each package's `package.json` for the authoritative,
up-to-date license of any dependency.
