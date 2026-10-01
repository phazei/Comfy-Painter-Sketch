# Tools: verified spec text and audit

Everything below is read from the code in `ui/src/tools/**`, `ui/src/engine/*` and `ui/src/ui/*`. Where I could only infer a behaviour, I say so.

---

# A. Spec section "Tools"

## A.0 Common mechanics

**Rail order and keys** (`registry.ts:243-267`). Hidden tools are not on the rail and have no key.

| Rail slot | Tool id(s) | Key |
|---|---|---|
| Brush | `brush` | B |
| Eraser | `eraser` | E |
| Paint bucket | `bucket` | G |
| Eyedropper | `eyedropper` | I |
| Shape group: Line, Arrow, Rectangle, Ellipse | `line`, `arrow`, `rectangle`, `ellipse` | U (Shift+U cycles) |
| Text | `text` | T |
| Move layer | `move-layer` | V |
| Marquee group: Rectangular, Elliptical | `marquee-rect`, `marquee-ellipse` | M (Shift+M cycles) |
| Lasso | `lasso` | L |
| Magic wand | `wand` | W |

- Below the tool slots the rail has the Quick Mask button (Q), then Copy/Cut/Paste/Images, then Undo/Redo/Fit/Clear/Fullscreen.
- Hidden tools:
  - `move` is Move drawing, toggled from the layers-panel footer.
  - `region` is activated by the Outputs tab or O.
  - `transform` is the Free Transform session tool and is never "active".
  - `selection-outline` is substituted at pointer-down.

**Tool groups** (`toolGroups.ts`, `toolGroupSlot.ts`)
- A group shares one rail slot, which shows the group's last-used member (initially the first).
- Clicking the slot selects that member.
- A 400 ms long-press or a right-click opens a flyout to the right. Each entry shows icon, label and key.
- The key activates the last-used member. Shift+key advances to the next member and wraps. If the active tool is outside the group, it advances from the last-used member.
- Slot tooltip: `Shape (U, Shift+U cycles)`.
- Single-tool tooltip: `Label (KEY)`.

**Tool resolution at pointer-down** (`ToolRegistry.resolve`, `registry.ts:214-222`). The result is locked for the whole drag. Changing Ctrl/Alt mid-drag does not swap tools.
1. A Free Transform session wins over everything.
2. A plain press (no Shift, Alt or Ctrl) inside the selection, with a selection tool (`combinesSelection`: marquees, lasso, wand) that is not mid-polygon, becomes an outline drag (see A.14).
3. Ctrl (or Cmd) gives the temporary layer Move tool, but only if the active tool is on the rail, has not set `ctrlMove: false`, and has no pending interaction.
   - Opted out: Text, Move layer, and the hidden tools Move drawing, Region and Transform.
   - A lasso with an open polygon is also exempt.
4. Alt gives the temporary eyedropper, only for tools with `altEyedropper`: Brush, Bucket, Line, Arrow, Rectangle, Ellipse.
5. Otherwise the active tool.

Ctrl beats Alt, so Ctrl+Alt in the brush is Move (with copy semantics), not the eyedropper. Modifier tracking only updates cursors. Pan (middle-drag, or Space+left-drag) is handled before any tool (`stageInput.ts:176`).

**Options model**
- Options are declarative descriptors (number, toggle, select, button, text, label), rendered generically by the options bar.
- Each tool instance holds its own values for the whole session. Brush and Eraser are separate, and so are Line, Arrow, Rectangle and Ellipse.
- Setting-backed defaults (pressure, bucket sample, wand sample) are read once when a session's tools are created. Bar changes win. Settings never touch live tools.
- Number fields show display units with a `scale` to the stored value. Sliders use a pow-2 curve when `curve: "pow"`.
- Bar decorations:
  - While a lmask is the target, every tool's bar gets a `Layer Mask:` caption plus Invert mask, Apply and Delete mask (`layerMaskBar.ts`).
  - Move layer, and the selection tools while a selection exists, get Transform / Flip H / Flip V buttons (`transformTool.ts:294`).
  - A running Free Transform session replaces the whole bar.
  - Whenever a selection exists, the leading area shows "To mask" and "Invert".
  - Quick Mask shows a "Mask" badge.

**Paint targets** (`document/masks.ts`, `paintOps.ts:94`, `layerMask.ts`)
- The default paint target is `findPaintLayer`. It is the active layer if that is not a mask, and may be a text layer. Otherwise it is the topmost paint layer.
- Quick Mask (Q) retargets pixel tools to the current cmask.
- A lmask target, when the active paint layer has a lmask and its target is the lmask, is only possible with Quick Mask off.
- Cmask strokes paint white coverage in alpha, whatever the foreground colour.
- Lmask strokes use `maskStrokeStyle`:
  - The eraser always reveals.
  - The brush paints white (hide) if the foreground mask swatch is white, otherwise it erases (reveals).
  - Size, hardness, opacity and flow are honoured.

**The pixel-edit gate** (`rasterize.ts:106`, `preparePixelEdit`). Every pixel edit calls it. It first settles any floating selection. It then refuses with a note in this precedence:
1. Image/Input Mask row.
2. Eye off.
3. Hidden by another layer's solo.
4. (kind `other` on a targeted lmask) the lmask-tool note.
5. Locked.

Exception: in lmask-only view, the viewed layer's lmask is editable even if the layer is hidden or solo-hidden. Lock still refuses. For a text layer it then shows the rasterize `window.confirm`:
- Strokes and shapes: if the user agrees, the layer is rasterized but the press is aborted. The next stroke joins the rasterize undo step.
- Bucket: if the user agrees, the fill continues in the same call.
- Floats: the confirm runs after the gesture has ended (`takeDeferred`).

**Notes**
- Notes are stage notes (`StageView.showNote`): one text, bottom of the stage, 5 s, replaced by the next one.
- They are not `notify` toasts and are not rate-limited.

**Selection clip**
- Brush, eraser, shapes and bucket are clipped to the selection coverage. Partial coverage scales the result.
- Bounds growth is limited to a normal selection's bbox. An inverted selection has no limit.

**Pointer samples**
- Samples are coalesced events converted to document coordinates through the frame map. Every tool receives them.
- `pressure` is `normalizePressure`: only `pointerType === "pen"` reports pressure; mouse and touch are 1.
- Sizes in options are image px. Tools convert with `imageLengthToDoc(frameMap, v)` (`/ map.scale`) at pointer-down.
- Modifier flags are read from each sample. While a tool drag is active, Shift/Alt/Ctrl key changes re-send the last sample with the new flags (`dragModifiers.ts`).

## A.1 Brush (B)

**Options** (`PAINT_OPTION_DESCRIPTORS`, `paintTool.ts:23`):

