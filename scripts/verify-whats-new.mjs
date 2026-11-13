// "What's new" in the production build (run against `npm run build && npx
// vite preview --port 4173`; the dev server shows neither banner).
// - A first visit shows nothing and records the current entries as seen.
// - A returning visitor who hasn't seen the newest entry gets it once, in the
//   update banner's style with a Dismiss link and no Refresh; the "New in Open
//   Poly" label sits on its own line, apart from the bold phrases.
// - Dismiss hides it; the next load doesn't show it again.
// - A tab open during a deploy shows the update banner (with Refresh) and
//   records what it showed, so the page Refresh loads doesn't repeat it.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const URL = process.env.URL ?? "http://localhost:4173/";
const SHOTS = process.env.SHOTS;
const KEY = "openpoly.whatsNewSeen";
const list = JSON.parse(readFileSync("dist/version.json", "utf8")).whatsNew;
const entryKey = (e) => `${e.date}|${e.items.join("|")}`;
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const fresh = async () => {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 700 },
    deviceScaleFactor: 2,
    serviceWorkers: "block",
  });
  return { context, page: await context.newPage() };
};
const ready = (page) => page.waitForSelector(".doc-title", { timeout: 60000 });
const seen = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), KEY);
const sinceBanner = (page) => page.locator(".whats-new-banner");

{
  const { context, page } = await fresh();
  await page.goto(URL);
  await ready(page);
  check("a first visit shows no what's-new banner", (await page.locator(".update-banner").count()) === 0);
  const s = await seen(page);
  check(
    "…and records every current entry as seen",
    Array.isArray(s) && s.length === list.length,
    JSON.stringify(s?.length),
  );

  // Someone who used the app before the seen record existed: no record, but
  // an open document from a past visit. They get the newest entry.
  await page.evaluate((k) => localStorage.removeItem(k), KEY);
  check(
    "…a first visit leaves an open document id behind",
    (await page.evaluate(() => localStorage.getItem("openpoly.activeDocId"))) !== null,
  );
  await page.reload();
  await ready(page);
  await sinceBanner(page).waitFor({ timeout: 10000 });
  const pre = await sinceBanner(page).innerText();
  check(
    "a visitor from before the record gets the newest entry only",
    pre.includes(list[0].items[0]) && !list.slice(1).some((e) => e.items.some((t) => pre.includes(t))),
    pre.replace(/\n/g, " ⏎ "),
  );
  await sinceBanner(page).getByText("Dismiss").click();

  // Back as someone whose last visit predates the newest entry.
  await page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [KEY, list.slice(1).map(entryKey)]);
  await page.reload();
  await ready(page);
  const banner = sinceBanner(page);
  await banner.waitFor({ timeout: 10000 });
  const text = await banner.innerText();
  check("a returning visitor sees the entry added since", text.includes(list[0].items[0]), text.replace(/\n/g, " ⏎ "));
  check(
    "…with Dismiss and no Refresh",
    (await banner.getByText("Dismiss").count()) === 1 && (await banner.getByText("Refresh").count()) === 0,
  );
  const label = banner.locator(".whats-new-label");
  const lb = await label.boundingBox();
  const first = await banner.locator("strong").first().boundingBox();
  check(
    "…the label on its own line, above the items",
    lb && first && first.y >= lb.y + lb.height - 1,
    JSON.stringify({ lb, first }),
  );
  const bold = await banner.locator("strong").allInnerTexts();
  check(
    "…and the entry's phrases bold",
    JSON.stringify(bold) === JSON.stringify(list[0].bold ?? []),
    JSON.stringify(bold),
  );
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/whats-new-since.png`, clip: await banner.boundingBox() });
  await banner.getByText("Dismiss").click();
  check("Dismiss hides it", (await sinceBanner(page).count()) === 0);
  await page.reload();
  await ready(page);
  await page.waitForTimeout(500);
  check("the next load doesn't show it again", (await page.locator(".update-banner").count()) === 0);
  await context.close();
}

{
  // A tab open during a deploy: the served list has an entry this build lacks.
  const extra = { date: "2099-01-01", items: ["Something from a later deploy"] };
  const served = { version: "newer", whatsNew: [extra, ...list] };
  const { context, page } = await fresh();
  await page.route("**/version.json*", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify(served) }),
  );
  await page.goto(URL);
  await ready(page);
  const update = page.locator(".update-banner:not(.whats-new-banner)");
  await update.waitFor({ timeout: 30000 });
  check(
    "an open tab gets the update banner, with Refresh",
    (await update.innerText()).includes(extra.items[0]) && (await update.getByText("Refresh").count()) === 1,
  );
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/whats-new-update.png`, clip: await update.boundingBox() });
  check("…and records what it showed as seen", (await seen(page)).includes(entryKey(extra)));
  check("…with no second, since-last-visit banner beside it", (await sinceBanner(page).count()) === 0);
  await context.close();
}

await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
