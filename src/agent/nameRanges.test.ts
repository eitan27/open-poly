import { describe, expect, it } from "vitest";
import { foldNames } from "./nameRanges";

const ID = "2f3adb2c-7183-4183-bcda-90a2efaac5de";

describe("foldNames", () => {
  it("folds a run of numbered faces and leaves the rest", () => {
    const names = [`${ID}/start`, `${ID}/end`, ...Array.from({ length: 340 }, (_, i) => `${ID}/side${i}`)];
    expect(foldNames(names)).toEqual([`${ID}/start`, `${ID}/end`, `${ID}/side{n} (n = 0–339)`]);
  });

  it("folds edges between neighbouring facets with an offset slot", () => {
    const names = Array.from({ length: 10 }, (_, i) => `${ID}/side${i}∩${ID}/side${i + 1}`);
    expect(foldNames(names)).toEqual([`${ID}/side{n}∩${ID}/side{n+1} (n = 0–9)`]);
  });

  it("folds cap edges, keeping each pattern apart, and shows gaps", () => {
    const names = [
      ...[0, 1, 2, 3, 7, 9, 10, 11].map((i) => `${ID}/end∩${ID}/side${i}`),
      ...[0, 1, 2, 3].map((i) => `${ID}/bore${i}∩${ID}/start`),
    ];
    expect(foldNames(names)).toEqual([
      `${ID}/end∩${ID}/side{n} (n = 0–3, 7, 9–11)`,
      `${ID}/bore{n}∩${ID}/start (n = 0–3)`,
    ]);
  });

  it("lists short runs in full and never reads numbers inside an id", () => {
    const names = [`${ID}/side0`, `${ID}/side1`, `${ID}/+z`, "a1b2/-x"];
    expect(foldNames(names)).toEqual(names);
  });
});