| Key | Label | Range | Default |
|---|---|---|---|
| `size` | Size | 1–1000 px, step 1, pow curve | 24 |
| `hardness` | Hard | 0–100 % | 80 % |
| `opacity` | Opac | 1–100 % | 100 % |
| `flow` | Flow | 1–100 % | 100 % |
| `spacing` | Spc | 1–400 % of diameter | 25 % |
| `pressureSize` | Size (pressure group) | toggle | setting `PainterSketch.PressureSize`, built-in on |
| `pressureOpacity` | Opacity (pressure group) | toggle | setting `PainterSketch.PressureOpacity`, built-in off |
| `minSize` | Min size (pressure group) | 0–100 %, enabled only if `pressureSize` | setting `PainterSketch.PressureMinSize`, built-in 10 % |
| `gamma` | Curve γ (pressure group) | 0.2–5, step 0.05, enabled if either toggle is on | setting `PainterSketch.PressureGamma`, built-in 1 |

- The four pressure options sit behind one stylus button, which is tinted when either toggle is on.
- The colour is the editor's foreground colour.

**Pointer behaviour**
- Pointer-down reads Shift, then calls `beginStroke`:
  - The stroke size is fixed in document px for the whole stroke.
  - If the gate refuses, nothing happens.
  - A text-layer rasterize prompt aborts the press.
- Each coalesced sample goes through `placeDabs` and then `editor.addDabs`. Pointer-up feeds a final sample and `endStroke(end)`.
- A click with no movement is one dab.
- **Shift+click at pointer-down.** If the editor has a `lastStrokeEnd`, the stroke is a straight line from there.
  - It is its own stroke and its own undo step, composited over the previous one.
  - Its spacing starts at the previous stroke's spacing residual with no dab at the joint, so at 100 % opacity it is pixel-identical to one continuous stroke.
  - Shift mid-drag does nothing.
  - With no `lastStrokeEnd`, Shift is ignored and the stroke is a normal click.
  - Shape tools do not set `lastStrokeEnd`.
- `lastStrokeEnd` is editor-wide, in document coordinates. It is shared by Brush and Eraser and survives layer switches.
- It is reset by Clear, Match image resolution, and undo/redo of a Clear.
- Esc or pointer-cancel calls `cancelStroke` and the layer is untouched.

**Per target**
- Paint layer: normal stroke.
- Text layer: rasterize prompt, press aborted.
- Cmask under Quick Mask: white coverage, mode paint.
- Lmask: see A.0.
- Image/Input Mask row: refused.
- Hidden, solo-hidden or locked layers: refused with a note.
- A hidden layer's lmask is editable only in lmask-only view.

**Modifiers**
- Alt at pointer-down gives the temporary eyedropper. On a lmask target that is refused with a note.
- Ctrl at pointer-down gives temporary Move.
- Caps Lock: nothing. Photoshop's "precise cursor" is not implemented.

**Cursor:** CSS `crosshair` plus an overlay size ring (see C).

Files: `tools/brush.ts`, `tools/paintTool.ts`, `engine/paintOps.ts`.

## A.2 Eraser (E)

- Same class as Brush (`PaintTool`, mode `erase`): same options and ranges.
- Defaults differ: size 48, hardness 80 %, opacity 100 %, flow 100 %, spacing 25 %. Pressure defaults come from the same settings.
- The stroke is composited with `destination-out` at the stroke opacity.
- Shift+click lines work the same.
- Not an Alt eyedropper (`altEyedropper` false), as in Photoshop. Ctrl gives Move.
- On a cmask it erases coverage. On a lmask it always reveals.

Files: `tools/eraser.ts`, `tools/paintTool.ts`.

## A.3 Paint bucket (G)

**Options** (`fill.ts:35`):

| Key | Label | Range / values | Default |
|---|---|---|---|
| `tolerance` | Tol | 0–255 per channel, no unit | 32 |
| `opacity` | Opac | 1–100 % | 100 % |
| `contiguous` | Contiguous | toggle (mode group) | on |
| `antiAlias` | Anti-alias | toggle (mode group) | on |
| `sample` | Sample | Current layer / All layers / Background (sample group) | setting `PainterSketch.BucketSample`, built-in `background` |

**Pointer behaviour**
- A click calls `pixelOps.fill`. Drag, Shift and Ctrl do nothing special.
- `fill` returns early on loading or an active stroke.
- The target layer is the current cmask under Quick Mask, otherwise the paint target.
- The gate runs with kind `paint`. A text-layer fill continues immediately after a rasterize "OK".
- The seed is `floor(point)`. The click must be inside the image rect or the current bounds, otherwise nothing happens (no note).
- Bounds are grown to cover the whole image rect first.
- Matching is described in A.16. The fill is clipped by selection coverage. The result is one dirty-rect undo patch. No change means no step.
- With anti-alias, the fill also goes behind the target layer's own soft edges (`fillUnder.ts`, not on masks), so filling around a stroke leaves no halo.
- On a cmask the fill writes white coverage at the opacity.
- On a targeted lmask it applies the foreground mask swatch to the flooded area:
  - White blends white at the opacity.
  - Black erases (reveals) by `coverage × opacity`.

**Modifiers:** Alt gives the eyedropper, Ctrl gives Move.

**Cursor:** SVG bucket icon, hotspot (19, 20).

Files: `tools/fill.ts`, `engine/pixelOps.ts`, `engine/floodFill.ts`, `engine/fillUnder.ts`.

## A.4 Eyedropper (I)

**Options:**

| Key | Values | Default |
|---|---|---|
| `sample` | Current layer / All layers / Background | `all` (no setting) |
| `size` | Point / 3x3 average / 5x5 average | `1` |

**Pointer behaviour**
- Pointer-down picks. Every move re-picks. Release picks once more.
- The colour goes to the foreground, written live (not on release).
- **Alt held at pointer-down with the eyedropper itself** targets the background colour instead.
- The temporary eyedropper (Alt in another tool) always writes the foreground. It shares the eyedropper's option values.
- A fully transparent sample, or an off-layer sample, leaves the colour unchanged.
- The average is alpha-weighted. Transparent pixels don't contribute.
- Quick Mask does not matter; it always picks colours.
- `Current layer` uses the paint target layer (`targetLayer(doc, "paint")`), even under Quick Mask. With no paint layer it samples nothing.
- It does not check hidden or locked state.
- **On a targeted lmask** (pixel-wise: `editor.layerMask.targeted`) it is refused with a note. This applies to the temporary one too.
- Esc during a pick drops the loupe. The colour stays at the last sample (no revert).
- Overlay: a loupe ring around the pointer while picking (see C).

Files: `tools/eyedropper.ts`, `engine/pixelOps.ts:311`, `ui/loupe.ts`.

## A.5 Line and Arrow (U group)

**Options** (`lineTool.ts:25`):

| Key | Label | Range | Default |
|---|---|---|---|
| `width` | Width | 1–500 px, pow curve | 4 |
| `opacity` | Opac | 1–100 % | 100 % |
| `heads` | Arrow (select: None / End / Both) | | Line: `none`; Arrow: `end` |
| `headSize` | Head | 150–1500 % of width, step 10 | 400 % |

