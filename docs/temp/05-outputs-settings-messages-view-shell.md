# PainterSketch frontend research: outputs/regions, settings, messages, tooltips, canvas/view, shell/focus

All file:line references are in `ui/src/`. Everything below was read from the code, not from the old SPEC. Section E lists where the two disagree.

---

# A. Spec sections

## A1. Outputs and regions (editor)

**Terms.** An *output* is Main or a region. It has a result and options. A *region* is the rectangle. Slot N feeds helper pair N (`IMAGE N` / `MASK N`).

**Region mode = the Outputs tab.** There is no region rail tool.
- A hidden tool, `region` (`tools/region.ts:79-150`), is active exactly while the Outputs tab is shown. It has `rail: false`, an empty shortcut and `ctrlMove: false`. It has no `altEyedropper` and no options, so the options bar is empty. Its cursor is the crosshair icon.
- Opening the Outputs tab activates the region tool. Clicking the tab button goes `SidePanel.showTab` → `tab` event → `HostSync.tabChanged` → `toolForTab` (`regionMode.ts:29`).
- Choosing any other tool shows the Layers tab. `HostSync.syncTools` calls `showTab(tabForTool(active.id))` on every tool change (`hostSync.ts:175`).
- Leaving the Outputs tab by clicking Layers re-activates the last rail tool (`lastRailTool`). The fallback is the first rail tool.
- The Outputs button (icon `region`, `aria-pressed`) and the **O** key call `HostSync.toggleOutputs` (`hostSync.ts:219-231`):
  - Region tool active and panel open: show Layers, which restores the last tool.
  - Otherwise: open the panel (`setCollapsed(false)`), show Outputs, activate the region tool.
  - So with the panel collapsed in region mode, O reopens the panel rather than leaving region mode.
- Collapsing the panel by its toggle does not leave region mode. Overlay and tool stay in region mode.
- The Outputs button sits in the options bar's trailing area, between the resolution notice and the panel toggle (`shell.ts:118`, `hostSync.ts:144`). It is not on the rail.
- Esc does not leave region mode. Delete/Backspace never deletes a region (the editor swallows it, `selectionShortcuts.ts:32-38`). Only the card's trash button removes a region.
- Shift+O is not bound.

**Pointer behaviour** (`tools/region.ts`; coordinates are current-image px via `docToImage(frameMap)`):
- *Press.*
  - Without Shift, `grabAt` runs (`:57-69`). Only visible regions count.
    1. The selected region's handle, within 6 screen px (`HANDLE_HIT_PX`) → resize.
    2. The selected region's body → move.
    3. The topmost visible region, searching `doc.regions` from the end (creation order, not slot order) → move.
  - Pressing on a region selects it immediately (a view change, not an edit).
  - Shift always starts a draw, even inside a region.
- *Click slop.* Movement under 3 screen px is a click (`CLICK_SLOP_PX`). Only a real drag opens a transaction (`regionOps.begin`).
- *Draw.*
  - Creates a region in the lowest empty slot (`nextRegionSlot`) on the first move past the slop. It is selected, with a live rect.
  - The rect spans start to current in any direction, rounded and clamped to the region area, at least 1×1 (`drawRegionRect`).
  - With all six slots used, the first move past the slop shows the note "All 6 region slots are used. Delete a region to draw another." and nothing is created.
- *Click without drag.* A click on empty canvas selects Main. A Shift+click anywhere also selects Main (mode `draw`, not moved). A plain click on a region selects that region.
- *Resize.* The opposite edge stays fixed and the rect never flips (min 1 px, `dragRegionRect`).
- *Move.* The size is kept and the rect stops at the region area.
- *Cancel.* Esc mid-drag (`cancelToolDrag` → `onCancel` → `regionOps.cancel`) reverts the gesture.

**Geometry** (`document/regions.ts`, `engine/regionGeometry.ts`):
- Regions are stored in image px from the top-left, as integers. They are never rescaled.
- The region area is one image size beyond each edge: `x ∈ [-W, 2W]`, `y ∈ [-H, 2H]` (`regionArea`).
- Each edge is `floor(v + 0.5)`, then clamped (`clampEdges`), with at least 1×1.
- `+ Region N` creates a region centred at half the image size (`defaultRegionRect`).
- New regions are named `Region N`, visible, with default output options.

**Outputs tab layout** (`ui/outputsPanel.ts`):
- The tab list is Main card, then six slot wrappers (slot 1..6 in order).
- A filled slot shows a `RegionCard`. An empty slot shows a one-line `+ Region N` button (plus icon, tooltip "Add a centred region in slot N") that calls `addDefault(slot)`. Card N always feeds helper pair N.
- A permanent hint line sits below the list: "Drag on the image to add a region; Shift-drag starts a new one inside another." (`outputsPanel.ts:59`).
- The panel refreshes only on the editor `outputs` event, never on `render`. Cards are updated in place, so a field being edited is never rebuilt.

**Cards** (`ui/outputCard.ts`):
- Clicking a card (pointerdown not on a control, or focusin) selects it. Selected cards get `cps-selected`.
- *Region card, row 1.*
  - Eye: toggles `visible`, an overlay display flag only. Outputs are always produced. Hidden cards are dimmed.
  - Title: `N · name` (`regionSlotLabel`). Double-click renames just the name through the shared inline rename (pre-filled with the effective name; Enter or blur commits, Esc cancels; max 100 chars; trimmed; empty means `Region N`).
  - Trash: removes the region and empties the slot. Other slots are not renumbered.
- *Region card, row 2.* X / Y / W / H number fields, no spin arrows.
  - Bounds come from `regionFieldBounds`:
    - x: `[-W, 2W - width]`
    - y: `[-H, 2H - height]`
    - width: `[1, 2W - x]`
    - height: `[1, 2H - y]`
  - Typing applies live, rounded and clamped.
  - Dragging the label scrubs: 2 px per step, Shift ×10, `cursor: ew-resize`.
  - One field session (focus to blur/Enter, or one scrub) is one undo step. Esc reverts.
- *Main card.* Fixed title `Main`, read-only `W x H` (tooltip "Output size (current image px)"), then the options row. It is highlighted when `selectedId === null`.

**Output options row** (`ui/outputOptionsRow.ts`). Line 1 is the label `Modify`, a select with None / Fill mask / Crop to mask / Add border, then `Alpha`. Line 2 shows extras only when the choice has any.

| Modify | Line 1 | Line 2 | Defaults |
|---|---|---|---|
| None | Alpha | hidden | — |
| Fill mask | Fill swatch in Alpha's place (Alpha hidden, value kept) | hidden | fill `#000000` |
| Crop to mask | Alpha | `Pad` field (min 0) | 0 |
| Add border | Alpha | `W` (1..4096), swatch, `Mask border` checkbox | 64, `#ffffff`, on |

- Colour swatches open the colour picker popover. One session is one undo step; Esc reverts.
- Option values live in `OutputOptions` (`document/outputOptions.ts`). Border fields are always materialised on clone. `alpha` exists only when true.
- Options apply at execution only. Nothing changes on the stage.

