# Third-party licenses

Open Poly is licensed under the GNU General Public License v3.0 or later
(see [`LICENSE`](./LICENSE)). It depends on a small number of third-party
packages with their own licenses, most of which are MIT. Two are worth
calling out explicitly:

- **[`@salusoft89/planegcs`](https://github.com/Salusoft89/planegcs)**
  (the 2D sketch constraint solver, a TypeScript/WASM port of FreeCAD's
  geometric constraint solver) is licensed **LGPL-2.0-or-later**. It is
  consumed unmodified as an ordinary npm dependency (dynamically loaded,
  not vendored or statically linked into this repository's own source), so
  it can be inspected, replaced, or relinked independently of Open Poly's
  own GPL-3.0 code — the standard arrangement for using an LGPL library
  from an application.

- **[`replicad-opencascadejs`](https://www.npmjs.com/package/replicad-opencascadejs)**
  (the geometry kernel) declares **MIT** in its `package.json`, and that is
  the license on the package's own wrapper and build scripts. The artifact
  it ships, however, is a WebAssembly build of **Open CASCADE Technology**,
  which upstream is distributed under the **LGPL-2.1 with an additional
  exception** — so OCCT's own terms travel with the compiled binary
  regardless of the wrapper's declaration. It is likewise consumed
  unmodified as an ordinary npm dependency and loaded dynamically at
  runtime, never vendored into this repository's source.

  This is flagged rather than resolved: if you redistribute a *built*
  bundle of Open Poly (as opposed to this source repository), confirm what
  OCCT's exception requires of you. Using it from source, as here, is the
  ordinary case.

The remaining runtime dependencies (`replicad`, `replicad-threejs-helper`,
`three`, `react`, `react-dom`, `zod`, `dxf-parser`, `opentype.js`,
`polygon-clipping`) declare MIT. Run `npm ls` / check each package's
`package.json` for the authoritative, up-to-date license of any dependency
— note that a package's declared license describes what that package's
authors wrote, which for a build or a port is not always the whole story.