**Drag model** (`shapeTool.ts`)
- Pointer-down opens a stroke (`beginStroke` with `shape: true`, hardness 1) and stores the start, the width in document px and the fg/bg colours.
- Every move rebuilds the whole shape from the start and the current sample, as a live preview in the stroke buffer.
- Release rasterizes it as one undo patch at the tool opacity. Opacity is applied once, so a fill and its stroke never stack alpha.
- Esc, tool switch or pointer-cancel drops it.
- A zero-length shape commits nothing.
- Shapes do not set `lastStrokeEnd`.

**Line behaviour**
- Shift snaps the angle to 15° steps, keeping the length. It is read on every sample, so it works mid-drag.
- Alt at pointer-down gives the eyedropper. Alt during the drag is ignored for lines.
- Round caps.
- Arrowhead length is `width × headSize`, capped at 90 % of the line length divided by the head count. The half-width is 0.4 × length. The shaft stops at the head base.
- Colour is the foreground.

**Targets**
- Paint layer: the shape is painted.
- Cmask under Quick Mask: white coverage.
- Text layer: rasterize prompt.
- Targeted lmask: refused with `LAYER_MASK_TOOL_NOTE`.

Files: `tools/lineTool.ts`, `tools/shapeTool.ts`, `tools/shapeTools.ts`, `engine/shapes.ts`, `engine/shapeRender.ts`.

## A.6 Rectangle and Ellipse (U group)

**Options** (`boxShapeTool.ts:25`):

| Key | Label | Values | Default |
|---|---|---|---|
| `paint` | Mode | Stroke / Fill / Both | Stroke |
| `width` | Width | 1–500 px, pow curve | 4 |
| `opacity` | Opac | 1–100 % | 100 % |

- Drag model is the same as A.5.
- Stroke and fill-only use the foreground. "Both" strokes with the foreground and fills with the background.
- The stroke is centred on the box edge and drawn over the fill. Corners are mitred.
- Rectangle edges are rounded to whole px, with a +0.5 offset for odd stroke widths, so the stroke is crisp. The ellipse is anti-aliased.
- Shift gives a square or circle (the larger side wins).
- **Alt pressed during the drag** draws from the centre (start = centre). Alt at pointer-down is the eyedropper.
- Shift and Alt are read per sample, with mid-drag key re-sends.

Files: `tools/boxShapeTool.ts`, `tools/shapeTool.ts`, `engine/shapes.ts`, `engine/shapeRender.ts`.

## A.7 Text (T)

**Options:**

| Key | Label | Range / values | Default |
|---|---|---|---|
| `font` | Font | text-with-suggestions | `sans-serif` |
| `size` | Size | 1–1000 image px, pow curve | 48 |
| `bold` | B (style group) | toggle | off |
| `italic` | I (style group) | toggle | off |
| `align` | Align (style group) | Left / Center / Right | Left |
| `angle` | Angle | −180…180°, step 0.1 | shows the target's rotation |

- `[` / `]` change size.
- Digits 1–9 and 0 do nothing in the text tool (it has no `opacity` option).
- Colour is the foreground.

**Fonts**
- The font menu lists the recent fonts first, then the curated list. De-duplication is case-insensitive.
- Curated list: `sans-serif`, `serif`, `monospace`, Arial, Helvetica, Verdana, Tahoma, Trebuchet MS, Segoe UI, Georgia, Times New Roman, Courier New, Impact, Comic Sans MS.
- There is a "Custom font…" entry that turns the menu into a text field.
- The text option stores a trimmed, whitespace-collapsed name of at most 100 characters.
- Each menu entry is previewed in its own font.
- Recent fonts are the last 5, in `localStorage["PainterSketch.recentFonts"]`. A font is remembered when text is created with it, or when the font option is changed.
- Rendering: CSS generic families are used bare, other names are quoted with a `sans-serif` fallback.

**`textData` fields** (`document/textData.ts`):

| Field | Meaning |
|---|---|
| `text` | Lines separated by `\n`, at most 10000 characters. |
| `x`, `y` | Anchor: baseline of the first line. `x` is its left, centre or right edge, per `align`. Document px. |
| `font` | Family name, at most 100 characters. |
| `size` | Document px, 1–4096. |
| `color` | `#rrggbb`. |
| `bold`, `italic` | Booleans. |
| `align` | `left`, `center` or `right`. |
| `lineHeight?` | Multiple of the font size. Default 1.25, saved only if set, clamped to 10. |
| `rotation?` | Degrees, normalized to (−180, 180], about the unrotated edit box centre. Dropped at 0. |

**Pointer-down** (`text.ts:188`)
1. If Ctrl is held, start a Ctrl+drag move (below).
2. If an edit is open, commit it.
   - If the click is on empty canvas or on the same text, stop. Clicking away only commits and does not create new text.
   - If it is on a different text, open that one.
3. If Quick Mask is on, switch back to the paint target (no type-mask).
4. If the click hits a text layer, re-edit it. Otherwise create new text.
   - Hit test: topmost visible text layer whose (rotated) box, plus a margin of 15 % of the font size, contains the point. A double-click has no special meaning.
   - A hit layer that is locked, hidden or solo-hidden shows the corresponding note and does not open.
   - Creating new text anchors at `round(click)` with the first baseline at the click point.
   - The new text layer is inserted above the active paint layer and made active. It is named "Text" while empty, and by its first ~20 characters on commit.
   - A new text layer takes over its group's solo if solo is on.
   - If a lmask is targeted, creation is refused with `LAYER_MASK_TOOL_NOTE`.

**Editing** (`textOverlay.ts`)
- A `<textarea>` is laid over the stage in document px, mapped through the frame map and the view. The canvas shows the real rendering, and the textarea text is transparent.
- Enter inserts a newline. Esc or Ctrl+Enter commits.
- Ctrl+Z inside the textarea is native text undo.
- Option changes and foreground colour changes apply live to the open edit. Live edits create no history.
- Starting a re-edit loads that layer's style into the options and sets the foreground to the layer colour. This is a side effect on the foreground swatch.
- The edit is `Tool.pending`.
- Commit also happens on tool switch or cancel, the layers-panel hook (`commitTextEdit`), undo, and focus leaving the editor.

**Commit rules** (`textOps.ts`)
- Create plus type is one undo step (the add-layer entry holds the final text).
- Empty text on commit removes the layer. For a new layer no history is kept. For an emptied existing layer, an undoable delete is recorded, unless it is the last paint-like layer, in which case it keeps its old text.
- The layer name follows the text unless the user renamed it.
- Editing an existing text records one text step.
- Stage note when the font is not installed: `Font '<name>' isn't installed; editing will use a fallback.` It is emitted when an edit opens or when the font changes (`document.fonts.check`).

