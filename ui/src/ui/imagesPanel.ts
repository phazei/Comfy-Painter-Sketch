/**
 * The rail's Images button and its panel (SPEC "Image sources (M12)"): the
 * button sits next to Paste with a count badge and is disabled while the
 * node's source history is empty. It opens a narrow panel over the left of
 * the stage with a vertical, scrollable thumbnail list, newest first;
 * clicking a thumbnail runs `pick` and the panel STAYS open (insert several
 * sources in a row; the next stage press closes it anyway).
 *
 * The panel is sticky, not a regular popover: it lives in the popover layer
 * (so it follows the root into fullscreen and is covered by the root's
 * pointer/wheel isolation) but is not on the popover host's stack, so clicks
 * elsewhere -- other nodes, the graph, the options bar, the layers panel,
 * other popovers -- leave it open. It closes only on: Esc
 * ({@link ImagesPanel.handleKey}, called by the host BEFORE every other key
 * handler), a press on the stage, a press on a rail tool button, or the
 * Images button again.
 *
 * Auto-open: a `"new"` history change (a source not seen before, after the
 * initial state; see `layerSourceWatch.ts`) opens the panel if closed; a
 * repeat moving to the top does not.
 *
 * The list follows the history live while open. Like every rail button the
 * button never takes DOM focus (the keyboard scope prevents it).
 */

import type { SourceChange, SourceEntry, SourceHistory } from "../widget/sourceHistory";
import { setIcon } from "./icons";
import type { PopoverHost } from "./popover";

/** What the panel needs. */
export interface ImagesPanelOptions {
  /** The node's source history (`null` = no history: the button stays disabled). */
  history: SourceHistory | null;
  /** Popover host (the panel lives in its layer). */
  popovers: PopoverHost;
  /** Editor root (positions are root-local). */
  root: HTMLElement;
  /** Stage (the panel covers its left edge; a press on it closes the panel). */
  stage: HTMLElement;
  /** Rail tool buttons (a press there closes the panel). */
  toolBox: HTMLElement;
  /** Before a user-initiated open (end drags). */
  beforeOpen(): void;
  /** A thumbnail was clicked (the panel stays open). */
  pick(entry: SourceEntry): void;
}

/** Inset of the panel from the stage edges, root CSS px. */
const INSET = 4;

/**
 * Images button + thumbnail panel.
 */
export class ImagesPanel {
  readonly button: HTMLButtonElement;
  private readonly badge: HTMLSpanElement;
  private readonly list: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private open = false;
  private readonly unlisten: () => void;
  private readonly abort = new AbortController();
  private readonly resize = new ResizeObserver(() => this.place());

  /**
   * @param options - History, popover host, layout elements, callbacks.
   */
  constructor(private readonly options: ImagesPanelOptions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cps-rail-button cps-images-button";
    button.title = "Images from the layer_source input (insert as a new layer)";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-haspopup", "dialog");
    setIcon(button, "images");
    this.badge = document.createElement("span");
    this.badge.className = "cps-images-badge";
    button.appendChild(this.badge);
    button.addEventListener("click", () => this.toggle());
    this.button = button;
    this.list = document.createElement("div");
    this.list.className = "cps-images-list";
    this.list.setAttribute("role", "listbox");
    const content = document.createElement("div");
    content.className = "cps-images-panel";
    content.appendChild(this.list);
    this.panel = document.createElement("div");
    this.panel.className = "cps-popover cps-images-popover";
    this.panel.appendChild(content);
    const { signal } = this.abort;
    const closeOnPress = (): void => this.close();
    options.stage.addEventListener("pointerdown", closeOnPress, { capture: true, signal });
    options.toolBox.addEventListener("pointerdown", closeOnPress, { capture: true, signal });
    this.unlisten = options.history?.onChange((change) => this.changed(change)) ?? (() => undefined);
    this.sync();
  }

  /** Whether the panel is open. */
  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Keydown from the editor's keyboard scope, before any other handler.
   * @param event - Key event.
   * @returns `true` if consumed (Esc while open).
   */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.open || event.key !== "Escape") return false;
    this.close();
    return true;
  }

  /** Close the panel (idempotent). */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.resize.disconnect();
    this.panel.remove();
    this.button.classList.remove("cps-active");
  }

  /** Close and stop listening. */
  dispose(): void {
    this.close();
    this.unlisten();
    this.abort.abort();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private get entries(): readonly SourceEntry[] {
    return this.options.history?.entries ?? [];
  }

  private toggle(): void {
    if (this.open) {
      this.close();
      return;
    }
    this.options.beforeOpen();
    this.show();
  }

  /** Open (no-op when open or empty). */
  private show(): void {
    if (this.open || this.entries.length === 0) return;
    this.open = true;
    this.render();
    this.options.popovers.element.appendChild(this.panel);
    this.button.classList.add("cps-active");
    this.list.scrollTop = 0;
    this.place();
    this.resize.observe(this.options.stage);
  }

  private changed(change: SourceChange): void {
    this.sync();
    if (change === "new") this.show();
  }

  /** Badge, disabled state, and the open list. */
  private sync(): void {
    const count = this.entries.length;
    this.badge.textContent = count > 0 ? String(count) : "";
    this.badge.hidden = count === 0;
    this.button.disabled = count === 0;
    if (!this.open) return;
    if (count === 0) this.close();
    else this.render();
  }

  private render(): void {
    this.list.replaceChildren(
      ...this.entries.map((entry, i) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "cps-images-item";
        item.setAttribute("role", "option");
        const label = entry.name ? `${entry.name} -- ` : i === 0 ? "Newest -- " : "";
        item.title = label ? `${label}click to insert as a new layer` : "Click to insert as a new layer";
        const img = document.createElement("img");
        img.className = "cps-images-thumb";
        img.alt = "";
        img.decoding = "async";
        img.draggable = false;
        img.src = entry.url;
        item.appendChild(img);
        item.addEventListener("click", () => this.options.pick(entry));
        return item;
      }),
    );
  }

  /** Over the left edge of the stage, at most the stage height (root-local CSS px; the root may be CSS-scaled). */
  private place(): void {
    if (!this.open) return;
    const element = this.panel;
    const root = this.options.root;
    const r = root.getBoundingClientRect();
    const s = this.options.stage.getBoundingClientRect();
    const scale = root.offsetWidth > 0 && r.width > 0 ? r.width / root.offsetWidth : 1;
    const left = (s.left - r.left) / scale - root.clientLeft + INSET;
    const top = (s.top - r.top) / scale - root.clientTop + INSET;
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
    element.style.maxHeight = `${Math.max(40, Math.round(s.height / scale - 2 * INSET))}px`;
  }
}
