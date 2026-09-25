/**
 * The Tool interface. Every tool is an object implementing it; the editor UI
 * routes input to the active tool and never branches on tool ids.
 */

import type { Editor } from "../engine/editor";

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

/** Numeric/boolean/colour options shown in the options strip. */
export interface PaintOptions {
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
  /** Present on tools that paint a colour. */
  color?: string;
}

/** Cursor the stage should show. */
export type ToolCursor = { kind: "ring"; diameter: number } | { kind: "css"; value: string };

/** A tool. */
export interface Tool {
  readonly id: string;
  readonly label: string;
  /** Single-key shortcut (lowercase), e.g. `"b"`. */
  readonly shortcut: string;
  /** Editable options, or `null` for tools without options. */
  readonly options: PaintOptions | null;

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
}
