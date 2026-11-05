/** Gap (px) kept between a nudged dialog and the window edge. */
export const DIALOG_EDGE_MARGIN = 8;

/** How far to move a box so it sits inside a `width` × `height` window, keeping
 *  `margin` clear of each edge. A box that already fits gets {0, 0}, so a
 *  dialog that opens fully on screen is never moved. A box bigger than the
 *  window is pinned by its top-left corner — the title bar it's dragged by and
 *  the first field are what has to stay reachable. */
export function shiftIntoView(
  rect: { left: number; top: number; right: number; bottom: number },
  width: number,
  height: number,
  margin = DIALOG_EDGE_MARGIN,
): { x: number; y: number } {
  const axis = (lo: number, hi: number, size: number) => {
    let s = 0;
    if (hi > size - margin) s = size - margin - hi;
    if (lo + s < margin) s = margin - lo;
    return s;
  };
  return { x: axis(rect.left, rect.right, width), y: axis(rect.top, rect.bottom, height) };
}
