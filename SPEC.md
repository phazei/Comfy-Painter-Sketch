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
  textData?: TextData                               // text layers
}
interface Region {                                  // future: Output Regions
  id: string
  index: number                                     // 1-based, shown on canvas, maps to output slot
  rect: { x: number; y: number; width: number; height: number } // frame coords
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
  unchanged and a zero mask. Missing layer file: warn, treat as empty.

## Feature Scope (v1)

### Canvas / view
- Fit to node by default; zoom (wheel over canvas, Ctrl +/-), pan (Space-drag,
  middle-drag), fit (Ctrl+0), 100% (Ctrl+1)
- Fullscreen toggle button (`F`; Esc exits)
- Brush-size ring cursor; image frame outline when paint extends beyond it
- **Undo / redo buttons** always visible in the toolbar, plus shortcuts

### Tools
| Tool | Key | Options / behavior |
|---|---|---|
| Brush | B | size, hardness, opacity, flow, spacing, color, pressure -> size / opacity toggles. **Click, then Shift+click draws a straight stroke from the last point** |
| Eraser | E | size, hardness, opacity, pressure, Shift+click straight line |
| Paint bucket | G | tolerance, contiguous, sample current layer / all layers, anti-alias |
| Eyedropper | I | sample current layer / all layers. **Alt held in brush/bucket/shape = eyedropper** |
| Rect marquee / Ellipse marquee | M (Shift+M cycles) | Shift = square/circle once started |
| Lasso | L | freehand; Alt-click adds polygon points |
| Magic wand | W | tolerance, contiguous, sample current layer / all layers |
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
Per-layer move/free transform (whole-drawing Move is M5), rotation, feathering/refine edge, blend modes, brush presets beyond
a couple, layer masks (per-layer), smoothing/stabilizer, symmetry, PSD export,
per-image paint in a batch, multiple mask layers in the UI, output regions.

### Future (v2): Apply mask to IMAGE
Option to bake the mask into the `IMAGE` output: fill the masked area with a
color, or cut it out as transparency. ComfyUI `IMAGE` is RGB, so transparency
likely means an extra RGBA/alpha output or relying on image+mask consumers.

### Future: Output Regions
Draw numbered rectangles on the canvas (e.g. one per person); each becomes its
own output pair.
- Each region has a visible number that matches its output slot:
  `IMAGE 1` / `MASK 1`, `IMAGE 2` / `MASK 2`, ... The main `IMAGE`/`MASK`
  (full frame) stay as the first outputs so existing links never shift.
- Region `IMAGE n` = composited image cropped to the region. Region `MASK n` = the
  combined mask (decision 5) cropped to the same rectangle.
- Deleting a region renumbers the rest only if nothing is linked to them; otherwise
  keep numbers stable (to be decided when built).
- Implementation note: V3 (`comfy_api.latest._io`) has a `DynamicOutput` base
  class but no concrete dynamic-output type yet (`Autogrow`, `DynamicCombo`,
  `DynamicSlot` are inputs). Options at build time:
  1. A concrete V3 dynamic output, if core has added one by then (check first).
  2. Declare a fixed maximum of region pairs in the V3 schema (e.g. 8) and have
     the frontend show only the first N. Only ever trim from the end: link
     indices are positional, so hiding a middle slot would misroute outputs.
  3. A single `is_output_list` IMAGE/MASK list (downstream runs once per region;
     no per-region wiring).
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

### M6 -- Text
- [ ] Text layers, textarea overlay editing, re-edit on double-click, rasterize on save

### M7 -- Polish
- [ ] Error toasts, settings (default mask color, pressure curve), README, example workflow

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

- 2026-09-24: ComfySketch is the skeleton, Comfy Canvas is the source of editor/UI ideas. LiteGraph primary, Nodes 2.0 supported.
- 2026-09-24: Name `PainterSketch`, extension `phazei.PainterSketch`.
- 2026-09-24: Background is live and never saved; scale to fit on size change; output = image frame.
- 2026-09-24: Masks are a layer kind (N-capable data model); red 50% default; `invert_mask` widget.
- 2026-09-24: Batch in, batch out (broadcast).
- 2026-09-24: Selection (marquee, lasso, magic wand) added to v1; Photoshop shortcuts and modifiers adopted.
- 2026-09-24: Per-mask-layer `invert` + node-level `invert_mask`; masks combine additively (max).
- 2026-09-24: Output regions recorded as a future feature; `regions` reserved in the document.
- 2026-09-24: Disconnect keeps the document; Clear button with confirm.
- 2026-09-24: M5 browser-verified. Ctrl+Shift+I restored (editor-scoped); Ctrl+A = current image area; new isometric "Move drawing" icon.
- 2026-09-24: M5 round 1 fixes: ants built from closed contours (no pulsing on diagonals; 4k wand ~65 ms); Invert button + Shift+F7 + Ctrl+Shift+I (editor-scoped); +/−/× cursor badges; whole-drawing Move moved from the rail to a "Move drawing" toggle in the layers footer (hidden tool, `rail: false`).
- 2026-09-24: M5 code landed. Move: `documentMap(doc, imageSize)` is the single doc<->image mapping (includes placement); wheel-scale while dragging 1.05/notch. Selection: cropped coverage `{rect, data, outside}` in doc coords, combine via min/max, empty result deselects, selection changes are undoable (`selection` history entry), clipping applied in `StrokeBuffer.compositeBuffer` + fill `clip`. Delete/Backspace always swallowed while the editor has the keyboard. Shift+F7 also inverts. Lasso Alt rule per Photoshop (Alt at start with a selection = subtract; re-press Alt for straight segments). Wand defaults tol 32 / contiguous / AA / all layers.
- 2026-09-24: M4 browser-verified. Fixes: SVG cursors for eyedropper (incl. Alt) and bucket; with no image, width/height are the image size in editor and Python (doc frame no longer overrides), disconnect copies the size into the widgets.
- 2026-09-24: M4 code landed. Bucket defaults tol 32 / contiguous / AA / all layers; fill grows bounds to cover the visible image; 4k fill ~185 ms. Eyedropper: Alt+click -> BG; `altEyedropper` tool flag gives Alt = temporary eyedropper (brush, bucket, shapes; not eraser). Shapes are pixel shapes rasterized on release (one undo patch); "both" = FG stroke + BG fill; Alt at pointer-down = eyedropper, Alt during drag = from centre; Esc cancels any tool drag. Rail tool groups (`tools/toolGroups.ts`, flyout via long-press/right-click) reusable for M5 marquees.
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
