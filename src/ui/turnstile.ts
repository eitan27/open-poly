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
// The sitekey is chosen by host, like that gate. The real widget is bound to
// open-poly.pages.dev in the Cloudflare dashboard, so it only validates there;
// everywhere else — localhost, a fork, a self-hosted copy — gets Cloudflare's
// published always-passes dummy key, which works from any domain. That keeps
// the dialog exercisable in development instead of being dead below production.
// The sitekey is public by design; it is in the page source of every deployed
// site that uses Turnstile. The SECRET half lives only in the Pages environment
// (TURNSTILE_SECRET) and is read by functions/api/report.ts.

/** The one host where the real widget is registered. */
export const PRODUCTION_HOST = "open-poly.pages.dev";

/** Cloudflare's dummy sitekey that always passes, usable from any domain. */
const DUMMY_SITEKEY = "1x00000000000000000000AA";
const REAL_SITEKEY = "0x4AAAAAAEyoMOmBmVThqB_H";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export function turnstileSitekey(hostname: string = location.hostname): string {
  return hostname === PRODUCTION_HOST ? REAL_SITEKEY : DUMMY_SITEKEY;
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
