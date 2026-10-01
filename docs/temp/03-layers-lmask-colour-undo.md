Everything below comes from reading the code; I ran nothing in a browser. Items I couldn't confirm statically are marked **(verify)**.

---

# A. Spec text

## Layers

### Kinds and properties

The panel shows five kinds of row. Three are real layers in `doc.layers`; the other two are not.

| Row | Record | Notes |
|---|---|---|
| **Paint layer** | `Layer{kind:"paint"}` | Pixels, optional lmask. |
| **Text layer** | `Layer{kind:"text", textData}` | Rendered to pixels from `textData`. It shows a "T" badge on its thumbnail. It cannot get an lmask. A pixel edit asks to rasterize first, which turns it into a paint layer. |
| **cmask** ("Mask N") | `Layer{kind:"mask"}` | A standalone ComfyUI-style mask. Pixel alpha is its coverage. |
| **Image Mask / Input Mask** | `doc.imageMask`, a `Layer`-shaped record with a fixed id. It is never in `layers`. | See its own subsection. |
| **Background** | No record. Only `doc.backgroundVisible` (written only when `false`). | See its own subsection. |

Layer properties:

- **id**: random base36. The Image Mask has a fixed id.
- **name**: rename trims it, caps it at 100 characters, and ignores an empty result. The Image Mask and Background names are fixed.
- **visible**: the eye. Not undoable. A hidden cmask is excluded from the `MASK` output.
- **locked**: refuses pixel edits only. Not undoable. Delete, rename, reorder, opacity and eye still work on a locked layer. The Image Mask and Background rows cannot be locked.
- **opacity**: stored 0..1, shown 0–100 %, scrubbable. On a paint layer it is the composite opacity. On a cmask it is the overlay opacity and is display-only.
- **blendMode**: always `"normal"`. There is no UI and the parser forces it.
- **file**: the saved image reference.
- **color**: cmask only, `#rrggbb`, display-only.
- **invert**: cmask only. It is applied before the union.
- **layerMask**: paint layers only.

Invariants:

- `activeLayerId` always names a paint-like layer (paint or text).
- cmasks sit above all paint layers. Parse repairs the order. Drag and drop can't violate it.
- At least one paint-like layer must remain, so the last one can't be deleted. Parse also guarantees a `paint`-kind layer exists, and adds "Layer 1" if none does.
- There are at most **7** cmask layers. The Image/Input Mask row does not count. `New mask` is disabled at the limit, with tooltip "At most 7 masks".
- At least one cmask should exist. The last one can't be deleted ("clear it instead").
  - Old documents may have none. `Q` or "To mask" then adds a default "Mask 1" lazily, with no undo step.
- There is no limit on paint layers.
- A new document is "Layer 1" (active) plus "Mask 1". Mask 1 uses the `DefaultMaskColor` and `DefaultMaskOpacity` settings (defaults red, 50 %).

Naming:

- **Paint**: "Layer N", where N is the highest existing "Layer N" plus 1 (Photoshop style).
- **Mask**: "Mask N", the lowest free N. A bare "Mask" counts as 1.
- **Duplicate**: "Name copy", "Name copy 2", and so on. An existing " copy N" suffix is stripped first, then the first free name is used.
- **Other names**: text layers are named from their text. Pastes are "Pasted" / "Pasted N". Image-source inserts use the file stem or "Image N".
- **Duplicating a paint layer** copies visible, locked and opacity. It also copies the lmask with its pixels. The copy sits directly above the original and becomes active.
- **Mask palette** (`maskDefaults.ts`): the first mask uses the user's default style. Later masks take the first unused colour from blue `#0000ff`, green `#00ff00`, yellow `#ffff00`, magenta `#ff00ff`, cyan `#00ffff`, orange `#ff8000`. Overlay opacity is the default-opacity setting. If all six are used, the palette cycles by mask count.

Why: "Layer N" is highest+1 and "Mask N" is lowest-free. These are different rules on purpose, so don't unify them.

Files: `document/types.ts`, `create.ts`, `layerList.ts`, `parse.ts`, `masks.ts`, `defaults/maskDefaults.ts`, `engine/layerOps.ts`.

### Layers panel

- **Position:** the side panel's "Layers" tab (the "Outputs" tab is region mode). The panel is 216 px wide. It auto-collapses when the editor is narrower than 520 px; the user's toggle wins until the width crosses 520 again. Fullscreen opens it and restores the state on exit.
- **Render:** the panel redraws only from editor events (`layers`, `mask`, `solo`, `render`, `change`). Rows are reused by id, so a double-click survives the re-render the first click causes. While a rename is open, rebuilds are deferred.
- **Header:** the title "Layers" plus one opacity control for the selected row.
  - It is labelled "Opacity" when a paint layer is the target, with tooltip "Opacity of the selected layer (drag the label to scrub)".
  - It is labelled "Overlay" under Quick Mask, where it edits the current cmask.
  - Each press on the control starts a new undo gesture. A scrub drag or one slider-popover session is one undo step.
- **List (top → bottom):**
  - cmask rows, top of stack first.
  - Paint and text rows, top of stack first.
  - The Image/Input Mask row, if present.
  - The Background row.
  - A 2 px accent divider bar sits wherever the group changes (masks | paint+text | input rows). It appears only between two non-empty groups. Dividers are not rows and not drop targets.
- **Footer:** `[Move drawing] | [New layer] [New mask] [Duplicate] [Merge Down] [Delete]`.
  - **Move drawing** toggles the hidden Move tool.
    - Toggling off returns to the last rail tool, or the first rail tool.
    - The icon turns red while the resolution or "fit" notice shows.
  - **New layer** inserts above the active paint layer, makes it active and turns Quick Mask off.
  - **New mask** inserts above the current mask and makes it current, which turns Quick Mask on.
  - **Duplicate** works on the active paint-like layer.
    - When the Image/Input Mask row is the current row, it makes an ordinary mask from it (see that subsection).
    - It is disabled for cmask layers.
  - **Merge Down** is disabled whenever Ctrl+E would be refused.
  - **Delete** acts on the selected target (the current mask under Quick Mask, otherwise the active layer).
    - The Image Mask is not deletable.
    - The tooltip reads "Delete layer", "Delete mask", or "The last mask can't be deleted (clear it instead)".
    - With an lmask targeted, footer Delete deletes the layer. The lmask is deleted only from the options bar.
