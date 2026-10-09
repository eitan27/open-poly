// Cloudflare Turnstile: the spam check in front of /api/report.
//
// Two things worth knowing before touching this.
//
// The script is fetched ON DEMAND, when the report dialog opens — never at page
// load. Open Poly's whole claim is that nothing leaves your machine, and a
// third-party script on every visit would quietly make that false for the sake
// of a form almost nobody opens. Same reasoning as the analytics beacon gate in
// index.html.
//
// The sitekey is chosen by host, like that gate. The real widget is bound to the
// production hosts in the Cloudflare dashboard, so it only validates there;
// everywhere else — localhost, a fork, a self-hosted copy, and every
// *.pages.dev preview deployment — gets Cloudflare's published always-passes
// dummy key, which works from any domain. That keeps the dialog exercisable in
// development instead of being dead below production.
//
// Note what that means for previews: a preview URL deliberately gets the dummy
// key, so a report filed from one is rejected by the real secret server-side.
// That is correct — a preview is not production — but it is why testing the
// report flow for real has to happen on openpoly.dev.
// The sitekey is public by design; it is in the page source of every deployed
// site that uses Turnstile. The SECRET half lives only in the Pages environment
// (TURNSTILE_SECRET) and is read by functions/api/report.ts.

/** The hosts where the real widget is registered.
 *
 *  Two, transitionally. `openpoly.dev` is canonical and `open-poly.pages.dev`
 *  301s to it via an account-level Bulk Redirect — but the redirect, the custom
 *  domain and this deploy land at different moments, and whichever host traffic
 *  is on at the time must get the REAL key: hand it the dummy one and every bug
 *  report 403s against the real secret, silently. Listing both removes the
 *  window entirely, in any order.
 *
 *  Drop `open-poly.pages.dev` once the redirect is confirmed live — at that point
 *  no real traffic reaches it, and keeping it only means a preview-like host
 *  would get the real key. Preview deployments are unaffected either way: their
 *  `<hash>.open-poly.pages.dev` names are not in this list, so they get the
 *  dummy key, which is correct. */
export const PRODUCTION_HOSTS = ["openpoly.dev", "open-poly.pages.dev"] as const;

/** Cloudflare's dummy sitekey that always passes, usable from any domain. */
const DUMMY_SITEKEY = "1x00000000000000000000AA";
const REAL_SITEKEY = "0x4AAAAAAEyoMOmBmVThqB_H";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export function turnstileSitekey(hostname: string = location.hostname): string {
  return (PRODUCTION_HOSTS as readonly string[]).includes(hostname) ? REAL_SITEKEY : DUMMY_SITEKEY;
}

interface TurnstileApi {
  render(
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback"?: () => void;
      "expired-callback"?: () => void;
      theme?: "auto" | "light" | "dark";
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** Fetch the Turnstile script once per page and resolve with its API. Rejects
 *  if it cannot load — offline, or blocked by an extension — which the caller
 *  must surface rather than leaving the user with a form that can't submit. */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = SCRIPT_SRC;
    el.async = true;
    el.defer = true;
    el.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile did not register")));
    el.onerror = () => reject(new Error("turnstile script failed to load"));
    document.head.appendChild(el);
  });
  // A failed load must not poison later attempts — reopening the dialog retries.
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