**Ctrl+drag move** (text only; the text tool opts out of the Ctrl→Move swap)
- It commits any open edit, then targets the text under the pointer, else the active text layer, else nothing.
- It switches Quick Mask to paint, activates the layer, and uses `layerMove.begin/preview/commit`. Cursor `move` during the drag.
- Locked, hidden and solo notes come from `layerMove`.
- The move updates the `textData` anchor and never rasterizes.

**Rotation and scale**
- The Angle field shows and sets the rotation of the open edit, else of the active text layer.
  - On an open edit it is applied live.
  - On an unedited layer it records a merged "text-angle" step. Locked and hidden layers show their notes.
- Ctrl+Alt+T on a text layer: rotation and uniform scale go into `textData`, and the layer stays editable text. Details in A.15.

**Rasterize prompt.** Text is `window.confirm("Rasterize text layer? It will no longer be editable as text.")`. It appears when a text layer would be edited as pixels. See A.0 for what happens afterwards.

Files: `tools/text.ts`, `engine/textOps.ts`, `engine/textLayer.ts`, `engine/textRender.ts`, `engine/textTransform.ts`, `document/textData.ts`, `ui/textOverlay.ts`.

## A.8 Move layer (V)

**Option:** `Auto-select` toggle, default off. The bar also shows Transform / Flip H / Flip V.

**What it moves** (`moveOps.ts`)
- The "edit layer" is the active paint or text layer. Under Quick Mask it is the current cmask.
- Paint and cmask layers move by translating pixels. A paint layer's lmask moves with it in the same undo entry.
- Text layers move by shifting the `textData` anchor and re-rendering.
- Deltas are whole document px.
- One drag is one undo entry. The selection outline moves with the layer, in the same step.
- Esc or pointer-cancel aborts the drag.

**With a selection**
- A press inside the selection (coverage ≥ 50 %) lifts the selected pixels as a floating selection and drags it.
- Alt at pointer-down lifts a copy, with no hole.
- If a float already exists, any drag moves the float.
- A press outside the selection moves the whole layer and the selection with it.
- Enter commits the float, other edits settle it, Esc cancels it.
- A text layer defers the lift behind the rasterize confirm. The press ends first.
- The lift is checked up front. A refusal never falls through to a layer move.
- Which pixels lift depends on the target:
  - With a lmask targeted, the lmask's own pixels lift (grayscale).
  - With the layer's pixels targeted, the lmask stays put.
- A whole-layer move always carries the lmask.

**Auto-select**
- It is active with Ctrl at pointer-down (including when this tool is the temporary Ctrl tool) or with the option on, and is off whenever a selection exists.
- It picks the topmost visible, unlocked paint or text layer with alpha > 10 under the pointer, and makes it active (not an undo step).
- With Quick Mask on, it picks only visible, unlocked cmasks by raw painted coverage (invert ignored), makes the hit the current mask, and Quick Mask stays on.
- If nothing is hit, nothing moves and there is no note.

**Arrow keys** (when this is the active tool; swallowed mid-drag)
- Nudge 1 image px (at least 1 document px). Shift gives 10.
- Nudges merge into one undo entry (gesture `move-nudge`). With a float, the float is nudged instead.

**Refusals**
- Notes: locked, hidden, solo-hidden, Image Mask row, and `This layer can't be moved.` for unmovable kinds.
- An empty layer with a selection and no float gives `No pixels are selected.`
- Loading or an active stroke: silent.

**Cursor:** see C. The kind (cut, copy, outline, move) depends on the resolved tool, Alt, whether the pointer is inside the selection, and whether a float exists.

Files: `tools/moveLayer.ts`, `engine/moveOps.ts`, `engine/layerMovers.ts`, `engine/layerPick.ts`, `engine/floatLift.ts`, `ui/moveCursors.ts`.

## A.9 Rectangular and Elliptical Marquee (M group)

- No options. The bar gets Transform/Flip buttons while a selection exists.
- Drag makes a box in document coordinates, snapped to whole px: edges are rounded and a pixel is selected when its centre is inside the box.
- The rectangle has hard edges. The ellipse is anti-aliased.
- The marching-ants preview appears only after the drag moves beyond the click slop (3 stage CSS px, converted to document px).

**Modifiers** (`selectionModifiers.ts`)
- With a selection, Shift/Alt at pointer-down pick the mode: Shift = add, Alt = subtract, Shift+Alt = intersect. The mode is fixed at pointer-down.
- During the drag, Shift gives a square or circle, and Alt draws from the centre. A key consumed as a mode key only constrains after it has been released and pressed again.
- With no selection, Shift and Alt at pointer-down constrain immediately.
- Alt is never the eyedropper for selection tools.
- A click with no drag deselects in replace mode only. With add, subtract or intersect it does nothing.
- The result is one `selection` history entry. Empty coverage is treated as "no selection".
- Esc cancels the drag.
- A plain press inside an existing selection becomes an outline drag (A.14).

**Targets:** marquees touch no layer pixels, so they have no gate refusals.

Files: `tools/marquee.ts`, `tools/selectionModifiers.ts`, `engine/selection.ts`, `engine/selectionRaster.ts`.

## A.10 Lasso (L)

- No options. Freehand points are decimated to ~1 image px. The result is an anti-aliased polygon, one selection history entry.
- **Mode keys** are as for marquees. The mode is fixed at pointer-down.
- **Alt as a constraint = straight segments.** While Alt is held with the button down, only the cursor moves (a rubber band). Pressing or releasing the button adds a vertex.
  - With no selection, Alt at pointer-down starts in polygon mode at once.
  - With a selection, the Alt used for the mode doesn't count. Release it and press it again.
- **Alt released with the button down** resumes freehand from the cursor.
- **Releasing the button while Alt is held** keeps the path open (`pending`):
  - Each further press adds a vertex.
  - Moves with the button up call `onHover`, which draws the rubber band.
  - Releasing Alt closes the polygon.
  - A press near the start (more than 2 points, within 2× the click slop) closes it.
  - A double-click closes it (≤ 400 ms apart, within the click slop).
- **Releasing the button without Alt** closes the path.
- Esc, or a tool switch, cancels. A bare click (not moved, fewer than 3 points) deselects in replace mode.
- The Ctrl→Move swap is suppressed while a polygon is pending.

Files: `tools/lasso.ts`, `tools/selectionModifiers.ts`, `engine/selectionRaster.ts`.

## A.11 Magic wand (W)

**Options** (`magicWand.ts:30`): `tolerance` (0–255, default 32), `contiguous` (on), `antiAlias` (on), `sample` (select, setting `PainterSketch.WandSample`, built-in `background`). There is no opacity.

