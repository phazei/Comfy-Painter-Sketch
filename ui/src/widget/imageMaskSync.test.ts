/**
 * M13a widget side (`imageMaskSync.ts`): the `/view?channel=a` read happens
 * once per background source key (so the coverage uploads only when the
 * source changes), not at all for our executed preview (the row is kept),
 * not again after a restore of the same key; a non-file upstream, an opaque
 * image, a failed read, no source or another source loading leaves no row. `fetch` / `createImageBitmap` and the
 * canvas are faked; the editor is a stub.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeCanvas, installCanvasFakes, removeCanvasFakes } from "../engine/fakeCanvas.testutil";
import type { BackgroundStatus } from "./backgroundRule";
import type { LoadedBackground } from "./handoff";
import type { EditorSession } from "./sessions";
import { imageMaskReady, syncImageMask } from "./imageMaskSync";
import { withAlphaChannel } from "./viewUrl";

vi.mock("@comfy/scripts/api.js", () => ({ api: { apiURL: (route: string) => route } }));

const SIZE = { width: 2, height: 1 };
let alphas = [0, 255];
let fetchOk = true;
const fetchMock = vi.fn(async (_url: string) => ({ ok: fetchOk, status: fetchOk ? 200 : 404, statusText: "", blob: async () => ({}) }));

beforeAll(() => {
  installCanvasFakes();
  const g = globalThis as Record<string, unknown>;
  g["fetch"] = fetchMock;
  g["createImageBitmap"] = async () => {
    const bitmap = Object.assign(new FakeCanvas(), { close: () => undefined });
    bitmap.width = SIZE.width;
    bitmap.height = SIZE.height;
    alphas.forEach((a, i) => bitmap.px.set([0, 0, 0, a], i * 4));
    return bitmap;
  };
});

afterAll(() => {
  removeCanvasFakes();
  const g = globalThis as Record<string, unknown>;
  delete g["fetch"];
  delete g["createImageBitmap"];
});

beforeEach(() => {
  fetchMock.mockClear();
  alphas = [0, 255];
  fetchOk = true;
});

interface StubMask {
  info: { sourceKey: string } | undefined;
  hasPixels: boolean;
  setFromAlpha: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function session(): { session: EditorSession; mask: StubMask } {
  const mask: StubMask = {
    info: undefined,
    hasPixels: false,
    setFromAlpha: vi.fn((key: string, _size: unknown, rgba: Uint8ClampedArray) => {
      const shown = rgba.some((v, i) => i % 4 === 3 && v < 255);
      mask.info = shown ? { sourceKey: key } : undefined;
      mask.hasPixels = shown;
      return shown;
    }),
    remove: vi.fn(() => {
      mask.info = undefined;
      mask.hasPixels = false;
    }),
  };
  const s = { alive: true, ready: Promise.resolve(), editor: { imageMask: mask } } as unknown as EditorSession;
  return { session: s, mask };
}

function background(key: string, origin: "upstream" | "executed" = "upstream", url = `/view?filename=${key}&type=input&rand=1`): BackgroundStatus {
  const bg: LoadedBackground = { key, image: {} as HTMLImageElement, size: SIZE, origin, alphaUrl: origin === "upstream" ? withAlphaChannel(url) : null };
  return { kind: "loaded", background: bg };
}

const NONE: BackgroundStatus = { kind: "none" };

async function settle(s: EditorSession): Promise<void> {
  await imageMaskReady(s);
}

describe("syncImageMask", () => {
  it("reads channel=a once per source key; a new key reads again", async () => {
    const { session: s, mask } = session();
    syncImageMask(s, background("a.png"));
    syncImageMask(s, background("a.png"));
    await settle(s);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/view?filename=a.png&type=input&rand=1&channel=a");
    expect(mask.setFromAlpha).toHaveBeenCalledTimes(1);
    expect(mask.info?.sourceKey).toBe("a.png");
    syncImageMask(s, background("a.png"));
    await settle(s);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    syncImageMask(s, background("b.png"));
    await settle(s);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the row for our executed preview, while unresolved and while its own key reloads", async () => {
    const { session: s, mask } = session();
    syncImageMask(s, background("a.png"));
    await settle(s);
    syncImageMask(s, background("filename=preview.png&type=temp", "executed"));
    syncImageMask(s, { kind: "loading", key: "filename=preview2.png&type=temp", origin: "executed" });
    syncImageMask(s, { kind: "unresolved" });
    syncImageMask(s, { kind: "loading", key: "a.png", origin: "upstream" });
    await settle(s);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mask.remove).not.toHaveBeenCalled();
    expect(mask.info?.sourceKey).toBe("a.png");
  });

  it("removes the row for no source / no image / another key loading; the same source reads again", async () => {
    const { session: s, mask } = session();
    syncImageMask(s, background("a.png"));
    await settle(s);
    syncImageMask(s, NONE);
    expect(mask.remove).toHaveBeenCalledTimes(1);
    expect(mask.info).toBeUndefined();
    // Reconnecting the same LoadImage reads its alpha again.
    syncImageMask(s, background("a.png"));
    await settle(s);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mask.info?.sourceKey).toBe("a.png");
    syncImageMask(s, { kind: "loading", key: "b.png", origin: "upstream" });
    expect(mask.info).toBeUndefined();
  });

  it("a removal discards an alpha read still in flight", async () => {
    const { session: s, mask } = session();
    syncImageMask(s, background("a.png"));
    syncImageMask(s, NONE);
    await settle(s);
    expect(mask.setFromAlpha).not.toHaveBeenCalled();
    expect(mask.info).toBeUndefined();
  });

  it("does not refetch a restored row of the same key", async () => {
    const { session: s, mask } = session();
    mask.info = { sourceKey: "a.png" };
    mask.hasPixels = true;
    syncImageMask(s, background("a.png"));
    await settle(s);
    expect(fetchMock).not.toHaveBeenCalled();
    // A failed restore (no pixels) reads the source again.
    const other = session();
    other.mask.info = { sourceKey: "a.png" };
    syncImageMask(other.session, background("a.png"));
    await settle(other.session);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("no row for an opaque image, a failed read or a non-file upstream", async () => {
    const { session: s, mask } = session();
    alphas = [255, 255];
    syncImageMask(s, background("opaque.png"));
    await settle(s);
    expect(mask.info).toBeUndefined();
    fetchOk = false;
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    syncImageMask(s, background("missing.png"));
    await settle(s);
    expect(mask.remove).toHaveBeenCalled();
    spy.mockRestore();
    const blob = session();
    syncImageMask(blob.session, background("blob:x", "upstream", "blob:x"));
    await settle(blob.session);
    expect(blob.mask.remove).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
