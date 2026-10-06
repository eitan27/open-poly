import { describe, expect, it } from "vitest";
import { assertNever } from "./assertNever";

describe("assertNever", () => {
  it("throws, naming the value that reached it", () => {
    // Only reachable when the union has been violated from outside the type
    // system, which is exactly what the cast stands in for here.
    expect(() => assertNever({ type: "newKind" } as never)).toThrow('Unhandled value: {"type":"newKind"}');
  });

  it("uses the caller's context in the message", () => {
    expect(() => assertNever("plane" as never, "feature type")).toThrow('Unhandled feature type: "plane"');
  });
});