**Overlay** (`ui/regionOverlay.ts`, drawn by `StageView.drawOverlay`):
- *Region mode.*
  - Solid outlines with a dark halo.
  - A number badge (12 px) at the top-left.
  - The selected region is 2 px `#62d5ff` with eight 6 px handles. Other regions are 1 px white.
  - The image border is highlighted (`#62d5ff`, 2 px) while Main is selected.
- *Outside region mode.* Subdued: 1 px dashed [4,4], two-tone (black dashes in the gaps), alpha 0.3, plain 9 px outlined number, no badge, no handles, no selection highlight.
- Only `visible` regions are drawn or hit-tested. Sizes are constant on screen (graph zoom divided out).

**Undo** (`engine/regionOps.ts`, `regionHistory.ts`):
- Edits (add, remove, rect, rename, eye, options) are `outputs` history entries holding metadata only: at most six small records, no pixels.
- A gesture is `begin` → `commit`. A no-op gesture leaves no step.
- Selecting is not a document edit: no `change`, so no upload, but it emits `outputs` + `render`.
- Clear restores `applyOutputs(undefined)` inside its snapshot. Regions are removed and Main options reset, all in the Clear undo step (`frameOps.ts:124`).

**`PainterSketch Regions` helper labels** (`widget/regionsNode.ts`, `regionLabels.ts`):
- The helper always has 12 outputs. Only `label` changes. Outputs are re-spliced so Nodes 2.0 notices.
- The labels come from the document of the PainterSketch node found via `helper.getInputNode`. That is the node's `document` widget value, parsed with `parseDocument`.
- Label forms:
  - Filled slot: `<name>` and `<name> mask`, using the effective name, so the default reads `Region N`.
  - Empty slot: `region N (missing)` and `region N mask (missing)`.
  - Unresolvable source (disconnected, legacy Reroute node, subgraph boundary, unreadable document): `region N` and `region N mask`.
