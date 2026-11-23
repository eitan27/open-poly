import { describe, expect, it } from "vitest";
import {
  DialogBaselines,
  dialogBusyHint,
  dialogFingerprint,
  featureShortcutVerdict,
  type OpenFeatureDialog,
} from "./dialogShortcutGuard";

const extrude = (over: Partial<OpenFeatureDialog> = {}): OpenFeatureDialog => ({
  shortcut: "model.extrude",
  label: "Extrude",
  editing: false,
  touched: false,
  ...over,
});

describe("featureShortcutVerdict", () => {
  it("passes every feature key through when no dialog is open", () => {
    expect(featureShortcutVerdict(null, "model.extrude")).toBe("pass");
    expect(featureShortcutVerdict(null, "model.sketch")).toBe("pass");
  });

  it("treats the open dialog's own key as already satisfied, touched or not", () => {
    expect(featureShortcutVerdict(extrude(), "model.extrude")).toBe("noop");
    expect(featureShortcutVerdict(extrude({ touched: true }), "model.extrude")).toBe("noop");
    expect(featureShortcutVerdict(extrude({ editing: true }), "model.extrude")).toBe("noop");
  });

  it("swaps an untouched new dialog for the one asked for", () => {
    expect(featureShortcutVerdict(extrude(), "model.revolve")).toBe("swap");
    expect(featureShortcutVerdict(extrude(), "model.sketch")).toBe("swap");
  });

  it("refuses another feature's key once the dialog holds work", () => {
    expect(featureShortcutVerdict(extrude({ touched: true }), "model.revolve")).toBe("block");
  });

  it("never swaps away a dialog editing an existing feature, even untouched", () => {
    expect(featureShortcutVerdict(extrude({ editing: true }), "model.revolve")).toBe("block");
  });
});

describe("dialogBusyHint", () => {
  it("names the open dialog and the way out", () => {
    expect(dialogBusyHint(extrude())).toBe("Finish or cancel the Extrude dialog first (Esc).");
  });
});

describe("dialogFingerprint", () => {
  it("ignores where the dialog sits and which slot is armed", () => {
    const a = { distance: "10", picks: [], arming: true, x: 10, y: 20 };
    const b = { distance: "10", picks: [], arming: false, x: 300, y: 400 };
    expect(dialogFingerprint(a)).toBe(dialogFingerprint(b));
  });

  it("sees a changed field or a filled slot", () => {
    const a = { distance: "10", picks: [] as string[] };
    expect(dialogFingerprint({ ...a, distance: "12" })).not.toBe(dialogFingerprint(a));
    expect(dialogFingerprint({ ...a, picks: ["face"] })).not.toBe(dialogFingerprint(a));
  });

  it("filters only the top level, so picked geometry keeps its own x/y", () => {
    expect(dialogFingerprint({ point: { x: 1 } })).not.toBe(dialogFingerprint({ point: { x: 2 } }));
  });
});

describe("DialogBaselines", () => {
  it("takes the first state seen as the baseline and compares against it", () => {
    const b = new DialogBaselines();
    expect(b.touched("extrude", { distance: "10" })).toBe(false);
    expect(b.touched("extrude", { distance: "10" })).toBe(false);
    expect(b.touched("extrude", { distance: "12" })).toBe(true);
    // Changing it back is untouched again.
    expect(b.touched("extrude", { distance: "10" })).toBe(false);
  });

  it("forgets a dialog's baseline when it closes, so the next opening starts afresh", () => {
    const b = new DialogBaselines();
    b.touched("extrude", { distance: "10" });
    expect(b.touched("extrude", null)).toBe(false);
    expect(b.touched("extrude", { distance: "25" })).toBe(false);
  });

  it("keeps each dialog's baseline separately", () => {
    const b = new DialogBaselines();
    b.touched("extrude", { distance: "10" });
    expect(b.touched("revolve", { degrees: "360" })).toBe(false);
    expect(b.touched("extrude", { distance: "10" })).toBe(false);
  });

  it("re-baselines after forget, for a swap that reuses the same state slot", () => {
    const b = new DialogBaselines();
    b.touched("dressUp", { op: "chamfer" });
    expect(b.touched("dressUp", { op: "fillet" })).toBe(true);
    b.forget();
    expect(b.touched("dressUp", { op: "fillet" })).toBe(false);
  });
});
