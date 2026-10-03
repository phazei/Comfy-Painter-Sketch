/**
 * Left sliders pill (design handoff "Left sliders pill"): vertical Size and
 * Hardness sliders bound to the active tool's options -- `size` + `hardness`
 * for the brush and eraser, `width` (no hardness) for the shapes. Those keys
 * leave the options strip while the pill shows them ({@link sliderKeys}).
 *
 * A slider is a vertical track: dragging anywhere on it (pointer capture)
 * sets the value from the pointer's height, mapped through the descriptor's
 * slider curve (`displayToSlider` / `sliderToDisplay`, so sizes get fine
 * control at the low end). Values write through `ToolOptions.set`; release
 * calls `endEdit`. The value is shown under each slider in mono. Hidden in
 * modal states (Free Transform, region mode, Align drawing).
 */

import { displayToSlider, formatDisplay, fromDisplay, sliderToDisplay, toDisplay } from "../tools/options";
import type { NumberOption, OptionDescriptor, ToolOptions } from "../tools/options";
import { setIcon } from "./icons";

/**
 * The option keys the sliders pill takes over from the strip: `size` and
 * `hardness` when the options have a hardness (paint tools; the text tool's
 * size stays in the strip), `width` when they have a width (shapes).
 * @param options - Options being shown (or `null`).
 * @returns Keys to hide from the strip.
 */
export function sliderKeys(options: ToolOptions | null): ReadonlySet<string> {
  const keys = new Set<string>();
  if (!options) return keys;
  const has = (key: string): boolean => numberOption(options.descriptors, key) !== undefined;
  if (has("hardness") && has("size")) keys.add("size").add("hardness");
  if (has("width")) keys.add("width");
  return keys;
}

/** One vertical slider. */
interface VSlider {
  readonly element: HTMLDivElement;
  bind(desc: NumberOption | undefined): void;
  refresh(): void;
}

/**
 * The sliders pill.
 */
export class SlidersPill {
  /** The pill. */
  readonly element: HTMLDivElement;
  private options: ToolOptions | null = null;
  private modal = false;
  private readonly size: VSlider;
  private readonly hardness: VSlider;
  private readonly divider: HTMLDivElement;

  /**
   * @param container - Shell slot (`shell.slidersSlot`).
   * @param changed - An option changed (refresh strip, cursor, notify the registry).
   */
  constructor(container: HTMLElement, changed: () => void) {
    this.element = document.createElement("div");
    this.element.className = "cps-sliders";
    this.size = vslider("cps-vslider-size", () => this.options, changed);
    this.hardness = vslider("cps-vslider-hardness", () => this.options, changed);
    this.divider = document.createElement("div");
    this.divider.className = "cps-sliders-div";
    this.element.append(this.size.element, this.divider, this.hardness.element);
    this.element.hidden = true;
    container.appendChild(this.element);
  }

  /** Whether the pill is shown. */
  get visible(): boolean {
    return !this.element.hidden;
  }

  /**
   * Follow a tool's options (the strip's bound options).
   * @param options - Options, or `null`.
   */
  bind(options: ToolOptions | null): void {
    if (options === this.options) {
      this.refresh();
      return;
    }
    this.options = options;
    const keys = sliderKeys(options);
    const descriptors = options?.descriptors ?? [];
    const width = keys.has("width") ? numberOption(descriptors, "width") : undefined;
    this.size.bind(width ?? (keys.has("size") ? numberOption(descriptors, "size") : undefined));
    this.hardness.bind(keys.has("hardness") ? numberOption(descriptors, "hardness") : undefined);
    this.sync();
  }

  /** Re-read values (after shortcuts such as `[` / `]`). */
  refresh(): void {
    this.size.refresh();
    this.hardness.refresh();
  }

  /**
   * Hide while a modal state runs (Free Transform, region mode, Align drawing).
   * @param on - A modal state is on.
   */
  setModal(on: boolean): void {
    if (on === this.modal) return;
    this.modal = on;
    this.sync();
  }

  private sync(): void {
    const keys = sliderKeys(this.options);
    const hasHardness = keys.has("hardness");
    this.element.hidden = this.modal || keys.size === 0;
    this.divider.hidden = !hasHardness;
    this.hardness.element.hidden = !hasHardness;
    this.refresh();
  }
}