- Relabelling triggers: `afterConfigureGraph`, helper `onAdded`, helper `onConnectionsChange`, and `documentEvents` (emitted when a PainterSketch node's widget value changes, same graph only). There is no polling.

Why: selection must stay a non-edit, or every click on a card would upload and clear redo.

Files: `ui/outputsPanel.ts`, `outputCard.ts`, `outputOptionsRow.ts`, `outputField.ts`, `regionOverlay.ts`, `regionMode.ts`, `hostSync.ts`, `engine/regionOps.ts`, `regionGeometry.ts`, `regionHistory.ts`, `tools/region.ts`, `document/regions.ts`, `outputOptions.ts`, `widget/regionsNode.ts`, `regionLabels.ts`, `styles/outputs.css`.

---

## A2. Settings

Settings are registered through `app.registerExtension({settings: SETTINGS})` (`main.ts:22`). They are collected in `settings.ts:20-27`, in panel order:

| # | id | Label (panel name) | Type / range | Default | Effect | Where read |
|---|---|---|---|---|---|---|
| 1 | `PainterSketch.PaintQuality` (Storage) | Paint layer quality | slider 50–100, step 1 | 99 | Below 100 saves paint layers as lossy WebP at that quality. 100 saves PNG. Masks and lmasks are always PNG. | `persistence.ts:151`, once per upload batch (`uploadDirty`), so a change affects future uploads only. `normalizePaintQuality` rounds and clamps. |
| 2 | `PainterSketch.Cleanup` (Storage) | Clean up files | custom control (`type` is a function), no stored value (`defaultValue ""`) | — | Renders a stats line and a **Clean up files** button (see below). | `cleanup/cleanupSetting.ts` |
| 3 | `PainterSketch.DefaultMaskColor` (Defaults) | Mask colour | color, stored without `#` | `ff0000` | Colour of the first cmask of a new document, and of a cmask added lazily to a document that has none. Existing cmasks keep theirs. | `readFirstMaskStyle` via `readDefaults.ts`: new document (`controller.ts:135`), lazy mask (provider set at `sessions.ts:69`), Quick Mask badge colour while no cmask exists (`hostSync.ts:239`). `normalizeMaskColor` accepts rgb / rrggbb / rrggbbaa and drops alpha. |
| 4 | `PainterSketch.DefaultMaskOpacity` (Defaults) | Mask overlay opacity (%) | slider 10–100, step 1 | 50 | Overlay opacity of the first cmask. Later cmasks take the first free palette colour at this same opacity (`nextMaskStyle`). Display only. | same |
| 5 | `PainterSketch.PressureSize` | Pen pressure controls size | boolean | on | Initial "Size" pressure toggle of brush and eraser. | `sessions.ts:80`, session creation (`createDefaultTools`). |
| 6 | `PainterSketch.PressureOpacity` | Pen pressure controls opacity | boolean | off | Initial "Opacity" pressure toggle. | same |
| 7 | `PainterSketch.PressureMinSize` | Pressure min size (%) | slider 0–100, step 1 | 10 | Size at zero pressure, as a share of the size. | same |
| 8 | `PainterSketch.PressureGamma` | Pressure curve (gamma) | slider 0.2–5, step 0.05 | 1 | Curve exponent (above 1 is a softer start). `normalizeGamma` snaps to 0.05. | same |
| 9 | `PainterSketch.BucketSample` | Paint bucket samples | combo | `background` | Initial "Sample" of the bucket. | `sessions.ts:80` (`readSampleDefaults`) |
| 10 | `PainterSketch.WandSample` | Magic wand samples | combo | `background` | Initial "Sample" of the wand. | same |

- The combo options for rows 9 and 10 are "Background (input image only)" = `background`, "Current layer" = `layer`, and "All layers (what you see)" = `all`. The options-bar labels differ: "Current layer", "All layers", "Background" (`tools/fill.ts:30-32`).
- Rows 5–10 are the initial option values of a newly created editor session. In-session changes win. A live editor is never touched, and sessions kept across tab switches keep theirs.
- The eyedropper has no setting.
- Reading goes through `readSetting` (`widget/comfyApi.ts:22`): `app.extensionManager.setting.get`, else `app.ui.settings.getSettingValue`. Any throw is logged once per id, and the value then reads as unset and falls back to the code default. `readDefaults.ts` adds its own `safeRead` try/catch. Every value is normalised with a type guard (junk gives the default).

**Cleanup control** (`cleanupSetting.ts`):
- The stats line reads "Loading file counts…", then `Files: N (X) · Older than 24 h: N (X)`. On failure it reads `Could not load file counts: <reason>.` (inline only, never a toast).
- Click: the button reads "Cleaning up…" and is disabled. Flow: `collectClientReferences` → dry run → nothing-to-do toasts or a confirm → real run with references re-collected → toast → stats refresh.
- It uses the project's one route, `POST /painter-sketch/cleanup`, with `{dryRun, referenced}` or `{mode: "stats"}`.

**localStorage (not settings):** `PainterSketch.recentColors` (max 10, `ui/recentColors.ts:12-13`) and `PainterSketch.recentFonts` (max 5, `document/textData.ts:232`, `tools/text.ts:50`).

Files: `settings.ts`, `widget/paintQuality.ts`, `defaults/maskDefaults.ts`, `pressureDefaults.ts`, `sampleDefaults.ts`, `readDefaults.ts`, `cleanup/cleanupSetting.ts`, `widget/comfyApi.ts`, `widget/sessions.ts`.

---

## A3. Canvas, view and fullscreen

**View model** (`engine/view.ts`, `engine/viewport.ts`):
- Content = the current image (the background, or the width×height fallback), not the document frame. `stage = content × scale + offset`.
- **Fit** adds 8 px padding (`fitView`). It is *sticky*: initial state, Ctrl+0, and the rail Fit button. While fitting, any stage or frame change re-fits.
- Any manual zoom, pan or Ctrl+1 leaves fit mode.
- After a manual view, a stage resize keeps the image point at the stage centre and clamps the offset.
- **Zoom limits** are 0.02 to 64 (`MIN_ZOOM`, `MAX_ZOOM`). The scale is in image px per stage CSS px and excludes graph zoom.
- **100%** (Ctrl+1) is one image px per on-screen px, centred on the stage centre. It uses `1/displayScale`, so it accounts for graph zoom.
- **Wheel on the stage** zooms about the cursor by `exp(-clamp(delta, ±300) × 0.0015)` (`wheelZoomFactor`). `deltaMode` 1 (lines) ×16, mode 2 (pages) ×stage height. Ctrl+wheel and pinch also zoom.
- **Ctrl +/=/+** zoom ×1.25 and **Ctrl+-/_** ×0.8, about the stage centre.
- **Wheel during a tool drag.** If the dragging tool has `onWheel` (Move drawing: scale), the tool gets the wheel instead of the view (`stageInput.ts:103`).
- **Pan** is middle-button drag (always) or Space + left-drag (`stageInput.ts:176`).
  - Space is ignored with Ctrl/Meta/Alt held. It is also ignored when the key event targets a text field (`modifierScope.ts:45`, `keyboard.ts:345`).
  - The stage classes `cps-pan-ready` and `cps-panning` hide the brush ring.
  - Right button does nothing, and the context menu is stopped at the root.
- **Pan clamp.** At least `min(64, on-screen image size)` CSS px of the image stays visible on each axis (`clampOffset`). It is applied on every view change, frame change and resize.
- **Backing store** = stage CSS size × devicePixelRatio × graph zoom, longest side capped at 4096 (`backingStoreSize`).
  - Pointer positions are converted through `getBoundingClientRect()` on every event (never cached).
  - Overlay sizes divide out graph zoom.
- **Stage drawing order** (`engine/compositor.ts:104-199`):
  1. Surround, then the cobweb outside the maximum paint area.
  2. Checker under the image area.
  3. Background (image or colour, or transparency when its eye is off), then layers, then cmask tints.
  4. A veil over off-image paint (only when the paint area extends past the image).
  5. The image outline: a faint shadow normally, a stronger outline when paint extends past it. It is always drawn.
  6. The paint-area border.
- A size label `W x H` sits under the image area (10 px, alpha 0.55, skipped if it would not fit; `resolutionLabel.ts`).
- Transient notes (below) show at the bottom of the stage for 5 s, one at a time (`stageView.ts:32,136`).

**Node sizing** (`widget/constants.ts`, `painterWidget.ts`, `nodeHooks.ts`):
- `getMinHeight` returns `WIDGET_MIN_HEIGHT = 256` (graph units). The DOM widget margin is `WIDGET_MARGIN = 6`.
- CSS backs this up with `min-height: 244px` on `.cps-widget` and `.cps-root` (`fullscreen.css:21`, `editor.css:30`). Nodes 2.0 ignores `getMinHeight` for DOM widgets.
- New nodes start at least 512 × 640 (`DEFAULT_NODE_SIZE`, applied before `configure`, so saved workflows keep their size).
- `width` and `height` widgets are hidden while `image` is linked (`widget.hidden`). When they reappear and the node is too short, the node grows (`sizeWidgets.ts:44`). Hiding never shrinks it.
- Output previews are suppressed: `hideOutputImages = true` for Nodes 2.0, plus a no-op `onDrawBackground` on our prototype for LiteGraph (`nodeHooks.ts:63`).

**Event isolation** (`widget/eventIsolation.ts`):
- The root stops `pointerdown/up/cancel`, `mousedown/up`, `dblclick` and `contextmenu` from bubbling. `pointermove` is not stopped on the root (the stage stops it itself during drags).
- A `window` capture listener for `wheel` and `pointerdown/move/up/cancel` is armed only while the pointer is over the root (or during a guarded middle-drag). Wheel over the stage zooms. Wheel elsewhere goes to `onChromeWheel`.
- Over the options bar, a wheel scrolls the bar sideways. Elsewhere the wheel scrolls natively. Ctrl+wheel is prevented (`shell.ts:156-167`).
- Middle-drag is guarded only when it starts on the stage. A lost middle `pointerup` ends the guard on the next non-middle press or move.
- `data-capture-wheel="true"` is also set on the root.

Why: Nodes 2.0's `TransformPane` forwards wheel and middle-button pointer events to the graph in the capture phase, before any listener on our element runs.

**Fullscreen** (`ui/fullscreen.ts`, `editorHost.ts:331-351`):
- Enter: the **F** key, the rail button (title "Fullscreen (F)"), or the `fullscreen` shell event.
  - The editor root is moved into a fixed overlay on `document.body`: `inset: 0`, `z-index: 1790` (above ComfyUI menus, below PrimeVue dialogs and toasts), padding `40px 12px 12px`.
  - The stable `.cps-widget` wrapper never moves. A placeholder button, "Editing in fullscreen — press Esc or click to return", takes the root's place in the node.
  - The overlay has an exit button at the top right, "Exit fullscreen" (title "Exit fullscreen (Esc)").
- On enter:
  - The side panel is saved (snapshot) and forced open.
  - The view re-fits.
  - The keyboard capture scope is set on the overlay.
  - Drags are cancelled and popovers closed.
- Exit: Esc (last in the Esc chain, below), F, the rail or overlay button, the placeholder click, or automatic exit.
  - On exit the panel state is restored, the view re-fits if it was fitting, and `onDisengage` fires (upload flush).
  - Automatic exit comes from a 250 ms poll (`WATCH_MS`) while open. It triggers when the container leaves the DOM or the node leaves the viewed graph.
- At most one editor is fullscreen per page. Entering another exits the first.
- Overlay isolation: pointer, mouse, click and dblclick events and contextmenu are stopped at the overlay. Backdrop wheel is stopped. Drops are blocked with `dropEffect = "none"`, so a file never loads a workflow into the hidden graph.
- The rail fullscreen button toggles its icon and tooltip to "Exit fullscreen (F / Esc)".
- In-node versus fullscreen:

  | | In-node | Fullscreen |
  |---|---|---|
  | Canvas scale | drawn at graph zoom (backing store follows it) | no graph zoom |
  | Side panel | auto-collapses below 520 px | forced open |
  | Keyboard | hover, click-engage | always owns it |
  | Unhandled keys | pass to ComfyUI | filtered by `fullscreenKeyPolicy` (list in D) |

Why: Nodes 2.0 only checks that `widget.element` is its child, so only the inner root may move, never the wrapper.

Files: `engine/view.ts`, `viewport.ts`, `ui/stageView.ts`, `stageInput.ts`, `fullscreen.ts`, `fullscreenKeys.ts`, `widget/eventIsolation.ts`, `widget/constants.ts`, `painterWidget.ts`, `nodeHooks.ts`, `sizeWidgets.ts`, `styles/fullscreen.css`, `styles/editor.css`.

---

## A4. Editor shell and focus

**Regions** (`ui/shell.ts`):
- The root `.cps-root` contains the rail, `main` (options bar over `body` = stage + side panel), and the popover host. Fixed sizes: rail 36 px, bar 28 px, panel 216 px (`editor.css:9-11`).
- *Rail.*
  - A scrolling tool box, with the scrollbar hidden.
  - A Quick Mask group.
  - A spacer.
  - The clipboard group: Copy, Cut, Paste (long-press source menu), Images with a count badge.
  - The action group: Undo, Redo, Fit, Clear, Fullscreen.
  - The swatch widget pinned at the bottom.
- *Options bar.*
  - `leading`: the selection actions ("To mask" and "Invert" while a selection exists) and the Quick Mask "Mask" badge in the mask colour.
  - `scroller`: the tool options. They scroll horizontally and never wrap.
  - `trailing`: the resolution notice, the Outputs button, then the panel toggle.
- *Side panel* tabs are **Layers** and **Outputs** (`HostSync` builds them). The tab buttons carry no tooltip.
  - The tab choice survives collapse and fullscreen.
  - Collapse logic is `sidePanelState.ts`. Below `NARROW_EDITOR_WIDTH = 520` px of root width the panel auto-collapses. A user toggle wins until the width crosses 520 again.
- Clear: confirm "Clear all paint, regions and output options? This can be undone." (`hostSync.ts:306`).

**Popovers** (`ui/popover.ts`):
- The host lives inside the root, so popovers follow it into fullscreen and are covered by the root's isolation.
- One popover at a time, except nesting (a popover anchored inside an open one stacks on it). Opening closes every open popover that does not contain the new anchor.
- Closing triggers: a pointerdown outside the popover and its anchor (a press inside a parent closes only its children), Esc inside it, `PopoverHost.close()` from the Esc chain, the anchor leaving the DOM, or the parent closing.
- Position: root-local CSS px with graph zoom divided out. Preferred side below, above or right, flipped when out of room, clamped inside the root. Gap 4 px.
- The Images panel is *not* a popover. It lives in the popover layer but outside the stack, so outside clicks leave it open (it closes on Esc, a stage press, a rail tool press, or its button).

**Long-press fly-outs:**
- Tool-group slots (Shape on U, Marquee on M): `LONG_PRESS_MS = 400` at `ui/toolGroupSlot.ts:15`.
- Paste button source menu: `LONG_PRESS_MS = 400` at `ui/pasteButton.ts:23`. This is a separate duplicate constant.
- Right-click (`contextmenu`) opens either immediately.
- Behaviour:
  - Pointerup, pointerleave or pointercancel cancels the timer.
  - After a long-press fires, the following click is suppressed.
  - The menu is a popover placed to the right of the button.
  - Items show label + key (group) or icon + label (paste). Choosing one makes it the slot's or button's current tool or source.

**Focus policy** (`ui/focusPolicy.ts`, `keyboard.ts`; this is the AGENTS.md rule as built):
- The keyboard scope is active when any of these holds: hover, a held drag, "engaged" (the user pressed inside), or fullscreen (`isScopeActive`).
  - While active, `keydown`/`keyup` capture listeners sit on `window`.
  - A hidden read-only `<input class="cps-focus-sink">` holds focus.
- *Hover* takes the sink unless a text field (anywhere, including other nodes) has focus (`hoverMayTakeFocus`). Leaving hands focus back.
- *A pointerdown in the root* engages. It is captured at the root, so it runs first.
  - Text entries (text input, textarea, select, contenteditable) keep native focus.
  - Range inputs keep native focus: `preventDefault` on pointerdown would kill native slider dragging.
  - Everything else is `preventDefault`ed and the sink takes focus, even from another node's text field. Engagement survives pointer leave.
- *Engagement ends* on a press or focusin outside the root and overlay.
- A non-text element that still gets focus is redirected to the sink. A text field that blurs to nothing returns focus to the sink.
- The rail's 2 px white left edge (`.cps-root.cps-has-keys .cps-rail`, `editor.css:122`) shows real focus (`document.activeElement` inside the root), never hover guesses.
- Ctrl+S, while the editor owns the key target, is intercepted (including from the editor's own text fields): flush, then `Comfy.SaveWorkflow`.
- Text fields other than the sink keep their keys (hex field, text tool, rename).
- Fullscreen: the scope is active without hover. Keys from UI above the overlay (a dialog) are ignored. Buttons outside the root (the exit button, the backdrop) do not keep focus.
- Scope going inactive calls `onDeactivate`, which is the upload-flush trigger.

Why: ComfyUI's ChangeTracker also listens on `window` capture, is registered before extensions, and ignores keys only when focus is in an INPUT. Focusing the sink is the only way Ctrl+Z undoes a stroke and not a graph edit.

**Esc chain** (`shortcuts.ts:69-72`, `editorHost.ts:178-201`), first consumer wins:
1. Images panel open.
2. Float or transform session: cancel.
3. Tool drag or pending tool interaction (shape drag, polygonal lasso, region drag): cancel.
4. Open popover (an open output colour picker session is reverted too).
5. Exit fullscreen.

Files: `ui/shell.ts`, `editorHost.ts`, `hostSync.ts`, `sidePanel.ts`, `sidePanelState.ts`, `popover.ts`, `toolRail.ts`, `toolGroupSlot.ts`, `pasteButton.ts`, `imagesPanel.ts`, `optionsBar.ts`, `focusPolicy.ts`, `keyboard.ts`, `modifierScope.ts`, `shortcuts.ts`, `styles/editor.css`.

---

# B. Messages

## B0. Toast system rules

- **API.** `notify(severity, detail, {key?, windowMs?, details?})` (`widget/toast.ts:42`) calls `app.extensionManager.toast.add({severity, summary: "PainterSketch", detail, life})`.
  - `life` is 10000 ms for `error` and 6000 ms for `warn` and `info`.
  - If the toast API is missing, it only logs.
  - The title is always "PainterSketch", so message text must not repeat the name.
- **Severity.**
  - `error` = the user's work is at risk (upload failure, workflow save failure).
  - `warn` = degraded, nothing lost.
  - `info` = rare confirmations (recovery, cleanup results).
  - The console (`[PainterSketch]` prefix, `log.ts`) logs every `warn` and `error` occurrence with `details`, shown or suppressed. `info` is not logged.
- **De-duplication** (`widget/toastLimiter.ts`).
  - The default key is `${severity}:${message}`. The default window is 10 s (`DEFAULT_TOAST_WINDOW_MS`).
  - A key shown within its window is suppressed. A suppressed occurrence does not extend the window, so a persistent problem re-announces once per window.
  - At most 64 keys are remembered, oldest first out.
  - `reset(key)` exists via `resetNotifyKey` (`toast.ts:57`) but nothing calls it.
- **Upload failure and recovery.** Both use a 60 s window (`UPLOAD_TOAST_WINDOW_MS`, `persistence.ts:57`) and shared keys `upload-failed` and `upload-recovered`, so several nodes in one outage give one toast. Additionally, `failureNotified` allows one failure toast per document per failure streak.
- **Wording and classification** (`widget/failures.ts`). `classifyError` maps: network `TypeError` to `offline`, 404/405 to `missing`, 413 to `tooLarge`, other 4xx to `rejected`, 5xx to `server`, canvas encode failure to `encode`, undecodable image to `unreadable`.
  - Upload failures give `uploadFailureMessage`.
  - Restore problems are folded into one message by `restoreSummary`. It is `error` if any layer failed transiently (offline or server error), else `warn`.
- **Console-only.** Background image load failures (upstreams change constantly) and unreadable-setting reads.
- **Stage notes** (the non-toast path) come from `editor.events.emit("note", text)` → `StageView.showNote`. They have no keys and no limiter. A new note replaces the old one, and each lasts 5000 ms (`NOTE_MS`). `dropImport` also calls the same sink.

## B1. Toasts (`notify`)

| Text | Key | Sev. | Trigger | file:line |
|---|---|---|---|---|
| Nothing to clean up (no files older than 24 h) | default | info | Cleanup dry run: no old files | `cleanup/cleanupSetting.ts:152` |
| Nothing to clean up (the N files older than 24 h are all in use) | default | info | Old files exist but all referenced | `:157` |
| Deleted N file(s) (X). | default | info | Cleanup done | `:167,170` |
| Deleted N file(s) (X). K problem(s), see server log. First: …  | default | warn | Cleanup done with errors | `:169` |
| File cleanup failed: <reason>. | default | warn | Cleanup route error (reasons: `cleanupFailureReason`, `failures.ts:152`) | `:173` |
| The saved painting has 1 layer entry / N layer entries that could not be read; loaded the rest (details in the console). | `skipped-layers` | warn | Manifest with skipped layers | `controller.ts:157`, text `failures.ts:192` |
| Could not read the saved painting (<reason>); showing an empty canvas. [It was probably saved by a newer PainterSketch; update the node.] The saved data is kept in the workflow unless you paint on this node. | `invalid-document:<reason>` | warn | Unreadable or unknown-version widget value | `controller.ts:179`, text `failures.ts:177` |
| Could not save paint layers: <reason>. Your paint is kept in the editor and retried automatically; don't reload the page until it is saved. | `upload-failed`, 60 s | error | Upload batch failed (reasons: server unreachable / too large HTTP 413 / server rejected the upload (…) / server error (HTTP n), check the ComfyUI console (disk full?) / browser could not encode "layer" (out of memory? try a smaller canvas)) | `persistence.ts:173`, text `failures.ts:116` |
| Paint layers saved again. | `upload-recovered`, 60 s | info | First success after a failure streak | `persistence.ts:184` |
| N layer(s) could not be loaded (the ComfyUI server is unreachable / server error, see the console): "a", "b" +k more. Reload the workflow to retry before painting on them. | `restore:<docId>:<msg>` | error | Restore: transient failures (parts below are joined into one message) | `persistence.ts:348`, text `failures.ts:246` |
| N layer(s) lost its/their file (deleted from input/painter-sketch?): …; loaded empty. | same | warn | Restore: missing files | `failures.ts:251` |
| N layer(s) could not be decoded (corrupt file?): …; loaded empty. | same | warn | Restore: undecodable | `failures.ts:257` |
| Their saved file references are kept until you edit those layers. | same | warn | Appended when any of the three above | `failures.ts:260` |
| N layer(s) was/were saved at an older canvas size (latest edits probably never uploaded): …; check their position. | same | warn | Restore: stale-size file | `failures.ts:264` |
| Loaded the painting as saved in this workflow; newer unsaved strokes from the previous copy of this node were discarded. | default | warn | Reopened workflow replaces a dirty live session | `widget/sessionAttach.ts:43` |
| Could not save the workflow: <error message> | default | error | `Comfy.SaveWorkflow` threw after Ctrl+S flush | `widget/uploadScheduler.ts:93` |
| Couldn't load the dragged image (the site doesn't allow it). Save it and drop the file instead. | `drag-image-blocked` | warn | Dropped web image blocked by CORS | `ui/dropImport.ts:34,109` |
| The image is N.Nx the drawing's resolution — use Match image resolution for full detail. | `resolution-mismatch:<docId>` | warn | Image finer than 1.5× the drawing grid (once per document per session) | `ui/resolutionNotice.ts:100` |
| The image's shape doesn't fit the drawing — parts can't be painted. Use Match image resolution to fix it. | `resolution-fit:<docId>` | warn | Image area exceeds the maximum paint area (once per document per session) | `:104` (label `:20`) |

## B2. Confirm dialogs (`window.confirm`)

| Text | Trigger | file:line |
|---|---|---|
| N of the M file(s) older than 24 h (X) are unused and will be deleted. This affects all workflows. [+ "\n\nWarning: K file(s) in the workflows folders could not be scanned (too large or unreadable); layer files used only there would be deleted."] | Cleanup after dry run | `cleanup/references.ts:138-148`, called `cleanupSetting.ts:163` |
| Clear all paint, regions and output options? This can be undone. | Rail Clear | `ui/hostSync.ts:306` |
| Upload failed; save anyway without the latest paint? | Ctrl+S when the flush failed | `widget/uploadScheduler.ts:88` |
| PainterSketch is still uploading paint (slow or unreachable server). Reload anyway and lose the unsaved paint? | F5 / Ctrl+R / Ctrl+Shift+R after the 3 s flush cap | `ui/reloadGuard.ts:40`, called `widget/pageGuards.ts:75` |
| PainterSketch could not upload some paint. Reload anyway and lose the unsaved paint? | Same, flush failed | `ui/reloadGuard.ts:42` |
| Resample all layers to the current image resolution? This clears the undo history. [+ "\n\nSome paint far outside the image exceeds the 16384 px paint-area limit and will be cropped."] | Match image resolution | `ui/resolutionNotice.ts:23,26,113` |
| Rasterize text layer? It will no longer be editable as text. | Pixel edit on a text layer | `engine/rasterize.ts:28`, shown by `ui/textOverlay.ts:73` |

## B3. Stage notes (`events.emit("note")`; no key, 5 s, one at a time)

| Text | Trigger | file:line |
|---|---|---|
| Layer is locked. | Edit on a locked layer | `engine/editorTypes.ts:198`, gate `rasterize.ts:77` |
| The layer is hidden. | Edit on an eye-off paint/text layer | `editorTypes.ts:204`, `rasterize.ts:91` |
| The layer is hidden by solo. | Edit on a layer another solo hides | `editorTypes.ts:207` |
| The mask is hidden. | Edit on an eye-off cmask; wand "Current layer" on one; queueing while a hidden cmask has content | `editorTypes.ts:222`, `widget/uploadScheduler.ts:60` |
| `<Image Mask or Input Mask>` can't be edited — duplicate it to edit. | Any pixel edit or Merge Down on that row | `editorTypes.ts:214`, `mergeDown.ts:93` |
| Layer mask: use the brush, eraser or fill. | Shapes, line or text with an lmask targeted | `engine/layerMask.ts:48,112`, `textOps.ts:117` |
| Layer mask: black and white only, no eyedropper (X swaps). | Eyedropper on a targeted lmask | `layerMask.ts:51`, `tools/eyedropper.ts:94` |
| The layer mask shows nothing. | Ctrl+click an lmask thumbnail when nothing is shown | `layerMaskOps.ts:37,375` |
| Layer mask applied. | Merge Down with an enabled upper lmask | `layerMaskCarry.ts:42`, `mergeDown.ts:73` |
| This layer can't be moved. | Move / nudge on a layer with no mover | `layerMovers.ts:55`, `moveOps.ts:163` |
| Nothing to merge down into. | Ctrl+E at the bottom of its group or with a group mismatch | `mergeDown.ts:40,96` |
| No pixels are selected. | Lift or move inside a selection that covers no pixels | `floatLift.ts:36` (`:109,:137`), `moveOps.ts:64` |
| The layer is empty. | Flip or whole-layer lift on an empty layer | `layerFlip.ts:24,38`, `floatLift.ts:137` |
| Nothing is selected. | To mask, fill, clear without a selection | `selectionOps.ts:53,247` (via `ready()` `:221,:260`) |
| The layer has no pixels. | Ctrl+click a row whose layer is empty | `selectionOps.ts:55,166,176` |
| Nothing to copy. | Copy or cut with nothing to copy | `clipboardOps.ts:67` (`:139,:157`) |
| Paste is larger than the paint area -- placed in Free Transform. Commit to crop, Esc to cancel. | Oversized paste or drop | `clipboardOps.ts:70` (`:210,:243`) |
| Nothing to paste. | Ctrl+V found no source | `ui/clipboardActions.ts:45,222` |
| The clipboard has no image -- nothing to paste. | Paste button, system mode, empty | `:51,157` |
| Clipspace has no image -- nothing to paste. | Paste button, clipspace mode, empty | `:48,230` |
| The dropped item is not an image. | Drop that isn't an image | `ui/dropImport.ts:37` (`:103,110,113`) |
| Could not load the image. | Images-panel thumbnail failed to decode | `ui/sourceInsertAction.ts:20,48` |
| Image reduced to W x H px (max 8192 px per side). | Source larger than 8192 px per side | `sourceInsertAction.ts:65` |
| Font 'X' isn't installed; editing will use a fallback. | Text edit with a missing font | `engine/textOps.ts:37,232` |
| All 6 region slots are used. Delete a region to draw another. | Drawing a seventh region | `tools/region.ts:31,92` |

The editor blocks (locked, hidden, solo, Image Mask) are the shared `editBlockNote` gate in `engine/rasterize.ts:69`. Its order is Image Mask, then hidden (eye), then solo, then lmask-tool, then locked.

## B4. Other user-visible fixed text (not notes or toasts)

| Text | Where | file:line |
|---|---|---|
| Run the workflow to load this mask | Hint under the Input Mask row while it waits for a run | `ui/imageMaskRow.ts:43` |
| Drawing grid W px — image W px (N.Nx) + button "Match image resolution" | Options bar resolution notice | `ui/resolutionNotice.ts:87,65` |
| Editing in fullscreen — press Esc or click to return | Node placeholder while fullscreen | `ui/fullscreen.ts:32` |
| Exit fullscreen | Overlay button label | `fullscreen.ts:173` |
| Drag on the image to add a region; Shift-drag starts a new one inside another. | Outputs tab hint | `ui/outputsPanel.ts:59` |
| Loading file counts… / Could not load file counts: … / Files: N (X) · Older than 24 h: N (X) / Cleaning up… | Cleanup settings row | `cleanupSetting.ts:56,67,96,109` |
| W x H | Stage size label | `ui/resolutionLabel.ts:28` |
| `<name>` can't be deleted (it follows the mask input / the image's transparency); Delete mask; The last mask can't be deleted (clear it instead) | Footer Delete tooltip (as tooltip) | `ui/imageMaskRow.ts:88` |

