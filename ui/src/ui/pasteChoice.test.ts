import { describe, expect, it } from "vitest";

import { choosePasteSource, imageUrlFromDrop, shouldClaimDrag, SIGNATURE_SIDE, signaturesMatch } from "./pasteChoice";
import type { PasteFacts } from "./pasteChoice";

const none: PasteFacts = { systemImage: false, systemIsOurs: false, internal: false, clipspace: false };

describe("choosePasteSource", () => {
  it("prefers a foreign system image", () => {
    expect(choosePasteSource({ ...none, systemImage: true, internal: true, clipspace: true })).toBe("system");
  });

  it("uses the internal copy when the system image is ours (paste in place knows its position)", () => {
    expect(choosePasteSource({ ...none, systemImage: true, systemIsOurs: true, internal: true })).toBe("internal");
  });

  it("uses the internal copy when the system clipboard has no image (before clipspace)", () => {
    expect(choosePasteSource({ ...none, internal: true, clipspace: true })).toBe("internal");
    expect(choosePasteSource({ ...none, internal: true })).toBe("internal");
  });

  it("falls back to clipspace, then nothing", () => {
    expect(choosePasteSource({ ...none, clipspace: true })).toBe("clipspace");
    expect(choosePasteSource(none)).toBe("none");
  });
});

describe("imageUrlFromDrop", () => {
  it("prefers the <img src> of the HTML (a linked image's uri-list is the link)", () => {
    const html = `<a href="https://site/page"><img alt=x src="https://cdn/a.png?w=1&amp;h=2"></a>`;
    expect(imageUrlFromDrop("https://site/page", html)).toBe("https://cdn/a.png?w=1&h=2");
  });

  it("falls back to the first uri-list entry; accepts data: and blob:", () => {
    expect(imageUrlFromDrop("# comment\r\nhttps://x/y.jpg\r\nhttps://z", "")).toBe("https://x/y.jpg");
    expect(imageUrlFromDrop("", "<img src='data:image/png;base64,AAAA'>")).toBe("data:image/png;base64,AAAA");
    expect(imageUrlFromDrop("blob:https://x/123", "")).toBe("blob:https://x/123");
  });

  it("rejects text drags and relative / non-image schemes", () => {
    expect(imageUrlFromDrop("", "<p>hello</p>")).toBeNull();
    expect(imageUrlFromDrop("javascript:alert(1)", "<img src=\"/rel.png\">")).toBeNull();
  });
});

describe("signaturesMatch", () => {
  const thumb = (v: number): Uint8ClampedArray => new Uint8ClampedArray(SIGNATURE_SIDE * SIGNATURE_SIDE * 4).fill(v);

  it("matches equal sizes with near-equal thumbnails", () => {
    expect(signaturesMatch({ width: 5, height: 6, thumb: thumb(100) }, { width: 5, height: 6, thumb: thumb(102) })).toBe(true);
  });

  it("rejects other sizes or different pixels", () => {
    expect(signaturesMatch({ width: 5, height: 6, thumb: thumb(100) }, { width: 6, height: 5, thumb: thumb(100) })).toBe(false);
    expect(signaturesMatch({ width: 5, height: 6, thumb: thumb(100) }, { width: 5, height: 6, thumb: thumb(140) })).toBe(false);
    expect(signaturesMatch(null, { width: 5, height: 6, thumb: thumb(100) })).toBe(false);
  });
});

describe("shouldClaimDrag", () => {
  it("claims a Chrome page image drag (uri-list + html + Files, file type hidden or image)", () => {
    expect(shouldClaimDrag(["text/uri-list", "text/html", "Files"], [""])).toBe(true);
    expect(shouldClaimDrag(["text/uri-list", "text/html", "Files"], ["image/jpeg"])).toBe(true);
    expect(shouldClaimDrag(["text/uri-list", "text/html"], [])).toBe(true);
  });
  it("claims desktop image files; leaves other files (workflow JSON, unknown) to ComfyUI", () => {
    expect(shouldClaimDrag(["Files"], ["image/png"])).toBe(true);
    expect(shouldClaimDrag(["Files"], ["application/json"])).toBe(false);
    expect(shouldClaimDrag(["Files"], [""])).toBe(false);
    expect(shouldClaimDrag(["text/plain"], [])).toBe(false);
  });
});