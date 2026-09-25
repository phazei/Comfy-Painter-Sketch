import { describe, expect, it } from "vitest";

import { firstOutputImage, parseAnnotatedFilename, viewQuery, viewUrl } from "./viewUrl";

describe("parseAnnotatedFilename", () => {
  it("parses a plain LoadImage value as an input file", () => {
    expect(parseAnnotatedFilename("cat.png")).toEqual({ filename: "cat.png", subfolder: "", type: "input" });
  });

  it("splits subfolders and honours the [type] annotation", () => {
    expect(parseAnnotatedFilename("clipspace/sub/cat 1.png [output]")).toEqual({
      filename: "cat 1.png",
      subfolder: "clipspace/sub",
      type: "output",
    });
  });

  it("normalizes backslashes and ignores unknown annotations", () => {
    expect(parseAnnotatedFilename("a\\b.png [weird]")).toEqual({
      filename: "b.png [weird]",
      subfolder: "a",
      type: "input",
    });
  });

  it("rejects empty and non-string values", () => {
    expect(parseAnnotatedFilename("")).toBeNull();
    expect(parseAnnotatedFilename("   ")).toBeNull();
    expect(parseAnnotatedFilename("dir/")).toBeNull();
    expect(parseAnnotatedFilename(42)).toBeNull();
    expect(parseAnnotatedFilename(undefined)).toBeNull();
  });
});

describe("firstOutputImage", () => {
  it("skips null entries and entries without a filename", () => {
    const item = { filename: "b.png", subfolder: "", type: "temp" };
    expect(firstOutputImage({ images: [null, { subfolder: "x" }, item] })).toBe(item);
  });

  it("returns null for missing or malformed outputs", () => {
    expect(firstOutputImage(undefined)).toBeNull();
    expect(firstOutputImage({})).toBeNull();
    expect(firstOutputImage({ images: [] })).toBeNull();
  });
});

describe("viewUrl", () => {
  it("builds an encoded, stable /view query and applies apiURL + cache-buster", () => {
    const item = { filename: "a b&c.png", subfolder: "s/t", type: "temp" };
    expect(viewQuery(item)).toBe("filename=a+b%26c.png&subfolder=s%2Ft&type=temp");
    expect(viewUrl(item, (route) => `/api${route}`, "&rand=1")).toBe(
      "/api/view?filename=a+b%26c.png&subfolder=s%2Ft&type=temp&rand=1",
    );
  });

  it("defaults missing fields", () => {
    expect(viewQuery({ filename: "x.png" })).toBe("filename=x.png&subfolder=&type=output");
  });
});