---

# C. Tooltips (`title`)

Tooltips show only on hover. The shortcut hint is part of the text where it exists.

**Rail** (`ui/toolRail.ts`, `toolGroupSlot.ts`, `pasteButton.ts`, `imagesPanel.ts`)

| Control | Tooltip |
|---|---|
| Brush | Brush (B) |
| Eraser | Eraser (E) |
| Paint bucket | Paint bucket (G) |
| Eyedropper | Eyedropper (I) |
| Shape group (Line, Arrow, Rectangle, Ellipse) | Shape (U, Shift+U cycles) |
| Text | Text (T) |
| Move layer | Move layer (V) |
| Marquee group (Rectangular, Elliptical) | Marquee (M, Shift+M cycles) |
| Lasso | Lasso (L) |
| Magic wand | Magic wand (W) |
| Quick Mask | Quick Mask (Q) |
| Copy | Copy (Ctrl+C; Ctrl+Shift+C copies merged) |
| Cut | Cut (Ctrl+X) |
| Paste (system) | Paste as new layer from the system clipboard (else our copy, else clipspace), Ctrl+V. Ctrl+Shift+V pastes our copy in place. Hold for sources |
| Paste (clipspace) | Paste as new layer from the ComfyUI clipspace. Ctrl+Shift+V pastes our copy in place. Hold for sources |
| Images | Images from the layer_source input (insert as a new layer) |
| Undo / Redo | Undo (Ctrl+Z) / Redo (Ctrl+Shift+Z) |
| Fit | Fit to view (Ctrl+0) |
| Clear | Clear canvas |
| Fullscreen | Fullscreen (F) / Exit fullscreen (F / Esc) |
| Swatches (colour) | Foreground color (X swaps) / Background color (X swaps) / Swap colors (X) / Default colors (D) |
| Swatches (lmask) | Layer mask foreground: white hides, black reveals (X swaps) / Layer mask background (X swaps) / Swap mask black / white (X) / Default mask swatches: white / black (D) |

