/**
 * The Tool interface. Every tool is an object implementing it; the editor UI
 * routes input to the active tool and never branches on tool ids.
 */

import type { Editor } from "../engine/editor";
import type { Point, Rect } from "../geometry/rect";
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
export type CursorIcon = "crosshair" | "eyedropper" | "bucket" | "move";

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
   * Selection tool: with a selection, Shift / Alt / Shift+Alt at
   * pointer-down add / subtract / intersect (`selectionModifiers.ts`). The
   * stage shows the matching badge on the cursor (`ui/cursors.ts`).
   */
  readonly combinesSelection?: boolean;

  /**
   * `false` = hidden tool: registered in the registry and activatable,
   * but not shown in the tool rail and not bound to a keyboard shortcut.
   * Omit or set `true` for normal rail tools.
   */
  readonly rail?: boolean;

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
   * Wheel while this tool's drag is in progress (e.g. Move: scale). When
   * absent, the wheel zooms the view as usual; outside a drag it always does.
   * @param editor - Editor.
   * @param deltaPx - Wheel delta normalized to px (positive = wheel down).
   * @param at - Pointer position.
   */
  onWheel?(editor: Editor, deltaPx: number, at: ToolPointer): void;
  /**
   * An interaction stays open between presses (polygonal lasso while Alt is
   * held). While `true`, the stage sends pointer moves with the button up
   * and modifier changes to {@link Tool.onHover}, Esc calls
   * {@link Tool.onCancel}, and tool switches cancel it.
   * @returns `true` while waiting for the next press.
   */
  pending?(): boolean;
  /**
   * Pointer moved (or a modifier changed) with the button up while
   * {@link Tool.pending} (rubber-band segment; releasing Alt closes).
   * @param editor - Editor.
   * @param sample - Current pointer.
   */
  onHover?(editor: Editor, sample: ToolPointer): void;
  /**
   * Tool-specific key while this tool is active and the editor has the
   * keyboard (e.g. Move: arrow nudges). Called before the tool/letter
   * shortcuts, never for Ctrl/Alt chords.
   * @param editor - Editor.
   * @param event - Key event.
   * @returns `true` if handled.
   */
  onKey?(editor: Editor, event: KeyboardEvent): boolean;
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
export type ToolOverlay =
  | {
      /** Eyedropper ring: top half the sampled colour, bottom half the colour before the drag. */
      kind: "loupe";
      color: string;
      previous: string;
    }
  | {
      /** In-progress selection outline (marquee / lasso), drawn as marching ants in document coords. */
      kind: "selection";
      shape: SelectionShape;
    };

/** Outline of an in-progress selection, document coords. */
export type SelectionShape =
  | { kind: "rect"; rect: Rect }
  | { kind: "ellipse"; rect: Rect }
  /** Lasso: `closed` joins the last point back to the first. */
  | { kind: "polygon"; points: readonly Point[]; closed: boolean };
