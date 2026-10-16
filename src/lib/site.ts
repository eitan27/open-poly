// Public-facing strings for the site itself, as opposed to the app chrome.
//
// SITE_TITLE is duplicated in index.html's <title>: an HTML file cannot import
// it, and a crawler that does not run JS only ever sees that copy. The two are
// asserted equal in site.test.ts, so the duplication cannot drift.

export const SITE_TITLE = "Open Poly — parametric CAD in your browser";
