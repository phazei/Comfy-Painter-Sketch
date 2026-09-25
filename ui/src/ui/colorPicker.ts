/**
 * Compact colour picker popover (M3.2, SPEC "Color").
 *
 * Usage: call {@link openColorPicker} with a {@link PopoverHost} and options;
 * it opens a popover and returns the {@link PopoverHandle}.
 *
 * Layout (~200 px wide):
 * - SV square (canvas, pointer-drag with setPointerCapture)
 * - Horizontal hue slider (canvas)
 * - Hex text field (Enter/blur applies; invalid input reverts)
 * - Old/new colour preview (clicking old reverts)
 * - Up to 10 recent colours from localStorage key `PainterSketch.recentColors`
 *
 * Keyboard:
 * - Esc reverts to initial and closes (handled by the popover element).
 * - Enter in the hex field applies.
 * - Typing in the hex field does NOT trigger editor shortcuts (keyboard.ts
 *   recognises `<input type=text>` as a text field and lets keys through).
 *
 * Click-outside commits (default popover behaviour: `outside` pointerdown
 * closes the popover, which calls `onCommit` via `onClose`).
 *
 * Pointer / wheel events inside stay inside: the popover is inside the editor
 * root whose isolation guard already stops propagation to the graph.
 *
 * The layers panel agent may reuse this function for the mask colour picker.
 */

import type { PopoverHandle, PopoverHost } from "./popover";
import { clamp01, hexToHsv, hsvToHex, type Hsv } from "./colorMath";
import { normalizeHex } from "../engine/colors";

// ── Constants ───────────────────────────────────────────────────────────────

const RECENT_KEY = "PainterSketch.recentColors";
const MAX_RECENTS = 10;

// ── Public API ──────────────────────────────────────────────────────────────

/** Options for {@link openColorPicker}. */
export interface ColorPickerOptions {
  /** Starting colour (`#rrggbb`). */
  initial: string;
  /** Optional title shown above the picker. */
  title?: string;
  /**
   * Called while the user drags / types – live preview.
   * @param hex - Current colour.
   */
  onInput: (hex: string) => void;
  /**
   * Called once when the picker commits (clicking outside, or Enter in the
   * hex field). Not called when Esc reverts. Optional.
   * @param hex - Committed colour.
   */
  onCommit?: (hex: string) => void;
}

/**
 * Open a compact HSV colour picker popover.
 * @param host    - The popover host of the editor where the picker should appear.
 * @param anchor  - Element to attach the popover to.
 * @param opts    - Initial colour, title, and live/commit callbacks.
 * @returns The {@link PopoverHandle}; call `.close()` to close programmatically.
 */