**Behaviour**
- A click selects pixels matching the clicked colour using the bucket's flood-fill matching and sampling (A.16), then combines the result with the current selection by mode.
- Modes come from Shift/Alt at pointer-down, exactly as for marquees. There are no drag constraints, and Alt is never the eyedropper.
- The area is the union of the image rect and the paint bounds. Bounds are not grown.
- A `"blocked"` result (hidden target) shows its note and leaves the selection alone.
- A `null` result goes to `selection.apply(null, mode)`; replace mode deselects. This is the code comment's claim ("replace deselects, like Photoshop"), and I didn't verify `combineSelection`'s outcome for add/subtract/intersect.
- Loading or an active stroke: silent no-op.
- No pixel edit happens, so the wand has no lock gate and no rasterize prompt.
- A plain click inside an existing selection goes through the outline-drag substitute. A click without movement is replayed to the wand as an ordinary click.

Files: `tools/magicWand.ts`, `engine/wand.ts`, `engine/pixelOps.ts:287`.

## A.12 Move drawing (hidden tool, no key)

- Activated by the "Move drawing" toggle in the layers footer. The previous rail tool is restored when it is turned off.
- **Options:**
  - X and Y: image px, ±16384, step 1.
  - Scale: 5–1000 % (stored 0.05–10), step 0.1, pow curve.
  - Reset position: button, dimmed unless moved.
- **Drag** moves the whole drawing by whole image px.
- **Wheel while the button is held** scales around the cursor: ×1.05 per notch, proportional for trackpads, capped. Without a drag the wheel zooms the view.
- **Arrows** nudge 1 image px, Shift 10, and are swallowed mid-drag.
- Esc during a drag restores the placement from the drag start.
- Not undoable (placement never enters paint history).
- Ctrl never swaps to Move.
- Cursor is CSS `move`.

Files: `tools/move.ts`, `engine/placementOps.ts`, `engine/placementMath.ts`, `engine/placementClamp.ts`.

## A.13 Region tool (hidden; Outputs tab / O)

- It has no options, no Ctrl swap and no Alt eyedropper. Any other tool leaves it.
- A drag on empty canvas draws a new region in the lowest empty slot.
- A plain drag inside a region moves it. The selected region's 8 handles resize it. The handle hit half-size is 6 screen px, and corners win on small rectangles.
- The hit order is the selected region's handle, then its body, then the topmost visible region under the point.
- Shift-drag always draws a new region, even from inside another.
- A click without a drag on a region selects it. On empty canvas it selects Main.
- The click slop is 3 screen px. Nothing is a document edit until a real drag; then one transaction opens, and release commits it.
- Drawing with all 6 slots used emits the "All 6 region slots are used" note. It is emitted when the drag passes the click slop (not at pointer-down).

Files: `tools/region.ts`, `engine/regionOps.ts`, `engine/regionGeometry.ts`, `ui/regionOverlay.ts`.

## A.14 Outline drag (substituted at press)

- With a selection tool and a plain press inside the selection (coverage ≥ 50 %, no Shift/Alt/Ctrl):
  - Moving past the click slop drags only the selection outline, as one `selection` history entry.
  - A press that never moves is replayed to the selection tool as a click.
- Esc cancels the drag and puts the outline back.
- Cursor: an arrow with a dotted-rectangle badge, hotspot (2, 2).

Files: `tools/outlineDrag.ts`, `engine/selectionFollow.ts`.

## A.15 Free Transform session (hidden; Ctrl+Alt+T, or the Transform button)

- While a session runs, the transform tool takes all stage input and arrow keys. Ctrl and Alt don't swap tools.
- **Hit zones:**
  - A handle within 8 screen px scales.
  - Inside the box moves.
  - Within 8 + 16 screen px of a corner (outside the box) rotates.
  - Elsewhere does nothing.
- **Modifiers**, read per sample:
  - Shift flips the proportional scale choice. The default is proportional when Link is on, and Shift gives free scaling. With Link off, Shift gives proportional.
  - Alt scales around the centre.
  - Shift while rotating snaps to 15° steps.
- **Arrows** nudge 1 image px (at least 1 document px). Shift gives 10.
- **Bar fields:** X and Y (box centre, image px, step 0.1), W and H (1–10000 %, step 0.1, pow curve), Link toggle, Angle (−180…180°, step 0.1), Flip H, Flip V, Commit (Enter), Cancel (Esc).
- **Text layers:**
  - Rotation and uniform scale go into `textData`. The session box is the unrotated edit box, proportional scale goes into `size`, and the layer stays editable text.
  - A non-uniform drag or a flip can't be represented in `textData`. It asks to rasterize after the press ends (pointer-up queues it with `setTimeout 0`). Changing W or H with Link off asks after the field edit.

Files: `tools/transformTool.ts`, `engine/transformOps.ts`, `engine/transformMath.ts`, `engine/transformHit.ts`, `engine/textTransform.ts`.

## A.16 Brush engine

**Why:** the brush tip is **measured from Photoshop's lossless exports**, not designed. Two sessions replaced it with a swept-profile or "max" model from eyeballing screenshots. Every variant creased where a stroke met itself and left Voronoi cells when colouring in. Change the tip or the combine rule only against a new lossless Photoshop export.

**Tip** (`brush.ts:241-280`; measured from a 300 px soft round)
- Alpha at distance `d` from the dab centre is `10^-(d/R)²`, with `R = size/2`. That is 10 % at the nominal radius, 50 % at 0.55 R, and cut off at 1.5 R (fit error under 1/255).
- **Hardness `h`** (0–1) gives a solid core out to `h·R`. The same fade is squeezed into `(1−h)·R`. 0 % is the measured tip. 0 < h < 1 is our own interpolation (browser-verified against PS at 50 and 100 %).
- The fade is never thinner than 1 px: `fade = max(1−h, 1/R)`, `core = min(h, 1 − fade/2)`. So 100 % hardness is a 1 px anti-aliased edge centred on the ring.
- `reach = core + 1.5·fade`.

**Dab placement** (`placeDabs`)
- Dabs are evenly spaced along each segment between consecutive samples.
- The step is `max(0.5 px, spacing × current diameter)`. Spacing is clamped to at least 0.01.
- Position and pressure are interpolated, and the diameter follows the interpolated pressure.
- The first sample of a stroke always gets a dab, unless the stroke is a Shift-click line (A.1).
- The minimum dab diameter is 0.5 document px.

**Pressure**
- Only pens report it (`normalizePressure`); mouse and touch are 1.
- **Pressure → size:** `factor = min + (1−min) · p^γ`, where `min = minSize` and `γ = gamma`. Zero pressure gives `minSize × size`, full pressure gives the full size.
- **Pressure → opacity:** a per-dab coverage cap `cap = p^γ`. It caps coverage around that dab and never lowers what is already there. Zero pressure gives cap 0, so nothing is painted.
- Pressure never affects flow.
- Both toggles share `gamma`.
- Ring and size options don't reflect pressure.

**Flow and opacity**
- **Flow** is the per-dab alpha, multiplied by the tip.
- **Opacity** is applied once, when the stroke is committed.

