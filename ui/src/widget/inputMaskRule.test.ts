/**
 * Input Mask source rule (`inputMaskRule.ts`): live for a MASK slot of
 * any node with a `/view` file (LoadImageMask only on alpha); otherwise wait for a run;
 * our executed preview wins once it belongs to the current link (and live
 * source); preview items / keys.
 */

import { describe, expect, it } from "vitest";

import { isInputMaskKey } from "../document/imageMask";
import type { ImageSource } from "./imageSource";
import { chooseInputMask, liveMaskSource, maskPreviewItem, maskPreviewKey, maskPreviewOrigin, recordMaskPreview } from "./inputMaskRule";
import type { MaskOrigins } from "./inputMaskRule";

const loadImage = {};
const other = {};
const file: ImageSource = { key: "filename=a.png&subfolder=&type=input", url: "/view?filename=a.png&subfolder=&type=input&rand=1", origin: "upstream" };

function origins(overrides: Partial<MaskOrigins> = {}): MaskOrigins {
  return { maskNode: loadImage, maskSlotType: "MASK", maskClass: "LoadImage", maskChannel: undefined, source: file, ...overrides };
}

describe("liveMaskSource", () => {
  it("MASK slot + /view file of any node -> channel=a of that file", () => {
    const live = liveMaskSource(origins());
    expect(live?.url).toBe("/view?filename=a.png&subfolder=&type=input&rand=1&channel=a");
    expect(isInputMaskKey(live?.key ?? "")).toBe(true);
    expect(liveMaskSource(origins({ maskNode: other, maskClass: "SomeLoader" }))?.url).toBe(live?.url);
  });

  it("LoadImageMask only with channel alpha", () => {
    const lim = (maskChannel: unknown): MaskOrigins => origins({ maskClass: "LoadImageMask", maskChannel });
    expect(liveMaskSource(lim("alpha"))?.url).toContain("channel=a");
    expect(liveMaskSource(lim("A"))).not.toBeNull();
    for (const channel of ["red", "green", "blue", "R", undefined, 3]) expect(liveMaskSource(lim(channel))).toBeNull();
  });

  it("no node, other slot type, no source or a non-file source -> none", () => {
    expect(liveMaskSource(origins({ maskNode: null }))).toBeNull();
    expect(liveMaskSource(origins({ maskSlotType: "IMAGE" }))).toBeNull();
    expect(liveMaskSource(origins({ source: null }))).toBeNull();
    expect(liveMaskSource(origins({ source: { key: "blob:x", url: "blob:x", origin: "upstream" } }))).toBeNull();
  });
});

describe("chooseInputMask", () => {
  const live = liveMaskSource(origins());
  const preview = { key: "mask:preview:abc", url: "/view?filename=t.png&type=temp" };

  it("live before a run; no live source waits for the run", () => {
    expect(chooseInputMask({ link: "5#1", live, preview: null, previewOrigin: undefined })).toMatchObject({ kind: "live" });
    const wait = chooseInputMask({ link: "5#1", live: null, preview: null, previewOrigin: undefined });
    expect(wait.kind).toBe("wait");
    expect(isInputMaskKey(wait.key)).toBe(true);
  });

  it("after a run the preview wins over the live read (same link and live source)", () => {
    const origin = { link: "5#1", liveKey: live?.key ?? null };
    expect(chooseInputMask({ link: "5#1", live, preview, previewOrigin: origin })).toEqual({ kind: "preview", key: preview.key, url: preview.url });
    // No live source: the preview replaces the wait.
    expect(chooseInputMask({ link: "7#0", live: null, preview, previewOrigin: { link: "7#0", liveKey: null } }).kind).toBe("preview");
  });

  it("a preview of another link, an unknown one or an older live file is not used", () => {
    expect(chooseInputMask({ link: "6#1", live: null, preview, previewOrigin: { link: "5#1", liveKey: null } }).kind).toBe("wait");
    expect(chooseInputMask({ link: "5#1", live, preview, previewOrigin: undefined }).kind).toBe("live");
    expect(chooseInputMask({ link: "5#1", live, preview, previewOrigin: { link: "5#1", liveKey: "mask:live:older" } }).kind).toBe("live");
  });
});

describe("mask preview items", () => {
  it("reads the input_mask item (file or 'no mask' marker) and keys it by content id", () => {
    const item = maskPreviewItem({ images: [{ filename: "bg.png" }], input_mask: [{ filename: "m.png", subfolder: "", type: "temp", mask_id: "abc" }] });
    expect(item?.filename).toBe("m.png");
    expect(maskPreviewKey(item ?? {})).toBe("mask:preview:abc");
    const none = maskPreviewItem({ input_mask: [{ mask_id: "none", empty: true }] });
    expect(none?.empty).toBe(true);
    expect(maskPreviewKey(none ?? {})).toBe("mask:preview:none");
    expect(maskPreviewItem({ images: [{ filename: "bg.png" }] })).toBeNull();
    expect(maskPreviewItem(null)).toBeNull();
  });

  it("remembers provenance per preview key", () => {
    recordMaskPreview("mask:preview:p1", { link: "3#1", liveKey: null });
    expect(maskPreviewOrigin("mask:preview:p1")).toEqual({ link: "3#1", liveKey: null });
    expect(maskPreviewOrigin("mask:preview:unknown")).toBeUndefined();
  });
});