export function openColorPicker(
  host: PopoverHost,
  anchor: HTMLElement,
  opts: ColorPickerOptions,
): PopoverHandle {
  const initial = normalizeHex(opts.initial) ?? "#000000";
  let hsv: Hsv = hexToHsv(initial) ?? { h: 0, s: 0, v: 0 };
  let current = initial;
  let committed = false;
  let escaped = false;

  // ── Build DOM ────────────────────────────────────────────────────────────

  const root = document.createElement("div");
  root.className = "cps-picker";

  if (opts.title) {
    const title = document.createElement("div");
    title.className = "cps-picker-title";
    title.textContent = opts.title;
    root.appendChild(title);
  }

  // SV square
  const svWrap = document.createElement("div");
  svWrap.className = "cps-picker-sv";
  const svCanvas = document.createElement("canvas");
  svCanvas.className = "cps-picker-sv-canvas";
  const svThumb = document.createElement("div");
  svThumb.className = "cps-picker-sv-thumb";
  svWrap.append(svCanvas, svThumb);

  // Hue slider
  const hueWrap = document.createElement("div");
  hueWrap.className = "cps-picker-hue";
  const hueThumb = document.createElement("div");
  hueThumb.className = "cps-picker-hue-thumb";
  hueWrap.appendChild(hueThumb);

  // Hex field
  const hexRow = document.createElement("div");
  hexRow.className = "cps-picker-hex-row";
  const hexLabel = document.createElement("span");
  hexLabel.className = "cps-picker-hex-label";
  hexLabel.textContent = "Hex";
  const hexInput = document.createElement("input");
  hexInput.type = "text";
  hexInput.className = "cps-picker-hex-input";
  hexInput.maxLength = 7;
  hexInput.spellcheck = false;
  hexInput.autocomplete = "off";
  hexRow.append(hexLabel, hexInput);

  // Old/new preview
  const preview = document.createElement("div");
  preview.className = "cps-picker-preview";
  preview.title = "Click left half to revert to original colour";
  const previewOld = document.createElement("div");
  previewOld.className = "cps-picker-preview-old";
  const previewNew = document.createElement("div");
  previewNew.className = "cps-picker-preview-new";
  preview.append(previewOld, previewNew);

  // Recent colours
  const recentsEl = document.createElement("div");
  recentsEl.className = "cps-picker-recents";

  root.append(svWrap, hueWrap, hexRow, preview, recentsEl);

  // ── State helpers ────────────────────────────────────────────────────────

  /** Apply a new colour without committing – updates all widgets + callback. */
  const applyHsv = (newHsv: Hsv, skipHexField = false): void => {
    hsv = newHsv;
    current = hsvToHex(hsv);
    drawSv();
    positionSvThumb();
    positionHueThumb();
    if (!skipHexField) syncHexField();
    previewNew.style.backgroundColor = current;
    opts.onInput(current);
  };

  const applyHex = (hex: string): void => {
    const normalized = normalizeHex(hex);
    if (!normalized) return;
    const newHsv = hexToHsv(normalized);
    if (!newHsv) return;
    applyHsv(newHsv);
  };

  // ── SV square ────────────────────────────────────────────────────────────

  const drawSv = (): void => {
    const ctx = svCanvas.getContext("2d");
    if (!ctx) return;
    const w = svCanvas.width;
    const h = svCanvas.height;

    // White -> hue gradient (left to right = saturation)
    const satGrad = ctx.createLinearGradient(0, 0, w, 0);
    satGrad.addColorStop(0, "#ffffff");
    satGrad.addColorStop(1, hsvToHex({ h: hsv.h, s: 1, v: 1 }));
    ctx.fillStyle = satGrad;
    ctx.fillRect(0, 0, w, h);

    // Transparent -> black gradient (top to bottom = value)
    const valGrad = ctx.createLinearGradient(0, 0, 0, h);
    valGrad.addColorStop(0, "rgba(0,0,0,0)");
    valGrad.addColorStop(1, "#000000");
    ctx.fillStyle = valGrad;
    ctx.fillRect(0, 0, w, h);
  };

  const positionSvThumb = (): void => {
    svThumb.style.left = `${clamp01(hsv.s) * 100}%`;
    svThumb.style.top = `${(1 - clamp01(hsv.v)) * 100}%`;
  };

  const svPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    svWrap.setPointerCapture(event.pointerId);
    updateSvFromEvent(event);
  };

  const svPointerMove = (event: PointerEvent): void => {
    if (!svWrap.hasPointerCapture(event.pointerId)) return;
    updateSvFromEvent(event);
  };

  const updateSvFromEvent = (event: PointerEvent): void => {
    const rect = svCanvas.getBoundingClientRect();
    const s = clamp01((event.clientX - rect.left) / rect.width);
    const v = clamp01(1 - (event.clientY - rect.top) / rect.height);
    applyHsv({ h: hsv.h, s, v });
  };

  svWrap.addEventListener("pointerdown", svPointerDown);
  svWrap.addEventListener("pointermove", svPointerMove);
  // Stop events leaking up past the popover (belt and suspenders)
  svWrap.addEventListener("wheel", (e) => e.stopPropagation());

  // ── Hue slider ───────────────────────────────────────────────────────────

  const positionHueThumb = (): void => {
    hueThumb.style.left = `${(hsv.h / 360) * 100}%`;
  };

  const huePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    hueWrap.setPointerCapture(event.pointerId);
    updateHueFromEvent(event);
  };

  const huePointerMove = (event: PointerEvent): void => {
    if (!hueWrap.hasPointerCapture(event.pointerId)) return;
    updateHueFromEvent(event);
  };

  const updateHueFromEvent = (event: PointerEvent): void => {
    const rect = hueWrap.getBoundingClientRect();
    const h = clamp01((event.clientX - rect.left) / rect.width) * 360;
    applyHsv({ h, s: hsv.s, v: hsv.v });
  };

  hueWrap.addEventListener("pointerdown", huePointerDown);
  hueWrap.addEventListener("pointermove", huePointerMove);
  hueWrap.addEventListener("wheel", (e) => e.stopPropagation());

  // ── Hex field ────────────────────────────────────────────────────────────

  const syncHexField = (): void => {
    // Show without the leading '#' to save width, but accept both.
    hexInput.value = current.slice(1).toUpperCase();
    hexInput.classList.remove("cps-invalid");
  };

  const applyHexField = (): void => {
    const raw = hexInput.value.trim();
    const normalized = normalizeHex(raw);
    if (normalized) {
      hexInput.classList.remove("cps-invalid");
      applyHex(normalized);
    } else {
      // Revert the field but keep whatever colour was last valid
      hexInput.classList.add("cps-invalid");
      syncHexField();
    }
  };

  hexInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      applyHexField();
      hexInput.blur();
    }
    // Don't stop other keys – let Esc bubble to the popover's keydown handler
    // which calls handle.close() (revert path). Other letter keys are fine
    // because keyboard.ts marks input[type=text] as a foreign text target.
  });

  hexInput.addEventListener("blur", () => {
    applyHexField();
  });

  hexInput.addEventListener("input", () => {
    const raw = hexInput.value.trim();
    const normalized = normalizeHex(raw);
    if (normalized) {
      hexInput.classList.remove("cps-invalid");
      applyHex(normalized);
    } else {
      hexInput.classList.add("cps-invalid");
    }
  });

  // ── Preview: click old to revert ─────────────────────────────────────────

  previewOld.style.backgroundColor = initial;
  previewOld.title = "Click to revert to original colour";
  previewOld.addEventListener("click", () => {
    applyHex(initial);
  });

  // ── Recent colours ────────────────────────────────────────────────────────

  const loadRecents = (): string[] => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v): v is string => typeof v === "string" && normalizeHex(v) !== null);
    } catch {
      return [];
    }
  };

  const saveRecent = (hex: string): void => {
    const normalized = normalizeHex(hex);
    if (!normalized) return;
    const existing = loadRecents().filter((c) => c !== normalized);
    const updated = [normalized, ...existing].slice(0, MAX_RECENTS);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
    } catch {
      // Storage quota or private mode – silently ignore.
    }
  };

  const renderRecents = (): void => {
    recentsEl.textContent = "";
    const recents = loadRecents();
    for (const hex of recents) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cps-picker-recent";
      btn.style.backgroundColor = hex;
      btn.title = hex.toUpperCase();
      btn.setAttribute("aria-label", `Use recent colour ${hex.toUpperCase()}`);
      btn.addEventListener("click", () => applyHex(hex));
      recentsEl.appendChild(btn);
    }
    recentsEl.hidden = recents.length === 0;
  };

  // ── Canvas sizing ────────────────────────────────────────────────────────

  /** Sync canvas backing resolution to its CSS size. */
  const resizeSvCanvas = (): void => {
    const rect = svCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (svCanvas.width !== w || svCanvas.height !== h) {
      svCanvas.width = w;
      svCanvas.height = h;
    }
  };

  // ── Initial render ────────────────────────────────────────────────────────

  // We do the initial render in a rAF so the element has been added to the DOM
  // and has a layout size for getBoundingClientRect.
  requestAnimationFrame(() => {
    resizeSvCanvas();
    drawSv();
    positionSvThumb();
    positionHueThumb();
    syncHexField();
    previewOld.style.backgroundColor = initial;
    previewNew.style.backgroundColor = current;
    renderRecents();
  });

  // ── Esc: revert and close ─────────────────────────────────────────────────
  // The popover element intercepts Escape (popover.ts line 100-105) and calls
  // handle.close(). We detect the revert path via the `escaped` flag set in
  // onClose (before committed is true).

  // ── Open the popover ──────────────────────────────────────────────────────

  const handle = host.open(root, {
    anchor,
    placement: "below",
    onClose: () => {
      if (!escaped && !committed) {
        // Clicking outside = commit
        committed = true;
        if (current !== initial) {
          saveRecent(current);
          opts.onCommit?.(current);
        }
      } else if (escaped) {
        // Esc = revert to initial
        opts.onInput(initial);
      }
    },
  });

  // Intercept the Escape key that the popover element forwards to handle.close()
  // so we can mark the revert path. We listen on the content root's ancestor
  // popover element (handle.element) in the capture phase.
  handle.element.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        escaped = true;
        // Let the event continue to the popover's own Escape handler.
      }
    },
    true,
  );

  return handle;
}

// ── Recent colours utility (exposed for testing / external use) ───────────

/**
 * Read the persisted recent colours list.
 * @returns Array of up to {@link MAX_RECENTS} normalized hex strings.
 */
export function getRecentColors(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && normalizeHex(v) !== null);
  } catch {
    return [];
  }
}
