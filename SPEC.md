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
  activeLayerId: string
  layers: Layer[]                                   // bottom -> top, background excluded
}
interface Layer {
  id: string; name: string
  kind: 'paint' | 'text' | 'mask'
  visible: boolean; locked: boolean; opacity: number
  blendMode: 'normal'
  file: string | null                               // "painter-sketch/xyz.png [input]"
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
- **Layer PNG:** RGBA, exactly `bounds.width x bounds.height`; PNG pixel `(px,py)`
  sits at frame coords `(bounds.x+px, bounds.y+py)`. Straight (non-premultiplied)
  alpha. `file: null` = empty layer.
- **File names:** `painter-sketch/ps-<docId8>-<hash>.png`, stored in the widget as
  `"painter-sketch/ps-<docId8>-<hash>.png [input]"`. The hash is of the content,
  so edits produce new names and unchanged layers are not re-uploaded. A fully
  erased layer saves as `file: null`.
- **Upload timing:** `serializeValue` only runs at queue time (inside
  `graphToPrompt`); save/export/tab switch read `widget.value`. So the widget
  value is updated after every edit and dirty layers upload ~1 s after the last
  edit; `serializeValue` just flushes pending uploads. File references change only
  after a successful upload. A failed upload toasts and blocks the queue (same as
  core Painter); pixels stay in memory, still dirty.
- **Paint layers** (`kind: "paint"`, later `"text"`): composited bottom -> top,
  Normal blend, straight-alpha "over", multiplied by layer `opacity`. Hidden
  (`visible: false`) layers are skipped.
- **Mask layers** (`kind: "mask"`): mask value = PNG **alpha** (RGB ignored).
  `opacity` and `color` are display-only and do NOT affect `MASK`. Per-layer
  `invert`, then union (max) of visible mask layers, then node `invert_mask`.
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
- Shift = add, Alt = subtract, Shift+Alt = intersect (Photoshop modifiers)
- Ctrl+D deselect, Ctrl+Shift+I invert, Ctrl+A select all
- Painting, filling and erasing are clipped to the selection
- Delete / Backspace clears the selection on the target layer
- Alt+Backspace fill with foreground, Ctrl+Backspace fill with background
- "Selection to mask": with the mask targeted, fill does it; also a button

### Color
- Foreground / background swatches, X swaps, D resets to black/white
- Hex field, compact SV square + hue slider, a few recent colors

### Brush shortcuts
- `[` / `]` size, Shift+`[` / `]` hardness
- `1`..`9`, `0` set opacity 10%..90%, 100%

### Layers (panel collapsible in-node, open in fullscreen)
- Add, delete, duplicate, reorder (drag), rename (double-click), visibility,
  lock, opacity, thumbnails
- Background (input image) row at the bottom, locked, not deletable
- Mask layers shown with their color swatch

### Pressure
- Pointer Events `pressure` with `getCoalescedEvents()`
- Mouse/touch without pressure = full pressure
- Simple curve (min size %, gamma) in brush options

### Undo / Redo
- Buttons in the UI, and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y while the editor is active

## Not in v1 (maybe later)
Per-layer move/free transform (whole-drawing Move is M5), rotation, feathering/refine edge, blend modes, brush presets beyond
a couple, layer masks (per-layer), smoothing/stabilizer, symmetry, PSD export,
per-image paint in a batch, multiple mask layers in the UI, output regions.

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
- [ ] Left tool rail, top options bar, color picker, layers panel
- [ ] Fullscreen re-parenting
- [x] Clear button (confirm, undoable) (pulled into M1)
- [ ] Keyboard shortcuts scoped to the active editor

### M4 -- Tools
- [ ] Paint bucket (typed-array flood fill), eyedropper (+ Alt)
- [ ] Line + arrow, rectangle, ellipse

### M5 -- Move + Selection
- [ ] Move tool (`V`): reposition/scale the whole drawing (all layers + masks) relative to the image, to realign paint to a similar but offset image
  - Drag = move; **scroll while dragging = scale** around the cursor (scroll without dragging still zooms the view); arrows nudge 1 px, Shift+arrows 10 px; Esc cancels the current drag; "Reset position" button. No rotation.
  - Non-destructive: stored as document `placement: {x, y, scale}` (frame px, identity default), applied after the frame map by both the editor and Python; pixels are never resampled. Needs a saved-file contract addition (Python must apply it).
  - Undo: placement is **not undoable** and stays out of the paint history; Ctrl+Z/Y always undo paint only (also while the Move tool is active). Recovery = Esc during a drag, drag it back, or "Reset position". Paint patches are in document coords, so they stay valid under any placement.
- [ ] Coverage-mask selection engine, cached marching ants, add/subtract/intersect
- [ ] Rect / ellipse marquee, lasso, magic wand
- [ ] Clip painting to selection, fill/clear selection, selection to mask

### M6 -- Text
- [ ] Text layers, textarea overlay editing, re-edit on double-click, rasterize on save

### M7 -- Polish
- [ ] Error toasts, settings (default mask color, pressure curve), README, example workflow

## Behavior Notes

- Shift+click straight line starts from where the previous stroke **ended**
  (Photoshop behavior).
- When `image` is disconnected after painting, the canvas keeps its last frame
  size and all layers; the background shows the `background` color.
  `width`/`height` only apply to a fresh, empty document.
- A **Clear** button resets the document (all layers and masks) after a
  `window.confirm()`. Clearing is undoable. The frame becomes the current image
  size (or stays `doc.frame` when disconnected).
- **View on node resize:** "fit" mode is sticky (initial, Ctrl+0, Fit button) and
  re-fits on resize. After a manual zoom/pan, resize keeps the zoom and the
  centered image point. Pan is clamped so at least 64 px of the image stays visible.
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
- 2026-09-24: M2 browser-verified. Hidden mask layers stay excluded from `MASK`; queueing with a hidden, painted mask shows the note "The mask is hidden; show it to output it."
- 2026-09-24: M2 code landed. New docs include a "Mask" layer (older docs get one lazily). Quick Mask paints white+alpha coverage. Overlay = tint of coverage (after per-layer invert) above paint; node `invert_mask` affects output only. Interim mask eye toggle until the M3 layers panel.
- 2026-09-24: Whole-drawing Move tool planned as the first M5 item (non-destructive placement, not undoable -- Esc/Reset instead, no rotation).
- 2026-09-24: M1 browser-verified. Fix: upstream size changes no longer resample layers (repeated A->B->A shrank paint); display maps doc -> image via `engine/frameMap.ts`. Clear button pulled forward from M3. Sticky fit + pan clamp + Fit button.
- 2026-09-24: M1 code landed (browser check pending). `docId` added to the document. Undo patches in frame coords; bounds growth is not an undo step; scale-to-fit is one undo entry. Live sessions kept in a module map (max 6 detached) so tab switches keep unsaved strokes + undo. An inverted mask layer with no paint = full mask.
- 2026-09-24: M0 code landed. Document widget via `getCustomWidgets` (`PAINTERSKETCH`); local TS types (official types package is empty). Installed ComfyUI frontend is 1.52.7; source reference is 1.55.x.
