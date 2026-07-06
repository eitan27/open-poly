// A document record exists but its stored content is malformed (migrateDocument
// threw on it). Carries the display name so callers can render a specific,
// actionable recovery message instead of a generic error string — e.g. bolding
// "Export as JSON" and linking to the Documents dialog, since that action
// still works on a corrupt record (it never validates the doc's shape).
export class CorruptDocError extends Error {
  constructor(public docName: string) {
    super(`"${docName}" is corrupted and can't be opened.`);
    this.name = "CorruptDocError";
  }
}