- Move drawing (rail:false) and the region tool have no rail button.
- Group fly-out items have no `title`. They show label + key text.
- The paste menu items show "System clipboard" and "Clipspace".
- The images list items have the tooltip "<name or Newest> -- click to insert as a new layer", else "Click to insert as a new layer" (`imagesPanel.ts:180`).

**Options bar / shell**

| Control | Tooltip | file:line |
|---|---|---|
| Outputs button | Output regions (O) | `shell.ts:113` |
| Panel toggle | Hide side panel / Show side panel (no shortcut) | `shell.ts:183` |
| Mask badge | Quick Mask: strokes paint the mask (Q to exit) | `optionsBar.ts:47` |
| To mask | Selection to mask: add the selection to the mask | `selectionActions.ts:28` |
| Invert | Invert selection (Ctrl+Shift+I) | `:35` |
| Match image resolution | Resample all layers to the current image resolution (clears undo history) | `resolutionNotice.ts:66` |
| Fullscreen overlay button | Exit fullscreen (Esc) | `fullscreen.ts:170` |
| Colour picker preview | Click left half to revert to original colour / Click to revert to original colour | `colorPicker.ts:112,198` |
| Recent colour | `#RRGGBB` | `recentColors.ts:65` |

**Outputs tab** (`outputCard.ts`, `outputOptionsRow.ts`, `outputField.ts`, `outputsPanel.ts`)

