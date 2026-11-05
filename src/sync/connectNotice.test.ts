import { describe, expect, it } from "vitest";
import { connectNotice } from "./connectNotice";

describe("connectNotice", () => {
  it("a new device, 10 or fewer in Drive: all synced, the latest opened", () => {
    expect(connectNotice({ inDrive: 3, downloaded: 3, opened: "Chamfer", localSynced: 0 })).toEqual({
      kind: "success",
      title: "Synced with Google Drive",
      text: "Opened “Chamfer”, the document you edited most recently.",
      action: "showDocuments",
    });
    expect(connectNotice({ inDrive: 1, downloaded: 1, opened: "Chamfer", localSynced: 0 })).toEqual({
      kind: "success",
      title: "Synced with Google Drive",
      text: "Opened “Chamfer”.",
    });
  });

  it("a new device, more than 10 in Drive: says how many came down", () => {
    expect(connectNotice({ inDrive: 24, downloaded: 10, opened: "Chamfer", localSynced: 0 })).toEqual({
      kind: "success",
      title: "Synced 10 of 24 documents from Google Drive",
      text: "These are the 10 you edited most recently, and “Chamfer” is open. The other 14 are listed under See all documents, and sync when you open them.",
      action: "showDocuments",
    });
    expect(connectNotice({ inDrive: 11, downloaded: 10, opened: "Chamfer", localSynced: 0 }).text).toBe(
      "These are the 10 you edited most recently, and “Chamfer” is open. The other one is listed under See all documents, and syncs when you open it.",
    );
  });

  it("a device with its own work keeps it open, and counts both directions", () => {
    expect(connectNotice({ inDrive: 6, downloaded: 6, opened: null, localSynced: 3 })).toEqual({
      kind: "success",
      title: "Synced with Google Drive",
      text: "3 documents from this device are now synced with Google Drive, and 6 documents from Google Drive are now available on this device.",
      action: "showDocuments",
    });
    expect(connectNotice({ inDrive: 1, downloaded: 1, opened: null, localSynced: 1 }).text).toBe(
      "1 document from this device is now synced with Google Drive, and 1 document from Google Drive is now available on this device.",
    );
    expect(connectNotice({ inDrive: 24, downloaded: 10, opened: null, localSynced: 3 })).toEqual({
      kind: "success",
      title: "Synced 10 of 24 documents from Google Drive",
      text: "3 documents from this device are now synced with Google Drive, and the 10 you edited most recently in Google Drive are now available on this device. The other 14 sync when you open them.",
      action: "showDocuments",
    });
    expect(connectNotice({ inDrive: 11, downloaded: 10, opened: null, localSynced: 2 }).text).toMatch(
      /\. The other one syncs when you open it\.$/,
    );
    // Nothing of its own in Drive (kept off it, say): only the incoming half.
    expect(connectNotice({ inDrive: 2, downloaded: 2, opened: null, localSynced: 0 }).text).toBe(
      "2 documents from Google Drive are now available on this device.",
    );
  });

  it("an empty Drive (the first device)", () => {
    expect(connectNotice({ inDrive: 0, downloaded: 0, opened: null, localSynced: 3 })).toEqual({
      kind: "success",
      title: "Synced with Google Drive",
      text: "3 documents from this device are now synced with Google Drive.",
    });
    expect(connectNotice({ inDrive: 0, downloaded: 0, opened: null, localSynced: 0 })).toEqual({
      kind: "success",
      title: "Synced with Google Drive",
    });
  });
});
