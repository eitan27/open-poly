import { describe, expect, it } from "vitest";
import { connectNotice } from "./connectNotice";

describe("connectNotice", () => {
  it("a new device, 10 or fewer in Drive: all synced, the latest opened", () => {
    expect(connectNotice({ inDrive: 3, downloaded: 3, opened: "Chamfer", hadLocalWork: false })).toEqual({
      kind: "success",
      title: "Synced with Google Drive",
      text: "Opened “Chamfer”, the document you edited most recently.",
      action: "showDocuments",
    });
    expect(connectNotice({ inDrive: 1, downloaded: 1, opened: "Chamfer", hadLocalWork: false })).toEqual({
      kind: "success",
      title: "Synced with Google Drive",
      text: "Opened “Chamfer”.",
    });
  });

  it("a new device, more than 10 in Drive: says how many came down", () => {
    expect(connectNotice({ inDrive: 24, downloaded: 10, opened: "Chamfer", hadLocalWork: false })).toEqual({
      kind: "success",
      title: "Synced 10 of 24 documents from Google Drive",
      text: "These are the 10 you edited most recently, and “Chamfer” is open. The other 14 are listed under See all documents, and sync when you open them.",
      action: "showDocuments",
    });
    expect(connectNotice({ inDrive: 11, downloaded: 10, opened: "Chamfer", hadLocalWork: false }).text).toBe(
      "These are the 10 you edited most recently, and “Chamfer” is open. The other one is listed under See all documents, and syncs when you open it.",
    );
  });

  it("a device with its own work keeps it open", () => {
    expect(connectNotice({ inDrive: 6, downloaded: 6, opened: null, hadLocalWork: true })).toEqual({
      kind: "success",
      title: "Synced with Google Drive",
      text: "Your documents here are now in Drive too, and 6 from Drive were added to this device.",
      action: "showDocuments",
    });
    expect(connectNotice({ inDrive: 1, downloaded: 1, opened: null, hadLocalWork: true }).text).toBe(
      "Your documents here are now in Drive too, and 1 from Drive was added to this device.",
    );
    expect(connectNotice({ inDrive: 24, downloaded: 10, opened: null, hadLocalWork: true })).toEqual({
      kind: "success",
      title: "Synced 10 of 24 documents from Google Drive",
      text: "Your documents here are now in Drive too. The 10 most recently edited from Drive were added to this device; the other 14 sync when you open them.",
      action: "showDocuments",
    });
  });

  it("an empty Drive (the first device)", () => {
    expect(connectNotice({ inDrive: 0, downloaded: 0, opened: null, hadLocalWork: true })).toEqual({
      kind: "success",
      title: "Synced with Google Drive",
      text: "Your documents here are now in Drive too.",
    });
    expect(connectNotice({ inDrive: 0, downloaded: 0, opened: null, hadLocalWork: false })).toEqual({
      kind: "success",
      title: "Synced with Google Drive",
    });
  });
});
