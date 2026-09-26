# SPEC.md

Living spec: goals, scope, decisions, milestones, progress. Update this as work
lands. Stable rules and conventions live in [`AGENTS.md`](AGENTS.md).

Status legend: `[ ]` not started, `[~]` in progress, `[x]` done.

## Goal

A ComfyUI node that takes an `IMAGE`, lets you paint on it and draw masks
**inside the node**, and outputs `IMAGE` + `MASK`. A fullscreen button opens the
same editor bigger. LiteGraph renderer is the primary target; Nodes 2.0 must
work too. Where Photoshop has an established behavior or shortcut, follow it.

Visual targets: the "PaintPro" screenshot (tool rail inside the node, canvas
filling it, `image` in, `IMAGE`/`MASK` out) combined with Comfy Canvas's
left rail + top options bar + layers panel, minus the prompt dock and output pane.

## Node Contract

Node ID and display name: `PainterSketch`. Extension: `phazei.PainterSketch`.
Category: `image`.

| | Name | Type | Notes |
|---|---|---|---|
| in | `image` | IMAGE, optional | Background. Batch in, batch out |
| in | `width`, `height`, `background` | widgets | Only used when `image` is not connected. `width`/`height` 64-8192, step 8, default 1024; `background` default `#ffffff` |
| in | `invert_mask` | BOOLEAN widget | Inverts the `MASK` output |
| in | `document` | STRING widget, hidden | Versioned layer manifest (see Persistence). Not a socket |
| out | `IMAGE` | IMAGE `[B,H,W,3]` | Each input image with visible paint layers composited on top |
| out | `MASK` | MASK `[B,H,W]` | Union of visible mask layers (white = masked), optionally inverted. Zeros if nothing drawn |

- Output resolution = input image resolution (the "image frame", see below).
- The same paint and mask apply to every image in the batch (broadcast).
- `fingerprint_inputs` hashes the saved files + `invert_mask`; the input tensor is
  handled by ComfyUI's normal caching.
- Returns `ui=UI.PreviewImage(image[0])` so the editor has the background after
  the first run, even when the upstream node shows no preview.

## Key Design Decisions

Recorded so they can be revisited deliberately. Each lists what we rejected.

1. **Edit in the node, fullscreen re-parents the same editor.** One editor
   instance; fullscreen moves its root element into a fixed overlay and back.
   *Rejected:* ComfySketch's preview + separate fullscreen instance.
2. **The input image is a live, locked background layer, never saved.** It
   always shows whatever the upstream currently provides -- no "load from input"
   button needed, because nothing is ever baked into it. Only paint layers and
   masks are saved; Python composites them over whatever arrives at run time, so
   you can re-roll the upstream image and keep your paint.
   *Rejected:* baking the base into the saved result (both references).
3. **Image frame vs. paint area.** Layers can hold paint outside the image
   (the document is larger than the frame when needed). The main output is always
   cropped to the image frame, so `IMAGE`/`MASK` stay pixel-aligned with the
   input -- important for inpainting. Off-frame paint is kept, just not output.
   *Deferred:* output regions (see Future: Output Regions). The data model
   reserves `regions: []` so they can be added without a migration.
4. **Upstream size change = scale to fit, non-destructively.** Layer pixels stay
   in the document's own `frame` coordinates (the size the paint was started on)
   and are **never resampled** when the upstream size changes. Both the editor
   and Python map document -> current image with the same transform:
   `s = min(W/fw, H/fh)`, centered (contain). Same aspect -> exact fit. The editor
   draws layers through this transform, and maps pointer input back through its
   inverse, so strokes made on a differently sized image land in document
   coordinates. Flipping between image sizes is lossless and creates no undo
   entries. **Clear** (confirm, undoable) resets the document to the current
   image size.
   *Rejected (M1 first cut):* resampling layers on each size change -- repeated
   A->B->A with different aspects shrank the paint (product of the two `min`
   factors < 1) and blurred it.
