/** The compiler-as-checklist guard for a discriminated union.
 *
 *  Put `default: assertNever(x)` on a switch that dispatches over every member
 *  of a union and the next member added to that union becomes a compile error
 *  here — the argument no longer narrows to `never` — instead of silently
 *  falling through at runtime. That is the whole point: adding a feature kind to
 *  this app means touching nine files, and the dispatch in `buildBodies` used to
 *  fail by doing nothing at all, so the feature appeared in the timeline, built
 *  no geometry, and raised no error anywhere.
 *
 *  It throws too, because a union can always be violated from outside the type
 *  system — a document written by a newer version of the app, a hand-edited
 *  `.openpoly.json`. Loud beats silent there as well, and callers that would
 *  rather degrade than throw should write an explicit `default` instead. */
export function assertNever(x: never, context = "value"): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(x)}`);
}
