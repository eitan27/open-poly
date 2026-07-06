import { describe, expect, it } from "vitest";
import { parseDocFile, serializeDocFile, DOC_FILE_VERSION } from "./docFile";
import { createDocument } from "../document/document";

describe("docFile round-trip", () => {
  it("serializes and parses back name + doc", () => {
    const doc = createDocument();
    const text = serializeDocFile("Bracket", doc);
    const parsed = parseDocFile(text);
    expect(parsed.name).toBe("Bracket");
    expect(parsed.doc).toEqual(doc);
  });

  it("excludes meshes by construction (only name/doc in the envelope)", () => {
    const text = serializeDocFile("X", createDocument());
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["doc", "format", "name", "version"]);
  });

  it("defaults a missing/blank name to Imported", () => {
    const raw = JSON.parse(serializeDocFile("  ", createDocument()));
    expect(parseDocFile(JSON.stringify(raw)).name).toBe("Imported");
  });
});

describe("parseDocFile rejections (readable errors)", () => {
  it("rejects non-JSON", () => {
    expect(() => parseDocFile("STEP-FILE v2")).toThrow(/Not a JSON file/);
  });
  it("rejects foreign JSON", () => {
    expect(() => parseDocFile('{"hello":"world"}')).toThrow(/Not an Open Poly document/);
  });
  it("rejects files from a newer version", () => {
    const raw = JSON.parse(serializeDocFile("X", createDocument()));
    raw.version = DOC_FILE_VERSION + 1;
    expect(() => parseDocFile(JSON.stringify(raw))).toThrow(/newer version/);
  });
  it("rejects corrupt document data", () => {
    const raw = JSON.parse(serializeDocFile("X", createDocument()));
    raw.doc = { features: "nope" };
    expect(() => parseDocFile(JSON.stringify(raw))).toThrow(/missing or corrupt/);
  });
});