| Control | Tooltip |
|---|---|
| `+ Region N` | Add a centred region in slot N |
| Eye | Hide outline (output unaffected) / Show outline |
| Title | N · name -- output pair N (double-click to rename) |
| Trash | Delete region (empties the slot) |
| X / Y / W / H | Left edge (image px) / Top edge (image px) / Width (image px) / Height (image px); label adds ": drag to scrub (Shift = x10), Esc reverts" |
| Main size | Output size (current image px) |
| Modify select | Modify this output |
| Fill / border swatch | Fill colour (output only) / Border colour (output only); picker titles "Fill colour" / "Border colour" |
| Pad | Crop padding (output px) |
| Border W | Border width per side (output px, 1..4096) |
| Mask border | Border area white in the MASK (for outpainting) |
| Alpha | Output the image with the mask as transparency (RGBA). Some nodes use RGB only and drop it. |

**Layers panel (for completeness)**

| Control | Tooltip |
|---|---|
| Opacity | Opacity of the selected layer (drag the label to scrub) |
| Mask overlay | Mask overlay opacity (display only) |
| Footer | New layer (above the active layer) / New mask (above the current mask) or "At most 7 masks" / Duplicate layer / Merge Down (Ctrl+E) / Delete layer (Delete mask, Delete states per `deleteTitle`) / Move drawing — reposition/scale all layers against the image |
| Row | `<name> (double-click to rename)`; Input image (Background) |
| Eye | Hide layer / Show layer; Hide mask (also excludes it from the MASK output) / Show mask (hidden masks are excluded from the MASK output); Hide background (shows transparency; outputs use the background colour instead of the image) / Show background (input image) |
| Solo | Solo: show only this layer in its group (view only); Solo the background: hide all paint layers (view only); End solo (view only) |
| Lock | Lock layer (refuses painting) / Unlock layer; The background (input image) is locked; The Image Mask can't be edited (duplicate it to edit) |
| Mask row | Current mask (Quick Mask paints into it); Mask colour (display only); Invert mask / Mask inverted (click to un-invert) |
| Image Mask / Input Mask name | From the image's transparency. A connected mask input will replace it. / From the connected mask input (it replaces the image's transparency; disconnect it to use that again). |
| Text badge | Text layer (click it with the Text tool to edit) |
| lmask add | Add layer mask (reveals all, or shows only the selection; Alt+click hides all) |
| lmask thumb | Layer mask: click to edit it; Shift+click off/on; Alt+click view it alone; Ctrl+click select its shown (black) part (+Shift add, +Alt subtract) |

