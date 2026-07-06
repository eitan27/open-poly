// Default-name pickers for the Documents manager (pure, Node-tested).
// Names are display labels, not identity (ids are); these only keep the
// DEFAULTS from colliding — users may still rename two docs identically.

/** "Untitled", or the first free "Untitled N" (N ≥ 2). */
export function nextUntitled(existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has("Untitled")) return "Untitled";
  for (let n = 2; ; n++) {
    const name = `Untitled ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** "Copy of X", or the first free "Copy of X N" (N ≥ 2). */
export function copyName(source: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  const base = `Copy of ${source}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** Compact "edited …" label for the Documents dialog. */
export function timeAgo(then: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(then).toLocaleDateString();
}
