/**
 * The Images button and its tray (SPEC "Image sources and the Images panel";
 * design handoff "Top-right group"): the button sits first in the top-right
 * pill (`clipGroup.ts`) with a count badge and is disabled while the node's
 * source history is empty. It opens a narrow tray right-aligned under that
 * pill: a vertical, scrollable thumbnail column, newest first; clicking a
 * thumbnail runs `pick` and the tray STAYS open (insert several sources in a
 * row; the next stage press closes it anyway).
 *
 * The tray is sticky, not a regular popover: it lives in the popover layer
 * (so it follows the root into fullscreen and is covered by the root's
 * pointer/wheel isolation) but is not on the popover host's stack, so clicks
 * elsewhere -- other nodes, the graph, the options strip, the side panel,
 * other popovers -- leave it open. It closes only on: Esc
 * ({@link ImagesPanel.handleKey}, called by the host BEFORE every other key
 * handler), a press on the stage, a press on a dock tool button, or the
 * Images button again.
 *
 * Auto-open: a `"new"` history change (a source not seen before, after the
 * initial state; see `layerSourceWatch.ts`) opens the tray if closed and
 * marks that thumbnail (accent ring + "NEW") until the tray closes; a
 * repeat moving to the top does not.
 *
 * The list follows the history live while open. Like every bar button the
 * button never takes DOM focus (the keyboard scope prevents it).
 */

import type { SourceChange, SourceEntry, SourceHistory } from "../widget/sourceHistory";
import { setIcon } from "./icons";
import type { PopoverHost } from "./popover";

/** What the tray needs. */
export interface ImagesPanelOptions {
  /** The node's source history (`null` = no history: the button stays disabled). */
  history: SourceHistory | null;
  /** Popover host (the tray lives in its layer). */
  popovers: PopoverHost;
  /** Editor root (positions are root-local). */
  root: HTMLElement;
  /** Stage (a press on it closes the tray; bounds the tray height). */
  stage: HTMLElement;
  /** Dock tool buttons (a press there closes the tray). */
  toolBox: HTMLElement;
  /** The tray is right-aligned under this element (the top-right pill or its slot). */
  anchor: HTMLElement;
  /** Before a user-initiated open (end drags). */
  beforeOpen(): void;
  /** A thumbnail was clicked (the tray stays open). */
  pick(entry: SourceEntry): void;
}

/** Gap between the anchor and the tray, root CSS px. */
const GAP = 6;
/** Room kept free under the tray (bottom bar), root CSS px. */
const BOTTOM_ROOM = 56;

/**
 * Images button + thumbnail tray.
 */
export class ImagesPanel {
  readonly button: HTMLButtonElement;
  private readonly badge: HTMLSpanElement;
  private readonly list: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private open = false;
  /** Key of the entry announced as new (highlighted until the tray closes). */
  private newKey: string | null = null;
  private readonly unlisten: () => void;
  private readonly abort = new AbortController();
  private readonly resize = new ResizeObserver(() => this.place());

  /**
   * @param options - History, popover host, layout elements, callbacks.
   */
  constructor(private readonly options: ImagesPanelOptions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cps-bar-button cps-images-button";
    button.title = "Images (layer_source)";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-haspopup", "dialog");
    setIcon(button, "images", 19);
    this.badge = document.createElement("span");
    this.badge.className = "cps-images-badge";
    button.appendChild(this.badge);
    button.addEventListener("click", () => this.toggle());
    this.button = button;
    this.list = document.createElement("div");
    this.list.className = "cps-images-list";
    this.list.setAttribute("role", "listbox");
    this.panel = document.createElement("div");
    this.panel.className = "cps-images-tray";
    this.panel.appendChild(this.list);
    const { signal } = this.abort;
    const closeOnPress = (): void => this.close();
    options.stage.addEventListener("pointerdown", closeOnPress, { capture: true, signal });
    options.toolBox.addEventListener("pointerdown", closeOnPress, { capture: true, signal });
    this.unlisten = options.history?.onChange((change) => this.changed(change)) ?? (() => undefined);
    this.sync();
  }

  /** Whether the tray is open. */
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

  /** Close the tray (idempotent); the "new" mark ends here. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.newKey = null;
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
    this.resize.observe(this.options.root);
    this.resize.observe(this.options.anchor);
  }

  private changed(change: SourceChange): void {
    if (change === "new") this.newKey = this.entries[0]?.key ?? null;
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
        item.title = `${label}Add as a new layer`;
        const img = document.createElement("img");
        img.className = "cps-images-thumb";
        img.alt = "";
        img.decoding = "async";
        img.draggable = false;
        img.src = entry.url;
        item.appendChild(img);
        if (this.newKey !== null && entry.key === this.newKey) {
          item.classList.add("cps-new");
          const badge = document.createElement("span");
          badge.className = "cps-images-new";
          badge.textContent = "NEW";
          item.appendChild(badge);
        }
        item.addEventListener("click", () => this.options.pick(entry));
        return item;
      }),
    );
  }

  /**
   * Right-aligned under the anchor, at most down to the bottom bar
   * (root-local CSS px; the root may be CSS-scaled by the graph zoom).
   */
  private place(): void {
    if (!this.open) return;
    const root = this.options.root;
    const r = root.getBoundingClientRect();
    const a = this.options.anchor.getBoundingClientRect();
    const scale = root.offsetWidth > 0 && r.width > 0 ? r.width / root.offsetWidth : 1;
    const right = (a.right - r.left) / scale - root.clientLeft;
    const top = (a.bottom - r.top) / scale - root.clientTop + GAP;
    const width = this.panel.offsetWidth;
    this.panel.style.left = `${Math.round(right - width)}px`;
    this.panel.style.top = `${Math.round(top)}px`;
    this.panel.style.maxHeight = `${Math.max(80, Math.round(root.clientHeight - top - BOTTOM_ROOM))}px`;
  }
}
