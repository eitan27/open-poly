import { Fragment } from "react";
import { boldRuns, type WhatsNewItem } from "../whatsNew";

/** A banner's "what's new" text (see src/whatsNew.ts): a small "NEW IN OPEN
 *  POLY" label on its own line, so its weight can't run into a bold phrase at
 *  the start of the first item, then every item, a line each. Used by the
 *  update banner and the since-your-last-visit one. A try line in the update
 *  banner (`refresh`) starts with a "Refresh the page" link, as its key or
 *  tool isn't in this tab's build yet. */
export function WhatsNewLine({ items }: { items: WhatsNewItem[] }) {
  return (
    <span className="whats-new">
      <span className="whats-new-label">New in Open Poly</span>
      {items.map((item, i) => (
        <span key={i} className="whats-new-item">
          {item.refresh && (
            <>
              <button className="banner-link whats-new-refresh" onClick={() => location.reload()}>
                Refresh the page
              </button>{" "}
              and{" "}
            </>
          )}
          {boldRuns(item.text, item.bold).map((r, j) => (
            <Fragment key={j}>{r.bold ? <strong>{r.text}</strong> : r.text}</Fragment>
          ))}
        </span>
      ))}
    </span>
  );
}
