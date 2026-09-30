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
| in | `width`, `height`, `background` | widgets | Only used when `image` is not connected. `width`/`height` 64-16384, step 8, default 1024; hidden while `image` is connected and kept synced to the image size; `background` default `#ffffff` |
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
  regions: Region[]                                 // M9, up to 6 stable output slots
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
  rect: { x: number; y: number; width: number; height: number } // current-image px from the top-left, never rescaled; may extend outside the image
  visible: boolean                                  // overlay display only; outputs always produced
  output: OutputOptions
}
interface OutputOptions {                           // per region, and doc-level `mainOutput` for IMAGE/MASK
  applyMask: 'none' | 'fill' | 'crop' | 'border'    // fill = paint masked area with `fillColor`; crop = trim to mask bbox; border = pad (M9 addendum)
  fillColor: string                                 // '#rrggbb'
  cropPadding: number                               // px around the mask bbox for 'crop'
  borderSize?: number; borderColor?: string; borderMask?: boolean // 'border': 64 / '#ffffff' / true
}
```

### Saved-file contract (frontend writes, Python reads)

- **Widget value** = `JSON.stringify(PainterDocument)`, or `""` for an empty document.
- **Coordinates:** paint is in *frame* pixels; M9 regions are in current-image pixels (see "Output regions"). `bounds` is the paint area and
  may extend past the frame (negative `x`/`y`, larger size) but always contains
  it. Initially `bounds = {x:0, y:0, width:frame.width, height:frame.height}`;
  it grows in 256 px chunks while painting off-frame, capped at the frame plus its short side on every side (was 3x the frame per axis until 2026-09-27) and 16384 px per
  axis.
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
| Output regions (Outputs tab) | O (toggle) | region mode: draw / move / resize; Shift-drag = new region; click empty = Main. Button next to the side-panel toggle |
| Float selection (M10) | Move tool: drag inside selection (Alt = copy); selection tools: Ctrl+drag inside (Ctrl+Alt = copy) | Enter commits, Esc / Ctrl+Z cancels; selection tools: plain drag inside moves the outline only |
| Merge Down (M10) | Ctrl+E | current row into the one below (same group); lower keeps its settings |

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
- Mask rows at the top (M8: 1-7; New mask button, inserted above the current
  mask; drag only among masks): eye, color swatch (picker), invert, overlay
  opacity. Clicking a mask row makes it current and turns Quick Mask on;
  clicking a paint row turns it off. The current mask has a left bar in its colour; each row (incl. the background) has a solo button. Masks found below paint in a loaded document are moved on top (output
  unchanged: union).
- New layer goes above the active paint layer, named "Layer N". The last paint
  layer can't be deleted. Painting on a locked layer shows "Layer is locked."
- Duplicate names follow Photoshop: "Name copy", "Name copy 2", ... (an existing " copy N" suffix is stripped first; first free number).
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
couple, layer masks (per-layer, PS-style: a mask linked to a paint layer hides part of it; useful once pasted images exist, M10+; decide then whether M8 masks can be linked or it is a separate per-layer mask), smoothing/stabilizer, symmetry, PSD export,
per-image paint in a batch, transparent (RGBA) outputs (the `MASK` output
carries alpha; downstream "Join Image with Alpha" exists), per-region mask
picking (regions use all masks; could become a dropdown later), text boxes with
wrapping, type-mask text, searchable installed-font picker.

## Post-v1 features (before public release)

Planned order after M7a: M8 -> M9 -> M10 -> M11 -> M12, then M7b release polish.
Details per milestone are in the Milestones section.

### Output regions (M9) -- agreed design (2026-09-26, rev. 2; done, browser-verified)
An overnight first pass (another model, plan not reviewed) built 14 dynamic outputs on
the main node, proportional region scaling and wire-disconnect rules. After testing,
the user and coordinator replaced that design with the one below. Do not bring back
dynamic output slots on the main node.

**Nodes**
- `PainterSketch` outputs `IMAGE`, `MASK`, `regions` (custom type `PS_REGIONS`).
  Keeps the node compact: 14 sockets were ~500 px tall and every added region made
  the node jump.
- New helper node **`PainterSketch Regions`** (category `image`): one required input
  `regions` (`PS_REGIONS`), always exactly 12 outputs `IMAGE 1`/`MASK 1` ...
  `IMAGE 6`/`MASK 6`. Sockets never appear, disappear or disconnect.
  - Output labels follow region names (`face` / `face mask`); an empty slot is
    labelled `region N (missing)`. Labels update without running: the helper's
    frontend follows its input link to the PainterSketch node and reads the
    document. Unresolvable links (reroute / subgraph boundary) fall back to
    `region N` labels; execution is unaffected.
  - An empty slot returns `ExecutionBlocker(None)` for that pair only: its downstream
    branch silently doesn't run (a feature; document it in README and the node
    description). Main and filled slots run normally.
  - Several helpers may hang off one node.
- `PS_REGIONS` value: a small Python object carrying, per slot 1..6, either the
  processed IMAGE/MASK tensors or "empty". Computed once in the main node.

**Slots and cards**
- Six fixed slots. The Outputs tab always shows **Main + six slot cards**: a filled
  slot is a full card, an empty slot is a one-line `+ Region N` row. Clicking it
  creates a centred default region in that slot; drawing on the canvas fills the
  lowest empty slot. `x` empties the slot (collapses to `+ Region N`). Card N
  always feeds helper pair N; refilling a slot sends the new region down the same
  wires (intentional and visible). No reordering (a "move to slot" action could
  come later).
- Card layout: row 1 eye, title, delete (icons from `ui/icons.ts`); row 2 X / Y / W / H
  (current image px, scrub labels, one undo step per field session); row 3 mask mode
  dropdown with colour swatch (Fill) or padding (Crop) inline. The title works like
  layer rows: shows `N · name`; double-click edits just the name, pre-filled with the
  default `Region N`; trimmed on commit, empty = default. No separate Name field.
- Main card: fixed title `Main`, read-only size, options row.

**Geometry**
- Regions are stored in **image px from the top-left** and never rescaled: not on
  input image changes, not on width/height widget changes. Move drawing doesn't move
  them. (`regionsReferenceSize` is dropped; nothing was released.)
- Regions may extend partly or fully outside the image, clamped to the paint area
  (one image size beyond each edge; independent of the paint-area cap). Edge rule (editor and Python):
  `floor(clamp(v, -W, 2W) + 0.5)` per edge (y with H), then at least 1x1. New
  regions from `+ Region N` are centred at half the image size. Outside the image a region
  outputs the `background` widget colour plus any paint and mask coverage that lies
  there; Python composites the needed extended area.

**Region mode (Outputs tab)**
- Opening the Outputs tab = region mode (draw / move / resize on the canvas);
  choosing any other tool switches back to the Layers tab. No separate rail tool
  and no "Draw region" button.
- A rail button next to the side-panel toggle (top) opens the panel on Outputs (for
  a collapsed panel); shortcut **O**.
- Shift-drag always draws a new region (even starting inside one); plain drag inside
  a region moves it. Clicking empty canvas selects Main. Selected Main = image border
  highlighted; selected region = highlighted with handles.
- Outside region mode, regions are subdued: thin, dashed, translucent, small number
  label, no handles, no selection highlight.

**Output options** (per output, Main + each region): None / Fill (colour) / Crop to
mask (+ padding). Applied to the final mask (per-layer invert -> union -> node
`invert_mask`); each output starts from the one composite; Main's options never
affect regions. Fill blends `image*(1-mask)+color*mask`, MASK unchanged. Crop uses
mask > 0 plus padding, clamped to that output; empty mask = uncropped. Batches kept.
**Add border** (2026-09-26): pads the output by `borderSize` px on all four sides
(current image px, default 64) with `borderColor` (default `#ffffff`); MASK is padded
to the same size, the border area white (1) when `borderMask` is on (default: marks the
border for outpainting, like core "Pad Image for Outpainting"), black (0) when off.
Applied after region slicing, to the one composite like the other modes. UI: the
dropdown label is **Modify** with None / Fill mask / Crop to mask / Add border; Add
border shows width, colour swatch and a "Mask border" checkbox inline. Manifest keeps
`applyMask` as the field name; new value `'border'` and fields `borderSize`,
`borderColor`, `borderMask` (missing = defaults; older readers ignore them).

