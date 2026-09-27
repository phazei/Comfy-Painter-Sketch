/**
 * One labelled output-card input (X / Y / W / H, crop padding). A field
 * session -- focus to blur/Enter, or one label scrub -- is one region
 * transaction (one undo step); Escape reverts it. The input is refreshed in
 * place and never rebuilt, so live updates can't steal focus or text.
 */

import { clampNumber } from "../geometry/rect";
import type { RegionOps } from "../engine/regionOps";

/** Scrub: screen px of pointer travel per unit step. */
const SCRUB_PX_PER_STEP = 2;

/** Scrub: step multiplier while Shift is held. */
const SCRUB_SHIFT_FACTOR = 10;

/** Disposable field. */
export interface OutputField {
  element: HTMLLabelElement;
  input: HTMLInputElement;
  /** Re-read the value (skipped while the user is typing) and bounds. */
  refresh(): void;
  /** Revert an open session and detach listeners. */
  dispose(): void;
}

/** Field services. */
export interface OutputFieldOptions {
  label: string;
  /** Tooltip / accessible name (defaults to `label`). */
  title?: string;
  ops: RegionOps;
  /** Current value. */
  read(): string | number;
  /** Apply a typed or scrubbed value inside the open session. */
  write(value: string): void;
  /** Called before a session starts (cancels canvas drags). */
  beforeEdit(): void;
  /** Hand keyboard focus back to the editor after blur. */
  releaseFocus(): void;
  /** Numeric bounds; present = numeric field with a scrub label. Re-read on use. */
  bounds?: () => { min: number; max: number };
}

// ═══════════════════════════════════════════════════════════════════════════
// Field
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a field.
 * @param options - Field services.
 * @returns Stable input with its transaction lifecycle.
 */
export function outputField(options: OutputFieldOptions): OutputField {
  const element = document.createElement("label");
  element.className = "cps-output-field";
  const label = document.createElement("span");
  label.textContent = options.label;
  const input = document.createElement("input");
  input.type = options.bounds ? "number" : "text";
  input.step = "1";
  input.spellcheck = false;
  input.setAttribute("aria-label", options.title ?? options.label);
  element.append(label, input);

  /** A session (typing or scrub) is open. */
  let editing = false;
  /** Aborts the scrub's pointer listeners. */
  let scrub: AbortController | null = null;
  let releaseCapture: (() => void) | null = null;

  const refresh = (): void => {
    if (!editing || scrub) input.value = String(options.read());
    if (!options.bounds) return;
    const bounds = options.bounds();
    input.min = String(bounds.min);
    input.max = String(bounds.max);
  };

  const begin = (): void => {
    if (editing) return;
    options.beforeEdit();
    editing = options.ops.begin();
  };

  const end = (cancel: boolean): void => {
    scrub?.abort();
    scrub = null;
    releaseCapture?.();
    releaseCapture = null;
    if (!editing) return;
    editing = false;
    if (cancel) options.ops.cancel();
    else options.ops.commit();
    refresh();
  };

  /** Typed text is applied only when it parses (numeric fields). */
  const typedValueValid = (): boolean => {
    if (!options.bounds) return true;
    return input.value !== "" && Number.isFinite(input.valueAsNumber);
  };

  input.addEventListener("focus", begin);
  input.addEventListener("input", () => {
    begin();
    if (editing && typedValueValid()) options.write(input.value);
  });
  input.addEventListener("blur", () => {
    end(false);
    options.releaseFocus();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" && event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    end(event.key === "Escape");
    input.blur();
  });

  if (options.bounds) {
    label.className = "cps-output-scrub";
    label.title = `${options.title ?? options.label}: drag to scrub (Shift = x10), Esc reverts`;
    label.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      input.focus({ preventScroll: true });
      begin();
      if (editing) startScrub(event);
    });
  }

  /** Label scrub: horizontal travel changes the value; release commits, cancel reverts. */
  function startScrub(event: PointerEvent): void {
    const start = Number(options.read());
    const x0 = event.clientX;
    const id = event.pointerId;
    label.setPointerCapture(id);
    scrub = new AbortController();
    releaseCapture = () => {
      if (label.hasPointerCapture(id)) label.releasePointerCapture(id);
    };
    const { signal } = scrub;
    label.addEventListener(
      "pointermove",
      (e) => {
        const bounds = options.bounds?.();
        if (e.pointerId !== id || !bounds) return;
        const steps = Math.trunc((e.clientX - x0) / SCRUB_PX_PER_STEP);
        const step = e.shiftKey ? SCRUB_SHIFT_FACTOR : 1;
        options.write(String(clampNumber(start + steps * step, bounds.min, bounds.max)));
        refresh();
      },
      { signal },
    );
    const finish = (e: PointerEvent): void => {
      if (e.pointerId !== id) return;
      end(e.type !== "pointerup");
      input.blur();
    };
    label.addEventListener("pointerup", finish, { signal });
    label.addEventListener("pointercancel", finish, { signal });
    label.addEventListener("lostpointercapture", finish, { signal });
  }

  refresh();
  return { element, input, refresh, dispose: () => end(true) };
}