**Combine rule** (`dabMask.ts`)
- Every dab composites **source-over** into a 16-bit stroke coverage mask: `c += a·tip·(1−c)`. A stroke is therefore far denser than a click. At 25 % spacing the cross-section is 0.74 where the tip is 0.52, matching PS to about 0.02.
- Crossings, corners and Shift-click joints fill in with no crease.
- At large spacing, dabs show as even circles with a solid interior (PS at 40 %: 10 % dips; the model predicts 9 %).
- **Segments** (`strokePath.ts`): consecutive dabs become straight segments. Evenly spaced runs merge while every dab stays within 0.35 px of its place on the chord, up to 4 radii. Every dab belongs to exactly one segment, so segments composite each dab once.
- A run is applied per pixel by summing `q = −ln(1−a·tip)` over the run's dabs within reach, then taking `1 − exp(−sum)`. That is exactly the over-composite, so batching never changes the result. Tables are indexed by squared distance and cached per profile and flow.
- Under 5 % spacing, every m-th dab stands for m dabs, which is identical in the limit and bounds the cost.

**Stroke buffer** (`stroke.ts`)
- Coverage is written to the buffer canvas as one colour with alpha = coverage, only inside the dirty area. This keeps colour exact. 8-bit premultiplied stacking drifted soft edges into rings.
- While drawing, the preview is `layer + buffer × opacity`, updated only inside the dirty rect.
- On pointer-up the buffer is composited at the stroke opacity: `source-over` for paint, `destination-out` for erase.
- The undo patch is the touched rect, intersected with the selection extent. A stroke that changed no pixel adds no step and no re-upload.
- **Selection clip:** the buffer is multiplied by the selection coverage right before compositing (`destination-in`), for both the preview and the commit. Soft coverage never compounds over overlapping dabs.
- **Shapes** use the same buffer but replace its content on each move instead of accumulating dabs.
- **Bounds** grow chunked and capped to cover dab reach + 2 px. The growth is limited to a normal selection's bbox.

**Cursor ring** (`ringDiameter`)
- `size × min(1, core + fade × 0.77)`. The factor 0.77 was measured in PS at hardness 0 (80 px brush → 60 px ring, 300 px → 230 px). The tip is about 25 % opaque there, not 50 %.
- The ring shrinks with softness. At 100 % hardness it is the full size.

**Coalesced events** are used for every tool: all samples of a pointer event are fed in order.

Files: `engine/brush.ts`, `engine/strokePath.ts`, `engine/dabMask.ts`, `engine/stroke.ts`, `tools/paintTool.ts`, `defaults/pressureDefaults.ts`.

## A.17 Fill and wand sampling

One path decides what the bucket, the wand and the eyedropper read (`sampleTarget`, `pixelOps.ts:90`).

| Situation | What is read |
|---|---|
| lmask-only view with the viewed layer's lmask targeted (bucket, wand) | That lmask as opaque grayscale: R=G=B = hidden amount (white = hidden), inverted if the lmask is inverted, `outside` value beyond the stored pixels. **Wins over the Sample option**, and also works for a hidden layer. |
| Sample = **Current layer**, paint or text target | That layer's raw pixels. Its own lmask is not applied. |
| Sample = **Current layer**, cmask target (Quick Mask; includes the Image/Input Mask row) | The cmask's effective coverage (invert applied) as opaque gray (`coverageGray`). Image/Input Mask coverage is resampled into document coordinates and is 0 outside the image. |
| Sample = **Current layer**, no layer | Falls back to everything visible (bucket, wand). The eyedropper samples nothing. |
| Sample = **All layers** | The visible composite: background plus visible paint layers at their opacity, lmasks applied, honouring solo and the background eye. Mask tints are not included. |
| Sample = **All layers**, cmask target | The union (max) of every cmask shown on the stage (eye and solo respected, each after its own invert). The Image/Input Mask row joins while it is shown and applies to the current image. Not the paint composite. |
| Sample = **Background** | Only the input image (or the `width × height` background-colour frame), same placement, no paint. Still reads the image when the background eye is off. |

**Hidden or locked targets**
- **Bucket:** the pixel-edit gate refuses a hidden target always, with that layer's note. An Image Mask row target gives the image-mask note. A locked layer gives `Layer is locked.` The lmask-only view exception keeps a hidden layer's lmask fillable.
- **Wand:** with Sample = Current layer on a hidden paint layer or cmask, it refuses with the hidden note and keeps the selection (`"blocked"`). It does not check locked.
- Other sample sources and the lmask-only view never refuse on visibility.

**Matching** (`floodFill.ts`)
- Every channel (R, G, B and alpha) must be within `tolerance` of the seed. Colours are compared alpha-weighted (premultiplied), so a nearly transparent pixel is close to transparent whatever its RGB. Two fully transparent pixels always match.
- **Contiguous** uses a 4-neighbour scanline fill with an explicit stack. Otherwise every matching pixel is kept.
- **Anti-alias** adds a 1 px soft fringe outside the filled area (3×3 box average of the hard mask; the inside stays fully covered). With the bucket it also fills behind the target layer's own soft edges.
- A selection clip restricts and scales the coverage.
- The seed is `floor(point)`. A seed outside the sampled area gives nothing.

**Area**
- Bucket: the paint bounds, first grown to cover the visible image rect.
- Wand: the union of the image rect and the bounds, without growing.
- Eyedropper: the sample window only.

Files: `engine/pixelOps.ts`, `engine/floodFill.ts`, `engine/wand.ts`, `engine/docComposite.ts`, `engine/fillUnder.ts`, `tools/fill.ts`, `tools/magicWand.ts`, `tools/eyedropper.ts`.

---

# B. Shortcuts found

Keys are lowercased unless noted. Everything here is active only while the editor owns the keyboard (the keyboard scope handles this; it also stops `preventDefault`/propagation for handled keys).

