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
  /** This device had documents of its own, now in Drive too. */
  hadLocalWork: boolean;
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
  const ownToo = "Your documents here are now in Drive too";
  if (o.inDrive === 0) {
    return o.hadLocalWork ? { kind: "success", title, text: `${ownToo}.` } : { kind: "success", title };
  }
  const lead = o.hadLocalWork ? `${ownToo}. ` : "";
  if (partial) {
    return {
      kind: "success",
      title,
      text: `${lead}The ${o.downloaded} most recently edited from Drive were added to this device; ${restSync}.`,
      action: "showDocuments",
    };
  }
  const added = o.downloaded === 1 ? "1 from Drive was added" : `${o.downloaded} from Drive were added`;
  return {
    kind: "success",
    title,
    text: o.hadLocalWork
      ? `${ownToo}, and ${added} to this device.`
      : `${added.charAt(0).toUpperCase()}${added.slice(1)} to this device.`,
    action: "showDocuments",
  };
}
