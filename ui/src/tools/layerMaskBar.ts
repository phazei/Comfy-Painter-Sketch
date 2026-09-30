/**
 * Options bar additions while a layer mask is the edit target (M14a): a
 * "Layer Mask:" caption, then the mask's Invert setting, Apply (M14b: bake
 * into the layer's pixels, one undo step) and Delete mask -- declarative
 * descriptors appended to whatever the bar shows for the active tool, so no
 * per-tool UI code. Hide / reveal is the black / white mask swatch on the
 * rail (X swaps), not a bar control.
 */

import type { Editor } from "../engine/editor";
import type { OptionDescriptor, OptionValue, ToolOptions } from "./options";
import type { Tool } from "./types";

const LABEL_KEY = "layerMaskLabel";
const INVERT_KEY = "layerMaskInvert";
const APPLY_KEY = "layerMaskApply";
const DELETE_KEY = "layerMaskDelete";

/** Caption + Invert + Apply + Delete (every tool while the mask is targeted). */
const MASK_DESCRIPTORS: readonly OptionDescriptor[] = [
  { kind: "label", key: LABEL_KEY, label: "Layer Mask:", title: "Strokes edit the layer mask (white hides, black reveals)", group: "layerMask" },
  { kind: "toggle", key: INVERT_KEY, label: "Invert mask", title: "Invert the layer mask (a setting; pixels are kept)", group: "layerMask" },
  { kind: "button", key: APPLY_KEY, label: "Apply", title: "Apply the layer mask: bake it into the layer's pixels and remove it (undoable)", group: "layerMask" },
  { kind: "button", key: DELETE_KEY, label: "Delete mask", title: "Delete the layer mask (undoable)", icon: "trash", group: "layerMask" },
];

/**
 * A tool's options plus the layer mask controls.
 */
export class LayerMaskBarOptions implements ToolOptions {
  readonly descriptors: readonly OptionDescriptor[];

  /**
   * @param editor - Session editor.
   * @param base - Options the bar would show otherwise (or `null`).
   */
  constructor(
    private readonly editor: Editor,
    private readonly base: ToolOptions | null,
  ) {
    this.descriptors = [...(base?.descriptors ?? []), ...MASK_DESCRIPTORS];
  }

  /** Groups of the base options. */
  get groups(): ToolOptions["groups"] {
    return this.base?.groups;
  }

  /** @inheritdoc */
  get(key: string): OptionValue | undefined {
    const lm = this.editor.layerMask;
    const id = lm.targeted;
    if (key === LABEL_KEY) return undefined;
    if (key === INVERT_KEY) return id ? lm.info(id)?.invert === true : false;
    if (key === DELETE_KEY || key === APPLY_KEY) return id !== null;
    return this.base?.get(key);
  }

  /** @inheritdoc */
  set(key: string, value: OptionValue): boolean {
    const lm = this.editor.layerMask;
    const id = lm.targeted;
    if (key === LABEL_KEY) return false;
    if (key === INVERT_KEY) return id !== null && typeof value === "boolean" && lm.setInvert(id, value);
    if (key === APPLY_KEY) return id !== null && value === true && lm.apply(id);
    if (key === DELETE_KEY) return id !== null && value === true && lm.remove(id);
    return this.base?.set(key, value) ?? false;
  }

  /** @inheritdoc */
  endEdit(key: string): void {
    this.base?.endEdit?.(key);
  }
}

/**
 * Bar decorator for the tool registry: while a layer mask is targeted (and
 * no Free Transform session runs), the bar gets the mask controls. Wrappers
 * are cached per options object so the bar only rebuilds on real changes.
 * @param editor - Session editor.
 * @returns Decorator for `ToolRegistry.setBarDecorator`.
 */
export function layerMaskBarDecorator(editor: Editor): (options: ToolOptions | null, active: Tool) => ToolOptions | null {
  const cache = new WeakMap<object, LayerMaskBarOptions>();
  const none = {};
  return (options) => {
    if (!editor.layerMask.targeted || editor.float.transform.active) return options;
    const base = options ?? none;
    let wrapped = cache.get(base);
    if (!wrapped) {
      wrapped = new LayerMaskBarOptions(editor, options);
      cache.set(base, wrapped);
    }
    return wrapped;
  };
}
