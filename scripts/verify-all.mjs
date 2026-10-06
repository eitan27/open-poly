// Runs the verify-*.mjs acceptance checks, one at a time, and tallies them.
//
//   npm run dev                       # in another shell — these drive a real app
//   npm run verify                    # everything
//   npm run verify -- shell transform # only scripts whose name contains one of these
//
// Sequential on purpose. These are wall-clock scripts that poll the app's status
// chip, so anything else competing for the CPU changes their answers — a lesson
// migrating these scripts learned twice (see PLAN, "What it taught us"). For the same
// reason, don't run them next to `npm test`.
//
// The per-script timeout is enforced here rather than with `timeout(1)`, which
// macOS does not ship — a silent no-op that once made a whole run report nothing.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const self = path.basename(fileURLToPath(import.meta.url));
const URL_ = process.env.URL ?? "http://localhost:5173/";
// Generous on purpose. These drive the real OCCT kernel: verify-shell-loft
// takes ~5m on its own (it re-lofts a cavity and then probes the walls), and a
// limit that merely looks safe reports the slowest REAL pass as a failure.
const TIMEOUT_MS = +(process.env.TIMEOUT_MS ?? 420000);

const filters = process.argv.slice(2);
const scripts = fs
  .readdirSync(dir)
  // `self` matches the verify-* glob too, and sorts first — without this the
  // runner's first act is to run itself, recursively, and the orphaned children
  // go on burning CPU next to the real scripts (which is exactly what makes
  // these scripts change their answers).
  .filter((f) => /^verify-.*\.mjs$/.test(f) && f !== self)
  .filter((f) => !filters.length || filters.some((q) => f.includes(q)))
  .sort();

if (!scripts.length) {
  console.error(filters.length ? `no verify scripts match: ${filters.join(", ")}` : "no verify scripts found");
  process.exit(1);
}

// Fail loudly up front rather than letting 66 scripts each time out on a dead port.
try {
  const res = await fetch(URL_, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (e) {
  console.error(`Dev server not reachable at ${URL_} (${e.message}).\nStart it with \`npm run dev\`, or set URL=.`);
  process.exit(1);
}

/** The few lines worth printing next to a failure.
 *
 *  A failed CHECK wins over an exception: the harness prints `FAIL  <label>`
 *  and some older scripts print `FAIL: <label>`, and that label says more than
 *  any stack. Only when a script produced none — it crashed before finishing —
 *  do we fall back to the exception, and then the useful trio is the operation
 *  that timed out, the selector it was waiting for, and the script line.
 *
 *  Match `FAIL` and `Error` as whole words, anchored. An unanchored /Error/i
 *  matches the word "errored" inside a PASSING line ("PASS: no feature
 *  errored"), which is how this once reported a pass as the reason for a fail. */
const FAIL_LINE = /^\s*FAIL\b/;
const ERROR_LINE = [
  /^\s*(?:[A-Z]\w*)?Error\b/, //                 "TimeoutError: …", "Error: …"
  /^\s*locator\.\w+:/, //                        "locator.textContent: Timeout 30000ms exceeded."
  /^\s*-\s*waiting for /, //                     "  - waiting for locator('.sketch-banner.pick span')"
  /^\s*at .*\.mjs:\d+/, //                       "    at /…/verify-x.mjs:62:64"
  /\bname: '[A-Za-z]*Error'/, //                 Playwright's dumped error object
  /\bTimeout \d+ms exceeded\b/,
];
// Playwright colours parts of its error dump, and the call log — the line that
// names the selector, which is the single most useful one — is entirely wrapped
// in it. Strip before matching, and report the stripped line.
const stripAnsi = (s) => s.replace(/\u001b\[\d+m|\[(?:\d{1,2})m/g, "");
function whyItFailed(lines) {
  const clean = lines.map(stripAnsi);
  const failed = clean.filter((l) => FAIL_LINE.test(l));
  if (failed.length) return failed.slice(0, 3);
  return clean.filter((l) => ERROR_LINE.some((re) => re.test(l))).slice(0, 3);
}

/** Resolves to { code, ms, timedOut, tail } — never rejects. */
function run(file) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // Its own process group, so a timeout can take the script's Chromium down
    // with it. Killing just the node process orphans the browser, and an
    // orphaned browser goes on competing for the CPU with every script after it.
    const child = spawn(process.execPath, [path.join(dir, file)], {
      env: { ...process.env, URL: URL_ },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, TIMEOUT_MS);
    let timedOut = false;
    child.on("close", (code) => {
      clearTimeout(timer);
      const lines = out.trimEnd().split("\n");
      resolve({
        code,
        ms: Date.now() - t0,
        timedOut,
        out,
        tail: whyItFailed(lines),
        last: lines.at(-1) ?? "",
      });
    });
  });
}

console.log(`${scripts.length} script(s) against ${URL_}\n`);
const failed = [];
const t0 = Date.now();
for (const [i, file] of scripts.entries()) {
  process.stdout.write(`[${String(i + 1).padStart(2)}/${scripts.length}] ${file.padEnd(38)}`);
  const r = await run(file);
  const secs = (r.ms / 1000).toFixed(1).padStart(5);
  if (r.timedOut) {
    console.log(`TIMEOUT ${secs}s`);
    failed.push({ file, why: `timed out after ${TIMEOUT_MS / 1000}s` });
  } else if (r.code !== 0) {
    console.log(`FAIL    ${secs}s  ${r.tail[0] ?? r.last}`);
    failed.push({ file, why: r.tail.join(" | ") || r.last || `exit ${r.code}` });
  } else {
    console.log(`ok      ${secs}s`);
  }
  if (process.env.VERBOSE) console.log(r.out);
}

console.log(
  `\n${scripts.length - failed.length}/${scripts.length} passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
);
if (failed.length) {
  console.log(`\n${failed.length} failing:`);
  for (const f of failed) console.log(`  ${f.file} — ${f.why}`);
  console.log(`\nRe-run one with its output: node scripts/${failed[0].file}`);
}
process.exit(failed.length ? 1 : 0);
