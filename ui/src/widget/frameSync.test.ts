/**
 * `width` / `height` follow the loaded image ({@link FrameSync}): written only
 * when they differ, rounded/clamped like the INT widgets, never through the
 * widget callback (no refresh loop), skipped for a graph undo/redo hand-off;
 * losing the image (disconnect, upstream without image) keeps the frame.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@comfy/scripts/app.js", () => ({ app: { nodeOutputs: {}, nodePreviewImages: {} } }));
vi.mock("@comfy/scripts/api.js", () => ({ api: { apiURL: (route: string) => route } }));

import type { Size } from "../geometry/rect";
import type { IBaseWidget, LGraphNode } from "../types/comfy";
import type { BackgroundLoader } from "./backgroundLoader";
import { FrameSync } from "./frameSync";
import type { LoadedBackground } from "./handoff";
import type { EditorSession } from "./sessions";

// ── Fakes ─────────────────────────────────────────────────────────────────────

const intOptions = { min: 64, max: 16384, step: 80, step2: 8, precision: 0 };

function fakeNode(width = 1024, height = 1024): LGraphNode & { widgets: IBaseWidget[] } {
  const widget = (name: string, value: unknown, options: Record<string, unknown> = {}): IBaseWidget =>
    ({ name, type: "number", value, options });
  return {
    id: "1",
    inputs: [{ name: "image", type: "IMAGE", link: 1 }],
    widgets: [
      widget("width", width, intOptions),
      widget("height", height, intOptions),
      widget("background", "#ffffff"),
    ],
    size: [400, 400],
  } as unknown as LGraphNode & { widgets: IBaseWidget[] };
}

function background(key: string, size: Size): LoadedBackground {
  return { key, image: {} as HTMLImageElement, size, origin: "upstream", alphaUrl: null };
}

interface FakeLoader {
  background: LoadedBackground | null;
  awaitingImage: boolean;
  handedOff: LoadedBackground | null;
  isHandedOff(bg: LoadedBackground): boolean;
}

function fakeLoader(): FakeLoader {
  return {
    background: null,
    awaitingImage: false,
    handedOff: null,
    isHandedOff(bg) {
      return bg === this.handedOff;
    },
  };
}

function fakeSession() {
  const editor = {
    background: { kind: "fill" } as { kind: string },
    setBackground: vi.fn((bg: { kind: string }) => {
      editor.background = bg;
    }),
    handleBackgroundSize: vi.fn(),
  };
  return { session: { docId: "doc", editor } as unknown as EditorSession, editor };
}

function setup(width?: number, height?: number) {
  const node = fakeNode(width, height);
  const loader = fakeLoader();
  const written = vi.fn();
  const frame = new FrameSync(node, loader as unknown as BackgroundLoader, written);
  const { session, editor } = fakeSession();
  const values = (): unknown[] => [node.widgets[0]?.value, node.widgets[1]?.value];
  return { node, loader, written, frame, session, editor, values };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("FrameSync size widgets", () => {
  it("writes a new image size and reports it once", () => {
    const { loader, written, frame, session, values } = setup();
    loader.background = background("a", { width: 1920, height: 1080 });
    frame.apply(session, true);
    expect(values()).toEqual([1920, 1080]);
    expect(written).toHaveBeenCalledTimes(1);
  });

  it("does not write (or report) when the values already match", () => {
    const { node, loader, written, frame, session, values } = setup(1920, 1080);
    const setter = vi.fn();
    const widget = node.widgets[0] as IBaseWidget;
    let value = widget.value;
    Object.defineProperty(widget, "value", { get: () => value, set: (v) => { setter(v); value = v; } });
    loader.background = background("a", { width: 1920, height: 1080 });
    frame.apply(session, true);
    expect(values()).toEqual([1920, 1080]);
    expect(setter).not.toHaveBeenCalled();
    expect(written).not.toHaveBeenCalled();
  });

  it("rounds to the widget step and clamps to its max (with a console note)", () => {
    const { loader, frame, session, values } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    loader.background = background("a", { width: 1917, height: 20000 });
    frame.apply(session, true);
    expect(values()).toEqual([1920, 16384]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("no loop: the write skips widget callbacks and repeated applies are no-ops", () => {
    const { loader, written, frame, session, editor } = setup();
    const onChange = vi.fn(() => frame.apply(session, true));
    frame.chainWidgetCallbacks(onChange);
    loader.background = background("a", { width: 800, height: 600 });
    for (let i = 0; i < 3; i++) frame.apply(session, true);
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.setBackground).toHaveBeenCalledTimes(1);
    expect(written).toHaveBeenCalledTimes(1);
  });

  it("disconnect keeps the synced size: the fill frame equals the last image, no copy step", () => {
    const { loader, written, frame, session, editor, values } = setup();
    loader.background = background("a", { width: 1280, height: 720 });
    frame.apply(session, true);
    loader.background = null;
    frame.apply(session, false);
    expect(values()).toEqual([1280, 720]);
    expect(editor.setBackground).toHaveBeenLastCalledWith({ kind: "fill", color: "#ffffff" }, { width: 1280, height: 720 });
    expect(editor.handleBackgroundSize).toHaveBeenLastCalledWith({ width: 1280, height: 720 });
    expect(written).toHaveBeenCalledTimes(1);
  });

  it("an upstream without an image keeps the frame size", () => {
    const { loader, frame, session, editor } = setup();
    loader.background = background("a", { width: 640, height: 480 });
    frame.apply(session, true);
    loader.background = null;
    frame.apply(session, true);
    expect(editor.handleBackgroundSize).toHaveBeenLastCalledWith({ width: 640, height: 480 });
  });

  it("a graph undo/redo hand-off never writes: the restored values are part of that state", () => {
    const { loader, written, frame, session, values } = setup(512, 512);
    const bg = background("a", { width: 1920, height: 1080 });
    loader.background = bg;
    loader.handedOff = bg;
    frame.apply(session, true);
    frame.reset();
    frame.apply(session, true);
    expect(values()).toEqual([512, 512]);
    expect(written).not.toHaveBeenCalled();
    // A newly loaded image is synced again.
    loader.background = background("b", { width: 1024, height: 768 });
    frame.apply(session, true);
    expect(values()).toEqual([1024, 768]);
  });
});
