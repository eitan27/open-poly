// Public-facing strings for the site itself, as opposed to the app chrome.
//
// SITE_TITLE is duplicated in index.html's <title>: an HTML file cannot import
// it, and a crawler that does not run JS only ever sees that copy. The two are
// asserted equal in site.test.ts, so the duplication cannot drift.

export const SITE_TITLE = "Open Poly — parametric CAD in your browser";

const PREVIEW_SUFFIX = ".open-poly.pages.dev";

/** The preview a hostname belongs to, or null on production and local builds.
 *  A Pages preview lives at `<branch>.open-poly.pages.dev`, the branch name with
 *  "/" turned into "-" (a per-deploy `<hash>.` URL gives the hash instead), so
 *  the subdomain alone says which branch is being looked at. */
export function previewName(hostname: string): string | null {
  return hostname.endsWith(PREVIEW_SUFFIX) ? hostname.slice(0, -PREVIEW_SUFFIX.length) : null;
}
