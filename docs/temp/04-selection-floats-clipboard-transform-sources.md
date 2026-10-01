# Research report: selection, floats, clipboard, Free Transform, moving, image sources

All of this is read from the code. Line numbers are as of today. I did not run anything.

---

## A. Spec sections

### Selection

**Model**
- A selection is a coverage buffer (0–255) in document coordinates. It follows the drawing, not the image, so it survives placement and frame-map changes.
- Storage is cropped: `{rect, data, outside: 0|255}`. Every pixel outside `rect` has the value `outside`. Invert flips `outside`, so an inverted selection keeps covering any paint area the bounds grow into later.
- Results are always trimmed. A result that selects nothing becomes `null`, so Photoshop's "empty result deselects" applies.
- Selections are immutable. Moves share the byte array and offset the rect (`floatMath.offsetSelection`).
- The selection is session state and is never saved.
- Every selection change is one `selection` history entry holding before and after. Ctrl+Z after a wrong marquee restores the previous selection.
- `SelectionOps.apply` clips new coverage to `limit` = bounds cap ∪ current bounds, then combines.

**Combine modes** (`selection.ts` OPS table)

| Mode | Rule |
|---|---|
| replace | the new coverage |
| add | `max(a, b)` |
| subtract | `min(a, 255 − b)` |
| intersect | `min(a, b)` |

- `outside` combines the same way and is thresholded at 128.
- Replace with an empty result deselects.
- With no current selection, only add survives.

**Modifiers** (`selectionModifiers.ts`)
- Mode is fixed at pointer-down, and only when a selection exists: Shift = add, Alt = subtract, Shift+Alt = intersect.
- With no selection the mode is always replace, and held keys act at once as constraints: Shift = square/circle, Alt = from centre (for the lasso, straight segments).
- A key consumed as a mode key only starts constraining after it is released and pressed again.
- Alt is never the temporary eyedropper in selection tools.

**Tools**
- **Rectangular marquee**: hard edge. Box edges are rounded to whole pixels; a pixel is selected if its centre is inside.
- **Elliptical marquee**: anti-aliased. `selectionRaster` uses 16 sub-rows with exact horizontal coverage.
- **Lasso**: anti-aliased, non-zero winding.
  - Freehand samples are decimated to about 1 image px.
  - Alt is straight segments. Releasing the button with Alt held keeps the path open (`pending`).
  - Each click while pending adds a vertex.
  - It closes on: releasing Alt with the button up, a double-click (≤400 ms and within the click slop), or a click within 2× slop of the start (needs more than 2 points).
  - Esc cancels.
  - Releasing the button with Alt up closes it.
- **Magic wand**: the bucket's flood fill, sampling and options, turned into a selection.
  - Options: tolerance 32, contiguous, anti-alias, Sample (default `background`, setting `PainterSketch.WandSample`).
  - A hidden target refuses with a note and keeps the selection.
  - No match in replace mode deselects.
- A press without a drag (past a 3 CSS px click slop) deselects, in replace mode only. This applies to the marquees and the lasso.

**Select all / deselect / invert**
- **Select all (Ctrl+A)**: the current image rect, converted to document coordinates through `documentMap` (so it includes Move-drawing placement and ignores frame size). Bounds grow first to cover it, like the bucket does. With no image connected, the area is the width × height fill.
- **Deselect (Ctrl+D)**.
- **Invert (Ctrl+Shift+I, Shift+F7, or the bar button)**: no selection stays no selection.
- **Not implemented**: Reselect (Ctrl+Shift+D), feather, grow/shrink/refine edge, Esc-to-deselect. Softness only comes from the AA tools and from the soft lmask Ctrl+click.
- **Marching ants** (`marchingAnts.ts`):
  - Boundary at coverage ≥ 128, built as closed contours with corners only (`selectionOutline.ts`).
  - Contours are computed once per selection change.
  - Drawn as a 1 px white solid line plus a black dashed line (4 CSS px dashes, about 8 fps).
  - Saddles turn towards the selected side.
- **Inverted selection outline**: the scan domain is `rect ∪ image area`, so ants also run along the image-area edge (document coordinates, so placement applies). Coverage itself is not bounded by the image. An inverted selection still covers the whole paint area.
  - Why: ants must follow the image boundary, not `doc.frame`.
- While transforming, the ants are hidden during a drag and reappear at the resampled coverage.

**Selection clip for painting**
- Brush, eraser, line and shapes: clipped through the stroke buffer (`selection.clipCanvas`, `destination-in`).
- Bucket: clipped through the `clip` coverage seam.
- Stroke bounds growth is limited to the selection bbox. An inverted selection means no limit.
- A stroke that changes no pixel is no undo step.
- Selection-clipped painting on an lmask works the same way.

**Selection commands** (one undo patch each; `selectionOps.ts`)

| Command | What it does |
|---|---|
| Delete / Backspace | Clear the selection. Paint: alpha × (1 − c). cmask: remove coverage. lmask: reveal (clears the white). |
| Alt+Backspace / Ctrl+Backspace | Fill with FG / BG. cmask: adds white coverage, colour ignored, so FG and BG are identical. lmask: paints white (hide), swatches ignored. |
| To mask | Adds the selection coverage (soft kept) to the current cmask (the last selected Mask N). Creates a mask if none exists. Works whatever the target is and does not change the target. |

- Delete, Alt+Backspace and Ctrl+Backspace all need a selection and note "Nothing is selected." without one (see the Delete exception below).
- All of them go through `preparePixelEdit`. That means the lock/hidden notes, the text rasterize confirm, and settling any float first (Delete while floating commits the float, then clears).
- Bounds grow (capped) to cover a normal selection. An inverted selection covers the whole bounds.

