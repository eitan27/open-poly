import { Fragment } from "react";
import { bannerItems, boldRuns, type WhatsNewItem } from "../whatsNew";

/** A banner's "what's new" text (see src/whatsNew.ts): a small "NEW IN OPEN
 *  POLY" label on its own line, so its weight can't run into a bold phrase at
 *  the start of the first item, then the newest items, a line each (see
 *  `bannerItems`). Used by the update banner and the since-your-last-visit one. */
export function WhatsNewLine({ items }: { items: WhatsNewItem[] }) {
  const shown = bannerItems(items);
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
    </span>
  );
}