| Key / modifier | Context | Action | file:line |
|---|---|---|---|
| B, E, G, I, T, V, L, W | any (no Ctrl/Alt) | Activate the tool | `shortcuts.ts:141-147`, `registry.ts:102-111` |
| U | any | Activate the last-used shape tool | same |
| M | any | Activate the last-used marquee | same |
| Shift+U, Shift+M | any | Cycle the group; always advances, wraps | `shortcuts.ts:111-118`, `registry.ts:64-69` |
| Shift+other letter | any | Not handled, event passes on | `shortcuts.ts:113-114` |
| `[` / `]` | tools with a numeric `size` option (Brush, Eraser, Text) | Size down/up in Photoshop steps | `shortcuts.ts:93-101`, `stepSize` `:171` |
| Shift+`[` / Shift+`]` | tools with `hardness` (Brush, Eraser) | Hardness ∓25 % steps (0/25/50/75/100) | `:95-96`, `stepHardness` `:183` |
| 1–9, 0 (no Shift) | tools with `opacity` (Brush, Eraser, Bucket, Line, Arrow, Rectangle, Ellipse) | Opacity 10–90 %, 0 = 100 % | `:103-109` |
| Arrow keys | active tool Move layer, a running transform session, or Move drawing | Nudge 1 image px (≥1 doc px), Shift = 10; swallowed mid-drag | `moveLayer.ts:130-139`, `transformTool.ts:109-115`, `move.ts:172-180` |
| Esc | tool drag in progress, or a pending lasso/text edit | Cancel the drag; text commits | `shortcuts.ts:70-72`, `stageInput.ts:151-156` |
| Esc | text overlay | Commit text | `textOverlay.ts:120-125` |
| Esc | float or transform session | Cancel | `floatShortcuts.ts:52-56` |
| Enter | float or transform session | Commit (a session commits first, then the float on the next Enter) | `floatShortcuts.ts:57-63` |
| Ctrl+Enter | text overlay | Commit text | `textOverlay.ts:121` |
| Ctrl+Alt+T | any | Enter Free Transform (not repeatable; AltGr guarded) | `floatShortcuts.ts:42-49,74-77` |
| Ctrl+E | any | Merge Down (cancels the drag first) | `floatShortcuts.ts:35-41` |
| Q | any | Toggle Quick Mask (cancels the drag first) | `shortcuts.ts:121-125` |
| X / D | any | Swap/reset colours; with a lmask targeted, the black/white mask swatches | `:126-132` |
| O | any | Toggle Outputs tab / region mode | `:136-139` |
| F | any | Toggle fullscreen | `:133-135` |
| Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y | any | Undo/redo | `:80-81` |
| Ctrl+0 / 1 / = / − | any | Fit / 100 % / zoom in / zoom out | `:82-85` |
| Delete/Backspace, Alt+Backspace, Ctrl+Backspace, Ctrl+A, Ctrl+D, Ctrl+Shift+I, Shift+F7 | any | Selection commands (listed for completeness) | `selectionShortcuts.ts:25-48` |
| Space+drag, middle-drag | any | Pan the view | `stageInput.ts:176`, `keyboard.ts:345-351` |
| Wheel | stage | Zoom around the cursor; during a Move-drawing drag, scale | `stageInput.ts:97-109` |
| Alt held | tools with `altEyedropper` | Cursor becomes the eyedropper; pointer-down picks | `registry.ts:221` |
| Ctrl/Cmd held | opted-in rail tools | Cursor/press become the layer Move tool | `registry.ts:220`, `ctrlMoves` `:232` |
| Alt (bare key) | any | `preventDefault` only, to stop the Windows menu bar | `keyboard.ts:337-343` |
| Shift at pointer-down | Brush, Eraser | Straight line from `lastStrokeEnd` | `paintTool.ts:120` |
| Shift during drag | Line, Arrow | Snap angle to 15° | `lineTool.ts:61` |
| Shift during drag | Rectangle, Ellipse, marquees | Square / circle | `boxShapeTool.ts:62`, `marquee.ts:159` |
| Alt during drag | Rectangle, Ellipse, marquees | From centre | same |
| Shift/Alt at pointer-down | marquees, lasso, wand, with a selection | Add / subtract / intersect | `selectionModifiers.ts:46-60` |
| Alt | lasso (as constraint) | Straight segments; release closes when pending | `lasso.ts:118-148` |
| Alt at pointer-down | Move layer, inside the selection | Lift a copy | `moveLayer.ts:84` |
| Ctrl at pointer-down | Move layer | Auto-select | `moveLayer.ts:92` |
| Shift/Alt per sample | transform session | Shift: invert proportional / 15° rotate; Alt: scale about centre | `transformSession.ts:60-62`, `transformTool.ts:88,95` |
| Shift at pointer-down | region tool | Always draw new | `region.ts:124` |
| Alt at pointer-down | eyedropper tool itself | Background slot | `eyedropper.ts:97` |
| Ctrl at pointer-down | Text tool | Move text | `text.ts:191` |
| Long-press (400 ms) / right-click | group rail slot | Open flyout | `toolGroupSlot.ts:122,57` |
| Caps Lock | — | Not used anywhere | grep: no hit |

---

# C. Cursors

The stage writes the cursor into the CSS variable `--cps-tool-cursor`. The `cps-panning` (grabbing), `cps-pan-ready` (grab) and `cps-loading` (progress) classes win over it (`styles/editor.css:301-314`). Icon cursors are 24×24 SVG data URLs with a 4 px `#111` outline pass and a 1.75 px white stroke pass, built from the rail icon paths (`cursors.ts`).

| Tool / state | Cursor | Hotspot |
|---|---|---|
| Brush, Eraser | CSS `crosshair` + overlay ring: 80 % black circle, then an 80 % white circle one line-width larger; line width `max(1, devicePixelRatio)`; radius `max(1, ringDiameter × viewScale × pr / 2)`; drawn only while hovering and not panning, not drawn while a loupe is up | crosshair centre |
| Bucket | SVG `bucket` icon, fallback `crosshair` | (19, 20) |
| Eyedropper, and Alt temporary eyedropper | SVG `eyedropper` icon, fallback `crosshair`. While picking, the overlay is a loupe: outer radius 34, inner 22 CSS px, top half the sampled colour, bottom half the colour before the drag, grey 90 % outlines. The loupe replaces the ring | (3, 21) |
| Line, Arrow, Rectangle, Ellipse | CSS `crosshair` | native |
| Text | CSS `text` (I-beam); `move` during a Ctrl+drag text move | native |
| Move layer, Move drawing, Ctrl-temporary Move, Transform "move" zone | CSS `move`, unless the move-cursor kind (below) applies | native |
| Move layer variants | SVG, black with a white outline, 32×32: **cut** (move arrows + scissors badge) when inside the selection without a float; **copy** (move arrows + "+") with Alt; **outline** (arrow + dotted-rectangle badge) for outline drag | cut and copy (11, 11), fallback `move`; outline (2, 2), fallback `default` |
| Marquees, Lasso, Wand | CSS `crosshair`. With a selection and Shift/Alt held, a 32×32 SVG crosshair (1 px white on a dark outline) with a badge at the bottom right: **+** add, **−** subtract, **×** intersect. Fixed during a drag and while a polygon is pending | (11, 11) |
| Region tool | CSS `crosshair` | native |
| Transform: handle zone | CSS `ns-resize`, `ew-resize`, `nwse-resize`, `nesw-resize`, chosen from the handle's on-screen direction in 45° sectors | native |
| Transform: rotate zone | Two circling arrows SVG, black with a white outline | (16, 16) |
| Transform: outside the box | CSS `crosshair` | native |
| Layer-row Ctrl+hover | Arrow + marquee badge (+ mode mark) | (2, 2) |

The Free Transform hover cursor uses `cursorAt`, which is polled per hover position.

---

# D. Messages

All are stage notes (5 s, bottom of the stage), unless marked as a confirm.

