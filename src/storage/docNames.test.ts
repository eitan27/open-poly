import { describe, expect, it } from "vitest";
import { copyName, dedupeName, nextUntitled, timeAgo } from "./docNames";

describe("nextUntitled", () => {
  it("starts at plain Untitled", () => {
    expect(nextUntitled([])).toBe("Untitled");
    expect(nextUntitled(["Bracket"])).toBe("Untitled");
  });
  it("counts past taken defaults, skipping holes it can fill", () => {
    expect(nextUntitled(["Untitled"])).toBe("Untitled 2");
    expect(nextUntitled(["Untitled", "Untitled 2"])).toBe("Untitled 3");
    expect(nextUntitled(["Untitled", "Untitled 3"])).toBe("Untitled 2");
  });
});

describe("copyName", () => {
  it("prefixes Copy of, deduping repeats", () => {
    expect(copyName("Bracket", [])).toBe("Copy of Bracket");
    expect(copyName("Bracket", ["Copy of Bracket"])).toBe("Copy of Bracket 2");
    expect(copyName("Bracket", ["Copy of Bracket", "Copy of Bracket 2"])).toBe("Copy of Bracket 3");
  });
});

describe("timeAgo", () => {
  const now = 10_000_000_000;
  it("buckets sensibly", () => {
    expect(timeAgo(now - 5_000, now)).toBe("just now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});

describe("dedupeName", () => {
  it("keeps a free name, numbers a taken one", () => {
    expect(dedupeName("Bracket", [])).toBe("Bracket");
    expect(dedupeName("Bracket", ["Bracket"])).toBe("Bracket 2");
    expect(dedupeName("Bracket", ["Bracket", "Bracket 2"])).toBe("Bracket 3");
  });
});
