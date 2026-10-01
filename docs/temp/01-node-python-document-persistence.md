# PainterSketch spec research: node contract, execution, saved files, persistence

Everything below was read from the code. No tests were run.

## A. Spec sections

### Node I/O

**Registration.** `__init__.py` exports `WEB_DIRECTORY = "./js"` and `comfy_entrypoint()`, and calls `register_routes()` at import. `NODE_CLASS_MAPPINGS` does not exist. `nodes/__init__.py` has `ALL_NODES = [PainterSketch, PainterSketchRegions]`. Both nodes are V3 (`io.ComfyNode`) with category `image`.
Why: `NODE_CLASS_MAPPINGS` (even `{}`) makes the loader take the V1 path, and `comfy_entrypoint` is never called.

**PainterSketch** (`node_id="PainterSketch"`, `has_intermediate_output=True`)

Input order is contract-stable. The frontend widget depends on the names.

| # | Name | Type | Default / limits | Notes |
|---|---|---|---|---|
| 1 | `image` | IMAGE, optional | – | Batch in, batch out. A 4th channel is dropped (`[:, :, :, :3]`). |
| 2 | `mask` | MASK, optional | – | The Input Mask row. Used only while `image` is also connected. |
| 3 | `layer_source` | IMAGE, optional | – | Feeds the editor's Images panel. It never affects the outputs. |
| 4 | `document` | STRING, `socketless=True`, `extra_dict={"widgetType":"PAINTERSKETCH"}` | `""` | Manifest JSON. It has no socket and the DOM widget replaces it. |
| 5 | `width` | INT | 1024, min 64, max 16384 (`FRAME_MAX`), step 8 | Used only when `image` is not linked. |
| 6 | `height` | INT | same as `width` | Same. |
| 7 | `background` | COLOR | `#ffffff` | Used in three places, listed below. |
| 8 | `invert_mask` | BOOLEAN | False | Inverts the MASK output. |

- `width` and `height` are `widget.hidden` while `image` is linked (`sizeWidgets.syncSizeWidgets`). They are rewritten to the loaded image's size, rounded to step 8 and clamped to 64..16384 (`writeSizeWidgets`). Disconnecting therefore keeps the frame.
- `background` is used when there is no `image`. It replaces the image when the Background eye is off, and it fills output regions that lie outside the image.
- Accepted `background` forms are `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, with or without `#`. Alpha is ignored. An unparseable value gives white plus a log warning.

Outputs:

| Name | Type | Shape |
|---|---|---|
| `IMAGE` | IMAGE | `[B,h,w,3]`, or 4 channels when Main's `alpha` option is on |
| `MASK` | MASK | `[B,h,w]` |
| `regions` | `PS_REGIONS` (`io.Custom`) | `PainterRegions` with 6 slots, each a `RegionOutput(image, mask)` or `None` |

- h and w equal the input image size (or `width` and `height` with no image), unless Main's Modify is Crop or Border.
- Sizes can differ per region.

**UI result** (`previews.ui_previews`)
- `images`: the first input frame (`base_rgb[:1]`), not the composite. Without an image it is the plain `background` colour, written as a temp PNG. The editor draws the paint itself, so a composited preview would lag one run behind.
- `layer_source`: present when the input is connected with at least 1 frame. It holds the first frame as a temp PNG item plus `source_id` (a 16-hex content id from shape and a strided ~128×128 sample).
- `input_mask`: present only when `mask` is used, meaning an image is also connected.
  - Normal case: one grayscale PNG item (the prepared coverage for image 0) plus `mask_id`.
  - LoadImage "no mask" placeholder: `[{"mask_id": "none", "empty": True}]` with no file.
- Preview files get random temp names each run. The editor identifies them by `source_id` and `mask_id`.

**Caching** (`fingerprint_inputs`, SHA-256 hex)
- Inputs hashed, in order:
  1. The `document` string.
  2. `invert_mask`.
  3. A fixed `IMAGE` marker if the key `image` is in kwargs (a linked input arrives as `None`, so "linked" means "present"). Otherwise `width` and `height`.
  4. `background`.
  5. A `MASK` marker if `mask` is linked.
  6. For each layer file, each layer-mask file, and the Image Mask file (the last only when `mask` is not linked): `(file name, st_size, st_mtime)`, or a `MISSING` marker plus the name.