| Text (verbatim) | Trigger | Where |
|---|---|---|
| `Layer is locked.` | Any gated pixel edit (strokes, shapes, bucket, lift, move, text edit, text angle) on a locked layer | `editorTypes.ts:198` |
| `The layer is hidden.` | Same gate, eye off, paint or text layer | `:204` |
| `The mask is hidden.` | Same gate, eye off, cmask; also the wand with Sample = Current layer | `:222` |
| `The layer is hidden by solo.` | Same gate, or wand Current layer, when another layer's solo hides the target | `:207` |
| `Image Mask can't be edited — duplicate it to edit.` / `Input Mask can't be edited — duplicate it to edit.` (em dash, `—`) | Any pixel edit on the Image/Input Mask row | `:214-216` |
| `Layer mask: use the brush, eraser or fill.` | Shape tools or text creation while a lmask is targeted | `layerMask.ts:48` |
| `Layer mask: black and white only, no eyedropper (X swaps).` | Eyedropper (including Alt temporary) while a lmask is targeted | `layerMask.ts:51` |
| `Rasterize text layer? It will no longer be editable as text.` | `window.confirm`: a pixel edit on a text layer, or a non-uniform/flip transform on text | `rasterize.ts:28` |
| `Font '<name>' isn't installed; editing will use a fallback.` | Text edit opens, or the font changes, with a font `document.fonts.check` rejects | `textOps.ts:37-39` |
| `No pixels are selected.` | Move layer or lift with a selection that holds no pixels of the layer | `floatLift.ts:36` |
| `The layer is empty.` | Whole-layer lift or flip of an empty layer | `layerFlip.ts:24` |
| `This layer can't be moved.` | Move layer on a kind without a mover | `layerMovers.ts:55` |
| `All 6 region slots are used. Delete a region to draw another.` | Region tool, drawing when all slots are used | `region.ts:31` |

Gate precedence is image-mask row, hidden, solo-hidden, lmask-tool note, then locked.

---

# E. Mismatches

| Old spec says | Code does | file:line | My read |
|---|---|---|---|
| "Brush ring cursor at the tip's 50% boundary (0.55 x size at hardness 0, the full size at 100%)" (Canvas/view). A 2026-09-26 Decisions Log line says the same. | Ring = `size × min(1, core + fade × 0.77)`; 0.77 measured in PS (~25 % opaque point). | `brush.ts:254,265-268` | Spec stale. The Handoff section already says 0.77. Use code. |
| Text: "click/double-click existing text = re-edit" | Single click on an existing text opens it. Double-click has no special handling. | `text.ts:196-206` | Spec wording stale. |
| Text (not in old spec): click on empty canvas while an edit is open | Only commits. It does not create new text. A second click is needed. Clicking the same text again also only commits. | `text.ts:197-202` | Intended behaviour (undocumented). Worth a line in the spec. |
| M6a: Ctrl auto-select "(Quick Mask turns off)" | With Quick Mask on it picks cmasks, makes the hit current, and Quick Mask stays on. (The M8 bullet already says this.) | `moveLayer.ts:151-155` | Spec internally inconsistent. Use the M8 text. |
| M5 Decisions Log: wand defaults "all layers" | Wand and bucket default to `background` (setting-backed). | `magicWand.ts:52`, `fill.ts:59`, `sampleDefaults.ts:23` | Superseded. The Tools table is right. |
| Behaviour Notes: hidden mask note `"The mask is hidden; show it to output it."` | Edit refusals use `"The mask is hidden."`. The queue-time wording is outside my area. | `editorTypes.ts:222` | The 09-28 Decisions Log says it was shortened. The Behaviour Notes entry is stale. Check the queue-time message separately. |
| Tools table, Eraser: "size, hardness, opacity, pressure, Shift+click straight line" | Eraser also has `flow` and `spacing` (same descriptors as Brush). | `paintTool.ts:23-55` | Spec omission. |
| Tools table, Line/Arrow: "width, color, arrowhead none / end / both. Shift snaps to 15 deg" | Also `opacity` and `headSize` (150–1500 %, default 400 %). | `lineTool.ts:25-52` | Spec omission. |
| Brush shortcuts: "`[` / `]` size, Shift+`[` / `]` hardness, 1..9/0 opacity" | `[` `]` only affect tools with a `size` option (Brush, Eraser, Text). Shape tools use `width`, so brackets do nothing there. In that case the key is reported unhandled and passes to the graph. Opacity digits work for every tool with an `opacity` option. | `shortcuts.ts:93-109` | Probably an oversight. Decide whether `[` `]` should also resize shape width. Either way, document the set of tools. |
| "Shift+click draws a straight stroke from the last point" | `lastStrokeEnd` is editor-wide and shared by Brush and Eraser. It is cleared only by Clear/Match/undo-of-Clear. Layer switching and ordinary undo don't clear it. Spacing residual is stored per tool instance (`PaintTool.residual`). | `paintTool.ts:90,120`, `frameOps.ts:92,114`, `resolutionOps.ts:102` | **Possible minor bug:** a Shift-click eraser line after a brush stroke starts from the brush's end with the eraser's old residual (only a tiny spacing phase glitch). Unclear whether it matters. |
| Float section: "selection tools: Ctrl+drag inside (Ctrl+Alt = copy)" | Implemented by the generic Ctrl→Move swap. Ctrl+drag on a selection tool with no selection is also a temporary Move with auto-select. | `registry.ts:220`, `moveLayer.ts:92` | Intended (Photoshop-like). Make explicit. |
| Selection section: Shift/Alt "act as constraints instead" with no selection | Correct. Subtlety: with a selection, a key used for the mode only constrains after release and re-press. | `selectionModifiers.ts:46-60` | Matches. Worth stating in the spec. |
| Pressure: "Simple curve (min size %, gamma)" | `minSize` is only enabled with `pressureSize`. `gamma` serves both mappings. Pressure→opacity is a per-dab cap (never lowers coverage); zero pressure paints nothing. | `paintTool.ts:36-54`, `dabMask.ts:16` | Spec too thin. The Handoff notes it as unmeasured vs PS ("Open #3"). |
| Handoff Open #3: flow < 100 % and pressure→opacity "not measured" | Still true. The code is the model (per-dab alpha, local cap). | `dabMask.ts` | Unchanged. Carry over as an open item. |
| Tools table, Eyedropper: sampling "(all default)" | Matches. Undocumented: it ignores hidden/locked state, and uses the paint-target layer even under Quick Mask. | `pixelOps.ts:311-320` | Document it. |
| (not covered) Region tool full-slots path | After the note, `drag.moved` stays true although `begin()` was never called. Pointer-up then calls `regionOps.commit()` anyway. | `region.ts:91-95,139` | Unclear: `commit()` probably tolerates "no transaction" (not verified). Worth a test. |
| Transform: "Shift while dragging a handle inverts" | Option title says "Keep proportions (Shift while dragging a handle inverts)". | `transformTool.ts:147`, `transformSession.ts:60` | Matches. |

Items where I could not fully verify behaviour:
- `selection.apply(null, mode)` for non-replace modes.
- The lmask-only view's exact sticking rules (they live in `layerMaskOps.ts`, outside my area).