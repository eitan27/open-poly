import { describe, expect, it } from "vitest";
import { dialogBusyHint, featureShortcutVerdict, type OpenFeatureDialog } from "./dialogShortcutGuard";

const extrude: OpenFeatureDialog = { shortcut: "model.extrude", label: "Extrude" };

describe("featureShortcutVerdict", () => {
  it("passes every feature key through when no dialog is open", () => {
    expect(featureShortcutVerdict(null, "model.extrude")).toBe("pass");
    expect(featureShortcutVerdict(null, "model.sketch")).toBe("pass");
  });

  it("treats the open dialog's own key as already satisfied", () => {
    expect(featureShortcutVerdict(extrude, "model.extrude")).toBe("noop");
  });

  it("refuses another feature's key while a dialog is open", () => {
    expect(featureShortcutVerdict(extrude, "model.revolve")).toBe("block");
    expect(featureShortcutVerdict(extrude, "model.sketch")).toBe("block");
  });
});

describe("dialogBusyHint", () => {
  it("names the open dialog and the way out", () => {
    expect(dialogBusyHint(extrude)).toBe("Finish or cancel the Extrude dialog first (Esc).");
  });
});
