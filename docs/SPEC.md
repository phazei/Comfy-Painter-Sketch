# PainterSketch specification

How every part of PainterSketch behaves **now**, for agents (and the maintainer)
who need to understand a piece before changing it.

## 0. Read this first

**How to use this file.** It is a reference, not a tutorial: read this section
and section 1, then jump to the section you need (code comments cite sections by
title, e.g. `SPEC "Free Transform and flips"`). Each feature section states
rules ("X happens when Y"), the contracts other code depends on, and a
one-line **Why:** where a past mistake must not come back.
[`AGENTS.md`](../AGENTS.md) holds the rules of work (code style, module layout,
gotchas); history is in `docs/archive/`.

**Updating this file.** When behaviour changes, change the sentence that
describes it; don't add a paragraph beside it. A line belongs here only if it
passes both tests: a reader would otherwise have to open the code to learn it,
and it would still be true after a restyle. So: rules, orderings, refusals,
formats, limits that change what the user sees, and *why* -- yes. Pixel sizes,
CSS names, tooltip text, menu wording, lists of files, what was tried, when it
was done -- no (the exceptions are the single-source tables, sections 22-24,
and user-facing timings). Write "Done" into section 25 and move the story to
`docs/archive/`; never leave dated notes in a feature section. If a section
passes about 250 lines, it is describing the code, not the behaviour.

**Pipeline.** An upstream `IMAGE` (never saved) is the background. The user
edits a *document*: a stack of paint/text layers and cmasks, each with its own
pixels in *frame* coordinates, plus optional lmasks, output regions and output
options. Edits upload one file per layer to `input/painter-sketch/` and the
widget value holds a small JSON manifest of file references. On queue, Python
loads those files, maps frame -> image with the same transform the editor uses
(section 3), composites paint over the image, unions the cmasks into `MASK`, and
cuts the regions.

**Invariants that span sections**

- *Hidden is not editable.* Every pixel edit goes through one gate
  (`engine/rasterize.ts preparePixelEdit`, section 8): locked, hidden,
  solo-hidden, Background and Image Mask targets refuse with a note; text layers
  ask to rasterize. View changes (eyes, solo, lmask on/off) are not edits and
  never commit a float unless they hide its own layer (section 16).
- *Document coordinates everywhere.* Pixels live in frame coordinates and are
  never resampled on an upstream size change; `documentMap` / `editor.frameMap`
  is the only doc <-> image conversion (sections 3-4).
- *One undo per gesture, and ours only.* Paint history is dirty-rect patches
  (section 11). ComfyUI's graph undo can roll back the manifest but never the
  live paint session (section 5).
- *Settings are defaults for new documents*, never live state (section 22).
- *cmask vs lmask* (Terms below): cmasks feed `MASK`; an lmask only hides part
  of its layer. Both are white = masked.
- *Photoshop wins on ties* for shortcuts and behaviour (section 24).
- *Degrade, never crash*: bad manifests, missing files and failed uploads keep
  the user's work and tell them once (sections 3-5, 23).

**What kind of section is it?**

| Sections | Kind | Change with |
|---|---|---|
| 2-5 | Contracts mirrored by Python and TypeScript (I/O, compositing, manifest, files, uploads) | a Python + TS change and a test |
| 6-21 | Editor behaviour, one feature per section | the feature's code; update the section in the same change |
| 22, 23, 24 | Single-source tables: every setting, every user-facing message, every shortcut | any UI string, key or setting |
| 25 | Remaining work and parked ideas | planning |

**Terms**

- **cmask**: a standalone ComfyUI-style mask row (Mask N, plus the fixed
  Image/Input Mask row); feeds the `MASK` outputs. **lmask**: a paint layer's
  layer mask; hides part of that layer, never reaches `MASK`. Never write just
  "mask". Both use ComfyUI polarity: white = masked / hidden.
- **Output**: Main or a region (has a result and output options). **Region**:
  the rectangle itself. Main is an output, not a region.
- **View**: pan/zoom of the stage. **Align drawing**: whole-drawing placement.
  **Move layer**: the `V` tool.
- **Frame**: the grid the paint was made on (document coordinates). **Image**:
  the current input image (or the width x height fill when none is connected).
- Three nested areas on the stage, inner to outer (section 4 "Frame and bounds"):
  - **Image area**: where the background image sits and where painting lands;
    what Ctrl+0 centres. Scales with the input size.
  - **Bounds** (*paint area*): the document's actual pixel extent, where the
    layers hold pixels. Starts as the frame and grows in chunks as moves,
    transforms, pastes and text reach outside; it never shrinks.
  - **Draw area**: the cap bounds can grow to (frame plus its short side on
    every side, max 16384 per axis); the cobwebs are drawn outside it. Also
    written "maximum paint area" or "bounds cap".

## Contents

0. Read this first
1. Overview and scope
2. Node I/O
3. Python execution
4. Document and saved files
5. Persistence and sync
6. Canvas, view and fullscreen
7. Editor shell and focus
8. Layers
9. Layer masks (lmask)
10. Colour
11. Undo and redo
12. Tools
13. Brush engine
14. Fill and wand sampling
15. Selection
16. Floating selections
17. Clipboard and drop
18. Free Transform and flips
19. Moving (Move layer, Align drawing)
20. Image sources and the Images panel
21. Outputs and regions (editor)
22. Settings
23. Messages
24. Shortcuts
25. Remaining work

---

## 1. Overview and scope

A ComfyUI node: `IMAGE` in, paint and draw cmasks **inside the node**, out
`IMAGE`, `MASK` and up to six output regions. Fullscreen moves the same editor
into an overlay (one editor, not a second app). LiteGraph is primary; Nodes 2.0
must work. Follow established image-editor (Photoshop first) behaviour and
shortcuts.

- **The input image is a live, locked background, never saved.** Only paint
  layers, cmasks and lmasks are saved; Python composites them over whatever
  arrives at run time, so re-rolling the upstream keeps the paint.
- **Frame vs paint area.** Layers may hold paint outside the image; outputs are
  always aligned to the image (except regions and Crop/Border options).
- **Upstream size change = scale to fit, non-destructive.** Pixels stay in
  document (frame) coordinates, never resampled on a size change; editor and
  Python map document -> image with the same transform.
  Why: resampling on each size change shrank and blurred paint on A->B->A flips.
- **cmasks are layers** (`kind: "mask"`), N of them, combined by union.
- **Selection is a pixel coverage mask**, not a path.
- **Persistence = PNG/WebP uploads to `input/painter-sketch/`**; the widget holds
  a small JSON manifest of file references. Never base64 in the workflow.
- **Canvas 2D, one offscreen canvas per layer.** No PIXI, no UI framework.
- **Undo = per-operation dirty-rect patches**, memory-capped.
- **Blend modes: Normal only**, so Python always matches the screen.
- **Text stays editable** (`textData`), rasterized into the layer file on save so
  Python never renders text.

Out of scope: sessions, custom server routes (except `POST
/painter-sketch/cleanup`), iframes, AI prompt boxes, output comparison panes, a
run button in the editor.

## 2. Node I/O

**Registration.** `__init__.py` exports `WEB_DIRECTORY = "./js"` and
`comfy_entrypoint()`, and registers the cleanup route at import.
`nodes/__init__.py`: `ALL_NODES = [PainterSketch, PainterSketchRegions]`, both V3
(`io.ComfyNode`), category `image`.
Why: `NODE_CLASS_MAPPINGS` must not exist (even `{}`); the loader would take the
V1 path and never call `comfy_entrypoint`.

### PainterSketch

`node_id="PainterSketch"`, `has_intermediate_output=True`. Input order and names
are contract-stable (the frontend widget depends on them).

| # | Name | Type | Default / limits | Notes |
|---|---|---|---|---|
| 1 | `image` | IMAGE, optional | - | Batch in, batch out. A 4th channel is dropped. |
| 2 | `mask` | MASK, optional | - | Gives the Input Mask row. Used only while `image` is also connected. |
| 3 | `layer_source` | IMAGE, optional | - | Feeds the Images panel. Never affects outputs. |
| 4 | `document` | STRING, `socketless`, `widgetType: "PAINTERSKETCH"` | `""` | The manifest. Replaced by our DOM widget. |
| 5 | `width` | INT | 1024, 64..16384, step 8 | Only used when `image` is not linked. |
| 6 | `height` | INT | same | Same. |
| 7 | `background` | COLOR | `#ffffff` | Fill with no image; replaces the image when the Background eye is off; fills regions outside the image. Alpha ignored; unparseable = white + log warning. |
| 8 | `invert_mask` | BOOLEAN | false | Inverts the normal cmask union; Subtract cmasks are removed afterwards (section 3). |

`width`/`height` are hidden while `image` is linked and rewritten to every
loaded image size (rounded to step 8, clamped). Disconnecting keeps the frame.
When they reappear and the node is too short, the node grows.

| Output | Type | Shape |
|---|---|---|
| `IMAGE` | IMAGE | `[B,h,w,3]`, or 4 channels with Main's Alpha option |
| `MASK` | MASK | `[B,h,w]` |
| `regions` | `PS_REGIONS` (custom) | 6 slots, each `RegionOutput(image, mask)` or `None` |

h, w = the image size (or width/height), unless Main's Modify is Crop or Border.

**UI result** (`nodes/previews.py`):

- `images`: the first input frame, not the composite (the editor draws the paint
  itself); with no image, the plain `background` colour.
- `layer_source`: first frame of that input + `source_id` (16-hex content id).
- `input_mask`: prepared coverage of image 0 as a grayscale PNG + `mask_id`;
  `[{"mask_id": "none", "empty": true}]` for LoadImage's "no mask" placeholder.

**Caching** (`fingerprint_inputs`, SHA-256) hashes: the `document` string,
`invert_mask`, an `IMAGE` marker if `image` is linked (else `width`,`height`),
`background`, a `MASK` marker if linked, and `(name, size, mtime)` (or MISSING)
for every layer file, lmask file and the Image Mask file (the last only when
`mask` is not linked). Unsafe names (outside `painter-sketch/`, or with `..`)
hash as MISSING without touching the disk. Tensors are left to ComfyUI's own
caching. No `validate_inputs`; bad input degrades gracefully.

Known limitation: when a run reveals a new image size, the width/height widgets
change, so the next queue re-runs once (widget values are in the cache key).

### PainterSketch Regions

