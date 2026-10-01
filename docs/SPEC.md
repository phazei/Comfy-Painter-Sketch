# PainterSketch specification

How every part of PainterSketch works **now**. Mostly for agents (and the
maintainer) who need to understand a piece of the codebase before changing it.

- [`AGENTS.md`](../AGENTS.md) (repo root) holds the rules: code style, repo
  practices, how agents work, and an index of where things live. This file holds
  behaviour. The two should overlap little.
- History (decision logs, milestone notes, rejected approaches) is archived in
  [`docs/archive/SPEC-log-2026-09.md`](archive/SPEC-log-2026-09.md). Look there
  for *why* something changed; this file only keeps a one-line **Why:** where it
  stops a known mistake from coming back.
- Keep this file current: when behaviour changes, change the section that
  describes it. Remaining work is tracked in the last section.

**Terms**

- **cmask**: a standalone ComfyUI-style mask row (Mask N, plus the fixed
  Image/Input Mask row). cmasks feed the `MASK` outputs.
- **lmask**: a paint layer's layer mask. It hides part of that layer and never
  reaches `MASK`.
- Never write just "mask". Both use the ComfyUI polarity: white = masked / hidden.
- **Output**: Main or a region (it has a result and output options).
  **Region**: the rectangle itself. Main is an output, not a region.
- **View**: pan/zoom of the stage. **Move drawing**: whole-drawing placement.
  **Move layer**: the `V` tool.
- **Frame**: the grid the paint was made on. **Bounds** (paint area): the
  document's pixel extent. **Image**: the current input image (or the
  width x height fill when none is connected).

## Contents

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
19. Moving (Move layer, Move drawing)
20. Image sources and the Images panel
21. Outputs and regions (editor)
22. Settings
23. Messages
24. Shortcuts
25. Remaining work

---

## 1. Overview and scope

A ComfyUI node that takes an `IMAGE`, lets you paint and draw cmasks **inside
the node**, and outputs `IMAGE`, `MASK` and up to six output regions. A
fullscreen button moves the same editor into an overlay; it is one editor, not a
second app. LiteGraph is the primary renderer; Nodes 2.0 must work too. Where
image editors (Photoshop first) have an established behaviour or shortcut, we
follow it.

Core design choices:

- **The input image is a live, locked background, never saved.** Only paint
  layers, cmasks and lmasks are saved; Python composites them over whatever
  arrives at run time, so you can re-roll the upstream and keep your paint.
- **Frame vs paint area.** Layers may hold paint outside the image; outputs are
  always aligned to the image (except regions and Crop/Border options).
- **Upstream size change = scale to fit, non-destructive.** Pixels stay in
  document (frame) coordinates and are never resampled on a size change; editor
  and Python map document -> image with the same transform.
  Why: resampling on each size change shrank and blurred paint on A->B->A flips.
- **cmasks are layers** (`kind: "mask"`), N of them, combined by union.
- **Selection is a pixel coverage mask**, not a path.
- **Persistence = PNG/WebP uploads to `input/painter-sketch/`**, the widget holds
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
`nodes/__init__.py` lists `ALL_NODES = [PainterSketch, PainterSketchRegions]`.
Both are V3 (`io.ComfyNode`), category `image`.
Why: `NODE_CLASS_MAPPINGS` must not exist (even `{}`); the loader would take the
V1 path and never call `comfy_entrypoint`.

### PainterSketch

`node_id="PainterSketch"`, `has_intermediate_output=True`. Input order is
contract-stable (the frontend widget depends on the names).

| # | Name | Type | Default / limits | Notes |
|---|---|---|---|---|
| 1 | `image` | IMAGE, optional | - | Batch in, batch out. A 4th channel is dropped. |
| 2 | `mask` | MASK, optional | - | Gives the Input Mask row. Used only while `image` is also connected. |
| 3 | `layer_source` | IMAGE, optional | - | Feeds the Images panel. Never affects outputs. |
| 4 | `document` | STRING, `socketless`, `widgetType: "PAINTERSKETCH"` | `""` | The manifest. Replaced by our DOM widget. |
| 5 | `width` | INT | 1024, 64..16384, step 8 | Only used when `image` is not linked. |
| 6 | `height` | INT | same | Same. |
| 7 | `background` | COLOR | `#ffffff` | Fill with no image; replaces the image when the Background eye is off; fills regions outside the image. Alpha ignored; unparseable = white + log warning. |
| 8 | `invert_mask` | BOOLEAN | false | Inverts the cmask union (see Python execution). |

- `width`/`height` are hidden while `image` is linked and rewritten to every
  loaded image size (rounded to step 8, clamped). Disconnecting keeps the frame.
  When they reappear and the node is too short, the node grows.

Outputs:

| Name | Type | Shape |
|---|---|---|
| `IMAGE` | IMAGE | `[B,h,w,3]`, or 4 channels with Main's Alpha option |
| `MASK` | MASK | `[B,h,w]` |
| `regions` | `PS_REGIONS` (custom) | 6 slots, each `RegionOutput(image, mask)` or `None` |

h, w = the image size (or width/height), unless Main's Modify is Crop or Border.

**UI result** (`nodes/previews.py`):

- `images`: the first input frame, not the composite (the editor draws the paint
  itself). With no image, the plain `background` colour.
- `layer_source`: first frame of that input + `source_id` (16-hex content id).
- `input_mask`: the prepared coverage of image 0 as a grayscale PNG + `mask_id`;
  `[{"mask_id": "none", "empty": true}]` for LoadImage's "no mask" placeholder.

**Caching** (`fingerprint_inputs`, SHA-256): the `document` string,
`invert_mask`, an `IMAGE` marker if `image` is linked (else `width`,`height`),
`background`, a `MASK` marker if linked, and `(name, size, mtime)` (or a MISSING
marker) for every layer file, lmask file and the Image Mask file (the last only
when `mask` is not linked); unsafe names (outside `painter-sketch/`, or with `..`)
hash as MISSING without touching the disk. Tensors are left to ComfyUI's own caching. No
`validate_inputs`; bad input degrades gracefully.

Known limitation: when a run reveals a new image size, the width/height widgets
change, so the next queue re-runs once (widget values are in the cache key).

### PainterSketch Regions

`node_id="PainterSketchRegions"`, display "PainterSketch Regions". One input
`regions` (`PS_REGIONS`), 12 fixed outputs `IMAGE 1`, `MASK 1` ... `IMAGE 6`,
`MASK 6`. An empty slot returns `ExecutionBlocker(None)` for both outputs
(downstream branches silently don't run); a wrong input type blocks all 12.
Labels are set by the frontend (section 21); sockets never appear or disappear.

- Why: import `ExecutionBlocker` from `comfy_execution.graph_utils`;
  `comfy_execution.graph` imports ComfyUI's `nodes`, which clashes with our
  `nodes/` package.
- Why: `io.NodeOutput(block_execution=...)` treats `None` as "no block", so the
  blocker must be the per-output value.

**Batches.** The same paint and cmasks apply to every image (broadcast, no
loop). The editor previews image 0. The Input Mask can be per image.

Files: `__init__.py`, `nodes/__init__.py`, `nodes/painter_sketch.py`,
`nodes/painter_sketch_regions.py`, `nodes/previews.py`,
`ui/src/widget/constants.ts`, `sizeWidgets.ts`, `regionsNode.ts`.

## 3. Python execution

`execute`, in order:

1. **Base.** With an image, `base_rgb = image[..., :3]`; otherwise a
   `[1,height,width,3]` fill of `background`.
2. **Input Mask.** Used when both `image` and `mask` are connected:
   `prepare_input_mask` (rules below).
3. **Parse** the manifest. If it is empty or invalid (bad JSON, not an object,
   version != 1, bad frame): IMAGE = `base_rgb` (no options), MASK = zeros (ones
   with `invert_mask`), or the Input Mask alone when connected (inverted with
   `invert_mask`); regions empty.
4. **Layers.** Every layer file loads as `[bounds.h, bounds.w, 4]` straight-alpha
   float, or nothing. Text layers load as raster like paint. Enabled lmasks are
   applied first: the layer's alpha is multiplied by `1 - plane` (`plane` if
   inverted); beyond the stored pixels the plane is the `outside` value
   (`reveal` = 0, `hide` = 1); `file: null` = an all-zero plane (all shown, or
   all hidden when `invert` is set); an unreadable lmask file is ignored (layer
   shows unmasked).
5. **Image/Input Mask row.** With the Input Mask in use, the row's manifest
   settings apply (defaults: visible, not inverted) and its pixels are the
   prepared coverage. Otherwise, with an image and a visible `imageMask` record,
   its file is used only if exactly the image size (a stale size is skipped with
   an info log). Never used without an image.
6. **Composite.**
   - Background eye on: for each visible paint/text layer bottom to top,
     `out = rgb*a + out*(1-a)`, `a = placed_alpha * opacity`. `blendMode` is not
     read (always Normal).
   - Background eye off (`backgroundVisible: false`): composite premultiplied
     over transparency into `P, A`. `IMAGE = P + bg*(1-A)` (bg = the
     `background` colour); `straight = P/A` clamped, `bg` where `A = 0`.
7. **MASK.** For each visible cmask: place its alpha through the frame map (0
   outside), apply its own invert, union = max. A visible Image/Input Mask row
   joins the same way (placed at the image origin, its invert applied). Then
   `invert_mask` (`1 - combined`; all ones when no cmask row is visible). cmask
   `opacity`/`color` are display only. With the Background eye off:
   `MASK = max(that, 1 - A)`; transparency joins after `invert_mask` and is never
   inverted.
8. **Outputs.** `apply_output_options` for Main; regions via `build_regions` from
   the same composite. Main's options never affect regions.

**Output options** (same function for Main and regions):

1. If `straight` exists and (Alpha or Fill), the image becomes `straight`
   (no background-colour fringe on soft edges).
2. Modify: `none` passes through; `fill`: `image*(1-mask) + color*mask`, MASK
   unchanged; `crop`: bbox of `mask > 0` unioned over the batch, plus
   `cropPadding`, clamped (an empty mask = no crop); `border`: pad every side by
   `borderSize`, IMAGE gets `borderColor`, MASK gets 1 (`borderMask`) or 0.
3. Alpha (not with Fill): a 4th channel `1 - mask`.

**Regions.** Up to 6 records matched by slot 1..6 (first valid record per slot
wins). Edges clamped to `[-W, 2W]` / `[-H, 2H]`, rounded `floor(v + 0.5)`, at
least 1x1. A region inside the image is a slice of the main composite; one that
reaches outside is composited on its own canvas (`background`, then the image
where it overlaps, then paint and cmasks placed at its origin). With the
Background eye off it composites transparent.
Why: rounding is half-up on both sides so editor and Python agree.

**Frame map and placement** (`composite._layout`, mirrored by
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

**Degrading.** A layer file whose size differs from `bounds` is placed unscaled
at the top-left (warning), like the editor. Missing, unsafe or unreadable files
are a warning and an empty layer, never a failure. A layer `file` is used only
if it is `painter-sketch/<name>` with an optional exact trailing ` [input]`
(`nodes/layers.py is_safe_file_value`, mirroring `folder_paths.annotated_filepath`):
`[output]` / `[temp]`, any `..` component or any other prefix are rejected
before touching the filesystem, both when loading and in `fingerprint_inputs`.
Files must exist via `folder_paths.exists_annotated_filepath` and load via
`node_helpers.pillow(Image.open)` (format from bytes, so WebP, PNG and older
PNG-only paint files all work).

**Cleanup route** (`POST /painter-sketch/cleanup`, a no-op without a server):

- `{"mode": "stats"}` -> `{all: {count, bytes}, old: {count, bytes}}`.
- `{"dryRun": bool, "referenced": string[]}` -> `{count, bytes, all, old,
  errors?}`, plus `deleted` on a real run. 400 for bad bodies (max 100 000
  references, 4096 chars each), 500 with `{error}` otherwise.
- A file is deleted only if it sits directly in `input/painter-sketch/`, is a
  regular non-symlink file, matches `ps-<docId>-<hash>.(png|webp)` (docId any case; hash and extension lowercase), is
  older than 24 h, and its name appears in no reference. References: raw-text
  scan of every `*.json` under each user's `workflows/` and `subgraphs/` (files
  over 50 MB skipped and reported) plus the client list. A symlinked folder is
  refused. Age and type are re-checked right before delete. Runs under a lock in
  a thread.
