import { describe, expect, it } from "vitest";
import { PRODUCTION_HOSTS, turnstileSitekey } from "./turnstile";

// The failure mode this guards is silent: hand a production host the dummy
// sitekey and the widget still renders and still produces a token — the report
// only fails later, server-side, where the real secret rejects it. Nothing in the
// UI says why. So the host list is worth asserting rather than eyeballing.
const REAL = "0x4AAAAAAEyoMOmBmVThqB_H";
const DUMMY = "1x00000000000000000000AA";

describe("turnstileSitekey", () => {
  it("gives every production host the real key", () => {
    for (const host of PRODUCTION_HOSTS) {
      expect(turnstileSitekey(host)).toBe(REAL);
    }
  });

  it("covers both hosts during the custom-domain migration", () => {
    // Explicit rather than derived from the constant, so shrinking the list to
    // one host is a deliberate edit here too — which is the point at which the
    // redirect has to already be live.
    expect(turnstileSitekey("openpoly.dev")).toBe(REAL);
    expect(turnstileSitekey("open-poly.pages.dev")).toBe(REAL);
  });

  // A preview is not production: its token must be rejected, so it gets the dummy
  // key deliberately. This is also why the Bulk Redirect must not include
  // subdomains — a redirected preview would silently serve the live build.
  it("gives a preview deployment the dummy key", () => {
    expect(turnstileSitekey("ebfbc6e3.open-poly.pages.dev")).toBe(DUMMY);
    expect(turnstileSitekey("abc123.open-poly.pages.dev")).toBe(DUMMY);
  });

  it("gives localhost, a fork and a self-hosted copy the dummy key", () => {
    for (const host of ["localhost", "127.0.0.1", "openpoly.dev.evil.test", "cad.example.com"]) {
      expect(turnstileSitekey(host)).toBe(DUMMY);
    }
  });

  // Exact match, not suffix: a lookalike that merely ends with the canonical name
  // must not get the real key.
  it("does not match a host that only ends with a production host", () => {
    expect(turnstileSitekey("notopenpoly.dev")).toBe(DUMMY);
  });

  // `www` is NOT a production host, which is a decision rather than an oversight:
  // prefer redirecting www to the apex over serving the app on both. If it ever
  // does serve the app, it has to join PRODUCTION_HOSTS or bug reports from it
  // will 403 with nothing in the UI to say why.
  it("treats www as non-production", () => {
    expect(turnstileSitekey("www.openpoly.dev")).toBe(DUMMY);
  });
});
