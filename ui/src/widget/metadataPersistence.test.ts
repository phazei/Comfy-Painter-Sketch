/** Integration of real controller/session policies, with browser and pixel I/O replaced. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../document/create";
import { cloneOutputOptions } from "../document/outputOptions";
import { parseDocument } from "../document/parse";
import { createRegion } from "../document/regions";
import { cloneDocument, stringifyDocument } from "../document/serialize";
import type { PainterDocument } from "../document/types";
import { Editor } from "../engine/editor";
import type { EditorEvents } from "../engine/editorTypes";
import { Emitter } from "../engine/emitter";
import type { LGraphNode } from "../types/comfy";
import { PainterSketchController } from "./controller";
import { releaseOrDetach, sessionForManifest } from "./sessionAttach";
import { attachSession, createSession, fileSignature, findSession, releaseSession, sessionMatches } from "./sessions";

vi.mock("@comfy/scripts/app.js", () => ({ app: {} }));
vi.mock("../defaults/readDefaults", () => ({
  readFirstMaskStyle: () => ({ color: "#ff0000", opacity: 0.5 }),
  readPressureDefaults: () => ({}), readSampleDefaults: () => ({}),
}));
vi.mock("../engine/editor", () => {
  class Editor {
    doc: PainterDocument;
    events = new Emitter<EditorEvents>();
    hasPaint = false;
    dirty = false;
    constructor(doc: PainterDocument) { this.doc = cloneDocument(doc); }
    setMaskStyleProvider(): void {}
    hiddenMaskHasContent(): boolean { return false; }
    fork(docId: string): Editor {
      const copy = new Editor(this.doc);
      copy.doc.docId = docId;
      copy.hasPaint = this.hasPaint;
      copy.dirty = this.dirty;
      return copy;
    }
    dispose(): void { this.events.clear(); }
  }
  return { Editor, HIDDEN_MASK_NOTE: "hidden" };
});
vi.mock("../tools/registry", () => ({ createDefaultTools: () => ({}) }));
vi.mock("./persistence", () => ({
  restoreLayers: async () => undefined,
  LayerUploader: class {
    busy = false;
    flush = vi.fn(async () => undefined);
    flushQuietly = vi.fn();
    schedule = vi.fn();
    dispose = vi.fn();
    onSettled(): () => void { return () => undefined; }
  },
}));
vi.mock("../ui/editorHost", () => ({
  EditorHost: class {
    element = { isConnected: false, remove: vi.fn() };
    setSession(): void {}
    dispose(): void {}
  },
}));
vi.mock("./eventIsolation", () => ({ isolateEvents: () => ({ dispose: () => undefined }) }));
vi.mock("./backgroundLoader", () => ({
  BackgroundLoader: class {
    background = null;
    lastExecuted = null;
    dispose(): void {}
    adopt(): void {}
  },
  SourceWatcher: class {
    active = false;
    start(): void { this.active = true; }
    stop(): void { this.active = false; }
  },
}));
vi.mock("./frameSync", () => ({
  FrameSync: class {
    fallbackFrame(): { size: { width: number; height: number } } { return { size: { width: 640, height: 480 } }; }
    reset(): void {}
    apply(): void {}
  },
}));
vi.mock("./imageSource", () => ({ isInputConnected: () => true }));
vi.mock("./graphSync", () => ({ requestGraphSync: vi.fn(), EDIT_SYNC_DELAY_MS: 0, UPLOAD_SYNC_DELAY_MS: 0 }));
vi.mock("./comfyApi", () => ({ executeCommand: vi.fn(), SAVE_WORKFLOW_COMMAND: "save" }));
vi.mock("./toast", () => ({ notify: vi.fn() }));

const controllers: PainterSketchController[] = [];
const ids = new Set<string>();

function node(id = "1", graph = false): LGraphNode {
  return {
    id, graph: graph ? { id: "graph" } : null, inputs: [], size: [300, 300], constructor: {},
    setSize: () => undefined, getInputNode: () => null,
    addDOMWidget: () => { throw new Error("Unused by controller"); },
  };
}

function controller(id = "1", graph = false): PainterSketchController {
  const value = new PainterSketchController(node(id, graph));
  controllers.push(value);
  return value;
}

function documentWith(kind: "region" | "options"): PainterDocument {
  const doc = createEmptyDocument({ width: 400, height: 200 });
  ids.add(doc.docId);
  if (kind === "region") {
    doc.regions = [createRegion("face", 2, { x: -10, y: 20, width: 50, height: 70 })];
  } else doc.mainOutput = { ...cloneOutputOptions(), applyMask: "crop", cropPadding: 3 };
  return doc;
}

function parsedDocument(value: string): PainterDocument {
  const parsed = parseDocument(value);
  if (parsed.status !== "ok") throw new Error(`Expected manifest, got ${parsed.status}`);
  ids.add(parsed.document.docId);
  return parsed.document;
}

afterEach(() => {
  for (const value of controllers) value.dispose();
  controllers.length = 0;
  for (const id of ids) releaseSession(id);
  ids.clear();
});

describe.each(["region", "options"] as const)("%s-only persistence before preview", (kind) => {
  it("syncs edits, queues without paint upload, detaches and reattaches the same session", async () => {
    const doc = documentWith(kind);
    const first = controller();
    first.setValue(stringifyDocument(doc));
    const session = findSession(doc.docId)!;
    expect(session.editor.hasPaint).toBe(false);
    expect(parsedDocument(first.getValue())).toEqual(doc);
    Object.assign(session.editor.doc, { mainOutput: { ...cloneOutputOptions(), fillColor: "#abcdef" } });
    session.editor.events.emit("change", undefined);
    expect(parsedDocument(first.getValue()).mainOutput?.fillColor).toBe("#abcdef");
    expect(parsedDocument(await first.serialize())).toEqual(session.editor.doc);
    const saved = first.getValue();
    first.dispose();
    expect(session.alive).toBe(true);
    expect(session.owner).toBeNull();
    const next = controller("2");
    next.setValue(saved);
    expect(findSession(doc.docId)).toBe(session);
    expect(session.owner).toBe(next);
    expect(parsedDocument(await next.serialize())).toEqual(session.editor.doc);
  });

  it("forks live duplicates with independent nested metadata", async () => {
    const doc = documentWith(kind);
    const first = controller();
    first.setValue(stringifyDocument(doc));
    const duplicate = controller("2");
    duplicate.setValue(first.getValue());
    const fork = parsedDocument(await duplicate.serialize());
    expect(fork.docId).not.toBe(doc.docId);
    const editor = findSession(fork.docId)!.editor;
    Object.assign(editor.doc, { mainOutput: { ...cloneOutputOptions(), fillColor: "#ffffff" } });
    if (kind === "region") {
      editor.doc.regions[0]!.rect.x = 700;
      editor.doc.regions[0]!.output.cropPadding = 100;
    }
    editor.events.emit("change", undefined);
    expect(parsedDocument(first.getValue())).toEqual(doc);
  });

  it("treats explicit empty input as reset, while graph undo preserves live metadata", () => {
    const doc = documentWith(kind);
    const first = controller("91", true);
    first.setValue(stringifyDocument(doc));
    const session = findSession(doc.docId)!;
    first.dispose();
    const successor = controller("91", true);
    successor.handleAdded();
    successor.setValue("");
    expect(parsedDocument(successor.getValue())).toEqual(doc);
    expect(session.owner).toBe(successor);
    // With no graph handoff, an explicit empty value really does reset work.
    successor.setValue("");
    expect(successor.getValue()).toBe("");
    expect(session.owner).toBeNull();
  });
});

describe("session matching and recovery", () => {
  it("retains an explicitly saved default Main choice and serializes latest metadata at queue/detach", async () => {
    const doc = documentWith("options");
    doc.mainOutput = cloneOutputOptions();
    const first = controller();
    first.setValue(stringifyDocument(doc));
    expect(parsedDocument(await first.serialize())).toEqual(doc);
    const session = findSession(doc.docId)!;
    session.editor.doc.mainOutput!.fillColor = "#ffffff";
    // Boundary sync does not rely on a pending UI event having fired yet.
    expect(parsedDocument(await first.serialize()).mainOutput!.fillColor).toBe("#ffffff");
    session.editor.doc.mainOutput!.cropPadding = 9;
    first.dispose();
    expect(parsedDocument(first.getValue()).mainOutput!.cropPadding).toBe(9);
    expect(session.alive).toBe(true);
    const next = controller("2");
    next.setValue(first.getValue());
    expect(findSession(doc.docId)).toBe(session);
  });

  it("restores older metadata even with identical files and a recent signature", () => {
    const old = documentWith("region");
    const session = createSession(old, "document");
    session.editor.doc.regions[0]!.rect.x = 100;
    session.editor.events.emit("change", undefined);
    expect(session.recentSignatures).toContain(fileSignature(old));
    expect(sessionMatches(session, old)).toBe(false);
    const restored = sessionForManifest(old, {}, null);
    expect(restored).not.toBe(session);
    expect(restored.editor.doc).toEqual(old);
  });

  it("still accepts recent upload references when metadata matches", () => {
    const old = documentWith("region");
    old.layers[0]!.file = "old.png [input]";
    const session = createSession(old, "document");
    session.editor.doc.layers[0]!.file = "new.png [input]";
    session.editor.events.emit("change", undefined);
    expect(sessionMatches(session, old)).toBe(true);
    expect(sessionForManifest(old, {}, null)).toBe(session);
  });

  it("handoff wins over an old manifest; a different live owner restores a fork", () => {
    const old = documentWith("options");
    const session = createSession(old, "document");
    session.editor.doc.mainOutput!.cropPadding = 90;
    session.editor.events.emit("change", undefined);
    expect(sessionForManifest(old, {}, session)).toBe(session);
    attachSession(session, {});
    const fork = sessionForManifest(old, {}, null);
    ids.add(fork.docId);
    expect(fork.docId).not.toBe(old.docId);
    expect(fork.editor.doc.mainOutput!.cropPadding).toBe(3);
    expect(session.editor.doc.mainOutput!.cropPadding).toBe(90);
  });

  it("preserves raw invalid manifests until an output edit, including queue/detach", async () => {
    const first = controller();
    first.setValue(stringifyDocument(documentWith("region")));
    const raw = '{"version":900,"recover":"keep me"}';
    first.setValue(raw);
    expect(first.getValue()).toBe(raw);
    expect(await first.serialize()).toBe(raw);
    first.dispose();
    expect(first.getValue()).toBe(raw);
    const setup = vi.spyOn(Editor.prototype, "setMaskStyleProvider");
    const next = controller("2");
    next.setValue(raw);
    const editor = setup.mock.contexts.at(-1);
    setup.mockRestore();
    if (!(editor instanceof Editor)) throw new Error("Expected recovery editor");
    Object.assign(editor.doc, { mainOutput: { ...cloneOutputOptions(), applyMask: "fill" } });
    editor.events.emit("change", undefined);
    expect(parsedDocument(await next.serialize())).toEqual(editor.doc);
  });

  it("retains missing-file recovery sessions even when runtime paint is empty", () => {
    const doc = createEmptyDocument({ width: 20, height: 30 });
    ids.add(doc.docId);
    doc.layers[0]!.file = "missing.png [input]";
    const session = createSession(doc, "document");
    const owner = {};
    attachSession(session, owner);
    releaseOrDetach(session, owner);
    expect(session.alive).toBe(true);
    expect(findSession(doc.docId)).toBe(session);
    expect(session.editor.doc.layers[0]!.file).toBe("missing.png [input]");
  });
});
