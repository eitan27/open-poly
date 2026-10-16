# Third-party licenses

Open Poly is licensed under the GNU General Public License v3.0 or later
(see [`LICENSE`](../LICENSE)). It depends on a small number of third-party
packages with their own licenses, most of which are MIT, and it bundles one
font.

This file is the _reasoning_: the three components whose terms need an
argument. It is not the list. The complete per-package list is generated at
build time into `dist/third-party-licenses.txt` — see the end of this file.

The three:

- **[`@salusoft89/planegcs`](https://github.com/Salusoft89/planegcs)**
  (the 2D sketch constraint solver, a TypeScript/WASM port of FreeCAD's
  geometric constraint solver) is licensed **LGPL-2.0-or-later**. It is
  consumed unmodified as an ordinary npm dependency. Its TypeScript wrapper
  is minified into the app bundle by the production build, which changes
  nothing: what the LGPL asks is that a recipient be able to relink the
  combined work against their own build of the library, and the complete
  corresponding source of Open Poly is public under GPL-3.0 — so anyone can
  substitute a different planegcs and rebuild, bundled or not.

- **[`replicad-opencascadejs`](https://www.npmjs.com/package/replicad-opencascadejs)**
  (the geometry kernel) declares **MIT** in its `package.json`, and that is
  the license on the package's own wrapper and build scripts. The artifact
  it ships, however, is a WebAssembly build of **Open CASCADE Technology**
  (Copyright © 1991–1999 Matra Datavision, © 1999–2014 OPEN CASCADE SAS and
  contributors), which upstream is distributed under the **LGPL-2.1 with an
  additional exception** — so OCCT's own terms travel with the compiled
  binary regardless of the wrapper's declaration.

  Open Poly does redistribute a built bundle: the deployment at
  <https://openpoly.dev> conveys `dist/assets/replicad_single-*.wasm`,
  which is OCCT in object form. That is LGPL-2.1 §4, and it is satisfied
  here without any special effort. The wasm is an unmodified, publicly
  published build (`replicad-opencascadejs` on npm) of unmodified upstream
  OCCT, so its corresponding source is available from the same public places
  any recipient can already reach. It is loaded as a separate file at
  runtime rather than merged into the JavaScript bundle, so replacing it
  with a different OCCT build takes nothing from us (§6) — and Open Poly's
  own source is public under GPL-3.0 in any case. The exception itself only
  relaxes the treatment of OCCT header material inlined into object code,
  on two conditions: carry OCCT's copyright notice, and say prominently that
  the software includes Open CASCADE components. This file does both, and
  the README links to it.

- **[Inter](https://github.com/rsms/inter)** (`public/fonts/Inter-Regular.ttf`,
  the font sketch text is rendered and extruded with) is licensed under the
  **SIL Open Font License 1.1** — "Copyright 2016 The Inter Project Authors
  (https://github.com/rsms/inter)". The OFL asks that the notice and license
  accompany every copy of the font; the font's own machine-readable name
  table already carries both, which condition 2 expressly accepts, so
  [`OFL.txt`](../OFL.txt) is here as a plain-text convenience rather than to
  close a gap — and the generated notices file now carries the same text into
  the download itself. The OFL covers the font file only — not Open Poly,
  and not anything you draw with it.

## Everything else

Permissive and GPL-3.0-compatible: mostly MIT, with Unlicense and ISC turning
up transitively. Rather than list them here — the version of this paragraph
that did went out of date — the exhaustive list is generated:

    dist/third-party-licenses.txt

every runtime dependency that ships in the bundle, with its license text
verbatim, built from the packages actually installed for that build by
[`scripts/third-party-licenses.ts`](../scripts/third-party-licenses.ts). It is
emitted next to the bundles it describes and served at
<https://openpoly.dev/third-party-licenses.txt>, linked from the app's
Settings dialog, so a visitor who only ever receives the built site receives
the notices with it. A package whose terms the generator cannot read fails the
build rather than shipping unattributed.

One caveat that no generator can fix: a package's _declared_ license describes
what that package's authors wrote, which for a build or a port is not always
the whole story. The OCCT case above is exactly that.
