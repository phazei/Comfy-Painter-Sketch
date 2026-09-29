import { describe, expect, it } from "vitest";

import { firstOutputImage, parseAnnotatedFilename, viewQuery, viewUrl, withAlphaChannel, withRgbChannel } from "./viewUrl";

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

describe("withRgbChannel", () => {
  it("adds channel=rgb to relative and api-prefixed /view URLs, keeping params", () => {
    expect(withRgbChannel("/view?filename=a+b%26c.png&subfolder=&type=input")).toBe(
      "/view?filename=a+b%26c.png&subfolder=&type=input&channel=rgb",
    );
    expect(withRgbChannel("/api/view?filename=a.png&type=temp&rand=0.5")).toBe(
      "/api/view?filename=a.png&type=temp&rand=0.5&channel=rgb",
    );
    expect(withRgbChannel("/comfy/api/view?filename=a.png&preview=webp;90")).toBe(
      "/comfy/api/view?filename=a.png&preview=webp;90&channel=rgb",
    );
  });

  it("handles absolute URLs, fragments and a bare /view", () => {
    expect(withRgbChannel("http://127.0.0.1:8188/api/view?filename=a.png#x")).toBe(
      "http://127.0.0.1:8188/api/view?filename=a.png&channel=rgb#x",
    );
    expect(withRgbChannel("/view")).toBe("/view?channel=rgb");
  });

  it("replaces an existing channel param", () => {
    expect(withRgbChannel("/api/view?channel=rgba&filename=a.png&channel=a")).toBe(
      "/api/view?filename=a.png&channel=rgb",
    );
    expect(withRgbChannel("/api/view?filename=a.png&channel=rgb")).toBe("/api/view?filename=a.png&channel=rgb");
  });

  it("leaves non-/view URLs untouched", () => {
    for (const url of NON_VIEW) {
      expect(withRgbChannel(url)).toBe(url);
    }
  });
});

const NON_VIEW = [
  "data:image/png;base64,AAAA",
  "blob:http://127.0.0.1:8188/1234-5678",
  "/api/viewer?filename=a.png",
  "/api/preview?filename=view",
  "http://example.com/img.png?channel=a",
];

describe("withAlphaChannel", () => {
  it("asks for channel=a as a lossless PNG (drops preview and any channel)", () => {
    expect(withAlphaChannel("/api/view?filename=a.png&subfolder=&type=input&rand=0.5")).toBe(
      "/api/view?filename=a.png&subfolder=&type=input&rand=0.5&channel=a",
    );
    expect(withAlphaChannel("/api/view?filename=a.png&preview=webp;90&channel=rgb")).toBe("/api/view?filename=a.png&channel=a");
  });

  it("is null for URLs without a file behind them", () => {
    for (const url of NON_VIEW) expect(withAlphaChannel(url)).toBeNull();
  });
});
