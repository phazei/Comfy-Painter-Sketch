/**
 * Injects the editor stylesheet once per page. ComfyUI only auto-loads `.js`
 * from `WEB_DIRECTORY`, so the CSS is bundled as a string (`?inline`).
 */

import editorCss from "./editor.css?inline";

const STYLE_ELEMENT_ID = "cps-styles";

/**
 * Add the `<style>` element if it is not already present. Idempotent.
 */
export function injectStyles(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = editorCss;
  document.head.appendChild(style);
}
