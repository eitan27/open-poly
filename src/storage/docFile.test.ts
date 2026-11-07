import { describe, expect, it } from "vitest";
import { parseDocFile, serializeDocFile, DOC_FILE_VERSION } from "./docFile";
import { createDocument } from "../document/document";
import { createAssembly } from "../assembly/assembly";

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

describe("assembly files", () => {
  it("round-trip the assembly", () => {
    const assembly = { ...createAssembly(), mates: [] };
    const parsed = parseDocFile(serializeDocFile("Arm", createDocument(), assembly));
    expect(parsed.assembly).toEqual(assembly);
  });

  it("are version 2, while a part file stays version 1 for older builds", () => {
    expect(JSON.parse(serializeDocFile("Arm", createDocument(), createAssembly())).version).toBe(2);
    expect(JSON.parse(serializeDocFile("Bracket", createDocument())).version).toBe(1);
  });

  it("a part file parses with no assembly key at all", () => {
    expect("assembly" in parseDocFile(serializeDocFile("Bracket", createDocument()))).toBe(false);
  });

  it("reject corrupt assembly data", () => {
    const raw = JSON.parse(serializeDocFile("Arm", createDocument(), createAssembly()));
    raw.assembly = { instances: 3 };
    expect(() => parseDocFile(JSON.stringify(raw))).toThrow(/Assembly data is missing or corrupt/);
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
