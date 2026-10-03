/**
 * Injects the editor stylesheets once per page as one `<style>`, in cascade
 * order: tokens + stage (editor), bar primitives (bars), option controls,
 * tool dock + sliders, colour picker, side panel, layer rows, outputs tab,
 * bottom bar, fullscreen. ComfyUI only auto-loads `.js` from
 * `WEB_DIRECTORY`, so the CSS is bundled as strings (`?inline`).
 */

import barsCss from "./bars.css?inline";
import bottomBarCss from "./bottomBar.css?inline";
import colorPickerCss from "./colorPicker.css?inline";
import controlsCss from "./controls.css?inline";
import dockCss from "./dock.css?inline";
import editorCss from "./editor.css?inline";
import fullscreenCss from "./fullscreen.css?inline";
import layerRowsCss from "./layerRows.css?inline";
import outputsCss from "./outputs.css?inline";
import panelCss from "./panel.css?inline";

const STYLE_ELEMENT_ID = "cps-styles";

/** Stylesheets in cascade order. */
const SHEETS: readonly string[] = [
  editorCss,
  barsCss,
  controlsCss,
  dockCss,
  colorPickerCss,
  panelCss,
  layerRowsCss,
  outputsCss,
  bottomBarCss,
  fullscreenCss,
];

/**
 * Add the `<style>` element if it is not already present. Idempotent.
 */
export function injectStyles(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = SHEETS.join("\n");
  document.head.appendChild(style);
}
