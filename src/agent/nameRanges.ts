// Folding long runs of numbered face/edge names into one line each, for the
// scene summaries.
//
// A faceted round wall is one face per facet (`<id>/bore0` … `bore95`), and a
// gear has ~25 faces a tooth, so a part's name list can run to thousands of
// entries — a 33- and a 14-tooth gear made a 335k-character assembly summary,
// too big for an agent to read. The names follow patterns, so the fold loses
// nothing: `<id>/side{n} (n = 0–339)` stands for every name it covers, and an
// edge between neighbouring facets reads `<id>/side{n}∩<id>/side{n+1}
// (n = 0–338)`. Names outside any run of at least MIN_RUN stay as they are.

/** Fewer names than this sharing a pattern are listed one by one. */
const MIN_RUN = 4;

interface Split {
  /** The name with each trailing number replaced by a slot marker. */
  parts: string[];
  nums: number[];
}

/** Each `∩`-joined component's local name (after its last `/`) may end in a
 *  number (`side12`, `bore0`, `rim95`); that number is a slot. Numbers inside
 *  ids (uuids) are never touched: only the end of the local name counts. */
function split(name: string): Split | null {
  const parts: string[] = [];
  const nums: number[] = [];
  for (const comp of name.split("∩")) {
    const slash = comp.lastIndexOf("/");
    const local = comp.slice(slash + 1);
    const m = /^(.*[^\d])(\d+)$/.exec(local);
    if (m && !m[1].endsWith("-")) {
      parts.push(comp.slice(0, slash + 1) + m[1]);
      nums.push(Number(m[2]));
    } else {
      parts.push(comp);
      nums.push(NaN);
    }
  }
  return nums.some((n) => !Number.isNaN(n)) ? { parts, nums } : null;
}

/** "0–3, 7, 9–12" from sorted unique integers. */
function ranges(ns: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < ns.length;) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    out.push(j === i ? String(ns[i]) : j === i + 1 ? `${ns[i]}, ${ns[j]}` : `${ns[i]}–${ns[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}

/** `names` with every run of at least MIN_RUN names that differ only by one
 *  number (or by numbers a fixed distance apart, as neighbouring facets' edge
 *  is) folded into one `pattern (n = …)` entry, in first-seen order. */
export function foldNames(names: string[]): string[] {
  type Group = { pattern: string; ns: number[]; members: string[] };
  const groups = new Map<string, Group>();
  const order: (string | Group)[] = [];
  for (const name of names) {
    const s = split(name);
    if (!s) {
      order.push(name);
      continue;
    }
    const base = s.nums.find((n) => !Number.isNaN(n))!;
    const pattern = s.parts
      .map((p, i) => {
        const n = s.nums[i];
        if (Number.isNaN(n)) return p;
        const d = n - base;
        return `${p}{n${d === 0 ? "" : d > 0 ? `+${d}` : d}}`;
      })
      .join("∩");
    let g = groups.get(pattern);
    if (!g) {
      g = { pattern, ns: [], members: [] };
      groups.set(pattern, g);
      order.push(g);
    }
    g.ns.push(base);
    g.members.push(name);
  }
  const out: string[] = [];
  for (const item of order) {
    if (typeof item === "string") out.push(item);
    else if (item.members.length < MIN_RUN) out.push(...item.members);
    else out.push(`${item.pattern} (n = ${ranges([...new Set(item.ns)].sort((a, b) => a - b))})`);
  }
  return out;
}

/** How the folded entries read, for the summaries to say once. */
export const FOLDED_NAMES_NOTE =
  "Long runs of numbered names are folded: `<id>/side{n} (n = 0–339)` stands for <id>/side0 … <id>/side339, and `{n+1}` is the next number along. Write the full name (e.g. <id>/side12) when you reference one.";
