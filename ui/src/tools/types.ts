/**
 * The Tool interface. Every tool is an object implementing it; the editor UI
 * routes input to the active tool and never branches on tool ids.
 */

import type { Editor } from "../engine/editor";
import type { ToolOptions } from "./options";

/** One pointer sample, already converted to document coordinates. */
export interface ToolPointer {
  /** Document x. */
  x: number;
  /** Document y. */
  y: number;
  /** Normalized pressure 0..1 (mouse/touch = 1). */
  pressure: number;
  pointerType: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}

/**
 * Stored options of brush-like tools (a type alias so it is assignable to
 * `OptionValues`). The brush colour is the editor's foreground colour.
 */
export type PaintOptions = {
  /** Diameter in image px (as seen on the current background); tools convert to document px. */
  size: number;
  /** 0..1 */
  hardness: number;
  /** 0..1 stroke opacity. */
  opacity: number;
  /** 0..1 per-dab alpha. */
  flow: number;
  /** Fraction of diameter. */
  spacing: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
  /** Diameter at zero pressure as a fraction of `size` (pressure -> size). */
  minSize: number;
  /** Pressure curve exponent (1 = linear, > 1 = softer start). */
  gamma: number;
};

/** Named stage cursor icon; the CSS definitions live in `ui/cursors.ts`. */
export type CursorIcon = "crosshair" | "eyedropper" | "bucket";

/**
 * Cursor the stage should show: a brush-size ring (drawn on the overlay, over
 * a crosshair) or a named CSS cursor icon.
 */
export type ToolCursor = { kind: "ring"; diameter: number } | { kind: "icon"; icon: CursorIcon };

/** A tool. */
export interface Tool {
  readonly id: string;
  readonly label: string;
  /** Single-key shortcut (lowercase), e.g. `"b"`. */
  readonly shortcut: string;
  /** Icon name in `ui/icons.ts` (unknown names get a fallback glyph). */
  readonly icon: string;
  /** Editable options (rendered by the options bar), or `null`. */
  readonly options: ToolOptions | null;
  /**
   * While Alt is held over the stage this tool acts as the eyedropper
   * (Photoshop: brush, bucket, shapes). Honoured by {@link ToolRegistry.resolve}.
   */
  readonly altEyedropper?: boolean;

  /**
   * Pointer pressed on the stage.
   * @param editor - Editor.
   * @param samples - Coalesced samples (at least one).
   */
  onPointerDown(editor: Editor, samples: readonly ToolPointer[]): void;
  /**
   * Pointer moved while pressed.
   * @param editor - Editor.
   * @param samples - Coalesced samples since the last event.
   */
  onPointerMove(editor: Editor, samples: readonly ToolPointer[]): void;
  /**
   * Pointer released.
   * @param editor - Editor.
   * @param sample - Final sample.
   */
  onPointerUp(editor: Editor, sample: ToolPointer): void;
  /**
   * Interaction aborted (pointer cancel, blur, tool switch).
   * @param editor - Editor.
   */
  onCancel(editor: Editor): void;
  /**
   * Cursor for the current options.
   * @returns Cursor description.
   */
  cursor(): ToolCursor;
  /**
   * Transient stage overlay (e.g. the eyedropper loupe), drawn at the
   * pointer instead of the cursor ring. Polled on every overlay redraw.
   * @returns Overlay description, or `null` for none.
   */
  overlay?(): ToolOverlay | null;
}

/** Declarative stage overlay of a tool (drawn by `ui/stageView.ts`). */
export type ToolOverlay = {
  /** Eyedropper ring: top half the sampled colour, bottom half the colour before the drag. */
  kind: "loupe";
  color: string;
  previous: string;
};