**Tool option tooltips** (descriptors):
- Brush and eraser:
  - Brush size ([ / ])
  - Hardness (Shift+[ / ])
  - Opacity (1..9, 0)
  - Flow (per-dab strength)
  - Spacing (% of diameter)
  - Pen pressure (group); Pen pressure controls size / controls opacity
  - Size at zero pressure (% of size)
  - Pressure curve (1 = linear, > 1 = softer start)
- Bucket and wand:
  - Tolerance (0-255 per channel)
  - Only fill / select connected pixels
  - Soften the fill / selection edge
  - Pixels the fill / wand looks at
- Eyedropper: Pixels to pick from; Sample size.
- Shapes: Line / stroke width; "Stroke (FG), fill (FG), or both (stroke FG, fill BG)"; Arrowheads; Arrowhead length (% of width).
- Text:
  - Font family (recent fonts first; Custom font… types any installed font)
  - Font size in image px ([ / ])
  - Bold
  - Italic
  - Alignment to the click point
- Move drawing:
  - Horizontal offset (image px; arrows nudge)
  - Vertical offset (image px; arrows nudge)
  - Drawing scale (wheel while dragging)
  - Put the drawing back where it was painted
- Move layer: Pick the layer under the pointer (hold Ctrl for a one-off pick).
- Free Transform:
  - Box centre, image px (arrows nudge)
  - Width scale / Height scale
  - Keep proportions (Shift while dragging a handle inverts)
  - Rotation, degrees (Shift while rotating = 15 deg steps)
  - Commit transform (Enter) / Cancel transform (Esc)
  - Transform (Ctrl+Alt+T)
- Layer Mask bar:
  - Strokes edit the layer mask (white hides, black reveals)
  - Invert the layer mask (a setting; pixels are kept)
  - Apply the layer mask: bake it into the layer's pixels and remove it (undoable)
  - Delete the layer mask (undoable)

Not documented by any tooltip: Ctrl+1 (100%), Ctrl +/- zoom, Space/middle-drag pan, Shift-drag new region, Ctrl+Y.

---

# D. Shortcuts found

**View, window, outputs** (`ui/shortcuts.ts` unless noted; all only while the editor owns the keyboard):

| Keys | Context | Action | file:line |
|---|---|---|---|
| Ctrl+0 | any | Fit (sticky) | `shortcuts.ts:82` |
| Ctrl+1 | any | 100%, centred | `:83` |
| Ctrl+= / Ctrl++ | any | Zoom ×1.25 about stage centre | `:84` |
| Ctrl+- / Ctrl+_ | any | Zoom ×0.8 | `:85` |
| Wheel | stage | Zoom about cursor (tool gets it during a drag with `onWheel`) | `stageInput.ts:97-109` |
| Middle-drag | stage | Pan | `stageInput.ts:176`; `eventIsolation.ts:104` |
| Space + left-drag | stage | Pan (Space ignored with Ctrl/Meta/Alt or in text fields) | `keyboard.ts:345`; `stageInput.ts:176` |
| F | any | Toggle fullscreen | `shortcuts.ts:133` |
| O | any | Toggle Outputs tab / region mode | `:136`; `hostSync.ts:219` |
| Esc | chain | Images panel, float or transform, tool drag, popover, fullscreen | `imagesPanel.ts:107`; `floatShortcuts.ts:52`; `shortcuts.ts:70-72` |
| Esc / Enter | field of an output card or rename | Revert / commit and blur | `outputField.ts:113`; `inlineRename.ts:31` |
| Esc | open popover | Close (revert output picker) | `popover.ts:109` |
| Shift-drag | region mode | New region | `tools/region.ts:124` |
| Click empty / Shift+click | region mode | Select Main | `region.ts:140` |
| Ctrl+S | editor owns target | Flush uploads, then `Comfy.SaveWorkflow` | `keyboard.ts:330`; `saveKey.ts:17` |
| F5 / Ctrl+R / Ctrl+Shift+R | page-wide when uploads are pending | Flush (3 s cap), confirm on failure, reload | `widget/pageGuards.ts:58`; `reloadGuard.ts:18` |
| Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | any | Undo / redo | `shortcuts.ts:80-81` |
| Q / X / D | any | Quick Mask / swap / reset swatches (lmask swatches when targeted) | `:121-132` |
| `[` `]` / Shift+`[` `]` | tools with size/hardness | Size / hardness | `:93-101` |
| 1..9, 0 | tools with opacity | Opacity 10..90 %, 100 % | `:103-109` |
| Tool key (B E G I U T V M L W) | any | Select the tool (groups pick last used) | `:141`; `registry.ts:102` |
| Shift+U / Shift+M | any | Cycle the group | `:111-118` |
| Ctrl+E, Ctrl+Alt+T | any | Merge Down; Free Transform | `floatShortcuts.ts:35,42` |
| Enter | float or transform | Commit | `floatShortcuts.ts:57` |
| Ctrl+A / D / Shift+F7 / Ctrl+Shift+I; Delete / Backspace; Alt+Backspace / Ctrl+Backspace | any | Selection commands | `selectionShortcuts.ts:32-47` |
| Ctrl+C / Ctrl+Shift+C / Ctrl+X / Ctrl+V / Ctrl+Shift+V | any | Clipboard | `clipboardShortcuts.ts:36-58` |
| Alt held | any | Prevented (no Windows menu bar); temporary eyedropper | `keyboard.ts:337` |