// ── Slider ────────────────────────────────────────────────────────────────────

/** Icon + tooltip per option key. */
const LOOK: Readonly<Record<string, { icon: string; title: string }>> = {
  size: { icon: "brushSize", title: "Size  [ ]" },
  width: { icon: "lineWidth", title: "Width  [ ]" },
  hardness: { icon: "hardness", title: "Hardness  \u21e7[ \u21e7]" },
};

/**
 * Build one vertical slider (icon, track, value).
 * @param className - Extra class (sets the track height in CSS).
 * @param getOptions - Current options.
 * @param changed - Change callback.
 * @returns The slider.
 */
function vslider(className: string, getOptions: () => ToolOptions | null, changed: () => void): VSlider {
  const element = document.createElement("div");
  element.className = `cps-vslider ${className}`;
  const icon = document.createElement("span");
  icon.className = "cps-vslider-icon";
  const hit = document.createElement("div");
  hit.className = "cps-vslider-hit";
  const track = document.createElement("div");
  track.className = "cps-vslider-track";
  const fill = document.createElement("div");
  fill.className = "cps-vslider-fill";
  const thumb = document.createElement("div");
  thumb.className = "cps-vslider-thumb";
  track.append(fill, thumb);
  hit.appendChild(track);
  const value = document.createElement("span");
  value.className = "cps-vslider-value cps-mono";
  element.append(icon, hit, value);

  let desc: NumberOption | undefined;
  const display = (): number => {
    const v = desc ? getOptions()?.get(desc.key) : undefined;
    return desc && typeof v === "number" ? toDisplay(desc, v) : (desc?.min ?? 0);
  };
  const refresh = (): void => {
    if (!desc) return;
    const d = display();
    const pct = `${(displayToSlider(desc, d) * 100).toFixed(2)}%`;
    fill.style.height = pct;
    thumb.style.bottom = pct;
    value.textContent = `${formatDisplay(desc, d)}${desc.unit === "%" ? "%" : ""}`;
  };
  const setFrom = (clientY: number): void => {
    const options = getOptions();
    if (!desc || !options) return;
    // Measured every event: the root is drawn at the graph's zoom.
    const r = track.getBoundingClientRect();
    if (r.height <= 0) return;
    const t = 1 - (clientY - r.top) / r.height;
    if (options.set(desc.key, fromDisplay(desc, sliderToDisplay(desc, t)))) changed();
    refresh();
  };

  hit.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !desc) return;
    event.preventDefault();
    const id = event.pointerId;
    try {
      hit.setPointerCapture(id);
    } catch {
      return;
    }
    hit.classList.add("cps-dragging");
    setFrom(event.clientY);
    const controller = new AbortController();
    const { signal } = controller;
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== id) return;
      controller.abort();
      hit.classList.remove("cps-dragging");
      if (hit.hasPointerCapture(id)) hit.releasePointerCapture(id);
      if (desc) getOptions()?.endEdit?.(desc.key);
    };
    hit.addEventListener("pointermove", (e) => e.pointerId === id && setFrom(e.clientY), { signal });
    hit.addEventListener("pointerup", end, { signal });
    hit.addEventListener("pointercancel", end, { signal });
    hit.addEventListener("lostpointercapture", end, { signal });
  });

  return {
    element,
    bind: (next) => {
      desc = next;
      const look = next ? LOOK[next.key] : undefined;
      setIcon(icon, look?.icon ?? "", 16);
      const title = look?.title ?? next?.label ?? "";
      for (const el of [icon, hit, value]) el.title = title;
      hit.setAttribute("aria-label", title);
      refresh();
    },
    refresh,
  };
}

/**
 * The number descriptor with a key.
 * @param descriptors - Descriptors.
 * @param key - Option key.
 * @returns The descriptor, or `undefined` (absent or not a number).
 */
function numberOption(descriptors: readonly OptionDescriptor[], key: string): NumberOption | undefined {
  const desc = descriptors.find((d) => d.key === key);
  return desc?.kind === "number" ? desc : undefined;
}
