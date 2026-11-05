// The message shown once a connect's first sync has landed (pure, Node-tested).
// Connecting brings down the RECENT_ON_CONNECT Drive documents edited most
// recently; the count only appears when some were left behind.
import type { DriveNotice } from "./useDriveSync";

export const RECENT_ON_CONNECT = 10;

export interface ConnectOutcome {
  /** Drive documents that weren't on this device when it connected. */
  inDrive: number;
  /** How many of those were brought down (the most recently edited first). */
  downloaded: number;
  /** The document opened in place of an untouched starter, if one was. */
  opened: string | null;
  /** How many of this device's own documents are now synced with Drive. */
  localSynced: number;
}

const SYNCED = "Synced with Google Drive";

export function connectNotice(o: ConnectOutcome): NonNullable<DriveNotice> {
  const partial = o.inDrive > o.downloaded;
  const title = partial ? `Synced ${o.downloaded} of ${o.inDrive} documents from Google Drive` : SYNCED;
  const rest = o.inDrive - o.downloaded;
  const restSync = rest === 1 ? "the other one syncs when you open it" : `the other ${rest} sync when you open them`;

  // A new device: the most recent document opened in place of the starter.
  if (o.opened) {
    if (partial) {
      const listed =
        rest === 1
          ? "The other one is listed under See all documents, and syncs when you open it."
          : `The other ${rest} are listed under See all documents, and sync when you open them.`;
      return {
        kind: "success",
        title,
        text: `These are the ${o.downloaded} you edited most recently, and “${o.opened}” is open. ${listed}`,
        action: "showDocuments",
      };
    }
    if (o.inDrive === 1) return { kind: "success", title, text: `Opened “${o.opened}”.` };
    return {
      kind: "success",
      title,
      text: `Opened “${o.opened}”, the document you edited most recently.`,
      action: "showDocuments",
    };
  }

  // This device kept its own document open.
  const docs = (n: number) => (n === 1 ? "1 document" : `${n} documents`);
  const mine =
    o.localSynced > 0
      ? `${docs(o.localSynced)} from this device ${o.localSynced === 1 ? "is" : "are"} now synced with Google Drive`
      : "";
  if (o.inDrive === 0) return mine ? { kind: "success", title, text: `${mine}.` } : { kind: "success", title };
  const theirs = partial
    ? `the ${o.downloaded} you edited most recently in Google Drive are now available on this device`
    : `${docs(o.downloaded)} from Google Drive ${o.downloaded === 1 ? "is" : "are"} now available on this device`;
  const sentence = mine ? `${mine}, and ${theirs}.` : `${theirs.charAt(0).toUpperCase()}${theirs.slice(1)}.`;
  const tail = partial ? ` ${restSync.charAt(0).toUpperCase()}${restSync.slice(1)}.` : "";
  return { kind: "success", title, text: sentence + tail, action: "showDocuments" };
}