5. **Masks are layers.** Layer `kind` is `"paint" | "text" | "mask"`. v1 creates a
   single mask layer by default and the UI may limit it to one, but the document,
   compositor and Python all handle N mask layers. Each mask layer stores its own
   display `color` (default red), `opacity` (default 50%) and `invert` (default
   false). Combine: apply each layer's own `invert`, then union (max, i.e.
   additive and clamped), then the node's `invert_mask` inverts the final result.
   Multiple masks later needs no data change.
   *Rejected:* mask derived from paint alpha (can't paint and mask separately).
6. **Quick Mask style editing.** `Q` toggles the paint target between the active
   paint layer and the active mask layer, like Photoshop's Quick Mask. Brush,
   eraser, fill, shapes and "fill selection" all work on the mask when targeted.
7. **Selection is a pixel coverage mask** (`Uint8Array`, 0-255), not a Path2D.
   Magic wand produces pixels anyway, and a pixel mask allows feathering later.
   The marching-ants outline is computed once per selection change and cached.
   *Rejected:* ComfySketch Path2D clip (can't represent magic-wand results),
   Comfy Canvas per-frame edge scan (slow).
8. **Persistence = upload PNGs to `input/painter-sketch/` on `serializeValue`**
   (only when dirty); the widget stores a JSON manifest referencing them.
   *Rejected:* base64/JPEG in the workflow (ComfySketch), session routes (Comfy Canvas).
9. **Canvas 2D, one offscreen canvas per layer, no PIXI.**
10. **Undo = per-operation dirty-rect patches**, memory-capped, synchronous.
    *Rejected:* full-document snapshots (both references).
11. **Blend modes: Normal only in v1**, so the Python composite always matches the
    screen. Layer data carries `blendMode` so more can be added later.
12. **Text stays editable** (`textData` on a text layer, `<textarea>` overlay
    while editing), rasterized into the layer PNG on save so Python never renders text.
13. **TypeScript, no UI framework**, Vite single-file bundle into `js/`.

## Document Model (v1 sketch)

```ts
interface PainterDocument {
  version: 1
  docId: string                                     // stable frontend identity (live-session key); Python ignores it
  frame: { width: number; height: number }         // image frame the paint was made on
  bounds: { x: number; y: number; width: number; height: number } // paint area, frame coords
  regions: Region[]                                 // reserved, always [] in v1 (decision 3)
  placement?: { x: number; y: number; scale: number } // Move tool; default identity
  mainOutput?: OutputOptions                        // M9; default applyMask 'none'
  activeLayerId: string
  layers: Layer[]                                   // bottom -> top, background excluded
}
interface Layer {
  id: string; name: string
  kind: 'paint' | 'text' | 'mask'
  visible: boolean; locked: boolean; opacity: number
  blendMode: 'normal'
  file: string | null                               // "painter-sketch/xyz.webp [input]"
  color?: string                                    // mask display color
  invert?: boolean                                  // mask layers, default false
  textData?: TextData                               // text layers: {text, x, y, font, size, color, bold, italic, align, lineHeight?}, doc px; (x,y) = first-line baseline at its left/centre/right edge per align
}
interface Region {                                  // M9 Output Regions
  id: string
  slot: number                                      // 1..6, stable: = output pair number, never renumbered
  name: string                                      // user label shown on the output dots ("" = "region N")
  rect: { x: number; y: number; width: number; height: number } // IMAGE px (not doc px): fixed to the image
  visible: boolean                                  // overlay display only; outputs always produced
  output: OutputOptions
}
interface OutputOptions {                           // per region, and doc-level `mainOutput` for IMAGE/MASK
  applyMask: 'none' | 'fill' | 'crop'               // fill = paint masked area with `fillColor`; crop = trim to mask bbox
  fillColor: string                                 // '#rrggbb'
  cropPadding: number                               // px around the mask bbox for 'crop'
}
```

### Saved-file contract (frontend writes, Python reads)

- **Widget value** = `JSON.stringify(PainterDocument)`, or `""` for an empty document.
- **Coordinates:** everything is in *frame* pixels. `bounds` is the paint area and
  may extend past the frame (negative `x`/`y`, larger size) but always contains
  it. Initially `bounds = {x:0, y:0, width:frame.width, height:frame.height}`;
  it grows in 256 px chunks while painting off-frame, capped at 3x the frame per
  axis and 16384 px.
- **Layer image:** RGBA, exactly `bounds.width x bounds.height`; pixel `(px,py)`
  sits at frame coords `(bounds.x+px, bounds.y+py)`. Straight (non-premultiplied)
  alpha. `file: null` = empty layer.
- **Format:** Mask layers are always **PNG** (lossless). Paint layers use the
  setting `PainterSketch.PaintQuality` (50-100, default **99**): below 100 = lossy
  WebP at that quality; 100 = PNG. (Measured: Chrome's canvas lossless WebP was
  ~2x the PNG size, while lossy 99% was ~1/3 of the PNG with no visible
  difference.) If the browser can't encode WebP, PNG. Python reads any format PIL
  supports.
- **File names:** `painter-sketch/ps-<docId8>-<hash>.<webp|png>`, stored in the
  widget as `"painter-sketch/ps-<docId8>-<hash>.webp [input]"`. The hash is of the
  content, so edits produce new names and unchanged layers are not re-uploaded. A
  fully erased layer saves as `file: null`.
- **Upload timing:** `serializeValue` only runs at queue time (inside
  `graphToPrompt`); save/export/tab switch read `widget.value`. The widget value
  (layer metadata) updates after every edit; dirty layers upload when the editor
  **loses focus/engagement**, after **~5 s idle**, at **queue** (`serializeValue`
  flushes), and on **Ctrl+S** while the editor has focus (we intercept, flush,
  then run `Comfy.SaveWorkflow` so the saved workflow has the latest files; if
  the upload fails, a confirm asks "Upload failed; save anyway without the latest
  paint?"; Ctrl+Shift+S is not intercepted). Also on fullscreen exit and session
  detach (tab switch / node removal).
  Also: F5 / Ctrl+R / Ctrl+Shift+R (any time uploads are pending) are intercepted, flushed (3 s cap), then reloaded; flush on tab hidden / window blur. No `beforeunload` prompt of our own (ComfyUI already asks).
  File references change only after a successful upload. A failed upload toasts
  and blocks the queue (same as core Painter); pixels stay in memory, still dirty.
- **Cleanup:** files accumulate by design (older workflow versions and graph undo
  may reference them). A settings button runs a two-step cleanup (see Settings).
- **Paint layers** (`kind: "paint"`, later `"text"`): composited bottom -> top,
  Normal blend, straight-alpha "over", multiplied by layer `opacity`. Hidden
  (`visible: false`) layers are skipped.
- **Mask layers** (`kind: "mask"`): mask value = image **alpha** (RGB ignored).
  `opacity` and `color` are display-only and do NOT affect `MASK`. Per-layer
  `invert`, then union (max) of visible mask layers, then node `invert_mask`.
- **No image:** the run-time image is `width` x `height` filled with `background`.
- **Placement** (Move tool): optional `placement: {x, y, scale}` on the document,
  default / missing = `{x:0, y:0, scale:1}`; `scale` clamped to [0.05, 20]. In
  document-frame px, scaling about the frame centre `c = (fw/2, fh/2)`: a document
  point `p` is placed at `p' = (p - c) * scale + c + (x, y)`, then the frame map
  below maps `p'` to the image. Combined, layer pixels land at
  `image = offset + s * (c * (1 - scale) + (x, y)) + s * scale * p`, i.e. effective
  scale `s * scale`. Python and the editor use this one formula (with the same
  rounding as below). Placement never resamples stored pixels.
- **Frame mismatch:** if the run-time image is `W x H` and `frame` is `fw x fh`,
  apply decision 4: `s = min(W/fw, H/fh)`, offset `((W-fw*s)/2, (H-fh*s)/2)`;
  each layer is scaled by `s` (bilinear) and placed at
  `offset + bounds.xy * s` (Python `round()`, halves to even; size
  `max(1, round(wh*s))` -- the frontend's `layerPlacement()` reproduces this),
  then cropped to `W x H`. The frontend uses the same
  transform for display (never resampling the stored pixels), so preview and
  output agree.
- **Unknown `version`** or unreadable manifest: log a warning, output the image
  unchanged and a zero mask. The editor keeps the raw value as the widget value
  (never overwrites it with `""`) until the user paints, and toasts once.
- **Missing / unreadable layer file:** Python warns and treats it as empty. The
  editor loads the layer empty but keeps its `file` reference until that layer is
  edited (a restored file loads again next time); text layers re-render from
  `textData` and re-upload. One toast per document.
- **Wrong-size layer file** (only documents saved before the bounds re-upload
  fix): placed unscaled at the top-left, cropped / padded with transparency, in
  both the editor and Python (no stretching), so output matches the screen.
- **Upload failures:** paint stays in memory and dirty; automatic retry after
  15 s, doubling up to 2 min; at most one toast per outage per minute, and one
  "Paint layers saved again." on recovery.

## Feature Scope (v1)

### Canvas / view
- Fit to node by default; zoom (wheel over canvas, Ctrl +/-), pan (Space-drag,
  middle-drag), fit (Ctrl+0), 100% (Ctrl+1)
- Fullscreen toggle button (`F`; Esc exits)
- Brush ring cursor at the tip's 50% boundary (Photoshop's "Normal Brush Tip": 0.55 x size at hardness 0, the full size at 100%); image frame outline when paint extends beyond it
- **Undo / redo buttons** always visible in the toolbar, plus shortcuts

### Tools
| Tool | Key | Options / behavior |
|---|---|---|
| Brush | B | size, hardness, opacity, flow, spacing, color, pressure -> size / opacity toggles. **Click, then Shift+click draws a straight stroke from the last point** |
| Eraser | E | size, hardness, opacity, pressure, Shift+click straight line |
| Paint bucket | G | tolerance, contiguous, sample **background** (default) / current layer / all layers, anti-alias, opacity |
| Eyedropper | I | sample all layers (default) / current layer / background; point / 3x3 / 5x5. Alt+click = BG colour. **Alt held in brush/bucket/shape = eyedropper** |
| Rect marquee / Ellipse marquee | M (Shift+M cycles) | Shift = square/circle once started |
| Lasso | L | freehand; Alt-click adds polygon points |
| Magic wand | W | tolerance, contiguous, anti-alias, sample **background** (default) / current layer / all layers |
| Line / Arrow | U (Shift+U cycles shapes) | width, color, arrowhead none / end / both. Shift snaps to 15 deg |
| Rectangle / Ellipse | U (Shift+U) | stroke / fill / both, stroke width. Shift = square/circle |
| Text | T | font, size, color, bold/italic, alignment |
| Quick Mask target | Q | toggle painting on mask vs. paint layer |

### Selection (applies to all selection tools)
- Shift = add, Alt = subtract, Shift+Alt = intersect (Photoshop modifiers), fixed
  at pointer-down. With no selection, those keys act as constraints instead
  (square/circle, from centre, lasso straight segments).
- Ctrl+D deselect, Ctrl+Shift+I, Shift+F7 or the options-bar **Invert** button inverts (Ctrl+Shift+I only while the editor owns the keyboard), Ctrl+A select all = the current image area (in doc coords via the document map, so it ignores doc frame size and Move placement; bounds grow to cover it). An inverted selection also shows ants along the frame.
- Cursor badge next to the crosshair while a selection exists: + (Shift, add), − (Alt, subtract), × (Shift+Alt, intersect); fixed during a drag.
- Selection is editor session state (not saved); selection changes are undoable.
- Lasso: freehand drag; press Alt during the drag for straight segments; release
  the button with Alt held to keep clicking vertices; close by releasing Alt,
  double-click, or clicking near the start; Esc cancels.
- Painting, filling and erasing are clipped to the selection
- Delete / Backspace clears the selection on the target layer
- Alt+Backspace fill with foreground, Ctrl+Backspace fill with background
- "Selection to mask": with the mask targeted, fill does it; also a button

### Color
- Foreground / background swatches, X swaps, D resets to black/white
- Hex field, compact SV square + hue slider, a few recent colors
- FG/BG are editor session state (not saved in the document). Recent colors
  (max 10) persist in `localStorage["PainterSketch.recentColors"]`.
- Picker: live update while dragging; click outside commits; Esc reverts and closes.

### View / window shortcuts
- `F` toggles fullscreen; `Esc` closes an open popover / rename first, then exits fullscreen.

### Brush shortcuts
- `[` / `]` size, Shift+`[` / `]` hardness
- `1`..`9`, `0` set opacity 10%..90%, 100%

### Layers (panel collapsible in-node, open in fullscreen)
- Add, delete, duplicate, reorder (drag), rename (double-click), visibility,
  lock, opacity, thumbnails
- Background (input image) row at the bottom, locked, not deletable
- Mask layers shown with their color swatch
- Mask row at the top (v1: exactly one; not addable/deletable/movable): eye,
  color swatch (picker), invert, overlay opacity. Clicking the mask row turns
  Quick Mask on; clicking a paint row turns it off.
- New layer goes above the active paint layer, named "Layer N". The last paint
  layer can't be deleted. Painting on a locked layer shows "Layer is locked."
- Undoable: add, delete (keeps pixels), duplicate, reorder, rename, opacity, mask
  color/invert/opacity -- one scrub or picker session = one undo step.
  Visibility and lock are not undoable (Photoshop-like).
- Side panel auto-collapses below 520 px editor width; the user's toggle wins
  until the width crosses 520 again. Fullscreen opens it and restores on exit.

### Pressure
- Pointer Events `pressure` with `getCoalescedEvents()`
- Mouse/touch without pressure = full pressure
- Simple curve (min size %, gamma) in brush options; pressure -> size and
  pressure -> opacity toggles. Spacing is also a brush option.

### Settings (ComfyUI settings panel, category "PainterSketch")
- `PainterSketch.PaintQuality`: paint layer WebP quality, 50-100, default 99 (100 = PNG).
- Defaults group (apply to new documents / new editor sessions only):
  - `PainterSketch.DefaultMaskColor` (color, default `ff0000`) and
    `PainterSketch.DefaultMaskOpacity` (10-100 %, default 50): style of the first
    mask (M8's palette continues after it).
  - `PainterSketch.PressureSize` (on), `PainterSketch.PressureOpacity` (off),
    `PainterSketch.PressureMinSize` (0-100 %, default 10),
    `PainterSketch.PressureGamma` (0.2-5, default 1): initial brush/eraser
    pressure options; in-session changes win.
  - `PainterSketch.BucketSample` / `PainterSketch.WandSample` (combo:
    `background` / `layer` / `all`, default `background`): initial "Sample"
    option of the paint bucket / magic wand; in-session changes win.
- `PainterSketch.Cleanup`: **Clean up files** button. Step 1 (dry run) counts
  deletable files; a confirm explains "N files (X MB) in `input/painter-sketch/`
  are not used by any saved workflow, open workflow or unsaved draft, and are older
  than 24 hours. Delete them? This affects all workflows." Step 2 deletes.
  - Referenced = file name appears in any saved workflow JSON under every user's
    `workflows` folder, or in the references the frontend sends (all open
    workflow tabs + locally stored drafts).
  - Only `ps-*.{png,webp}` directly in `input/painter-sketch/`, mtime older than
    24 h. Never follows symlinks.
  - Also scanned: `<user>/subgraphs/**/*.json` (saved subgraph blueprints) and,
    client-side, graph-undo/redo history of open tabs. Other browsers' drafts
    can't be seen -- hence the 24 h age floor. Workflows that couldn't be scanned
    are reported in the confirm. A symlinked/junctioned `painter-sketch/` folder
    is refused.
  - This is the project's **one server route** (`POST /painter-sketch/cleanup`,
    body `{dryRun, referenced: string[]}`).

### Undo / Redo
- Buttons in the UI, and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y while the editor is active

## Not in v1 (maybe later)
Non-destructive per-layer transforms (cut: too complex -- use destructive Free
Transform, M11), feathering/refine edge, blend modes, brush presets beyond a
couple, layer masks (per-layer), smoothing/stabilizer, symmetry, PSD export,
per-image paint in a batch, transparent (RGBA) outputs (the `MASK` output
carries alpha; downstream "Join Image with Alpha" exists), per-region mask
picking (regions use all masks; could become a dropdown later), text boxes with
wrapping, type-mask text, searchable installed-font picker.

## Post-v1 features (before public release)

Planned order after M7a: M8 -> M9 -> M10 -> M11 -> M12, then M7b release polish.
Details per milestone are in the Milestones section.

### Output regions: implementation notes (M9)
- V3 has no concrete dynamic-output type (check core again first). Plan: declare
  the maximum in the schema -- `IMAGE`, `MASK`, then 6 pairs `IMAGE 1`/`MASK 1` ...
  `IMAGE 6`/`MASK 6` (14 outputs) -- and let the frontend show only the pairs in use.
- **Output links are positional.** Never `removeOutput` a middle slot: the next
  slot shifts into its index and ComfyUI would send the wrong region downstream.
  Region *n* always uses output pair *n* (stable, never renumbered; a new region
  takes the lowest free slot). The node shows pairs up to the highest slot in use;
  unused pairs below it stay but are greyed/labelled "(unused)" -- unless the
  M9 agent verifies a way to hide a slot *without removing it* in both renderers.
- Output labels come from region names (`face` / `face mask`; default
  `region N` / `region N mask`), set via the slot `label`, saved in the workflow.
  Nodes 2.0: re-splice `node.outputs` after label changes (AGENTS.md).
- Python: an unused slot returns a 1x1 black image / zero mask (or
  `ExecutionBlocker` if something is linked to an unused slot -- decide in M9).
  - Reference: rgthree Power Puter (`D:\AITools\rgthree-comfy`,
    `py/power_puter.py`, `src_web/comfyui/power_puter.ts`) does truly dynamic
    outputs, but via V1: `RETURN_TYPES = ByPassTypeTuple(("*",))` (a tuple that
    returns `"*"` for any out-of-range index, `py/utils.py:169`) so validation
    accepts any output index; the frontend adds/removes slots with
    `addOutput`/`removeOutput` driven by a widget value, and `execute` returns a
    tuple of that length. V3 builds `RETURN_TYPES` from the schema, so this does
    not carry over as-is; don't drop to V1 for it.
  - Its `stabilize()` shows a Nodes 2.0 gotcha worth reusing: after mutating
    output slots, re-splice `node.outputs` in place so the Vue renderer notices
    (see `AGENTS.md`).

## Milestones

### M0 -- Scaffold
- [x] Python package: `__init__.py` (`WEB_DIRECTORY`, `comfy_entrypoint`), `nodes/`, V3 node stub with the contract above (smoke-tested in the ComfyUI venv)
- [x] `ui/` Vite + TS project building one file into `js/`, CSS injection
- [x] DOM widget mounts in LiteGraph (primary) and Nodes 2.0, resizes with the node, stops pointer/wheel leaking to the graph (browser-verified)
- [x] Background from upstream preview lookup + our `ui` preview after execution; updates live when the upstream changes (browser-verified)

### M1 -- Paint end to end
- [x] Engine: document model v1, layer canvases, compositor, viewport (pan/zoom)
- [x] Tool interface; brush + eraser with stroke buffer, hardness, spacing, pressure, coalesced events, Shift+click line
- [x] Undo/redo (dirty-rect) with buttons
- [x] Persistence: upload on `serializeValue`, restore on load, survives tab switch + subgraph
- [x] Python composites layers over the batch -> `IMAGE`; fingerprinting
- [x] Size-change scale-to-fit (non-destructive mapping, browser-verified)

### M2 -- Mask
- [x] Mask layer kind, Quick Mask toggle, colored overlay display (browser-verified)
- [x] `MASK` output (union of mask layers) + `invert_mask` (browser-verified)

### M3 -- UI shell
- [x] Left tool rail, top options bar, color picker, layers panel (browser-verified)
- [x] Fullscreen re-parenting (browser-verified)
- [x] Clear button (confirm, undoable) (pulled into M1)
- [x] Keyboard shortcuts scoped to the active editor (browser-verified)

### M4 -- Tools
- [x] Paint bucket (typed-array flood fill), eyedropper (+ Alt) (browser-verified)
- [x] Line + arrow, rectangle, ellipse (browser-verified)

### M5 -- Move + Selection
- [x] **Move drawing** (layers-panel footer toggle, no shortcut; `V` is reserved for a future element Move tool): reposition/scale the whole drawing (all layers + masks) relative to the image, to realign paint to a similar but offset image (browser-verified)
  - Drag = move; **scroll while dragging = scale** around the cursor (scroll without dragging still zooms the view); arrows nudge 1 px, Shift+arrows 10 px; Esc cancels the current drag; "Reset position" button. No rotation.
  - Non-destructive: stored as document `placement: {x, y, scale}` (frame px, identity default), applied after the frame map by both the editor and Python; pixels are never resampled. Contract: see "Placement" in the saved-file contract. X/Y are shown in image px, stored in doc-frame px.
  - Placement is relative to the current image -- with no image connected, that's the `width` x `height` background, so Move works the same.
  - Undo: placement is **not undoable** and stays out of the paint history; Ctrl+Z/Y always undo paint only (also while the Move tool is active). Recovery = Esc during a drag, drag it back, or "Reset position". Paint patches are in document coords, so they stay valid under any placement.
- [x] Coverage-mask selection engine, cached marching ants, add/subtract/intersect (browser-verified)
- [x] Rect / ellipse marquee, lasso, magic wand (browser-verified)
- [x] Clip painting to selection, fill/clear selection, selection to mask (browser-verified)

### M6 -- Move tool + Text
- [x] **M6a Move tool (`V`, "Move layer")** (browser-verified) -- moves the *active layer's content* (not the whole drawing; that's "Move drawing").
  - Paint layers: translate pixels by whole doc px; bounds grow so nothing is clipped; one drag = one undo entry (exactly reversible). Mask layer: same (moves the mask). Arrows nudge 1 image px, Shift+arrows 10; Esc cancels the drag. Locked layer -> note.
  - Text layers: changes `textData` position and re-renders (lossless).
  - No saved-file contract change: moved layers are just re-uploaded; text is rasterized at its new position.
  - Ctrl held with any other rail tool (not Text) = temporary Move layer; Ctrl+click/drag auto-selects the topmost visible, unlocked paint/text layer with pixels under the cursor (Quick Mask turns off). Move tool option **Auto-select** (default off) does this without Ctrl. Nothing hit = nothing moves.
  - Later (not M6): move only the selection's contents (cut/copy-move).
- [x] **M6b Text tool (`T`)** (browser-verified) -- point text only (Enter = new line, grows as you type; no wrapping boxes in v1).
  - Click empty canvas = new text layer (named after its first words) with an in-canvas `<textarea>` editor; click/double-click existing text = re-edit; Ctrl+drag with the text tool moves the text; Esc / click away commits; empty text on commit = layer removed.
  - Options: font, size (image px), color (FG), bold, italic, alignment (left/center/right).
  - Fonts: short curated list of widely available fonts + free-typed font name + recent fonts (localStorage). Missing font on re-edit shows a note ("Font 'X' isn't installed; editing will use a fallback"). Output never depends on fonts (rasterized pixels).
  - `textData` saved in the layer (small); the layer image is also uploaded so Python never renders text.
  - Painting/erasing/filling/shapes on a text layer asks "Rasterize text layer? It will no longer be editable as text." -- OK converts to a paint layer (part of the same undo step), Cancel aborts.
  - Text tool while Quick Mask is on: switch the target back to paint and create a normal text layer (type-mask is out of scope).

### M7a -- Code health + warts (do first)
- [x] Split `controller.ts` (596 -> 349), `colorPicker.ts` (421 -> 256), `editor.ts` (399 -> 272, via `editorBase.ts`); `keyboard.ts` (390) left as is
- [x] Error toasts: audit every failure path (upload, restore/missing files, cleanup route, bad manifest) for a clear, non-spammy toast (browser-verified)
- [x] Settings: default mask color, default pressure curve (+ existing PaintQuality / Cleanup) (browser-verified; + bucket/wand sample defaults)
- [x] Known warts to fix or accept:
  - FIXED: Esc in the mask color picker left an empty undo step (any gesture that ends where it started now leaves no step)
  - FIXED: `fullscreenKeys.ts` no longer blocks bare modifier keydowns (bare Alt keeps preventDefault in `keyboard.ts` to stop the Windows menu bar)
  - ACCEPTED: an upload that finishes while the node's workflow tab is in the background doesn't update that tab's draft until you return (drafts are only written for the active workflow; the draft store isn't reachable from extensions; returning re-captures)
  - ACCEPTED: paint/mask files in documents saved before the bounds-growth re-upload fix may be offset; they can't be repaired (text layers are). Editor and Python now at least agree (unscaled top-left)
### M8 -- Multiple masks
- [ ] Add / delete / reorder mask layers (mask rows stay above paint layers); each has its own color, overlay opacity, invert, visibility
- [ ] Default colors are distinct: first mask red, then a fixed palette (e.g. blue, green, yellow, magenta, cyan, orange); user can change any
- [ ] Quick Mask paints into the selected mask; clicking a mask row selects it (and turns Quick Mask on)
- [ ] `MASK` = union of visible masks (unchanged rule); hidden-mask note covers any hidden mask with content
- [ ] Undo for add/delete/reorder like paint layers; masks are not tied to paint layers

### M9 -- Output regions + output options
- [ ] Region tool: draw numbered rectangles (max 6) anywhere on the image; move/resize with handles; overlap allowed; exact X/Y/W/H fields
- [ ] Regions are in **image px**, fixed to the image (Move drawing doesn't move them); on an upstream size change, scale them proportionally with the image and clamp
- [ ] Stable slots: region *n* <-> output pair *n*, never renumbered; new region = lowest free slot (see "Output regions: implementation notes")
- [ ] User-editable region name = output labels (`name` / `name mask`)
- [ ] Region outputs: `IMAGE n` = composited image cropped to the rect; `MASK n` = union of visible masks cropped to the rect
- [ ] Output options per output (Main + each region): apply mask **None / Fill (color) / Crop to mask (+ padding px)**. Crop trims to the mask's bbox + padding (clamped to the output), which changes that output's size; empty mask with Crop = uncropped
- [ ] Side panel tabs **Layers | Outputs**: Outputs lists Main (always) + regions (number, name, size fields, visibility, options, delete)
- [ ] Regions and options saved in the document (`regions`, `mainOutput`); Python applies them; undoable edits
- [ ] Batch: each output is a batch like `IMAGE`

### M10 -- Floating selections + clipboard
- [ ] Move layer tool inside a selection drags the selected pixels as a floating piece; Alt+drag duplicates; commit on deselect / tool switch / Enter; Esc cancels
- [ ] Ctrl+C / Ctrl+X / Ctrl+V inside the editor (only while it owns the keyboard -- white rail edge); paste = new layer, floating, at the view centre
- [ ] Paste images from the system clipboard (browser `paste` event; no permission prompt) as a new floating layer
- [ ] One undo step per committed float

### M11 -- Free Transform (Ctrl+T)
- [ ] Destructive scale/rotate with handles for the active layer, a selection, or a floating paste; Shift keeps proportions (Photoshop); Enter commits, Esc cancels; resample once on commit
- [ ] Floating pastes/inputs stay unresampled until commit (one resample from the source)
- [ ] Text rotation stored in `textData` (non-destructive; text re-renders); Free Transform on a text layer rotates/scales via `textData`
- [ ] No saved-file contract change: pixel layers are resampled on commit, text is rasterized as always

### M12 -- Extra image inputs
- [ ] Optional growable inputs `image_2`, `image_3`, ... (V3 `Autogrow`; verify)
- [ ] "Copy from input N" button: places that image as a new floating layer, ready to Free Transform; no live link after commit
- [ ] Python returns previews for all image inputs so the editor can see them after a run (LoadImage-style upstreams work before a run)

### M7b -- Release polish (last)
- [ ] README: real feature list, shortcuts table, screenshots/GIF, install, storage + cleanup explanation
- [ ] Example workflows (`example_workflows/`): e.g. LoadImage -> PainterSketch -> inpaint (Crop to mask); regions -> per-person prompts
- [ ] Full manual checklist (AGENTS.md "Testing") in both renderers before the first release

### Handoff notes (for the next session)
- M0-M6 and M7a are done and browser-verified; the user commits. Update checkboxes + Decisions Log as work lands.
- Main (coordinating) session: read `AGENT_ORCHESTRATOR.md` for how to delegate to agents, verify, and report. Sub-agents don't need it.
- Terminology: "view" = pan/zoom of the stage; "Move drawing" = whole-drawing placement (layers-footer toggle); "Move layer" = the `V` tool.
- Next: M8 (multiple masks), then M9-M12 (agreed 2026-09-24), then M7b release polish. The user will not publicly release until M8-M12 are done.
- M8 starting points: the first mask's style comes from `readFirstMaskStyle()` (`ui/src/defaults/maskDefaults.ts`, "first mask" naming so the M8 palette continues after it); v1 limits to one mask in `document/layerList.ts` / `document/masks.ts` and the layers panel, while Python (`combine_mask_layers`) and the compositor already handle N masks.
- Largest files: `ui/src/ui/keyboard.ts` (390), `widget/controller.ts` (367), `engine/dabMask.ts` (337), `engine/stroke.ts` (330), `engine/editor.ts` (272 + `editorBase.ts`). User messages go through `notify` (AGENTS.md).

#### Brush engine (2026-09-25/26, after M7a)
Unplanned work driven by comparisons with Photoshop. Two sessions of guessing at PS's model from screenshots went wrong (details in the Decisions Log); on 2026-09-26 the model was **measured** from PS's own lossless exports and the engine rebuilt on it. Do not re-derive the model from eyeballing screenshots: the measurements below are the ground truth (`300px*.png` in the repo root at the time; keep them out of git or move them).

**Photoshop, measured** (300 px soft round, hardness 0, opacity/flow 100, paint on black, PNG at 100%; analysis: numpy radial profile of a click, column-centroid cross-section of a stroke, dab centres of a 40% line)
- Tip: `alpha = 10^-(d/R)^2` (R = size / 2) -- a Gaussian that is **10% at the nominal radius**, 50% at 0.55 R, and cut off at 1.5 R (fit error < 1/255; the tail drops off the Gaussian between 1.45 and 1.55 R). Not "50% at the ring" as assumed before: PS's cursor ring shrinks with softness (user-confirmed it changes with hardness; R when hard, measured 0.767 R when soft at 300 px, 0.75 R at 80 px -- the tip's ~25% point, not the 50% boundary), which is what `ringDiameter()` does.
- Combine: **every dab is composited source-over** (`c += a x tip x (1 - c)`). A stroke is far denser than a click: at 25% spacing the cross-section at 0.27 / 0.53 / 0.8 / 1.07 R is 0.94 / 0.74 / 0.43 / 0.18 (over predicts 0.97 / 0.78 / 0.44 / 0.16; the swept-tip "max" model predicts 0.85 / 0.52 / 0.23 / 0.07). Consequences that match what the user sees in PS: crossings, corners and Shift-click joints fill in with no crease; colouring in gives a solid fill; at 40% spacing the dabs show as circles with a solid interior (measured 10% dips between dab centres on the centreline; over predicts 9%, max 31%).
- Spacing 40% = 120 px steps exactly (spacing is % of diameter); default 25%.
- Shift-click lines are separate history states (user checked: three entries for click + two Shift-clicks) and show no bulb at the joints.
- Hardness > 0 is **not measured yet** (ask for 300 px dots at hardness 50 and 100 to confirm the interpolation below).

**Brush engine as built** (`engine/brush.ts`, `engine/strokePath.ts`, `engine/dabMask.ts`, `engine/stroke.ts`, `tools/paintTool.ts`)
- `stampProfile(hardness, maxRadius)` in radius units: `core = h`, `fade = 1 - h` (never under 1 px: `fade >= 1 / maxRadius`, and then `core = 1 - fade / 2` so 100% hardness is a 1 px antialiased edge centred on the ring), `reach = core + 1.5 fade`. `stampAlpha(u)` = 1 inside the core, then `10^-t^2` with `t = (u - core) / fade`, 0 from `t = 1.5`. Hardness 0 is the measured PS tip; 0 < h < 1 is our interpolation.
- Tools produce spaced dabs (`placeDabs`, unchanged). `planSegments` merges straight, *evenly spaced* runs (each dab within 0.35 px of its place on the chord, up to 4 radii); a run owns dabs `1..intervals` (dab 0 is the previous segment's end), a 0-interval segment is the stroke's first dab. Every dab belongs to exactly one segment, so segments composite each dab once.
- `CoverageMask` (16-bit, bounds-sized): one dab per segment (curves: every pointer sample) is stamped directly through a `p = flow x tip` table indexed by squared distance; a run is applied per pixel by summing `q = -ln(1 - p)` over the run's dabs within reach and taking `1 - exp(-sum)`, which is exactly the over-composite of those dabs (so batching never changes the result). Per-row capsule bounds, not the bbox. Under 5% spacing every m-th dab stands for m (the group's centre, weight m), identical in the limit. Tables are cached per (profile, flow). The 1.5 R cutoff is interpolated over the last table cell (< 0.6% coverage in a sliver 0.15% of a radius wide).
- Pen pressure -> opacity is a cap: after compositing, `next = min(next, max(c, cap))` with `cap` interpolated along the segment; never lowers what is there. Flow = per-dab alpha. Stroke opacity is applied once at commit (`globalAlpha`), as before.
- Shift-click line = its own stroke and undo step composited over the previous one (PS). `createSpacer(from, residual)` starts at the previous stroke's end **without a dab there** and carries that stroke's spacing residual on, so at 100% opacity the joint is pixel-identical to a continuous stroke (test: "a Shift-click joint..."). The old `continued` / `base` merge is gone.
- Cost (temporary vitest timing, deleted): curvy strokes 0.15 ms per pointer sample for an 80 px soft brush, 0.5 ms for 500 px. A straight 2600 px flick in one frame: 20 ms (80 px), 145 ms (500 px soft, 6 dabs per pixel); hard brushes ~4x cheaper. Realistic drags are 20-100 px per frame. If huge soft brushes need to be faster: a per-stroke table of the semi-infinite run sum `S(u, sigma)` in radius units would make long runs one bilinear lookup per pixel (only for soft profiles; hard edges need the exact loop).
- Cursor ring (`ringDiameter`, `paintTool.cursor()`): `size x min(1, core + fade x RING_FADE_POSITION)`, with `RING_FADE_POSITION = 0.77`, **measured in PS** at hardness 0: 80 px brush -> 60 px ring, 300 px -> 230 px (0.75 / 0.767). The tip is ~25% opaque there, not 50% (`sqrt(log10 2)` = 0.55 was too small). Hardness > 0 is interpolated (not measured). Browser-verified by the user: a 300 px soft ring lines up with a 230 px hard dot, and ring and dots scale together at any graph / canvas zoom and after the input image changes size.
- Regression tests in `dabMask.test.ts`: the PS fixtures (25% cross-section within 0.045, 40% beading within the measured ranges, tip within 1/255), "colouring in" (scribbled square solid > 0.995 for soft and = 1 for hard), crossings = over of the arms, batching invariance, the Shift-click joint, cap, thinning, hard edge.

**Tried and reverted** (don't repeat)
- Canvas stamp stacking as originally built: source-over was right; the tip (a linear ramp ending at the ring, later a k = 5 Gaussian also ending there) and the 10% default spacing were not -- lines came out nearly solid to half a radius with a hard end at the ring (cross-section 1.00 / 0.96 / 0.56 / 0.00 where PS is 0.94 / 0.74 / 0.43 / 0.18). 8-bit premultiplied canvas stacking also drifted colour into rings (fixed by the 16-bit JS coverage mask).
- "Alpha darken" / max of the swept tip (`c = max(c, tip)`), with or without a per-pixel "pass" rule: every variant creases where a stroke meets itself and leaves Voronoi-like cells when colouring in, because a pixel only ever keeps its nearest dab. Pass rules (segment serials, arc-length windows) additionally step 24-25% wherever the rule flips between neighbours. Sliding the tip between dabs hid the circles PS shows at 40%; a per-pair slide/stamp threshold flipped on floating-point noise.

**Open**
1. ~~Hardness 50 / 100 tips~~ closed 2026-09-26: user compared 300 px dots at hardness 50 / 100 against PS, they match.
2. Curve smoothing of pointer samples (e.g. Catmull-Rom): fast loops are polygons. One pointer event of latency. Offered, not requested.
3. Flow < 100% and pressure -> opacity against PS (model: per-dab alpha and a local cap; not measured).

## Behavior Notes

- Shift+click straight line starts from where the previous stroke **ended**
  (Photoshop behavior).
- With no image connected, `width` x `height` filled with `background` **is** the
  current image: editor and Python both use it, and the document maps onto it with
  the normal scale-to-fit transform (empty documents adopt it as their frame).
  Editing the widgets updates the canvas live.
- Disconnecting `image` (a real link removal) copies the last image size into
  `width`/`height` (rounded to a multiple of 8, clamped 64-8192), so the canvas
  keeps its size and the node shows it.
- A **Clear** button resets the document (all layers and masks) after a
  `window.confirm()`. Clearing is undoable. The frame becomes the current image
  size (the widget size when no image is connected).
- **View on node resize:** "fit" mode is sticky (initial, Ctrl+0, Fit button) and
  re-fits on resize. After a manual zoom/pan, resize keeps the zoom and the
  centered image point. Pan is clamped so at least 64 px of the image stays visible.
- The `background` colour is always used opaque; any alpha from the picker is
  ignored (the `IMAGE` output has no alpha).
- Hidden mask layers are excluded from `MASK` (same rule as paint layers). Painting
  on a hidden mask, or queueing while a hidden mask has paint, shows the note
  "The mask is hidden; show it to output it."
- Brush size is in *current image* pixels; strokes convert to document pixels
  (`size / s`) at pointer-down.

## Open Questions

None right now.

## Decisions Log

- 2026-09-26: Brush engine closed (hardness 0 / 50 / 100 all match PS, browser-verified). M8 decisions: max 7 masks, min 1, names "Mask N", first mask uses the default-mask settings then a palette, current mask = last selected (`*` marker while Quick Mask is off), per-mask invert before the union, masks stay above paint, no contract change. PS-style per-layer masks deferred (post-M10 idea).
- 2026-09-24: ComfySketch is the skeleton, Comfy Canvas is the source of editor/UI ideas. LiteGraph primary, Nodes 2.0 supported.
- 2026-09-24: Name `PainterSketch`, extension `phazei.PainterSketch`.
- 2026-09-24: Background is live and never saved; scale to fit on size change; output = image frame.
- 2026-09-24: Masks are a layer kind (N-capable data model); red 50% default; `invert_mask` widget.
- 2026-09-24: Batch in, batch out (broadcast).
- 2026-09-24: Selection (marquee, lasso, magic wand) added to v1; Photoshop shortcuts and modifiers adopted.
- 2026-09-24: Per-mask-layer `invert` + node-level `invert_mask`; masks combine additively (max).
- 2026-09-24: Output regions recorded as a future feature; `regions` reserved in the document.
- 2026-09-24: Disconnect keeps the document; Clear button with confirm.
- 2026-09-26: Brush engine rebuilt on Photoshop's **measured** model (supersedes the four 2026-09-25 brush entries below). The whole detour started with "a hardness-0 line isn't as soft as PS's": the original engine's model (dabs composited source-over) was right; its tip (linear ramp ending at the ring) and 10% default spacing were wrong; the 09-25 sessions replaced the model with a swept-tip "max" (alpha darken), which creases wherever a stroke meets itself and leaves Voronoi cells when colouring in, then piled passes / continuation merges / dab blends on top. Measured from 300 px PS exports (Handoff notes, "Brush engine"): tip `10^-(d/R)^2` (10% at the ring, cut off at 1.5 R, error < 1/255), every dab composited over (stroke cross-section at 25% within 0.02-0.04 of over, 2x off from max), 40% beading 10% (over 9%, max 31%). Built: `stampProfile` / `stampAlpha` (hardness > 0 interpolated, unmeasured), `CoverageMask` stamps single dabs directly and applies runs as `1 - exp(-sum q)` (= exact over), per-row capsule bounds, thinning under 5% spacing, pressure -> opacity as a local cap; Shift-click = separate stroke composited over with the spacing residual carried through the joint (no dab at the joint), so 100% opacity is pixel-identical to a continuous stroke; `continued` / `base` / `dabBlend` / passes removed. Regression tests incl. a scribbled square that must be solid. Browser-verified by the user: an 80 px hardness-0 dot and line are "practically identical" to Photoshop's. Cursor ring now at the tip's 50% boundary like PS's default cursor (user confirmed PS's ring changes with hardness); no setting.
- 2026-09-25: Brush dabs show as spacing grows (`dabBlend`, `engine/dabMask.ts`): the per-pair slide/stamp threshold (`slides()`) is gone; each segment's target is the slid profile blended towards the nearest two real dabs, 0 up to 25% spacing soft / 10% hard, 1 from 35% / 20%. Root cause of the uneven 40% line: the threshold was exactly the 40% gap for an 80 px soft brush, so pairs flipped on floating-point noise; and sliding at 40% hid the circles Photoshop shows (its line at 40% has visible, even dabs -- so PS is discrete `max`, not over: rendered comparisons rule over out). `planSegments` now also requires even spacing along the chord to merge a run. Crossing / zig-zag artifacts at 25% remain the `max` crease along acute wedges; whether PS has it too is the open question -- asked the user for 100% PNG exports (dot, self-crossing, 40%) to measure the real profile and the crossing rule before changing either. Needs browser check.
- 2026-09-25: Brush seams fixed by removing the "pass" rule from `CoverageMask` (`serials`/`before` per pixel): the coverage is now plain alpha darken over the swept profile (`c += max(0, target - c) * rate`, Krita wash mode = Photoshop) with no per-pixel history. Root cause of the artifacts (dark cracks inside shift-click corners, steps where dots overlap non-consecutively): "same pass = max, path came back = combine like a separate stroke" was decided from segment numbering, so the formula flipped between neighbouring pixels along the apex stamp's reach (24% step) and along the next dab's reach (25% step); reproduced numerically before the change. Consequences: at 100% flow self-crossings, corners, doubling back and overlapping separate dabs are all max ("one even stroke", the user's PS observation); below 100% flow coming back builds up towards the profile. Open question 1 (separate dabs building up) is answered "no" pending the user's PS check. Regression tests: `dabMask.test.ts` "no seams". Supersedes the pass part of the entry below. Needs browser check.
- 2026-09-25: Brush engine (`engine/dabMask.ts`): dabs become path segments (straight runs merged) and the stamp is slid continuously along each segment into a 16-bit JS coverage mask (A. Joshi, JCGT 2018). Photoshop model, verified by the user in PS: coverage moves towards the stamp profile at the pixel's distance from the path, never down; 100% flow = profile swept, no build-up where a stroke crosses itself; lower flow `rate = 1 - (1 - flow)^n` (n = dab steps covering the pixel). Soft stamps reach `radius x (2 - hardness)` with the fade halfway at the cursor ring (Photoshop's soft dots halo past the ring); falloff = normalized Gaussian k = 3. Default spacing 25% (Photoshop's). Spacing still matters: consecutive dabs slide only while that looks identical to stamping them (edge dip `g^2 / (8 reach)` under 0.5 px hard / 2% alpha soft; e.g. 80 px: soft slides to ~40% spacing, hard to ~16%); farther apart they are stamped as separate dabs (dotted strokes at large spacing, like Photoshop). Passes (segment serials): while consecutive segments keep touching a pixel (the path never left its reach: along a line, around a corner) it keeps the stronger value (line = profile swept, corners don't notch); once the path has left and comes back (self-crossing) a new pass combines like a separate stroke `1 - (1 - before)(1 - pass)`, so crossings fill in instead of leaving hard-edged max-of-two gaps. Spacing max 400%. Shift-click lines continue the previous stroke (same layer/style, its undo entry still newest): the kept coverage is the base and only the extra `(c - p) / (1 - p * opacity)` is composited, so start dots / zig-zag corners don't double up (Photoshop behaviour); still one undo step per click. No beads at any spacing; ~1 computation per pixel per segment (500 px soft brush ok). Replaced canvas stamp stacking (`stampCache.ts` removed; stacking saturated soft edges, 8-bit drift made rings). Needs browser check.
- 2026-09-25: Brush hardness falloff: solid core = hardness x radius, then a normalized Gaussian (k = 5, 16 gradient stops; ~0.29 alpha halfway) instead of a linear ramp, to match Photoshop's soft round (a linear ramp looked hard once 10%-spaced dabs build up). Brush, eraser, mask painting. Colour fixes browser-verified.
- 2026-09-25: Colour fixes. (1) Brush dabs accumulate as coverage only and get the colour once at composite (`stroke.ts`): coloured low-alpha dabs drifted in the 8-bit premultiplied buffer (dark "dust" rings when painting a mid-tone over the same colour). (2) Bucket/wand tolerance compares alpha-weighted colour (faint AA pixels match transparent), and with anti-alias the bucket fills *behind* the target layer's rising soft edges next to the fill (`engine/fillUnder.ts`): no halo when filling around a stroke. Needs browser check.
- 2026-09-25: M7a browser-verified (incl. missing-files recovery: renaming `input/painter-sketch/` away and back restores all layers). Added `BucketSample` / `WandSample` default settings.
- 2026-09-25: M7a code landed: file splits; error-message audit with `notify` + `ToastLimiter` de-dup, upload auto-retry with backoff, unreadable manifests preserved, missing files keep their reference; wrong-size layer files placed unscaled top-left in Python too (was stretched); six "Defaults" settings (mask color/opacity, pressure curve); no-op gestures leave no undo step; bare modifiers pass in fullscreen.
- 2026-09-24: Post-v1 plan agreed: M8 multiple masks (distinct default colors), M9 output regions (max 6, image px, stable slots never renumbered, user-named output labels, per-output apply-mask None/Fill/Crop+padding, no transparency), M10 floating selections + clipboard, M11 destructive Free Transform (+ text rotation in textData; non-destructive per-layer transforms cut), M12 extra image inputs with "Copy from input N". M7 split into M7a (now) and M7b (release polish, last).
- 2026-09-24: M6 complete. Late fixes: bounds growth now re-uploads every layer (other layers kept old-size files -> offset after reload, and slightly wrong Python output); restored text layers with mismatched files re-render from `textData`. Reload guard for F5/Ctrl+R (flush then reload; no extra prompt, ComfyUI already asks); flush on tab hidden / window blur. Drafts: we trigger `changeTracker.captureCanvasState()` after uploads/edits so page reload restores the latest paint.
- 2026-09-24: Ctrl = temporary Move layer with auto-select (Photoshop); thumbnails now follow Move drawing placement.
- 2026-09-24: M6 browser-verified. Fixes: every view command repaints (Fit button bug); stuck middle-button/pen drag recovery (likely cause of the "Move drawing ignored" bug); Space in text fields no longer arms pan. New Sample choice "Background" (input image only), default for bucket and wand; eyedropper keeps "All layers". Rasterize "paint again" note removed.
- 2026-09-24: M6 code landed. Move layer: `translate {layerId,dx,dy}` history entry (no pixels; bounds grow first; patch fallback at the cap); nudges merge; per-kind movers in `engine/layerMovers.ts`. Text: `rasterize.ts` is the single gate before pixel edits (lock/hidden notes too); rasterize + next edit = one undo step; the press that triggers the confirm paints nothing; create+empty = no history; Clear turns text layers into empty paint layers; clicking another text while editing switches to it. New `text` option descriptor kind (font menu + custom).
- 2026-09-24: M5 browser-verified. Ctrl+Shift+I restored (editor-scoped); Ctrl+A = current image area; new isometric "Move drawing" icon.
- 2026-09-24: M5 round 1 fixes: ants built from closed contours (no pulsing on diagonals; 4k wand ~65 ms); Invert button + Shift+F7 + Ctrl+Shift+I (editor-scoped); +/−/× cursor badges; whole-drawing Move moved from the rail to a "Move drawing" toggle in the layers footer (hidden tool, `rail: false`).
- 2026-09-24: M5 code landed. Move: `documentMap(doc, imageSize)` is the single doc<->image mapping (includes placement); wheel-scale while dragging 1.05/notch. Selection: cropped coverage `{rect, data, outside}` in doc coords, combine via min/max, empty result deselects, selection changes are undoable (`selection` history entry), clipping applied in `StrokeBuffer.compositeBuffer` + fill `clip`. Delete/Backspace always swallowed while the editor has the keyboard. Shift+F7 also inverts. Lasso Alt rule per Photoshop (Alt at start with a selection = subtract; re-press Alt for straight segments). Wand defaults tol 32 / contiguous / AA / all layers.
- 2026-09-24: M4 browser-verified. Fixes: SVG cursors for eyedropper (incl. Alt) and bucket; with no image, width/height are the image size in editor and Python (doc frame no longer overrides), disconnect copies the size into the widgets.
- 2026-09-24: M4 code landed. Bucket defaults tol 32 / contiguous / AA / (now: Background); fill grows bounds to cover the visible image; 4k fill ~185 ms. Eyedropper: Alt+click -> BG; `altEyedropper` tool flag gives Alt = temporary eyedropper (brush, bucket, shapes; not eraser). Shapes are pixel shapes rasterized on release (one undo patch); "both" = FG stroke + BG fill; Alt at pointer-down = eyedropper, Alt during drag = from centre; Esc cancels any tool drag. Rail tool groups (`tools/toolGroups.ts`, flyout via long-press/right-click) reusable for M5 marquees.
- 2026-09-24: Storage revised after measurements: masks PNG, paint lossy WebP default 99 (100 = PNG); cleanup settings row shows file stats.
- 2026-09-24: Storage: WebP layers (masks lossless-verified via VP8L sniff, paint quality setting default 100 = lossless), upload on focus loss / 5 s idle / queue / Ctrl+S, settings-panel cleanup button with the one server route.
- 2026-09-24: M3 browser round 1 fixes: click-to-engage focus rule + white rail edge as focus indicator; slider popover drag fixed; pressure options moved behind a stylus button (declarative option groups, nested popovers); background colour alpha ignored in both editor and Python (`#rgba`/`#rrggbbaa` accepted); `document` tooltip removed; graph undo no longer blanks the node (element/session hand-off) and never rolls back paint.
- 2026-09-24: M3 code landed (browser check pending). Shell regions (rail / options bar / stage / side panel / in-root popover host); declarative tool options with scrubby labels; `editor.ts` split into ~7 engine modules. Layers panel with a `layers` history entry type. Fullscreen moves the editor root (child of a stable `.cps-widget` wrapper) into a body overlay (z-index 1790: above ComfyUI menus, below PrimeVue dialogs/toasts). In fullscreen, keys we don't use are swallowed except browser keys (F1-F24, Ctrl+R/W/T/N/L/Tab/PgUp/PgDn, devtools, Alt+arrows) and Ctrl+S / Ctrl+Enter. Clicking editor buttons no longer takes focus from the hidden key-sink input.
- 2026-09-24: M2 browser-verified. Hidden mask layers stay excluded from `MASK`; queueing with a hidden, painted mask shows the note "The mask is hidden; show it to output it."
- 2026-09-24: M2 code landed. New docs include a "Mask" layer (older docs get one lazily). Quick Mask paints white+alpha coverage. Overlay = tint of coverage (after per-layer invert) above paint; node `invert_mask` affects output only. Interim mask eye toggle until the M3 layers panel.
- 2026-09-24: Whole-drawing Move tool planned as the first M5 item (non-destructive placement, not undoable -- Esc/Reset instead, no rotation).
- 2026-09-24: M1 browser-verified. Fix: upstream size changes no longer resample layers (repeated A->B->A shrank paint); display maps doc -> image via `engine/frameMap.ts`. Clear button pulled forward from M3. Sticky fit + pan clamp + Fit button.
- 2026-09-24: M1 code landed (browser check pending). `docId` added to the document. Undo patches in frame coords; bounds growth is not an undo step; scale-to-fit is one undo entry. Live sessions kept in a module map (max 6 detached) so tab switches keep unsaved strokes + undo. An inverted mask layer with no paint = full mask.
- 2026-09-24: M0 code landed. Document widget via `getCustomWidgets` (`PAINTERSKETCH`); local TS types (official types package is empty). Installed ComfyUI frontend is 1.52.7; source reference is 1.55.x.