**Fullscreen pass-through list** (`ui/fullscreenKeys.ts:53`). This applies only to keys the editor did *not* handle. Everything else is `preventDefault` + `stopPropagation`, both from the window listener (`keyboard.ts:352`) and from the root keydown listener, which covers keys from our own text fields (`:86-88`).
- Bare modifiers: Control, Shift, Alt, AltGraph, Meta, OS.
- F1..F24.
- Alt+ArrowLeft and Alt+ArrowRight (without Ctrl/Meta).
- Ctrl/Cmd (not with Alt): R, W, T, N, L, Tab, PageUp, PageDown (Shift optional); S and Enter (Shift optional); V (Shift optional, so the `paste` event fires).
- Ctrl/Cmd+Shift: I, J, C.

---

# E. Mismatches (old SPEC vs code)

| Old SPEC says | Code does | file:line | My read |
|---|---|---|---|
| Canvas/view: brush ring at the tip's 50% boundary (0.55 × size at hardness 0, full size at 100%). | Ring = `size × min(1, core + fade × 0.77)` (the tip's ~25 % point; PS-measured). | `engine/brush.ts:254,267` | Old text is stale; the 2026-09-26 decision log says 0.77. Use code. |
| Canvas/view: image frame outline "when paint extends beyond it". | The image outline is always drawn (faint shadow, or a stronger outline plus veil when paint extends past it). | `engine/compositor.ts:179-197` | Spec was incomplete. Document both states. |
| View shortcuts: "`Esc` closes an open popover / rename first, then exits fullscreen." | Chain: Images panel → float/transform → tool drag or pending → popover → fullscreen. Rename is a text field that handles its own Esc (not part of the chain). | `shortcuts.ts:69-72`; `imagesPanel.ts:107` | Intended. Rewrite the sentence. |
| M9: "A rail button next to the side-panel toggle (top)". | The Outputs button is in the options bar's trailing area, not on the rail. | `shell.ts:118` | Wording only. The later bullet ("options bar, top right") is right. |
| M9: "O / the button again returns to Layers and the last tool." | True only when the panel is open. With the panel collapsed in region mode, O reopens it on Outputs. | `hostSync.ts:224-230` | Probably intended, but undocumented. |
| M9: Outputs tab contents. | A permanent hint line under the cards. It isn't in the spec. | `outputsPanel.ts:59` | Add it to the spec. |
| Behavior Notes and M2 log: note "The mask is hidden; show it to output it." | Text is "The mask is hidden." | `editorTypes.ts:222` | Old text is stale; the 2026-09-28 decision log already says "shortened". |
| Settings: cleanup confirm "N files (X MB) in `input/painter-sketch/` are not used by any saved workflow, open workflow or unsaved draft, and are older than 24 hours. Delete them? This affects all workflows." | "N of the M file(s) older than 24 h (X) are unused and will be deleted. This affects all workflows." plus an optional unscanned-workflows warning. | `cleanup/references.ts:138-148` | Spec text outdated. Use code. |
| M10: oversized paste "cropped + toast". | A stage note, and the paste opens in Free Transform ("Paste is larger than the paint area -- placed in Free Transform. Commit to crop, Esc to cancel."). | `clipboardOps.ts:70` | Old M10 bullet superseded by the 2026-09-27 decision. |
| M10 log: "CORS failure toast". | `DRAG_BLOCKED_TEXT` is a toast (key `drag-image-blocked`); a non-image drop is a stage note. | `dropImport.ts:34,37` | Matches. Messages list is the reference. |
| M3 log: fullscreen swallows keys except "F1-F24, Ctrl+R/W/T/N/L/Tab/PgUp/PgDn, devtools, Alt+arrows, Ctrl+S, Ctrl+Enter". | Also passes Ctrl+Shift+S, Ctrl+Shift+Enter and Ctrl+V (+Shift). Plain Ctrl+S never reaches the policy (the scope intercepts it first). | `fullscreenKeys.ts:36-66` | The pass list in D is complete. |
| (not in spec) Ctrl+Shift+I and Ctrl+Shift+C listed as devtools pass-through. | The editor handles them first (invert selection, copy merged), including in fullscreen. So devtools never open via those chords while the editor owns the keyboard. | `selectionShortcuts.ts:44`; `clipboardShortcuts.ts:52`; `fullscreenKeys.ts:39` | Likely intended (the 2026-09-24 log says "editor-scoped"). The pass list entry is dead for those two. |
| Side panel width: stale comment says ~180 px. | CSS is 216 px. | `sidePanel.ts:2` vs `editor.css:11` | Stale code comment; spec (216) is right. |
| Region docs: "3x paint area". | Region area is `3W × 3H` from `(-W, -H)`, independent of the paint-area cap. | `regions.ts:6`; `regionGeometry.ts:99` | The comment in `regions.ts:7` ("the 3x paint area") reads misleadingly. |
| AGENTS: "Esc… 60 s for upload problems". | Matches (`UPLOAD_TOAST_WINDOW_MS`). Only `upload-failed` and `upload-recovered` get 60 s; every other notify defaults to 10 s. | `persistence.ts:57` | Fine. State the rule explicitly. |
| Toast API: `resetNotifyKey` documented as available. | Defined but never called. Upload recovery does not reset the failure key. | `toast.ts:57` | Dead code, or a recovery gap. Decide before the rewrite. |
| Long-press: one "400 ms" mentioned nowhere. | Two independent constants (tool-group slot and paste button), both 400 ms. | `toolGroupSlot.ts:15`; `pasteButton.ts:23` | To shorten the delay later, change both, or share one constant. |
| Zoom/pan limits not in the old spec. | Zoom 0.02 to 64, fit padding 8 px, pan grip `min(64, on-screen)`, wheel factor `exp(-Δ×0.0015)` with Δ clamped ±300. | `viewport.ts:32-33,76,122-125,163` | Add to the spec. |
| Shortcut docs: 100% (Ctrl+1) and zoom +/- have no button or tooltip. | Only Fit has a button. | `toolRail.ts:93` | Note for the UI refresh and the help overlay. |
| Redo tooltip "Ctrl+Shift+Z". | Ctrl+Y also works. | `shortcuts.ts:81` | Minor; spec should list both. |
| M9 `Region` labels: "region N (missing)". | Matches. Filled slots with the default name show `Region N` (capital R), empty slots show `region N (missing)` (lower case). | `regionLabels.ts:34,36`; `regions.ts:70` | Cosmetic inconsistency; confirm it is intended. |