**Persistence / behaviour**
- Additive v1 manifest fields (`regions`, `mainOutput`); legacy `{id,index,rect}` maps
  `slot = index + 1`; bad region records are skipped individually. Region-only and
  options-only documents count as edited (save, queue, sessions, reload).
- Region edits are undoable metadata steps (no pixel snapshots); Clear removes
  regions and resets Main options inside its undo step. Selecting a region is not a
  document edit. Solo never affects outputs.
- Side panel tabs: Layers | Outputs. The Outputs button sits next to the side-panel
  toggle (options bar, top right); O / the button again returns to Layers and the
  last tool.
- Parity fixes (editor and Python must read a manifest the same way): Python frame
  cap raised to 16384 (as the editor); the editor skips a single malformed layer with
  a toast instead of dropping the document (as Python); Python ignores non-boolean
  `invert` and non-numeric `opacity` (as the editor).
### Floating selections + clipboard (M10) -- agreed design (2026-09-26; done, browser-verified)
**Floats** (transient editor state, never a document layer, never saved; drawn above
their own layer; whole-pixel moves, no resampling).
- Move tool (`V`) with a selection: drag starting **inside** the selection lifts the
  selected pixels of the current layer (hole left behind) and floats them; Alt+drag
  floats a copy. Drag starting **outside** moves the whole layer as today. Ctrl
  auto-select is off while a selection exists (PS).
- Marquee / lasso / wand: plain drag inside the selection moves only the outline;
  Ctrl+drag inside = lift and move pixels; Ctrl+Alt+drag = copy-move; Alt = subtract
  (unchanged).
- The selection outline always moves with what moves: floats, and whole-layer moves
  (new: today a layer move leaves the selection behind).
- While floating: drag again, arrows nudge (1 / Shift 10 image px). Commit = Enter,
  deselect (Ctrl+D), tool switch, or any other edit. Esc or Ctrl+Z while floating =
  cancel (everything back). A committed float = one undo step (one patch on that layer).
- Works on the current mask with Quick Mask on. Text layer -> usual rasterize prompt.
  Hidden / solo-hidden / locked layers -> the usual `editBlockNote`.
- Pixels moved beyond the maximum paint area are cropped.

**Merge Down (Ctrl+E)**: merges the current row into the next row below of the same
group (paint/text into paint, mask into mask); one undo step. Same rule for both (PS):
the lower row keeps its name / settings, the upper one's opacity is baked in (paint).
Masks: coverage = union of each mask's effective coverage (per-mask invert applied),
stored under the lower mask's invert and colour. Refused with a note if either row is hidden or locked or there is nothing below;
text is rasterized (prompt). No Merge Visible, no multi-select (repeat Ctrl+E).

**Clipboard**
- Ctrl+C copies the current layer's selected pixels (whole layer without a selection)
  and writes a PNG to the system clipboard. Ctrl+Shift+C = copy merged (what is
  visible, incl. the image). Ctrl+X = copy + clear selected (one undo step).
- Ctrl+V: system clipboard image (browser `paste` event; keydown not blocked so the
  event fires; only while the editor owns the keyboard) else ComfyUI clipspace image
  else nothing. New paint layer at 100% (1 px = 1 image px), centred in the view, one
  undo step; Quick Mask turns off. Ctrl+Shift+V = paste in place (copied position,
  own copies only). Larger than the paint area -> cropped + toast.
- Buttons Copy / Cut / Paste at the bottom of the left rail, directly above Undo / Redo, with a separator rule above and below the group; long-press
  Paste offers System / Clipspace. Clipspace access only through `app`; if it isn't
  reachable cleanly, skip clipspace.
- Dropping image files on the canvas = paste at the drop point.
- Pasted layers are ordinary layers; M11 may keep the pasted source until the next edit
  so Free Transform resamples from it.
- Idea for M12, not M10: pulling an image from another node = the "Copy from input N"
  inputs (no auto-disconnecting "drop" input).

### Background row + drawing resolution (post-M10) -- agreed design (2026-09-27; done, browser-verified)
**Background row** (do first)
- Eye and solo on the background row (it stays unselectable and uneditable).
- Eye off: the editor shows transparency (checkerboard) instead of the image; the
  `IMAGE` output (Main and regions) uses the `background` widget colour instead of the
  input image (the eye affects outputs, like other layers). Saved in the manifest as an
  additive field (missing = visible). Copy merged then excludes the image.
- Solo on the background: view only, never outputs (same rules as other solos: one
  paint-group solo; soloing the background hides all paint layers; masks unaffected
  unless a mask is soloed too).

**Drawing resolution** (after the background row)
- Minimum frame: when a document's frame is set from an image, scale it
  proportionally so its short side is at least 1024 px, but the boost never makes the
  long side exceed 4096 (images already >= 1024 on the short side are unchanged).
  Editor and Python agree through the saved frame (Python just reads it).
- Mismatch notice: when the current image needs more than 1.5x the frame's resolution
  (fit scale > 1.5), the options bar shows "Drawing grid W px -- image W px (N.Nx)"
  with a **Match image resolution** button (visible regardless of tool), the Move
  drawing icon turns red, and a one-time toast per document session points to it.
- Match image resolution: resamples every paint and mask layer once so the frame
  becomes what it would have been from this image (incl. the minimum rule); the drawing
  stays where it is on screen (placement folded in); text layers re-render from
  `textData`. Upscale only. Not undoable: a confirm explains it clears the undo
  history, then history is cleared.

### Free Transform (M11) -- agreed design (2026-09-27; done, browser-verified)
**Targets** (**Ctrl+Alt+T** -- Chrome reserves Ctrl+T; Photopea convention -- from any tool while the editor owns the keyboard, or the Transform
button): with a selection -> lift the selected pixels of the current layer as a float
(M10 lift) and transform it; without -> the current layer's whole content; an active
float -> that float. Masks (Quick Mask) like paint. Text -> `textData` (M11b). Hidden /
solo-hidden / locked / empty -> the usual note.

**Handles** (Photoshop CC): bounding box, 8 handles + centre mark. Drag inside = move;
handle = scale, **proportional by default, Shift = free**, Alt = around the centre; drag
just outside a corner = rotate (curved-arrow cursor), Shift = 15 deg steps. Cursors per
hover zone. No skew / distort / perspective / warp / movable pivot / multi-layer.

**Options bar while transforming**: X, Y, W %, H %, angle (scrub fields), proportion
lock, Flip H, Flip V, commit (check) and cancel (x) buttons.

**Commit / cancel**: commit = Enter, the check button, tool switch, any other edit (the
float commit hub `settleFloat`). Cancel = Esc, x, or Ctrl+Z (cancels the whole session;
no per-adjustment undo). One undo step per commit. Preview draws the original pixels
through the current matrix (smoothed); commit resamples **once** from the original
(high quality), never cumulatively within a session.

**Transform button and flips** (options bar, not the rail): shown in the Move tool bar
always, and in the selection tools' bar while a selection exists; Transform = Ctrl+T.
Flip H / Flip V next to it: with a selection -> lift the selected pixels and flip them
into a float (not committed; Enter / the usual rules commit it); without -> flip the
whole layer about its content centre, one undo step. Flips are exact pixel mirrors (no
resampling). While transforming, flips are part of the session. Text -> rasterize prompt.

**M11b**: text layers: rotation (around the text box centre) + uniform scale stored in `textData` (rotation added; angle field in the Text tool options for the selected text layer; creating text does not clear a selection, as PS;
size scaled; re-rendered, stays editable); non-uniform scale or flip -> rasterize prompt.
Kept original: after a transform commit the layer keeps its pre-transform pixels + the
cumulative matrix in memory until any other edit of that layer; a later Ctrl+T on it
transforms from that original (5 x 10 deg = one 50 deg resample). Not saved; freed on
reload, layer delete, or memory pressure. Pastes benefit the same way.

