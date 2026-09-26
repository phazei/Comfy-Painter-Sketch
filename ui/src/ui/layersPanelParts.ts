/**
 * Small DOM builders and row-model helpers for the layers panel
 * (`layersPanel.ts`), split out to keep that file focused on state sync.
 */

import { maskDisplayColor } from "../document/masks";
import type { Layer } from "../document/types";
import { setIcon } from "./icons";
import { soloGroup } from "../engine/solo";
import type { SoloIds } from "../engine/solo";
import type { RowModel, SoloMark } from "./layerRow";

/** Row flags computed by the panel. */
export interface RowFlags {
  /** Highlighted (paint target). */
  selected: boolean;
  /** Active paint layer while Quick Mask is on. */
  standby: boolean;
  /** Current mask (colour bar, Quick Mask on or off). */
  current: boolean;
  /** Solo display state. */
  solo: SoloMark;
}

/**
 * Solo display state of a layer's row.
 * @param layer - Layer.
 * @param solo - Current solos.
 * @returns `"on"`, `"dimmed"` (another row of its group is soloed) or `"off"`.
 */
export function soloMark(layer: Pick<Layer, "id" | "kind">, solo: Readonly<SoloIds>): SoloMark {
  if (solo.paint === null && solo.mask === null) return "off";
  return solo[soloGroup(layer)] === layer.id ? "on" : "dimmed";
}

/**
 * Display model of a layer row.
 * @param layer - Layer.
 * @param flags - Selection flags.
 * @returns Row model.
 */
export function rowModel(layer: Readonly<Layer>, flags: RowFlags): RowModel {
  const model: RowModel = {
    id: layer.id,
    name: layer.name,
    visible: layer.visible,
    locked: layer.locked,
    selected: flags.selected,
    standby: flags.standby,
    solo: flags.solo,
  };
  if (layer.kind === "mask") {
    model.color = maskDisplayColor(layer);
    model.invert = layer.invert === true;
    model.current = flags.current;
  }
  if (layer.kind === "text") model.text = true;
  return model;
}

/**
 * Create an element with a class.
 * @param tag - Tag name.
 * @param className - Class attribute.
 * @returns The element.
 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

/**
 * Footer icon button.
 * @param icon - Icon name.
 * @param title - Tooltip.
 * @param onClick - Click handler.
 * @returns The button.
 */
export function footerButton(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = el("button", "cps-icon-button cps-layers-action");
  button.type = "button";
  button.title = title;
  setIcon(button, icon, 16);
  button.addEventListener("click", onClick);
  return button;
}

/**
 * Build the "Move drawing" toggle button for the footer left side.
 * @param onClick - Called when the button is clicked.
 * @returns The button.
 */
export function moveDrawingBtn(onClick: () => void): HTMLButtonElement {
  const button = el("button", "cps-icon-button cps-layers-action cps-layers-move-drawing");
  button.type = "button";
  button.title = "Move drawing \u2014 reposition/scale all layers against the image";
  button.setAttribute("aria-label", "Move drawing \u2014 reposition/scale all layers against the image");
  button.setAttribute("aria-pressed", "false");
  setIcon(button, "moveDrawing", 16);
  button.addEventListener("click", onClick);
  return button;
}
