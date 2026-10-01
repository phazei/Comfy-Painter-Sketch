/** LayerUploader stale-file guard: known names are only trusted for KNOWN_FILE_MAX_AGE_MS. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PainterDocument } from "../document/types";
import type { Editor } from "../engine/editor";

const { fetchApi } = vi.hoisted(() => ({
  fetchApi: vi.fn(async (...args: unknown[]) => {
    const init = args[1] as { body?: FormData } | undefined;
    const image = init?.body?.get("image");
    const name = image instanceof File ? image.name : "unnamed";
    return { status: 200, json: async () => ({ name, subfolder: "painter-sketch", type: "input" }) };
  }),
}));
vi.mock("@comfy/scripts/api.js", () => ({ api: { fetchApi, apiURL: (route: string) => route } }));
vi.mock("./comfyApi", () => ({ readSetting: () => undefined }));
vi.mock("./toast", () => ({ notify: vi.fn() }));
vi.mock("./layerEncode", () => ({
  encodeLayer: async () => ({ blob: new Blob([new Uint8Array([1, 2, 3])]), bytes: new Uint8Array([1, 2, 3]), ext: "webp" }),
}));

const { KNOWN_FILE_MAX_AGE_MS, LayerUploader, manifestKnownFiles } = await import("./persistence");
const HOUR = 60 * 60 * 1000;

/** One dirty paint layer whose pixels always encode to the same bytes. */
function fakeEditor(): { editor: Editor; touch: () => void; layer: { file: string | null } } {
  const layer = { id: "L1", name: "Layer", kind: "paint", file: null as string | null };
  const rt = { dirty: true, version: 1 };
  const editor = {
    doc: { docId: "doc1", layers: [layer] },
    get dirty() {
      return rt.dirty;
    },
    layerRuntime: () => rt,
    savedLayerCanvas: () => ({ width: 2, height: 2, getContext: () => null }),
    markUploaded: (_id: string, _version: number, file: string | null) => {
      rt.dirty = false;
      layer.file = file;
    },
    layerMask: { uploads: () => [] },
    imageMask: { info: null, dirty: false, canvas: () => null },
  } as unknown as Editor;
  return { editor, layer, touch: () => (rt.dirty = true) };
}

describe("LayerUploader known files", () => {
  beforeEach(() => fetchApi.mockClear());

  it("skips a name uploaded < 20 h ago, re-uploads an older one and refreshes its time", async () => {
    const { editor, touch, layer } = fakeEditor();
    const known = new Map<string, number>();
    let now = 1_000_000;
    const uploader = new LayerUploader(editor, known, () => now);
    await uploader.flush();
    expect(fetchApi).toHaveBeenCalledTimes(1);
    const file = layer.file;
    expect(file).toMatch(/^painter-sketch\/ps-doc1-.*\.webp \[input\]$/);
    expect(known.get(file ?? "")).toBe(now);

    // Same bytes again (e.g. undo) an hour later: no request.
    now += HOUR;
    touch();
    await uploader.flush();
    expect(fetchApi).toHaveBeenCalledTimes(1);

    // Past the limit (the cleanup may delete it at 24 h): uploaded again, time refreshed.
    now += KNOWN_FILE_MAX_AGE_MS;
    touch();
    await uploader.flush();
    expect(fetchApi).toHaveBeenCalledTimes(2);
    expect(known.get(file ?? "")).toBe(now);

    now += KNOWN_FILE_MAX_AGE_MS - HOUR;
    touch();
    await uploader.flush();
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });

  it("manifest files are recorded fresh: a re-render to the same bytes (text layer on load) is not uploaded", async () => {
    const first = fakeEditor();
    await new LayerUploader(first.editor, new Map()).flush();
    const file = first.layer.file ?? "";
    fetchApi.mockClear();
    const now = 1_700_000_000_000;
    const known = manifestKnownFiles(
      {
        imageMask: { file: "painter-sketch/im.png [input]" },
        layers: [{ file }, { file: null, layerMask: { file: "painter-sketch/lm.png [input]" } }],
      } as unknown as PainterDocument,
      now,
    );
    expect([...known.entries()]).toEqual([
      [file, now],
      ["painter-sketch/lm.png [input]", now],
      ["painter-sketch/im.png [input]", now],
    ]);
    const { editor, layer } = fakeEditor();
    await new LayerUploader(editor, known, () => now + HOUR).flush();
    expect(fetchApi).not.toHaveBeenCalled();
    expect(layer.file).toBe(file);
  });

  it("a manifest name dropped after a failed load is uploaded on reuse", async () => {
    const first = fakeEditor();
    await new LayerUploader(first.editor, new Map()).flush();
    const file = first.layer.file ?? "";
    fetchApi.mockClear();
    const known = manifestKnownFiles({ layers: [{ file }] } as unknown as PainterDocument, 0);
    known.delete(file);
    const { editor } = fakeEditor();
    await new LayerUploader(editor, known, () => 5).flush();
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(known.get(file)).toBe(5);
  });
});
