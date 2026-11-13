import { Fragment } from "react";
import { bannerItems, boldRuns, type WhatsNewItem } from "../whatsNew";

/** A banner's "what's new" text (see src/whatsNew.ts): a small "NEW IN OPEN
 *  POLY" label on its own line, so its weight can't run into a bold phrase at
 *  the start of the first item, then "A · B · C +2 more". Used by the update
 *  banner and the since-your-last-visit one. */
export function WhatsNewLine({ items }: { items: WhatsNewItem[] }) {
  const { shown, more } = bannerItems(items);
  return (
    <span className="whats-new">
      <span className="whats-new-label">New in Open Poly</span>
      {shown.map((item, i) => (
        <Fragment key={i}>
          {i > 0 && " · "}
          {boldRuns(item.text, item.bold).map((r, j) => (r.bold ? <strong key={j}>{r.text}</strong> : r.text))}
        </Fragment>
      ))}
      {more > 0 && ` +${more} more`}
    </span>
  );
}