### Image sources (M12) -- agreed design (2026-09-27; done, browser-verified)
- One optional input `layer_source` (IMAGE), below `image` in the socket row (no extra node height). No Autogrow, no helper node, no input regions.
- Session history: the last 10 distinct images seen on `layer_source`, newest first; a repeat moves to the top. Session only (in memory, per node instance), never in the manifest or workflow.
- Sources: the upstream preview before a run (LoadImage-style, same lookup as the background), else the preview Python returns after a run (first image of a batch).
- "Images" button next to Paste with a count badge; disabled while the history is empty. Opens a narrow panel over the left of the stage: vertical thumbnail list. Click outside / Esc closes it. Not in the node's socket/title area (renderer-owned).
- Clicking a thumbnail: new paint layer at the source's full resolution, Free Transform opens at once (large images start scaled to fit the image area, small ones at native size, centred; resampling from the original, no loss). Commit = one undo step; cancel (Esc / Ctrl+Z) removes the layer as if nothing happened. Selection cleared, like paste.
- No manifest change.
- Later (after M12): the user's custom folder loader sometimes shows the `input/` default after a page refresh -- check the upstream lookup order (widget value vs the loader's own preview).

### Image Mask / Input Mask (M13) -- agreed design (2026-09-28; done, browser-verified)
- One fixed mask row (layer-row scaffolding), directly above Background. Never deleted, reordered or painted on; eye (on by default), overlay colour, invert. Ctrl+click = selection; Duplicate = an ordinary editable mask layer.
- Name follows the source: "Image Mask" (from the background image's alpha) or "Input Mask" (from a `mask` input, later step). Tooltip: a connected mask input replaces the image's alpha.
- M13a, image alpha: shown only when the upstream background file has alpha (any pixel < 255). The editor fetches it with `/view?...&channel=a` (the background itself uses `channel=rgb`). Coverage = 255 - alpha (LoadImage's MASK polarity).
- Stored like a mask layer: the editor uploads the alpha as a PNG when the SOURCE changes (not on edits; it isn't editable); the manifest references it with its settings. Python combines it into the MASK outputs when visible (same rules as other masks). A stale file (size differs from the input image) is skipped with a log line.
- M13b, `mask` input (2nd input, after `image`; `layer_source` moves to 3rd): replaces the image alpha while connected (row named "Input Mask"; the alpha upload stops); disconnect = back to Image Mask if the image has alpha. Row settings (eye, colour, opacity, invert) survive a source change. No pixels stored (Python has the tensor), like the background.
  - Live source: when `mask` comes from a MASK-typed output of any node that shows a `/view` file -> `channel=a` of that file (updates at once). Exception: core Load Image (as Mask) with a non-alpha `channel` (can't be split by `/view`) waits for a run. Otherwise: a Python mask preview after a run; before it the row shows empty with "Run the workflow to load this mask" (Python still uses the mask). After a run the Python preview always wins over the live read.
  - Python: mask size != image -> resized to the image (ComfyUI convention). Batch: mask n for image n when counts match, else the first mask for all. LoadImage's 64x64 all-zero placeholder = no mask. A 4-channel IMAGE is used as RGB (alpha ignored).
- M13c: per-output "Alpha" checkbox next to the Modify dropdown (not a dropdown choice): that output's IMAGE gets 4 channels, alpha = 1 - that output's final mask (after Modify). Combines with None, Crop to mask and Add border; hidden while Modify = Fill mask (fill and alpha cancel out; value kept). Add border: the border's alpha follows "Mask border" (masked = transparent). MASK output unchanged. Manifest: additive per-output `alpha: true` (written only when on). Tooltip: some downstream nodes use RGB only and drop the alpha.

### Layer masks (M14) -- agreed design (2026-09-28; done, browser-verified)
Editing masks, not output masks: they hide part of a paint layer non-destructively and never reach the MASK outputs.
- **Scope:** paint layers only (not text, mask layers, Image/Input Mask or Background). A rasterized text layer is a paint layer and can get one. One mask per layer, always linked to it.
- **Pixels:** 8-bit grayscale in the ComfyUI mask convention (same as our mask layers): **white = hidden, black = shown**, grey = partial. Stored, shown in the thumbnail and in the Alt view that way. Same extent as the layer; the area outside the stored pixels uses the mask's `outside` value (show, or hide for a hide-all mask).
- **Row:** a tiny "add layer mask" icon right of the layer thumbnail (no footer button -- it would be confused with Add Mask). Click = a mask that shows all; with a selection = shows only the selection; Alt+click = hides all. Once added, the icon becomes the mask thumbnail.
- **Target:** click the layer thumbnail = edit pixels; click the mask thumbnail = edit the mask (highlighted frame). One target at a time; clicking elsewhere on the row keeps the layer's current target.
- **Mask thumbnail modifiers:** Shift+click = off/on (red X, layer shows unmasked); Alt+click = view the mask alone as grayscale in the stage (Alt+click again, or clicking a thumbnail, ends it); Ctrl+click = selection of the lmask's SHOWN (black) part, soft (+Shift add, +Alt subtract, +Shift+Alt intersect) -- the inverse of a cmask's Ctrl+click (white), so selection -> add lmask -> Ctrl+click round-trips.
- **lmask-only view (Alt+click):** stays on (following the new layer) when clicking another paint layer's lmask thumbnail or a paint layer row whose target is its lmask; ends on a paint layer without an lmask or targeting its pixels, any cmask row (incl. Image/Input Mask), and a click on the Background row. While in it, that layer's lmask is editable even if the layer's eye is off (Photoshop); outside the view a hidden layer's lmask is refused like its pixels.
- **Options bar while the mask is targeted:** a "Layer Mask:" label, then Invert (a setting, like mask layers; not a pixel change), Apply (bake into the layer pixels, one undo step), Delete (remove, undoable).
- **Painting on the mask:** while a layer mask is targeted, the colour swatches are replaced by black/white mask swatches (same look; only black or white). The brush and fill paint the foreground swatch: white hides, black reveals, at the tool's opacity / flow / hardness. **X swaps them** (the normal swatch swap). The real colours are untouched and return when the target leaves the mask.
  - Bucket / magic wand sampling (Photoshop, user-checked): in lmask-only view both sample only the lmask's grayscale, whatever the sample option. Otherwise "current layer" = the layer's raw pixels (lmask not applied), "all" = the visible composite with lmasks applied. The bucket floods like a normal fill and writes the foreground mask swatch into the flooded area.
  - Eraser always reveals (clears coverage).
  - Delete / Alt+Backspace behave as on mask layers.
  - Selections clip mask painting as usual. Other pixel tools (shapes, line, text) refuse with a note.
- **Display:** the live composite while editing (no auto solo, no red overlay); the solo button still works manually. Alt+click view for the mask alone.
- **Engine:** one mask canvas per masked layer; the compositor caches the masked layer and rebuilds only when the layer or its mask changes. Undo uses the existing dirty-rect patches.
- **Saved:** additive per-layer manifest field `layerMask: { file, enabled, invert, outside }` + a PNG like mask layers (no version bump if old documents load unchanged). Python applies it when compositing, matching the editor; `fingerprint_inputs` includes the file.
- **M14b interactions:** Move, Free Transform (incl. kept original) and flip carry the mask with the layer. Merge Down uses the masked result with a note ("Layer mask applied"; undo reverts). Copy / cut copy the masked result. Ctrl+click on the layer row = the layer's own pixels (mask ignored). Selection floats (Photoshop, user-checked): with the layer's pixels targeted, a selection move / transform / flip lifts the pixels only and the lmask stays put; with the lmask targeted, it lifts the lmask's pixels (the layer stays). Whole-layer Move, Free Transform (incl. kept original) and flip always carry the lmask. Apply (options bar) bakes the lmask into the pixels (one undo step) and removes it.

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
Purpose: switch masked areas on/off independently and tell them apart by colour. Mask order has no effect on output (union); reorder is only for organising.
- [x] Add / delete / reorder mask layers, **max 7** (one for the main output + 6 for M9 regions); **at least one** always exists (the last can't be deleted -- clear it instead). Mask rows always stay above paint layers (drag can't cross). Each has its own color, overlay opacity, invert, visibility
- [x] Names "Mask 1", "Mask 2", ... (lowest free number, like "Layer N")
- [x] Default colors: the first mask uses `DefaultMaskColor` / `DefaultMaskOpacity`; later masks take the first palette colour not already used by a mask: blue, green, yellow, magenta, cyan, orange (opacity = `DefaultMaskOpacity`); user can change any
- [x] The **current mask** = the last selected mask row; Quick Mask paints into it. Clicking a mask row selects it and turns Quick Mask on; the Quick Mask toggle uses the current mask. The current mask row is marked (see "Current-mask bar")
- [x] Invert is per mask, applied **before** the union; the node's `invert_mask` input inverts the final union (unchanged)
- [x] `MASK` = union of visible masks (unchanged rule); hidden-mask note covers any hidden mask with content
- [x] Undo for add/delete/reorder like paint layers; masks are not tied to paint layers
- [x] No saved-file contract change (Python `combine_mask_layers` already unions N masks)
- [x] **Current-mask bar** (replaces the `*`): the current mask row has a thick left bar in the mask's own colour, always (Quick Mask on or off); the normal selected-row highlight adds on top when Quick Mask is on
- [x] **Solo (view only)**: a small solo button on each paint/text/mask row and the background (Alt+click on the eye removed 2026-09-27). Up to one solo paint/text layer AND one solo mask at a time (soloing another row in the same group replaces it; clicking the active solo again ends it). While any solo is set the canvas shows only the background + the soloed layer and/or soloed mask (everything else is hidden, both groups; changed 2026-09-26 after testing). A hidden layer can be soloed (shown while soloed). Eyes are never changed; all other rows get dimmed eyes and the soloed row a highlighted eye/solo button. Not saved, not undoable, no effect on outputs; ends if the layer is deleted. Editing (paint, fill, move, text) a layer the solo hides is refused with "The layer is hidden by solo." (after the eye-hidden note, before locked). Soloing never changes the selection (peek). A layer created while any solo is on (new layer, new mask, duplicate, new text layer) takes over its group's solo
- [x] **Ctrl+click / Move layer (`V`) auto-select with Quick Mask on** picks the topmost visible mask with coverage under the pointer, makes it the current mask and drags it; with Quick Mask off, unchanged (paint/text only)

### M9 -- Output regions + output options
Design: "Output regions (M9) -- agreed design". First pass (dynamic sockets) replaced.
- [x] Main node outputs `IMAGE`, `MASK`, `regions`; helper `PainterSketch Regions` with 12 fixed outputs, live labels, empty slot = silent block
- [x] Regions in image px from top-left, never rescaled; may extend outside the image (background colour + off-image paint/mask)
- [x] Outputs tab = region mode (other tools -> Layers tab); rail button by the panel toggle, shortcut O; draw / move / resize, Shift-drag = new region, empty click = Main
- [x] Six fixed slot cards (`+ Region N` when empty), layer-style titles (double-click rename), icon set, X/Y/W/H, options row
- [x] Subdued overlay outside region mode; Main selection highlights the image border
- [x] Output options per output (Main + regions): None / Fill (colour) / Crop to mask (+ padding)
- [x] Add border option (width, colour, "Mask border" checkbox); dropdown renamed "Modify", Fill -> "Fill mask"
- [x] Saved in the document, undoable, Python applies them; batches kept
- [x] Parity fixes (frame cap, lenient bad layer in the editor, strict invert/opacity in Python)
- [x] Code/doc style brought to the project standard (section headers, TSDoc, no dense one-liners, no duplicated helpers)
### M10 -- Floating selections + clipboard
Design: "Floating selections + clipboard (M10) -- agreed design".
- [x] M10a: floats (Move tool + marquee Ctrl / Ctrl+Alt), selection-outline move with marquee tools, selection follows layer moves, Enter/Esc/commit rules, one undo step per float
- [x] M10a: Merge Down (Ctrl+E) for paint and masks
- [x] M10b: Ctrl+C / Ctrl+Shift+C / Ctrl+X / Ctrl+V / Ctrl+Shift+V; system clipboard first, clipspace fallback; Copy / Cut / Paste buttons (long-press Paste: System / Clipspace)
- [x] M10b: drop image files onto the canvas = new layer

### M11 -- Free Transform (Ctrl+T)
Design: "Free Transform (M11) -- agreed design".
- [x] M11a: Ctrl+Alt+T / Transform button; handles (scale, rotate outside corners, move inside); proportional by default, Shift = free, Alt = from centre, Shift-rotate = 15 deg; options bar fields + flips + commit/cancel; one resample from the original on commit; one undo step
- [x] M11a: Flip H / Flip V buttons (Move tool; selection tools with a selection)
- [x] M11b: text layers: rotation + uniform scale in `textData` (non-uniform / flip -> rasterize prompt)
- [x] M11b: keep the pre-transform original per layer until its next other edit (repeat transforms resample from it; memory only)
- [x] No saved-file contract change: pixel layers are resampled on commit, text is rasterized as always

### M12 -- Extra image inputs
- [x] Optional `layer_source` input; Python returns its preview (first of batch) when present
- [x] Session history (10, deduped, newest first) fed by the upstream preview and executed previews
- [x] Images button + badge next to Paste; left thumbnail panel
- [x] Thumbnail click = new layer in Free Transform (fit if large); cancel removes the layer; commit = one undo step

### M13 -- Image Mask / Input Mask
- [x] Background loads with `channel=rgb` (matches LoadImage's IMAGE) (browser-verified)
- [x] M13a: Image Mask row from the image's alpha, uploaded on source change, combined by Python
- [x] M13b: optional `mask` input (2nd) -> Input Mask, no stored pixels
- [x] M13c: per-output Alpha checkbox (RGBA IMAGE)

### M14 -- Layer masks
- [x] M14a: add (show all / selection / hide all), mask thumbnail + target, off/on, invert, Alt view, Ctrl+click selection
- [x] M14a: painting (black/white mask swatches + X, eraser reveals, fill, Delete), selection clip, other tools refuse
- [x] M14a: compositor cache, undo, manifest `layerMask` + PNG, Python applies it
- [x] M14b: Move / Free Transform / flip carry the mask; Merge Down + copy use the masked result; Apply; floats (remove the interim `"whole"` gate)
- [x] M14c: composite transparency joins the output masks (see Decisions Log 2026-09-28 "Transparency in outputs")

### M7b -- Release polish (last)
- [ ] README: real feature list, drawing-vs-image model (fit, paint area, Match image resolution), shortcuts table, screenshots/GIF, install, storage + cleanup explanation
- [ ] Example workflows (`example_workflows/`): e.g. LoadImage -> PainterSketch -> inpaint (Crop to mask); regions -> per-person prompts
- [ ] Selection "add" cursor badge (+) looks too much like the copy-move cursor (+); make them distinct
- [ ] Maybe: cursor hints for lmask thumbnail modifiers (Alt+click = eye in a square, Shift+click = red X)
- [ ] "Not allowed" cursor (circle with a cross) over the canvas when the current tool can't edit the current target (hidden, locked, wrong target kind)
- [ ] Maybe: while soloed, a hidden layer is editable (you can see it)
- [ ] Maybe: small mask glyph by the brush ring while painting on a mask / layer mask (overlay-drawn, not a CSS cursor)
- [ ] Full manual checklist (AGENTS.md "Testing") in both renderers before the first release

### Handoff notes (for the next session)
- M0-M6, M7a and M8-M13 are done and browser-verified; the user commits. Update checkboxes + Decisions Log as work lands.
- Main (coordinating) session: read `AGENT_ORCHESTRATOR.md` for how to delegate to agents, verify, and report. Sub-agents don't need it.
- Terminology: "view" = pan/zoom of the stage; "Move drawing" = whole-drawing placement (layers-footer toggle); "Move layer" = the `V` tool.
- Next: M7b release polish (M14 done). File size: aim < 500 lines, hard limit 600 (AGENTS.md); no split tasks. The user will not publicly release until M8-M14 are done.
- M8 as built: current mask = `editorState.currentMaskId` (`document/masks.ts` fallback to the top mask); mask palette in `defaults/maskDefaults.ts`; solo in `engine/solo.ts` (display + "all" sampling only); every edit gate goes through `editBlockNote` in `engine/rasterize.ts` (eye-hidden > hidden by solo > locked). M9 regions will use all visible masks (union) per SPEC.
- M9 as built: design in "Output regions (M9) -- agreed design"; naming rule output vs region in AGENTS.md; main node IMAGE/MASK/regions + `PainterSketch Regions` helper (labels via `widget/regionsNode.ts` + `documentEvents.ts`); editor side `engine/regionOps.ts`, hidden `tools/region.ts`, `ui/outputsPanel.ts` / `outputCard.ts` / `outputOptionsRow.ts` / `regionOverlay.ts` / `regionMode.ts`; Python `nodes/output_processing.py`, `document_regions.py`, `painter_sketch_regions.py`.
- M12 as built: `widget/sourceHistory.ts` (session history, 10), `widget/layerSourceWatch.ts`, `ui/imagesPanel.ts`, `ui/sourceInsertAction.ts`, `engine/sourceInsert.ts` (insert = empty layer + transform session; also oversized pastes), `engine/pastePlacement.ts` (Photoshop placement rule); Python ui key `layer_source` (`nodes/previews.py`).
- M13 as built: background URL rules `widget/viewUrl.ts` (`channel=rgb` / `channel=a`), `widget/backgroundRule.ts` (only the connected upstream's image), `widget/imageSource.ts`; width/height sync `widget/frameSync.ts` + `sizeWidgets.ts`; Image/Input Mask row `document/imageMask.ts`, `engine/imageMask.ts`, `imageMaskOps.ts`, `widget/imageMaskSync.ts`, `inputMaskRule.ts`, `inputMaskSync.ts`, `ui/imageMaskRow.ts`; Python `nodes/input_mask.py`; Alpha output `with_alpha` in `nodes/output_processing.py`, UI `ui/outputOptionsRow.ts`.
- M14 as built: lmask `document/layerMask.ts`, `engine/layerMask.ts` (gates), `layerMaskOps.ts` (add/apply/paint/view), `layerMaskCarry.ts` (move/transform/flip/floats), `tools/layerMaskBar.ts`, `ui/layerMaskThumb.ts`; sampling targets in `engine/pixelOps.ts` (`sampleTarget`, `lmaskGray`, `visibleMasksGray`), hidden notes `hiddenNote` in `rasterize.ts`; Python `nodes/layer_masks.py`; transparency `run_transparent_composite` in `nodes/composite.py`. Layers panel dividers `ui/layerSections.ts`.- Largest files: see the Next line above. User messages go through `notify` (AGENTS.md).

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
- Whenever an image loads and the frame adopts its size, the size is written into
  `width`/`height` (only when different; rounded to a multiple of 8, clamped 64-16384).
  Disconnecting, an image-less upstream or a reload without an image keep that size.
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

- 2026-09-28: M14c code done (browser-verified). `nodes/composite.py` computes colour + alpha in one pass (`run_transparent_composite`) only when the Background eye is off; MASK = max(cmasks after invert_mask, 1 - A). Alpha on and Fill mask use the un-premultiplied colour (P / A; background colour where A = 0), so no background-colour fringe; plain IMAGE / Crop / Border without Alpha keep the flattened image. No frontend change (the editor already shows a checkerboard).

- 2026-09-28: Sample = current layer means the actual target: with a cmask targeted, wand and bucket sample its effective coverage as opaque gray (the wand sampled the last paint layer). A hidden target with current-layer sampling: the wand refuses with the hidden note (shared `hiddenNote`); the bucket refuses a hidden target always (edit gate). lmask-only view exception kept. With a cmask targeted, sample = all = the union of visible cmasks' coverage (user: consistency). Hidden cmask note shortened to "The mask is hidden." (browser-verified)

- 2026-09-28: Fixed lmask sampling: the bucket on an lmask filled the whole lmask without sampling; the wand in lmask-only view sampled the visible layers. New `lmask` sample target (`lmaskGray`, opaque gray, Invert and `outside` applied) used in lmask-only view. (browser-verified)

- 2026-09-28: Paste into an lmask: while in lmask-only view, Ctrl+V / Ctrl+Shift+V / drops paste into that lmask as a float (Rec.709 luminance x alpha; raw values, lmask Invert ignored so copies round-trip; normal placement; oversized -> Free Transform). Outside the view paste is unchanged. (browser-verified)

- 2026-09-28: M14b code done (browser-verified). `engine/layerMaskCarry.ts`: whole-layer move/transform/flip carry the lmask (own kept original; one undo step). lmask-target floats lift grayscale and replace what they land on; vacated area reveals. Merge Down applies an enabled upper lmask (disabled = ignored); a lower lmask stays. Copy on pixels = masked result; on the lmask = grayscale; cut on the lmask reveals; paste always makes a new paint layer. Apply also bakes a disabled lmask (user-confirmed: clicking Apply means apply).

- 2026-09-28: Transparency in outputs (M14c, agreed): transparency = 1 - composite alpha (only possible with the Background eye off). It joins the cmask union AFTER `invert_mask` (never inverted), for Main and every region, so Fill mask fills holes, Alpha makes them transparent, Crop/Border treat them as masked (a hole can grow the crop -- accepted). Plain IMAGE keeps the background colour under holes. With Alpha on, RGB under partial transparency is the layers' own (un-premultiplied) colour, not blended with the background colour (no fringe). Mirrors LoadImage (RGB + MASK from alpha).

- 2026-09-28: Terms: **cmask** = standalone mask rows (Mask N, Image/Input Mask), **lmask** = a paint layer's layer mask. lmask Ctrl+click selects the shown (black) part; lmask-only view stick/end rules; hidden layer's lmask editable only in lmask-only view. Built: Alt+click on an lmask thumb also makes it the target; the view follows the active layer while its target is its lmask (Quick Mask off); solo-hidden layers are editable in the view too; adding an lmask from a selection grows bounds to cover it. (browser-verified)

- 2026-09-28: Layer masks switched to the ComfyUI mask convention (white = hidden), matching our mask layers -- the Photoshop polarity was confusing next to them. The brush's Hide/Reveal state is replaced by black/white mask swatches in place of the colour swatches (X swaps). "Layer Mask:" label in the options bar. Layer names wrap to 2 lines, then ellipsis, vertically centred. Built: `outside` reveal=0/hide=1; `file: null` = all shown; clicking a mask swatch does nothing; eyedropper refused on a mask target; Delete reveals / Alt+Backspace hides (as mask layers). (browser-verified)

- 2026-09-28: M14a code done (browser-verified). Ctrl+click on the mask thumbnail = soft coverage (row Ctrl+click stays hard). Enable not undoable (like the eye); add/delete/invert/strokes are. `layerMask` written only when present, `file: null` = fully hidden; no version bump. Interim gate for M14b: the `"whole"` branch of `layerMaskBlockNote` (`engine/layerMask.ts`) via `editBlockNote`/`preparePixelEdit` kinds -- callers moveOps, mergeDown, floatLift (covers Free Transform), layerFlip, clipboard copy/cut. Bucket hides at its opacity; Alt+Backspace hides.

- 2026-09-28: File-size rule changed (user): aim < 500 lines, hard limit 600; no split tasks, no new modules just to save lines. A 30+-file split was reverted.

- 2026-09-28: M14 layer masks designed (see "Layer masks (M14)"): paint layers only; row icon -> mask thumbnail; Shift/Alt/Ctrl+click like Photoshop; Invert/Apply/Delete in the options bar; colour ignored (brush hides, X toggles the brush to reveal while a mask is targeted, eraser reveals); live view, no auto solo, no overlay; Merge Down/copy use the masked result.

- 2026-09-28: Layers panel section dividers (`ui/layerSections.ts`): 2px accent bar (matches the active side-tab underline) wherever the group changes (masks | paint/text | Image/Input Mask + Background); not rows, not drop targets. Row / output-card separators 2px. Custom loader: refresh glitch gone with the reroute walk in `findUpstreamOutput`; inserts from any `type=input` preview use the file stem (user's edit in `imageSource.ts`). (browser-verified)

- 2026-09-28: Output card layout: line 1 = Modify select (never shrinks below its longest option) + Alpha (hidden for Fill; Fill's swatch takes its place); line 2 = extras (Pad / W + colour + Mask border, wrapping); Pad/W sized for 4 digits. (browser-verified)

- 2026-09-28: M13c code done (browser-verified). Alpha checkbox on output cards (`ui/outputOptionsRow.ts`); Python `apply_output_options` runs Modify, then `with_alpha` appends 1 - the returned MASK (skipped for Fill); Main and regions share the path.

- 2026-09-28: Input Mask live rule relaxed (user): any MASK output of a node showing a `/view` file (LoadImageMask only on alpha); a wrong guess lasts until the first run, when the Python preview wins. Duplicating the Image/Input Mask takes the next free mask colour (`nextMaskStyle`). (browser-verified)

- 2026-09-28: M13b code done (browser-verified). Manifest keeps the `imageMask` record: while `mask` is linked, `sourceKey` starts with `mask:` and `file` is null (no version bump). Python: `nodes/input_mask.py` (bilinear resize copied from ComfyUI's `resize_mask`, batch n-for-n else first), `nodes/previews.py`; ui key `input_mask` (first mask, grayscale, `mask_id`; LoadImage placeholder = `empty`). 4-channel IMAGE was already sliced to RGB (now tested). The run preview wins only while it matches the same mask link AND the same live file; if the LoadImage file changes after a run, the new file is read live until the next run.

- 2026-09-28: width/height sync to every loaded image size (replaces copy-on-disconnect); TS widget max raised to 16384 to match Python; fingerprint ignores width/height while an image is linked. Known: a new size from our executed preview still re-runs the node once on the next queue (widget values are in ComfyUI's cache key). (browser-verified)

- 2026-09-28: Background source rule (`widget/backgroundRule.ts`): show only the connected upstream's own image, or our executed preview from a run with the same origin node + slot; an upstream with no image = blank like disconnected (fixed: the loader kept the last image). Image Mask row removed (and its manifest entry) when the source goes away or changes to another key; kept while the same key reloads, for our same-link executed preview, and on page reload. Later UI idea: dividers between paint layers / masks / input section (Image Mask + Background). (browser-verified)

- 2026-09-28: M13a code done (browser-verified). Manifest optional `imageMask: {file, visible, color, opacity, invert, sourceKey, width, height}`, no version bump (additive). `channel=a` drops `preview` (else lossy webp of the whole image). Alpha read once per upstream source key; our executed preview keeps the current row. A row alone counts as document content. Merge Down from it refused; eye not undoable (like other masks). Python uses it only with an image connected, visible, exact size.

- 2026-09-28: Background ignores file alpha: `/view` background URLs get `channel=rgb` (`widget/viewUrl.ts`, applied in `backgroundLoader`), matching LoadImage's 3-channel IMAGE. layer_source thumbnails unchanged. Next (M13, design pending the user's test): optional `mask` input (2nd), an "Input Mask" row on the normal layer scaffolding, always shown when connected, eye on; live source TBD (`channel=a` of LoadImage's file before a run vs Python preview after); Modify "Mask as alpha (RGBA)". Mask-editor facts: 4 clipspace files in input/ root, one merged alpha, RGB kept under it. (browser-verified)

- 2026-09-27: A paste/drop that would reach past the paint area opens as a Free Transform session on the full image at native size (same path as Images-panel inserts; commit crops, one undo step; Esc removes it), with a note. Fitting pastes unchanged. Later idea: inverted selections bounded by the image area. (browser-verified)

- 2026-09-27: Paste placement = Photoshop (user-measured), `engine/pastePlacement.ts`: selection -> centre on its bbox (never resized); else own copy from this editor -> in place; else whole image area visible -> its centre; else view centre. Always clamped inside the image area (oversized = centred), pixel-snapped. Drops keep the drop point + clamp; Images-panel inserts use the selection/visible rules + clamp. Long layer names ellipsize (side panel fixed width). (browser-verified)

- 2026-09-27: M12 follow-ups (browser-verified): history cap 10, scrolling list; the Images panel stays open on clicks outside the node and closes on Esc / stage press / rail tool / its button; a new history image auto-opens it (not on load, not repeats). Inserted layer = file name (LoadImage) or "Image N". Stage label under the image area shows its pixel size. width/height widgets `hidden` while `image` is connected (fallback only; order and values unchanged).

- 2026-09-27: M12 code done (browser-verified). Preview under `ui.layer_source` with a content-hash `source_id` (dedupes re-runs). Insert = empty layer + transform session on the full source; commit folds creation into one undo step, cancel undoes and drops it from redo. Sources > 8192 px per side are downscaled on load with a note.

- 2026-09-27: M12 redesigned: one `layer_source` input + session-only history of 5 thumbnails in a left panel (Images button by Paste); a click inserts in Free Transform, cancel removes it. Dropped: Autogrow inputs, helper node, input regions, drop-and-disconnect.

- 2026-09-27: M11 complete (browser-verified): Free Transform, flips, text rotation/scale, kept original (a re-used transform shows its box at the previous angle). Text W/H fields honour Link (unlinked -> rasterize prompt after the field session).

- 2026-09-27: Ctrl+click layer selection is HARD: every pixel with alpha > 0 (mask: effective coverage > 0) is selected at 255. A soft (alpha-weighted) selection left a residue of a*(1-a) on every edge when moved and ghosted on repeat. `selectionFromAlpha` stays soft for other callers.

- 2026-09-27: M11b code done (browser-verified): `textData.rotation` (deg, around the box centre); textarea edited in place with the same CSS rotation; text transform sessions keep W/H linked, a non-uniform drag or flip asks to rasterize after release (No = drop the change, Yes = text step + rasterize step, continue as pixels). Kept original (`engine/keptOriginal.ts`): valid only while the layer's pixel revision is unchanged (any edit / undo / redo on it drops it), 128 MB cap per editor, oldest first; selection-float commits keep it only if the layer was otherwise empty; pastes keep the pasted pixels at identity.

- 2026-09-27: Ctrl+click a layer row = selection from its alpha (PS thumbnail Ctrl+click); Ctrl+Shift add, Ctrl+Alt subtract, Ctrl+Shift+Alt intersect; masks use effective coverage (invert applied); empty layer -> note, selection unchanged; hidden layers allowed; current layer unchanged; hover cursor shows the mode. Marquee cursor badges now use the rail marquee icon. Browser-verified.

- 2026-09-27: Free Transform shortcut = Ctrl+Alt+T (Chrome's Ctrl+T new tab can't be cancelled). Committing a selection/float transform keeps it a float (original pixels + cumulative matrix kept; re-transform resamples once from the original; the float commits by the M10 rules, one undo step). Whole-layer transforms commit straight into the layer. Rotate cursor = two circling arrows.

- 2026-09-27: M11a code done (browser-verified): a transform session = a float with a matrix (`engine/transformOps.ts`, `transformMath.ts`, `transformResample.ts`; hidden transform tool). Edge handles proportional when locked (modern PS); X/Y = box centre in image px. Commit resample = pure-JS bilinear with up to 4x4 supersampling when shrinking (testable; whole-px moves / flips exact). Esc mid-drag cancels the session; clicking outside the box does nothing.

- 2026-09-27: M11 design agreed (see its section): proportional scaling by default (Shift = free), Ctrl+Z cancels the session, kept original per layer in memory (M11b), text = rotation + uniform scale only, Transform + Flip buttons in the options bar (Move tool; selection tools with a selection), a flip with a selection leaves a float. Split M11a / M11b. (Restored the lost `## Milestones` heading.)

- 2026-09-27: Cobweb backdrop = TS port of the user's `temp.cobweb-backdrop.js` (`engine/cobweb/`): grows from the maximum paint-area rect, inline Vite worker (single bundle kept; main-thread fallback), drape maxAngle 160 / length 80 (= 47 steps) / start 3% / ramp 12%; grown once without animation, a plain click on the web regrows it animated (observe-only, no undo). Browser-verified.

- 2026-09-27: Clear is a normal undo step on top of earlier history (verified by test; image-size changes don't touch document coords, and undoing Clear restores the old frame, so earlier patches line up). Second notice case: the image area doesn't fit the maximum paint area -> "The image's shape doesn't fit the drawing" + Match image resolution (one notice when both apply). Match never lowers resolution (frame enlarged proportionally if needed, 16384 cap). README (M7b) should explain the image area vs drawing model (why the drawing fits onto a changing upstream image, like video overlays / annotations, unlike PS where the canvas is the document).

- 2026-09-27: After Clear the document adopts every size change like a fresh one while nothing is drawn (only selection steps since the Clear). Adoption is not a history step; undoing the Clear restores the drawing at its original frame / bounds / placement; redo returns the cleared doc at the last adopted frame.

- 2026-09-27: Maximum paint area changed from 3x the frame per axis to the frame plus its SHORT side as a margin on every side (`boundsCap`, `marginFactor: 1`; 16384 per-axis cap unchanged). Square frames are unchanged; long frames no longer get a huge long-axis margin. Python has no copy of the rule (reads saved bounds). Existing bounds beyond the new cap are kept. Paint-area border + cobweb texture outside it on the stage (`engine/cobweb.ts`).

- 2026-09-27: Placement clamp is interaction-only (supersedes the load / image-size clamp and write-back in the "Move drawing clamp" entry): nothing automatic changes the user's placement; Reset = identity always; from a state that already breaks the 50 px rule, an edge may move outward or stay but never further inside (no jump). Match image resolution also resets to identity.

- 2026-09-27: Drawing resolution code done (browser-verified): `engine/drawingResolution.ts` `minimumFrame()` used by new documents, empty-doc adoption and Clear (also the no-image width/height path). Mismatch ratio = resample factor Match would apply (image px per doc px incl. placement scale, relative to a fresh frame from this image). Match keeps all content; bounds beyond 16384 are clipped centred with a warning line in the confirm. Python unchanged (reads the frame).

- 2026-09-27: Merge Down button in the layers footer (Move drawing | New layer, New mask, Duplicate, Merge Down, Delete), disabled when not possible. Alt+click eye = solo removed (solo button only). A paint solo keeps the image per its eye (the background has its own eye).

- 2026-09-27: Background row code done (browser-verified): manifest `backgroundVisible` (written only when false); eye not undoable (same as layer eyes); "background" sample mode still samples the image when hidden; background solo = paint-group solo (reserved id); a paint solo keeps the image as its eye says; node preview still shows the input image.

- 2026-09-27: Move drawing clamp (browser-verified): the maximum paint area always covers the image area + 50 image px per side (drag, nudge, wheel scale, fields, Reset, on load / image-size change with metadata write-back, not undoable). Scale max 20 -> 10 (editor + Python). Fallback when impossible: scale 10, centred. Reset = nearest valid placement (not always identity). Undoing Clear may restore an unclamped placement until the next move / size change.

- 2026-09-26: M10 complete (browser-verified). Terminology: the "image area" = the current image rectangle on the stage (where pastes centre). Empty-paste notes phrased alike: "The clipboard has no image -- nothing to paste." / "Clipspace has no image -- nothing to paste." Next: background row (eye + solo), then M11.

- 2026-09-26: M10b round 2 (browser-verified): Ctrl+V / button pastes centre on the image (not the view); Paste menu items always enabled, empty source = note; paste source remembered per button like tool groups (removed a page-wide module variable); copy refuses hidden / solo-hidden layers (locked may be copied); browser image drags claimed at dragenter/dragover (Chrome reports the dragged file type blank).
- 2026-09-26: Background row (AFTER M10, not now): eye + solo on the background row; eye off = transparent (checkerboard) in the editor; outputs use the `background` widget colour instead of the image (eye affects outputs, like other layers); copy merged then excludes the image. Selectable background row deferred.

- 2026-09-26: M10b fixes (browser-verified): Ctrl+V = system image > own copy > clipspace; Ctrl+Shift+V = own copy in place only; clipspace explicitly via the Paste button menu (choice sticks, C-badge icon); paste/drop clears the selection (same step); copy merged with Quick Mask on = union of visible masks; browser image drags (img src / uri-list, CORS failure toast); ellipse marquee icon dashed. Paste offset likely was the clipspace fallback under Ctrl+Shift+V.

- 2026-09-26: M10b code done (browser-verified). Clipspace read via `app.constructor.clipspace` (static on ComfyApp, runtime-guarded). Masks copy as opaque grayscale. Cut without a selection cuts the whole layer (PS disables it). Pasted layers are named "Pasted", "Pasted 2", ... One layer + one undo step per dropped file. Ctrl+V adds a one-shot capture `paste` listener; fullscreen lets Ctrl+V keydown through.

- 2026-09-26: M10a browser-verified. Added PS-style move cursors (scissors = cut, + = copy, dotted rect = outline move; `ui/moveCursors.ts`); a rasterize confirm now ends the gesture first (`Tool.takeDeferred`), Yes only rasterizes; drags on an empty layer refuse at pointerdown.

- 2026-09-26: M10a code done (browser-verified). Float commit hook `EditorState.settleFloat()` (edits, layer/selection/tool changes, queue); idle/focus uploads save the pre-lift pixels; Ctrl+Y while floating is ignored; a zero-offset commit = cancel (no step); Delete while floating commits then clears (same result as PS). Merge Down is Ctrl+E only (no panel button yet).

- 2026-09-26: M10 design agreed (see its section): PS move semantics (Move: inside = float, outside = whole layer + selection; marquee: drag inside = outline, Ctrl = float, Ctrl+Alt = copy), floats are transient, Merge Down incl. masks (PS: lower row keeps its settings, for paint and masks), copy/cut/paste buttons above Undo/Redo on the rail, no Merge Visible / multi-select, paste = ordinary new layer, system clipboard first with clipspace fallback, drop files. Split M10a / M10b.

- 2026-09-26: Add border output option landed (browser-verified): width 1..4096 (default 64), colour (default white), "Mask border" (default on = white border in MASK, ComfyUI convention: white = area to change). Dropdown renamed "Modify"; "Fill" shown as "Fill mask".

- 2026-09-26: M9 done (browser-verified). Subdued outline opacity 60% -> 30% (two-tone dashes read stronger), outlined region numbers. Rename `nodes/output_regions.py` -> `output_processing.py` (it processes Main too); naming rule output vs region added to AGENTS.md.

- 2026-09-26: M9 browser-verified except the last tweaks: side panel 180 -> 216 px, number fields without spin arrows, two-tone (black/white) dashes for the subdued overlay, rule + spacing between the Outputs button and the panel toggle.

- 2026-09-26: M9 rev. 2 code landed (browser-verified): main node IMAGE/MASK/regions (`PS_REGIONS` = `PainterRegions`, 6 slots); helper `PainterSketch Regions` (12 fixed outputs, labels via `widget/regionsNode.ts` on a document-change event, no polling); dynamic socket code removed; pixel-fixed regions clamped to the 3x area, off-image = background colour + off-frame paint/mask; editor skips a malformed layer with one toast, duplicate layer ids get a fresh id; Python frame cap 16384, strict invert/opacity. Region mode = Outputs tab (hidden region tool), shortcut O; six slot cards; subdued overlay. Selecting is not a document edit.

- 2026-09-26: M9 redesigned with the user after testing the overnight first pass: main node IMAGE/MASK/regions + helper node with 12 fixed, never-disconnecting outputs; six fixed slot cards; pixel-fixed regions that may extend outside the image; Outputs tab = region mode (shortcut O); subdued overlay outside it; parity fixes. The first-pass contract section was replaced.

- 2026-09-26: M8 fully browser-verified (incl. solo). Duplicate naming changed to Photoshop's "copy N" (no growing names).

- 2026-09-26: Solo + mask bar + mask auto-select code landed (browser-verified). Solo lives in `engine/solo.ts`; the stage and bucket/wand/eyedropper "all" sampling follow it, outputs/uploads don't; ends on delete / Clear / new session. Mask auto-select uses raw painted coverage (ignores invert) and keeps Quick Mask on.

- 2026-09-26: M8 browser-verified. Additions agreed: current-mask colour bar (no `*`), view-only solo (button + Alt+click eye; one layer + one mask; hidden layers can be soloed), Ctrl/V auto-select picks masks while Quick Mask is on. Hidden note now wins over locked.

- 2026-09-26: M8 code landed (browser-verified). Palette after the first mask: blue, green, yellow, magenta, cyan, orange; first mask named "Mask 1" (old "Mask" counts as 1); new mask goes above the current mask; loaded masks below paint are moved on top. Helpers split into `ui/layersPanelParts.ts`.
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
- 2026-09-25: Brush dabs show as spacing grows (`dabBlend`, `engine/dabMask.ts`): the per-pair slide/stamp threshold (`slides()`) is gone; each segment's target is the slid profile blended towards the nearest two real dabs, 0 up to 25% spacing soft / 10% hard, 1 from 35% / 20%. Root cause of the uneven 40% line: the threshold was exactly the 40% gap for an 80 px soft brush, so pairs flipped on floating-point noise; and sliding at 40% hid the circles Photoshop shows (its line at 40% has visible, even dabs -- so PS is discrete `max`, not over: rendered comparisons rule over out). `planSegments` now also requires even spacing along the chord to merge a run. Crossing / zig-zag artifacts at 25% remain the `max` crease along acute wedges; whether PS has it too is the open question -- asked the user for 100% PNG exports (dot, self-crossing, 40%) to measure the real profile and the crossing rule before changing either. Browser-verified.
- 2026-09-25: Brush seams fixed by removing the "pass" rule from `CoverageMask` (`serials`/`before` per pixel): the coverage is now plain alpha darken over the swept profile (`c += max(0, target - c) * rate`, Krita wash mode = Photoshop) with no per-pixel history. Root cause of the artifacts (dark cracks inside shift-click corners, steps where dots overlap non-consecutively): "same pass = max, path came back = combine like a separate stroke" was decided from segment numbering, so the formula flipped between neighbouring pixels along the apex stamp's reach (24% step) and along the next dab's reach (25% step); reproduced numerically before the change. Consequences: at 100% flow self-crossings, corners, doubling back and overlapping separate dabs are all max ("one even stroke", the user's PS observation); below 100% flow coming back builds up towards the profile. Open question 1 (separate dabs building up) is answered "no" pending the user's PS check. Regression tests: `dabMask.test.ts` "no seams". Supersedes the pass part of the entry below. Browser-verified.
- 2026-09-25: Brush engine (`engine/dabMask.ts`): dabs become path segments (straight runs merged) and the stamp is slid continuously along each segment into a 16-bit JS coverage mask (A. Joshi, JCGT 2018). Photoshop model, verified by the user in PS: coverage moves towards the stamp profile at the pixel's distance from the path, never down; 100% flow = profile swept, no build-up where a stroke crosses itself; lower flow `rate = 1 - (1 - flow)^n` (n = dab steps covering the pixel). Soft stamps reach `radius x (2 - hardness)` with the fade halfway at the cursor ring (Photoshop's soft dots halo past the ring); falloff = normalized Gaussian k = 3. Default spacing 25% (Photoshop's). Spacing still matters: consecutive dabs slide only while that looks identical to stamping them (edge dip `g^2 / (8 reach)` under 0.5 px hard / 2% alpha soft; e.g. 80 px: soft slides to ~40% spacing, hard to ~16%); farther apart they are stamped as separate dabs (dotted strokes at large spacing, like Photoshop). Passes (segment serials): while consecutive segments keep touching a pixel (the path never left its reach: along a line, around a corner) it keeps the stronger value (line = profile swept, corners don't notch); once the path has left and comes back (self-crossing) a new pass combines like a separate stroke `1 - (1 - before)(1 - pass)`, so crossings fill in instead of leaving hard-edged max-of-two gaps. Spacing max 400%. Shift-click lines continue the previous stroke (same layer/style, its undo entry still newest): the kept coverage is the base and only the extra `(c - p) / (1 - p * opacity)` is composited, so start dots / zig-zag corners don't double up (Photoshop behaviour); still one undo step per click. No beads at any spacing; ~1 computation per pixel per segment (500 px soft brush ok). Replaced canvas stamp stacking (`stampCache.ts` removed; stacking saturated soft edges, 8-bit drift made rings). Browser-verified.
- 2026-09-25: Brush hardness falloff: solid core = hardness x radius, then a normalized Gaussian (k = 5, 16 gradient stops; ~0.29 alpha halfway) instead of a linear ramp, to match Photoshop's soft round (a linear ramp looked hard once 10%-spaced dabs build up). Brush, eraser, mask painting. Colour fixes browser-verified.
- 2026-09-25: Colour fixes. (1) Brush dabs accumulate as coverage only and get the colour once at composite (`stroke.ts`): coloured low-alpha dabs drifted in the 8-bit premultiplied buffer (dark "dust" rings when painting a mid-tone over the same colour). (2) Bucket/wand tolerance compares alpha-weighted colour (faint AA pixels match transparent), and with anti-alias the bucket fills *behind* the target layer's rising soft edges next to the fill (`engine/fillUnder.ts`): no halo when filling around a stroke. Browser-verified.
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
- 2026-09-24: M3 code landed (browser-verified). Shell regions (rail / options bar / stage / side panel / in-root popover host); declarative tool options with scrubby labels; `editor.ts` split into ~7 engine modules. Layers panel with a `layers` history entry type. Fullscreen moves the editor root (child of a stable `.cps-widget` wrapper) into a body overlay (z-index 1790: above ComfyUI menus, below PrimeVue dialogs/toasts). In fullscreen, keys we don't use are swallowed except browser keys (F1-F24, Ctrl+R/W/T/N/L/Tab/PgUp/PgDn, devtools, Alt+arrows) and Ctrl+S / Ctrl+Enter. Clicking editor buttons no longer takes focus from the hidden key-sink input.
- 2026-09-24: M2 browser-verified. Hidden mask layers stay excluded from `MASK`; queueing with a hidden, painted mask shows the note "The mask is hidden; show it to output it."
- 2026-09-24: M2 code landed. New docs include a "Mask" layer (older docs get one lazily). Quick Mask paints white+alpha coverage. Overlay = tint of coverage (after per-layer invert) above paint; node `invert_mask` affects output only. Interim mask eye toggle until the M3 layers panel.
- 2026-09-24: Whole-drawing Move tool planned as the first M5 item (non-destructive placement, not undoable -- Esc/Reset instead, no rotation).
- 2026-09-24: M1 browser-verified. Fix: upstream size changes no longer resample layers (repeated A->B->A shrank paint); display maps doc -> image via `engine/frameMap.ts`. Clear button pulled forward from M3. Sticky fit + pan clamp + Fit button.
- 2026-09-24: M1 code landed (browser-verified). `docId` added to the document. Undo patches in frame coords; bounds growth is not an undo step; scale-to-fit is one undo entry. Live sessions kept in a module map (max 6 detached) so tab switches keep unsaved strokes + undo. An inverted mask layer with no paint = full mask.
- 2026-09-24: M0 code landed. Document widget via `getCustomWidgets` (`PAINTERSKETCH`); local TS types (official types package is empty). Installed ComfyUI frontend is 1.52.7; source reference is 1.55.x.