**Selection from a row (Ctrl+click)**
- Plain Ctrl = replace, +Shift add, +Alt subtract, +Shift+Alt intersect.
- The hover cursor shows the mode (see section C).
- **Paint, text and cmask rows** (`fromLayer`):
  - **Hard**: every pixel with alpha > 0 becomes 255 (`hardenSelection`).
  - A cmask uses its effective coverage, with its per-mask Invert applied.
  - It works on hidden layers.
  - It does not change the current layer, Quick Mask or solo.
  - It settles a float first.
  - An empty layer notes and leaves the selection unchanged.
  - An lmask is ignored (the layer's own pixels are used).
  - Why hard: a soft selection left an a·(1−a) residue on every edge when moved, and ghosted on repeat.
- **Image Mask / Input Mask row**: hard, with invert applied, resampled into document coordinates, clipped to the cap.
- **lmask thumbnail** (`layerMask.toSelection`):
  - **Soft**: the shown part, `255 − value`, with Invert applied and the `outside` value beyond bounds.
  - It is the inverse of a cmask's Ctrl+click, so selection → add lmask → Ctrl+click round-trips.
  - An lmask that shows nothing gives the note "The layer mask shows nothing."
- The Background row cannot load a selection (it is not in `ROW_SELECTOR`).

**Outline-only moves and selection following**
- Marquee, lasso or wand, plain press (no Shift, Alt or Ctrl) inside the selection (coverage ≥ 128): `OutlineDragTool` drags only the outline, by whole document px.
  - It records one `selection` entry per drag.
  - Esc restores the outline.
  - A press that never leaves the click slop is replayed to the tool as a click (marquee and lasso deselect, the wand selects there).
  - With a float alive, this commits the float first.
- A whole-layer move (Move layer outside the selection, or arrow nudges) carries the selection by the same delta, folded into the move's undo step (group `[move, selection]`). Consecutive nudges still merge.
- Auto-select is off while a selection exists.

**Options bar**
- **To mask** and **Invert** appear in the bar's leading area while a selection exists, for any tool.
- **Transform, Flip H, Flip V** are appended to the Move layer bar always, and to the marquee, lasso and wand bars while a selection exists.

**Files:** `engine/selection.ts`, `selectionOps.ts`, `selectionState.ts`, `selectionRaster.ts`, `selectionOutline.ts`, `selectionFollow.ts`; `tools/marquee.ts`, `lasso.ts`, `magicWand.ts`, `outlineDrag.ts`, `selectionModifiers.ts`; `ui/selectionShortcuts.ts`, `selectionActions.ts`, `marchingAnts.ts`, `layerRow.ts`, `layerMaskThumb.ts`.

---

### Floating selections

**What a float is**
- Transient editor state, never a document layer and never saved.
- Drawn above its own layer inside that layer's display, so it follows the layer's opacity, visibility and cmask tint.
- Moves are whole document px and nothing is resampled until a transform.
- The outline moves with it.
- Bounds grow while it moves, so what you see is what lands. Anything past the paint-area cap is cropped on commit.

**How a float starts**
- **Move layer (V)**: a press inside a selection (coverage ≥ 128) lifts the selected pixels. Alt at pointer-down lifts a copy (no hole).
  - Pressing outside moves the whole layer, and the selection follows.
  - While a float exists, any drag anywhere and any arrow nudge moves the float.
- **Any rail tool with Ctrl** (Ctrl is the temporary Move layer): Ctrl+drag inside the selection lifts, and Ctrl+Alt+drag lifts a copy. Alt is read at pointer-down.
  - This is not marquee-only. It applies to every rail tool except Text, Move layer itself, Move drawing and the region tool.
  - Why: Ctrl resolves before Alt and before the active tool.
- **Free Transform with a selection** also lifts, but always as a cut (see Free Transform).
- Decided at pointer-down, before anything moves (`float.check()`):
  - A refused lift never falls through into a layer move.
  - `blocked` shows a note.
  - `confirm` (a text layer) defers the rasterize confirm until the press has ended. The user must drag again afterwards.

**What a lift takes, per target**
- Pixels are coverage-weighted: float alpha = a·c, remainder alpha = a·(1−c).
- The lift area is the whole selection rect, including transparent parts.
- **Paint or text layer, pixels targeted**: lifts the pixels. The layer's lmask stays put.
- **lmask targeted**: lifts the lmask's own pixels as grayscale.
  - The coverage clears what it covers on landing, and the value replaces what it lands on.
  - The vacated area reveals.
- **cmask under Quick Mask**: lifts like paint. A mask has a value everywhere, so any selected part lifts.
- **Whole-layer lift** (Free Transform without a selection): always carries the layer's lmask.
- A text layer asks the rasterize prompt first.

**Commit, cancel, undo**
- **Commit** lands the float: one patch over source ∪ destination, joined with the selection move into one group undo step. Triggers: Enter, and `settleFloat` from any other edit, deselect or selection change, tool switch, layer or target change, solo, queue or serialize.
- **No-move commit**: a float left at its lift position commits as a cancel, with no step.
- **Cancel (Esc or Ctrl+Z)** writes the pre-lift pixels and the selection back with no history. Ctrl+Y is ignored while floating.
- **Arrows**: nudge 1 image px (at least 1 document px), Shift = 10.
- **Saving while floating** saves the pre-lift pixels (`savedLayerCanvas`), so a float is never half-saved.
- **Esc precedence**: Esc is consumed first by an open Images panel, then handled as the float cancel.

**Gate**: hidden, solo-hidden, locked, Image Mask and lmask-only-view rules come from `editBlockNote`. Empty selection content gives "No pixels are selected.".

**Files:** `engine/floatOps.ts`, `floatLift.ts`, `floatCommit.ts`, `floatMath.ts`, `layerMaskCarry.ts`, `rasterize.ts`; `tools/moveLayer.ts`, `registry.ts`; `ui/floatShortcuts.ts`.

---

### Clipboard and drop

**Copy and cut**
- **Ctrl+C**: the current edit layer's selected pixels, with coverage-weighted alpha. Without a selection it copies the whole layer content. The result is trimmed to the non-transparent bbox.
- **Ctrl+Shift+C** (copy merged): what is visible, including the image, within the selection or the image area.
  - It excludes the background when its eye is off.
  - Under Quick Mask it is the union of the visible cmasks' effective coverage as grayscale.
- **cmask copy**: opaque grayscale, white = masked, and it keeps the selection shape.
- **Layer with an enabled lmask**: copy takes the masked result. With the lmask targeted, copy and cut act on the lmask as grayscale, and cut reveals.
- **Cut**: copy plus clear in one patch. A text layer is rasterized first, in the same step. Cut without a selection cuts the whole layer.
- **Copy refusals**: hidden and solo-hidden layers refuse with a note. Locked layers can be copied.
- **Settling**: every command settles a float first.
- **Rail buttons**: Copy (not merged), Cut and Paste sit at the bottom of the rail, above Undo/Redo, with the Images button after them.

**Where copies go**
- The internal clipboard is module-level, shared by every PainterSketch node on the page. It holds pixels, document rect, image scale, a 16×16 fingerprint and an editor reference.
- A PNG is also written to the system clipboard (the blob is a promise, so the user gesture counts). Failure only logs to the console and leaves the copy internal-only.

**Paste source order**
- **Ctrl+V** and Paste button "System": a system image (unless it is our own PNG, fingerprint mean diff ≤ 4, in which case the internal copy is used) → internal copy → clipspace → note.
- **Ctrl+Shift+V** (paste in place): the internal copy at its copied document position, handled on keydown. The system clipboard is ignored. Without an internal copy it behaves like Ctrl+V, and Chrome's plain-text paste falls back to `clipboard.read()`.
- **Paste button "Clipspace"**: the ComfyUI clipspace image only (`app.constructor.clipspace`, narrowed at runtime).
- **Paste button**: long-press 400 ms or right-click opens a System / Clipspace menu. The choice runs and sticks per button instance.
- **Ctrl+V mechanics**: the keydown is stopped but not prevented, so the browser fires `paste`. A one-shot capture `paste` listener on `window` is armed for 1000 ms. The listener stops the event from reaching ComfyUI.

**What a paste creates**
- A new ordinary paint layer named "Pasted", "Pasted 2", …
- Foreign images paste 1 source px = 1 image px. Internal copies keep their own image-px size.
- One `layers` undo entry.
- Quick Mask turns off.
- The selection is dropped in the same step.
- The new layer is the kept original at identity placement, so a later Free Transform resamples from the pasted pixels.
- Placement:
  - Above the active paint layer.
  - With a cmask current, above the top-most paint layer.
  - Takes over its group's solo.

**Placement rule** (`pastePlacement.ts`, user-measured Photoshop behaviour, first match wins)
1. A selection exists: centre on its bounding box, even off screen, never resized. An inverted selection counts as the image area.
2. Our own copy from this editor: its original position.
3. The whole image area is visible: centre of the image area.
4. Otherwise: centre of the view.

- Then always clamp into the image area (centred on an axis where the item is larger) and snap to whole document px.
- Drops use the drop point as centre and the same clamp.

**Oversized pastes**
- A paste whose rect reaches past the paint-area cap (the bounds cap ∪ current bounds, not the image area) opens as an image-source insert at native size.
- It runs in a Free Transform session, and the note "Paste is larger than the paint area -- placed in Free Transform. Commit to crop, Esc to cancel." is shown.
- Commit crops. Esc removes the layer. One undo step.
- Why: nothing is cropped silently.

**lmask-only view**
- Every paste and drop goes into the viewed lmask instead of making a layer. The pixels become an lmask float at the normal placement.
- Value = Rec.709 luminance × alpha, so transparent = black = shown. Our own lmask copies (opaque grayscale) keep exact values. The lmask's Invert is ignored, so copies round-trip.
- The selection is dropped now and joins the commit's step. Esc brings it back.
- Move it, then commit or cancel like any lmask float. An oversized paste goes into a Free Transform session on that float.

**Drag-drop** (`dropImport.ts`)
- Claimed on the stage in capture phase, on both `dragenter` and `dragover`.
  - Any `image/*` file item is claimed.
  - A non-image file with a known type (workflow JSON) is left to ComfyUI.
  - Otherwise it is claimed if a URL or HTML type is present (an image dragged from a Chrome page).
- On drop: image files first (one layer per file, in order, one undo step each). Otherwise the `<img src>` or the first uri-list entry is fetched to a blob.
- A cross-origin fetch failure gives the toast "Couldn't load the dragged image (the site doesn't allow it). Save it and drop the file instead.". A non-image gives the note.

**Files:** `engine/clipboardOps.ts`, `clipboardMath.ts`, `pastePlacement.ts`; `ui/clipboardActions.ts`, `clipboardShortcuts.ts`, `pasteChoice.ts`, `pasteSources.ts`, `pasteButton.ts`, `dropImport.ts`, `toolRail.ts`.

---

### Free Transform and flips

**Entering**
- **Ctrl+Alt+T** from any tool while the editor owns the keyboard (literal `t` only, so AltGr never triggers it), or the **Transform** button.
- **Ctrl+T is unbound.** Chrome reserves it.
- A session is a float with a matrix.
- **Entry cases**, in this order:
  - A text layer: float-less text session over its text box (a selection is ignored).
  - A selection: lifts the selected pixels as a cut.
  - No selection: the kept original if it is still valid, otherwise the whole layer content, carrying the lmask.
  - An existing float is adopted.
- Parameters are `{cx, cy, sx, sy, angle}`. Signed scale means a flip. There is no skew, distort, perspective, warp, movable pivot or multi-layer.

**Handles and hit zones** (`transformHit.ts`, `transformOverlay.ts`)
- Box outline with a dark halo under a light line, 8 square handles (7 screen px) and a centre mark. All are screen-constant.
- Handle grab radius 8 screen px. Rotate zone is outside a corner, within 8 + 16 px.
- Inside the box = move. Outside everything = nothing (a click does nothing).
- Scale drag:
  - Proportional by default (the Link toggle); **Shift inverts the lock**.
  - Edge handles are also proportional when locked.
  - **Alt** scales about the centre.
  - Minimum box side is 1 document px.
- Rotate drag: **Shift** snaps the total angle to 15° steps.
- Move drag: whole document px.
- Handle drag is done by the hidden transform tool, which takes all stage input and keys during a session (Ctrl and Alt do not substitute anything).
- **Arrows** nudge 1 image px, Shift 10.

**Options bar during a session** (replaces the tool's own options)
- **X, Y**: box centre in image px, step 0.1.
- **W, H**: scale %, 1–10000.
- **Link** toggle: keeps proportions.
- **Angle**: −180° to 180°.
- **Flip H, Flip V**.
- **Commit** (check) and **Cancel** (×).

**Commit and cancel**
- **Commit** = Enter, the check button, a tool switch, or any other edit (`settleFloat`).
- **Whole-layer or inserted session**: one undo step, from a single resample.
- **Selection-float session**: Enter, the check button or a drag end only ends the session. The float stays, with its matrix over the original lifted pixels and a baked display. A second Enter, or any other edit, lands it. A later session on it restarts from the original with the cumulative matrix, so there is no accumulated resampling.
- **Cancel** = Esc, ×, or Ctrl+Z. It cancels the whole session, including the lift. Esc mid-drag cancels the whole session too. There is no per-adjustment undo.
- The preview draws the original float canvas through the matrix with canvas smoothing.
- The commit resamples once from the original: bilinear on premultiplied alpha, up to 4×4 supersampling when shrinking. Whole-px moves and flips are exact.

**Flips** (the H/V buttons, in the session bar and in the Move layer / selection-tool bars)
- **During a session**: part of the session. They flip in document space about the box centre.
- **With a selection or a float, outside a session**: lifts the selected pixels and flips them as an exact mirror matrix. It stays floating and is not committed.
- **With neither**: flips the whole current layer about its content centre as an exact pixel mirror inside the content bbox, one undo step, and the lmask mirrors with it.
- **Text layer**: asks the rasterize prompt.

**Text layers**
- A float-less session over the text box.
- Rotation maps to `textData.rotation` (degrees, about the box centre). A uniform scale scales `textData.size`. A move shifts the anchor.
- The layer re-renders live and stays editable. Commit is one text undo step.
- A non-uniform scale, a flip, or an unlinked W/H field edit asks to rasterize once the gesture ends. Yes = text step + rasterize step, continuing as a pixel session. No = the change is dropped.

**Kept original** (`keptOriginal.ts`)
- After a commit that leaves the float as all the layer holds, the layer keeps its pre-transform pixels and the cumulative matrix in memory.
- It is valid only while the layer's pixel revision is unchanged. Any paint, fill, lift, merge, clear, rasterize, Match image resolution or undo/redo touching the layer drops it.
- A later whole-layer Free Transform restarts exactly (5 × 10° = one 50° resample).
- Pastes keep their pixels at identity placement.
- The cap is 128 MB per editor, oldest first. It is never saved.

**lmask carry**
- A whole-layer lift always carries the layer's lmask. It lands, transforms, flips and keeps its own original in the same step.
- A selection lift follows the target (pixels or lmask), as in Floating selections.

**Files:** `engine/transformOps.ts`, `transformMath.ts`, `transformHit.ts`, `transformFields.ts`, `transformSession.ts`, `transformResample.ts`, `textTransform.ts`, `keptOriginal.ts`, `layerFlip.ts`; `tools/transformTool.ts`; `ui/transformOverlay.ts`, `floatShortcuts.ts`.

---

### Moving (Move layer, Move drawing)

**Move layer (V)**
- Moves the active layer's content by whole document px, one undo entry per drag. The preview only offsets how the layer canvas is drawn. Pixels move once, on commit.
- **Targets**: the active paint or text layer, or the current cmask under Quick Mask.
- **Whole-layer moves**: carry the lmask in the same entry, move a text layer by shifting its `textData` anchor (never rasterizes), and move the selection with them.
- **Notes**: an unmovable kind gives "This layer can't be moved."; hidden, locked and Image Mask refuse via `editBlockNote` (kind "whole"); an empty layer with a selection gives "No pixels are selected."
- **Esc or a pointer cancel** aborts the drag.
- **Arrows**: nudge 1 image px (at least 1 document px), Shift 10. Consecutive nudges merge into one undo entry. A nudge mid-drag is swallowed.
- **With a selection**: pressing inside lifts a float (Alt = copy). Pressing outside moves the whole layer and the selection follows.
- **Auto-select** (toggle option, default off, or Ctrl at pointer-down, including when this tool is the temporary Ctrl tool):
  - Picks the topmost visible, unlocked paint or text layer with a pixel under the pointer and makes it active (not an undo step).
  - With Quick Mask on, it picks only visible, unlocked cmasks by raw painted coverage and makes the hit the current cmask, with Quick Mask staying on.
  - Nothing hit means nothing moves, with no note.
  - It is disabled while a selection exists.
- **Ctrl as temporary Move**: all rail tools except Text, Move layer, Move drawing and the region tool. It also does not apply while a tool has a pending interaction (polygonal lasso).
  - Precedence at pointer-down is Ctrl > Alt > active tool, and it is locked for the drag.
  - A Free Transform session beats all of them.

**Move drawing**
- Not a rail tool and has no shortcut. It is a toggle in the layers-panel footer.
- Toggling again returns to the last rail tool.
- Ctrl never substitutes Move layer while it is active.
- It edits document placement (`doc.placement`): the whole drawing relative to the image.
- Drag moves in whole image px, so an unscaled drawing stays pixel-exact.
- **Wheel while dragging** scales around the cursor (×1.05 per notch, trackpads proportional). The wheel without a drag still zooms the view.
- **Arrows** nudge 1 image px, Shift 10.
- **Esc during a drag** restores the placement from the drag start.
- **Options bar**: X, Y (image px, ±16384), Scale % (5–1000), **Reset position**.
- Not undoable and never in the paint history.
- Interactions (drag, nudge, wheel, fields) are clamped so the paint area covers the image area plus 50 image px per side. Reset and drag-cancel are not clamped.
- Clear resets placement as part of its own undoable snapshot.
- The icon turns red when the resolution notice is active (see the Resolution notice).

**Files:** `tools/moveLayer.ts`, `move.ts`, `registry.ts`; `engine/moveOps.ts`, `layerMovers.ts`, `layerTranslate.ts`, `placementOps.ts`, `placementClamp.ts`, `placementMath.ts`; `ui/hostSync.ts` (`toggleMoveDrawing`).

---

### Image sources and the Images panel

**Input and history**
- Optional `layer_source` IMAGE input, third in the order (`image`, `mask`, `layer_source`). It does not affect the outputs.
- Session history (`SourceHistory`): the last **10** distinct images, newest first. A repeat moves to the top. In memory, per node instance, never in the manifest or workflow.
- Source lookup (`layerSourceWatch.ts`), only while the input is linked:
  1. The upstream node's preview. This is the same lookup as the background and works before any run.
  2. Our own executed output's `ui.layer_source` preview (first image of a batch).
- Dedupe key is Python's content `source_id`, so re-runs do not duplicate.
- The name is the upstream file stem when it is a LoadImage-style or `type=input` preview.

**Images button and panel**
- The Images button sits after Paste with a count badge. It is disabled while the history is empty.
- The panel is a sticky popover over the left of the stage, with a vertical scrolling thumbnail list, newest first.
- It lives in the popover layer, so it follows the root into fullscreen.
- **A thumbnail click inserts and the panel stays open**, so several sources can be inserted in a row.
- It closes on: Esc (consumed before every other key handler), a press on the stage, a press on a rail tool button, or the Images button again. Clicks elsewhere (other nodes, the graph, the options bar, the layers panel) leave it open.
- Auto-open: a new source after the initial state opens the panel if closed. A "seed" (load) or a repeat moving up does not. A user link change on the input re-arms it.

**Inserting a source**
- Loads the full source and decodes it. A source over **8192 px** on its long side is downscaled once, with the note `Image reduced to W x H px (max 8192 px per side).`
- Adds an empty paint layer named after the file stem, else "Image N" (lowest unused N).
  - Placement: above the active paint layer.
  - Quick Mask off.
  - Selection dropped in the same step.
  - It takes over solo.
- The source becomes a float with no lift position and a Free Transform session starts at once.
  - Start scale is 1, or the largest scale that fits the image area (aspect kept). Large sources start scaled to fit, small ones at native size.
  - Placement uses the paste placement rule (selection, else image area or view centre), clamped, with a whole-px top-left.
  - The commit resamples once from the full source, so the start scale loses nothing.
- **Commit** = one undo step (the layer add and the transform patch are joined). **Cancel** (Esc, ×, Ctrl+Z) undoes the add and drops it from redo.
- Clicking a thumbnail while another session or float is live settles it first.
- A failed load gives the note "Could not load the image."

**Files:** `widget/sourceHistory.ts`, `layerSourceWatch.ts`, `imageSource.ts`; `ui/imagesPanel.ts`, `sourceInsertAction.ts`, `editorHost.ts`; `engine/sourceInsert.ts`; `nodes/previews.py`.

---

## B. Shortcuts found

| Keys | Context | Action | file:line |
|---|---|---|---|
| Ctrl+A | editor owns keyboard | select all (image area) | `selectionShortcuts.ts:40` |
| Ctrl+D | same | deselect | `selectionShortcuts.ts:41` |
| Ctrl+Shift+I | same (editor-scoped) | invert selection | `selectionShortcuts.ts:44` |
| Shift+F7 | same | invert selection | `selectionShortcuts.ts:47` |
| Delete / Backspace | same; with a selection | clear selection on target | `selectionShortcuts.ts:36` |
| Delete / Backspace | same; no selection | silently swallowed, no note (Delete without a selection is the one that stays silent; Alt/Ctrl+Backspace note "Nothing is selected.") | `selectionShortcuts.ts:37` |
| Alt+Backspace | same | fill selection with FG | `selectionShortcuts.ts:34` |
| Ctrl+Backspace | same | fill selection with BG | `selectionShortcuts.ts:35` |
| Ctrl+C | same | copy | `clipboardShortcuts.ts:52-56` |
| Ctrl+Shift+C | same | copy merged | `clipboardShortcuts.ts:56` |
| Ctrl+X | same (not with Shift) | cut | `clipboardShortcuts.ts:52,55` |
| Ctrl+V | same | stop keydown (not prevented), arm `paste` | `clipboardShortcuts.ts:36,45-50` |
| Ctrl+Shift+V | same; internal copy exists | paste in place | `clipboardShortcuts.ts:38-44` |
| Ctrl+Shift+V | same; no internal copy | like Ctrl+V (plain-text fallback) | `clipboardShortcuts.ts:45-49` |
| Ctrl+Alt+T | any tool | Free Transform | `floatShortcuts.ts:42,74-77` |
| Enter | float or transform active | commit session, else land the float | `floatShortcuts.ts:57-62` |
| Esc | float or transform active | cancel (whole session or float) | `floatShortcuts.ts:52-56` |
| Esc | Images panel open | close the panel, before everything else | `imagesPanel.ts:107-111`, `editorHost.ts:179` |
| Esc | tool drag in progress | cancel the drag | `shortcuts.ts:70-72`, `stageInput.ts:151` |
| Ctrl+Z | float or transform active | cancel float/session | `editor.ts:353-355` |
| Ctrl+Y / Ctrl+Shift+Z | float or transform active | ignored | `editor.ts:361-362` |
| Ctrl+E | float shortcuts | Merge Down (not my area) | `floatShortcuts.ts:35` |
| Arrow keys, Shift+arrows | Move layer | nudge 1 / 10 image px; float first | `moveLayer.ts:130-139` |
| Arrow keys, Shift+arrows | Move drawing | nudge placement 1 / 10 image px | `move.ts:172-180` |
| Arrow keys, Shift+arrows | Free Transform session | nudge session 1 / 10 | `transformTool.ts:109-115` |
| V | tool key | Move layer | `moveLayer.ts:53` |
| M, Shift+M | tool key | marquee group, cycle | `marquee.ts:88`, `shortcuts.ts:111-118` |
| L | tool key | Lasso | `lasso.ts:78` |
| W | tool key | Magic wand | `magicWand.ts:43` |
| (none) | Move drawing | no shortcut, footer toggle | `move.ts:115` |
| Shift | at pointer-down, selection exists | add | `selectionModifiers.ts:47`, `selection.ts:50-54` |
| Alt | same | subtract | same |
| Shift+Alt | same | intersect | same |
| Shift (after release and re-press) | during drag | square/circle | `selectionModifiers.ts:60` |
| Alt | during drag | from centre (lasso: straight segments) | `selectionModifiers.ts:60`, `lasso.ts` |
| Ctrl | at pointer-down, any rail tool | temporary Move layer | `registry.ts:220,232-234` |
| Ctrl+drag inside selection | rail tool | lift and move | `moveLayer.ts:79-85` |
| Ctrl+Alt+drag inside selection | rail tool | lift a copy | `moveLayer.ts:84` |
| Alt+drag inside selection | Move layer | lift a copy | `moveLayer.ts:84` |
| Ctrl+drag, no selection | rail tool | auto-select then move layer | `moveLayer.ts:92-95` |
| Plain press inside selection | marquee, lasso, wand | outline drag | `registry.ts:217-219`, `outlineDrag.ts` |
| Ctrl / +Shift / +Alt / +Shift+Alt click | layer or cmask row | selection from alpha (hard): replace / add / subtract / intersect | `layerRow.ts:185-186` |
| Same combinations | lmask thumbnail | soft selection of the shown part | `layerMaskThumb.ts:108-110` |
| Shift+click | lmask thumbnail | toggle enable (not my area) | `layerMaskThumb.ts:111` |
| Alt+click | lmask thumbnail | lmask-only view (not my area) | `layerMaskThumb.ts:112` |
| Shift while dragging a handle | Free Transform | invert proportional lock | `transformSession.ts:60` |
| Alt while dragging a handle | Free Transform | scale about centre | `transformSession.ts:60` |
| Shift while rotating | Free Transform | 15° steps | `transformSession.ts:62` |
| Wheel while dragging | Move drawing | scale ×1.05 per notch | `move.ts:161-169`, `stageInput.ts:103` |
| Long-press 400 ms / right-click | Paste button | source menu (System / Clipspace) | `pasteButton.ts:23,72-76,110-119` |
| Double-click, or click near start | polygon lasso pending | close | `lasso.ts:189-197` |
| Alt-click | lasso | add polygon vertex | `lasso.ts` |

---

## C. Cursors

All are CSS `cursor` values set through `--cps-tool-cursor` in `stageView.syncCursor`.

| State | Cursor | Hotspot | file |
|---|---|---|---|
| Marquee, lasso, wand; a selection exists and a modifier is held (Shift, Alt, Shift+Alt) | 32×32 SVG: crosshair with a badge at the bottom right: `+` add, `−` subtract, `×` intersect; fixed during a drag | (11, 11) | `cursors.ts:143-181` |
| Same tools, no selection or no modifier | native `crosshair` | n/a | `marquee.ts:146`, `lasso.ts:156`, `magicWand.ts:87` |
| Marquee, lasso, wand, plain hover inside selection (outline drag) | SVG arrow plus a dotted-rectangle badge (the marquee icon), fallback `default` | (2, 2) | `moveCursors.ts:76-80` |
| Move layer or Ctrl, hover inside selection, no float | `cut`: four-way move arrows plus scissors badge | (11, 11) | `moveCursors.ts:38-44,71` |
| Same, Alt held | `copy`: move arrows plus a `+` badge | (11, 11) | `moveCursors.ts:72` |
| Move layer, outside selection, no selection, or a float exists | native `move` | n/a | `moveCursors.ts:42` |
| Move drawing | native `move` | n/a | `move.ts:183` |
| Layer-row hover with Ctrl: replace | SVG arrow plus the dotted-rectangle badge, set on the row element | (2, 2) | `moveCursors.ts:134-146`, `layerSelectHover.ts` |
| Layer-row hover with Ctrl: add / subtract / intersect | same arrow with `+` / `−` / `×` marks above the badge | (2, 2) | `moveCursors.ts:62-67` |
| Free Transform: inside box | `move` | n/a | `transformTool.ts:128-129` |
| Free Transform: handle | native `ns-resize`, `ew-resize`, `nwse-resize` or `nesw-resize`, chosen by the handle's on-screen direction (45° sectors, so it follows rotation and flips) | n/a | `transformHit.ts:78-88`, `cursors.ts:81` |
| Free Transform: rotate zone | SVG: two circling arrows, black with a white outline, fallback `crosshair` | (16, 16) | `moveCursors.ts:154-177` |
| Free Transform: outside | `crosshair` | n/a | `transformTool.ts:134-135` |
| Free Transform: during a handle drag | the dragged zone's cursor stays | n/a | `transformTool.ts:126` |

The cursor reflects the tool resolved for the held modifiers and the pointer position, and updates on Alt or Ctrl changes without pointer movement.

---

## D. Messages

Stage notes last 5000 ms (`NOTE_MS`, `stageView.ts:32`). Toasts go through `notify`.

| Text (verbatim) | Trigger | file |
|---|---|---|
| `Nothing is selected.` | Delete, fill or To mask without a selection (Delete itself is silent, see B) | `selectionOps.ts:53` |
| `The layer has no pixels.` | Ctrl+click on a layer row or the Image Mask row that has no pixels | `selectionOps.ts:55` |
| `The layer mask shows nothing.` | Ctrl+click on an lmask thumbnail that selects nothing | `layerMaskOps.ts:37` |
| `No pixels are selected.` | Lift or Move with a selection that holds no pixels of the layer | `floatLift.ts:36` |
| `The layer is empty.` | Flip or whole-layer transform of an empty layer | `layerFlip.ts:24` |
| `This layer can't be moved.` | Move on a layer kind with no mover | `layerMovers.ts:55` |
| `Layer is locked.` | Any gated edit on a locked layer, including lift, move, transform, cut | `editorTypes.ts:198` |
| `The layer is hidden.` | Gated edit on a hidden paint or text layer (copy too) | `editorTypes.ts:204` |
| `The mask is hidden.` | Gated edit on a hidden cmask | `editorTypes.ts:222` |
| `The layer is hidden by solo.` | Gated edit while another layer's solo hides it | `editorTypes.ts:207` |
| `<name> can't be edited — duplicate it to edit.` (em dash; `name` = "Image Mask" or "Input Mask") | Any pixel edit on the Image/Input Mask row | `editorTypes.ts:214-216` |
| `Layer mask: use the brush, eraser or fill.` | Other pixel tool on a targeted lmask (shapes, line, text) | `layerMask.ts:48` |
| `Nothing to copy.` | Copy or cut finds no pixels | `clipboardOps.ts:67` |
| `Nothing to paste.` | Ctrl+V with no source anywhere | `clipboardActions.ts:45` |
| `The clipboard has no image -- nothing to paste.` | Paste button "System" with no source | `clipboardActions.ts:51` |
| `Clipspace has no image -- nothing to paste.` | Paste button "Clipspace" with an empty clipspace | `clipboardActions.ts:48` |
| `Paste is larger than the paint area -- placed in Free Transform. Commit to crop, Esc to cancel.` | A paste or drop past the paint-area cap | `clipboardOps.ts:70` |
| `The dropped item is not an image.` | A drop with nothing usable, or a non-image URL | `dropImport.ts:37` |
| **Toast** (warn, key `drag-image-blocked`, 10 s window): `Couldn't load the dragged image (the site doesn't allow it). Save it and drop the file instead.` | A web-image drag whose fetch is blocked by CORS or network | `dropImport.ts:34,109` |
| `Could not load the image.` | An Images-panel source failed to decode | `sourceInsertAction.ts:20` |
| `Image reduced to W x H px (max 8192 px per side).` | A source over 8192 px on its long side | `sourceInsertAction.ts:65` |
| **`window.confirm`**: `Rasterize text layer? It will no longer be editable as text.` | Pixel edit, lift, flip or non-uniform transform on a text layer | `rasterize.ts:28`, `textOverlay.ts:73` |

Nothing in my area uses a toast except the drag-blocked one. Console-only: `System clipboard unavailable; the copy is kept inside PainterSketch only.`, `Could not write the system clipboard; …`, `Could not decode the pasted image:`, `Could not load the clipspace image:`, `Could not load the image source:`, the `Clipboard read unavailable:` warning, and `[PainterSketch] drop:` debug lines.

---

## E. Mismatches

| Old SPEC says | Code does | file:line | My read |
|---|---|---|---|
| Ctrl+V pastes "centred in the view" (M10 Clipboard text) | Four-step placement rule: selection bbox, own copy in place, image-area centre if fully visible, else view centre; always clamped inside the image area | `pastePlacement.ts:5-12,59-67` | Old text is stale (2026-09-27 decision supersedes it). Document the rule. |
| Larger than the paint area → "cropped + toast" | Opens a Free Transform session at native size with a note, and crops on commit | `clipboardOps.ts:181-183,204-212` | Old text stale. The log has it. |
| Images panel: "Click outside / Esc closes it" | Sticky panel: clicks outside the stage, rail tools and the button leave it open, and a thumbnail click keeps it open | `imagesPanel.ts:1-24` | Intended (2026-09-27 follow-up). Old text stale. |
| History: "last 5 thumbnails" (design entry); the M12 section says 10 | 10 | `sourceHistory.ts:16` | Code is right. Drop the "5". |
| The Images panel opens only on a click | Auto-opens on a new history image, but not on seed, repeats or load | `imagesPanel.ts:156-159`, `sourceHistory.ts:62-69` | Intended. Add to the spec. |
| M11 section: "Transform = Ctrl+T" and milestone heading "Free Transform (Ctrl+T)" | Only Ctrl+Alt+T. Ctrl+T is deliberately unbound. | `floatShortcuts.ts:11-13,74-77` | Old text stale. The button title already says Ctrl+Alt+T. |
| "Commit = Enter, check, tool switch, any other edit" | For a selection float, Enter or the check button only ends the session. The float stays and a second Enter (or other edit) lands it. Whole-layer and inserted sessions commit at once. | `transformOps.ts:144-155`, `floatShortcuts.ts:57-62` | Intended (2026-09-27 log). Spec must state the two-step. |
| "Selection tools: Ctrl+drag inside (Ctrl+Alt = copy)" | Works for every rail tool except Text, Move layer, Move drawing and the region tool, because Ctrl swaps in Move layer | `registry.ts:220,232-234` | Intended (Photoshop). Widen the wording. |
| "Delete / Backspace clears the selection on the target layer" | Without a selection, Delete is swallowed silently, with no note. Alt/Ctrl+Backspace note "Nothing is selected." | `selectionShortcuts.ts:32-38`, `selectionOps.ts:246-249` | Unclear. Probably fine (stops the graph deleting the node), but inconsistent. Mention it. |
| "Selection to mask: with the mask targeted, fill does it" | To mask adds to the current cmask whatever the target and creates a Mask if none. On a cmask target, FG and BG fills are identical (white coverage). | `selectionOps.ts:219-226,206-212` | Intended. Rewrite the sentence. |
| `fromLayer` docstring: "soft edges stay partial" | The code hardens (`hardenSelection`) | `selectionOps.ts:150,179-182` | Stale comment. The 2026-09-27 log says hard. The spec should say hard. |
| `selectionOps.ts:179-182` indentation | Extra indent inside `fromLayer` | `selectionOps.ts:179-182` | Cosmetic. |
| `clipboardActions.ts` header: Ctrl+Shift+V "own copies only", internal `from`: "paste in place only there" | `pasteInPlace` does not check `internal.from === editor`. It pastes the internal copy at its rect in whichever node is active; only the Ctrl+V "own copy" rule uses `from`. | `clipboardActions.ts:141-146,220` | Unclear. Probably "internal copy only" is meant. Decide. |
| M10: "Dropping image files on the canvas = paste at the drop point" | Also web-page image drags (`<img src>` or uri-list, fetched) with CORS toast | `dropImport.ts` | Intended (2026-09-26 fix). Spec should include it. |
| M10 "Pasted layers are ordinary layers; M11 may keep the pasted source" | The paste is the layer's kept original at identity | `clipboardOps.ts:191-192` | Done. Update the spec. |
| M5: "`V` is reserved for a future element Move tool" | `V` is Move layer | `moveLayer.ts:53` | Stale. |
| M10: "Float: Move tool; Alt = copy; outside moves the whole layer" | Same, but a refused lift (blocked or text confirm) never falls through into a layer move | `moveLayer.ts:79-85` | Intended. Add to the spec. |
| Marquee: "Alt = subtract (unchanged)" | Alt also subtracts inside a selection (not an outline drag), since the outline drag requires no Shift, Alt or Ctrl | `registry.ts:217` | Consistent. |
| "A float: tool switch commits" | The tool-switch hook is `registry.setBeforeSwitch(editor.settle)` | `registry.ts:270` | Consistent. |
| Marquee plain drag inside moves the outline | With a float alive, a plain press inside the selection commits the float first (the outline drag calls `settleFloat`), then moves the outline | `selectionFollow.ts:97-104` | Intended. Note it. |
| "Later idea: inverted selections bounded by the image area" (log) | Only the ants are bounded by the image area. Coverage is not. | `selectionOps.ts:91-93`, `selectionOutline.ts:48-58` | Still true. Say "not bounded". |
| M14: "Ctrl+click on the layer row = the layer's own pixels (mask ignored)" | Consistent (`fromLayer` reads the layer pixels) | `selectionOps.ts:173-175` | OK. |
| Old tool table: "Float selection … selection tools: plain drag inside moves the outline only" | Implemented as `OutlineDragTool`, not a tool-table row | `outlineDrag.ts` | The spec's Tools table row should become prose under Selection. |

**Not mismatches, but absent from the old spec:**
- Paste button long-press is 400 ms.
- The 16×16 own-PNG fingerprint (tolerance 4) for matching our own system-clipboard PNG.
- Armed paste window is 1000 ms.
- lmask-only-view paste math.
- `TransformButtons` appear on the Move layer bar always.
- The Link toggle is labelled "Link".