`node_id="PainterSketchRegions"`, display "PainterSketch Regions". One input
`regions` (`PS_REGIONS`), 12 fixed outputs `IMAGE 1`, `MASK 1` ... `IMAGE 6`,
`MASK 6`. An empty slot returns `ExecutionBlocker(None)` for both its outputs
(downstream silently doesn't run); a wrong input type blocks all 12. Labels are
set by the frontend (section 21, `ui/src/widget/regionsNode.ts`); sockets never
appear or disappear.

- Why: import `ExecutionBlocker` from `comfy_execution.graph_utils`;
  `comfy_execution.graph` imports ComfyUI's `nodes`, which clashes with our
  `nodes/` package.
- Why: `io.NodeOutput(block_execution=...)` treats `None` as "no block", so the
  blocker must be the per-output value.

**Batches.** The same paint and cmasks apply to every image (broadcast, no
loop). The editor previews image 0. The Input Mask can be per image.

Files: `nodes/painter_sketch.py`, `nodes/painter_sketch_regions.py`,
`ui/src/widget/constants.ts`, `sizeWidgets.ts`.

## 3. Python execution

`execute`, in order:

1. **Base.** With an image, `base_rgb = image[..., :3]`; else a
   `[1,height,width,3]` fill of `background`.
2. **Input Mask.** Used when both `image` and `mask` are connected
   (`prepare_input_mask`, rules below).
3. **Parse** the manifest. Empty or invalid (bad JSON, not an object,
   version != 1, bad frame): IMAGE = `base_rgb` (no options); MASK = zeros (ones
   with `invert_mask`), or the Input Mask alone when connected (inverted with
   `invert_mask`); regions empty.
4. **Layers.** Each layer file loads as `[bounds.h, bounds.w, 4]` straight-alpha
   float, or nothing; text layers load as raster like paint. Enabled lmasks
   first: alpha *= `1 - plane` (`plane` if inverted); beyond the stored pixels
   the plane is the `outside` value (`reveal` = 0, `hide` = 1); `file: null` =
   all-zero plane (all shown, or all hidden with `invert`); an unreadable lmask
   file is ignored (layer shows unmasked).
5. **Image/Input Mask row.** With the Input Mask in use, the row's manifest
   settings apply (defaults: visible, normal) and its pixels are the
   prepared coverage. Otherwise, with an image and a visible `imageMask` record,
   its file is used only if exactly the image size (stale size skipped, info
   log). Never used without an image.
6. **Composite.**
   - Background eye on: each visible paint/text layer bottom to top,
     `out = rgb*a + out*(1-a)`, `a = placed_alpha * opacity`. `blendMode` is not
     read (always Normal).
   - Background eye off (`backgroundVisible: false`): composite premultiplied
     over transparency into `P, A`. `IMAGE = P + bg*(1-A)` (bg = `background`);
     `straight = P/A` clamped, `bg` where `A = 0`.
7. **MASK.** Every cmask row (cmasks and the Image/Input Mask row) is normal
   or **Subtract** (`subtract`). Each visible row's alpha is placed through the
   frame map (the row at the image origin; 0 outside the placed rect, raw, never
   flipped). `U` = max of the visible normal rows; with `invert_mask`,
   `U = 1 - U` (all ones when no normal row is visible -- Subtract rows don't
   count). `S` = max of the visible Subtract rows. `MASK = U * (1 - S)`:
   Subtract means "never masked here", whatever `invert_mask` says. Only
   Subtract rows and `invert_mask` off = all zeros (not special-cased). An
   empty visible normal cmask still counts as a mask row (zeros); an empty
   Subtract one changes nothing. cmask `opacity`/`color` are display only.
   Background eye off: `MASK = max(that, 1 - A)`; transparency joins last and
   is never inverted or subtracted. **Why:** a per-cmask invert was removed
   because two inverted cmasks union to the inverse of their intersection,
   masking almost everything; Subtract combines.
8. **Outputs.** `apply_output_options` for Main; regions via `build_regions` from
   the same composite. Main's options never affect regions.

**Output options** (`nodes/output_processing.py`, same for Main and regions):

1. If `straight` exists and (Alpha or Fill), the image becomes `straight` (no
   background-colour fringe on soft edges).
2. Modify: `none` passes through; `fill`: `image*(1-mask) + color*mask`, MASK
   unchanged; `crop`: bbox of `mask > 0` unioned over the batch, plus
   `cropPadding`, clamped (empty mask = no crop); `border`: pad every side by
   `borderSize`, IMAGE gets `borderColor`, MASK gets 1 (`borderMask`) or 0.
3. Alpha (not with Fill): a 4th channel `1 - mask`.

**Regions** (`nodes/document_regions.py`). Up to 6 records matched by slot 1..6
(first valid record per slot wins). Edges clamped to `[-W, 2W]` / `[-H, 2H]`,
rounded `floor(v + 0.5)`, at least 1x1. A region inside the image is a slice of
the main composite; one reaching outside is composited on its own canvas
(`background`, then the image where it overlaps, then paint and cmasks placed at
its origin). Background eye off: composites transparent.
Why: rounding is half-up on both sides so editor and Python agree.

**Frame map and placement** (`nodes/composite.py` `_layout`, mirrored by
`ui/src/engine/frameMap.ts`):

- `s = min(W/fw, H/fh)`, `ox = (W - fw*s)/2`, `oy = (H - fh*s)/2` (contain).
- Placement `{x, y, scale=k}`: `eff_s = s*k`,
  `eff_ox = ox + s*((fw/2)*(1-k) + x)`, same for y.
- A layer lands at `round(eff_ox + bounds.x*eff_s)` with size
  `max(1, round(w*eff_s))`, `round` = half to even on both sides (Python
  `round`, `roundHalfEven` in the editor); bilinear resample only if
  `eff_s != 1` or the offset is fractional.

**Input Mask tensor rules** (`nodes/input_mask.py`): `[H,W]` = one frame; a
64x64 all-zero mask = LoadImage's "no mask" (no row); per image only when the
mask batch equals the image batch, else mask 0 for all; bilinear resize to the
image; clamped 0..1.

**Degrading** (`nodes/layers.py`). A layer file whose size differs from `bounds`
is placed unscaled at the top-left (warning), like the editor. Missing, unsafe
or unreadable files = warning + empty layer, never a failure. A layer `file` is
used only if it is `painter-sketch/<name>` with an optional exact trailing
` [input]` (`is_safe_file_value`, mirroring `folder_paths.annotated_filepath`):
`[output]` / `[temp]`, any `..` component or any other prefix are rejected
before touching the filesystem, both when loading and in `fingerprint_inputs`.
Files must exist via `folder_paths.exists_annotated_filepath` and load via
`node_helpers.pillow(Image.open)` (format from bytes: WebP, PNG and older
PNG-only paint files all work).

**Cleanup route** (`POST /painter-sketch/cleanup`, `nodes/cleanup_route.py` +
`cleanup.py`; no-op without a server):

- `{"mode": "stats"}` -> `{all: {count, bytes}, old: {count, bytes}}`.
- `{"dryRun": bool, "referenced": string[]}` -> `{count, bytes, all, old,
  errors?}`, plus `deleted` on a real run. 400 for bad bodies (max 100 000
  references, 4096 chars each), 500 with `{error}` otherwise.
- A file is deleted only if it sits directly in `input/painter-sketch/`, is a
  regular non-symlink file, matches `ps-<docId>-<hash>.(png|webp)` (docId any
  case; hash and extension lowercase), is older than 24 h, and its name appears
  in no reference. References: raw-text scan of every `*.json` under each user's
  `workflows/` and `subgraphs/` (files over 50 MB skipped and reported) plus the
  client list. A symlinked folder is refused. Age and type are re-checked right
  before delete. Runs under a lock in a thread.
- Why: raw-text scanning finds names even in double-encoded manifests. The
  reference regex is mirrored in `ui/src/cleanup/references.ts`; a test fails if
  the copies differ.

## 4. Document and saved files

**Manifest** (`PainterDocument`, `version: 1`; `ui/src/document/types.ts`). The
widget value is the JSON (stable key order), or `""` for an untouched document.

| Field | Type / default | Written |
|---|---|---|
| `version` | `1` | always |
| `docId` | `/^[a-z0-9]{4,64}$/i`, regenerated if invalid (12 chars) | always; Python ignores it |
| `frame` | `{width, height}`, 1..16384 | always |
| `bounds` | `{x, y, width, height}`, `abs(x), abs(y) <= 65536`, size 1..16384, contains the frame | always |
| `regions` | `Region[]` | always (may be `[]`) |
| `mainOutput?` | `OutputOptions` | when set |
| `backgroundVisible?` | `false` | only when false |
| `imageMask?` | `{file, visible, color, opacity, subtract?, sourceKey, width, height}` | while the row exists |
| `placement?` | `{x, y, scale}` | only when not identity |
| `activeLayerId` | string | always |
| `layers` | `Layer[]`, bottom -> top, Background excluded | always |

- `Layer`: `id`, `name`, `kind: "paint" | "text" | "mask"`, `visible`,
  `locked`, `opacity` (0..1), `blendMode: "normal"` (reserved, ignored),
  `file: string | null`; optional `color` and `subtract: true` (cmasks;
  `subtract` is written only when true and read only on cmasks, anything but
  `true` = normal), `textData` (text layers; see section 12 Text), `layerMask`
  (paint layers that have one).
- `layerMask`: `{file: string | null, enabled, invert, outside: "reveal" |
  "hide"}`. Pixels are white RGB with the hidden amount in alpha, sized like the
  layer's bounds; `file: null` = all shown.
- `Region`: `{id, slot 1..6, name, rect {x, y, width, height}, visible,
  output}`. `rect` is integer current-image px from the top-left, may extend
  outside the image, never rescaled. Blank `name` = "Region N". Legacy
  `{id, index}` maps to `slot = index + 1`.
- `OutputOptions`: `applyMask: "none" | "fill" | "crop" | "border"` (none),
  `fillColor` (`#000000`), `cropPadding` int >= 0 (0), `borderSize` 1..4096
  (64), `borderColor` (`#ffffff`), `borderMask` (true), `alpha?` (written only
  when true). Colours are lowercase `#rrggbb`; each bad field defaults on its own.
- `placement.scale` is clamped 0.05..10; non-finite x/y become 0.

**Frame and bounds** (`ui/src/engine/bounds.ts`)

- A new document (or an empty one adopting an image) gets `minimumFrame(image)`:
  scaled up so the short side is >= 1024, but never pushing the long side past
  4096; never shrinks.
- `bounds` starts as the frame and grows in 256 px chunks when edits reach
  outside, capped at the frame plus its short side on every side and 16384 per
  axis (the *draw area*, inside the cobwebs). Existing larger bounds are kept.
- **Painting stays on the image.** Brush, eraser, shapes, lines, the bucket and
  selection fills (Alt/Ctrl+Backspace, selection to mask) change pixels only on
  the *image area* (the background image's rect, what Ctrl+0 centres; the
  `width x height` fill without an image) inside the draw area
  (`engine/imageArea.ts` `paintLimit`). Paint past the image edge is not drawn
  and never grows the layers; when the image area lies outside the draw area
  nothing can be painted. Move, transforms, paste and text still grow the bounds
  up to the cap. Clearing a selection (Delete) still reaches everything selected.
- Layer pixel `(px, py)` sits at frame coordinate `(bounds.x + px, bounds.y + py)`.
- Why: all editor conversions go through `documentMap(doc, imageSize)` /
  `editor.frameMap`. Never call `frameMap(doc.frame, ...)` directly or
  re-derive the formula.

**Versions.** Only version 1 exists; any other value is rejected (editor:
invalid; Python: no document). Additive optional fields ship without a bump;
older manifests stay valid. Bump the version (and add a migration) for any
breaking change.

**Validation** (`ui/src/document/parse.ts`, never throws; Python mirror
`nodes/document.py`):

| Condition | Result |
|---|---|
| null / empty string | `empty` |
| not JSON, not an object, version != 1, bad frame (incl. a side > 16384), bounds not containing the frame, `layers` present but not an array | `invalid` (empty canvas + toast; the raw value is kept) |
| missing / malformed `bounds` (incl. a side > 16384 or `abs(x)`/`abs(y)` > 65536) | repaired to the frame |
| missing `layers` | `[]` (then "Layer 1" is added, document marked repaired) |
| layer entry not an object / no id / unknown kind | skipped (counted, toast) |
| duplicate layer id | fresh id |
| bad `file` | null |
| bad `opacity` | 1, clamped 0..1 |
| bad `visible` / `locked` | true / false |
| text layer without usable `textData` | loaded as paint |
| no paint layer | adds "Layer 1" |
| cmasks below paint | moved above the paint stack |
| unknown `activeLayerId` | first paint layer |
| bad region / bad `imageMask` | dropped on its own |

Python applies the same rules: bounds not containing the frame, or a present
non-array `layers`, mean "no document" (plain image out); a missing `layers` key
is an empty stack. Files are sized to `bounds`, so any bounds growth re-uploads
every layer that has pixels.

**Files** (`ui/src/widget/layerEncode.ts`, `contentHash.ts`, `paintQuality.ts`)

- Paint and text layers: lossy WebP at `PaintQuality/100` when the setting is
  below 100 (PNG if the browser's WebP fails a sniff), PNG at 100. cmasks,
  lmasks and the Image Mask are always PNG.
- Straight alpha RGBA, exactly `bounds` size. The Image Mask is exactly the
  image size with coverage in alpha (coverage = 255 - image alpha). A fully
  transparent canvas stores no file (`file: null`).
- Name: `painter-sketch/ps-<docId8>-<hash14>.<webp|png>`; `docId8` = docId with
  non-alphanumerics stripped, first 8 chars, case kept (`doc` if empty);
  `hash14` = 14-hex cyrb53 of the encoded bytes. The manifest stores the
  server's answer, `"painter-sketch/<name> [input]"`. Older documents may hold
  files offset from `bounds`; both sides place them unscaled (section 3
  "Degrading"), nothing repairs them.
- Upload: `POST /upload/image`, `type=input`, `subfolder=painter-sketch`,
  `overwrite=true`. Skipped when the name was loaded or uploaded before in this
  session, unless more than 20 h ago: re-uploading bumps the server mtime so
  cleanup's 24 h rule can't delete a file an undo brings back. Files named by the
  loaded manifest count as fresh, so loading never re-uploads (text layers
  re-rendered to the same name included); a file that failed to load is
  forgotten.
- The manifest holds only file references (~250 B per layer). Never inline pixel
  data: ComfyUI fails to save workflow drafts with very large widget values.

## 5. Persistence and sync

**Value.** `""` until the document has content (unsaved paint, a layer file,
regions, `mainOutput`, a hidden Background, or an `imageMask` record). An
unreadable incoming value is returned unchanged until the user paints, so saving
the workflow never drops it.

**Upload timing** (`widget/controller.ts`, `persistence.ts`, `uploadScheduler.ts`):

- 5 s after the last edit (debounced idle fallback); on editor disengage,
  fullscreen exit and session detach.
- Queue: `serializeValue` waits for the session and any Image Mask read, settles
  floats, flushes, shows the hidden-cmask note if needed, returns the manifest.
  It **throws on upload failure**, so the queue stops.
- Ctrl+S in the editor: settle floats, flush, then `Comfy.SaveWorkflow` (confirm
  "save anyway?" on failure). Ctrl+Shift+S is not intercepted.
- F5 / Ctrl+R / Cmd+R / Ctrl+Shift+R with uploads pending: flush (3 s cap), then
  reload; a failed or timed-out flush confirms first. Tab hidden / window blur:
  fire-and-forget flush. These guards (`widget/pageGuards.ts`: keydown capture,
  blur, visibilitychange, beforeunload) are the one always-on window listener
  set; they do nothing unless a session has pending uploads or captures.
- Idle, blur and tab-hidden flushes never settle a float (user is mid-work);
  they upload the pre-lift pixels.
- Why: `serializeValue` runs only when building a prompt, not on save, tab
  switch or export, so the value is kept current after every edit and uploads
  run on a debounce.

**Dirty tracking.** Per-layer version + dirty flag (cleared only if unchanged
after the upload), a separate Image Mask flag, lmasks in the same flush. A file
reference changes only after a successful upload, so the manifest never points
at a missing file. On failure: pixels stay dirty in memory, one error toast per
failure streak (60 s window across documents), retry with backoff
15/30/60/120 s, info toast on recovery.

**Restore.** Layer and lmask files load in parallel from `/view`; painting waits.
A failed file leaves the layer empty with its reference intact (not dirty); text
layers re-render from `textData` and re-upload; a loaded size differing from
`bounds` is flagged stale (not text). One toast per document summarizes problems.

**Sessions** (module-level, keyed by `docId`) outlive node instances, so tab
switches keep strokes and undo. Removing a node only detaches: untouched
sessions are released, others flushed and kept (max 6 detached, LRU). A
manifest re-attaches only if its file signature (frame, layer ids+files,
lmasks, Image Mask file) matches the session's current or one of its last 4
states (an upload may finish between value capture and re-create) AND its
output metadata (regions, options) equals the session's. Attach rules
(`widget/attachDecision.ts`):

- no live session -> restore from files;
- detached or same-owner session that matches (or was handed off) -> reuse;
- non-matching -> restore (warning toast if that discards dirty pixels);
- shown by another live node (node copy/paste) -> fork under a new `docId`:
  copy of the live editor if the manifest matches (`fork-copy`), else restore
  (`fork-restore`). While the original is still loading (`session.restoring`)
  the copy always restores from files (cloning would copy blank layers).

**Graph undo handoff** (`widget/handoff.ts`). Graph undo/redo removes and
re-creates every node with the same id in one task. `onRemoved` offers the
wrapper element, session and background; `onAdded` takes it; the offer expires
after a microtask so tab switches and deletions never match. A handed-off
session is always kept: **graph undo never rolls back paint**. No ChangeTracker
capture after a handoff (it would clear redo).
Why: Nodes 2.0 reuses the old Vue widget and never re-inserts `widget.element`;
a disposed element would leave a blank node.

**Drafts** (`widget/graphSync.ts`). ComfyUI writes drafts only on
`graphChanged`, i.e. when `captureCanvasState()` sees a change. After our value
changes on its own we request a coalesced capture on the active workflow's
change tracker (1000 ms after edits, 0 ms after an upload batch), only for
nodes in the root graph, never during graph undo/redo. Pending captures flush
on blur, tab hidden, `beforeunload` and the reload keys. Accepted limitation:
an upload finishing while the node's tab is in the background doesn't update
that tab's draft until you return.

**Input lookup** (background, Image Mask, Input Mask, layer_source), in order:

1. Upstream node's own image: LoadImage / LoadImageOutput / LoadImageMask widget
   values, then `app.nodePreviewImages`, `app.nodeOutputs`, `node.imgs`.
2. Our own executed preview: for background and Image Mask only if from the
   same upstream node and slot (`widget/backgroundRule.ts`); `layer_source`
   falls back to our `layer_source` preview without provenance check
   (`widget/layerSourceWatch.ts`).

Background URLs use `channel=rgb`, Image Mask alpha reads `channel=a`. The
Input Mask row reads our `input_mask` preview (same link), or a live
`channel=a` read of a MASK output of a node showing a `/view` file
(LoadImageMask only with channel alpha); otherwise it waits ("Run the workflow
to load this mask"). Its `file` is always null. Background load failures are
console-only.

**Cleanup button** (setting `PainterSketch.Cleanup`, `ui/src/cleanup/`): show
file counts -> collect client references (open workflows incl. change-tracker
states, `app.graph.serialize()`, all local/session storage) -> dry run ->
confirm -> real run (references re-collected) -> toast -> refresh counts.

Files: `ui/src/widget/` (sessions, attach, handoff, graphSync, failures/toasts,
background/Image Mask/Input Mask loaders), `ui/reloadGuard.ts`.

## 6. Canvas, view and fullscreen

**View model** (`engine/view.ts`, `viewport.ts`): content is the current image
(not the frame); `stage = content * scale + offset`.

- **Fit** is sticky: initial state, Ctrl+0, Fit button. While fitting, stage or
  image changes re-fit. Manual zoom/pan or Ctrl+1 leave fit; then a resize
  keeps the centred image point.
- Zoom 0.02..64 (`scale` = stage CSS px per image px, graph zoom excluded).
  **100%** (Ctrl+1) = one image px per screen px, centred.
- Wheel zooms about the cursor by `exp(-clamp(delta, +-300) * 0.0015)` (line
  mode x16, page mode x stage height); Ctrl+wheel and pinch the same. Ctrl+= /
  Ctrl+- zoom x1.25 / x0.8 about the centre. During a drag of a tool with
  `onWheel` (Align drawing) the tool gets the wheel.
- Pan: middle-drag, or Space + left-drag (Space in a text field is text; with
  Ctrl/Alt/Meta the key isn't prevented but still arms pan). At least
  `min(64, on-screen size)` px of the image stays visible.
- Stuck-drag recovery (`stageInput.ts`): a buttonless mouse/pen move during a
  drag cancels it; a press of another button or a new primary pointer aborts
  the old press; a lost middle `pointerup` ends the pan guard on the next
  non-middle press/move; stage `auxclick` is prevented. Right-click on the
  stage is not prevented (browser menu opens).
- Backing store = stage CSS size x devicePixelRatio x graph zoom, long side
  capped at 4096. Pointer positions go through `getBoundingClientRect()` every
  event (never cache a scale).
- One redraw per animation frame. While a stroke/shape is live (`"stroke"`
  render hint) and view, backing size, bounds and frame map are unchanged, only
  the stroke's dirty rect redraws (`stageDirtyRect`), through the same
  compositor; anything else redraws the whole stage.
- Layer runs (`layerStackCache.ts`): 2+ consecutive paint layers not changing
  this frame draw from one flattened copy, rebuilt when a member's pixels,
  opacity, lmask or visibility change. Live layers (stroke on layer or lmask,
  float, Move drag) draw in place: same picture and stacking (Normal blending,
  up to 8-bit rounding).
- Layer history keeps whole-layer pixels as canvas copies, not `ImageData` (no
  GPU readback).
- Drawing order: surround and cobweb outside the max paint area; checker under
  the image area; background (image / colour / transparency when its eye is
  off); layers; cmask tints; veil over off-image paint; image outline (stronger
  when paint extends past it); paint-area border. Image size is in the bottom
  bar; on the stage under the image only in Simple mode. A quick click on the
  cobweb regrows it (cosmetic).
- Stage notes: one at a time, bottom of the stage, 5 s.

**Node sizing.** `getMinHeight` 256 (graph units) plus CSS `min-height` (Nodes
2.0 ignores `getMinHeight` for DOM widgets). New nodes start at least 512 x 640.
Output previews suppressed (`hideOutputImages` for Nodes 2.0; no-op
`onDrawBackground` on our prototype for LiteGraph).

**Event isolation** (`widget/eventIsolation.ts`). The root stops
pointer/mouse/dblclick/contextmenu bubbling. While the pointer is over the root
a `window` capture listener stops `wheel` (always) and pointer events of a
middle-drag started on the stage; `data-capture-wheel="true"` is set too. Wheel
over the options strip scrolls it sideways when it overflows; elsewhere native
scroll; Ctrl+wheel is prevented.
Why: Nodes 2.0 forwards wheel and middle-button pointer events to the graph in
the capture phase, before our element's listeners run.

**Fullscreen** (`ui/fullscreen.ts`). Enter with F or the bottom bar button. The
editor root moves into a fixed overlay on `document.body` (above ComfyUI menus,
below PrimeVue dialogs/toasts); the `.cps-widget` wrapper stays and shows a
placeholder.

- On enter the side panel moves inside and is always shown (shrunk state kept),
  the view re-fits, drags cancel, popovers close. On exit the view re-fits only
  if it was fitting before.
- Keys are read only from inside the overlay (a dialog over it is ignored).
- Exit: Esc (last in the Esc chain), F, the Exit button, the placeholder, or
  automatically (250 ms poll) when the node leaves the DOM or the viewed graph.
  One fullscreen editor per page.
- The overlay stops pointer/wheel events and refuses drops (a dropped file
  never loads a workflow into the hidden graph).
- Width handles (`ui/fullscreenWidth.ts`) on both sides move together,
  symmetric about the centre; min 640 px, snaps to full near full, double-click
  = full. Stored as the root's `max-width` per browser in `localStorage`
  (`PainterSketch.fullscreenWidth`), not in the document.

Why: Nodes 2.0 only checks that `widget.element` is its child, so only the
inner root may move, never the wrapper.

| | In-node | Fullscreen |
|---|---|---|
| Canvas | drawn at graph zoom | no graph zoom |
| Chrome (bars + side panel) | panel outside the node, right; shown while node selected or keyboard scope active | panel inside, right, below top row; always shown |
| Keyboard | hover / click-engage | always owned |
| Unhandled keys | pass to ComfyUI (except arrows while engaged) | swallowed except the pass-through list (section 24) |

Files: `engine/compositor.ts`, `ui/stageView.ts`, `fullscreenKeys.ts`,
`widget/painterWidget.ts`, `nodeHooks.ts`.

## 7. Editor shell and focus

**Regions** (`ui/shell.ts`). The stage fills `.cps-root`; bars float over it.
Top row and bottom bars share a centred width cap so corner groups stay near
the dock.

- Top-left **history pill**: Undo, Redo, Clear (confirm, section 8).
- Top centre **tool dock** with the options strip under it. The dock's top edge
  shows a line while the editor owns the keyboard (`cps-has-keys`).
- Top-right **Images / clipboard pill**: Images (count badge; absent until the
  node has a source; tray, section 20) | Copy, Cut, Paste (section 17).
- Left **sliders pill**; bottom **left and right pills** with the resolution
  notice above the right one; **side panel**, help overlay, popover host.

**Chrome visibility** (`chromeVisibility.ts`). In-node, bars and side panel are
hidden while idle. They show while the node is selected (`onSelected` /
`onDeselected` + per-tick check), the keyboard scope is active, or fullscreen is
open. Hover alone shows them after 750 ms; a click inside, selecting the node or
fullscreen shows them at once. Hide waits 250 ms and while the pointer is over
the panel. Shortcuts work as soon as the scope is active; only visuals wait.
Hiding closes any popover.

**Simple mode** (`defaults/modeDefaults.ts`, `ui/modeToggle.ts`). Per node,
stored in `node.properties["PainterSketch mode"]` (never sent to the backend, so
switching never re-runs the node); new nodes take the "Default editor mode"
setting (section 22). Toggle under the title bar (in the bottom bar in
fullscreen); **Tab** toggles. Every shortcut works in both modes. Simple hides:

- Copy, Cut, Paste (Images stays while there are images);
- the bucket, Shapes and Text in the dock, unless active (picked by shortcut);
- the side panel, except in region mode (`O`);
- the right bottom pill except **Fit**, plus **Align** while it warns or runs;
  the image size moves onto the stage.

The edit chip and Quick Mask manage one layer, its lmask and the cmasks. In
Simple mode the chip menu adds Hide / Show for what it edits; Lock appears only
as Unlock, while locked (cmask and paint layer). Pastes, drops and Images
inserts always go into the current layer (section 17): Merge Down is out of
reach.

**Tool dock** (`toolDock.ts`, `toolGroupSlot.ts`): `Brush, Eraser, Fill | Select
group, Move layer | Shapes group, Text | swatches`; other rail tools appended in
registry order.

- Select group = Rect marquee (M), Elliptical marquee (Shift+M), Lasso (L),
  Magic wand (W); Shapes group = Line (U), Arrow, Rectangle, Ellipse. A slot
  shows its last-used member; click selects it; long-press, right-click or the
  caret opens a fly-out. Keys keep their registry groups (section 12); the
  Select slot remembers its own last member.
- **Eyedropper** has no dock button: hovering the swatches (mouse) or
  long-pressing them (any pointer, until the next press elsewhere) reveals it
  beside the dock (hidden under Quick Mask). Stays while active; hides 250 ms
  after the pointer leaves.
- **Swatches** at the dock's right end (section 10).
- Modal states (Free Transform, region mode, Align drawing) dim the dock (no
  active tint).

**Options strip** (`optionsStrip.ts`): one row, never wraps (scrolls sideways),
removed while empty. First match wins:

1. **Free Transform**: its own options only (section 18).
2. **Region mode**: hint + **Done** (back to Layers).
3. **Align drawing**: X, Y, Scale, Reset (section 19), **Done** (turns it off).
4. **Otherwise** the tool's options (Move layer always, selection tools while a
   selection exists, append Transform, Flip H, Flip V), then: with a selection,
   "To mask" (target cmask, or the targeted lmask) and "Invert" (changes the
   selection; no on-state); a selection tool with nothing selected shows a
   usage hint, so the strip is never empty; an open text edit adds **Done**
   (commit).

Options render generically from descriptors (`optionControls.ts`): number =
label (scrub) + value (slider popover), toggle = pill, select = dropdown (icon
selects as icon toggles), pen pressure group = one button with a popover
(tinted while either toggle is on).

**Sliders pill** (`slidersPill.ts`): vertical Size + Hardness for brush/eraser,
Width for shapes; those keys leave the strip (text Size stays). Drag anywhere
on a track (pointer capture, descriptor's slider curve). Hidden for other tools
and in modal states; on short nodes tracks shrink to fit, down to a floor.

**Bottom bars** (`bottomBar.ts`, `editChip.ts`, `quickMaskButton.ts`): left
`[status] [edit chip] [Quick Mask] [| Invert Apply Delete]`, right
`Align | W x H | Fit Fullscreen Help`.

- **Status pill**: "LMask ×" while the lmask-only view is on (wins), else
  "Solo ×" while any solo is set. Click ends the lmask view or clears both solo
  slots. Esc never does.
- **Edit chip** (swatch, name, part; click opens a menu). First match wins:

  | State | Chip | Swatch | Menu |
  |---|---|---|---|
  | Region mode | Main / region · Outputs | white | Main + regions (current marked); Back to {layer} (leaves region mode) |
  | Background selected | Background · Read-only | fill colour; stripes over an image | Duplicate to editable layer; Back to {layer} |
  | Image/Input Mask current | {row} · Read-only | mask colour | Duplicate to editable mask; Back to {layer} |
  | Quick Mask | {cmask} · Mask (· Subtract for a Subtract cmask) | mask colour | Subtract ✓; View this mask alone ✓ (cmask solo); Lock/Unlock; Back to {layer} (Q) |
  | Paint layer, lmask targeted | {layer} · Mask | half white / half black | Pixels; Layer mask (current); View layer mask only ✓ (Alt-click); Enable/Disable layer mask (⇧-click) |
  | Paint layer | {layer} · Pixels | checker | same; without lmask: Pixels, Add layer mask (reveal all / show only selection) |
  | Text layer | {layer} · Pixels | checker | Pixels; Rasterize text (commits open edit, then rasterize confirm) |

  Region mode wins, so a cmask or lmask target never shows in Outputs.
- **Quick Mask button**: tap toggles (like Q); long-press, right-click or caret
  opens the cmask list (top-most first; a pick makes it current and turns Quick
  Mask on). Tinted with the current cmask's colour while on. A current
  Image/Input Mask row or selected Background doesn't count as on: a tap (or
  `Q`) switches to the target cmask / turns Quick Mask on. Hidden in region mode.
- **lmask options** (lmask targeted; not in region mode or Free Transform):
  Invert (tinted while inverted), Apply, Delete mask (section 9).
- **Align** toggles Align drawing (section 19). While the resolution notice
  condition holds and Align drawing is off it shows amber with a warning, even
  if the notice pill is hidden.
- **W x H** read-only image size; **Fit** (Ctrl+0), **Fullscreen** (F),
  **Help** (?).

**Resolution notice** (`resolutionNotice.ts`): amber pill above the right
bottom pill: text (section 8), "Match image resolution", ×. × hides it until
the text changes or Align drawing is enabled (where the mismatch is fixed, so
it comes back).

**Help overlay** (`helpOverlay.ts`): `?` / Help toggles; Esc, backdrop click or
× closes. An "Essentials" band (`QUICK_ROWS`) over per-section cards, generated
from `ui/shortcutList.ts`, a condensed copy of section 24 limited to the
editor's own keys (wrapped/passed ComfyUI keys like Ctrl+S, Ctrl+Enter left
out); change both together. Buttons and text only, so focus stays on the sink.

**Side panel** (`sidePanel.ts`), floating, shown/hidden with the chrome.

- In-node **outside the node** to its right, top-aligned; in fullscreen inside
  at the right, below the top row (never covers the clipboard pill) and below
  the options strip when the strip reaches its column.
- Header: tabs `Layers | Outputs` (O) + shrink toggle (shrunk = header only).
  A tab click or O expands it. Layers shows the opacity chip (section 8). The
  tab survives shrink and fullscreen.
- Height cap: in-node `max(580, node height - panel top)` (graph units);
  fullscreen: editor height minus panel top and bottom-bar clearance (never
  covers the bottom pills). Below the cap it fits content; only the tab's list
  scrolls.

**Narrow layouts** (`shell.ts`, `data-layout`): when the dock would overlap a
side group, the top row becomes one centred row and the bottom pills sit
together, centred. A bar wider than the node anchors to the node's **right**
edge, so overflow sticks out left into the graph, never under the side panel.

**Popovers** (`ui/popover.ts`) live inside the root (follow it into
fullscreen). One at a time, except nesting. Close on a press outside popover and
anchor, Esc, the Esc chain, the anchor leaving the DOM, or the parent closing.
**A stage press that closes a popover only closes it** (swallowed: never paints,
fills or selects). A second click on the same colour swatch closes its picker
(committing); the other swatch (FG <-> BG) switches pickers. Placement
flips/clamps inside the root widened to include the anchor.

**Menus** (`ui/menu.ts`): popovers with rows, dividers, optional title/footer.
Rows never take focus.

**Long-press** (`ui/longPress.ts`, `LONG_PRESS_MS` = **380 ms**): group slots,
Copy, Paste, Quick Mask, swatches (eyedropper reveal). Held press opens the
menu; right-click or the caret opens it at once. Release/leave/cancel ends the
timer; the click after a long-press is suppressed.

**Focus policy** (`ui/focusPolicy.ts`, `keyboard.ts`). Shortcuts work only while
the editor owns the keyboard: the hidden read-only `<input
class="cps-focus-sink">` or a text field inside the root has focus.

- Hover focuses the sink unless a text field elsewhere has focus; leaving hands
  focus back.
- A press inside **engages**: the sink takes focus (even from another node's
  text field) and keeps it after the pointer leaves, until the next press or
  focus move outside. Text fields, `<select>`, range sliders keep native focus.
  Never `preventDefault` a pointerdown on a range input (kills dragging).
- Non-text elements never keep focus (redirected to the sink). A text field
  blurring to nothing, or a popover closing, returns focus to the sink. A
  focused `<select>` / text field keeps it until the next press on a non-text
  control, so letter shortcuts are dead until then.
- Fullscreen always owns the keyboard; a backdrop click reclaims the sink;
  non-input elements outside the root never keep focus.
- No focus ring. `cps-has-keys` reflects real focus state (never hover guesses);
  chrome visibility follows the scope's active state.
- While active, `keydown`/`keyup` capture listeners on `window`; handled keys
  get `preventDefault` + `stopPropagation`. Keys from text fields pass through
  except Ctrl+S (in fullscreen, keys the pass-through policy would swallow are
  still stopped). A bare Alt press is prevented (Windows menu bar); modifier
  state (Space/Alt/Shift/Ctrl) resets on window blur and when the scope goes
  inactive.
- **Arrows**: engaged or fullscreen -> always swallowed, even when nothing
  nudges (ComfyUI would jump to another node). Hover-focused only -> pass to
  ComfyUI unless they nudge something (float, transform session, Move layer /
  Align drawing tool, or the selection outline with a selection tool). Alt/Ctrl
  +arrow left alone in-node. Keyboard graph navigation never moves the pointer,
  so the node can't grab arrows in passing.
- Why: ComfyUI's ChangeTracker listens on `window` capture, registers before
  extensions, and ignores keys only when focus is in an INPUT. Focusing the
  sink makes Ctrl+Z undo a stroke instead of a graph edit.
- The scope going inactive triggers an upload flush.

**Esc chain** (first consumer wins; `editorHost.ts`, `shortcuts.ts`
`handleEscape`): help overlay (close) -> Images tray, then any open menu,
fly-out or popover (close, keeping colour changes) -> open text edit (commit)
-> float or Free Transform (cancel) -> tool drag or pending interaction
(cancel) -> selection (deselect; not in region mode) -> fullscreen (exit).
Confirms are native dialogs and take Esc themselves. Esc never ends Solo, the
lmask-only view or region mode (sections 8 / 9 / 21). Esc in a text field
(rename, geometry) belongs to the field.

Files: `ui/` (shell, bars, popover/menu, focus/keyboard, `modifierScope.ts`),
`widget/nodeHooks.ts`, `styles/`.

## 8. Layers

### Kinds

| Row | Record | Notes |
|---|---|---|
| Paint layer | `Layer {kind: "paint"}` | Pixels, optional lmask. |
| Text layer | `Layer {kind: "text", textData}` | Rendered from `textData`; "T" badge; no lmask; a pixel edit asks to rasterize (becomes paint). |
| cmask ("Mask N") | `Layer {kind: "mask"}` | Alpha = coverage. |
| Image Mask / Input Mask | `doc.imageMask` (fixed id, not in `layers`) | Fixed row, see below. |
| Background | none, only `doc.backgroundVisible` | Fixed row, see below. |

Properties: `name` (trimmed, max 100, empty ignored); `visible` (not undoable;
hidden cmasks are excluded from MASK); `locked` (refuses pixel edits only --
delete/rename/reorder/opacity/eye still work; not undoable); `opacity` (paint:
composite; cmask: overlay, display only); `color`, `subtract` (cmask; its
coverage is removed from the union, section 3 step 7; toggling it is one undo
step); `layerMask` (paint only).

Invariants:
- `activeLayerId` is always a paint or text layer.
- cmasks sit above all paint layers (parse repairs; drag can't violate it).
- At least one paint-like layer remains (the last can't be deleted).
- 1..7 cmasks (Image/Input Mask row doesn't count): New mask disabled at 7; the
  last cmask can't be deleted (clear it instead). Old documents without one get
  "Mask 1" lazily (Q or To mask), no undo step.
- A new document is "Layer 1" + "Mask 1" (style from the `DefaultMaskColor` /
  `DefaultMaskOpacity` settings).

Naming: paint "Layer N" = highest existing N + 1; cmask "Mask N" = lowest free
N. Duplicates "Name copy", "Name copy 2" (an existing " copy N" suffix is
stripped first). Text layers are named from their text, pastes "Pasted" /
"Pasted N", inserted images by file stem or "Image N". Why: the two numbering
rules differ on purpose; don't unify them.

Mask palette (`defaults/maskDefaults.ts`): the first cmask uses the default
style; later ones take the first colour not used by a cmask from blue, green,
yellow, magenta, cyan, orange (`#0000ff #00ff00 #ffff00 #ff00ff #00ffff
#ff8000`), at the default opacity, cycling when all are used.

### Layers panel

The Layers tab of the side panel (section 7); `ui/layersPanel.ts` and siblings.

- **Header opacity chip** for the selected row (paint target, or the current
  cmask's overlay under Quick Mask; dimmed with no target). Each press starts a
  new undo gesture; a scrub or a slider-popover session is one step.
- **Sections**, top to bottom: **MASKS** (cmask rows; "+" = New mask, disabled
  at 7), **LAYERS** (paint and text rows; "+" = New layer), **SOURCE** (Image/
  Input Mask row if any, and Background: read-only, selectable, each with a
  Duplicate button; not collapsible, no header buttons). MASKS and LAYERS are
  collapsible (collapsed header names the current cmask / active layer) and have
  a Delete (trash) button that stays in the collapsed header. Headers are not
  rows (no selection, hover or drop target). Collapse is session UI state.
- **Row actions** (`layerRow.ts`):
  - cmask: colour bar (current cmask only), eye, thumbnail (raw coverage,
    white on black; a small subtract-icon badge when Subtract), name +
    colour swatch (picker; one undo step per session) + "Subtract" when on,
    Subtract toggle, lock, solo.
  - Paint / text: eye, thumbnail (image footprint incl. placement; "T" on
    text), lmask slot (section 9; not on text), name, lock, solo.
  - Image/Input Mask: as cmask, but a lock badge instead of lock, plus
    Duplicate; a hint while the Input Mask waits for a run.
  - Background: eye, thumbnail with lock badge, Duplicate, solo.
- **States**: `selected` = the paint target (active paint layer, or the current
  cmask under Quick Mask) or the selected Background; its targeted thumbnail
  (pixels or lmask) is ringed. `standby` = the active paint layer while Quick
  Mask is on or the Background is selected. The current cmask always has its
  colour bar. Hidden rows (eye off, or hidden by a solo) are dimmed.
- **Clicks**: a paint row selects it and turns Quick Mask off (keeping that
  layer's pixels/lmask target); a cmask or Image Mask row makes it the current
  cmask and turns Quick Mask on; Ctrl(+Shift/Alt)+click loads a selection
  (section 15); Background selects it read-only (Ctrl+click on it does
  nothing). Double-click the name to rename (not Background / Image Mask; Enter
  or blur commits, Esc cancels). Row buttons never select the row.
- **Reorder**: drag a paint/text/cmask row after 4 px (not with Ctrl, not from a
  control). Paint drops onto paint rows, cmask onto cmask rows; past the group
  end snaps to its edge row; auto-scroll near the edges. One undo step; the
  selection is unchanged.
- **Footer** (`layersFooter.ts`): New layer, New mask, Duplicate, Merge Down.
  - New layer: above the active paint layer, active, Quick Mask off.
  - New mask: above the current cmask, becomes current (Quick Mask on).
  - Duplicate: the selected row. A paint/text layer copies visible, locked,
    opacity and the lmask with pixels (above the original, active). A cmask
    (under Quick Mask) copies pixels, visible, locked, opacity and Subtract,
    takes the next free palette colour, sits above the original and becomes
    current + target; disabled at 7 cmasks. The Image/Input Mask row makes an
    editable cmask, Background an editable paint layer (below). One undo step.
  - Merge Down: disabled whenever Ctrl+E would be refused.
- **Delete** (`sectionDeleteState`) acts on the selected target: the current
  cmask under Quick Mask, otherwise the active layer (with an lmask targeted it
  deletes the layer; the lmask is deleted only from the bottom bar's lmask
  options). Each header's button works only while the selected row is in its
  section and deletable: MASKS = Quick Mask on and the current cmask isn't the
  last (never the Image/Input Mask row); LAYERS = Quick Mask off and the active
  layer isn't the last paint-like layer; with Background selected both refuse.
  A refused button is dimmed (`aria-disabled`) but clickable and shows the
  reason as the stage note. Afterwards the layer (or cmask) below becomes
  active/current, else the nearest above (`maskAfterRemoval`). Undo restores
  pixels and lmask.
- New layers, duplicates and new cmasks take over their group's solo when a
  solo is on.

### cmasks, current mask and Quick Mask

- Combine rule (section 3 step 7): union of the normal cmasks, the node's
  `invert_mask`, then the union of the **Subtract** cmasks is removed
  (`U * (1 - S)`). Colour and overlay opacity are display only.
- **Stage overlay**: normal cmask tints draw bottom to top above the paint,
  the Image Mask lowest. A Subtract cmask knocks most of its coverage out of
  the normal tints (a faint ghost stays, so the removed part reads lighter) and
  is drawn itself as a faint tint plus a diagonal hatch in its colour, so it is
  visible where it overlaps nothing too. The editor never previews
  `invert_mask`.
- **Current mask** (session only): the last selected cmask row (the Image/Input
  Mask row included); falls back to the top-most cmask. A new mask becomes
  current. **Target cmask** (session only): the last selected *real* cmask,
  which "To mask" adds to and "New mask" inserts above; it is kept while the
  Image/Input Mask row is current so those commands never land on a row that
  refuses every edit. **Why:** selecting the read-only row used to steal the
  "To mask" target and every later "To mask" failed with its refusal note.
- **Quick Mask** (Q, the bottom bar button, or clicking a cmask row) toggles
  the paint target between the active paint layer and the current cmask. While
  on, the button shows the mask colour, the swatches grey out, the edit chip
  names the cmask (section 7). Text tool, paste, Images panel inserts and New
  layer switch it off. Not available in region mode.
- Painting a cmask: brush, eraser, bucket, shapes, selection fill and Delete
  act on coverage. Strokes are forced white (FG/BG ignored); opacity and flow
  apply.
- Ctrl+click a cmask row selects its raw coverage, hard (Subtract is not a flip).
- Merge Down of cmasks: both normal or both Subtract -> union, the lower
  cmask's mode, colour and name. Different modes are refused with "Can't merge
  a Subtract mask with a normal one." (Ctrl+E note; the footer button disables),
  because a Subtract cmask acts on every cmask, not just the one below.
- Queueing while a hidden cmask has ever held paint shows "The mask is hidden."

### Image Mask / Input Mask row

- One fixed cmask-shaped row directly above Background. Eye, solo, colour,
  Subtract and Ctrl+click work; never lockable, renamable, draggable or
  deletable; not counted toward 7.
- **Image Mask** = the input image's alpha (coverage = 255 - alpha), uploaded
  as a PNG when the source changes. **Input Mask** = the `mask` input; replaces
  it while connected (no stored pixels).
- Selecting it makes it the current cmask (Quick Mask on) but not the target
  cmask; every pixel edit and Merge Down from it are refused with "<Image Mask |
  Input Mask> can't be edited -- duplicate it to edit."
- A new row takes the next free palette colour. Eye, colour, opacity and
  Subtract survive source changes (colour/opacity/Subtract undoable, eye not).
- **Duplicate** makes an ordinary cmask: raw coverage resampled into document
  coordinates, named "<row name> copy", next palette colour, the row's opacity,
  visibility and Subtract; bottom of the cmask stack, current; one undo step.
  Disabled without coverage or at 7 cmasks.
- Drawn and sampled only over an image of exactly its size.

### Background row and drawing resolution

- Background (= the input image): always locked, no rename/drag/delete. Its
  colour is the node's `background` widget (used opaque).
- **Selectable, read-only**: a click selects it (`Editor.selectBackground`;
  session state, not saved, not undoable): Quick Mask off, active layer and
  current cmask kept (active layer shows standby), no lmask targeted (lmask-only
  view ends). Every pixel edit, Move, Free Transform, flip, Merge Down, cut and
  Delete is refused with "Background can't be edited -- duplicate it to edit."
  (the edit gate; ban cursor); Copy works (reading isn't editing, section 17)
  and so does "To mask" (it names the target cmask, not the selected row;
  section 15). Any other selection ends it (a row, Q, the chip's Back, a new or pasted
  layer, the Move tool's auto-select, clicking text with the Text tool).
- **Duplicate** (row, footer, chip menu): what the background shows (the image,
  or the `background` colour without one; eye ignored) over the image rect in
  document coordinates, clipped to the maximum paint area, becomes paint layer
  "Background copy" at the bottom of the paint stack, active; one undo step.
- **Eye** (not undoable, saved as `backgroundVisible: false`): off shows a
  checkerboard; outputs use the `background` colour instead of the image and
  gain transparency (section 3); copy merged and "All layers" sampling exclude
  the image; "Background" sampling still reads it.
- **Mismatch notice** (`ui/resolutionNotice.ts`, pill above the bottom bar, any
  tool; section 7): shown when Match would resample by more than 1.5x (gives
  grid px, image px, ratio), or when the image area doesn't fit the maximum
  paint area (parts can't be painted); resolution wins if both. Never for an
  empty document or while loading. One warn toast per document per page
  session. While the condition holds the Align button is highlighted, even
  after × hid the pill (hidden until the text changes or Align drawing is on).
- **Match image resolution** (notice button, confirm): resamples every paint,
  cmask and lmask once so the frame matches what the image would give (never
  lowers resolution, up to 16384); placement is folded in and reset; text
  re-renders with scaled `textData`; bounds beyond 16384 are clipped around the
  frame centre. Clears undo history and the selection.
  Why: undo patches are in document coordinates, and the grid itself changes.

### Solo

- View only (`engine/solo.ts`). One slot for the paint group (paint, text or
  Background), one for cmasks (incl. Image/Input Mask). Clicking a solo
  replaces its group's solo; clicking the active one ends it.
- While any solo is set, the stage shows only the soloed layers (both groups),
  even with their eye off; the Background follows its eye unless soloed. Eyes
  are never changed.
- Solo affects "All layers" sampling and copy merged; not outputs, uploads or
  Ctrl+click selection. Never saved or undoable; ends on delete, merge, Clear,
  or a new session. Never changes the selection; clicking a solo settles a
  float first.
- Editing a layer that solo hides is refused ("The layer is hidden by solo.").
  A soloed layer with its eye off is still refused with the eye note.

### The edit gate

`preparePixelEdit` / `editBlockNote` (`engine/rasterize.ts`) is the single gate
before any pixel edit (brush, fill, shapes, selection fill/clear, move,
transform, flip, Merge Down, cut, Apply, lifts). It settles any float, then
refuses in this order: Image/Input Mask row -> eye hidden -> hidden by solo ->
lmask-tool note -> locked. Text layers then get the rasterize confirm. In the
lmask-only view the viewed lmask is editable even if its layer is hidden or
solo-hidden (lock still refuses). Copy refuses hidden layers but allows locked
ones. New pixel-editing paths must call this gate.

### Merge Down and Clear

- **Merge Down** (Ctrl+E or footer; `engine/mergeDown.ts`): merges the current
  row (active paint-like layer, or the current cmask under Quick Mask) into the
  row directly below in the same group. The lower row keeps name and settings;
  paint bakes the upper opacity in; text rasterizes first (prompt); the lower
  row becomes active / current. One undo step. Refused when either row is
  hidden, solo-hidden or locked, or nothing is below ("Nothing to merge down
  into."), or when the two cmasks differ in Subtract mode ("cmasks, current
  mask and Quick Mask" above); never into Background or the Image Mask row. An
  enabled upper lmask is applied first ("Layer mask applied."); the lower lmask
  stays.
- **Clear** (history pill, confirm): empties every layer, removes lmasks,
  converts text to paint, resets the frame to the minimum frame of the current
  image, resets placement, regions and Main options, ends solos and drops the
  selection (the frame can change, so its coordinates would be meaningless;
  undo restores it). Any float is committed and an open region edit cancelled
  first. Names, order, eye, lock, opacity, the current cmask and the Image Mask
  row stay. One undo step.

Files: `ui/layersPanel.ts` (+ `layerRow.ts`, `layerSections.ts`,
`layersFooter.ts`, `layerDrag.ts`, `imageMaskRow.ts`, `resolutionNotice.ts`);
`engine/layerOps.ts`, `editorMaskOps.ts`, `imageMaskOps.ts`, `solo.ts`,
`rasterize.ts`, `mergeDown.ts`, `frameOps.ts`, `drawingResolution.ts`,
`resolutionOps.ts`; `document/layerList.ts`, `masks.ts`, `imageMask.ts`.

## 9. Layer masks (lmask)

An optional grayscale mask on a paint layer that hides part of it
non-destructively. One per layer, always linked. **White = hidden, black =
shown.** Never reaches `MASK`. Text layers can't have one (rasterize first).

**Adding** (icon beside the layer thumbnail): click = reveal all, or with a
selection only the selection is shown (works with inverted selections; bounds
grow to cover it); Alt+click = hide all. Selects the layer, targets the new
lmask; one undo step.

**Thumbnails**
- lmask thumbnail: click = target the lmask (selects the layer, Quick Mask
  off); Shift+click = enable/disable (red X; not undoable); Alt+click =
  lmask-only view, also targets it (again ends it); Ctrl+click = **soft**
  selection of the shown (black) part (+Shift add, +Alt subtract, +Shift+Alt
  intersect; honours invert and `outside`; "The layer mask shows nothing." if
  empty). Inverse of a cmask's Ctrl+click, so selection -> add lmask ->
  Ctrl+click round-trips.
- Layer thumbnail click (when an lmask exists) = target the pixels. The target
  is per layer and session-only; other row clicks keep it.

**lmask-only view**: draws only that lmask as grayscale over the normal
background (cmask tints hidden). Moves to another layer's lmask thumbnail or a
row whose target is its lmask. Ends when the active layer has no lmask, targets
its pixels, or is text; when Quick Mask turns on or a cmask row is clicked; on
the Background row; when the layer/lmask is deleted; on Alt+click again. While
on, the viewed lmask is editable even on a hidden layer; bucket and wand sample
only that lmask; paste and drop go into it.

**lmask options** (bottom bar while an lmask is targeted, any tool; hidden
during Free Transform and in region mode): Invert (a setting, undoable), Apply,
Delete mask (undoable). The edit chip switches Pixels / Layer mask, the view and
enable (section 7).

**Apply** bakes the lmask as it acts (invert and `outside` applied) into the
layer's alpha and removes it; one undo step. Also bakes a disabled lmask
(clicking Apply means apply). Gate kind "whole": a hidden or locked layer is
refused, even in the lmask-only view.

**Swatches.** While an lmask is targeted the dock swatches become black/white
mask swatches (default white foreground). X swaps, D resets to white over black;
clicking a swatch does nothing. The real FG/BG are untouched.

**Tools while an lmask is targeted**

| Tool / command | Behaviour |
|---|---|
| Brush | Paints the foreground mask swatch: white hides, black reveals. Size, hardness, opacity, flow, spacing, pressure apply. |
| Eraser | Always reveals. |
| Bucket | Writes the foreground swatch into the flooded area at the tool opacity (white blends, black erases); no fill-under. |
| Magic wand | Samples per section 14. |
| Eyedropper (incl. Alt) | Refused: "Layer mask: black and white only, no eyedropper (X swaps)." |
| Line, Arrow, Rectangle, Ellipse | Refused: "Layer mask: use the brush, eraser or fill." |
| Text | Normal view: creates / edits a text layer (text never paints the lmask). lmask-only view: refused (same note), since text layers aren't visible there. |
| Delete / Alt+Backspace / Ctrl+Backspace (with a selection) | Reveal / fill with the foreground mask swatch / fill with the background mask swatch (white hides, black reveals). |
| To mask | Hides the selection on the lmask (white, soft kept). |

**Carry.** Whole-layer Move, Free Transform and flips carry the lmask (moves
and flips exact; a transform keeps its own original for the lmask; exposed
areas get `outside`). Selection floats follow the target: pixels targeted ->
pixels lift, lmask stays; lmask targeted -> the lmask's own pixels lift as
grayscale and replace what they land on; the vacated area reveals.

**Clipboard.** Pixels targeted: copy = the masked result, cut clears pixels
only. lmask targeted: copy = opaque grayscale, cut reveals. Paste makes a new
paint layer, except in the lmask-only view or when pasting into the current
layer (targeted lmask: gray float on it; section 17).

**Persistence and undo.** Add, delete, invert, Apply, strokes and fills are
undoable; enable, target, view and swatches are not. PNG upload like a cmask;
applied in Python by `nodes/layer_masks.py`. Clear removes lmasks (undo
restores them). Duplicate copies them.

Files: `engine/layerMask.ts`, `layerMaskOps.ts`, `layerMaskCarry.ts`,
`ui/layerMaskThumb.ts`, `document/layerMask.ts`, `nodes/layer_masks.py`.

## 10. Colour

- **FG/BG** (`engine/colors.ts`): default black / white, lowercase `#rrggbb`,
  per editor session (survives tab switches and graph undo; reset on reload;
  never saved).
- **Swatches** (`ui/swatches.ts`, tool dock): FG over BG, swap (X), reset (D);
  click a circle for the picker. Grey under Quick Mask; black/white mask
  swatches while an lmask is targeted (section 9; no picker). Hover or
  long-press reveals the eyedropper button (section 7).
- **Uses**: brush, bucket and line use FG. Rectangle/ellipse: stroke FG, fill
  FG; "Both" fills with BG. Text uses FG (changing FG recolours an open edit;
  re-editing a text layer loads its colour into FG). Alt+Backspace fills FG,
  Ctrl+Backspace BG (cmask: always white coverage; lmask: the mask swatches).
- **Picker** (`ui/colorPicker.ts`, popover): one picker for FG/BG, cmask colour
  and output fill/border. No alpha.
  - **Wheel**: hue ring around a **fixed** (never rotating) saturation/value
    triangle. A press on the ring drags hue, in the triangle drags in it
    (clamped); the zone is fixed for the drag; presses in the gaps do nothing.
    Greys keep their hue while open; a picker opened on black, white or grey
    starts at the hue the last picker closed with
    (`localStorage["PainterSketch.colorLastHue"]`, shared), first time 260°
    (`GREY_HUE`).
  - **Swatch**: top = new colour, bottom = the colour on open (click reverts).
  - **Circle groups** (`colorSchemes.ts`): current colour plus two partners;
    clicking a partner takes it and the group recomputes. A cycle button per
    group changes mode, remembered in `localStorage`:
    - Harmonies (`PainterSketch.colorHarmony`), hue partners at the same S/V:
      Analogous (±30°) -> Triadic (±120°) -> Split-complementary (180° ±30°).
    - Variations (`PainterSketch.colorVariation`): Lighter / darker (RGB mix
      30 % white / black) -> Warmer / cooler (RGB mix 20 % `#ff7a1a` /
      `#1a6cff`: no seam on the wheel, greys warm and cool too) -> More / less
      saturated (±25 %).
  - **Value row** (`colorFields.ts`): Hex (no `#`, upper case, 3 or 6 digits),
    RGB (0-255), HSV, HSL (H 0-360, others 0-100); a button cycles the format
    (`localStorage["PainterSketch.colorFormat"]`). Typing applies as soon as
    every field parses; a bad field is marked red and the colour stays. Enter
    applies and leaves the field (doesn't close); ArrowUp/Down steps by 1
    (Shift 10); leaving the row rewrites the fields.
  - Up to 10 recent colours (`localStorage["PainterSketch.recentColors"]`,
    saved when the picker closes with a changed colour; shared).
  - **Eyedropper while open** (FG/BG picker): a sampling stage press (Eyedropper
    tool, or Alt with a tool that has the temporary eyedropper; not with Ctrl
    or Space) or the dock's eyedropper button goes through and keeps the picker
    open; the picker follows the sample without echoing it back. While the
    **BG** picker is open every sample goes to BG, with or without Alt
    (`ColorState.sampleSlot`).
  - Click outside commits and closes. **Esc closes and keeps the colour** in
    every picker, even from a field; only the swatch's lower half reverts.
- **Eyedropper**: see Tools.

Files: `engine/colors.ts`; `ui/swatches.ts`, `colorPicker.ts`, `colorWheel.ts`,
`colorWheelGeometry.ts`, `colorSchemes.ts`, `colorFields.ts`, `colorMath.ts`,
`recentColors.ts`.

## 11. Undo and redo

- `HistoryStack`: undo and redo stacks sharing a **256 MB** budget; oldest undo
  entries are dropped silently (the newest is always kept). A push clears redo.
  History lives with the session (survives tab switches), is not saved and not
  copied by forks. **Graph undo never touches paint history.**
- Entry types: `patch` (dirty rect before/after, doc coords), `layers` (add,
  remove with pixels and lmask, move, props), `translate` (lossless layer
  move), `text`, `layerMask` (add/delete/invert), `selection`, `outputs` (region
  and Main metadata), `clear` (full snapshots), `group`.
- Same-gesture property edits merge (a scrub, a picker session, consecutive
  nudges); a merged gesture that ends where it started leaves no step.
  `joinNext` / `joinSince` fold related pushes into one step (rasterize + edit,
  insert + transform commit, float + lmask carry). A stroke that changes no
  pixel adds no step.
- Not undoable: eyes (layer and Background), lock, solo, active layer, Quick
  Mask and current cmask, lmask enable/target/view/swatches, FG/BG, Align
  drawing placement, view, Match image resolution (clears history), Image/Input
  Mask source changes. Frame adoption on an empty document drops history (after
  a Clear: truncates to it).
- Undo / Redo (history pill, Ctrl+Z / Ctrl+Y): disabled during a stroke; Undo
  also enabled while a float or transform is active.
- Special cases: with a float or transform active, Undo cancels it and Redo is
  ignored; Undo during a Move or region drag cancels the gesture; Undo with an
  open text edit commits it first, then undoes it.

Files: `engine/history.ts`, `editorTypes.ts`, `layerHistory.ts`, `paintOps.ts`,
`editor.ts`; `ui/historyPill.ts`, `shortcuts.ts`.

## 12. Tools

### Common mechanics

**Dock and keys** (`ui/toolDock.ts`; tools and keys in `tools/registry.ts`).
Dock: `Brush, Eraser, Fill | Select group, Move layer | Shapes group, Text |
swatches` (section 7).

| Slot | Tool ids | Key |
|---|---|---|
| Brush | `brush` | B |
| Eraser | `eraser` | E |
| Fill (paint bucket) | `bucket` | G |
| Select (dock group) | `marquee-rect`, `marquee-ellipse`, `lasso`, `wand` | M, Shift+M cycles the marquees; L; W |
| Move layer | `move-layer` | V |
| Shapes (group) | `line`, `arrow`, `rectangle`, `ellipse` | U, Shift+U cycles |
| Text | `text` | T |
| Eyedropper (no dock button) | `eyedropper` | I; hover reveal above the swatches; Alt |

Hidden tools (no button, no key): `move` (Align drawing), `region` (Outputs tab
/ O), `transform` (Free Transform session), `selection-outline` (substituted at
pointer-down).

**Tool groups** (`toolGroups.ts`): one dock slot showing the last-used member;
long-press or right-click opens a fly-out. The key selects the last-used member;
Shift+key advances to the next (wraps).

**Resolution at pointer-down** (`ToolRegistry.resolve`), locked for the drag:

1. A Free Transform session takes all input, except Alt + press outside its box
   (not a handle, inside, or the rotate zone) with an `altEyedropper` rail tool:
   temporary eyedropper, session stays open. Ctrl is ignored during a session.
2. A plain press (no modifiers) inside the selection with a selection tool
   (marquees, lasso, wand; not mid-polygon) -> outline drag.
3. Ctrl -> temporary Move layer with auto-select, for rail tools with `ctrlMove`
   (default on; off for Text, Move layer, Align drawing, region, transform, and a
   lasso with an open polygon).
4. Alt -> temporary eyedropper, for `altEyedropper` tools: Brush, Bucket, Line,
   Arrow, Rectangle, Ellipse.
5. Otherwise the active tool.

Ctrl beats Alt. Modifier tracking is observe-only (cursors). Pan (middle-drag,
Space+drag) is handled before any tool.

**Options** are declarative descriptors (number, toggle, select, button, text,
label) rendered by the options strip (`ui/optionsStrip.ts`); no per-tool UI
code. Each tool instance keeps its values for the session (Brush and Eraser
separately, each shape separately). Setting-backed defaults are read once when a
session's tools are created. Strip extras: Transform / Flip H / Flip V (Move
layer always; selection tools while a selection exists), To mask / Invert while
a selection exists. A Free Transform session replaces the whole strip (`[` `]`
and digit keys still change width/size and opacity).

**Paint target**: the active paint/text layer; the current cmask under Quick
Mask; the lmask when the active paint layer targets it (Quick Mask off).
Sections 8 and 9.

**Pointer samples**: coalesced events, converted to doc coords through the frame
map. Pressure only for `pointerType === "pen"` (else 1). Option sizes are image
px, converted at pointer-down. Modifier changes during a drag re-send the last
sample with the new flags.

**Selection clip**: brush, eraser, shapes and bucket are clipped to the
selection coverage (soft coverage scales the result), and all to the image area
(see "Painting stays on the image").

### Brush (B) and Eraser (E)

| Option | Range | Brush | Eraser |
|---|---|---|---|
| Size | 1..1000 px (pow curve) | 24 | 48 |
| Hard | 0..100 % | 80 % | 80 % |
| Opac | 1..100 % | 100 % | 100 % |
| Flow | 1..100 % | 100 % | 100 % |
| Spc (spacing) | 1..400 % of diameter | 25 % | 25 % |
| Pressure: Size | toggle | setting, on | same |
| Pressure: Opacity | toggle | setting, off | same |
| Pressure: Min size | 0..100 % (enabled with Size) | setting, 10 % | same |
| Pressure: Curve gamma | 0.2..5 (enabled with either) | setting, 1 | same |

- Brush paints FG; eraser composites `destination-out`. Esc / pointer-cancel
  drops the stroke. Alt = eyedropper (brush only); Ctrl = temporary Move.
- **Shift+click**: a straight line from the previous brush/eraser stroke end
  (editor-wide `lastStrokeEnd`, doc coords; reset by Clear, undo/redo of Clear,
  and Match; none -> plain click; shapes don't set it). Own stroke and undo step
  at the press's pressure. The spacing phase (per tool) carries through the
  joint with no dab there, so a same-tool continuation at 100 % opacity equals
  one continuous stroke.

### Paint bucket (G)

| Option | Range | Default |
|---|---|---|
| Tol | 0..255 per channel | 32 |
| Opac | 1..100 % | 100 % |
| Contiguous | toggle | on |
| Anti-alias | toggle | on |
| Sample | Current layer / All layers / Background | setting `BucketSample`, `background` |

- A click floods (section 14) over the image area inside the draw area (bounds
  grow to cover it, never past); a click outside it does nothing.
- Clipped by the selection; one undo patch; no change = no step.
- With anti-alias the fill also goes behind the target's own soft edges
  (`fillUnder.ts`; not on cmasks/lmasks), so filling around a stroke leaves no
  halo.
- cmask: white coverage at the opacity. lmask: the foreground mask swatch.

### Eyedropper (I)

| Option | Values | Default |
|---|---|---|
| Sample | Current layer / All layers / Background | All layers (no setting) |
| Size | Point / 3x3 average / 5x5 average | Point |

- Press/drag/release pick live into FG; **Alt+click with the eyedropper itself**
  picks into BG. The temporary (Alt) eyedropper always writes FG and shares these
  options. Esc / cancel keeps the last sampled colour.
- Transparent or off-layer samples leave the colour unchanged; averages are
  alpha-weighted.
- "Current layer" = the active paint/text layer's raw pixels (never the cmask,
  even under Quick Mask; nothing without a paint layer); ignores hidden/locked.
- Refused while an lmask is targeted (also the temporary one).
- A loupe shows the new and previous colour (`ui/loupe.ts`).

### Line and Arrow (U group)

| Option | Range | Default |
|---|---|---|
| Width | 1..500 px (pow), `[` `]` | 4 |
| Opac | 1..100 % | 100 % |
| Arrow | None / End / Both | Line: None, Arrow: End |
| Head | 150..1500 % of width | 400 % |

- Drag rebuilds the shape from start to current each move (live in the stroke
  buffer). Esc drops it; zero length makes nothing. Shift snaps to 15 degrees.
  Round caps, FG. Arrowhead length `width x Head`, max 90 % of the line per head.
- **Release opens the shape in Free Transform** (all shape tools,
  `engine/shapeFloat.ts`): a float on the current target layer (never a new
  layer; cmask = white coverage), axis-aligned box. Enter / tool switch / any
  edit commits one step; an untouched commit writes exactly the drawn pixels.
  Esc / Cancel / Ctrl+Z removes it (no history; a text layer's rasterize step
  stays). With the shape tool, a press on a handle, inside or in the rotate zone
  transforms; elsewhere it commits and starts the next shape in the same gesture
  (Alt there = eyedropper, session kept; Ctrl ignored). The selection clips the
  shape once, when it becomes the float; the float never changes the selection.
  A shape changing no pixel ends silently (no session, no step). A committed
  shape on an empty layer becomes its kept original (section 18).

### Rectangle and Ellipse (U group)

| Option | Values | Default |
|---|---|---|
| Width | 1..500 px (pow), `[` `]` | 4 |
| Opac | 1..100 % | 100 % |
| Mode | Stroke / Fill / Both | Stroke |

- Same drag model and Free Transform on release. Stroke and Fill use FG; Both
  strokes FG and fills BG. Stroke centred on the edge, over the fill; corners
  mitred; rectangles pixel-aligned, ellipses anti-aliased.
- Shift = square/circle; Alt during the drag = from centre (Alt at pointer-down
  is the eyedropper, also during a shape's session).

### Text (T)

| Option | Values | Default |
|---|---|---|
| Font | text with suggestions | `sans-serif` |
| Size | 1..1000 image px (pow) | 48 |
| B / I | toggles | off |
| Align | Left / Center / Right | Left |
| Angle | -180..180 degrees | the target's rotation |

- Fonts: 5 recent (`localStorage["PainterSketch.recentFonts"]`), then a fixed
  list; custom font field (max 100 chars); a missing font shows a note.
- `textData`: `text` (lines `\n`, max 10000 chars), `x`, `y` (baseline of the
  first line at its left/centre/right edge per `align`, document px), `font`,
  `size` (doc px, 1..4096), `color`, `bold`, `italic`, `align`, `lineHeight?`
  (default 1.25), `rotation?` (degrees about the unrotated box centre; dropped
  at 0).
- **Pointer-down**: Ctrl -> move the text under the pointer (else the active
  text layer) via `textData` (never rasterizes). Otherwise an open edit commits
  (a click on empty canvas or the same text only commits; on another text opens
  it); Quick Mask switches off; a click on a text layer (topmost visible, rotated
  box + 15 % margin) re-edits it (locked/hidden: their note); else new point
  text at the click (new layer above the active paint layer, named from its text
  on commit). Any non-Ctrl click drops the selection (own undo step; the
  lmask-only view refuses the click). Point text only (no wrapping boxes).
- **Editing**: `<textarea>` overlay (transparent text; canvas shows the real
  rendering). Enter = new line; Esc or Ctrl+Enter commits. Keys belong to the
  field (Ctrl+Z = native text undo; Ctrl+D only prevented). Option/FG changes
  apply live. Also commits on tool switch, undo, layers-panel actions, focus
  leaving the editor.
- **Commit**: create + type = one step; editing = one text step; empty or
  whitespace-only text removes the layer (keeping the last paint-like layer).
- Angle: live on an open edit, else one merged step on the active text layer.
  Free Transform keeps text editable for rotation and uniform scale (section 18).
- Pixel edits on a text layer ask to rasterize; OK converts it to paint in the
  same undo step (strokes and shapes abort that press; the bucket continues).

### Move layer (V), Align drawing, region, outline drag, transform

Described in sections 19 (Move layer, Align drawing), 21 (region tool), 15
(outline drag) and 18 (Free Transform).

### Marquees (M group), Lasso (L), Magic wand (W)

Described in section 15. The wand's options and sampling are in section 14.

Files: `tools/` (one per tool), `engine/paintOps.ts`, `shapes.ts`, `textOps.ts`,
`document/textData.ts`, `ui/textOverlay.ts`.

## 13. Brush engine

**Why: the tip and combine rule are measured from Photoshop's lossless exports,
not designed.** Swept-profile / "max" / "alpha darken" schemes from eyeballing
screenshots all creased where a stroke met itself and left Voronoi-like cells
when colouring in. Change the tip or the combine rule only against a new
lossless Photoshop export, measured. Measurements and rejected variants are in
the archive ("Brush engine").

**Tip** (`brush.ts`): alpha at distance `d` is `10^-(d/R)^2`, `R = size/2`: at
hardness 0, 10 % at the nominal radius, 50 % at 0.55 R, cut off at 1.5 R (fit
error < 1/255). Hardness `h` gives a solid core to `h*R` and squeezes the same
fade into `(1-h)*R`, never thinner than 1 px (`fade = max(1-h, 1/R)`,
`core = min(h, 1 - fade/2)`), so 100 % is a 1 px anti-aliased edge. Hardness 0
is measured; 0 < h < 1 is our interpolation (user-compared with PS at 50 and
100 %).

**Dabs** (`placeDabs`): evenly spaced along each segment between samples, step
`max(0.5 px, spacing x current diameter)`; position and pressure interpolated;
the first sample always gets a dab (except a Shift+click line); minimum diameter
0.5 doc px.

**Pressure** (pen only): size factor `min + (1 - min) * p^gamma`; opacity is a
per-dab coverage cap `p^gamma` that never lowers what is already painted (zero
pressure paints nothing). Pressure never affects flow. The ring doesn't reflect
pressure.

**Flow and opacity**: flow is the per-dab alpha (times the tip); opacity is
applied once at commit.

**Combine** (`dabMask.ts`): every dab composites **source-over** into a 16-bit
stroke coverage mask: `c += a * tip * (1 - c)`. Strokes are much denser than a
click; crossings, corners and Shift+click joints fill in without creases; at
40 % spacing dabs show as circles with solid interiors, as in PS.

- `strokePath.ts` merges evenly spaced straight runs (every dab within 0.35 px
  of the chord, up to 4 radii); each dab belongs to exactly one segment.
- A run is applied per pixel as `1 - exp(-sum q)`, `q = -ln(1 - a*tip)` = exactly
  the over-composite, so batching never changes the result. Tables are indexed
  by squared distance and cached per (profile, flow). Under 5 % spacing every
  m-th dab stands for m.

**Stroke buffer** (`stroke.ts`): coverage is written to a buffer canvas as one
colour with alpha = coverage, only in the dirty area (8-bit premultiplied
stacking drifted soft edges into rings). Preview = layer + buffer x opacity in
the dirty rect. On pointer-up the buffer is composited at the stroke opacity
(`source-over` / `destination-out`). The selection clip multiplies the buffer
(`destination-in`) right before compositing, so soft coverage never compounds.
The undo patch is the touched rect. Shapes reuse the buffer but replace its
content each move. Bounds grow (chunked) to cover dab reach + 2 px, never past
the image area; preview and commit are cut to it (`StrokeBuffer` `limit`).

**Cursor ring** (`ringDiameter`): `size x min(1, core + fade x 0.77)`. 0.77 is
measured in PS at hardness 0 (80 px -> 60 px ring, 300 px -> 230 px; the tip is
~25 % opaque there). The ring shrinks with softness; full size at 100 %.

Open (not measured against PS): flow below 100 % and pressure -> opacity. Curve
smoothing of pointer samples (fast loops are polygons) was offered, not
requested.

Files: `engine/brush.ts`, `strokePath.ts`, `dabMask.ts`, `stroke.ts`,
`tools/paintTool.ts`, `defaults/pressureDefaults.ts`.

## 14. Fill and wand sampling

One path decides what the bucket and the wand read (`sampleTarget`,
`engine/pixelOps.ts`):

| Situation | What is read |
|---|---|
| lmask-only view with the viewed lmask targeted | That lmask as opaque gray (white = hidden), invert and `outside` applied. Wins over the Sample option; works on a hidden layer. |
| Current layer, paint/text target | The layer's raw pixels (its lmask not applied). |
| Current layer, cmask target (incl. Image/Input Mask) | The cmask's raw coverage as opaque gray (Subtract not applied); the Image/Input Mask is resampled to doc coords, 0 outside the image. |
| Current layer, no layer | Falls back to All layers. |
| All layers, pixel or lmask target | The visible composite: background + visible paint layers at opacity, lmasks applied, solo and the Background eye honoured; no cmask tints. |
| All layers, cmask target | The combined result of the cmasks shown on the stage (eye and solo respected): normal union minus Subtract union (section 3 step 7, without `invert_mask`); the Image/Input Mask row joins while shown and applicable. Matches Python's MASK to 1/255. |
| Background | Only the input image (or the width x height fill), same placement, no paint; reads the image even with the Background eye off. |

**Hidden targets**: the bucket goes through the edit gate (hidden target refused
for any Sample, except the gate's own exception: the viewed lmask in the
lmask-only view is fillable on a hidden layer). The wand with Current layer on a
hidden paint layer or cmask refuses with the hidden note and keeps the
selection; other sources and the lmask-only view never refuse on visibility.
The wand doesn't check lock.

**Matching** (`floodFill.ts`): every channel (R, G, B, A) within `tolerance` of
the seed, compared premultiplied (nearly transparent matches transparent; two
transparent pixels always match). Contiguous = 4-neighbour scanline fill; else
every matching pixel. Anti-alias adds a 1 px soft fringe outside the hard result
(3x3 box). Seed = `floor(point)`; a seed outside the area gives nothing. Area:
bucket = image area inside the draw area (bounds grown to it); wand = image area
union bounds (no growth).

**Magic wand (W)** options: Tol 32, Contiguous on, Anti-alias on, Sample
(setting `WandSample`, `background`). The result combines with the selection by
mode (section 15); a miss in replace mode deselects.

Files: `engine/pixelOps.ts`, `floodFill.ts`, `docComposite.ts`, `fillUnder.ts`,
`tools/fill.ts`, `tools/magicWand.ts`.

## 15. Selection

**Model** (`engine/selection.ts`): a 0..255 coverage buffer in doc coords
(follows the drawing, not the image), stored cropped as `{rect, data, outside:
0 | 255}`: every pixel outside `rect` has the value `outside`, so an inverted
selection keeps covering paint area added later. Results are trimmed; empty =
`null` (no selection). Session state, never saved. Every change is one
`selection` history entry. New coverage is clipped to the bounds cap union
current bounds.

| Mode | Rule |
|---|---|
| replace | new coverage (empty -> deselect) |
| add | `max(a, b)` |
| subtract | `min(a, 255 - b)` |
| intersect | `min(a, b)` |

**Modifiers** (`selectionModifiers.ts`): with a selection, Shift/Alt at
pointer-down pick the mode (Shift = add, Alt = subtract, Shift+Alt = intersect),
fixed for the drag. Without a selection the mode is replace and held keys
constrain at once (Shift = square/circle, Alt = from centre; lasso: straight
segments). A key used as a mode key only constrains after being released and
pressed again. Alt is never the eyedropper in selection tools.

**Tools**

- **Marquees**: rectangle hard-edged (a pixel is in if its centre is), ellipse
  anti-aliased. A click without a drag deselects (replace mode only). Esc cancels.
- **Lasso**: anti-aliased, non-zero winding. Alt held with the button down =
  straight segments (rubber band); releasing Alt resumes freehand. Releasing the
  button with Alt held keeps the path open (`pending`): each press adds a
  vertex; it closes on releasing Alt, a double-click (<= 400 ms, within slop),
  or a click near the start (> 2 points). Releasing the button without Alt
  closes it. Esc or a tool switch cancels. A bare click deselects (replace
  mode). Ctrl->Move is suppressed while a polygon is pending.

**Commands** (all go through the edit gate and settle a float first;
`ui/selectionShortcuts.ts`)

- Select all (Ctrl+A): the current image area in doc coords (includes
  placement); bounds grow to cover it.
- Deselect (Ctrl+D). Invert (Ctrl+Shift+I, Shift+F7, or the strip button); no
  selection stays none. Not implemented: Reselect, feather, grow/shrink, refine
  edge.
- Delete / Backspace: clear the selected part of the target (paint: alpha x
  (1 - c); cmask: remove coverage; lmask: reveal). Without a selection Delete is
  swallowed silently (so the graph never deletes the node).
- Alt+Backspace / Ctrl+Backspace: fill with FG / BG (cmask: white coverage for
  both; lmask: the foreground / background mask swatch). Without a selection: a
  "Nothing is selected." note.
- **To mask** (strip button): adds the selection coverage (soft kept) to the
  target cmask (section 8: the last real cmask, never the Image/Input Mask
  row), creating one if none; does not change the paint target and is not
  refused by a selected Background row (the cmask's own hidden/locked state
  still is). With an lmask
  targeted it hides the selection on that lmask instead (white, soft kept,
  through the edit gate). One undo step.
- Arrow keys with a selection tool active and a selection (no float) nudge the
  outline 1 / 10 image px; consecutive nudges are one undo step.

**Marching ants** (`marchingAnts.ts`): boundary at coverage >= 128. An inverted
selection also draws ants along the image-area edge, but its coverage is **not**
bounded by the image. Hidden during a transform drag.

**Selection from a row** (Ctrl+click; +Shift add, +Alt subtract, +Shift+Alt
intersect):

- Paint, text and cmask rows: **hard** (alpha > 0 -> 255); a cmask uses its
  raw coverage (Subtract is not a flip); the lmask is ignored; works on hidden layers; doesn't
  change the current layer, Quick Mask or solo; settles a float first; an empty
  layer notes and keeps the selection.
  Why: a soft selection left an `a*(1-a)` residue on every edge when moved, and
  ghosted on repeat.
- Image/Input Mask row: hard, raw coverage, resampled to doc coords.
- lmask thumbnail: **soft**, the shown part (section 9).
- The Background row can't load a selection.

**Outline drag** (`tools/outlineDrag.ts`): a plain press inside the selection
(coverage >= 128) with a selection tool drags only the outline, whole doc px,
one `selection` entry; Esc restores it; a press that never leaves the click slop
is replayed to the tool as a click. A live float is committed first.

**Following**: a whole-layer move (drag outside the selection, or nudges)
carries the selection in the same undo step (`selectionFollow.ts`).

## 16. Floating selections

A float is transient editor state (never a layer, never saved), drawn above its
own layer inside that layer's display (opacity, visibility and cmask tint
apply). It moves in whole doc px; nothing is resampled until a transform. The
outline moves with it. Bounds grow while it floats so it can be shown (past the
cap is cropped on commit); commit and cancel return the bounds to their
pre-float value (`FloatState.boundsBase`), then commit grows them only for where
the float lands. An oversized paste scaled down inside the image never grows the
layers.

**Starting a float** (decided at pointer-down, `float.check()`; a refused lift
never falls through into a layer move; a text layer defers the rasterize
confirm until the press ends, drag again afterwards)

- Move layer: a press inside the selection (coverage >= 128) lifts the selected
  pixels; Alt at pointer-down lifts a copy (no hole). Outside moves the whole
  layer (selection follows). While a float exists, any drag or arrow nudge moves
  it.
- Any rail tool: Ctrl+drag inside lifts, Ctrl+Alt+drag lifts a copy.
- Free Transform with a selection lifts as a cut (section 18).

**What lifts**: pixels coverage-weighted (float alpha `a*c`, remainder
`a*(1-c)`). Paint/text: pixels, the lmask stays. lmask targeted: its pixels as
grayscale; they replace what they land on, the vacated area reveals. cmask
under Quick Mask: like paint. A whole-layer lift (Free Transform without a
selection) carries the lmask. Empty lift: a note.

**Commit / cancel** (owning rules; sections 17, 18, 20 refer here)

- Commit lands the float as one patch (source union destination) joined with the
  selection move into one step. Triggers: Enter, any other edit, deselect or
  selection change, tool switch, layer/target change, queue and Ctrl+S. A float
  that never moved commits as a cancel (no step).
- View changes (eyes, Background eye, solo, lmask on/off) leave it floating;
  only hiding the float's own layer (eye or solo) commits it, since a hidden
  layer is not editable.
- Cancel (Esc or Ctrl+Z) restores the pre-lift pixels and selection with no
  history; Ctrl+Y is ignored while floating. Cancelling an inserted image or an
  oversized paste also removes its layer and restores the previous selection.
- Arrow keys nudge a float whatever the active tool (1 image px, Shift 10; the
  key is swallowed even when the nudge is refused); in a Free Transform session
  the session nudges.
- Idle / blur / tab-hidden uploads while floating save the pre-lift pixels
  (never half a float); queue and Ctrl+S commit first.
- A shape float (section 12) leaves the selection as it is on commit and cancel.

Files: `engine/floatOps.ts`, `floatLift.ts`, `floatCommit.ts`,
`layerMaskCarry.ts`, `ui/floatShortcuts.ts`.

## 17. Clipboard and drop

**Copy / cut** (each settles a float first)

- Ctrl+C: the target's selected pixels (coverage-weighted), or the whole layer
  without a selection; trimmed to non-transparent pixels. cmask (incl. the
  Image/Input Mask row): raw coverage as opaque grayscale (white = masked).
  Paint with an enabled lmask: the masked result; lmask targeted: the lmask as
  grayscale.
- Ctrl+Shift+C (copy merged): what is visible, including the image, within the
  selection or the image area; no image when the Background eye is off; under
  Quick Mask the combined cmask result as grayscale (the same rule as "All
  layers" sampling, section 14; the Image/Input Mask row included).
- Ctrl+X: copy + clear in one patch (text rasterizes first; lmask: reveals).
- Hidden / solo-hidden layers refuse; locked layers can be copied. The read-only
  SOURCE rows copy too (reading isn't editing): Background what it shows (image
  or fill, eye ignored), Image / Input Mask its effective coverage as grayscale;
  cut on them is refused like any edit.
- The copy goes to a module-level internal clipboard (shared by all PainterSketch
  nodes on the page: pixels, doc rect, image scale, a 16x16 fingerprint, the
  source editor) and as a PNG to the system clipboard (failure console-only).
- Buttons (`ui/clipGroup.ts`): Copy (or Copy merged), Cut, Paste (System
  clipboard or Clipspace, + the toggle below); a menu pick runs and sticks.

**Paste**

- Ctrl+V / Paste button: a system-clipboard image (unless it is our own PNG by
  fingerprint -> the internal copy) -> internal copy -> ComfyUI clipspace ->
  note. "Our own" = an internal copy exists, same pixel size, and the mean
  absolute difference over the 16x16 RGBA thumbnails is <= 4. The keydown is
  stopped but not prevented, so the browser fires `paste`; a one-shot capture
  `paste` listener (1 s) takes it before ComfyUI.
- Ctrl+Shift+V (no button): the internal copy at its copied doc position, not
  clamped, also from another PainterSketch node (same spot across nodes);
  without one, like Ctrl+V (Chrome fires no `paste` for it, so the async
  clipboard is read).
- **Insert into current layer** toggle: sticky per editor; picking it doesn't
  paste; always on in Simple mode; also covers drops and Images panel inserts.
- Default: a new paint layer "Pasted" / "Pasted N" above the active paint layer
  (above the top paint layer under Quick Mask); one undo step; Quick Mask off;
  selection dropped in the same step; takes over solo. Foreign images paste
  1 source px = 1 image px; internal copies keep their image-px size. The pasted
  pixels become the layer's kept original (section 18).
- **Placement** (`pastePlacement.ts`, measured from Photoshop, first match wins):
  1. A selection exists: centre on its bbox (inverted = the image area).
  2. Our own copy from this editor: its original position.
  3. The whole image area is visible: its centre.
  4. Otherwise: the view centre.
  Then clamp into the image area (centred on an axis where the item is larger)
  and snap to whole doc px.
- **Oversized** (larger than the image area after the clamp, or a paste in place
  reaching outside it): opens in a Free Transform session fitted inside the
  image area (about its placed centre, aspect kept, never enlarged; `fitRect`).
  The session keeps the full source pixels; the commit resamples once. A note
  explains it. Why: nothing lands outside the image, or is cropped at the cap,
  without a commit.
- **lmask-only view** (wins over everything): every paste and drop goes into the
  viewed lmask as an lmask float (value = Rec.709 luminance x alpha, so
  transparent = shown; our own lmask copies keep exact values; the lmask's
  invert is ignored so copies round-trip), normal placement; oversized -> Free
  Transform on that float.
- **Into the current layer** (toggle / Simple mode): no new layer. Every paste
  and drop floats on the current edit surface at the normal placement: a paint
  layer's pixels (composited over on commit), its targeted lmask, or under
  Quick Mask the current mask (made if none; Quick Mask stays on). Masks and
  lmasks take the gray value as above, replacing what they land on. The float's
  outline replaces the selection (To mask / Invert hidden for it) and the tool
  switches to Move layer without settling it; commit = one step (outline
  dropped), cancel = nothing happened (old selection back). Oversized -> Free
  Transform on that float (no outline, tool unchanged). Text asks to rasterize;
  Background, Image Mask, locked or hidden targets refuse with their note; no
  layer at all: a note.

**Drop** (`ui/dropImport.ts`): image files (one layer per file, at the drop
point, same clamp) and images dragged from web pages (`<img src>` / uri-list,
fetched). Workflow JSON and other known non-image files are left to ComfyUI. A
CORS-blocked web image gives a toast; a non-image a note.

Files: `engine/clipboardOps.ts`, `pastePlacement.ts`, `ui/clipboardActions.ts`,
`pasteSources.ts`, `dropImport.ts`.

## 18. Free Transform and flips

**Entering**: Ctrl+Alt+T (literal `t`, AltGr-safe; Ctrl+T is Chrome's) or the
Transform button. In order: an existing float is adopted; a text layer -> text
session over its box (selection ignored); a selection -> lift as a cut; else the
kept original if valid, else the whole layer content (carrying the lmask).
Parameters `{cx, cy, sx, sy, angle}`; signed scale = flip. No skew, distort,
warp, movable pivot or multi-layer.

**Handles** (`transformHit.ts`): 8 handles, screen-constant. A handle scales;
inside moves; just outside a corner rotates; elsewhere nothing (Alt eyedropper /
shape-tool exceptions: section 12). Scale is proportional by default (Link on;
an edge handle then scales both axes, as in Photoshop); **Shift inverts** that;
**Alt** on a handle scales about the centre; minimum side 1 doc px. **Shift
while rotating** snaps to 15 degrees. Arrows nudge 1 image px, Shift 10. The
session takes all other stage input (no Ctrl substitution).

**Options strip** (replaces the tool's): X, Y (box centre, image px), W, Link,
H (1..10000 %), Angle (-180..180), Flip H, Flip V, Commit (Enter), Cancel (Esc).

**Commit / cancel**

- Commit: Enter, the check button, a tool switch, or any other edit.
  Whole-layer and inserted sessions commit at once (one step, one resample). A
  **selection-float** session only ends: the float stays (with its matrix over
  the original lifted pixels) until it commits (section 16); a later session on
  it restarts from the original with the cumulative matrix.
- Cancel: Esc, the x button, or Ctrl+Z cancels the whole session (including the
  lift); no per-adjustment undo.
- Preview draws the original through the matrix; commit resamples once from the
  original (bilinear on premultiplied alpha, up to 4x4 supersampling when
  shrinking). Whole-px moves and flips are exact.

**Kept original** (`keptOriginal.ts`): after a commit that leaves the result as
all the layer holds, the layer keeps its pre-transform pixels + cumulative
matrix in memory while its pixel revision is unchanged (any edit, lift, merge,
Clear, rasterize, Match or undo touching it drops it). Repeated transforms
resample from it once (5 x 10 degrees = one 50 degree resample). 128 MB per
editor, oldest dropped first; never saved.

**Flips** (H/V in the session strip, the Move layer strip, and selection tools'
strips while a selection exists; `layerFlip.ts`): in a session, part of it. With
a selection or float outside a session: lift and mirror, stays floating. With
neither: mirror the whole layer about its content centre, exact, one step, lmask
mirrored too. Text: rasterize confirm. Empty layer: a note.

**Text layers**: rotation -> `textData.rotation`, uniform scale -> `size`, move
-> anchor; stays editable; one text step. A non-uniform scale, a flip, or an
unlinked W/H edit asks to rasterize after the gesture (Yes = continue as a pixel
session; No = drop the change).

Files: `engine/transformOps.ts`, `transformSession.ts`, `transformResample.ts`,
`textTransform.ts`, `tools/transformTool.ts`, `ui/transformOverlay.ts`.

## 19. Moving (Move layer, Align drawing)

**Move layer (V)**

- Moves the edit layer (active paint/text layer, or the current cmask under
  Quick Mask) by whole doc px; one undo entry per drag; the selection moves
  with it. Preview only offsets the drawing; pixels move once, on commit
  (`engine/layerMovers.ts`: paint/cmask translate pixels and carry the lmask;
  text shifts its `textData` anchor and never rasterizes).
- With a selection: section 16.
- **Auto-select** (option, default off; or Ctrl at pointer-down): picks the
  topmost visible, unlocked paint/text layer with alpha > 10 under the pointer
  and makes it active (no undo step). Under Quick Mask it picks only visible,
  unlocked cmasks by raw coverage and makes the hit current (Quick Mask stays
  on). Nothing hit = nothing moves. Off while a selection exists.
- Ctrl as temporary Move: section 12.
- Arrows nudge 1 image px (>= 1 doc px), Shift 10; consecutive nudges merge
  into one step; swallowed mid-drag. Esc / pointer-cancel aborts a drag.
- Refusals: edit gate notes, unmovable layer, empty selection; loading or an
  active stroke: silent.
- Strip: Auto-select, Transform, Flip H, Flip V (always shown).

**Align drawing** (hidden tool; bottom bar Align button, no shortcut; toggling
again returns to the last rail tool)

- Edits `doc.placement`: the whole drawing (all layers, cmasks, lmasks) relative
  to the image, to realign paint to a similar but offset image.
- Drag moves in whole image px. **Wheel while dragging** scales around the
  cursor (x1.05 per notch, trackpads proportional); the wheel without a drag
  still zooms the view. Arrows nudge 1 / 10 image px. Esc during a drag restores
  the start placement.
- Strip: X, Y (image px, +-16384), Scale (5..1000 %), Reset position, Done.
- Clamped so the paint area covers the image area plus 50 image px per side
  (Reset and cancel aren't clamped).
- **Not undoable**: never in the paint history (Ctrl+Z always undoes paint, also
  while this tool is active). Paint patches are in doc coords, so they stay valid
  under any placement. Clear resets placement inside its own undoable snapshot.
- Ctrl never substitutes Move layer here.

Files: `tools/moveLayer.ts`, `tools/move.ts`, `engine/moveOps.ts`,
`layerPick.ts`, `placementOps.ts`, `placementClamp.ts`.

## 20. Image sources and the Images panel

- Optional `layer_source` input (3rd). Session history (`SourceHistory`): the
  last **10** distinct images, newest first (a repeat moves to the top), per node
  instance, never saved. Sources: the upstream preview (same lookup as the
  background; works before any run), then our executed `layer_source` preview
  (no provenance check). Deduped by the `/view` query for upstream previews and
  by Python's `source_id` for executed ones. Named after the upstream file stem
  for LoadImage-style / `type=input` previews.
- **Images button** first in the top-right pill, with a count badge; hidden
  while the history is empty (no `layer_source` -> never shown).
- **Tray** (`ui/imagesPanel.ts`; in the popover layer, follows fullscreen):
  thumbnails newest first. A click inserts and the tray **stays open**. It closes
  on Esc (right after the help overlay, before other Esc handlers), a press on
  the stage or a dock tool button, or the button again. A new source auto-opens
  it and marks its thumbnail until the tray closes, except the first one seen
  after load (a seed) or a repeat; re-linking the input re-arms. The list follows
  the history live; the tray closes if it empties.
- **Insert** (`engine/sourceInsert.ts`): decode (over 8192 px per side is
  downscaled once, with a note); add an empty paint layer named after the file
  stem or "Image N" above the active paint layer (Quick Mask off, selection
  dropped in the same step, takes over solo); start a Free Transform session at
  scale 1 or fitted to the image area, placed by the paste rule (section 17).
  Commit resamples once from the full source, one undo step; cancel (Esc, x,
  Ctrl+Z) removes the layer, no step. A live session or float is settled first.
  Failure: a note. With **Insert into current layer** (or Simple mode) no layer
  is added: the session runs on a float on the current layer (section 17).

Files: `widget/sourceHistory.ts`, `layerSourceWatch.ts`, `nodes/previews.py`.

## 21. Outputs and regions (editor)

**Region mode = the Outputs tab.** The hidden `region` tool (no options, no
Ctrl/Alt substitutes, crosshair) is active exactly while the Outputs tab shows.

- Enter: open the tab or **O** (a shrunk panel expands).
- Leave: Layers tab, O again, the strip's **Done** (section 7), the edit chip's
  "Back to {layer}", or choosing any other tool. Leaving by tab, O, Done or chip
  restores the last rail tool. Shrinking the panel and Esc do not leave.
- While in it: the edit chip shows the output ("Main" / region name · Outputs);
  the Quick Mask button and lmask options are hidden; Q does nothing.
- Delete / Backspace removes the selected region (one undo step; nothing with
  Main selected).
- The image selection is hidden (no marching ants) and out of reach: Delete,
  Ctrl+C/X/A/D and Alt/Ctrl+Backspace never touch it (swallowed).

**Pointer** (current-image px):

- Press (no Shift): the selected region's handle -> resize; its body -> move;
  the topmost visible region -> select + move. Shift always draws a new region.
- Under 3 px of movement is a click; only a real drag opens a transaction.
- Draw creates a region in the lowest empty slot (selected, live rect, any
  direction). With all 6 slots used: stage note "All 6 region slots are used.
  Delete a region to draw another."
- Click on empty canvas (or Shift+click) selects Main; on a region selects it.
- Resize keeps the opposite edge (no flip, min 1 px); move keeps the size and
  stops at the region area. Esc mid-drag reverts.

**Geometry**: integer image px from the top-left, never rescaled; the region area
is one image size beyond each edge (`x` in `[-W, 2W]`, `y` in `[-H, 2H]`); edges
`floor(v + 0.5)`; min 1x1. Clicking an empty slot creates a centred half-size
region.

**Outputs tab** (`outputsPanel.ts`), top to bottom:

1. **Main card**: "Main" + read-only `W x H`, options row. Selected when no
   region is; clicking it selects Main.
2. **Slot grid**: six fixed slots `1..6` (filled / selected / empty styles). A
   filled slot selects its region; an empty slot creates the centred half-size
   region in that slot. Slot N always feeds helper output pair N.
3. **Region card**, only while a region is selected: eye (overlay only; outputs
   are always produced), title `N · name` (double-click renames: Enter / blur
   commit, Esc cancels), trash (empties the slot; no renumbering). X / Y / W / H
   fields (typed live, rounded, clamped; label scrub 2 px per step, Shift x10;
   one session = one undo step; Enter commits, Esc reverts). Then the options row.
4. Hint: "Drag on the image to add a region; Shift-drag starts a new one inside
   another."

Cards update in place (a field being edited is never rebuilt); the region card
is swapped only when the selected id changes (its open field sessions commit).

**Output options row** (`outputOptionsRow.ts`): segmented `None | Fill | Crop |
Border` plus an **Alpha** pill. Under Fill, Alpha is greyed and inert ("Not
available with Fill"), its value kept. Extras line only when needed:

| Mode | Extras | Defaults |
|---|---|---|
| None | - | - |
| Fill | "Color" + swatch | `#000000` |
| Crop | "Padding" + `− N px +` stepper (±8, min 0) | 0 |
| Border | width stepper (±1 up to 8, then ±4; 1..4096; "Border width"), colour swatch, "Mask border" pill | 64, `#ffffff`, on |

Stepper values are typeable; each click is one undo step. Swatches open the
colour picker (one session = one step). Options apply only at execution (nothing
changes on the stage).

**Overlay** (`regionOverlay.ts`): in region mode, solid boxes with a dark halo
and a number badge; the selected region is brighter with 8 handles; the image
border is outlined while Main is selected. Outside region mode: subdued dashed
outlines with a small number. Only visible regions are drawn or hit.

**Undo**: add, remove, rect, rename, eye and option edits are `outputs` entries
(metadata only). Selecting is not an edit (no upload, no redo loss). Why: every
card click would otherwise upload and clear redo.

**Regions helper labels** (`widget/regionsNode.ts`, `regionLabels.ts`), from the
source node's document:

| Slot state | Labels |
|---|---|
| Filled | `<name>` / `<name> mask` |
| Empty | `Region N (missing)` / `Region N mask (missing)` |
| Source unresolvable | `Region N` / `Region N mask` |

Updated on graph configure, helper add, connection changes and our document
changes (no polling). Outputs are re-spliced so Nodes 2.0 sees label changes.

Files: `ui/outputsPanel.ts`, `outputCard.ts`, `outputOptionsRow.ts`,
`outputField.ts`, `regionOverlay.ts`, `regionMode.ts`, `hostSync.ts`,
`engine/regionOps.ts`, `regionGeometry.ts`, `regionHistory.ts`, `tools/region.ts`,
`document/regions.ts`, `outputOptions.ts`, `widget/regionsNode.ts`,
`regionLabels.ts`.

## 22. Settings

Declared in `ui/src/settings.ts`, read via `readSetting` (guarded; a missing API
or a throw -> code default, logged once). Colour settings are stored without
`#`. Defaults apply to new documents / new sessions only, never to live state.

| Id | Label | Type | Default | Effect |
|---|---|---|---|---|
| `PainterSketch.PaintQuality` | Paint layer quality | slider 50..100 | 99 | < 100: paint/text as lossy WebP at that quality; 100: PNG. cmasks/lmasks always PNG. Read per upload batch. |
| `PainterSketch.Cleanup` | Clean up files | custom button | - | Stats line + cleanup (section 5). |
| `PainterSketch.DefaultMode` | Default editor mode | combo | `simple` | Mode of nodes created afterwards (`simple` / `advanced`); each node then keeps its own (section 7). First in the panel (`sortOrder` 100). |
| `PainterSketch.DefaultMaskColor` | Mask colour | color | `ff0000` | First cmask of a new document (and a lazily added one). |
| `PainterSketch.DefaultMaskOpacity` | Mask overlay opacity (%) | slider 10..100 | 50 | Overlay opacity of new cmasks. |
| `PainterSketch.PressureSize` | Pen pressure controls size | boolean | on | Initial brush/eraser toggle. |
| `PainterSketch.PressureOpacity` | Pen pressure controls opacity | boolean | off | Same. |
| `PainterSketch.PressureMinSize` | Pressure min size (%) | slider 0..100 | 10 | Same. |
| `PainterSketch.PressureGamma` | Pressure curve (gamma) | slider 0.2..5 | 1 | Same. |
| `PainterSketch.BucketSample` | Paint bucket samples | combo | `background` | Initial bucket Sample. |
| `PainterSketch.WandSample` | Magic wand samples | combo | `background` | Initial wand Sample. |

Combo values: "Background (input image only)" = `background`, "Current layer" =
`layer`, "All layers (what you see)" = `all`.

localStorage (not settings): `PainterSketch.recentColors` (10),
`PainterSketch.recentFonts` (5).

Files: `settings.ts`, `defaults/`, `widget/comfyApi.ts`, `widget/paintQuality.ts`,
`cleanup/cleanupSetting.ts`.

## 23. Messages

**Rules** (`widget/toast.ts`, `toastLimiter.ts`, `failures.ts`)

- Toasts go through `notify(severity, text, {key, windowMs})`: title always
  "PainterSketch" (never repeat the name in the text); life 10 s for errors, 6 s
  otherwise. Each key shows at most once per window (default 10 s; 60 s for
  `upload-failed` / `upload-recovered`); a suppressed occurrence doesn't extend the
  window; the limiter remembers the last 64 keys. Keys: `upload-failed`,
  `upload-recovered` (shared by all documents; one failure toast per streak per
  document), `skipped-layers`, `invalid-document:{reason}`,
  `drag-image-blocked`, `resolution-mismatch:{docId}`, `resolution-fit:{docId}`,
  `restore:{docId}:{message}`; everything else keys on severity + text. The
  console logs every warn/error occurrence with details.
- "--" in the tables below is written as an em dash (U+2014) in the fullscreen
  placeholder, the Image/Input Mask note and the resolution texts; the clipboard
  notes use a literal "--".
- Severity: error = the user's work is at risk; warn = degraded, nothing lost;
  info = rare confirmations (recovery, cleanup).
- Console only: background image load failures, draft-capture failures, Image
  Mask read failures, Python warnings, clipboard write failures.
- **Stage notes** (`events.emit("note")`): one at a time at the bottom of the
  stage, 5 s, no limiter. Used for refusals and tool feedback.

### Toasts

| Text | Sev. | Trigger |
|---|---|---|
| Could not save paint layers: {reason}. Your paint is kept in the editor and retried automatically; don't reload the page until it is saved. | error | Upload batch failed. Reasons: "the ComfyUI server is unreachable", "the server rejected the file as too large (HTTP 413)", "the server rejected the upload ({text})", "the server reported an error (HTTP {n}); check the ComfyUI console (disk full?)", "the browser could not encode layer "{name}" (out of memory? try a smaller canvas)". |
| Paint layers saved again. | info | First success after a toasted failure. |
| Could not read the saved painting ({reason}); showing an empty canvas. [It was probably saved by a newer PainterSketch; update the node.] The saved data is kept in the workflow unless you paint on this node. | warn | Unreadable / unknown-version value. |
| The saved painting has 1 layer entry / N layer entries that could not be read; loaded the rest (details in the console). | warn | Skipped layer entries. |
| {N layer(s)} could not be loaded (the ComfyUI server is unreachable / server error, see the console): {names}. Reload the workflow to retry before painting on them. / ... lost its/their file (deleted from input/painter-sketch?): ...; loaded empty. / ... could not be decoded (corrupt file?): ...; loaded empty. / Their saved file references are kept until you edit those layers. / ... was/were saved at an older canvas size (latest edits probably never uploaded): ...; check their position. | error if transient, else warn | Restore problems, one combined message per document. |
| Loaded the painting as saved in this workflow; newer unsaved strokes from the previous copy of this node were discarded. | warn | A manifest replaced a dirty live session. |
| Could not save the workflow: {message} | error | `Comfy.SaveWorkflow` threw after Ctrl+S. |
| Couldn't load the dragged image (the site doesn't allow it). Save it and drop the file instead. | warn | CORS-blocked web image drop. |
| The image is {N.N}x the drawing's resolution -- use Match image resolution for full detail. | warn | Resolution mismatch, once per document per session. |
| The image's shape doesn't fit the drawing -- parts can't be painted. Use Match image resolution to fix it. | warn | Fit problem, once per document per session. |
| Nothing to clean up (no files older than 24 h) / Nothing to clean up (the {N file(s)} older than 24 h are all in use) / Deleted {N file(s)} ({size}). | info | Cleanup. |
| {summary} {k} problem(s), see server log. First: {error} | warn | Cleanup with server errors. |
| File cleanup failed: {reason}. | warn | Cleanup request failed. Reasons (`failures.ts`): server unreachable / HTTP status / the server's `{error}` text. |

Restore and cleanup lists show at most 3 names then "+N more"; counts are
"1 layer" / "N layers", "1 file" / "N files". An upload failure with no known
cause shows the raw error text as the reason.

### Confirms (`window.confirm`)

| Text | Trigger |
|---|---|
| Rasterize text layer? It will no longer be editable as text. | Pixel edit, merge, lift, flip or non-uniform transform on a text layer. |
| Clear all paint, layer masks, regions and output options? Text layers become empty paint layers. This can be undone. | Clear. |
| Resample all layers to the current image resolution? This clears the undo history. [+ Some paint far outside the image exceeds the 16384 px paint-area limit and will be cropped.] | Match image resolution. |
| Upload failed; save anyway without the latest paint? | Ctrl+S after a failed flush. |
| PainterSketch is still uploading paint (slow or unreachable server). Reload anyway and lose the unsaved paint? / PainterSketch could not upload some paint. Reload anyway and lose the unsaved paint? | Reload keys with pending uploads. |
| {count} of the {N} files older than 24 h ({size}) are unused and will be deleted. This affects all workflows. [+ unscanned-workflows warning] | Cleanup. |

### Stage notes

| Text | Trigger |
|---|---|
| Layer is locked. | Edit on a locked layer. |
| The layer is hidden. | Edit on an eye-off paint/text layer. |
| The mask is hidden. | Edit on an eye-off cmask; wand Current layer on one; queueing while a hidden cmask has ever held paint. |
| The layer is hidden by solo. | Edit on a layer another solo hides. |
| {Image Mask \| Input Mask} can't be edited -- duplicate it to edit. | Pixel edit or Merge Down on that row. |
| Background can't be edited -- duplicate it to edit. | Any pixel edit, move, transform, flip, Merge Down or copy/cut while the Background row is selected. |
| Nothing to duplicate. | Background Duplicate with no image area inside the maximum paint area. |
| Layer mask: use the brush, eraser or fill. | Shapes / line with an lmask targeted; creating or editing text in the lmask-only view. |
| Layer mask: black and white only, no eyedropper (X swaps). | Eyedropper with an lmask targeted. |
| The layer mask shows nothing. | Ctrl+click an lmask that shows nothing. |
| Layer mask applied. | Merge Down with an enabled upper lmask. |
| Nothing to merge down into. | Ctrl+E with no valid row below. |
| Can't merge a Subtract mask with a normal one. | Ctrl+E on two cmasks of different modes. |
| This layer can't be moved. | Move on a kind without a mover. |
| No pixels are selected. | Lift/move with a selection holding no pixels. |
| The layer is empty. | Flip / whole-layer lift of an empty layer. |
| Nothing is selected. | To mask / fill without a selection. |
| The layer has no pixels. | Ctrl+click an empty row. |
| Nothing to copy. | Copy/cut found nothing. |
| Nothing to paste. / The clipboard has no image -- nothing to paste. / Clipspace has no image -- nothing to paste. | Paste with no source (Ctrl+V / System / Clipspace). |
| No layer to paste into. | Paste into the current layer with no layer at all. |
| Paste is larger than the image -- placed in Free Transform. Scale or place it, then commit (Esc cancels). | Paste or drop larger than the image area. |
| The dropped item is not an image. | Non-image drop. |
| Could not load the image. | Images panel insert failed. |
| Image reduced to W x H px (max 8192 px per side). | Large source. |
| Font '{name}' isn't installed; editing will use a fallback. | Text edit with a missing font. |
| All 6 region slots are used. Delete a region to draw another. | Drawing a 7th region. |
| Select a mask to delete it. / Select a layer to delete it. / The last layer can't be deleted. / the cmask or Image Mask delete tooltip | A refused header Delete (section 8). |

Other fixed text: "Run the workflow to load this mask" (Input Mask hint); the
resolution notice; the fullscreen placeholder; the Outputs hint; the strip's
region hint "Drag to draw · click a box to select"; the strip's empty-selection
hints "Drag on the canvas · ⇧ add · Alt subtract" (marquees, lasso) and "Click
to select · ⇧ add · Alt subtract" (wand); the help overlay ("Shortcuts",
sections and rows from `ui/shortcutList.ts`); the menu footer "Your pick
becomes the button's default"; the cleanup
stats line "Files: {A} ({size}) · Older than 24 h: {B} ({size})" with
"Loading file counts…" before it loads and "Could not load file counts:
{reason}." on failure.

## 24. Shortcuts

All keys work only while the editor owns the keyboard (section 7). Keys typed
into a text field pass through (except Ctrl+S). Ctrl = Cmd on macOS.

### General

| Keys | Action |
|---|---|
| Ctrl+Z | Undo (cancels a float / transform / region or Move drag without undoing anything else; commits an open text edit first) |
| Ctrl+Shift+Z, Ctrl+Y | Redo (ignored while floating / transforming) |
| Ctrl+S | Commit a float, flush uploads, then save the workflow (Ctrl+Shift+S is not intercepted) |
| Esc | Help overlay > Images tray / menu / fly-out / popover > commit an open text edit > cancel a float / transform > cancel a tool drag or pending interaction > deselect (not in region mode) > exit fullscreen. Never ends Solo, the lmask-only view or region mode |
| ? | Toggle the help overlay (also the bottom bar's Help button) |
| Q | Toggle Quick Mask (does nothing in region mode) |
| F | Toggle fullscreen |
| O | Toggle the Outputs tab (region mode; a shrunk panel expands; also in Simple mode) |
| Tab | Toggle Simple / Advanced mode (section 7; Shift / Ctrl / Alt+Tab are not bound) |
| Delete / Backspace (Shift optional) | Clear the selection on the target; without a selection, or on key repeat, swallowed (never deletes graph nodes). Ctrl+Delete / Alt+Delete are not bound. In region mode it removes the selected region instead |
| F5 / Ctrl+R / Cmd+R / Ctrl+Shift+R | Page-wide, only while uploads are pending: flush (3 s), confirm if that failed, then reload |

### View

| Keys | Action |
|---|---|
| Wheel (any modifier) | Zoom about the cursor (Align drawing drag: scale) |
| Middle-drag, Space+drag | Pan |
| Ctrl+0 / Fit button | Fit (sticky) |
| Ctrl+1 | 100 % |
| Ctrl+= / Ctrl++ | Zoom in x1.25 |
| Ctrl+- / Ctrl+_ | Zoom out x0.8 |

### Tools

| Keys | Action |
|---|---|
| B E G I T V L W | Brush, Eraser, Bucket, Eyedropper, Text, Move layer, Lasso, Wand |
| U / Shift+U | Shape group / cycle Line, Arrow, Rectangle, Ellipse |
| M / Shift+M | Marquee group / cycle Rectangular, Elliptical |
| Ctrl (hold, at press) | Temporary Move layer with auto-select (rail tools except Text, Move layer; auto-select is off while a selection exists and picks cmasks under Quick Mask; ignored during a transform session) |
| Alt (hold, at press) | Temporary eyedropper (Brush, Bucket, Line, Arrow, Rectangle, Ellipse; not the Eraser; also outside a transform session's box) |
| Long-press (380 ms) / right-click / corner caret on a dock group slot (Select, Shapes) | Tool fly-out |
| Hover / long-press the swatches | Reveal the Eyedropper button |

### Brush and options

| Keys | Action |
|---|---|
| `[` / `]` | Size down / up (Brush, Eraser, Text); Width for Line, Arrow, Rectangle, Ellipse |
| Shift+`[` / Shift+`]` | Hardness -/+ 25 % (Brush, Eraser) |
| 1..9, 0 | Opacity 10..90 %, 100 % (tools with Opacity; `[` `]` and digits still reach the rail tool during a transform session) |
| Shift+click | Straight line from the last stroke end (Brush, Eraser) |
| Shift (drag) | Line/Arrow: 15 degree steps; Rectangle/Ellipse: square/circle |
| Alt (drag) | Rectangle/Ellipse: from centre |
| Drag a number label | Scrub (Shift x10) |

### Colour

| Keys | Action |
|---|---|
| X | Swap FG/BG (lmask targeted: swap mask swatches) |
| D | Default black/white (lmask targeted: white over black) |
| Alt+click (Eyedropper tool) | Pick into BG |

### Selection

| Keys | Action |
|---|---|
| Shift / Alt / Shift+Alt at press (with a selection) | Add / subtract / intersect |
| Shift / Alt during drag | Square-circle / from centre (re-press if used as a mode key) |
| Ctrl+A / Ctrl+D | Select all (image area) / deselect |
| Ctrl+Shift+I, Shift+F7 | Invert |
| Alt+Backspace / Ctrl+Backspace | Fill selection with FG / BG (cmask: white coverage either way; lmask: the FG / BG mask swatch) |
| Delete / Backspace | Clear selection (lmask: reveal) |
| Plain drag inside (selection tools) | Move the outline only (commits a float first) |
| Ctrl+drag / Ctrl+Alt+drag inside | Lift the pixels / lift a copy |
| Arrows / Shift+arrows (selection tool, selection, no float) | Nudge the outline 1 / 10 image px (one undo step per run; refused mid-drag) |
| Alt (lasso) | Straight segments; release the button with Alt held to keep adding vertices |
| Double-click / click the start / release Alt (lasso) | Close the polygon |

### Layers, cmasks and lmasks

| Keys / clicks | Action |
|---|---|
| Click a row | Select (cmask row: current cmask + Quick Mask on; paint row: Quick Mask off) |
| Ctrl+click a row (+Shift / +Alt / +Shift+Alt) | Selection from the layer (hard) / add / subtract / intersect |
| Double-click a name | Rename (Enter / blur commit, Esc cancels) |
| Drag a row | Reorder within its group |
| Ctrl+E | Merge Down |
| Click / Alt+click the add-lmask icon | Add lmask: reveal all (or the selection) / hide all |
| Click the lmask thumbnail | Target the lmask |
| Shift+click the lmask thumbnail | Enable / disable |
| Alt+click the lmask thumbnail | lmask-only view (Alt+click again ends it) |
| Ctrl+click the lmask thumbnail (+Shift / +Alt) | Soft selection of the shown part (Ctrl wins over Shift's enable toggle) |
| Click the layer thumbnail (with an lmask) | Target the pixels |

### Move and Transform

| Keys | Action |
|---|---|
| Arrows / Shift+arrows | Nudge 1 / 10 image px (any float, transform session, Move layer, Align drawing; the selection outline with a selection tool). Swallowed while engaged even when nothing nudges |
| Alt+drag inside a selection (Move layer) | Lift a copy (Alt outside a selection and Shift axis-lock are not bound) |
| Ctrl+Alt+T | Free Transform |
| Enter / Esc | Commit / cancel a float or transform |
| Shift (handle drag) | Toggle proportional |
| Alt (handle drag) | Scale about the centre |
| Shift (rotate) | 15 degree steps |
| Wheel while dragging (Align drawing) | Scale the drawing |

### Clipboard

| Keys | Action |
|---|---|
| Ctrl+C / Ctrl+Shift+C | Copy / copy merged |
| Ctrl+X | Cut |
| Ctrl+V | Paste as a new layer (into the lmask in lmask-only view; into the current layer with the Paste menu toggle or in Simple mode) |
| Ctrl+Shift+V | Paste our copy in place |
| Long-press / right-click / caret on Copy | Choose Copy / Copy merged (sticks as the button's mode) |
| Long-press / right-click / caret on Paste | Choose System clipboard / Clipspace (sticks as the button's mode) |

### Text (while editing)

| Keys | Action |
|---|---|
| Enter | New line |
| Esc, Ctrl+Enter, click away | Commit |
| Ctrl+Z (in the field) | Native text undo |
| Click an existing text (Text tool) | Edit it |
| Ctrl+drag (Text tool) | Move the text layer |

### Regions (Outputs tab)

| Keys | Action |
|---|---|
| Drag empty canvas / Shift+drag | New region / new region even inside another |
| Drag a region / a handle | Move / resize |
| Click empty canvas | Select Main |
| Delete / Backspace | Remove the selected region |
| Double-click a card title | Rename (Enter / blur commit, Esc cancels) |
| X / Y / W / H fields | Enter commits, Esc reverts; label scrub 2 px per step, Shift x10 |

### Fullscreen pass-through

In fullscreen every key the editor doesn't handle is swallowed except: bare
modifiers; F1..F24; Alt+Left/Right (Shift optional); Ctrl+R/W/T/N/L/Tab/PageUp/PageDown (Shift
optional); Ctrl+Shift+J (devtools); Ctrl+S and Ctrl+Enter (Shift optional);
Ctrl+Alt+Enter without Shift (ComfyUI interrupt); Ctrl+V (Shift optional).
While the editor owns the keyboard it handles Ctrl+Shift+I, Ctrl+Shift+C,
Ctrl+D, Ctrl+0/1/=/-, Ctrl+A/E/X/Z/Y itself (intended), so those browser
shortcuts don't fire. Ctrl+wheel over the editor chrome is prevented (no
browser zoom).

Right-click on the stage opens the browser's context menu (left alone until we
have our own).

**Free keys** (useful for new bindings): letters
A C H J K N P R S Y Z; F1, Tab, Home/End, PageUp/PageDown, Caps
Lock; Shift+letters other than M and U; Shift+digits (except a layout's `?`).
`?` is taken by the help overlay (bound on `event.key` before the
Shift+group-cycle lookup in `shortcuts.ts`). ComfyUI's keybinding
service ignores plain and Shift-only keys while an `<input>` (our focus sink)
has focus (`keyCombo.ts isReservedByTextInput`), and also its reserved set
(Ctrl+A/C/V/X/Z/Y/P, Enter, Home/End, PageUp/PageDown, arrows,
Ctrl+Backspace/Delete); other Ctrl / Alt chords still reach ComfyUI (Ctrl+B/G/M/O
and Alt+C/M are graph commands; Ctrl+L/N/R/T/W/H are browser keys). F1, if
ever bound, must be handled by the editor's own handler, which runs before the
fullscreen pass-through (outside fullscreen the browser's F1 help opens
otherwise).

### Cursors

- Every stage cursor is an SVG data URL from the composer (`ui/cursorArt.ts`;
  drawings in `ui/cursors.ts`, move kinds in `ui/moveCursors.ts`), so the OS
  cursor set never shows over the stage (native keywords are only the fallback).
- Badges: the mode badge sits bottom-right (selection add / subtract /
  intersect; eyedropper background slot); `ban` replaces it. The edit target is
  not shown on the cursor (the edit chip shows it).
- Colours are theme tokens on `.cps-root` (`editor.css`); the stage reads them on
  render and rebuilds cursors on a change. Pan / busy cursors (written by the
  stage) win over the tool cursor.
- Mid-drag the cursor kind and badges stay as at pointer-down.

| Tool / state | Cursor | Hotspot |
|---|---|---|
| Brush, Eraser | Nothing in the centre while the ring is small on screen, a dot once it is large; the overlay draws the ring plus, outside it bottom-right, the eraser glyph or `ban`; badges grow with the ring (`ui/ringCursor.ts`). A tiny ring: precise cross | centre |
| Bucket, Lasso, Polygonal lasso (while a polygon path runs) | pointer tip + tool glyph lower-right | (3, 3) |
| Move layer, Ctrl temporary Move, Align drawing, transform inside the box, Text Ctrl+drag | pointer tip + move glyph; inside a selection: + cut, Alt + copy; + `ban` while the layer move would be refused (`layerMove.blocked()`; not when the press picks the layer: Ctrl / Auto-select without a selection) | (3, 3) |
| Outline drag; Ctrl over a layer row | pointer tip + dashed square (rows: with the mode mark) | (3, 3) |
| Eyedropper (and Alt temporary) | pipette; the eyedropper itself with Alt: + background-slot badge; loupe while picking | tip (22, 42) |
| Magic wand | wand | star point (41, 23) |
| Shapes, marquees, region tool, transform outside the box | precise cross (Alt outside the box: eyedropper) | centre |
| Region tool | over a region body: pointer tip + move; on the selected region's handles: resize cursors; elsewhere or with Shift: precise cross, + `ban` when all 6 slots are used | centre (move: the tip) |
| Text | text cursor (+ `ban` in the lmask-only view, `ToolCursor.ban`); while Ctrl is held (and during the Ctrl+drag): pointer tip + move (`Tool.ctrlCursor`) | centre |
| Transform handles / rotate zone | directional resize arrows by on-screen direction / rotate | centre |
| Pan ready / panning / loading | open hand / grabbing hand / hourglass | centre |
| Pixel tools (brush, eraser, bucket, shapes) on a cmask / lmask | + mask badge; `ban` while the edit gate (`editBlockNote`) would refuse (the reason still shows as a note on click) | -- |

**lmask slot indicators** (hover; `layerSelectHover.ts` writes `data-mod`):
thumbnail + Alt = lmask-only-view glyph, + Shift = red `x`; add-mask icon + Alt =
the inverted mask glyph. Ctrl shows the row's load-selection cursor instead.

## 25. Remaining work

**M7b -- release polish.** Steps 1-4 (spec rewrite, Lucide icons and cursors,
UI refresh, Simple mode) are done; the record of what was decided and tuned is
in `docs/archive/SPEC-log-2026-10.md`.

5. [ ] **README** (with the user's screenshots; no install section): pitch, quick
   start, feature overview, I/O, condensed shortcuts, storage and cleanup,
   limitations, licence. Example workflow(s) = the node with its inputs attached.
6. [ ] **Manual checklist** (AGENTS.md "Testing") with Nodes 2.0 off and on, then
   release.

**Parked ideas**

- Line / arrow shapes: start the Free Transform box rotated to the line.
- While soloed, a hidden layer could be editable (you can see it).
- Inverted selections bounded to the image area (today only the ants are).
- Curve smoothing of pointer samples.
- Measure flow < 100 % and pressure -> opacity against Photoshop.
- In-editor confirm dialogs for every confirm (Clear, Rasterize, Match
  resolution, ...) instead of `window.confirm`; they would join the Esc chain
  between menus and text commit.