- Not hashed: the `image`, `mask` and `layer_source` tensors (ComfyUI's tensor-identity caching handles those).
- A changed layer always has a new file name (content hash), so it changes the document string too. Stat is enough for same-name files.
- There is no `validate_inputs` and no `IS_CHANGED`.

**PainterSketch Regions** (`node_id="PainterSketchRegions"`, display "PainterSketch Regions")
- One required input `regions` (`PS_REGIONS`).
- Twelve fixed outputs, in order `IMAGE 1`, `MASK 1` … `IMAGE 6`, `MASK 6`. Display names are `image N` and `mask N`.
- Empty slot: both outputs are `ExecutionBlocker(None)`, per output, as positional values. Downstream branches silently don't run.
- A non-`PainterRegions` input blocks all 12.
- No fingerprint. Frontend labels are relabelled from the source document (`widget/regionsNode.ts`, region names, `region N` fallback). The 12 sockets never appear, disappear or disconnect.
- Why: `ExecutionBlocker` must be imported from `comfy_execution.graph_utils`. `comfy_execution.graph` imports ComfyUI's `nodes`, which clashes with our `nodes/` package.
- Why: `io.NodeOutput(block_execution=...)` treats `None` as "no block", so the blocker has to be a per-output value.

**Batches.** The same paint and cmask apply to every image (broadcast, no Python loop). The editor previews image 0. The Input Mask can be per image (see Python execution).

Files:
- `__init__.py` – entry, route registration
- `nodes/__init__.py` – `ALL_NODES`
- `nodes/painter_sketch.py` – schema, `execute`, `fingerprint_inputs`
- `nodes/painter_sketch_regions.py` – helper node, `PSRegions` type
- `nodes/previews.py` – ui keys
- `ui/src/widget/constants.ts` – shared names
- `ui/src/widget/sizeWidgets.ts` – hide and sync `width`/`height`
- `ui/src/widget/regionsNode.ts` – helper labels

### Python execution

**`execute`, in order**
1. **Base.** With an image, `base_rgb = image[..., :3]`. Otherwise it is a `[1,height,width,3]` fill of `background`. `B,H,W` come from it. `preview_frame = base_rgb[:1]`.
2. **Input Mask.** `use_mask = image is not None and mask is not None`. `coverage = prepare_input_mask(mask, (W,H), B)` (rules below).
3. **Parse.** `parse_document(document)`. If it returns `None` (empty, bad JSON, non-object, version ≠ 1, bad frame), the node runs a "no document" path:
   - IMAGE is `base_rgb` with no options applied.
   - MASK is zeros, or ones if `invert_mask`. With `use_mask` and a non-placeholder it is the Input Mask alone: `1 - cov` if `invert_mask`, else `cov`, and with no document the row's eye and invert are not read.
   - `regions` is `EMPTY_REGIONS`.
4. **Layers.** `load_layer_rgba(layer, doc.bounds)` for every layer gives `[bounds.h, bounds.w, 4]` straight-alpha float32, or `None`.
   - Text layers load as raster, like paint.
   - `apply_layer_masks` runs before any compositing, for paint layers with an enabled `layerMask` only.
   - The mask's alpha plane is `mask_plane`: placed unscaled at the top-left, and the area beyond the stored pixels takes the `outside` value (`reveal` = 0, `hide` = 1).
   - The layer's alpha is multiplied by `plane` if `invert`, else by `1 - plane`. RGB is unchanged. A `file: null` mask is an all-0 plane, so the layer is fully shown.
   - An unreadable mask file means the mask is ignored (the layer shows unmasked).
   - Layer masks never reach MASK.
5. **Image/Input Mask row** (`IMAGE_MASK_KEY` in `layer_tensors`):
   - `use_mask`:
     - `row_settings` supplies default settings (visible, not inverted) if the manifest has no `imageMask` record.
     - If `record.visible`, the key holds `coverage`.
     - The record's `file` is ignored.
   - Else, with an image and a visible `imageMask` record: `load_image_mask(record, (W,H))` returns the file's alpha, only if the file is exactly W×H. A stale size is skipped with one info log.
   - With no image, the row is never used (the widgets-fill is not an image).
6. **Composite.** `transparent = not doc.background_visible`.
   - **Eye on:** `run_composite(base_rgb, …)`. For each visible paint or text layer, bottom to top: `out = rgb * a + out * (1 - a)`, with `a = placed_alpha * layer.opacity`. Blend is Normal only; Python does not read `blendMode`.
   - **Eye off:** `run_transparent_composite(bg_rgb, …)`. The input image is ignored (it only supplies the batch size).
     - It composites premultiplied over a transparent base (`P`, `A`).
     - `IMAGE = P + bg * (1 - A)`.
     - `straight = P / A`, clamped to 0..1, with `bg` where `A = 0`.
7. **MASK** (`combine_mask_layers`):
   - For each visible mask layer: place its alpha through the frame map (0 outside the placed rect), apply its own `invert` (`1 - a`), then take the max union.
   - A visible Image/Input Mask row joins the union the same way. Coverage is placed at the image origin, 0 outside the image. Its `invert` is applied, then max.
   - Then `invert_mask`: with no mask layers and no row it gives all ones, otherwise `1 - combined`.
   - Mask `opacity` and `color` are display-only.
   - An empty mask layer with `invert` set gives all ones.
   - Result is `[H,W]`, or `[Bm,H,W]` with a batch Input Mask, then `expand(B)`.
   - Eye off: `MASK = max(that, 1 - A)`. The transparency joins after `invert_mask` and is never inverted.
8. **Outputs.**
   - `apply_output_options(out_image, out_mask, doc.main_output, straight)` for Main. Region slots come from `build_regions` on the same composite.
   - Main's options never affect regions.
   - `viewport_renderer` is built only for regions that reach outside the image.

**Output options** (`apply_output_options`; the same path serves Main and regions)
1. If `straight` exists (eye off) and (`alpha` or `fill`), the image becomes `straight`.
2. Modify:
   - `none`: pass through.
   - `fill`: `image*(1-mask) + color*mask`; MASK unchanged.
   - `crop`: bounding box of `mask > 0`, unioned over the batch, plus `cropPadding`, clamped to the output. An empty mask leaves the output uncropped.
   - `border`: pad every side by `borderSize`. IMAGE gets `borderColor`. MASK gets 1.0 if `borderMask`, else 0.0.
3. If `alpha` and the mode is not `fill`: IMAGE gets a 4th channel `1 - the returned mask`.

**Regions**
- `regions[]` has up to 6 entries, matched by `slot` 1..6. The first valid record wins an id or slot.
- Each edge is clamped to `[-W,2W]` and `[-H,2H]`, then rounded with `floor(v + 0.5)`, not Python's half-even `round`. The result is at least 1×1: `left ≤ 2W-1`, `right ≥ left+1`.
- Region rects are image px and are never rescaled.
- An edge-set fully inside the image is a slice of the main composite (and of `straight`).
- Otherwise the region is composited on its own canvas: `background` colour, then the input image where it overlaps, then paint and cmasks placed with `image_size=(W,H)` and `origin=(left,top)`. Overlapping pixels equal the main composite.
- With the eye off, the viewport composites transparent.
- Why: the rounding rule is half-up on both sides so editor and Python agree.

**Placement and frame map** (`composite._layout`; the editor mirrors it in `frameMap.ts`)
- `s = min(W/fw, H/fh)`; `ox = (W - fw*s)/2`; `oy = (H - fh*s)/2`.
- With `k = placement.scale`: `eff_s = s*k`; `eff_ox = ox + s*((fw/2)*(1-k) + placement.x)`; `eff_oy` likewise.
- `_place_layer` destination: `x = round(eff_ox + bounds.x*eff_s)` (Python half-even); size is `max(1, round(layer_w*eff_s))`, clipped to the canvas.
- If `eff_s ≠ 1`, or the destination offset is not an integer, the straight-alpha RGBA is resampled with bilinear `interpolate(align_corners=False)`.
- Stored pixels are never resampled by the document. Why: resampling on size change shrank and blurred paint on A→B→A flips.

**Input Mask tensor rules** (`input_mask.py`)
- `[H,W]` is one frame.
- A 64×64 all-zero mask is LoadImage's "no mask", so coverage is `None` and no row is used.
- A batch is per image only when `mask.shape[0] == B`. Otherwise mask 0 is used for every image.
- Resize to the image uses bilinear `interpolate` (ComfyUI's `resize_mask` convention). The result is clamped to 0..1 on CPU.

**Resizing and mismatch**
- A layer file whose size differs from `bounds` is warned about, then placed unscaled at the top-left, cropped or padded with transparency. This matches the editor.
- A missing, unsafe or unreadable file is a warning and an empty layer, never a failure. The checks are: the path must start with `painter-sketch/`, contain no `..`, exist via `folder_paths.exists_annotated_filepath`, and load via `node_helpers.pillow(Image.open)`. PIL detects the format from bytes, so WebP and PNG both work.
- Unreadable means `OSError`, `ValueError`, or `DecompressionBombError`.

**Cleanup route** (`POST /painter-sketch/cleanup`, registered via `PromptServer.instance.routes`; a no-op without a server and idempotent)
- Mode `{"mode":"stats"}` returns `{all:{count,bytes}, old:{count,bytes}}` with no scan. "old" means mtime older than 24 h.
- Mode `{"dryRun": bool, "referenced": string[]}` returns `{count, bytes, all, old, errors?}`. A real run adds `deleted: [names]`.
- Errors: 400 JSON `{error}` for bad bodies (non-JSON, non-object, `dryRun` not boolean, `referenced` invalid: max 100 000 entries, 4096 chars each, never truncated). 500 JSON `{error: "cleanup failed on the server: …"}` otherwise.
- Runs under an `asyncio.Lock` and `asyncio.to_thread`.
- A file is deletable only if all hold:
  - It sits directly in `input/painter-sketch/`, is a regular file, and is not a symlink.
  - Its name matches `CANDIDATE_RE = ^ps-[a-z0-9]+-[0-9a-f]+\.(png|webp)$` (case-sensitive).
  - Its mtime is older than 24 h.
  - Its name is in no `REFERENCE_RE` match.
- Reference sources:
  - Every `*.json` under `<user_dir>/<each user>/workflows/**` and `…/subgraphs/**`, skipped over 50 MB (reported in `errors`).
  - The client list, which is raw-text scanned and accepts bare names.
- A symlinked or junctioned `painter-sketch/` folder is refused (`errors`, count 0).
- Deletion re-checks lstat and age right before `unlink`.
- Why: references are found by raw text scan, so double-encoded manifest strings in workflows still match. The `REFERENCE_RE` regex is mirrored in `ui/src/cleanup/references.ts` (a test compares them).

Files:
- `nodes/painter_sketch.py` – execute flow, colours
- `nodes/composite.py` – layout, place, over, mask union, transparent composite
- `nodes/layers.py` – safe file resolve and load
- `nodes/layer_masks.py` – layer-mask parse and apply
- `nodes/input_mask.py` – `mask` input prep
- `nodes/output_processing.py` – Modify and Alpha, regions, viewport
- `nodes/document_regions.py` – region and output-option parse
- `nodes/cleanup.py` – pure cleanup logic
- `nodes/cleanup_route.py` – the route

### Document and saved files

**Manifest** (`PainterDocument`, `version: 1`; the widget value is `JSON.stringify` in stable key order, or `""` for an untouched document). `serialize.ts` order:

| Field | Type / default | Written when |
|---|---|---|
| `version` | `1` | always |
| `docId` | string matching `/^[a-z0-9]{4,64}$/i`; regenerated if invalid (`createId`, 12 chars) | always; Python ignores it |
| `frame` | `{width,height}` ints 1..16384 | always |
| `bounds` | `{x,y,width,height}`; `\|x\|,\|y\| ≤ 65536`; size 1..16384 | always |
| `regions` | `Region[]` | always (may be `[]`) |
| `mainOutput?` | `OutputOptions` | when set. An explicit record counts as content. |
| `backgroundVisible?` | `false` only | only when `false` |
| `imageMask?` | `{file, visible, color, opacity, invert, sourceKey, width, height}` | while the row exists |
| `placement?` | `{x,y,scale}` | only when non-identity |
| `activeLayerId` | string | always |
| `layers` | `Layer[]`, bottom to top, Background excluded | always |

`Layer`: `id`, `name`, `kind: "paint"|"text"|"mask"`, `visible`, `locked`, `opacity` (0..1), `blendMode: "normal"`, `file: string|null`, then optional `color`, `invert`, `textData` (text layers only), `layerMask` (only while the layer has one).

`Region`: `{id, slot 1..6, name, rect{x,y,width,height}, visible, output}`.
- `name` blank means `Region N`.
- `rect` is integer image px (edges rounded half-up), may extend outside the image, and is not clamped at load because the image size is unknown there.

`OutputOptions`: `{applyMask "none|fill|crop|border" (default none), fillColor "#rrggbb" (#000000), cropPadding int ≥ 0 (0), borderSize 1..4096 (64), borderColor "#rrggbb" (#ffffff), borderMask bool (true), alpha? (written only as true)}`.
- Colours are lowercased `#rrggbb` only (no alpha).
- `cropPadding` is floored and clamped to `[0, 2^53-1]`.
- `borderSize` is floored and clamped to 1..4096.
- Each bad field defaults on its own.
- Legacy region `{id, index, rect}` maps to `slot = index + 1`. A present but invalid `slot` never falls back to `index`.

`layerMask`: `{file: string|null, enabled: true, invert: false, outside: "reveal"|"hide"}`.
- Pixels use the ComfyUI polarity (white = hidden) in ALPHA.
- The file is sized like the layer (`bounds`).
- `file: null` means all shown.

**Frame, bounds and mapping**
- `frame` is the grid the paint was made on. A new document or an adopted empty document gets `minimumFrame(imageSize)`: scaled up so the short side is ≥ 1024, but the long side never exceeds 4096. It never shrinks.
- `bounds` is the paint area in frame coordinates. It starts as the frame rect and grows in 256 px chunks when strokes reach outside, capped at the frame plus its short side on every side and 16384 per axis (`engine/bounds.ts`). Existing larger bounds are kept.
- Layer file pixel `(px,py)` sits at frame coordinate `(bounds.x+px, bounds.y+py)`.
- Document to image: the frame map plus placement above (`documentMap(doc, imageSize)`).
- `placement` clamps: `scale` 0.05..10; non-finite `x`/`y` become 0; non-object becomes identity.
- Why: all editor conversions go through `documentMap`. Never rederive the formula.

**Versions and migration**
- Only version 1 exists. `migrate()` returns an error for any other value, and Python returns `None` (no migration chain yet).
- Additive fields (`regions`, `mainOutput`, `backgroundVisible`, `imageMask`, `placement`, `layerMask`, `alpha`, and so on) shipped without a version bump. Older manifests stay byte-identical.

**Validation and fallbacks.** This is *editor* behaviour (`parse.ts`, never throws, never toasts):

| Condition | Result |
|---|---|
| `null`, `undefined`, or blank string | `empty` |
| Not JSON, not an object, version ≠ 1, bad frame, bounds not containing the frame, bounds side > 16384, `layers` not an array | `invalid` (reason string) |
| Missing or malformed `bounds` | repaired to the frame rect |
| A layer entry that is not an object, has no id, or has an unknown kind | skipped (counted in `skippedLayers`) |
| Duplicate layer id | gets a fresh id |
| Invalid `file` | treated as null |
| `opacity` non-finite or non-number | 1; clamped 0..1 |
| `visible` non-boolean | true |
| `locked` non-boolean | false |
| Text layer without usable `textData` | loaded as paint |
| No paint layer | adds `Layer 1` |
| Mask layers | moved above the paint stack |
| `activeLayerId` unknown | first paint layer |
| `docId` invalid | regenerated |
| Bad region | skipped on its own |
| `imageMask` without a string `sourceKey` or valid size | dropped |
| `imageMask.visible` non-boolean | true |
| `imageMask.invert` not exactly `true` | false |
| `backgroundVisible` non-boolean | visible |

Python has the same rules except as noted in Mismatches. It never repairs bounds that don't contain the frame.

**Files**
- **Format.** Paint and text layers use setting `PainterSketch.PaintQuality` (slider 50..100, default 99).
  - Quality below 100: lossy WebP at `quality/100`. The bytes must pass the WebP sniff (`acceptWebp`), else PNG.
  - Quality of exactly 100: PNG.
  - Mask layers, layer masks and the Image Mask are always PNG.
- **Alpha and size.** Straight alpha, RGBA, exactly `bounds` sized (for layer masks, the layer's bounds). The Image Mask is exactly `width × height` in current-image px, with coverage in the alpha channel (coverage = 255 − image alpha). A fully transparent canvas stores no file (`file: null`).
- **Name.** `painter-sketch/ps-<docId8>-<hash14>.<webp|png>`. `docId8` is the first 8 alphanumerics of `docId`. `hash14` is a 14-hex cyrb53 hash of the encoded bytes (not crypto).
- **Stored form.** The manifest holds `"painter-sketch/<name> [input]"`, as reported by the server's upload response (`subfolder/name [type]`).
- **Upload.** `POST /upload/image`, form fields `image`, `type=input`, `subfolder=painter-sketch`, `overwrite=true`.
- **Dedup.** The request is skipped if the same name equals the layer's current file or is in the session's `knownFiles`.
- **Format change.** The paint-quality setting is read once per flush, so a change affects future uploads only.
- **Reading.** Python reads any PIL format, and the editor reads anything the browser decodes. `layers.py` only enforces the `painter-sketch/` prefix and no `..`.
- **Manifest size.** The manifest holds file references only (~250 B per layer). Never inline pixel data.

Files:
- `ui/src/document/types.ts`
- `ui/src/document/create.ts`
- `ui/src/document/parse.ts` – strict structure, lenient optionals
- `ui/src/document/serialize.ts`
- `ui/src/document/outputOptions.ts`, `regions.ts`, `placement.ts`, `layerMask.ts`, `imageMask.ts`, `content.ts`
- `ui/src/engine/frameMap.ts` – the map
- `ui/src/engine/bounds.ts` – growth and cap
- `ui/src/widget/layerEncode.ts`, `contentHash.ts`, `paintQuality.ts` – encode, name, quality
- `nodes/document.py`, `document_regions.py`, `layer_masks.py` – Python mirror of the parse rules

### Persistence and sync

**Value model.** The widget value is `""` while untouched. A document counts as touched (`hasDocumentContent`) when it has any of:
- unsaved paint
- a layer with a `file`
- `regions`
- `mainOutput`
- `backgroundVisible === false`
- an `imageMask` record

Otherwise the value is `""`. An unreadable incoming value is kept as `unreadableValue` and returned until the user paints, so saving the workflow never drops it.

**Upload timing** (the owner is `controller.ts`; the uploader is `persistence.LayerUploader`)
- Idle fallback: 5 s after the last edit, debounced (`IDLE_UPLOAD_DELAY_MS`).
- Editor disengages (`onDisengage`), fullscreen exit, session detach (`releaseOrDetach` → `flushQuietly`).
- Queue: `widget.serializeValue` calls `flushForQueue`. It waits for the session to be ready, waits for any in-flight Image Mask read, settles floats, flushes the uploader, then emits a "hidden mask" note if a hidden mask has content. It returns the manifest and **throws on upload failure**, so queueing stops.
- Ctrl/Cmd+S in the editor (not Shift, not Alt): `WorkflowSaver` flushes, then runs `Comfy.SaveWorkflow`. Failure asks a confirm.
- Page: F5, Ctrl/Cmd+R, Ctrl/Cmd+Shift+R are intercepted only when uploads are pending. It flushes (3 s cap), then reloads, with a confirm on failure or timeout. Tab hidden and window blur do a fire-and-forget flush. No `beforeunload` prompt of our own.
- Dirty tracking: per-layer `version` with `dirty` (cleared only if the version is unchanged after upload). The Image Mask has its own dirty flag. Layer-mask uploads (`editor.layerMask.uploads()`) run in each flush.
- A file reference is updated only after a successful upload, so the manifest never points at a missing file.
- Failure handling: pixels stay in memory and dirty. One error toast per failure streak per document, with a 60 s window across documents. Automatic retry with backoff 15 s, 30 s, 60 s, up to 120 s. The first success after a toast gives "Paint layers saved again."
- Why: `serializeValue` runs only when building the API prompt, not on workflow save, tab switch or export. So the value is kept current after every edit, and uploads run on a debounce.

**Restore.** `restoreLayers` loads every layer file and layer-mask file in parallel with `fetch` of `/view?...` (no cache-bust), and decodes via an object URL.
- Painting is disabled during the load.
- A layer whose file fails to load stays empty with its `file` reference intact and is not dirty.
- A text layer re-renders from `textData` and is re-uploaded.
- A loaded size ≠ `bounds` is flagged `stale`, except for text layers.
- All problems of a document produce one toast.
- `restoreImageMask` restores the row's file. A failure there is log-only, and the alpha is read again from the source.
- Loads for a released session are dropped.

**Sessions** (module-level, keyed by `docId`)
- Sessions outlive node instances, so tab switches keep strokes and undo history.
- Removal only detaches. Untouched sessions (no content, not dirty) are released. Others are flushed and kept.
- Detached sessions are LRU-capped at 6 (`MAX_DETACHED_SESSIONS`).
- `sessionMatches` accepts a manifest only if it is the session's own recent state. Its signature is `[frame, layer ids+files (+ layerMask), outputMetadataSignature, imageMask.file]`, matched against the last 4 signatures, and output metadata must be equal.
- The attach decision (`attachDecision.ts`), by owner of the live session:
  - none or self, handed off or recently matching: reuse.
  - none or self, otherwise: restore from the manifest (new session). The user is warned if that discards dirty pixels.
  - another live owner (copy/paste), matching: fork-copy under a new `docId`.
  - another live owner, not matching: fork-restore under a new `docId`.
- Empty or unreadable values: `invalid` resets to a fresh session. `empty` adopts a handed-off session, else resets if the current one has paint, else keeps.

**Graph-undo handoff** (`handoff.ts`)
- `onRemoved` offers `{element, session, background, lastExecuted}`, keyed by graph (root or subgraph id) + node id. `onAdded` takes the offer. It expires in a microtask, so tab switches never match.
- A handed-off session is always kept: graph undo never rolls back paint.
- No ChangeTracker capture is made after a handoff (it would clear redo).
- Why: Nodes 2.0 reuses the old Vue widget component and never re-inserts `widget.element`, so the new instance swaps its element into the old slot.

**Drafts** (`graphSync.ts`)
- ComfyUI writes drafts only on `graphChanged`, which fires only when `captureCanvasState()` sees a change.
- After a value change we request a coalesced capture on `app.extensionManager.workflow.activeWorkflow.changeTracker`:
  - 1000 ms after edits (`EDIT_SYNC_DELAY_MS`).
  - 0 ms after an upload batch settles.
  - Falls back to `checkState` on older frontends.
- Only nodes in the active root graph are captured.
- Pending captures are flushed on blur, tab hidden, `beforeunload`, and the reload keys.
- A capture throw is logged once (`[PainterSketch] workflow draft update failed…`) and is not a toast.
- Why: draft writes would otherwise lag behind async uploads, and `graph.change()` only repaints.

**Background and input sources**
- Resolution order:
  1. The upstream node's own image: `LoadImage`, `LoadImageOutput` and `LoadImageMask` widget values, then `app.nodePreviewImages`, then `app.nodeOutputs`, then `node.imgs`.
  2. Our own executed `images` preview, only if produced with the same upstream node+slot link (`backgroundRule.ts`).
- Background `/view` URLs get `channel=rgb`.
- Image Mask alpha reads use `channel=a` with `preview` dropped.
- `layer_source` history (session-only, 10 entries) uses the same lookup applied to the `layer_source` slot, falling back to our own `layer_source` ui preview.
- The Input Mask row (while `mask` is linked) takes pixels from:
  1. Our `input_mask` preview, if made with the current link and live source.
  2. A live `channel=a` read of a MASK output of a node that shows a `/view` file (`LoadImageMask` only with `channel` = alpha).
  3. Otherwise it waits (hint "Run the workflow to load this mask"). It never uploads and its `file` is `null`.

**Cleanup button** (`PainterSketch.Cleanup`, `ui/src/cleanup/`)
- Flow: fetch stats when the row renders ("Loading file counts…" then "Files: N (X) · Older than 24 h: N (X)"). On click: collect client references, dry run, confirm, real run (references re-collected), toast, refresh stats.
- Client references (`sources.ts`): `openWorkflows` (`content`, `originalContent`, and the change tracker's `activeState`, `initialState`, `undoQueue`, `redoQueue`), `app.graph.serialize()`, and every value in `localStorage` and `sessionStorage`. All are regex-scanned as text.

Files:
- `ui/src/widget/persistence.ts` – encode, upload, retry, restore
- `ui/src/widget/uploadScheduler.ts` – idle, queue flush, Ctrl+S saver
- `ui/src/widget/pageGuards.ts` – reload keys, blur flush
- `ui/src/ui/reloadGuard.ts` – reload-key logic and confirm text
- `ui/src/widget/sessions.ts`, `sessionAttach.ts`, `attachDecision.ts`, `handoff.ts` – sessions and handoff
- `ui/src/widget/graphSync.ts`, `graphSyncCore.ts` – ChangeTracker capture
- `ui/src/widget/controller.ts` – value sync, orchestration
- `ui/src/widget/failures.ts`, `toast.ts`, `toastLimiter.ts` – messages, dedup
- `ui/src/widget/backgroundLoader.ts`, `backgroundRule.ts`, `imageSource.ts`, `viewUrl.ts` – input lookup
- `ui/src/widget/imageMaskSync.ts`, `inputMaskSync.ts`, `inputMaskRule.ts` – the row
- `ui/src/cleanup/` – button and client references

## B. Messages

Toast title is always "PainterSketch" (`summary`). Error toasts last 10 s, others 6 s. Default dedup window is 10 s per key. The console logs every occurrence.

| Trigger | Severity | Text (verbatim) |
|---|---|---|
| Upload batch fails (key `upload-failed`, 60 s) | error | `Could not save paint layers: {reason}. Your paint is kept in the editor and retried automatically; don't reload the page until it is saved.` |
| – reason: `offline` | – | `the ComfyUI server is unreachable` |
| – reason: `tooLarge` (413) | – | `the server rejected the file as too large (HTTP 413)` |
| – reason: `missing` or `rejected` (404, 405, other 4xx) | – | `the server rejected the upload ({error text})` |
| – reason: `server` (5xx) | – | `the server reported an error (HTTP {status}); check the ComfyUI console (disk full?)` |
| – reason: `encode` | – | `the browser could not encode layer "{name}" (out of memory? try a smaller canvas)` |
| – reason: other | – | the raw error text |
| First success after a toasted failure (key `upload-recovered`, 60 s) | info | `Paint layers saved again.` |
| Incoming value fails `parseDocument` (key `invalid-document:{reason}`) | warn | `Could not read the saved painting ({reason}); showing an empty canvas.{ " It was probably saved by a newer PainterSketch; update the node."}` ` The saved data is kept in the workflow unless you paint on this node.` |
| Valid manifest had skipped layer entries (key `skipped-layers`) | warn | `The saved painting has 1 layer entry that could not be read; loaded the rest (details in the console).` (or `N layer entries`) |
| Restore problems, one message per document (key `restore:{docId}:{msg}`) | error if any transient (offline or server), else warn | Parts, space-joined (names list up to 3, then `+N more`): `{N layer(s)} could not be loaded (the ComfyUI server is unreachable \| server error, see the console): {"A", "B"}. Reload the workflow to retry before painting on them.` / `{N layer(s)} lost its\|their file (deleted from input/painter-sketch?): …; loaded empty.` / `{N layer(s)} could not be decoded (corrupt file?): …; loaded empty.` / `Their saved file references are kept until you edit those layers.` / `{N layer(s)} was\|were saved at an older canvas size (latest edits probably never uploaded): …; check their position.` |
| Manifest replaces a live session that held unsaved strokes (restore choice) | warn | `Loaded the painting as saved in this workflow; newer unsaved strokes from the previous copy of this node were discarded.` |
| Ctrl+S: flush failed | confirm (not a toast) | `Upload failed; save anyway without the latest paint?` |
| Ctrl+S: save command threw | error | `Could not save the workflow: {message}` |
| Reload key: flush timed out | confirm | `PainterSketch is still uploading paint (slow or unreachable server). Reload anyway and lose the unsaved paint?` |
| Reload key: flush failed | confirm | `PainterSketch could not upload some paint. Reload anyway and lose the unsaved paint?` |
| Queue with a hidden mask that has content | editor note (event `note`), not a toast | `The mask is hidden.` |
| Input Mask row waiting for a run | row hint | `Run the workflow to load this mask` |
| Cleanup: no old files | info | `Nothing to clean up (no files older than 24 h)` |
| Cleanup: old files all in use | info | `Nothing to clean up (the {N file(s)} files older than 24 h are all in use)` |
| Cleanup: dry-run confirm | confirm | `{count} of the {N file(s)} older than 24 h ({size}) are unused and will be deleted. This affects all workflows.` plus, if workflows could not be scanned: `\n\nWarning: {N file(s)} in the workflows folders could not be scanned (too large or unreadable); layer files used only there would be deleted.` |
| Cleanup: success | info | `Deleted {N file(s)} ({size}).` |
| Cleanup: success with server errors | warn | `{summary} {k} problem(s), see server log. First: {errors[0]}` |
| Cleanup: request fails | warn | `File cleanup failed: {reason}.` Reasons: `the ComfyUI server is unreachable`, `the cleanup route is not available; the PainterSketch Python node probably failed to load (check the ComfyUI console) or ComfyUI needs a restart after an update`, `server error (HTTP {n}): {msg or "see the ComfyUI console"}`, or the server's `error`. |
| Cleanup stats fail | inline text in the setting row | `Could not load file counts: {reason}.` |
| Settings button states | – | `Clean up files`, `Cleaning up…` |

Console-only (no toast): background load failures, draft-capture failure, Image Mask read failures, `Image Mask file does not match its size; reading the image again`, and all Python log warnings. The Python log lines come from `layers.py`, `document.py` and `composite.py`: unsafe path, file not found, unreadable file, wrong-size layer file, invalid manifest or frame, malformed region or `imageMask`.

Not in my area, so not listed: resolution-mismatch, clear, rasterize and drag-block texts in `ui/` and `engine/`.

## C. Mismatches

| Old spec says | Code does | file:line | My read |
|---|---|---|---|
| Placement `scale` clamped to [0.05, **20**] (Saved-file contract) | Clamp is [0.05, **10**] in Python and the editor | `SPEC.md:183`; `document.py:55-58`; `placement.ts:11-15` | The spec is stale (the 2026-09-27 decision log changed 20 to 10). Use 10. |
| Node Contract table lists only `image`, `width/height/background`, `invert_mask`, `document` in, and `IMAGE`/`MASK` out | The node also has `mask`, `layer_source` inputs and a `regions` (`PS_REGIONS`) output. `document` order in the schema is 4th, after the optional image inputs | `SPEC.md:24-31`; `painter_sketch.py:133-189` | The spec is stale. The table in this report is current. |
| "Returns `ui=UI.PreviewImage(image[0])`" | Returns `images` (first input frame, or the plain `background` colour with no image) plus optional `layer_source` and `input_mask` keys | `SPEC.md:37`; `previews.py:44-79` | The spec is incomplete. |
| `fingerprint_inputs` "hashes saved files + `invert_mask`" | Also hashes the document string, `background`, `width`/`height` only while `image` is unlinked, and `IMAGE`/`MASK` markers; includes layer-mask and Image Mask files | `SPEC.md:35`; `painter_sketch.py:337-374` | The spec is incomplete. |
| Document Model omits `backgroundVisible`, `imageMask`, `layerMask`, `alpha`, `borderSize` etc. as required fields; `OutputOptions` shows border fields as optional | All are real manifest fields (additive). `OutputOptions` is always serialized with the full border fields | `SPEC.md:100-137`; `serialize.ts:20-37`; `outputOptions.ts:87-97` | The spec is stale. |
| Unknown version or unreadable manifest: "output the image unchanged and a **zero** mask" | Output is a zero mask only if `invert_mask` is off. With `invert_mask` it is all ones. With `mask` connected it is the Input Mask alone (with `invert_mask` applied) | `SPEC.md:198-200`; `painter_sketch.py:246-252`; `input_mask.py:117-129` | Intended extension. The spec should say it honours `invert_mask` and the Input Mask. |
| Python has no `validate_inputs`; AGENTS.md lists `validate_inputs` among the V3 classmethods | The node defines none | `AGENTS.md` Code Style; `painter_sketch.py` | Not a bug. Spec should state "no validation, everything degrades gracefully". |
| `background` tooltip: "when no image is connected; also fills output regions outside the image" | `background` is also the colour that replaces the input image when the Background eye is off | `painter_sketch.py:172-175`; `painter_sketch.py:271-281` | The tooltip is stale. Update it. |
| "bounds always contains the frame" (data model) | The editor rejects a manifest whose bounds don't contain the frame (`invalid`, empty canvas + toast). Python accepts any positive bounds and falls back to frame-sized only when bounds are missing or malformed | `parse.ts:93-97`; `document.py:349-357` | Unclear divergence on an edge-case manifest. Python would composite what the editor refuses to load. Decide which side wins. |
| `layers` must be an array | The editor returns `invalid` if `layers` isn't an array. Python treats it as an empty list and still runs | `parse.ts:103`; `document.py:359-362` | Minor divergence, likely harmless. Align or document. |
| Cleanup is `POST /painter-sketch/cleanup` with body `{dryRun, referenced}` | The route also accepts `{"mode":"stats"}` (read-only counts) | `SPEC.md:320-321`; `cleanup_route.py:75-77` | Same single route; the spec is incomplete. |
| Cleanup confirm: "N files (X MB) in `input/painter-sketch/` are not used by any saved workflow … Delete them? …" | Text is `{count} of the {oldCount} files older than 24 h ({size}) are unused and will be deleted. This affects all workflows.` | `SPEC.md:306-309`; `references.ts:138-149` | The spec text is stale. Use the code's text. |
| `ps-<docId8>-<hash>` file names; cleanup only deletes names matching the pattern | `layerFileName` keeps the docId case (`replace(/[^a-z0-9]/gi, "")`) and the editor accepts mixed-case docIds, but `CANDIDATE_RE` is case-sensitive lowercase, so such files are never cleaned | `contentHash.ts:43`; `parse.ts:127`; `cleanup.py:38` | Latent bug, low risk (generated ids are lowercase). Lowercase the prefix or make the regex case-insensitive. |
| "Unchanged content maps to the same name and is not re-uploaded" | Upload is skipped for any name in `knownFiles`, even if the file was deleted since (cleanup removes unreferenced files older than 24 h, and paint-undo can revisit an old state) | `persistence.ts:253`; `cleanup.py` | Possible bug in very long sessions. A manifest after undo could reference a deleted file. Consider a stale check or refreshing mtime. |
| AGENTS.md: "Treat widget values that name files as untrusted: resolve through `get_annotated_filepath()` and verify" | Execution enforces the `painter-sketch/` prefix and no `..`. `fingerprint_inputs` stats any annotated path without the prefix check | `layers.py:70-87`; `painter_sketch.py:363-367` | Low-severity inconsistency (a hostile workflow could stat arbitrary files for caching only). Reuse `_is_safe_name` in the fingerprint. |
| `layers.py` docstring says layers "can never reference arbitrary input files" | The prefix check applies to the bare path. An `[output]` or `[temp]` annotation still resolves in that folder under `painter-sketch/` | `layers.py:35-38`, `67` | Unclear, low risk. Doc wording is stronger than the guard. |
| Maintained helper `frame_size()` kept for "M0 callers" | Only used in tests | `document.py:386-399`; `tests/test_document.py:233` | Dead code in production. Candidate to delete. |
| Old spec "Document Model" `Layer` shows `blendMode: 'normal'` as a manifest field Python honours | Python never reads `blendMode` (hardcoded Normal). The editor always writes and reads `"normal"` | `document.py` (no field); `parse.ts:233` | Intended. The spec should say it is reserved and ignored. |
| SPEC "Known" (2026-09-28 log): a new image size from our executed preview re-runs the node once because widget values are in the cache key | Consistent: `width`/`height` are rewritten to every loaded image size while `fingerprint_inputs` ignores them only when `image` is linked | `frameSync.ts:122-130`; `painter_sketch.py:340-344` | Matches; still a known limitation. |