- Why: raw-text scanning finds names even in double-encoded manifests. The
  reference regex is mirrored in `ui/src/cleanup/references.ts`; a test fails if
  the copies differ.

Files: `nodes/painter_sketch.py`, `composite.py`, `layers.py`,
`layer_masks.py`, `input_mask.py`, `output_processing.py`,
`document_regions.py`, `document.py`, `cleanup.py`, `cleanup_route.py`.

## 4. Document and saved files

**Manifest** (`PainterDocument`, `version: 1`). The widget value is the JSON
(stable key order), or `""` for an untouched document.

| Field | Type / default | Written |
|---|---|---|
| `version` | `1` | always |
| `docId` | `/^[a-z0-9]{4,64}$/i`, regenerated if invalid (12 chars) | always; Python ignores it |
| `frame` | `{width, height}`, 1..16384 | always |
| `bounds` | `{x, y, width, height}`, `abs(x), abs(y) <= 65536`, size 1..16384, contains the frame | always |
| `regions` | `Region[]` | always (may be `[]`) |
| `mainOutput?` | `OutputOptions` | when set |
| `backgroundVisible?` | `false` | only when false |
| `imageMask?` | `{file, visible, color, opacity, invert, sourceKey, width, height}` | while the row exists |
| `placement?` | `{x, y, scale}` | only when not identity |
| `activeLayerId` | string | always |
| `layers` | `Layer[]`, bottom -> top, Background excluded | always |

- `Layer`: `id`, `name`, `kind: "paint" | "text" | "mask"`, `visible`,
  `locked`, `opacity` (0..1), `blendMode: "normal"` (reserved, ignored),
  `file: string | null`; optional `color` and `invert` (cmasks), `textData`
  (text layers), `layerMask` (paint layers that have one).
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
- `textData`: see Tools > Text.
- `placement.scale` is clamped 0.05..10; non-finite x/y become 0.

**Frame and bounds**

- A new document (or an empty one adopting an image) gets `minimumFrame(image)`:
  scaled up so the short side is >= 1024, but never pushing the long side past
  4096; never shrinks.
- `bounds` starts as the frame and grows in 256 px chunks when edits reach
  outside, capped at the frame plus its short side on every side and 16384 per
  axis. Existing larger bounds are kept.
- Layer pixel `(px, py)` sits at frame coordinate `(bounds.x + px, bounds.y + py)`.
- Why: all editor conversions go through `documentMap(doc, imageSize)` /
  `editor.frameMap`. Never call `frameMap(doc.frame, ...)` directly or
  re-derive the formula.

**Versions.** Only version 1 exists; any other value is rejected (editor:
invalid; Python: no document). Additive optional fields shipped without a bump;
older manifests stay valid. Bump the version (and add a migration) for any
breaking change.

**Validation** (`document/parse.ts`; never throws):

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

Python applies the same rules: bounds that don't contain the frame, or a
present non-array `layers`, mean "no document" (plain image out); a missing
`layers` key is an empty stack. Files are sized to `bounds`, so any bounds
growth re-uploads every layer that has pixels.

**Files**