- **Row contents:** thumbnail (36 px box, drawn at the device pixel ratio up to 2×, refreshed at most every 150 ms), name, solo button, eye, lock.
  - Names wrap to 2 lines, then ellipsize. The tooltip reads "`name` (double-click to rename)".
  - cmask and Image/Input Mask rows add a second line with a colour swatch (opens the picker, title "Mask colour"), an invert toggle, and an "Overlay" opacity control.
  - Paint rows add the lmask slot right of the thumbnail (see Layer masks).
- **Thumbnails:**
  - Paint thumbnails show the image footprint, including Move-drawing placement. A checkerboard shows behind transparency.
  - cmask thumbnails are white on black, with invert applied.
  - The Image Mask thumbnail is framed on its own image-pixel size.
  - The Background thumbnail shows the image, or the fill colour when no image is connected.
- **Row states:**
  - `selected` is the paint target: the active paint layer, or the current cmask under Quick Mask.
  - `standby` is a fainter marker on the active paint layer while Quick Mask is on.
  - The current cmask always has a 4 px left bar in its own colour. The Image Mask row can be current too.
  - Hidden rows are dimmed.
  - A paint row with an lmask frames whichever thumbnail (pixels or mask) is the edit target.
  - Hover over a cmask row title reads "Current mask (Quick Mask paints into it)".
- **Click rules:**
  - A plain row click on a paint row makes it active and turns Quick Mask off. It keeps that layer's per-layer target (pixels or lmask).
  - A plain row click on a cmask or Image Mask row makes it the current mask and turns Quick Mask on.
  - Ctrl+click on a row loads a selection (see Lock/selection below).
  - A click on the Background row does nothing except end the lmask-only view.
  - Double-click on the name renames, unless Ctrl is held. Not available for Background or Image Mask. Enter or blur commits, Esc cancels, and the field is one line.
  - Button clicks stop propagation and never select the row.
- **Reorder:**
  - Pointer-drag of a paint, text or cmask row starts after 4 px of movement.
  - It is not available with Ctrl/Cmd held, from a control, or with a non-left button.
  - The Image/Input Mask and Background rows can't be dragged or dropped on.
  - A paint row drops only onto paint rows; a cmask row drops only onto cmask rows.
  - The drop line shows above or below the row under the pointer. The list auto-scrolls within 18 px of its edge.
  - Dragging past the group's end snaps to that group's edge row.
  - Reorder is one undo step and doesn't change the selection.
- **Add / delete / duplicate:**
  - Delete on the active layer activates the layer below, else the nearest above.
  - Deleting the current cmask makes the top-most cmask current.
  - Undo of a delete restores pixels and the lmask. A layer that never held paint and has no lmask costs nothing in history.
  - Add, duplicate and a new cmask take over an active solo of their group.

Why: the lmask slot and the layer thumbnail stop click propagation, otherwise the row's own click would re-select or load a selection.

Files: `ui/layersPanel.ts`, `layerRow.ts`, `layersPanelParts.ts`, `layerSections.ts`, `layerDrag.ts`, `layerControls.ts`, `thumbnails.ts`, `inlineRename.ts`, `sidePanel.ts`, `sidePanelState.ts`, `engine/layerOps.ts`, `document/layerList.ts`.

### cmasks, current mask and Quick Mask

- A cmask is a layer whose pixel alpha is coverage. All cmasks feed the `MASK` output. Combine rule: apply each cmask's `invert`, take the union (max), then the node's `invert_mask` inverts the result.
- **Display:** colour and overlay opacity are display-only. They draw bottom → top as tinted overlays above the paint, and the Image Mask is drawn lowest.
- **Painting a cmask** (Quick Mask on):
  - Brush, eraser, fill, shapes, selection fill and Delete all act on the cmask.
  - The stroke colour is forced white, so FG/BG are ignored and the real swatches show greyed.
  - Brush/eraser opacity and flow still apply.
  - "To mask" in the options bar (shown while a selection exists) adds the selection to the current cmask regardless of target. It is one undo step and does not switch Quick Mask on.
- **Current mask** (`currentMaskId`, session-only):
  - It is the last selected mask row.
  - If that row is gone, or after a reload, it is the top-most cmask.
  - Select a mask row (which also turns Quick Mask on) or press `Q`. A `New mask` also becomes current.
- **Quick Mask** (`Q`, the rail button, or selecting a mask row):
  - It toggles the paint target between the active paint layer and the current cmask.
  - The rail button is highlighted and tinted with the mask's colour.
  - The root gets the `cps-quickmask` class, which greys out the FG/BG swatches.
  - The options bar shows a "Mask" badge in the mask's colour, with tooltip "Quick Mask: strokes paint the mask (Q to exit)".
  - Entering Quick Mask adds "Mask 1" if the document has no cmask.
  - The Text tool, paste, the Images panel and the New layer button all switch Quick Mask off.
  - Ctrl+click auto-select with Move picks only visible, unlocked cmasks that have raw coverage under the pointer (invert ignored). It keeps Quick Mask on.
- **Invert** on a cmask is a setting and is undoable. The colour picker for the mask swatch is one undo step per session.
- **Merge Down on cmasks:** coverage is the union of both masks' effective coverage (each invert applied). It is stored under the lower mask's invert and colour. The lower mask keeps its name and settings. See Merge Down below.
- **Ctrl+click on a cmask row** selects its effective coverage (invert applied), hard (every pixel with coverage > 0 gets 255).
- **Hidden cmask:** painting on it is refused with "The mask is hidden." At queue time a note shows if any hidden cmask has ever held paint.

Files: `engine/editorMaskOps.ts`, `paintOps.ts`, `document/masks.ts`, `ui/hostSync.ts`, `toolRail.ts`, `optionsBar.ts`, `engine/layerDisplay.ts`, `engine/selectionOps.ts`.

### Image Mask / Input Mask row

- It is one fixed row directly above Background. It is mask-shaped, with a swatch, an invert toggle, and an Overlay control.
- Controls:
  - Eye, solo and Ctrl+click selection all work on it.
  - The lock is permanently disabled. Its tooltip is "The `<name>` can't be edited (duplicate it to edit)".
  - It has no rename, no drag, and cannot be deleted. It does not count toward the 7-mask limit.
