import { Fragment } from "react";
import { bannerItems, boldRuns, type WhatsNewItem } from "../whatsNew";

/** A banner's "what's new" text (see src/whatsNew.ts): a small "NEW IN OPEN
 *  POLY" label on its own line, so its weight can't run into a bold phrase at
 *  the start of the first item, then each item on a line of its own, and "+2
 *  more" under them when there are more than fit. Used by the update banner and
 *  the since-your-last-visit one. */
export function WhatsNewLine({ items }: { items: WhatsNewItem[] }) {
  const { shown, more } = bannerItems(items);
  return (
    <span className="whats-new">
      <span className="whats-new-label">New in Open Poly</span>
      {shown.map((item, i) => (
        <span key={i} className="whats-new-item">
          {boldRuns(item.text, item.bold).map((r, j) => (
            <Fragment key={j}>{r.bold ? <strong>{r.text}</strong> : r.text}</Fragment>
          ))}
        </span>
      ))}
      {more > 0 && <span className="whats-new-more">+{more} more</span>}
    </span>
  );
}
