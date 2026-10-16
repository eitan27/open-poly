// Generates `dist/third-party-licenses.txt` — the notices the shipped bundle
// is legally required to carry.
//
// WHY THIS IS GENERATED RATHER THAN WRITTEN. Almost every dependency here is
// MIT, and MIT asks that its copyright notice travel with "all copies or
// substantial portions of the Software". A production build minifies those
// packages into `dist/assets/*.js` and strips the comments that carried their
// notices, so the copy a visitor downloads has none — the repo's docs/NOTICE.md is
// not a copy the visitor receives. This file is emitted into the same `dist/`
// as those bundles, so the notices ship with the code they belong to.
//
// WHY NOT `public/`. Vite copies `public/` verbatim, which would mean a
// hand-maintained list — exactly the thing that drifts out of date as
// dependencies come and go (docs/NOTICE.md did). Emitting from a build plugin means
// the file is derived from the packages actually installed for that build, and
// a dependency that turns up without a readable license breaks the build
// instead of quietly shipping unattributed.
//
// SCOPE. The runtime dependency tree — `dependencies`, transitively, which is
// what `npm ls --omit=dev` walks — since that is what the browser downloads.
// devDependencies are not in the bundle and are not listed. Two things a visitor
// receives are not packages in that tree and so are added by hand below: the
// OCCT wasm, whose own terms `replicad-opencascadejs` does not ship, and the
// Inter font in `public/fonts`. (The planegcs wasm needs no separate entry — it
// arrives inside its npm package, which is in the tree.)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** One thing a visitor receives that Open Poly didn't write. */
interface Component {
  name: string;
  /** Absent for the components that aren't npm packages. */
  version?: string;
  /** The SPDX identifier the package declares, or the one that actually applies. */
  license: string;
  /** Where the thing comes from. */
  source?: string;
  /** Why this entry says something the package.json doesn't. */
  note?: string;
  /** The license text itself, verbatim. */
  text: string;
}

const RULE = "-".repeat(78);

/** Drops blank lines at either end without touching indentation — license texts
 *  centre their headings with leading spaces, and `trim()` eats those. */
function trimBlankLines(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
}

/** `@types/*` hold declaration files only — nothing they contain is compiled
 *  into the bundle, so they aren't distributed and need no notice here. */
const isTypesOnly = (name: string) => name.startsWith("@types/");

/** Resolves `name` the way Node would from `fromDir`: nearest `node_modules`
 *  walking up. Not `require.resolve`, which an `exports` map can refuse. */
function packageDir(name: string, fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The license text a package ships with itself: a LICENSE/COPYING file if it
 *  has one, otherwise the README's License section (which is where a few
 *  small packages put it — splaytree, for one). Null if it has neither. */
function licenseText(dir: string): string | null {
  const files = readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying)/i.test(f))
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort();
  if (files.length > 0) return files.map((f) => trimBlankLines(readFileSync(join(dir, f), "utf8"))).join("\n\n");

  for (const readme of readdirSync(dir).filter((f) => /^readme/i.test(f))) {
    const lines = readFileSync(join(dir, readme), "utf8").split("\n");
    const start = lines.findIndex((l) => /^#{1,6}\s+.*licen[cs]e/i.test(l));
    if (start === -1) continue;
    const depth = lines[start].match(/^#+/)![0].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const heading = lines[i].match(/^#+/);
      if (heading && heading[0].length <= depth) {
        end = i;
        break;
      }
    }
    return trimBlankLines(lines.slice(start + 1, end).join("\n"));
  }
  return null;
}

/** A package's own idea of where it lives, for the reader who wants the source
 *  the notice refers to. Falls back to the package's npm page, which always
 *  exists — `replicad-opencascadejs` declares neither repository nor homepage. */