- Selecting it makes it the current mask and turns Quick Mask on. Every pixel edit is then refused with the Image Mask note.
- **Name and tooltip:** the name is "Image Mask" (from the image's alpha) or "Input Mask" (from the `mask` input). The tooltip is the one in the Messages section.
- **Settings:** eye, colour, overlay opacity and invert survive a source change. Colour, opacity and invert go through the normal layer property edits, so they are undoable. The eye is not.
- **Duplicate** makes an ordinary editable mask with these properties:
  - The coverage is resampled into document coordinates.
  - The name is "Image Mask copy".
  - The colour is the next free palette colour.
  - It keeps the row's opacity, visibility and invert.
  - It is inserted at the bottom of the cmask stack and becomes the current mask. It is one undo step.
  - It is disabled without coverage or at 7 masks.
- **Input Mask hint:** while waiting for a run, a hint line under the row reads "Run the workflow to load this mask".
- **Display and sampling:** the row is drawn and sampled only over an image of exactly its size (`imageMaskApplies`). A mask-sampling bucket or wand includes it in the union while shown.
- **Merge Down** from it is refused with the Image Mask note.
- Source rules, the upload, and Python live in the Image Mask / Input Mask milestone (another area).

Files: `ui/imageMaskRow.ts`, `layerRow.ts`, `engine/imageMaskOps.ts`, `document/imageMask.ts`.

### Background row and drawing resolution

- **The row:**
  - It is named "Background" (tooltip "Input image"), is always locked and not selectable, and can't be renamed, dragged or deleted.
  - Its **colour** is the node's `background` widget. It is always used opaque, with alpha dropped. There is no per-row colour control.
- **Eye** is not undoable. It is saved as `backgroundVisible:false`, and only when false.
  - **Eye off:** the stage shows a checkerboard instead of the image. Outputs use the `background` widget colour instead of the input image. Copy-merged and "All layers" sampling exclude the image. The "Background" sample source still reads the image, because it is an explicit request.
- **Solo** on the Background is a paint-group solo.
  - It replaces any paint solo and shows the image even when the eye is off.
  - Any solo hides every non-soloed layer in both groups, so cmasks are hidden too unless one is soloed.
  - The Background eye is never dimmed by other solos.
  - A paint solo keeps the image as its eye says.
- **Frame, bounds and the paint area:**
  - `frame` is the grid the paint was made on.
  - `bounds` is the paint area. It always contains the frame and grows in 256 px chunks on paint, move, fill or paste.
  - Its maximum is the frame plus the frame's short side on every side, at most 16384 per axis. Existing larger bounds are kept.
  - The stage draws a border and a cobweb texture outside the maximum area.
  - A label "W x H" sits under the image rect on the stage overlay.
- **Minimum frame** (`minimumFrame`):
  - It applies when a frame is set from an image: new documents, an empty document adopting a new size, Clear, and the widget fallback.
  - The short side is scaled up proportionally to ≥ 1024, but the boost never pushes the long side past 4096.
  - It never shrinks.
- **Mismatch notice** (options bar, any tool):
  - It shows when `ratio` > 1.5, where `ratio` is the factor Match would resample by.
  - Text: "Drawing grid `G` px — image `I` px (`N.N`x)". The ratio is floored to one decimal.
  - A second case, "fit", shows when the image area doesn't fit the maximum paint area: "The image's shape doesn't fit the drawing — parts can't be painted." If both apply, the resolution message wins.
  - It never shows for an empty document or while loading.
  - It comes with one warn toast per document per page session.
- **Match image resolution** (button in the notice):
  - A confirm asks first. See Messages. A second paragraph is added if far-away paint would be cropped.
  - It resamples every paint, cmask and lmask layer once. The frame becomes what the image would give. It never lowers resolution; the frame is enlarged if needed, up to 16384.
  - The drawing stays visually where it is, and placement is folded in then reset to identity. Text layers re-render with scaled `textData`.
  - Bounds beyond 16384 are clipped around the frame centre.
  - It is not undoable: the history is cleared and the selection is cleared.
- **Move drawing:** moves or scales the whole drawing via `placement`. It is not undoable. Its options bar has X, Y, Scale and Reset position.

Why: Match clears undo because patches are in document coordinates and the grid itself is being resampled.

Files: `ui/layersPanel.ts`, `resolutionNotice.ts`, `resolutionLabel.ts`, `engine/drawingResolution.ts`, `resolutionOps.ts`, `bounds.ts`, `frameOps.ts`, `docComposite.ts`, `compositor.ts`, `widget/frameFallback.ts`, `tools/move.ts`.

### Solo

- Solo is view-only. It has one slot for the paint group (paint, text, or Background) and one for cmasks (including the Image/Input Mask row). Clicking a solo button replaces its group's solo. Clicking the active solo ends it.
- **While any solo is set** the stage draws only the soloed layers, in both groups, even if a layer's eye is off. The Background follows its own eye unless it is soloed.
- Eyes are never changed. Rows in a soloed context show dimmed eyes. The soloed row shows an accent-coloured eye and solo button.
- **Hidden by solo:**
  - "All layers" sampling for the bucket, wand and eyedropper.
  - The Alt+click lmask-only view is separate and independent.
  - Copy-merged.
  - Not affected: outputs, uploads, Ctrl+click selection (works on hidden layers) and selection-to-layer.
- **Edit refusal:** editing a layer that solo hides is refused with "The layer is hidden by solo." The refusal order is: Image Mask note → eye-hidden → solo-hidden → lmask-tool note → locked.
  - A soloed layer with its eye off is still refused with the eye note.
  - The lmask-only view lets you edit the viewed lmask even when the layer is eye-hidden or solo-hidden.
- Solo is never saved or undoable. It ends on delete, merge, or Clear, and on a new session.
- Soloing never changes the selection.
- A newly created layer (add, duplicate, mask, text, paste, Image-Mask duplicate) takes over its group's solo while any solo is on.

Files: `engine/solo.ts`, `layerDisplay.ts`, `rasterize.ts`, `editorState.ts`, `ui/layersPanelParts.ts`.

### Lock, selection from a row, and the edit gate

- A single gate decides whether a pixel edit may proceed: `preparePixelEdit` (and `editBlockNote`). It covers brush, fill, shapes, selection fill/clear, Move, transform, flip, Merge Down, copy/cut, and Apply.
  - Text layers get the rasterize prompt.
  - The caller proceeds only on "proceed" or "rasterized".
  - Copy refuses hidden layers but allows locked ones.
- Ctrl+click on a row loads the layer's own pixels as the selection. It is hard, ignores the lmask, and works on hidden layers.
  - The modes are Ctrl = replace, Ctrl+Shift = add, Ctrl+Alt = subtract, Ctrl+Shift+Alt = intersect.
  - It does not change the active layer, Quick Mask, or solo.
  - An empty layer gives a note and leaves the selection unchanged.
  - A cmask uses its effective coverage, with invert applied.
  - While Ctrl is held over a row, the cursor shows an arrow with a marquee badge, plus `+`, `−` or `×` for the mode.

Why: the selection is hard (255 wherever alpha > 0). A soft selection left an `a·(1−a)` residue at every edge when moved, and ghosted on repeat.

Files: `engine/rasterize.ts`, `selectionOps.ts`, `ui/layerSelectHover.ts`, `moveCursors.ts`.

### Merge Down and Clear

- **Merge Down** (Ctrl+E or the footer button):
  - It merges the current row into the row directly below in the same group.
  - The current row is the active paint-like layer, or the current cmask under Quick Mask.
  - The lower row keeps its name and settings. Paint rows bake the upper opacity in. Text rows rasterize first, with the prompt.
  - It is one undo step.
  - It is refused when either row is hidden, solo-hidden or locked, or when there is nothing to merge into. It never merges into the Background or the Image Mask row.
  - A mask-layer merge uses the union of both masks' effective coverage.
  - A paint layer's lmask is applied to its pixels first, with the note "Layer mask applied." The lower layer keeps its own lmask.
  - Merging works on the layer's pixels. An lmask target doesn't change that.
- **Clear** (rail button, with a confirm):
  - It empties every layer's pixels, removes all lmasks, converts text layers to paint, and resets the frame to the minimum frame for the current image.
  - It also resets placement, regions and Main output options, and ends all solos.
  - Layers keep their names, order, eye, lock and opacity.
  - It is one undoable step. It is also the history "barrier" that frame adoption respects.

Files: `engine/mergeDown.ts`, `floatMath.ts` (`mergeMaskCoverage`), `frameOps.ts`, `ui/hostSync.ts`.

---

## Layer masks (lmask)

**What it is.** An lmask is an optional grayscale mask on a paint layer that hides part of that layer non-destructively. It never reaches the `MASK` outputs. Only paint layers can have one; a rasterized text layer is a paint layer and can. There is one per layer, always linked to it. It uses the ComfyUI convention: **white = hidden, black = shown**, grey = partial.

**Data.** `layerMask: {file, enabled, invert, outside}`.
- It is a PNG exactly the size of `bounds`. The hidden amount lives in alpha, with white RGB.
- `file:null` means everything is shown.
- `enabled:false` means the layer shows unmasked.
- `invert` is a setting, not a pixel change.
- `outside` ("reveal" or "hide") is the value beyond the stored pixels.
- No manifest version bump.

**Adding.**
- Click the small add icon right of the layer thumbnail. This selects the layer and adds a mask that reveals everything (all black).
- With a selection active, the mask shows only the selection. This works with inverted selections too, and bounds grow to cover the selection.
- Alt+click adds a mask that hides everything (all white).
- Adding targets the new mask.
- Adding is one undo step, and the icon becomes the mask thumbnail.

**Thumbnail interactions.**
- **Click:** edit the mask. It targets the mask, selects the layer and turns Quick Mask off.
- **Shift+click:** toggle enabled. A disabled mask shows a red X and the layer shows unmasked. Not undoable.
- **Alt+click:** show the mask alone in the stage as grayscale, and edit it. Alt+click again ends the view.
- **Ctrl+click:** soft selection of the mask's shown (black) part. Ctrl+Shift adds, Ctrl+Alt subtracts, Ctrl+Shift+Alt intersects. It honours invert and `outside`. An empty result gives the note "The layer mask shows nothing." It is the inverse of a cmask's Ctrl+click, so selection → add mask → Ctrl+click round-trips.
- **Layer thumbnail click** (when a mask exists): edit the layer's pixels. The target is per layer and session-only. Other row clicks keep the current target. A frame marks the targeted thumbnail.

**lmask-only view** (`layerMasks.view`):
- It draws only the mask, in grayscale, over the normal background. All cmask overlays are hidden.
- It follows the active layer while that layer targets its lmask. It ends when:
  - the active layer has no lmask, or targets its pixels, or is a text layer
  - Quick Mask turns on (`Q`, the rail button, or any cmask row click)
  - the layer or mask is deleted
  - the Background row is clicked
  - the same thumbnail is Alt+clicked again
  - the layer thumbnail is clicked
- Clicking another layer's lmask thumbnail, or a row whose target is its lmask, moves the view there.
- While in the view, the viewed lmask is editable even if the layer is eye-hidden or solo-hidden. Lock still refuses. Outside the view a hidden layer's lmask is refused like its pixels.
- Bucket and wand sample only the viewed mask, as grayscale, whatever the Sample option says.
- Paste and drop go into the viewed lmask (see Clipboard).

**Options bar while an lmask is targeted** (any tool; hidden during a Free Transform session). It appends:
- a "Layer Mask:" label
- "Invert mask" toggle (a setting, undoable)
- "Apply"
- "Delete mask" (trash icon, undoable)

**Apply.** It bakes the mask, as it acts (invert and `outside` applied), into the layer's alpha and removes the mask. It is one undo step.
- It runs the edit gate with kind "whole", so a hidden or locked layer is refused. Even in the lmask view, a hidden layer is refused.
- It also bakes a disabled mask.

**Swatches and keys.** While an lmask is targeted, the FG/BG squares show black/white mask swatches instead of the colours.
- The default is white foreground, black background.
- `X` swaps them; `D` resets to white over black. Clicking a swatch square does nothing.
- The real FG/BG are untouched and return when the target leaves the mask.
- The swatch state is per editor and session-only.

**What each tool does while an lmask is targeted.**

| Tool / command | Behaviour |
|---|---|
| Brush | Paints the foreground mask swatch. White hides (white paint). Black reveals (erase). Size, hardness, opacity, flow, spacing and pressure apply. The real colour is ignored. |
| Eraser | Always reveals. |
| Bucket | Floods per the sampling rules below. It writes the foreground swatch into the flooded area at the tool opacity. Anti-alias "behind" is off. |
| Magic wand | Samples per the rules below. |
| Eyedropper, including the Alt temporary eyedropper in brush/bucket/shapes | Refused with a note. |
| Line, Arrow, Rectangle, Ellipse | Refused with a note. |
| Text | Not blocked. It creates or edits a normal text layer and does not touch the lmask. |
| Selections | Clip mask painting as usual. Delete reveals. Alt+Backspace **and** Ctrl+Backspace hide (the swatches are ignored). |
| "To mask" button | Adds to the current **cmask**, not the lmask. |

**Sampling rules (bucket and wand).**
- In lmask-only view: the viewed mask only, as grayscale.
- Otherwise "Current layer" means the layer's raw pixels, lmask not applied. "All layers" means the visible composite with lmasks applied. "Background" means the image only.

**Carry rules.**
- **Whole-layer Move, Free Transform and Flip** carry the lmask with the layer. Moves and flips are exact. A transform keeps its own kept-original for the mask. The vacated or exposed area gets `outside`. Each is one undo step.
- **Selection floats** follow the target. With the layer's pixels targeted, the lift takes the pixels only and the lmask stays put. With the lmask targeted, the lift takes the mask's own pixels as opaque grayscale. They replace what they land on (`d(1−c)+v·c`). The vacated area reveals.

**Merge Down:** see the Merge Down section above.

**Clipboard.**
- With the pixels targeted, copy takes the masked result (layer × the shown part of an enabled lmask). Cut clears the layer's pixels only.
- With the lmask targeted, copy gives opaque grayscale of the mask, and cut reveals.
- Paste always creates a new paint layer, **except** in the lmask-only view. There, every paste or drop goes into the viewed lmask as an lmask float: luminance × alpha, raw values, lmask Invert ignored so copies round-trip, normal placement. An oversize paste goes into Free Transform. The dropped selection joins the step.

**Persistence and undo.**
- Add, delete, invert, Apply and strokes/fills are undoable. The mask has its own store key, so its patches are ordinary dirty-rect patches.
- Not undoable: enable toggle, target, view, swatches.
- It uploads like a cmask (PNG).
- Clear removes all lmasks, and undoing the Clear brings them back.
- Duplicate copies the lmask with the layer.

Files: `engine/layerMask.ts`, `layerMaskOps.ts`, `layerMaskCarry.ts`, `pixelOps.ts`, `paintOps.ts`, `selectionOps.ts`, `clipboardOps.ts`, `layerFlip.ts`, `mergeDown.ts`, `tools/layerMaskBar.ts`, `tools/eyedropper.ts`, `ui/layerMaskThumb.ts`, `swatches.ts`, `hostSync.ts`, `document/layerMask.ts`.

---

## Colour

- **FG/BG state:** `ColorState`, defaults black/white. It is per editor session: it survives tab switches and graph-undo hand-offs, and a fork copies it. It is never saved in the document, and a reload resets it. Values are normalized lowercase `#rrggbb`.
- **Swatches** (bottom of the rail): FG top-left, BG bottom-right, a swap arrow and a reset icon.
  - Click a square to open the picker. Tooltips: "Foreground color (X swaps)", "Background color (X swaps)".
  - Click the swap arrow = `X`, and the reset icon = `D`. Tooltips: "Swap colors (X)", "Default colors (D)".
  - Under Quick Mask (cmask target), the swatches are greyed and dimmed. FG/BG still don't apply.
  - With an lmask targeted, the swatches switch to the black/white mask swatches, with different tooltips (see Messages).
- **Where FG/BG are used:**
  - Brush, bucket and eyedropper write the foreground.
  - Shapes: the stroke is FG. Fill-only shapes use FG; stroke+fill shapes fill with BG.
  - Text uses FG as its colour. Changing FG while a text edit is open recolours it. Re-editing a text layer loads its colour into FG.
  - Alt+Backspace fills with FG and Ctrl+Backspace with BG (colours ignored on cmask and lmask targets).
- **Picker** (`openColorPicker`, anchored popover, about 200 px wide, inside the editor root so fullscreen carries it):
  - An optional title ("Foreground", "Background", or "Mask colour").
  - A saturation/value square (drag with pointer capture).
  - A hue slider.
  - A hex field, shown without `#` and in upper case, `maxLength` 7.
    - It accepts 3 or 6 digits, with or without `#`.
    - Typing applies live. Invalid input shows a `cps-invalid` class. Enter or blur applies a valid value, or reverts the field to the last valid colour.
    - Enter applies and blurs but **does not close** the popover.
  - An old/new preview. Clicking the old half resets to the colour the picker opened with.
  - Up to 10 recent colours (localStorage key `PainterSketch.recentColors`). They are saved when the picker closes with a colour different from the one it opened with, not from the eyedropper. They are shared with the mask-colour picker. Clicking one applies it.
  - **Live update:** every drag or keystroke calls `onInput`. A click outside closes and commits. Pointer and wheel events don't leak to the graph. Esc is meant to revert (see Mismatches 6).
  - No alpha, no numeric HSV fields.
- **Eyedropper** (I):
  - Click or drag samples into FG. Alt+click in the eyedropper itself samples into BG.
  - Alt held in brush, bucket or shape tools turns on a temporary eyedropper that always writes FG. It is **not** active in the eraser, text, move or selection tools.
  - Options: Sample (current layer / all layers (default) / background) and Size (point / 3x3 / 5x5 average).
  - A loupe ring shows the sampled colour and the previous one while dragging. A fully transparent sample leaves the colour unchanged.
  - It always samples colours, including under Quick Mask. "Current layer" is the active **paint** layer's raw pixels.
  - It is refused on a targeted lmask.
  - The bucket and wand defaults come from settings and are separate from the eyedropper's.

Files: `engine/colors.ts`, `ui/swatches.ts`, `colorPicker.ts`, `hsvControls.ts`, `colorMath.ts`, `recentColors.ts`, `hostSync.ts`, `editorHost.ts`, `tools/eyedropper.ts`, `tools/text.ts`, `boxShapeTool.ts`, `lineTool.ts`, `engine/layerMaskOps.ts`.

---

## Undo and redo

- **Model.** `HistoryStack` has an undo stack and a redo stack. They share one **256 MB** byte budget (`DEFAULT_HISTORY_BYTES`).
  - Each entry reports its bytes. When the total exceeds the cap, the oldest undo entries are dropped silently, down to one. The newest entry is always kept even if it alone exceeds the cap.
  - A new push clears the redo stack.
  - History lives with the editor session. It survives tab switches. It is not saved and not copied by forks. **Graph undo never rolls back paint.**
- **Entry types:**
  - `patch`: dirty rect, before and after pixels, in document coordinates. Used for strokes, fills, floats, cut and lmask edits.
  - `layers`: add, remove (pixels and lmask kept), move, and props (name, opacity, colour, invert).
  - `translate`: a lossless layer move, no pixels stored.
  - `text`: text edits, text moves, rasterize.
  - `layerMask`: lmask add, delete or invert.
  - `selection`: before and after coverage.
  - `outputs`: region and Main metadata.
  - `clear`: full snapshots before and after.
  - `group`: several entries as one step.
- **Merging and joining:**
  - Property edits with the same gesture key merge: a scrub, a picker session, or consecutive arrow nudges.
  - A merged gesture that ends where it started leaves no step.
  - `joinNext` and `joinSince` fold related pushes into one step. Examples: rasterize plus the next edit, an inserted image's layer add plus its transform commit, a float plus its mask carry.
- **Not undoable:** layer eye, background eye, lock, solo, active layer, Quick Mask and current mask, lmask enable, target, view and swatches, FG/BG, placement (Move drawing), view pan/zoom, Match image resolution, and Image/Input Mask source changes.
  - Match image resolution clears the history. Frame adoption on an empty document drops it, unless a Clear step exists; then the steps after the Clear are truncated.
  - A removed layer's re-insertion keeps its live non-undoable state (visible, locked, file).
- **Buttons.** Rail Undo ("Undo (Ctrl+Z)") and Redo ("Redo (Ctrl+Shift+Z)") are always visible.
  - Undo is enabled when the history has an entry, or a float or transform session is active, and no stroke is in progress.
  - Redo is enabled when redo is available and no float or transform session is active, and no stroke is in progress.
- **Special cases:**
  - While a float or transform is active, Undo **cancels** the float and Redo is ignored.
  - Undo during an unfinished Move drag, or an open region gesture, cancels that gesture instead of popping history.
  - Undo with an open text edit commits it first, then undoes it. A no-op edit just closes.
  - Undo and redo are no-ops during a stroke.

Files: `engine/history.ts`, `editorTypes.ts`, `paintOps.ts`, `layerHistory.ts`, `layerOpsHelpers.ts`, `layerList.ts`, `editor.ts`, `ui/toolRail.ts`, `shortcuts.ts`.

---

# B. Shortcuts found

| Keys / click | Context | Action | File:line |
|---|---|---|---|
| Ctrl+Z | editor owns keyboard | Undo (cancels a float/transform) | `ui/shortcuts.ts:80` |
| Ctrl+Shift+Z, Ctrl+Y | same | Redo (ignored while floating) | `shortcuts.ts:81` |
| Q | same | Toggle Quick Mask | `shortcuts.ts:121-125` |
| X | same | Swap FG/BG, or the mask swatches when an lmask is targeted | `shortcuts.ts:126-129` |
| D | same | Reset FG/BG to black/white, or mask swatches to white over black | `shortcuts.ts:130-132` |
| Ctrl+E | same | Merge Down | `ui/floatShortcuts.ts:35-41` |
| Ctrl+Alt+T | same | Free Transform (carries an lmask) | `floatShortcuts.ts:42-49` |
| Enter / Esc | while floating or transforming | Commit / cancel | `floatShortcuts.ts:51-63` |
| Esc | otherwise | Cancel tool drag → close popover → exit fullscreen | `shortcuts.ts:70-72` |
| Delete / Backspace | selection exists | Clear selected on the target (lmask: reveal; cmask: remove coverage) | `ui/selectionShortcuts.ts:36` |
| Delete / Backspace | no selection | Swallowed (no graph delete) | `selectionShortcuts.ts:37` |
| Alt+Backspace | selection | Fill with FG (cmask/lmask: hide/add white, colour ignored) | `selectionShortcuts.ts:34` |
| Ctrl+Backspace | selection | Fill with BG (lmask: hides; cmask: adds coverage, colour ignored) | `selectionShortcuts.ts:35` |
| Ctrl+C / Ctrl+Shift+C / Ctrl+X | editor | Copy / copy merged / cut (lmask aware) | `ui/clipboardShortcuts.ts:52-59` |
| Ctrl+V / Ctrl+Shift+V | editor | Paste (into the lmask in lmask-only view) / paste in place | `clipboardShortcuts.ts:36-51` |
| Alt held | brush, bucket, shapes | Temporary eyedropper (refused on an lmask) | `tools/registry.ts:221` |
| Ctrl held | rail tools except Text, Move layer, hidden tools | Temporary Move layer with auto-select | `registry.ts:220`, `moveLayer.ts:92-94` |
| Click | Layers row (paint/cmask/Image Mask) | Select | `ui/layerRow.ts:183-188`, `layersPanel.ts:327-335` |
| Ctrl+click (+Shift / +Alt / +Shift+Alt) | row | Load selection, mode replace / add / subtract / intersect | `layerRow.ts:185`, `moveCursors.ts:128` |
| Double-click name | paint/cmask rows (not with Ctrl) | Inline rename | `layerRow.ts:189-192` |
| Enter / Esc / blur | rename field | Commit / cancel / commit | `ui/inlineRename.ts:31-41` |
| Drag row | paint/text/cmask rows (not with Ctrl) | Reorder within group | `ui/layerDrag.ts:65-93` |
| Click layer thumbnail (masked layer) | paint row | Target pixels | `layerRow.ts:151-155` |
| Click add-lmask icon / Alt+click | paint row | Add reveal-all (or selection) / hide-all | `ui/layerMaskThumb.ts:74-77`, `layersPanel.ts:341-345` |
| Click lmask thumbnail | lmask slot | Target mask | `layerMaskThumb.ts:113` |
| Shift+click lmask thumbnail | same | Toggle enabled | `layerMaskThumb.ts:111` |
| Alt+click lmask thumbnail | same | Toggle lmask-only view | `layerMaskThumb.ts:112` |
| Ctrl(+Shift/Alt/Shift+Alt)+click lmask thumbnail | same | Soft selection of the shown part | `layerMaskThumb.ts:108-110` |
| Click eye / solo / lock / swatch / invert | row buttons | Visibility / solo / lock / colour picker / invert | `layerRow.ts:164-168,198-200` |
| Click Background row | panel | Ends the lmask-only view only | `layerRow.ts:178-181`, `layersPanel.ts:329` |
| Click swatch square / swap arrow / reset icon | rail | Picker / X / D (picker ignored in mask mode) | `hostSync.ts:108-123` |
| Click Quick Mask / Undo / Redo / Clear buttons | rail | Q / undo / redo / confirm clear | `hostSync.ts:90-98`, `toolRail.ts:67,85-94` |
| Enter in hex field | picker | Apply and blur | `colorPicker.ts:168-178` |
| Esc | picker | Revert (only when focus is inside the popover; see Mismatches 6) | `colorPicker.ts:247-256`, `popover.ts:109-114` |
| Click outside | picker | Commit (if changed) and close | `colorPicker.ts:228-235` |
| Press on opacity control | header / mask Overlay | Start a new undo gesture | `layerControls.ts:81` |
| Alt+click in the eyedropper tool | Eyedropper tool | Sample into BG | `tools/eyedropper.ts:97` |
| Space / Alt | keyboard scope | Pan / swallow bare Alt | `ui/keyboard.ts:337-351` |
| Tool keys (V, B, E, G, I...) | editor | Switch tools; digits set opacity; `[ ]` size | `shortcuts.ts:93-109,141` |

---

# C. Modifier indicators

| Modifier + click | Where | Effect | Indicator today |
|---|---|---|---|
| Ctrl / +Shift / +Alt / +Shift+Alt | any row (paint/cmask/Image Mask) | Load selection in mode replace / add / subtract / intersect | **Yes.** Hover cursor with marquee badge and `+`/`−`/`×` (`layerSelectHover.ts:41-77`). It tracks keydown and keyup only while the pointer is over the list. Not on the Background row, and not over the row's buttons. |
| Ctrl / +Shift / +Alt / +Shift+Alt | lmask thumbnail | Soft selection of the shown part | **Yes.** Same row cursor (the thumbnail is not a button). The effect differs from the row (soft, inverse polarity) but the cursor is identical. |
| Shift | lmask thumbnail | Toggle enabled | **Partial.** Tooltip only. A red X on the thumbnail is the *state* afterwards, not a hover indicator. |
| Alt | lmask thumbnail | Toggle lmask-only view | **No hover indicator.** Tooltip only. The `cps-viewing` style marks the *state*. |
| Alt | add-lmask icon | Hide-all instead of reveal-all | **No.** Tooltip only (it's a button, so no row cursor). |
| Shift / Alt (alone) | rows, layer thumbnails | None (plain select) | None |
| Alt held | stage, brush/bucket/shapes | Temporary eyedropper | **Yes.** Eyedropper icon cursor (resolved through `tools.resolve`). It does not show whether the Alt will be refused (lmask target). |
| Alt | stage, Eyedropper tool | Sample into BG instead of FG | No distinct indicator. |
| Ctrl held | stage, rail tools | Temporary Move layer with auto-select | **Yes.** Move icon cursor. |
| Ctrl+Alt in brush | stage | Move wins over the eyedropper | Move icon cursor. |
| Ctrl | layer-row drag | Suppresses drag | None |
| Q state / lmask state | stage cursor | Which target the stage tool is hitting | **No cursor badge** for cmask or lmask targets, nor a "refused" state. Only the "Mask" badge in the options bar, the rail button tint, and the swatches/options bar. |

---

# D. Messages

**Notes** (bottom-of-stage note, 5 s; each fires on the trigger shown).

| Text | Trigger | Source |
|---|---|---|
| `Layer is locked.` | Pixel edit on a locked layer | `engine/editorTypes.ts:198` |
| `The layer is hidden.` | Edit on an eye-hidden paint/text layer | `editorTypes.ts:204` |
| `The mask is hidden.` | Edit on an eye-hidden cmask (incl. Image Mask). Also at queue when any hidden cmask has ever held paint. | `editorTypes.ts:222`, `widget/uploadScheduler.ts:59-60` |
| `The layer is hidden by solo.` | Edit on a layer another solo hides | `editorTypes.ts:207` |
| `Image Mask can't be edited — duplicate it to edit.` (name = `Image Mask` / `Input Mask`) | Any pixel edit, merge, or move with the Image/Input Mask as current | `editorTypes.ts:214-216` |
| `Nothing to merge down into.` | Ctrl+E with no valid row below | `engine/mergeDown.ts:40` |
| `Layer mask applied.` | Merge Down with an enabled upper lmask | `engine/layerMaskCarry.ts:42` |
| `Layer mask: use the brush, eraser or fill.` | Shapes or line on a targeted lmask | `engine/layerMask.ts:48` |
| `Layer mask: black and white only, no eyedropper (X swaps).` | Eyedropper or Alt eyedropper on an lmask | `layerMask.ts:51`, `tools/eyedropper.ts:93-95` |
| `The layer mask shows nothing.` | Ctrl+click on an all-hidden lmask thumbnail | `layerMaskOps.ts:37` |
| `The layer has no pixels.` | Ctrl+click on an empty layer or empty Image Mask | `selectionOps.ts:55` |
| `Nothing is selected.` | "To mask", fill or clear selection with no selection | `selectionOps.ts:53` |
| `The layer is empty.` | Flip or transform on an empty layer | `engine/layerFlip.ts:24` |
| `No pixels are selected.` | Move with a selection on an empty layer | `engine/floatLift.ts:36` |
| `This layer can't be moved.` | Move on a kind with no mover | `engine/layerMovers.ts:55` |

**Confirms.**

| Text | Trigger | Source |
|---|---|---|
| `Rasterize text layer? It will no longer be editable as text.` | Pixel edit, merge, or lmask add on a text layer | `rasterize.ts:28` |
| `Clear all paint, regions and output options? This can be undone.` | Rail Clear | `ui/hostSync.ts:306` |
| `Resample all layers to the current image resolution? This clears the undo history.` (+ `\n\nSome paint far outside the image exceeds the 16384 px paint-area limit and will be cropped.`) | Match image resolution | `ui/resolutionNotice.ts:23-26` |

**Notice and toasts.**

| Text | Trigger | Source |
|---|---|---|
| `Drawing grid {G} px — image {I} px ({N.N}x)` | Mismatch label | `resolutionNotice.ts:87` |
| `The image's shape doesn't fit the drawing — parts can't be painted.` | Fit label and toast lead | `resolutionNotice.ts:20` |
| (warn toast) `The image is {N.N}x the drawing's resolution — use Match image resolution for full detail.` | First mismatch per doc per session | `resolutionNotice.ts:100` |
| (warn toast) `{fit label} Use Match image resolution to fix it.` | First fit problem per doc per session | `resolutionNotice.ts:104` |
| (warn toast) `The saved painting has 1 layer entry / N layer entries that could not be read; loaded the rest (details in the console).` | Parse skipped malformed layers | `widget/failures.ts:192-195` |

**Hint line.** `Run the workflow to load this mask` appears under the Input Mask row while waiting for a run (`imageMaskRow.ts:43`).

**Key tooltips tied to behaviour.**
- Image Mask: "From the image's transparency. A connected mask input will replace it."
- Input Mask: "From the connected mask input (it replaces the image's transparency; disconnect it to use that again)."
- lmask thumbnail: "Layer mask: click to edit it; Shift+click off/on; Alt+click view it alone; Ctrl+click select its shown (black) part (+Shift add, +Alt subtract)"
- Add-lmask icon: "Add layer mask (reveals all, or shows only the selection; Alt+click hides all)"
- Lock: "Lock layer (refuses painting)" / "Unlock layer"
- Eye (paint): "Hide layer" / "Show layer"
- Eye (cmask): "Hide mask (also excludes it from the MASK output)" / "Show mask (hidden masks are excluded from the MASK output)"
- Eye (Background): "Hide background (shows transparency; outputs use the background colour instead of the image)" / "Show background (input image)"
- Solo: "Solo: show only this layer in its group (view only)", "End solo (view only)", "Solo the background: hide all paint layers (view only)"
- Mask swatch: "Mask colour (display only)"; mask invert: "Invert mask" / "Mask inverted (click to un-invert)"
- Overlay control: "Mask overlay opacity (display only)"
- Footer: "New layer (above the active layer)", "New mask (above the current mask)" / "At most 7 masks", "Duplicate layer", "Merge Down (Ctrl+E)", "Delete layer", "Delete mask", "The last mask can't be deleted (clear it instead)", "The Image Mask can't be deleted (it follows the image's transparency)" / "...the mask input", "Move drawing — reposition/scale all layers against the image"
- Options bar: "Strokes edit the layer mask (white hides, black reveals)", "Invert the layer mask (a setting; pixels are kept)", "Apply the layer mask: bake it into the layer's pixels and remove it (undoable)", "Delete the layer mask (undoable)"
- Mask swatches (mask mode): "Layer mask foreground: white hides, black reveals (X swaps)", "Layer mask background (X swaps)", "Swap mask black / white (X)", "Default mask swatches: white / black (D)"
- Picker: "Click to revert to original colour" (old half), "Click left half to revert to original colour" (preview wrapper)

---

# E. Mismatches

| # | Old spec says | Code does | File:line | My read |
|---|---|---|---|---|
| 1 | M8 names "lowest free number, like 'Layer N'" (SPEC 641) | "Layer N" = highest+1; "Mask N" = lowest free | `document/layerList.ts:86-98,118-125` | Old text wrong; code intended (Photoshop). |
| 2 | Background solo "masks unaffected unless a mask is soloed too" (SPEC 484-485) | Any solo hides all non-soloed layers in both groups, so masks hide | `engine/solo.ts:43-46` (header doc 1-8) | Old text stale; matches the 2026-09-26 change. |
| 3 | Hidden-mask queue note "The mask is hidden; show it to output it." (SPEC 774) | `"The mask is hidden."` | `editorTypes.ts:222` | Stale; shortened 2026-09-28. |
| 4 | Placement `scale` clamped to [0.05, 20] (SPEC 183) | max 10 | `document/placement.ts:12-15` | Contract stale (decision log notes 20→10). Not my area, but it will be wrong in the rewrite. |
| 5 | lmask view "Alt+click again, or clicking a thumbnail, ends it" (SPEC 562); line 563 says it stays when clicking another lmask thumbnail | Only the same-thumbnail Alt+click, a layer-pixel thumbnail click, or a non-lmask target ends it. Another lmask thumbnail moves the view. | `layerMaskOps.ts:302-311,457-467` | Old spec self-contradicts; code follows 563. |
| 6 | "Picker: ... Esc reverts and closes" (SPEC 259) | Revert is set only by a keydown *inside* the popover. With focus on the key sink (after dragging in the SV square or hue slider), Esc goes through `closePopover` → `popoverHost.close()` with `escaped=false`, so the colour commits. | `colorPicker.ts:244-256`, `popover.ts:109-114`, `shortcuts.ts:70-72`, `editorHost.ts:188-193` | **Likely bug (verify in browser).** The same applies to the mask-colour picker. |
| 7 | colorPicker header comment: commits on "Enter in the hex field" | Enter applies and blurs but doesn't close or commit | `colorPicker.ts:51-55` vs `168-178` | Stale code comment. |
| 8 | "Delete / Alt+Backspace behave as on mask layers" (lmask, SPEC 568) | Delete reveals, Alt+Backspace hides, and **Ctrl+Backspace also hides**. Selection fill ignores the mask swatches, whereas brush and bucket obey them. | `selectionOps.ts:206-212`, `layerMaskOps.ts:529-553` | Unclear. The swatch-ignoring fill may be an oversight. |
| 9 | Options bar "Invert" (SPEC 564) | Label is "Invert mask" | `tools/layerMaskBar.ts:22` | Wording only. |
| 10 | Apply bakes the mask (SPEC 564, 573) | Also bakes a disabled mask (decision log). A hidden layer is refused even in the lmask view (kind "whole"). | `layerMaskOps.ts:211-238`, `layerMask.ts:100-102` | Intended; absent from the old spec. |
| 11 | Clear "resets the document (all layers and masks)" (SPEC 765) | Doesn't remove rows. Empties pixels, drops lmasks, converts text → paint, resets frame/placement/outputs/solo. It doesn't touch selection, the Image Mask, or eye/lock/opacity/names. | `frameOps.ts:102-161` | Wording ambiguous. Selection after Clear **(verify)**. |
| 12 | M10: "Merge Down is Ctrl+E only (no panel button yet)" (decision log) | A footer Merge Down button exists. | `layersPanel.ts:105` | Superseded by the 2026-09-27 entry. |
| 13 | Footer Duplicate generally "Duplicate layer" | Disabled for cmask layers. Works on the Image/Input Mask row instead. | `layersPanel.ts:244`, `imageMaskRow.ts:60-78` | Intended; document it. |
| 14 | "Layer mask ... Other pixel tools (shapes, line, text) refuse with a note" (SPEC 569) | Text does **not** refuse; it creates or edits a text layer | `tools/text.ts:202,269` | Intended (text doesn't paint on the lmask). Clarify in the rewrite. |
| 15 | "Hidden layer can be soloed (shown while soloed)" (SPEC 649) | It is shown, but editing still hits the eye-hidden note first | `rasterize.ts:69-79,90-94` | Consistent with the rule; "Maybe" in M7b notes it as an open idea. |
| 16 | M7b step 2 plans "lmask thumbnail Alt = eye-in-square, Shift = red X" indicators | Not implemented. Only tooltips and the post-hoc red X state exist. | `layerMaskThumb.ts:72-83` | Planned work, not a bug. |
| 17 | Recents: "max 10, persisted in localStorage" | True, but written only on picker close with a changed colour. The mask-colour picker shares the list. | `colorPicker.ts:229-235`, `recentColors.ts:37-47` | Fine; document the exact rule. |
| 18 | Image-Mask hidden note at queue covers "any hidden mask with content" | Counts only `doc.layers` cmasks, not the Image Mask row. It uses a "ever held paint" flag. | `editorMaskOps.ts:45-47` | Fine; document it. |