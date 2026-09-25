/**
 * Injects the editor stylesheets (layout + controls + colour picker + layers
 * panel + fullscreen) once per page as one `<style>`. ComfyUI only auto-loads `.js` from
 * `WEB_DIRECTORY`, so the CSS is bundled as strings (`?inline`).
 */

import colorPickerCss from "./colorPicker.css?inline";
import controlsCss from "./controls.css?inline";
import editorCss from "./editor.css?inline";
import fullscreenCss from "./fullscreen.css?inline";
import layersCss from "./layers.css?inline";

const STYLE_ELEMENT_ID = "cps-styles";

/**
 * Add the `<style>` element if it is not already present. Idempotent.
 */
export function injectStyles(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `${editorCss}\n${controlsCss}\n${colorPickerCss}\n${layersCss}\n${fullscreenCss}`;
  document.head.appendChild(style);
}