- Paint and text layers: lossy WebP at `PaintQuality/100` when the setting is
  below 100 (falls back to PNG if the browser's WebP fails a sniff), PNG at 100.
  cmasks, lmasks and the Image Mask are always PNG.
- Straight alpha RGBA, exactly `bounds` size. The Image Mask is exactly the
  image size with coverage in alpha (coverage = 255 - image alpha). A fully
  transparent canvas stores no file (`file: null`).
- Name: `painter-sketch/ps-<docId8>-<hash14>.<webp|png>`, `docId8` = the
  docId with non-alphanumerics stripped, first 8 chars, case kept (`doc` if
  empty), `hash14` = 14-hex cyrb53 of the encoded bytes. The manifest stores the
  server's answer, `"painter-sketch/<name> [input]"`. Documents saved before the
  bounds re-upload fix may hold offset files; both sides place them unscaled
  (see Python "Degrading"), nothing repairs them.
- Upload: `POST /upload/image`, `type=input`, `subfolder=painter-sketch`,
  `overwrite=true`. Skipped when the name was loaded or
  uploaded before in this session, unless that was more than 20 h ago:
  re-uploading bumps the server mtime so cleanup's 24 h rule can't delete a file
  an undo brings back. Files named by the loaded manifest count as fresh (the open
  workflow references them), so loading never re-uploads (text layers re-rendered
  to the same name included); a file that failed to load is forgotten.
- The manifest holds only file references (~250 B per layer). Never inline pixel
  data: ComfyUI fails to save workflow drafts with very large widget values.

Files: `ui/src/document/` (`types.ts`, `create.ts`, `parse.ts`, `serialize.ts`,
`outputOptions.ts`, `regions.ts`, `placement.ts`, `layerMask.ts`,
`imageMask.ts`, `content.ts`, `textData.ts`), `engine/frameMap.ts`,
`engine/bounds.ts`, `widget/layerEncode.ts`, `contentHash.ts`, `paintQuality.ts`,
`nodes/document.py`.

## 5. Persistence and sync

**Value.** The widget value is `""` until the document has content: unsaved
paint, a layer file, regions, `mainOutput`, a hidden Background, or an
`imageMask` record. An unreadable incoming value is kept and returned unchanged
until the user paints, so saving the workflow never drops it.

**Upload timing** (`widget/controller.ts`, `persistence.ts`,
`uploadScheduler.ts`):

- 5 s after the last edit (debounced idle fallback).
- When the editor disengages, on fullscreen exit, and on session detach.
- On queue: `serializeValue` waits for the session and any Image Mask read,
  settles floats, flushes uploads, shows the hidden-cmask note if needed, and
  returns the manifest. It **throws on upload failure**, so the queue stops.
- Ctrl+S in the editor: settle floats (commit, as queue does), flush, then
  `Comfy.SaveWorkflow` (confirm "save anyway?" on failure). Ctrl+Shift+S is not
  intercepted.
- F5 / Ctrl+R / Cmd+R / Ctrl+Shift+R while uploads are pending: flush (3 s
  cap), then reload; a failed or timed-out flush asks a confirm first. Tab
  hidden / window blur: fire-and-forget flush. These guards (`widget/pageGuards.ts`)
  are the one always-on window listener set (keydown capture, blur,
  visibilitychange, beforeunload); they do nothing unless a session has pending
  uploads or captures.
- Idle, blur and tab-hidden flushes never settle a float (the user is mid-work);
  they upload the pre-lift pixels.
- Why: `serializeValue` runs only when building a prompt, not on save, tab
  switch or export, so the value is kept current after every edit and uploads
  run on a debounce.

**Dirty tracking.** Per-layer version + dirty flag (cleared only if unchanged
after the upload), a separate flag for the Image Mask, and lmask uploads in the
same flush. A file reference changes only after a successful upload, so the
manifest never points at a missing file. On failure: pixels stay dirty in
memory, one error toast per failure streak (60 s window across documents),
automatic retry with backoff 15/30/60/120 s, "Paint layers saved again." on
recovery.

**Restore.** All layer and lmask files load in parallel from `/view`; painting
waits. A failed file leaves the layer empty with its reference intact (not
dirty); text layers re-render from `textData` and re-upload; a loaded size that
differs from `bounds` is flagged stale (not for text). One toast per document
summarizes all problems.

**Sessions** (module-level, keyed by `docId`): they outlive node instances, so
tab switches keep strokes and undo. Removing a node only detaches; untouched
sessions are released, others flushed and kept (max 6 detached, LRU). A manifest
re-attaches to a session only if its file signature (frame, layer ids+files,
lmasks, Image Mask file) matches the session's current or one of its last 4
states (an upload may finish between the value capture and the re-create) AND
its output metadata (regions, options) equals the session's current state.
Attach rules (`widget/attachDecision.ts`): no live session -> restore from
files; a detached or same-owner session that matches (or was handed off, below)
-> reuse; a non-matching one -> restore (warning toast if that discards dirty
pixels); a session another live node shows (copy/paste of the node) -> fork
under a new `docId`: a copy of the live editor when the manifest matches
(`fork-copy`), else a restore from files (`fork-restore`).

**Graph undo handoff** (`widget/handoff.ts`). Graph undo/redo removes and
re-creates every node with the same id in one task. `onRemoved` offers the
wrapper element, session and background; `onAdded` takes it; the offer expires
after a microtask so tab switches and deletions never match. A handed-off
session is always kept: **graph undo never rolls back paint**. No ChangeTracker
capture after a handoff (it would clear redo).
Why: Nodes 2.0 reuses the old Vue widget and never re-inserts `widget.element`;
a disposed element would leave a blank node.

**Drafts** (`widget/graphSync.ts`). ComfyUI writes drafts only on
`graphChanged`, which fires only when `captureCanvasState()` sees a change. After
our value changes on its own we request a coalesced capture on the active
workflow's change tracker (1000 ms after edits, 0 ms after an upload batch),
only for nodes in the root graph and never during graph undo/redo. Pending
captures flush on blur, tab hidden, `beforeunload` and the reload keys.
Accepted limitation: an upload that finishes while the node's workflow tab is
in the background does not update that tab's draft until you return to it.

**Input lookup** (background, Image Mask, Input Mask, layer_source):

1. The upstream node's own image: LoadImage / LoadImageOutput / LoadImageMask
   widget values, then `app.nodePreviewImages`, `app.nodeOutputs`, `node.imgs`.
2. Our own executed preview. For the background and the Image Mask only if it
   came from the same upstream node and slot (`widget/backgroundRule.ts`);
   `layer_source` falls back to our `layer_source` preview with no provenance
   check (`widget/layerSourceWatch.ts`).

Background URLs get `channel=rgb`; Image Mask alpha reads use `channel=a`. The
Input Mask row reads our `input_mask` preview (same link), or a live `channel=a`
read of a MASK output of a node showing a `/view` file (LoadImageMask only with
channel alpha); otherwise it waits ("Run the workflow to load this mask"). Its
`file` is always null. Background load failures are console-only.

**Cleanup button** (setting `PainterSketch.Cleanup`): shows file counts, then
collect client references (open workflows incl. change-tracker states,
`app.graph.serialize()`, all local/session storage values) -> dry run -> confirm
-> real run (references re-collected) -> toast -> refresh counts.

Files: `ui/src/widget/` (`persistence.ts`, `uploadScheduler.ts`,
`pageGuards.ts`, `sessions.ts`, `sessionAttach.ts`, `attachDecision.ts`,
`handoff.ts`, `graphSync.ts`, `controller.ts`, `failures.ts`, `toast.ts`,
`toastLimiter.ts`, `backgroundLoader.ts`, `backgroundRule.ts`, `imageSource.ts`,
`viewUrl.ts`, `imageMaskSync.ts`, `inputMaskSync.ts`, `inputMaskRule.ts`),
`ui/reloadGuard.ts`, `ui/src/cleanup/`.

## 6. Canvas, view and fullscreen

**View model** (`engine/view.ts`, `viewport.ts`). The view content is the
current image (not the frame): `stage = content * scale + offset`.

- **Fit** (8 px padding) is sticky: initial state, Ctrl+0 and the Fit button.
  While fitting, stage or image changes re-fit. Manual zoom/pan or Ctrl+1 leave
  fit mode; afterwards a resize keeps the centred image point.
- Zoom 0.02..64 (`scale` = stage CSS px per image px, graph zoom excluded).
  **100%** (Ctrl+1) = one image px per screen px, centred.
- Wheel on the stage zooms about the cursor by `exp(-clamp(delta, +-300) *
  0.0015)` (line mode x16, page mode x stage height); Ctrl+wheel and pinch the
  same. Ctrl+= / Ctrl+- zoom x1.25 / x0.8 about the stage centre. During a drag
  of a tool with `onWheel` (Move drawing) the tool gets the wheel.
- Pan: middle-drag, or Space + left-drag (Space typed in a text field is text,
  not pan; with Ctrl/Alt/Meta the key is not prevented but still arms pan). Pan
  is clamped so at least `min(64, on-screen size)` px of the image stays visible.
- Stuck-drag recovery (`stageInput.ts`, `eventIsolation.ts`): a buttonless
  mouse/pen move during a drag ends it as a cancel; a second press of another
  button or a new primary pointer aborts the old press; a lost middle `pointerup`
  ends the pan guard on the next non-middle press/move; stage `auxclick` is
  prevented (no middle-click autoscroll). Right-click on the stage is not
  prevented (the browser menu opens).
- Backing store = stage CSS size x devicePixelRatio x graph zoom, long side
  capped at 4096. Pointer positions go through `getBoundingClientRect()` on
  every event (never cache a scale).
- Drawing order: surround and cobweb outside the maximum paint area; checker
  under the image area; background (image / colour / transparency when its eye
  is off); layers; cmask tints; a veil over off-image paint; the image outline
  (faint, stronger when paint extends past it); the paint-area border. A
  `W x H` label sits under the image area. A plain quick click on the cobweb
  regrows it (cosmetic).
- Stage notes: one at a time at the bottom of the stage, 5 s.

**Node sizing.** `getMinHeight` 256 (graph units) plus CSS `min-height: 244px`
(Nodes 2.0 ignores `getMinHeight` for DOM widgets). New nodes start at least
512 x 640. Output preview images are suppressed (`hideOutputImages` for Nodes
2.0; a no-op `onDrawBackground` on our prototype for LiteGraph).

**Event isolation** (`widget/eventIsolation.ts`). The root stops
pointer/mouse/dblclick/contextmenu bubbling. While the pointer is over the root a
`window` capture listener stops `wheel` (always) and pointer events of a
middle-drag that started on the stage before the graph sees them;
`data-capture-wheel="true"` is set too. Wheel over the options bar scrolls it sideways; elsewhere native
scroll; Ctrl+wheel is prevented.
Why: Nodes 2.0 forwards wheel and middle-button pointer events to the graph in
the capture phase, before our element's listeners run.

**Fullscreen** (`ui/fullscreen.ts`). Enter with F or the rail button. The editor
root moves into a fixed overlay on `document.body` (z-index 1790: above ComfyUI
menus, below PrimeVue dialogs/toasts); the `.cps-widget` wrapper never moves and
shows a placeholder ("Editing in fullscreen -- press Esc or click to return").
On enter the side panel is forced open (restored on exit), the view re-fits
(on exit it re-fits only if it was fitting before entering), drags are
cancelled and popovers closed. Keys are read only from inside the overlay
(a dialog over it is ignored). Exit with Esc (last in the Esc chain),
F, the rail or overlay button, the placeholder, or automatically (250 ms poll)
when the node leaves the DOM or the viewed graph. One fullscreen editor per page.
The overlay stops pointer/wheel events and refuses drops (so a dropped file
never loads a workflow into the hidden graph).
Why: Nodes 2.0 only checks that `widget.element` is its child, so only the
inner root may move, never the wrapper.

| | In-node | Fullscreen |
|---|---|---|
| Canvas | drawn at graph zoom | no graph zoom |
| Side panel | auto-collapses below 520 px | forced open |
| Keyboard | hover / click-engage | always owned |
| Unhandled keys | pass to ComfyUI (except arrows while engaged) | swallowed except the pass-through list (section 24) |

Files: `engine/view.ts`, `viewport.ts`, `compositor.ts`, `ui/stageView.ts`,
`stageInput.ts`, `fullscreen.ts`, `fullscreenKeys.ts`, `resolutionLabel.ts`,
`webClick.ts`, `widget/eventIsolation.ts`, `constants.ts`, `painterWidget.ts`,
`nodeHooks.ts`.

## 7. Editor shell and focus

**Regions** (`ui/shell.ts`). The root `.cps-root` holds the rail (36 px), the
options bar (28 px) over the body (stage + side panel, 216 px), and the popover
host.

- **Rail**, top to bottom: tool slots (scrolling); Quick Mask; Copy, Cut,
  Paste, Images (count badge); Undo, Redo, Fit, Clear, Fullscreen; the colour
  swatches pinned at the bottom.
- **Options bar**: leading area (selection actions "To mask" / "Invert" while a
  selection exists; the Quick Mask "Mask" badge in the mask colour); the tool's
  options (scroll horizontally, never wrap); trailing area (resolution notice,
  Outputs button, side-panel toggle).
- **Side panel** tabs Layers and Outputs. The tab survives collapse and
  fullscreen. Below 520 px of editor width it auto-collapses; a user toggle wins
  until the width crosses 520 again.

**Popovers** (`ui/popover.ts`) live inside the root (they follow it into
fullscreen). One at a time, except nesting. They close on a press outside the
popover and its anchor, Esc inside, the Esc chain, the anchor leaving the DOM,
or the parent closing. Placed below / above / right of the anchor, flipped and
clamped inside the root.

**Long-press fly-outs.** Tool-group slots and the Paste button open their menu
after a 400 ms press (two separate `LONG_PRESS_MS` constants:
`toolGroupSlot.ts`, `pasteButton.ts`) or immediately on right-click. Release or
leave cancels; the click after a long-press is suppressed.

**Focus policy** (`ui/focusPolicy.ts`, `keyboard.ts`). Editor shortcuts work only
while the editor owns the keyboard: a hidden read-only `<input
class="cps-focus-sink">` or a text field inside the root has focus.

- Hover focuses the sink unless a text field elsewhere has focus; leaving hands
  focus back.
- A press inside the root **engages** it: the sink takes focus (even from
  another node's text field) and keeps it after the pointer leaves, until the
  next press or focus move outside. Text fields, `<select>` and range sliders
  keep native focus. Never `preventDefault` a pointerdown on a range input (it
  kills native dragging).
- Non-text elements never keep focus (redirected to the sink). A text field
  blurring to nothing, or a popover closing, hands focus back to the sink. A
  focused `<select>` / text field keeps it until the next press on a non-text
  control, so letter shortcuts are dead until then.
- Fullscreen always owns the keyboard; a backdrop click reclaims the sink and
  overlay buttons never keep focus.
- The rail's 2 px white left edge shows real focus, never hover guesses.
- While active, `keydown`/`keyup` capture listeners sit on `window`; handled keys
  get `preventDefault` + `stopPropagation`. Keys from text fields pass through
  untouched except Ctrl+S (in fullscreen, keys the pass-through policy would
  swallow are still stopped from reaching ComfyUI). A bare Alt press is
  prevented (keeps Windows browsers from focusing the menu bar); modifier
  state (Space/Alt/Shift/Ctrl) resets on window blur and when the scope goes
  inactive.
- **Arrow keys**: while engaged or fullscreen they are always swallowed, even
  when nothing nudges (ComfyUI would jump to another node). While only
  hover-focused they pass through to ComfyUI unless they nudge something (a
  float, a transform session, the Move layer / Move drawing tool, or the
  selection outline with a selection tool and a selection). Alt/Ctrl+arrow
  combos are left alone in-node. Keyboard graph navigation never moves the
  pointer, so it can't make the node grab arrows in passing.
- Why: ComfyUI's ChangeTracker listens on `window` capture, registers before
  extensions, and ignores keys only when focus is in an INPUT. Focusing the sink
  is what makes Ctrl+Z undo a stroke instead of a graph edit.
- The scope going inactive triggers an upload flush.

**Esc chain** (first consumer wins): Images panel -> float or transform session
(cancel) -> tool drag or pending interaction (cancel) -> open popover (close, keeping any colour change) -> fullscreen (exit).

Files: `ui/shell.ts`, `editorHost.ts`, `hostSync.ts`, `sidePanel.ts`,
`sidePanelState.ts`, `popover.ts`, `toolRail.ts`, `toolGroupSlot.ts`,
`pasteButton.ts`, `optionsBar.ts`, `focusPolicy.ts`, `keyboard.ts`,
`modifierScope.ts`, `shortcuts.ts`.

## 8. Layers

### Kinds

| Row | Record | Notes |
|---|---|---|
| Paint layer | `Layer {kind: "paint"}` | Pixels, optional lmask. |
| Text layer | `Layer {kind: "text", textData}` | Rendered from `textData`; "T" badge; no lmask; a pixel edit asks to rasterize (becomes paint). |
| cmask ("Mask N") | `Layer {kind: "mask"}` | Alpha = coverage. |
| Image Mask / Input Mask | `doc.imageMask` (fixed id, not in `layers`) | Fixed row, see below. |
| Background | none, only `doc.backgroundVisible` | Fixed row, see below. |

Properties: `name` (trimmed, max 100, empty ignored), `visible` (not undoable;
hidden cmasks are excluded from MASK), `locked` (refuses pixel edits only;
delete/rename/reorder/opacity/eye still work; not undoable), `opacity` (paint:
composite opacity; cmask: overlay opacity, display only), `color` and `invert`
(cmask; invert applies before the union), `layerMask` (paint only).

Invariants:

- `activeLayerId` is always a paint or text layer.
- cmasks sit above all paint layers (parse repairs; drag can't violate it).
- At least one paint-like layer remains (the last can't be deleted).
- 1..7 cmasks (the Image/Input Mask row doesn't count). "New mask" is disabled
  at 7 ("At most 7 masks"); the last cmask can't be deleted ("clear it
  instead"). Old documents without one get "Mask 1" lazily (Q or To mask), no
  undo step.
- A new document is "Layer 1" + "Mask 1" (mask style from the
  `DefaultMaskColor` / `DefaultMaskOpacity` settings).

Naming: paint "Layer N" = highest existing N + 1; cmask "Mask N" = lowest free
N. Duplicates "Name copy", "Name copy 2" (an existing " copy N" suffix is
stripped first). Text layers are named from their text, pastes "Pasted" /
"Pasted N", inserted images by file stem or "Image N". Why: the two numbering
rules differ on purpose; don't unify them.

Mask palette (`defaults/maskDefaults.ts`): the first cmask uses the default
style; later ones take the first colour not used by a cmask from blue
`#0000ff`, green `#00ff00`, yellow `#ffff00`, magenta `#ff00ff`, cyan
`#00ffff`, orange `#ff8000`, at the default opacity (cycling when all are used).

### Layers panel

- **Header**: "Layers" and one opacity control for the selected row ("Opacity"
  for a paint target, "Overlay" for the current cmask under Quick Mask). Each
  press starts a new undo gesture; a scrub or a slider-popover session is one
  step.
- **List**, top to bottom: cmask rows; paint/text rows; the Image/Input Mask row
  (if any); Background. A 2 px accent divider separates non-empty groups
  (dividers are not rows or drop targets); rows have 2 px separators.
- **Row**: thumbnail (36 px, checkerboard behind transparency, refreshed at most
  every 150 ms), name (wraps to 2 lines, then ellipsis), solo, eye, lock. cmask
  and Image/Input Mask rows add a second line: colour swatch (picker, one undo
  step per session), invert toggle, Overlay opacity. Paint rows have the lmask
  slot right of the thumbnail (section 9). Paint thumbnails show the image
  footprint including placement; cmask thumbnails white on black with invert
  applied.
- **States**: `selected` = the paint target (active paint layer, or the current
  cmask under Quick Mask); `standby` = fainter mark on the active paint layer
  while Quick Mask is on; the current cmask always has a 4 px left bar in its
  colour; hidden rows dimmed; with an lmask, a frame marks the targeted
  thumbnail.
- **Clicks**: a paint row selects it and turns Quick Mask off (keeping that
  layer's pixels/lmask target); a cmask or Image Mask row makes it the current
  cmask and turns Quick Mask on; Ctrl(+Shift/Alt)+click loads a selection
  (section 15); Background only ends the lmask-only view. Double-click the name
  to rename (not Background / Image Mask; Enter or blur commits, Esc cancels).
  Row buttons never select the row.
- **Reorder**: drag a paint/text/cmask row after 4 px (not with Ctrl, not from a
  control). Paint drops onto paint rows, cmask onto cmask rows; past the group
  end snaps to its edge row; the list auto-scrolls near its edges. One undo
  step; the selection is unchanged.
- **Footer**: `[Move drawing] | [New layer] [New mask] [Duplicate] [Merge Down]
  [Delete]`.
  - New layer: above the active paint layer, active, Quick Mask off.
  - New mask: above the current cmask, becomes current (Quick Mask on).
  - Duplicate: the active paint/text layer (copies visible, locked, opacity and
    the lmask with pixels; above the original, active). Disabled for cmasks; on
    the Image/Input Mask row it makes an editable cmask (below).
  - Merge Down: disabled whenever Ctrl+E would be refused.
  - Delete: the selected target (the current cmask under Quick Mask, otherwise
    the active layer; with an lmask targeted it deletes the layer -- the lmask is
    deleted only from the options bar). The layer below becomes active, else the
    nearest above; deleting the current cmask makes the top-most one current.
    Undo restores pixels and lmask.
  - Move drawing: toggles the hidden Move drawing tool (section 19); its icon
    turns red while the resolution notice shows.
- New layers, duplicates and new cmasks take over their group's solo when a solo
  is on.

### cmasks, current mask and Quick Mask

- Combine rule: each cmask's invert, then union (max), then the node's
  `invert_mask`. Colour and overlay opacity are display only; tints draw bottom
  to top above the paint, the Image Mask lowest.
- **Current mask** (session only): the last selected cmask row; falls back to the
  top-most cmask. A new mask becomes current.
- **Quick Mask** (Q, the rail button, or clicking a cmask row) toggles the paint
  target between the active paint layer and the current cmask. The rail button
  is tinted with the mask colour, the swatches grey out, the options bar shows a
  "Mask" badge ("Quick Mask: strokes paint the mask (Q to exit)"). Text tool,
  paste, Images panel inserts and New layer switch it off.
- Painting a cmask: brush, eraser, bucket, shapes, selection fill and Delete act
  on coverage. Strokes are forced white (FG/BG ignored); opacity and flow apply.
- Ctrl+click a cmask row selects its effective coverage (invert applied), hard.
- Merge Down of cmasks: union of both effective coverages, stored under the
  lower cmask's invert, colour and name.
- Queueing while a hidden cmask has ever held paint shows "The mask is hidden."

### Image Mask / Input Mask row

- One fixed row directly above Background, cmask-shaped (swatch, invert,
  Overlay). Eye, solo and Ctrl+click work; lock permanently disabled; no rename,
  drag or delete; not counted toward 7.
- **Image Mask** comes from the input image's alpha (coverage = 255 - alpha),
  uploaded as a PNG when the source changes. **Input Mask** comes from the `mask`
  input and replaces it while connected (no stored pixels). Tooltips explain the
  source.
- Selecting it makes it the current cmask (Quick Mask on); every pixel edit and
  Merge Down from it are refused with "<Image Mask | Input Mask> can't be edited
  -- duplicate it to edit."
- A new row takes the next free palette colour (like a new cmask). Eye,
  colour, opacity and invert survive source changes (colour/opacity/invert
  undoable, eye not).
- **Duplicate** makes an ordinary cmask: coverage resampled into document
  coordinates, named "<row name> copy", next palette colour, the row's opacity,
  visibility and invert; at the bottom of the cmask stack, current; one undo
  step. Disabled without coverage or at 7 cmasks.
- Drawn and sampled only over an image of exactly its size.

### Background row and drawing resolution

- "Background" (tooltip "Input image"): always locked, not selectable, no
  rename/drag/delete. Its colour is the node's `background` widget (used opaque).
- **Eye** (not undoable, saved as `backgroundVisible: false`): off shows a
  checkerboard; outputs use the `background` colour instead of the image and
  gain transparency (section 3); copy merged and "All layers" sampling exclude
  the image; "Background" sampling still reads it.
- **Mismatch notice** (options bar, any tool): when Match would resample by more
  than 1.5x: "Drawing grid G px -- image I px (N.Nx)"; when the image area
  doesn't fit the maximum paint area: "The image's shape doesn't fit the drawing
  -- parts can't be painted." (resolution wins if both). Never for an empty
  document or while loading. One warn toast per document per page session.
- **Match image resolution** (button in the notice, confirm): resamples every
  paint, cmask and lmask once so the frame matches what the image would give
  (never lowers resolution, up to 16384); placement is folded in and reset; text
  re-renders with scaled `textData`; bounds beyond 16384 are clipped around the
  frame centre. Clears undo history and the selection.
  Why: undo patches are in document coordinates, and the grid itself changes.

### Solo

- View only. One slot for the paint group (paint, text or Background) and one
  for cmasks (incl. Image/Input Mask). Clicking a solo replaces its group's
  solo; clicking the active one ends it.
- While any solo is set, the stage shows only the soloed layers (both groups),
  even with their eye off; the Background follows its eye unless soloed. Eyes are
  never changed (other rows show dimmed eyes).
- Solo affects "All layers" sampling and copy merged. It does not affect outputs,
  uploads or Ctrl+click selection. Never saved or undoable; ends on delete,
  merge, Clear, or a new session. Never changes the selection; clicking a solo
  settles a float first.
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

- **Merge Down** (Ctrl+E or footer): merges the current row (active paint-like
  layer, or the current cmask under Quick Mask) into the row directly below in
  the same group. The lower row keeps name and settings; paint bakes the upper
  opacity in; text rasterizes first (prompt); the lower row becomes the
  active / current one. One undo step. Refused when either
  row is hidden, solo-hidden or locked, or there is nothing below ("Nothing to
  merge down into."); never into Background or the Image Mask row. An enabled
  upper lmask is applied first ("Layer mask applied."); the lower lmask stays.
- **Clear** (rail, confirm "Clear all paint, regions and output options? This
  can be undone."): empties every layer, removes lmasks, converts text to paint,
  resets the frame to the minimum frame of the current image, resets placement,
  regions and Main options, ends solos and drops the selection (the frame can
  change, so its coordinates would be meaningless; undo restores it). Any float
  is committed and an open region edit cancelled first. Names, order, eye, lock,
  opacity, the current cmask and the Image Mask row stay. One undo step.

Files: `ui/layersPanel.ts`, `layerRow.ts`, `layersPanelParts.ts`,
`layerSections.ts`, `layerDrag.ts`, `layerControls.ts`, `thumbnails.ts`,
`inlineRename.ts`, `imageMaskRow.ts`, `resolutionNotice.ts`,
`engine/layerOps.ts`, `editorMaskOps.ts`, `imageMaskOps.ts`, `solo.ts`,
`layerDisplay.ts`, `rasterize.ts`, `mergeDown.ts`, `frameOps.ts`,
`drawingResolution.ts`, `resolutionOps.ts`, `bounds.ts`, `document/layerList.ts`,
`masks.ts`, `imageMask.ts`, `defaults/maskDefaults.ts`.

## 9. Layer masks (lmask)

An optional grayscale mask on a paint layer that hides part of it
non-destructively. One per layer, always linked. **White = hidden, black =
shown.** Never reaches `MASK`. Text layers can't have one (rasterize first).

**Adding** (the small icon right of the thumbnail): click = reveal all, or with
a selection only the selection is shown (works with inverted selections; bounds
grow to cover it); Alt+click = hide all. Adding selects the layer, targets the
new lmask, and is one undo step.

**Thumbnails**

- lmask thumbnail: click = target the lmask (selects the layer, Quick Mask off);
  Shift+click = enable/disable (red X; not undoable); Alt+click = lmask-only
  view, also targets it (Alt+click again ends it); Ctrl+click = **soft**
  selection of the shown (black) part (+Shift add, +Alt subtract, +Shift+Alt
  intersect; honours invert and `outside`; "The layer mask shows nothing." if
  empty). It is the inverse of a cmask's Ctrl+click, so selection -> add lmask ->
  Ctrl+click round-trips.
- Layer thumbnail click (when an lmask exists) = target the pixels. The target is
  per layer and session-only; other row clicks keep it.

**lmask-only view**: draws only that lmask as grayscale over the normal
background (cmask tints hidden). It moves to another layer's lmask thumbnail or
a row whose target is its lmask. It ends when the active layer has no lmask,
targets its pixels, or is a text layer; when Quick Mask turns on or a cmask row
is clicked; on the Background row; when the layer/lmask is deleted; on Alt+click
again. While it is on, the viewed lmask is editable even on a hidden layer;
bucket and wand sample only that lmask; paste and drop go into it.

**Options bar** while an lmask is targeted (any tool, hidden during Free
Transform): "Layer Mask:" | Invert mask (a setting, undoable) | Apply | Delete
mask (undoable).

**Apply** bakes the lmask as it acts (invert and `outside` applied) into the
layer's alpha and removes it; one undo step. Also bakes a disabled lmask
(clicking Apply means apply). Gate kind "whole": a hidden or locked layer is
refused, even in the lmask-only view.

**Swatches.** While an lmask is targeted, the rail swatches become black/white
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
| Text | Not blocked in the normal view: creates a new text layer / edits an existing one (text never paints the lmask). In the lmask-only view both are refused ("Layer mask: use the brush, eraser or fill.") because text layers aren't visible there. |
| Delete / Alt+Backspace / Ctrl+Backspace (with a selection) | Reveal / fill with the foreground mask swatch / fill with the background mask swatch (white hides, black reveals). |
| To mask | Hides the selection on the lmask (white, soft kept). |

**Carry.** Whole-layer Move, Free Transform and flips carry the lmask (moves and
flips exact; a transform keeps its own original for the lmask; exposed areas get
`outside`). Selection floats follow the target: pixels targeted -> pixels lift,
lmask stays; lmask targeted -> the lmask's own pixels lift as grayscale and
replace what they land on; the vacated area reveals.

**Clipboard.** Pixels targeted: copy = the masked result, cut clears pixels
only. lmask targeted: copy = opaque grayscale, cut reveals. Paste makes a new
paint layer, except in the lmask-only view (section 17).

**Persistence and undo.** Add, delete, invert, Apply, strokes and fills are
undoable; enable, target, view and swatches are not. PNG upload like a cmask.
Clear removes lmasks (undo restores them). Duplicate copies them.

Files: `engine/layerMask.ts`, `layerMaskOps.ts`, `layerMaskCarry.ts`,
`tools/layerMaskBar.ts`, `ui/layerMaskThumb.ts`, `ui/swatches.ts`,
`document/layerMask.ts`, `nodes/layer_masks.py`.

## 10. Colour

- **FG/BG** (`engine/colors.ts`): default black / white, lowercase `#rrggbb`,
  per editor session (survives tab switches and graph undo; reset on reload;
  never saved).
- **Swatches** (rail bottom): FG top-left, BG bottom-right, swap arrow (X),
  reset icon (D). Click a square to open the picker. Greyed under Quick Mask;
  replaced by mask swatches while an lmask is targeted.
- **Uses**: brush, bucket and line use FG. Rectangle/ellipse: stroke FG, fill
  FG; "Both" fills with BG. Text uses FG (changing FG recolours an open edit;
  re-editing a text layer loads its colour into FG). Alt+Backspace fills FG,
  Ctrl+Backspace fills BG (cmask: always white coverage; lmask: the mask swatches).
- **Picker** (popover, ~200 px): optional title, saturation/value square,
  hue slider, hex field (no `#`, upper case, 3 or 6 digits; typing applies live;
  invalid input is marked; Enter or blur applies or reverts the field; Enter
  does not close), old/new preview (click old to reset), up to 10 recent colours
  (`localStorage["PainterSketch.recentColors"]`, saved when the picker closes
  with a changed colour; shared with cmask colour pickers). A click outside
  commits and closes. **Esc closes and keeps the colour** in every colour picker (FG/BG, cmask colour, output fill/border), even from the hex field; only the old half of the preview reverts. No alpha.
- **Eyedropper**: see Tools.

Files: `engine/colors.ts`, `ui/swatches.ts`, `colorPicker.ts`, `hsvControls.ts`,
`colorMath.ts`, `recentColors.ts`.

## 11. Undo and redo

- `HistoryStack`: undo and redo stacks sharing a **256 MB** budget; oldest undo
  entries are dropped silently (the newest is always kept). A push clears redo.
  History lives with the session (survives tab switches), is not saved and not
  copied by forks. **Graph undo never touches paint history.**
- Entry types: `patch` (dirty rect before/after, doc coords), `layers` (add,
  remove with pixels and lmask, move, props), `translate` (lossless layer move),
  `text`, `layerMask` (add/delete/invert), `selection`, `outputs` (region and Main
  metadata), `clear` (full snapshots), `group`.
- Same-gesture property edits merge (a scrub, a picker session, consecutive
  nudges); a merged gesture that ends where it started leaves no step.
  `joinNext` / `joinSince` fold related pushes into one step (rasterize + edit,
  insert + transform commit, float + lmask carry). A stroke that changes no
  pixel adds no step.
- Not undoable: eyes (layer and Background), lock, solo, active layer, Quick Mask
  and current cmask, lmask enable/target/view/swatches, FG/BG, Move drawing
  placement, view, Match image resolution (clears history), Image/Input Mask
  source changes. Frame adoption on an empty document drops history (after a
  Clear: truncates to it).
- Buttons: rail Undo ("Undo (Ctrl+Z)") / Redo ("Redo (Ctrl+Shift+Z / Ctrl+Y)"); disabled
  during a stroke; Undo also enabled while a float or transform is active.
- Special cases: with a float or transform active, Undo cancels it and Redo is
  ignored; Undo during a Move or region drag cancels the gesture; Undo with an
  open text edit commits it first, then undoes it.

Files: `engine/history.ts`, `editorTypes.ts`, `layerHistory.ts`, `paintOps.ts`,
`editor.ts`, `ui/toolRail.ts`, `shortcuts.ts`.

## 12. Tools

### Common mechanics

**Rail order and keys** (`tools/registry.ts`):

| Slot | Tool ids | Key |
|---|---|---|
| Brush | `brush` | B |
| Eraser | `eraser` | E |
| Paint bucket | `bucket` | G |
| Eyedropper | `eyedropper` | I |
| Shapes (group) | `line`, `arrow`, `rectangle`, `ellipse` | U, Shift+U cycles |
| Text | `text` | T |
| Move layer | `move-layer` | V |
| Marquee (group) | `marquee-rect`, `marquee-ellipse` | M, Shift+M cycles |
| Lasso | `lasso` | L |
| Magic wand | `wand` | W |

Hidden tools (no rail button, no key): `move` (Move drawing, layers footer),
`region` (Outputs tab / O), `transform` (a Free Transform session), and
`selection-outline` (substituted at pointer-down).

**Tool groups** (`toolGroups.ts`, `toolGroupSlot.ts`): one rail slot showing the
last-used member. Click selects it; long-press (400 ms) or right-click opens a
fly-out (icon, label, key). The key selects the last-used member; Shift+key
advances to the next (wraps).

**Resolution at pointer-down** (`ToolRegistry.resolve`), locked for the drag:

1. A Free Transform session takes all input, with one exception: Alt + press
   outside its box (not a handle, inside, or the rotate zone) with a rail tool
   that has `altEyedropper` is the temporary eyedropper and leaves the session
   open. Ctrl is ignored during a session.
2. A plain press (no Shift/Alt/Ctrl) inside the selection with a selection tool
   (marquees, lasso, wand; not mid-polygon) -> outline drag.
3. Ctrl -> temporary Move layer with auto-select, for rail tools that allow it
   (`ctrlMove`, default on; off for Text, Move layer, Move drawing, region,
   transform, and a lasso with an open polygon).
4. Alt -> temporary eyedropper, for tools with `altEyedropper`: Brush, Bucket,
   Line, Arrow, Rectangle, Ellipse.
5. Otherwise the active tool.

Ctrl beats Alt. Modifier tracking is observe-only (cursors). Pan (middle-drag,
Space+drag) is handled before any tool.

**Options** are declarative descriptors (number, toggle, select, button, text,
label) rendered by the options bar; no per-tool UI code. Each tool instance
keeps its values for the session (Brush and Eraser separately, each shape
separately). Setting-backed defaults are read once when a session's tools are
created. Number labels scrub (Shift x10); clicking a value opens a slider
popover with a typed field. Bar extras: the lmask bar (section 9), Transform /
Flip H / Flip V (Move layer always; selection tools while a selection exists),
"To mask" / "Invert" while a selection exists, the Quick Mask badge. A Free
Transform session replaces the whole bar (the hidden rail tool's `[` `]` and
digit keys still change its width/size and opacity).

**Paint target**: the active paint/text layer; the current cmask under Quick
Mask; the lmask when the active paint layer targets it (Quick Mask off). See
sections 8 and 9 for cmask/lmask behaviour.

**Pointer samples**: coalesced events, converted to document coordinates through
the frame map. Pressure only for `pointerType === "pen"` (mouse/touch = 1).
Sizes in options are image px, converted at pointer-down. Modifier changes
during a drag re-send the last sample with the new flags.

**Selection clip**: brush, eraser, shapes and bucket are clipped to the
selection coverage (soft coverage scales the result). Bounds growth is limited to
a normal selection's bbox (an inverted selection: no limit).

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

- The four pressure options sit behind one stylus button (tinted when on).
- Brush paints FG; eraser composites `destination-out`.
- **Shift+click** (at pointer-down): a straight line from where the previous
  brush/eraser stroke ended (editor-wide `lastStrokeEnd`, document coords; reset
  by Clear, undo/redo of Clear, and Match; with no previous stroke it is a plain
  click). Its own stroke and undo step at the press's pressure; the spacing
  phase is carried through the joint with no dab there, so a line continuing a
  stroke of the same tool at 100 % opacity is identical to one continuous
  stroke. The spacing phase is per tool, so a line with the other tool starts
  with that tool's own last phase. Shapes don't set `lastStrokeEnd`.
- Esc / pointer-cancel drops the stroke.
- Alt = temporary eyedropper (brush only; not the eraser). Ctrl = temporary
  Move.
- Cursor: crosshair + size ring (section 13).

### Paint bucket (G)

| Option | Range | Default |
|---|---|---|
| Tol | 0..255 per channel | 32 |
| Opac | 1..100 % | 100 % |
| Contiguous | toggle | on |
| Anti-alias | toggle | on |
| Sample | Current layer / All layers / Background | setting `BucketSample`, `background` |

- A click floods (section 14 for sampling and matching). The click must be
  inside the image or the bounds; bounds first grow to cover the image area.
- Clipped by the selection; one undo patch; no change = no step.
- With anti-alias the fill also goes behind the target's own soft edges
  (`fillUnder.ts`; not on cmasks/lmasks), so filling around a stroke leaves no
  halo.
- cmask: white coverage at the opacity. lmask: the foreground mask swatch.
- A text layer: rasterize confirm, then the fill continues.
- Cursor: bucket icon, hotspot at the drip (19, 20).

### Eyedropper (I)

| Option | Values | Default |
|---|---|---|
| Sample | Current layer / All layers / Background | All layers (no setting) |
| Size | Point / 3x3 average / 5x5 average | Point |

- Press, drag and release pick live into FG; **Alt+click with the eyedropper
  itself** picks into BG. The temporary (Alt) eyedropper always writes FG and
  shares these options. Esc / cancel during a pick keeps the last sampled
  colour (no revert).
- Transparent or off-layer samples leave the colour unchanged; averages are
  alpha-weighted.
- "Current layer" = the active paint/text layer's raw pixels (never the cmask,
  even under Quick Mask; nothing is picked without a paint layer). It ignores
  hidden/locked state.
- Refused while an lmask is targeted (also the temporary one).
- While picking, a loupe ring shows the new colour (top) and the previous one
  (bottom). Cursor: eyedropper icon, hotspot at the tip (3, 21).

### Line and Arrow (U group)

| Option | Range | Default |
|---|---|---|
| Width | 1..500 px (pow), `[` `]` | 4 |
| Opac | 1..100 % | 100 % |
| Arrow | None / End / Both | Line: None, Arrow: End |
| Head | 150..1500 % of width | 400 % |

- Drag: the shape is rebuilt from start to current on every move (live preview
  in the stroke buffer). Esc drops it; zero length makes nothing.
- **Release opens the shape in Free Transform** (all shape tools): it becomes a
  float on the current target layer (never a new layer; cmask = white coverage)
  with handles (axis-aligned box). Enter / tool switch / any edit commits one
  undo step; an untouched commit writes exactly the pixels the shape was drawn
  with. Esc / Cancel / Ctrl+Z removes it (no history; a text layer's rasterize
  step from the press stays). With the shape tool, a press on a handle, inside
  the box or in the rotate zone transforms; a press anywhere else commits and
  starts the next shape in the same gesture (Alt there = eyedropper instead,
  session kept; Ctrl ignored). The selection clips the shape when it becomes
  the float (not again at commit); the float never moves, restores or clears
  the selection. A shape that changes no pixel (fully clipped, or identical
  pixels) ends silently with no session and no step. A committed shape on an
  empty layer becomes the layer's kept original (section 18).
  (`engine/shapeFloat.ts`)
- Shift snaps to 15 degree steps (live). Round caps. FG colour. Arrowhead length
  `width x Head`, capped at 90 % of the line per head.
- `[` `]` change Width (same steps as Size, max 500).

### Rectangle and Ellipse (U group)

| Option | Values | Default |
|---|---|---|
| Width | 1..500 px (pow), `[` `]` | 4 |
| Opac | 1..100 % | 100 % |
| Mode | Stroke / Fill / Both | Stroke |

- Same drag model (and Free Transform on release). Stroke and Fill use FG; Both strokes FG and fills BG. The
  stroke is centred on the edge and drawn over the fill; corners mitred;
  rectangles pixel-aligned, ellipses anti-aliased.
- Shift = square/circle; Alt during the drag = from centre (Alt at pointer-down
  is the eyedropper, also during a shape's Free Transform session).

### Text (T)

| Option | Values | Default |
|---|---|---|
| Font | text with suggestions | `sans-serif` |
| Size | 1..1000 image px (pow) | 48 |
| B / I | toggles | off |
| Align | Left / Center / Right | Left |
| Angle | -180..180 degrees | the target's rotation |

- Fonts: recent fonts first (last 5, `localStorage["PainterSketch.recentFonts"]`),
  then `sans-serif`, `serif`, `monospace`, Arial, Helvetica, Verdana, Tahoma,
  Trebuchet MS, Segoe UI, Georgia, Times New Roman, Courier New, Impact, Comic
  Sans MS; "Custom font..." turns the menu into a text field (max 100 chars).
  Entries preview in their own font. A missing font shows "Font 'X' isn't
  installed; editing will use a fallback."
- `textData`: `text` (lines `\n`, max 10000 chars), `x`, `y` (baseline of the
  first line at its left/centre/right edge per `align`, document px), `font`,
  `size` (doc px, 1..4096), `color`, `bold`, `italic`, `align`, `lineHeight?`
  (default 1.25), `rotation?` (degrees about the unrotated box centre; dropped
  at 0).
- **Pointer-down**: Ctrl -> move the text under the pointer (else the active
  text layer) via `textData` (never rasterizes). Otherwise, if an edit is open,
  commit it; a click on empty canvas or the same text only commits, a click on
  another text opens that one. Quick Mask switches off. A click on a text layer
  (topmost visible, rotated box plus a 15 % margin) re-edits it; locked/hidden
  layers show their note. Otherwise new text at the click (new layer above the
  active paint layer, named from its text on commit); creating text never
  clears the selection. Point text only (no wrapping boxes).
- **Editing**: a `<textarea>` overlay (transparent text; the canvas shows the
  real rendering). Enter = new line; Esc or Ctrl+Enter commits; Ctrl+Z in the
  field is native text undo. Option and FG changes apply live. It also commits on
  tool switch, undo, layers-panel actions, and focus leaving the editor.
- **Commit**: create + type = one step; editing = one text step; empty or
  whitespace-only text removes the layer (keeping the last paint-like layer).
- Angle: live on an open edit, else one merged step on the active text layer.
  Free Transform keeps text editable for rotation and uniform scale (section 18).
- Pixel edits on a text layer ask "Rasterize text layer? It will no longer be
  editable as text."; OK converts it to paint in the same undo step (strokes and
  shapes abort that press; the bucket continues).
- Cursor: I-beam; `move` during a Ctrl+drag.

### Move layer (V), Move drawing, region, outline drag, transform

Described in sections 19 (Move layer, Move drawing), 21 (region tool), 15
(outline drag) and 18 (Free Transform).

### Marquees (M group), Lasso (L), Magic wand (W)

Described in section 15. The wand's options and sampling are in section 14.

Files: `tools/` (`registry.ts`, `toolGroups.ts`, `brush.ts`, `eraser.ts`,
`paintTool.ts`, `fill.ts`, `eyedropper.ts`, `lineTool.ts`, `boxShapeTool.ts`,
`shapeTool.ts`, `shapeTools.ts`, `text.ts`, `types.ts`, `options.ts`),
`engine/paintOps.ts`, `pixelOps.ts`, `shapes.ts`, `shapeRender.ts`,
`textOps.ts`, `textLayer.ts`, `textRender.ts`, `document/textData.ts`,
`ui/textOverlay.ts`, `ui/loupe.ts`, `ui/optionsBar.ts`, `ui/optionControls.ts`.

## 13. Brush engine

**Why: the tip and combine rule are measured from Photoshop's lossless exports,
not designed.** Two sessions replaced them with swept-profile / "max" / "alpha
darken" schemes from eyeballing screenshots; every variant creased where a
stroke met itself and left Voronoi-like cells when colouring in. Change the tip
or the combine rule only against a new lossless Photoshop export, measured. The
measurements and the rejected variants are in the archive ("Brush engine").

**Tip** (`brush.ts`): alpha at distance `d` is `10^-(d/R)^2`, `R = size/2`: at
hardness 0, 10 % at the nominal radius, 50 % at 0.55 R, cut off at 1.5 R (fit
error < 1/255).
Hardness `h` gives a solid core to `h*R` and squeezes the same fade into
`(1-h)*R`, never thinner than 1 px (`fade = max(1-h, 1/R)`, `core = min(h, 1 -
fade/2)`), so 100 % is a 1 px anti-aliased edge. Hardness 0 is measured;
0 < h < 1 is our interpolation (user-compared with PS at 50 and 100 %).

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
click; crossings, corners and Shift+click joints fill in without creases; at 40
% spacing dabs show as circles with solid interiors, as in PS.

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
content each move. Bounds grow (chunked, capped) to cover dab reach + 2 px.

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
| Current layer, cmask target (incl. Image/Input Mask) | The cmask's effective coverage (invert applied) as opaque gray; the Image/Input Mask is resampled to doc coords, 0 outside the image. |
| Current layer, no layer | Falls back to All layers. |
| All layers, pixel or lmask target | The visible composite: background + visible paint layers at opacity, lmasks applied, solo and the Background eye honoured; no cmask tints. |
| All layers, cmask target | The union (max) of the cmasks shown on the stage (eye and solo respected, each inverted per its setting); the Image/Input Mask row joins while shown and applicable. |
| Background | Only the input image (or the width x height fill), same placement, no paint; reads the image even with the Background eye off. |

**Hidden targets**: the bucket goes through the edit gate (a hidden target is
refused, any Sample; the one exception is the gate's own: the viewed lmask in
the lmask-only view is fillable on a hidden layer). The wand with Current layer on a hidden paint
layer or cmask refuses with the hidden note and keeps the selection; other
sample sources and the lmask-only view never refuse on visibility. The wand
doesn't check lock.

**Matching** (`floodFill.ts`): every channel (R, G, B, A) within `tolerance` of
the seed, compared premultiplied (nearly transparent pixels match transparent;
two transparent pixels always match). Contiguous = 4-neighbour scanline fill;
otherwise every matching pixel. Anti-alias adds a 1 px soft fringe outside the
hard result (3x3 box). The seed is `floor(point)`; a seed outside the area gives
nothing. Area: bucket = bounds grown to the image area; wand = image area union
bounds (no growth).

**Magic wand (W)** options: Tol 32, Contiguous on, Anti-alias on, Sample
(setting `WandSample`, `background`). The result combines with the selection by
mode (section 15); a miss in replace mode deselects.

Files: `engine/pixelOps.ts`, `floodFill.ts`, `wand.ts`, `docComposite.ts`,
`fillUnder.ts`, `tools/fill.ts`, `tools/magicWand.ts`.

## 15. Selection

**Model** (`engine/selection.ts`): a 0..255 coverage buffer in document
coordinates (follows the drawing, not the image). Stored cropped as `{rect,
data, outside: 0 | 255}`: every pixel outside `rect` has the value `outside`, so
an inverted selection keeps covering paint area added later. Results are trimmed;
an empty result is `null` (= no selection). Session state, never saved. Every
change is one `selection` history entry. New coverage is clipped to the bounds
cap union current bounds.

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
pressed again. Alt is never the eyedropper in selection tools. Cursor badges
show the mode (section 24 / cursors).

**Tools**

- **Rectangular marquee**: hard edge; edges rounded to whole px, a pixel is in if
  its centre is.
- **Elliptical marquee**: anti-aliased (16 sub-rows, exact horizontal coverage).
- Marquee ants preview only after the drag passes a 3 CSS px click slop. A click
  without a drag deselects (replace mode only). Esc cancels.
- **Lasso**: anti-aliased, non-zero winding; freehand points decimated to ~1
  image px. Alt held with the button down = straight segments (rubber band);
  releasing Alt with the button down resumes freehand. Releasing the button with
  Alt held keeps the path open (`pending`): each press adds a vertex; it closes on
  releasing Alt, a double-click (<= 400 ms, within slop), or a click near the
  start (> 2 points). Releasing the button without Alt closes it. Esc or a tool
  switch cancels. A bare click deselects (replace mode). Ctrl->Move is suppressed
  while a polygon is pending.
- **Magic wand**: section 14.

**Commands**

- Select all (Ctrl+A): the current image area in document coordinates (includes
  placement); bounds grow to cover it.
- Deselect (Ctrl+D). Invert (Ctrl+Shift+I, Shift+F7, or the bar button); no
  selection stays none.
- Not implemented: Reselect, feather, grow/shrink, refine edge.
- Delete / Backspace: clear the selected part of the target (paint: alpha x
  (1 - c); cmask: remove coverage; lmask: reveal). Without a selection Delete is
  swallowed silently (so the graph never deletes the node).
- Alt+Backspace / Ctrl+Backspace: fill with FG / BG (cmask: white coverage, both
  identical; lmask: the foreground / background mask swatch). Without a
  selection: "Nothing is selected."
- **To mask** (bar button): adds the selection coverage (soft kept) to the
  current cmask, creating one if none exists; does not change the target. With
  an lmask targeted it hides the selection on that lmask instead (white, soft
  kept, through the edit gate). One undo step.
- Arrow keys with a marquee, lasso or wand active and a selection (no float)
  nudge the outline 1 / 10 image px; consecutive nudges are one undo step.
- All commands go through the edit gate and settle a float first.

**Marching ants** (`marchingAnts.ts`, `selectionOutline.ts`): boundary at
coverage >= 128, closed contours computed once per change; 1 px white solid +
black dashes (4 CSS px, ~8 fps). An inverted selection also draws ants along the
image-area edge, but its coverage is **not** bounded by the image (it still
covers the whole paint area). Hidden during a transform drag.

**Selection from a row** (Ctrl+click; +Shift add, +Alt subtract, +Shift+Alt
intersect; hover cursor shows the mode):

- Paint, text and cmask rows: **hard** (alpha > 0 -> 255); a cmask uses its
  effective coverage; the lmask is ignored; works on hidden layers; doesn't change
  the current layer, Quick Mask or solo; settles a float first; an empty layer
  notes "The layer has no pixels." and keeps the selection.
  Why: a soft selection left an `a*(1-a)` residue on every edge when moved, and
  ghosted on repeat.
- Image/Input Mask row: hard, invert applied, resampled to doc coords.
- lmask thumbnail: **soft**, the shown part (section 9).
- The Background row can't load a selection.

**Outline drag** (`tools/outlineDrag.ts`): a plain press inside the selection
(coverage >= 128) with a marquee, lasso or wand drags only the outline, whole
doc px, one `selection` entry; Esc restores it; a press that never leaves the
click slop is replayed to the tool as a click. With a float alive it commits the
float first. Cursor: arrow + dotted-rectangle badge.

**Following**: a whole-layer move (drag outside the selection, or nudges)
carries the selection in the same undo step.

Files: `engine/selection.ts`, `selectionOps.ts`, `selectionState.ts`,
`selectionRaster.ts`, `selectionOutline.ts`, `selectionFollow.ts`,
`tools/marquee.ts`, `lasso.ts`, `magicWand.ts`, `outlineDrag.ts`,
`selectionModifiers.ts`, `ui/selectionShortcuts.ts`, `selectionActions.ts`,
`marchingAnts.ts`, `layerSelectHover.ts`.

## 16. Floating selections

A float is transient editor state (never a layer, never saved), drawn above its
own layer inside that layer's display (so opacity, visibility and cmask tint
apply). It moves in whole doc px; nothing is resampled until a transform. The
outline moves with it; bounds grow so what you see is what lands (past the cap
is cropped on commit).

**Starting a float**

- Move layer: a press inside the selection (coverage >= 128) lifts the selected
  pixels; Alt at pointer-down lifts a copy (no hole). Pressing outside moves the
  whole layer (selection follows). While a float exists, any drag or arrow nudge
  moves it.
- Any rail tool with Ctrl (temporary Move layer): Ctrl+drag inside lifts,
  Ctrl+Alt+drag lifts a copy.
- Free Transform with a selection lifts as a cut (section 18).
- Decided at pointer-down (`float.check()`): a refused lift never falls through
  into a layer move; a text layer defers the rasterize confirm until the press
  ends (drag again afterwards).

**What lifts**: pixels coverage-weighted (float alpha `a*c`, remainder
`a*(1-c)`). Paint/text with pixels targeted: pixels, the lmask stays. lmask
targeted: the lmask's pixels as grayscale; they replace what they land on, the
vacated area reveals. cmask under Quick Mask: like paint. A whole-layer lift
(Free Transform without a selection) carries the lmask.

**Commit / cancel**

- Commit lands the float as one patch (source union destination) joined with the
  selection move into one step. Triggers: Enter, and any other edit, deselect or
  selection change, tool switch, layer/target change, solo, queue and Ctrl+S. A
  float that never moved commits as a cancel (no step).
- Cancel (Esc or Ctrl+Z) restores the pre-lift pixels and selection with no
  history; Ctrl+Y is ignored while floating. Cancelling an inserted image or an
  oversized paste also removes its layer and brings the previous selection back.
- Arrow keys nudge an existing float whatever the active tool (1 image px,
  Shift 10; the key is swallowed even mid-drag, when the nudge is refused);
  during a Free Transform session the session nudges.
- Idle / blur / tab-hidden uploads while floating save the pre-lift pixels
  (never half a float); queue and Ctrl+S commit first.
- A shape float (section 12) is independent of the selection: commit and
  cancel leave the selection as it is.
- Empty lift: "No pixels are selected."

Files: `engine/floatOps.ts`, `floatLift.ts`, `floatCommit.ts`, `floatMath.ts`,
`layerMaskCarry.ts`, `tools/moveLayer.ts`, `ui/floatShortcuts.ts`.

## 17. Clipboard and drop

**Copy / cut**

- Ctrl+C: the target's selected pixels (coverage-weighted), or the whole layer
  without a selection; trimmed to non-transparent pixels. cmask: opaque grayscale
  (white = masked). Paint with an enabled lmask: the masked result; lmask targeted:
  the lmask as grayscale.
- Ctrl+Shift+C (copy merged): what is visible, including the image, within the
  selection or the image area; no image when the Background eye is off; under
  Quick Mask the union of visible cmasks as grayscale.
- Ctrl+X: copy + clear in one patch (text rasterizes first; lmask targeted:
  reveals).
- Hidden / solo-hidden layers refuse ("Nothing to copy." if empty); locked layers
  can be copied. Every command settles a float first.
- The copy goes to a module-level internal clipboard (shared by all PainterSketch
  nodes on the page: pixels, doc rect, image scale, a 16x16 fingerprint, the
  source editor) and as a PNG to the system clipboard (failure is console-only).

**Paste**

- Ctrl+V and the Paste button ("System"): a system-clipboard image (unless it is
  our own PNG by fingerprint -> the internal copy) -> internal copy -> ComfyUI
  clipspace -> note. "Our own" = an internal copy exists, same pixel size, and
  the mean absolute difference over the 16x16 RGBA thumbnails is <= 4. The
  keydown is stopped but not prevented, so the browser fires `paste`; a
  one-shot capture `paste` listener (1 s) takes it before ComfyUI.
- Ctrl+Shift+V: the internal copy at its copied document position, not
  clamped, also from another PainterSketch node (intended: same spot across
  nodes); without one, like Ctrl+V (Chrome fires no `paste` for Ctrl+Shift+V,
  so the async clipboard is read instead).
- Paste button long-press / right-click: System clipboard / Clipspace (the choice
  sticks per button).
- A paste is a new paint layer "Pasted" / "Pasted N" above the active paint layer
  (above the top paint layer under Quick Mask); one undo step; Quick Mask
  off; the selection is dropped in the same step; takes over solo. Foreign images
  paste 1 source px = 1 image px; internal copies keep their image-px size. The
  pasted pixels become the layer's kept original (section 18).
- **Placement** (`pastePlacement.ts`, measured from Photoshop, first match wins):
  1. A selection exists: centre on its bbox (an inverted selection counts as the
     image area).
  2. Our own copy from this editor: its original position.
  3. The whole image area is visible: its centre.
  4. Otherwise: the view centre.
  Then clamp into the image area (centred on an axis where the item is larger)
  and snap to whole doc px.
- **Oversized**: a paste reaching past the paint-area cap opens at native size in
  a Free Transform session with "Paste is larger than the paint area -- placed in
  Free Transform. Commit to crop, Esc to cancel." Why: nothing is cropped
  silently.
- **lmask-only view**: every paste and drop goes into the viewed lmask as an
  lmask float (value = Rec.709 luminance x alpha, so transparent = shown; our own
  lmask copies keep exact values; the lmask's invert is ignored so copies
  round-trip), normal placement; oversized -> Free Transform on that float.

**Drop** (`ui/dropImport.ts`): image files (one layer per file, at the drop
point, same clamp) and images dragged from web pages (`<img src>` / uri-list,
fetched). Workflow JSON and other known non-image files are left to ComfyUI. A
CORS-blocked web image gives a toast; a non-image a note.

Files: `engine/clipboardOps.ts`, `clipboardMath.ts`, `pastePlacement.ts`,
`ui/clipboardActions.ts`, `clipboardShortcuts.ts`, `pasteChoice.ts`,
`pasteSources.ts`, `pasteButton.ts`, `dropImport.ts`.

## 18. Free Transform and flips

**Entering**: Ctrl+Alt+T (literal `t`, AltGr-safe; Ctrl+T is Chrome's) or the
Transform button. Cases in order: an existing float is adopted; a text layer ->
text session over its box (selection ignored); a selection -> lift as a cut; no
selection -> the kept original if valid, else the whole layer content (carrying
the lmask). Parameters `{cx, cy, sx, sy, angle}`; signed scale = flip. No
skew, distort, warp, movable pivot or multi-layer.

**Handles** (`transformHit.ts`, `transformOverlay.ts`): box with 8 square
handles (7 px) and a centre mark, screen-constant. A handle within 8 px scales;
inside the box moves; outside a corner within 8 + 16 px rotates; elsewhere does
nothing (except Alt + press there = temporary eyedropper for tools with
`altEyedropper`, session kept; with a shape tool a plain press there commits and
draws the next shape, section 12). Scale is proportional by default (Link on;
an edge handle then scales both axes, as in Photoshop); **Shift inverts** that;
**Alt** on a handle scales about the centre; minimum side 1 doc px. **Shift
while rotating** snaps to 15 degrees. Arrows nudge 1 image px, Shift 10. The
session tool takes all other stage input (no Ctrl substitution).

**Options bar** (replaces the tool's): X, Y (box centre, image px), W, H (1..10000
%), Link, Angle (-180..180), Flip H, Flip V, Commit (Enter), Cancel (Esc).

**Commit / cancel**

- Commit: Enter, the check button, a tool switch, or any other edit.
  Whole-layer and inserted sessions commit at once (one undo step, one resample).
  A **selection-float** session only ends: the float stays (with its matrix over
  the original lifted pixels); a second Enter or any edit lands it. A later
  session on it restarts from the original with the cumulative matrix.
- Cancel: Esc, the x button, or Ctrl+Z cancels the whole session (including the
  lift); no per-adjustment undo.
- The preview draws the original through the matrix; the commit resamples once
  from the original (bilinear on premultiplied alpha, up to 4x4 supersampling
  when shrinking). Whole-px moves and flips are exact.

**Kept original** (`keptOriginal.ts`): after a commit that leaves the result as
all the layer holds, the layer keeps its pre-transform pixels + cumulative matrix
in memory while its pixel revision is unchanged (any edit, lift, merge, Clear,
rasterize, Match or undo touching it drops it). Repeated transforms resample from
it once (5 x 10 degrees = one 50 degree resample). 128 MB per editor, oldest
first; never saved.

**Flips** (H/V buttons in the session bar, the Move layer bar, and the selection
tool bars while a selection exists): in a session, part of it. With a selection
or float outside a session: lift and mirror, stays floating. With neither: mirror
the whole layer about its content centre, exact, one undo step, lmask mirrored
too. Text: rasterize confirm. Empty layer: "The layer is empty."

**Text layers**: rotation -> `textData.rotation`, uniform scale -> `size`, move
-> anchor; stays editable; one text step. A non-uniform scale, a flip, or an
unlinked W/H edit asks to rasterize after the gesture (Yes = continue as a pixel
session; No = drop the change).

Files: `engine/transformOps.ts`, `transformMath.ts`, `transformHit.ts`,
`transformFields.ts`, `transformSession.ts`, `transformResample.ts`,
`textTransform.ts`, `textFieldEdit.ts`, `keptOriginal.ts`, `layerFlip.ts`,
`tools/transformTool.ts`, `ui/transformOverlay.ts`, `ui/floatShortcuts.ts`.

## 19. Moving (Move layer, Move drawing)

**Move layer (V)**

- Moves the edit layer (active paint/text layer, or the current cmask under
  Quick Mask) by whole doc px; one undo entry per drag. The preview only offsets
  the layer's drawing; pixels move once, on commit (`engine/layerMovers.ts`
  per-kind handlers: paint/cmask translate pixels and carry the lmask; text shifts
  its `textData` anchor and never rasterizes). The selection moves with it.
- With a selection: see section 16 (press inside lifts, Alt = copy).
- **Auto-select** (option, default off; or Ctrl at pointer-down): picks the
  topmost visible, unlocked paint/text layer with alpha > 10 under the pointer
  and makes it active (not an undo step). With Quick Mask on it picks only
  visible, unlocked cmasks by raw coverage and makes the hit current (Quick Mask
  stays on). Nothing hit = nothing moves. Off while a selection exists.
- **Ctrl = temporary Move layer** for every rail tool except Text, Move layer,
  Move drawing and the region tool (and a pending lasso). Precedence Ctrl > Alt >
  active tool, locked for the drag; a Free Transform session beats all.
- Arrows nudge 1 image px (>= 1 doc px), Shift 10; consecutive nudges merge into
  one step; swallowed mid-drag. Esc / pointer-cancel aborts a drag.
- Refusals: the edit gate notes; "This layer can't be moved."; "No pixels are
  selected." Loading or an active stroke: silent.
- Bar: Auto-select, Transform, Flip H, Flip V.

**Move drawing** (hidden tool; layers-footer toggle, no shortcut; toggling again
returns to the last rail tool)

- Edits `doc.placement`: the whole drawing (all layers, cmasks, lmasks) relative
  to the image, to realign paint to a similar but offset image.
- Drag moves in whole image px. **Wheel while dragging** scales around the
  cursor (x1.05 per notch, trackpads proportional); the wheel without a drag
  still zooms the view. Arrows nudge 1 / 10 image px. Esc during a drag restores
  the start placement.
- Bar: X, Y (image px, +-16384), Scale (5..1000 %), Reset position.
- Clamped so the paint area covers the image area plus 50 image px per side
  (Reset and cancel aren't clamped).
- **Not undoable**: never in the paint history (Ctrl+Z always undoes paint, also
  while this tool is active). Paint patches are in doc coords, so they stay valid
  under any placement. Clear resets placement inside its own undoable snapshot.
- Ctrl never substitutes Move layer here. Cursor `move`.

Files: `tools/moveLayer.ts`, `tools/move.ts`, `engine/moveOps.ts`,
`layerMovers.ts`, `layerTranslate.ts`, `layerPick.ts`, `placementOps.ts`,
`placementMath.ts`, `placementClamp.ts`.

## 20. Image sources and the Images panel

- Optional `layer_source` input (3rd). Session history (`SourceHistory`): the
  last **10** distinct images, newest first (a repeat moves to the top), per node
  instance, never saved. Sources: the upstream preview (same lookup as the
  background; works before any run), then our executed `layer_source` preview
  (no provenance check). Deduped by the `/view` query for upstream previews and
  by Python's `source_id` for executed ones. Named after the upstream file stem
  for LoadImage-style / `type=input` previews.
- **Images button** after Paste, with a count badge; disabled while empty.
- **Panel**: a sticky thumbnail column over the left of the stage (in the popover
  layer, so it follows fullscreen), newest first. A thumbnail click inserts and
  the panel **stays open**. It closes on Esc (before any other Esc handler), a
  press on the stage, a rail tool press, or the button again; clicks elsewhere
  leave it open. A new source auto-opens it, except the first one seen after
  load (a seed) or a repeat; re-linking the input re-arms, so the next first
  source auto-opens. The list follows the history live and the panel closes if
  it empties.
- **Insert**: load and decode (over 8192 px per side is downscaled once: "Image
  reduced to W x H px (max 8192 px per side)."); add an empty paint layer named
  after the file stem or "Image N" above the active paint layer (Quick Mask off,
  selection dropped in the same step, takes over solo); start a Free Transform
  session at scale 1 or fitted to the image area, placed by the paste rule. The
  commit resamples once from the full source. Commit = one undo step; cancel
  (Esc, x, Ctrl+Z) removes the layer and leaves no step. A live session or float
  is settled first. Failure: "Could not load the image."

Files: `widget/sourceHistory.ts`, `layerSourceWatch.ts`, `imageSource.ts`,
`ui/imagesPanel.ts`, `sourceInsertAction.ts`, `engine/sourceInsert.ts`,
`nodes/previews.py`.

## 21. Outputs and regions (editor)

**Region mode = the Outputs tab.** The hidden `region` tool (no options, no
Ctrl/Alt substitutes, crosshair) is active exactly while the Outputs tab shows.
Opening the tab activates it; choosing any other tool shows the Layers tab;
clicking Layers restores the last rail tool. The Outputs button (options bar,
trailing, "Output regions (O)") and **O** toggle: with the panel open in region
mode they return to Layers; otherwise they open the panel on Outputs. Collapsing
the panel doesn't leave region mode. Esc doesn't leave it; Delete never deletes a
region (only the card's trash button).

**Pointer** (current-image px):

- Press (no Shift): the selected region's handle (6 px) -> resize; its body ->
  move; the topmost visible region -> select + move. Shift always draws a new
  region.
- Under 3 px of movement is a click; only a real drag opens a transaction.
- Draw creates a region in the lowest empty slot (selected, live rect, any
  direction). With all 6 slots used: "All 6 region slots are used. Delete a
  region to draw another."
- A click on empty canvas (or Shift+click) selects Main; on a region selects it.
- Resize keeps the opposite edge (no flip, min 1 px); move keeps the size and
  stops at the region area. Esc mid-drag reverts.

**Geometry**: integer image px from the top-left, never rescaled; the region area
is one image size beyond each edge (`x` in `[-W, 2W]`, `y` in `[-H, 2H]`); edges
`floor(v + 0.5)`; min 1x1. "+ Region N" creates a centred half-size region.

**Outputs tab**: Main card, then six slot cards in order (an empty slot is a
one-line "+ Region N" button). Hint: "Drag on the image to add a region;
Shift-drag starts a new one inside another." Cards update in place (a field being
edited is never rebuilt).

- Region card row 1: eye (overlay only; outputs always produced), title
  `N · name` (double-click renames the name: Enter / blur commit, Esc
  cancels), trash (empties the slot; no renumbering). Row 2: X / Y / W / H
  fields (typed live, rounded, clamped; label scrub 2 px per step, Shift x10;
  one session = one undo step; Enter commits, Esc reverts).
- Main card: title, read-only `W x H`, options row; selected when no region is.
- Clicking a card selects it.

**Output options row** (`outputOptionsRow.ts`): `Modify` select + `Alpha`
checkbox; a second line only when needed.

| Modify | Extras | Defaults |
|---|---|---|
| None | - | - |
| Fill mask | fill swatch (in Alpha's place; Alpha hidden, value kept) | `#000000` |
| Crop to mask | Pad | 0 |
| Add border | W (1..4096), colour swatch, Mask border | 64, `#ffffff`, on |

Options apply only at execution (nothing changes on the stage).

**Overlay** (`regionOverlay.ts`): in region mode, solid outlines with a halo and a
number badge; the selected region 2 px `#62d5ff` with 8 handles; the image border
highlighted while Main is selected. Outside region mode: subdued dashed outlines
(alpha 0.3) with a small number. Only visible regions are drawn or hit.

**Undo**: add, remove, rect, rename, eye and option edits are `outputs` entries
(metadata only). Selecting is not an edit (no upload, no redo loss). Why: every
card click would otherwise upload and clear redo.

**Regions helper labels** (`widget/regionsNode.ts`, `regionLabels.ts`): from the
source node's document: filled slot `<name>` / `<name> mask`; empty slot
`Region N (missing)` / `Region N mask (missing)`; unresolvable source
`Region N` / `Region N mask`. Updated on graph configure, helper add, connection changes and
our document changes (no polling). Outputs are re-spliced so Nodes 2.0 sees
label changes.

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
| Clear all paint, regions and output options? This can be undone. | Clear. |
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
| Layer mask: use the brush, eraser or fill. | Shapes / line with an lmask targeted; creating or editing text in the lmask-only view. |
| Layer mask: black and white only, no eyedropper (X swaps). | Eyedropper with an lmask targeted. |
| The layer mask shows nothing. | Ctrl+click an lmask that shows nothing. |
| Layer mask applied. | Merge Down with an enabled upper lmask. |
| Nothing to merge down into. | Ctrl+E with no valid row below. |
| This layer can't be moved. | Move on a kind without a mover. |
| No pixels are selected. | Lift/move with a selection holding no pixels. |
| The layer is empty. | Flip / whole-layer lift of an empty layer. |
| Nothing is selected. | To mask / fill without a selection. |
| The layer has no pixels. | Ctrl+click an empty row. |
| Nothing to copy. | Copy/cut found nothing. |
| Nothing to paste. / The clipboard has no image -- nothing to paste. / Clipspace has no image -- nothing to paste. | Paste with no source (Ctrl+V / System / Clipspace). |
| Paste is larger than the paint area -- placed in Free Transform. Commit to crop, Esc to cancel. | Oversized paste or drop. |
| The dropped item is not an image. | Non-image drop. |
| Could not load the image. | Images panel insert failed. |
| Image reduced to W x H px (max 8192 px per side). | Large source. |
| Font '{name}' isn't installed; editing will use a fallback. | Text edit with a missing font. |
| All 6 region slots are used. Delete a region to draw another. | Drawing a 7th region. |

Other fixed text: "Run the workflow to load this mask" (Input Mask hint); the
resolution notice; the fullscreen placeholder; the Outputs hint; the cleanup
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
| Esc | Images panel > float / transform > tool drag or pending interaction > popover > fullscreen |
| Q | Toggle Quick Mask |
| F | Toggle fullscreen |
| O | Toggle the Outputs tab (region mode; with the panel collapsed, opens it on Outputs) |
| Delete / Backspace (Shift optional) | Clear the selection on the target; without a selection, or on key repeat, swallowed (never deletes graph nodes). Ctrl+Delete / Alt+Delete are not bound. No key deletes a region |
| F5 / Ctrl+R / Cmd+R / Ctrl+Shift+R | Page-wide, only while uploads are pending: flush (3 s), confirm if that failed, then reload |

### View

| Keys | Action |
|---|---|
| Wheel (any modifier) | Zoom about the cursor (Move drawing drag: scale) |
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
| Long-press / right-click a group slot | Tool fly-out |

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
| Arrows / Shift+arrows | Nudge 1 / 10 image px (any float, transform session, Move layer, Move drawing; the selection outline with a selection tool). Swallowed while engaged even when nothing nudges |
| Alt+drag inside a selection (Move layer) | Lift a copy (Alt outside a selection and Shift axis-lock are not bound) |
| Ctrl+Alt+T | Free Transform |
| Enter / Esc | Commit / cancel a float or transform |
| Shift (handle drag) | Toggle proportional |
| Alt (handle drag) | Scale about the centre |
| Shift (rotate) | 15 degree steps |
| Wheel while dragging (Move drawing) | Scale the drawing |

### Clipboard

| Keys | Action |
|---|---|
| Ctrl+C / Ctrl+Shift+C | Copy / copy merged |
| Ctrl+X | Cut |
| Ctrl+V | Paste as a new layer (into the lmask in lmask-only view) |
| Ctrl+Shift+V | Paste our copy in place |
| Long-press / right-click Paste | Choose System clipboard / Clipspace |

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

**Free keys** (useful for new bindings, e.g. the planned help overlay): letters
A C H J K N P R S Y Z; `?` (Shift+/), F1, Tab, Home/End, PageUp/PageDown, Caps
Lock; Shift+letters other than M and U; Shift+digits. ComfyUI's keybinding
service ignores plain and Shift-only keys while an `<input>` (our focus sink)
has focus (`keyCombo.ts isReservedByTextInput`), and also its reserved set
(Ctrl+A/C/V/X/Z/Y/P, Enter, Home/End, PageUp/PageDown, arrows,
Ctrl+Backspace/Delete); other Ctrl / Alt chords still reach ComfyUI (Ctrl+B/G/M/O
and Alt+C/M are graph commands; Ctrl+L/N/R/T/W/H are browser keys). Notes for
the help overlay: `?` arrives as Shift + a character, so bind it on `event.key`
before the Shift+group-cycle lookup in `shortcuts.ts`; F1 must be handled by
the editor's own handler, which runs before the fullscreen pass-through
(outside fullscreen the browser's F1 help opens otherwise).

### Cursors (current state)

The stage cursor is the CSS variable `--cps-tool-cursor`; pan classes
(`cps-pan-ready` grab, `cps-panning` grabbing) and loading (progress) win. Icon
cursors are SVG data URLs: bucket and eyedropper 24 px (4 px `#111` outline +
1.75 px white stroke, from the rail icon paths, `ui/cursors.ts`); move, outline,
row and rotate cursors 32 px (black fill, white outline, `ui/moveCursors.ts`);
the mode-badge crosshair 32 px (3 px / 1 px strokes).

| Tool / state | Cursor | Hotspot |
|---|---|---|
| Brush, Eraser | CSS `crosshair` + overlay size ring (black + white circles) | centre |
| Bucket | bucket icon | (19, 20) |
| Eyedropper (and Alt) | eyedropper icon; loupe while picking | (3, 21) |
| Shapes, region tool, transform outside the box | CSS `crosshair` (eyedropper icon with Alt held outside the box) | centre |
| Text | CSS `text`; `move` during Ctrl+drag | native |
| Move layer, Move drawing, transform inside the box | CSS `move` | native |
| Move inside a selection | move arrows + scissors (cut), + "+" with Alt (copy) | (11, 11) |
| Outline drag, Ctrl over a layer row | arrow + dotted-rectangle badge (+ mode mark on rows) | (2, 2) |
| Marquee, lasso, wand | `crosshair`; with a selection and Shift/Alt: 32 px crosshair + `+` / `-` / `x` badge | (11, 11) |
| Transform handles | native `ns/ew/nwse/nesw-resize` by on-screen direction | native |
| Transform rotate zone | circling arrows SVG | (16, 16) |

## 25. Remaining work

### M7b -- release polish (agreed 2026-09-30)

Order: 1 -> 2 -> 3 -> 4 -> 5 -> 6.

1. [x] **Spec rewrite** -- this file; old spec archived; mismatches ruled on and
   fixed (2026-09-30).
2. [ ] **Icons and cursors, Lucide style.** No npm dependency: Lucide SVG data is
   copied into the repo (ISC licence note). Our own icons (Move drawing, etc.)
   are redrawn on Lucide's grid and stroke; Merge Down uses Lucide's
   `layers-arrow-down` style. A mapping table is approved by the user first.
   - Every tool gets its own cursor; the OS cursor set must never show over the
     stage. Photoshop is the reference for which tools use a ring vs an icon.
     Hotspots stay exact.
   - Precise cross = the user's modified Lucide `locate`: centre dot, arms
     `M12 18v4 M12 2v4.5 M17.5 12H22 M2 12h4.5`, circle r = 7.
   - Brush = ring; Eraser = ring + an eraser icon bottom-right outside the ring.
     Text = Lucide `text-cursor`.
   - A cursor composer with badge slots: bottom-right = mode (selection
     `+ - x`, copy-move `copy-plus`); left = target (a mask glyph on cmask/lmask
     targets); not-allowed (`ban`) when the tool can't edit the target, computed
     before the click (the reason still only shows as a note on click).
     `square-dashed-plus` / `-x` (+ a custom `-minus`) are available for
     selection modes.
   - Every modifier that changes what a click does gets an indicator (incl.
     lmask thumbnail: Alt = eye in a square, Shift = red X).
   - Sizes and stroke width as CSS variables, chosen in the UI refresh; must read
     on any background.
3. [ ] **UI refresh** (discuss first). Procreate-like styling and spacing, not
   minimalism; keep following ComfyUI theme colours; floating menus and fly-outs
   allowed; a shorter long-press for fly-outs (both `LONG_PRESS_MS` constants);
   more room while keeping every feature reachable in-node. Includes the **help
   overlay**: `?` key and a `?` button, sections of useful shortcuts; a single
   source file for the shortcut list if a sensible display for all of them
   exists.
4. [ ] **Simple mode** (after the refresh). A per-node toggle saved in the
   document + a setting for the default; no shortcut. A `SIMPLE` / `ADVANCED`
   button in the node header area (a DOM element in the empty title strip, or a
   header draw path; the user has a reference node for the Vue header). Keeps:
   brush, eraser, bucket, eyedropper, Move layer, rectangular marquee; swatches
   and picker; undo/redo, zoom/pan, fullscreen; layers panel with paint layers +
   one cmask row (+ the Image/Input Mask row when present), no blend/opacity;
   brush options size / hardness / opacity. Hidden tools' shortcuts still work
   (their icon shows what got selected). Output options keep applying.
5. [ ] **README** (after the UI, with the user's screenshots; no install
   section): pitch, quick start, feature overview, I/O, condensed shortcuts,
   storage and cleanup, limitations, licence. Example workflow(s) = the node with
   its inputs attached. Use-case ideas for videos are brainstormed outside the
   repo from this spec.
6. [ ] **Manual checklist** (AGENTS.md "Testing") with Nodes 2.0 off and on, then
   release.

### Parked ideas

- Line / arrow shapes: start the Free Transform box rotated to the line.

- While soloed, a hidden layer could be editable (you can see it).
- Inverted selections bounded to the image area (today only the ants are).
- Pasting pixels onto an existing layer as a float; pasting into a cmask.
- Curve smoothing of pointer samples.
- Measure flow < 100 % and pressure -> opacity against Photoshop.
