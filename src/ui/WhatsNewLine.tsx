import { bannerItems } from "../whatsNew";

/** The update banner's text when the new deploy brings "what's new" entries:
 *  "New in Open Poly: A · B · C +2 more" (see src/whatsNew.ts). */
export function WhatsNewLine({ items }: { items: string[] }) {
  const { shown, more } = bannerItems(items);
  return (
    <span>
      <strong>New in Open Poly:</strong> {shown.join(" · ")}
      {more > 0 && ` +${more} more`}
    </span>
  );
}