function sourceUrl(name: string, pkg: Record<string, unknown>): string {
  const repo = pkg.repository as string | { url?: string } | undefined;
  const url = typeof repo === "string" ? repo : repo?.url;
  if (url) {
    return (
      url
        .replace(/^git\+/, "")
        .replace(/\.git$/, "")
        .replace(/^git:\/\//, "https://")
        .replace(/^git@github\.com:/, "https://github.com/")
        // npm's shorthand forms: "github:owner/repo", or a bare "owner/repo".
        .replace(/^github:/, "https://github.com/")
        .replace(/^(?!https?:\/\/)([\w.-]+\/[\w.-]+)$/, "https://github.com/$1")
    );
  }
  if (typeof pkg.homepage === "string" && pkg.homepage !== "") return pkg.homepage;
  return `https://www.npmjs.com/package/${name}`;
}

/** Notes that say what a package.json can't. Distilled from docs/NOTICE.md, which
 *  reasons about the same three at length. */
const NOTES: Record<string, string> = {
  "@salusoft89/planegcs":
    "The 2D sketch constraint solver: a TypeScript/WebAssembly port of FreeCAD's\n" +
    "geometric constraint solver, under the LGPL. Open Poly consumes it unmodified\n" +
    "as an ordinary npm dependency; the production build minifies its TypeScript\n" +
    "wrapper into the bundle and loads its wasm as a separate file. What the LGPL\n" +
    "asks is that a recipient be able to relink the combined work against their own\n" +
    "build of the library, and Open Poly's complete corresponding source is public\n" +
    "under GPL-3.0 — so anyone can substitute a different planegcs and rebuild.",
  "replicad-opencascadejs":
    "MIT is the license on this package's own wrapper and build scripts. The\n" +
    "artifact it ships is a WebAssembly build of Open CASCADE Technology, whose own\n" +
    "terms travel with the compiled binary — see the Open CASCADE Technology entry\n" +
    "below.",
};

/** Walks the runtime dependency tree from the root package.json. */
function runtimePackages(root: string): Component[] {
  const found = new Map<string, Component>();
  const visited = new Set<string>();

  const visit = (name: string, fromDir: string) => {
    const dir = packageDir(name, fromDir);
    if (!dir) throw new Error(`third-party-licenses: ${name} is a runtime dependency but isn't installed`);
    if (visited.has(dir)) return;
    visited.add(dir);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    if (!isTypesOnly(name)) {
      const text = licenseText(dir);
      if (!text) {
        throw new Error(
          `third-party-licenses: ${name} ships no license text — read its terms and handle it explicitly in scripts/third-party-licenses.ts`,
        );
      }
      const license = pkg.license;
      if (typeof license !== "string") {
        throw new Error(`third-party-licenses: ${name} declares no license in its package.json`);
      }
      found.set(`${name}@${pkg.version as string}`, {
        name,
        version: pkg.version as string,
        license,
        source: sourceUrl(name, pkg),
        note: NOTES[name],
        text,
      });
    }
    for (const dep of Object.keys((pkg.dependencies as Record<string, string>) ?? {})) visit(dep, dir);
    for (const dep of Object.keys((pkg.optionalDependencies as Record<string, string>) ?? {})) {
      if (packageDir(dep, dir)) visit(dep, dir);
    }
  };

  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  for (const dep of Object.keys((rootPkg.dependencies as Record<string, string>) ?? {})) visit(dep, root);

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The two components that arrive as files rather than as npm packages, and
 *  whose terms no package.json in the tree states. */
function fileComponents(root: string): Component[] {
  // replicad-opencascadejs ships the compiled OCCT wasm but none of OCCT's own
  // license files, so `licenses/` carries them verbatim from upstream OCCT.
  const occtHeader = [
    "Copyright (c) 1991-1999 Matra Datavision",
    "Copyright (c) 1999-2014 OPEN CASCADE SAS",
    "",
    "This library is free software; you can redistribute it and/or modify it under",
    "the terms of the GNU Lesser General Public License version 2.1 as published",
    "by the Free Software Foundation, with special exception defined in the file",
    "OCCT_LGPL_EXCEPTION.txt. Consult the file LICENSE_LGPL_21.txt included in OCCT",
    "distribution for complete text of the license and disclaimer of any warranty.",
    "",
    "Both files are reproduced in full below.",
  ].join("\n");
  const exception = trimBlankLines(readFileSync(join(root, "licenses/OCCT_LGPL_EXCEPTION.txt"), "utf8"));
  const lgpl = trimBlankLines(readFileSync(join(root, "licenses/LICENSE_LGPL_21.txt"), "utf8"));

  return [
    {
      name: "Open CASCADE Technology",
      license: "LGPL-2.1-only WITH OCCT-exception-1.0",
      source: "https://github.com/Open-Cascade-SAS/OCCT",
      note:
        "The geometry kernel, shipped as assets/replicad_single-*.wasm — Open CASCADE\n" +
        "Technology compiled to WebAssembly by the replicad-opencascadejs package.\n" +
        "That is object form under LGPL-2.1 section 4, and it is satisfied without\n" +
        "special effort: the wasm is an unmodified, publicly published build of\n" +
        "unmodified upstream OCCT, so its corresponding source is available from the\n" +
        "same public places any recipient can already reach, and it is loaded as a\n" +
        "separate file at runtime rather than merged into the JavaScript, so replacing\n" +
        "it with a different OCCT build takes nothing from us (section 6). Open Poly's\n" +
        "own source is public under GPL-3.0 in any case. The exception relaxes the\n" +
        "treatment of OCCT header material inlined into object code on two conditions:\n" +
        "carry OCCT's copyright notice, and say prominently that the software includes\n" +
        "Open CASCADE components. This file does both.",
      text: `${occtHeader}\n\n${RULE}\n\n${exception}\n\n${RULE}\n\n${lgpl}`,
    },
    {
      name: "Inter",
      license: "OFL-1.1",
      source: "https://github.com/rsms/inter",
      note:
        "The typeface sketch text is rendered and extruded with, shipped as\n" +
        "fonts/Inter-Regular.ttf. The OFL covers the font file only — not Open Poly,\n" +
        "and not anything you draw with it.",
      text: trimBlankLines(readFileSync(join(root, "OFL.txt"), "utf8")),
    },
  ];
}

/** Renders the whole file. Exported for the dev-server middleware below. */
export function renderThirdPartyLicenses(root: string): string {
  const components = [...runtimePackages(root), ...fileComponents(root)];
  const width = Math.max(...components.map((c) => `${c.name} ${c.version ?? ""}`.trim().length));

  const contents = components
    .map((c) => `  ${`${c.name} ${c.version ?? ""}`.trim().padEnd(width)}  ${c.license}`)
    .join("\n");

  const header = [
    "Open Poly — third-party licenses",
    "================================",
    "",
    "Open Poly is free software under the GNU General Public License, version 3 or",
    "later. Its complete source is at https://github.com/eitan27/open-poly.",
    "",
    "The application also carries code Open Poly did not write. Building it for",
    "production minifies that code, which strips the comments its licenses ask to be",
    "carried along with every copy — so the notices are collected here instead, in",
    "the same download. Every component below is listed with its own license text,",
    "verbatim, as that component ships it.",
    "",
    "Open Poly includes software developed by Open CASCADE SAS: its geometry kernel",
    "is a WebAssembly build of Open CASCADE Technology. See the entry for Open",
    "CASCADE Technology below.",
    "",
    "This file is generated at build time from the packages installed for the build",
    "(see scripts/third-party-licenses.ts); it is not maintained by hand.",
    "",
    `${components.length} components:`,
    "",
    contents,
    "",
  ].join("\n");

  const sections = components.map((c) => {
    const title = [`${c.name} ${c.version ?? ""}`.trim(), c.license].join("  —  ");
    const head = [RULE, title, ...(c.source ? [c.source] : []), ...(c.note ? ["", c.note] : []), RULE, ""];
    return `${head.join("\n")}\n${c.text}\n`;
  });

  return [header, ...sections].join("\n");
}

/**
 * Emits `third-party-licenses.txt` next to the bundles it describes, and serves
 * the same text in `vite dev` so the link in Settings isn't dead there.
 */
export function thirdPartyLicenses(): Plugin {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return {
    name: "third-party-licenses",
    // Worker builds are separate Rollup builds that don't run these plugins,
    // so this emits exactly once, into the client output.
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "third-party-licenses.txt",
        source: renderThirdPartyLicenses(root),
      });
    },
    configureServer(server) {
      server.middlewares.use("/third-party-licenses.txt", (_req, res) => {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(renderThirdPartyLicenses(root));
      });
    },
  };
}
