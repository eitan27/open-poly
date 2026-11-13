import { Fragment } from "react";
import { bannerItems, boldRuns, type WhatsNewItem } from "../whatsNew";

/** The update banner's text when the new deploy brings "what's new" entries:
 *  "New in Open Poly: A · B · C +2 more" (see src/whatsNew.ts). */
export function WhatsNewLine({ items }: { items: WhatsNewItem[] }) {
  const { shown, more } = bannerItems(items);
  return (
    <span>
      <strong>New in Open Poly:</strong>{" "}
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
