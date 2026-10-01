I read the code statically and did not run it in a browser. Anything marked "verify" needs a browser check. Line numbers are `ui/src/...` unless a full path is given.

## A. Inventory

Throughout, "text field" means a text input, textarea, select or contenteditable. `keyboard.ts:336` drops every key from a text field except Ctrl+S, so editor shortcuts never see them.

### General (12)

| Keys | Context | Action | file:line |
|---|---|---|---|
| Ctrl+Z | any | Undo. With a float or transform active it cancels that instead. With a text edit open it commits, then undoes. A region drag in progress is cancelled. | ui/shortcuts.ts:80; engine/editor.ts:353-358 |
| Ctrl+Shift+Z, Ctrl+Y | any | Redo. Ignored while floating or transforming. | shortcuts.ts:81; editor.ts:361 |
| Ctrl+S | editor owns keys, including from its own text fields | Flush uploads, then run `Comfy.SaveWorkflow`. Ignores key repeat. | ui/keyboard.ts:330-335; ui/saveKey.ts:17; widget/controller.ts:116 |
| Esc | cascade, first match wins | 1) Images panel closes. 2) A float or transform is cancelled. 3) A tool drag or pending lasso/text is cancelled. 4) An open popover closes. 5) Fullscreen exits. Shift+Esc counts as Esc. | ui/imagesPanel.ts:107; ui/floatShortcuts.ts:52; ui/shortcuts.ts:70-72 |
| Q | no modifiers | Toggle Quick Mask (paint target). | shortcuts.ts:121 |
| F | no modifiers | Toggle fullscreen. | shortcuts.ts:133 |
| O | no modifiers | Toggle the Outputs tab / region mode. | shortcuts.ts:136; ui/hostSync.ts:219-231 |
| Space (held) | not in a text field | Pan-ready cursor. Space-drag pans. Always `preventDefault`ed, so a focused button is never clicked. Ctrl/Alt+Space is left alone. | keyboard.ts:345-351; ui/modifierScope.ts:42-45 |
| Alt (keydown) | not in a text field | `preventDefault` only, to stop the Windows menu bar. Also feeds the temporary eyedropper and the selection-mode badge. | keyboard.ts:337-344 |
| Delete, Backspace | editor active | Always swallowed, so the graph never deletes nodes. See Selection. | ui/selectionShortcuts.ts:32-38 |
| Ctrl+Enter, Ctrl+Shift+Enter, Ctrl+Shift+S | editor active | Not intercepted. They reach ComfyUI (queue, save as). Fullscreen explicitly allows them. | ui/fullscreenKeys.ts:42,63 |
| F5, Ctrl+R, Ctrl+Shift+R | page-global, not editor-scoped | If uploads are pending: flush (3 s cap), then reload. Otherwise the browser reloads normally. | widget/pageGuards.ts:58-93; ui/reloadGuard.ts:18-24 |

### View (12)

| Keys | Context | Action | file:line |
|---|---|---|---|
| Wheel | over the stage | Zoom around the cursor: factor `exp(-Δ·0.0015)`, Δ clamped to ±300 per event. | ui/stageInput.ts:97-109; engine/viewport.ts:122 |
| Ctrl/Shift/Alt+wheel | over the stage | Same as plain wheel. There is no modifier variant (no Shift+wheel horizontal pan). | stageInput.ts:97-109 |
| Wheel during a Move-drawing drag | active tool Move drawing | Scales the drawing (1.05 per notch) instead of zooming. | tools/move.ts:161-169; stageInput.ts:103 |
| Middle-drag | over the stage | Pan. Both renderers; Nodes 2.0 is handled by the capture guard. | stageInput.ts:176; widget/eventIsolation.ts:102-122 |
| Space + left-drag | over the stage | Pan. | stageInput.ts:176 |
| Ctrl+0 | any | Fit, and re-enter sticky fit mode. | shortcuts.ts:82; engine/view.ts:96 |
| Ctrl+1 | any | 100% (one doc px per screen px), centred. | shortcuts.ts:83; view.ts:106 |
| Ctrl+= or Ctrl++ | any | Zoom in ×1.25 around the stage centre. | shortcuts.ts:84 |
| Ctrl+- or Ctrl+_ | any | Zoom out ×0.8. | shortcuts.ts:85 |
| Wheel over rail, side panel, options bar | chrome | The options bar scrolls sideways. Ctrl+wheel is prevented (no browser zoom). Other regions scroll natively. Nothing reaches the graph. | ui/shell.ts:156-167 |
| Plain click on the cobweb (outside the paint cap) | stage | Regrows the cobweb. Needs no modifiers, no Space/pan, ≤4 px and ≤500 ms. The press still reaches the tool. | ui/webClick.ts:60-75 |
| Fit button | rail | Same as Ctrl+0. | ui/toolRail.ts:93 |

### Tools (selection keys) (19)

| Keys | Context | Action | file:line |
|---|---|---|---|
| B, E, G, I, T, V | no modifiers | Brush, Eraser, Bucket, Eyedropper, Text, Move layer. | tools/brush.ts:18; eraser.ts:19; fill.ts:49; eyedropper.ts:65; text.ts:125; moveLayer.ts:53 |
| L, W | no modifiers | Lasso, Magic wand. | lasso.ts:78; magicWand.ts:43 |
| M | no modifiers | Marquee group: last-used of rect/ellipse. | marquee.ts:88; tools/registry.ts:102-111 |
| U | no modifiers | Shape group: last-used of Line, Arrow, Rectangle, Ellipse. | shapeTools.ts:12 |
| Shift+M, Shift+U | no selection needed | Cycle the group: next member after the active one, or after the group's current member if the active tool is outside the group. Wraps. | shortcuts.ts:111-118; registry.ts:64-69; tools/toolGroups.ts:82-88 |
| Shift+any other letter | — | Not handled. Returns false and falls through. | shortcuts.ts:114 |
| Rail group slot click | M and U slots | Select the group's current tool. | ui/toolGroupSlot.ts:109-116 |
| Long-press 400 ms, or right-click, on a group slot | rail | Open the flyout. Shows labels and key letters. | toolGroupSlot.ts:15,57-61,118-127 |
| No key: Move drawing, region tool, Free Transform | hidden tools | Reachable only by the layers-footer toggle, the Outputs tab / `O`, and Ctrl+Alt+T (a session). | tools/move.ts:115; region.ts:113; transformTool.ts:62 |
| Ctrl held at pointer-down | any rail tool except Text, Move layer, Move drawing, regions | Temporary Move layer. Auto-selects the topmost visible, unlocked layer under the pointer, but only if no selection exists. Fixed for the drag. | registry.ts:214-234; moveLayer.ts:92 |
| Alt held at pointer-down | Brush, Bucket, Line, Arrow, Rectangle, Ellipse | Temporary eyedropper (foreground only). | registry.ts:221; brush.ts:21; fill.ts:51; shapeTool.ts:95 |
| Ctrl+Alt in those tools | — | Ctrl wins, so it is Move, not the eyedropper. | registry.ts:218-221 |
| Alt+click | Eyedropper tool itself | Samples into the background colour. | eyedropper.ts:97 |
| Alt in Eraser, Text, Wand, marquees, Lasso | — | No eyedropper. In marquee/lasso/wand, Alt is the subtract modifier. Eraser and Text do nothing special. | paintTool.ts:103 (eraser leaves it false) |
| Plain press inside a selection | marquee, lasso, wand | The pointer-down tool becomes an outline drag. A click that doesn't move is replayed as the tool's normal click. | registry.ts:217; tools/outlineDrag.ts |
| Ctrl+Z / Ctrl+Y | modifier tracking | Observe-only. Shift/Ctrl flags are read from every key event. | modifierScope.ts:47-49 |
| Tooltips | rail | Group slot: "(U, Shift+U cycles)". Others: "(B)". | toolGroupSlot.ts:48; toolRail.ts:151 |
| Clicking a rail button | rail | Never takes DOM focus. Focus goes to the hidden sink. | keyboard.ts:95-102 |
| Precedence | pointer-down | Free Transform session > outline drag > Ctrl Move > Alt eyedropper > active tool. | registry.ts:214-222 |

### Brush and shared options (9)

| Keys | Context | Action | file:line |
|---|---|---|---|
| `[` / `]` | tool with a numeric `size` option: Brush, Eraser, Text | Size step. Step is 1/5/10/25/50 by range, clamped 1..1000. Works from the key code, so layout-independent. | shortcuts.ts:93-101, 171-175 |
| Shift+`[` / Shift+`]` | tool with `hardness`: Brush, Eraser | Hardness in 25% steps. | shortcuts.ts:95-97, 183 |
| `1`..`9`, `0` | tool with `opacity`: Brush, Eraser, Bucket, all shape tools | Opacity 10%..90%, `0` = 100%. Needs a bare key (no Shift/Alt/Ctrl). | shortcuts.ts:103-109 |
| Same keys in a tool lacking the option | Marquee, Lasso, Wand, Text (opacity), shapes (`[` `]`) | Returns false, so the key is not swallowed. | shortcuts.ts:98,106 |
| Shift+click | Brush, Eraser | Straight line from where the last stroke ended. It is its own stroke and undo step, with no extra dab at the joint. | tools/paintTool.ts:120-129 |
| Shift+click (second click) | Line / Arrow while dragging | Shift snaps the angle to 15° during the drag. | tools/lineTool.ts:61 |
| Shift / Alt during drag | Rectangle, Ellipse | Shift = square/circle, Alt = from centre. | tools/boxShapeTool.ts:62 |
| Number-label drag | any number option in the options bar | Scrub. Shift = ×10, re-anchored when Shift changes mid-drag. | ui/optionControls.ts:131-173; ui/scrub.ts |
| Click the value | number option | Slider popover with a typed field. Enter commits and closes. Esc closes through the popover. | optionControls.ts:116-124, 217-222 |

Pen pressure uses Pointer Events, with coalesced events (`stageInput.ts:322-340`). Nothing else is bound to the pen.

### Colour (8)

| Keys | Context | Action | file:line |
|---|---|---|---|
| X | no layer mask targeted | Swap FG/BG. | shortcuts.ts:126-129 |
| X | layer mask targeted | Swap the mask's black/white swatches. | shortcuts.ts:128 (`layerMask.swapSwatches`) |
| D | no layer mask targeted | Reset to black/white. | shortcuts.ts:130-132 |
| D | layer mask targeted | Reset the mask swatches (white fg, black bg). | shortcuts.ts:131 |
| Click a swatch square | rail | Open the colour picker. Ignored while a layer mask is targeted. | ui/hostSync.ts:108-114 |
| Click the swap or reset icons | rail | Same as X and D. | ui/swatches.ts:57-60 |
| Picker: drag SV/hue, type in hex | popover | Live update. Enter in hex applies and blurs. | ui/colorPicker.ts:168-178 |
| Picker close | popover | Click outside commits. Esc reverts only if the keydown reaches the popover element (see B1). Clicking the left half of the preview reverts. Recent swatches apply a colour. | colorPicker.ts:195-200, 225-256 |

### Selection (22)

| Keys | Context | Action | file:line |
|---|---|---|---|
| Ctrl+A | editor | Select all (the current image area). | ui/selectionShortcuts.ts:40 |
| Ctrl+D | editor | Deselect. | selectionShortcuts.ts:41 |
| Ctrl+Shift+I, Shift+F7 | editor | Invert. Also the options-bar "Invert" button. No selection stays none. | selectionShortcuts.ts:44, 47 |
| Delete, Backspace | selection active | Clear the selection on the paint target. | selectionShortcuts.ts:36 |
| Delete, Backspace | no selection | Swallowed, does nothing. Shift+Delete and Shift+Backspace act like plain Delete. Key repeat is swallowed. | selectionShortcuts.ts:33,37 |
| Alt+Backspace | editor | Fill the selection with FG. On an lmask this hides. | selectionShortcuts.ts:34 |
| Ctrl+Backspace | editor | Fill the selection with BG. | selectionShortcuts.ts:35 |
| Shift / Alt / Shift+Alt at pointer-down | marquee, lasso, wand, only if a selection exists | Add / subtract / intersect. Without a selection the mode is always replace. | tools/selectionModifiers.ts:46-50; engine/selection.ts:44-47 |
| Shift during drag | marquee | Square/circle. | selectionModifiers.ts:60; marquee.ts:159 |
| Alt during drag | marquee | Draw from centre. | same |
| Re-press rule | marquee, lasso | A key used as a mode key only constrains after it is released and pressed again. Without a selection, held keys constrain at once. | selectionModifiers.ts:39-61 |
| Click without drag | marquee, lasso (freehand) | Deselect, in replace mode only. | marquee.ts:131-135; lasso.ts:211-214 |
| Alt held | lasso, as a constraint | Straight segments. Releasing Alt with the button down resumes freehand. | lasso.ts:171-186 |
| Release button while Alt held | lasso | Path stays open and `pending()` is true. Each click adds a vertex. | lasso.ts:123-139 |
| Close the lasso polygon | lasso, pending | Release Alt with the button up, double-click (≤400 ms, within slop), or click near the start. Esc cancels. | lasso.ts:142-148, 189-204 |
| Wand click | wand | Select by colour. Modifiers pick the mode. | tools/magicWand.ts:62-74 |
| Plain drag inside the selection | marquee, lasso, wand | Moves the outline only (one `selection` undo entry). | outlineDrag.ts |
| Ctrl+drag inside the selection | selection tools | Lift the pixels and float them (Ctrl is the temporary Move layer). | moveLayer.ts:79-85 |
| Ctrl+Alt+drag inside the selection | selection tools | Float a copy. | moveLayer.ts:84 |
| Cursor badge | selection tools with a selection | + (Shift), − (Alt), × (Shift+Alt). Also on the layer-row Ctrl hover. | ui/moveCursors.ts:62-67 |
| Options-bar buttons | a selection exists | "To mask" and "Invert". | ui/selectionActions.ts:31,38 |
| Esc | marquee/lasso drag or pending polygon | Cancels it. | stageInput.ts:151-156 |
| Press then modifier change | mid-drag | Modifier changes re-send the last sample (live constraint). | stageInput.ts:241-257 |

### Layers and panel (19)

| Keys | Context | Action | file:line |
|---|---|---|---|
| Click a row | paint, text, or cmask row | Select it. A mask row also turns Quick Mask on; a paint row turns it off. | ui/layerRow.ts:183-188; ui/layersPanel.ts:327-335 |
| Ctrl+click a row | paint/text/cmask row, not Background | Load the layer's pixels as the selection (hard: alpha>0, or effective mask coverage). Current layer and Quick Mask unchanged. | layerRow.ts:185-186; layersPanel.ts:337 |
| Ctrl+Shift / Ctrl+Alt / Ctrl+Shift+Alt+click a row | same | Add / subtract / intersect. | ui/moveCursors.ts:128-130 |
| Shift+click or Alt+click a row (no Ctrl) | any row | Plain select. No multi-select. | layerRow.ts:185 |
| Ctrl-hover a row | list | Cursor shows arrow + marquee badge and the mode mark. | ui/layerSelectHover.ts |
| Plain click a masked layer's thumbnail | paint row with an lmask | Target the layer's pixels, not the lmask. With a modifier it falls through to the row. | layerRow.ts:151-155 |
| Double-click the name | paint, text, mask rows | Inline rename. Ctrl+dblclick does nothing. Not on Background or Image/Input Mask. | layerRow.ts:189-192, 299 |
| Enter / Esc / blur | rename field | Commit / cancel / commit. Keys stay in the field. | ui/inlineRename.ts:31-41 |
| Eye, solo, lock buttons | rows | Plain clicks only. Alt+click on the eye was removed. | layerRow.ts:164-169; layersPanel.ts:350-356 |
| Click the Background row | Background | Selects nothing. Only ends the lmask-only view. | layerRow.ts:178-181; layersPanel.ts:328 |
| Press and drag a paint or mask row | list, >4 px | Reorder. Paint onto paint, mask onto mask. Edge auto-scroll. Not started with Ctrl held. | ui/layerDrag.ts:65-73 |
| Ctrl+E | editor | Merge Down (also the footer button). Ignores key repeat. | ui/floatShortcuts.ts:35-41 |
| Footer buttons | panel | Move drawing toggle, New layer, New mask, Duplicate, Merge Down, Delete. | layersPanel.ts:102-110 |
| Header opacity | panel | Scrub the label, or click the value. It is the "Overlay" label in Quick Mask. | layersPanel.ts:97, 251 |
| Mask row swatch, invert, overlay control | cmask rows | Colour picker, invert toggle, overlay opacity. | layerRow.ts:195-207 |
| Image/Input Mask row | cmask | Eye, solo, colour, invert, Ctrl+click. Lock disabled, no rename, no drag. | layerRow.ts:172-176; ui/imageMaskRow.ts |
| Tab buttons | side panel | Layers / Outputs. Opening Outputs enters region mode. | ui/sidePanel.ts:75; ui/hostSync.ts:285-294 |
| Side-panel toggle | options bar | Show or hide the panel. | ui/shell.ts:109 |
| Clear button | rail | Confirm dialog, then one undoable Clear. | ui/hostSync.ts:303-309 |

### cmask and lmask (13)

| Keys | Context | Action | file:line |
|---|---|---|---|
| Click a cmask row | Mask N or Image/Input Mask | Make it the current mask, Quick Mask on. | layersPanel.ts:327-335 |
| Q | any | Toggle Quick Mask. It paints into the current cmask. | shortcuts.ts:121 |
| Ctrl+click a cmask row | cmask | Selection of the white (coverage) part. | layerRow.ts:185; engine/imageMaskOps.ts:243 |
| Click the add-lmask icon | paint row, no lmask yet | Add a lmask that reveals all, or shows only the selection if one exists. | ui/layerMaskThumb.ts:74-77; layersPanel.ts:341-345 |
| Alt+click the add-lmask icon | same | Add a lmask that hides all. | layerMaskThumb.ts:76 |
| Click the lmask thumbnail | row with an lmask | Target the lmask. Moves an lmask-only view onto it. | layerMaskThumb.ts:113 |
| Shift+click the lmask thumbnail | same | Toggle the lmask on/off (red X). Not undoable. | layerMaskThumb.ts:111 |
| Alt+click the lmask thumbnail | same | View the lmask alone in grayscale and target it. Again to end. | layerMaskThumb.ts:112 |
| Ctrl(+Shift/Alt/Shift+Alt)+click the lmask thumbnail | same | Selection of the lmask's shown (black) part, soft. Ctrl wins over Shift/Alt for the toggle. | layerMaskThumb.ts:108-110 |
| X / D | lmask targeted | Operate on the black/white mask swatches. | shortcuts.ts:128,131 |
| Eyedropper (tool or Alt) | lmask targeted | Refused with a note. | tools/eyedropper.ts:93-96 |
| Delete / Alt+Backspace | lmask or cmask targeted | Reveal / hide the selection (coverage), same as mask layers. | selectionShortcuts.ts:34-36 |
| Options bar: Invert mask, Apply, Delete mask | lmask targeted | Appended to whatever the active tool shows. | tools/layerMaskBar.ts:20-25 |

### Move and Transform (20)

| Keys | Context | Action | file:line |
|---|---|---|---|
| Drag | Move layer (V) | Move the active layer or the mask under Quick Mask, whole doc px, one undo step. | tools/moveLayer.ts:74-115 |
| Drag starting inside the selection | Move layer, a selection exists | Lift the selected pixels into a float. | moveLayer.ts:79-85 |
| Alt+drag | Move layer, inside the selection | Float a copy, no hole. Outside the selection Alt does nothing. | moveLayer.ts:84 |
| Ctrl+drag | Move layer | Auto-select the topmost layer, off while a selection exists. The option is "Auto-select". | moveLayer.ts:92 |
| Arrows / Shift+arrows | active tool Move layer | Nudge 1 / 10 image px. Consecutive nudges merge into one undo. A nudge mid-drag is swallowed. | moveLayer.ts:130-139 |
| Arrows / Shift+arrows | active tool Move drawing | Nudge the placement 1 / 10 image px. Not undoable. | tools/move.ts:172-180 |
| Drag, Esc, "Reset position" | Move drawing | Move, cancel a drag, reset. | move.ts:132-158 |
| Ctrl+Alt+T | any, editor owns keys, no Shift | Free Transform. Targets the selection (lift), the active float, or the whole layer. AltGr-safe. Ignores key repeat. | ui/floatShortcuts.ts:42-49, 74-77 |
| Enter | float or transform active | Commit. A selection float stays floating after a session commit. The next Enter drops the float. Shift+Enter ignored. | floatShortcuts.ts:57-62 |
| Esc | same | Cancel (everything back). | floatShortcuts.ts:52-56 |
| Ctrl+Z | same | Cancel. Ctrl+Y ignored. | engine/editor.ts:354,362 |
| Arrows / Shift+arrows | transform session | Nudge the box. The session tool wins over the active tool. | tools/transformTool.ts:109-115 |
| Drag inside the box / on a handle / just outside a corner | transform session | Move / scale / rotate. Cursors per zone. | transformTool.ts:77-83, 123-137 |
| Shift while dragging a handle | transform session | Inverts the proportion lock. | transformTool.ts:88,95 (tooltip :147) |
| Shift while rotating | transform session | 15° steps. | transformTool.ts:148; engine/transformMath.ts:59 |
| Alt while dragging a handle | transform session | Scale around the centre. | transformSession.ts:42 |
| Options bar: X, Y, W, H, angle, Link, Flip, commit, cancel | transform session | Scrub fields and buttons. | transformTool.ts:142-153 |
| Switching tools or any other edit | float/session | Commits it (settle hook). | registry.ts:120; setBeforeSwitch |
| Click outside the box | transform session | Does nothing. | transformTool.ts:77 |
| Transform / Flip H / Flip V buttons | Move layer bar, or selection-tool bar with a selection | Start or flip. | transformTool.ts:294 |

### Clipboard (10)

| Keys | Context | Action | file:line |
|---|---|---|---|
| Ctrl+C | editor | Copy the layer's selected pixels (whole layer without a selection), plus a PNG to the system clipboard. | ui/clipboardShortcuts.ts:52-58 |
| Ctrl+Shift+C | editor | Copy merged (what is visible, including the image). | clipboardShortcuts.ts:56 |
| Ctrl+X | editor | Cut (copy + clear, one undo step). | clipboardShortcuts.ts:52-55 |
| Ctrl+V | editor | Paste as a new layer, centred on the image. Order: system image, then our copy, then clipspace. The keydown is stopped but not prevented, so the browser fires `paste`. | clipboardShortcuts.ts:45-50; shortcuts.ts:75 |
| Ctrl+Shift+V | editor | Our copy at its copied position. Falls back to Ctrl+V behaviour if there is none. | clipboardShortcuts.ts:38-44 |
| Ctrl+Shift+X | editor | Unbound. | clipboardShortcuts.ts:52 |
| Rail Copy, Cut, Paste buttons | rail | Same actions. | ui/toolRail.ts:80-84 |
| Paste long-press 400 ms, or right-click | rail | Menu: System clipboard / Clipspace. The choice sticks per button. | ui/pasteButton.ts:23,72-77,110-139 |
| Drop image files or web images on the stage | stage | Paste at the drop point, one layer per file. | ui/dropImport.ts |
| Images button | rail | Thumbnail panel. Click inserts and opens Free Transform. Closes on Esc, a stage press, a rail tool press, or the button again. | ui/imagesPanel.ts |

### Text (10)

| Keys | Context | Action | file:line |
|---|---|---|---|
| Click empty canvas | Text tool | New text layer with an in-canvas textarea. Quick Mask is switched off first. | tools/text.ts:195-207 |
| Click existing text | Text tool | Re-edit it. Clicking another text commits the open edit and switches. | text.ts:196-206 |
| Ctrl+drag | Text tool | Move the text layer (the Ctrl-Move substitute is off for Text). | text.ts:191, 264-272 |
| Enter | textarea | New line. | ui/textOverlay.ts:19 |
| Esc, Ctrl+Enter | textarea | Commit. Stopped before ComfyUI queues. | textOverlay.ts:120-125 |
| Click away or focus leaves the editor | text edit open | Commits. | textOverlay.ts:128,141-147 |
| `[` `]` | Text tool | Font size. Typing in the textarea types `[` instead. | shortcuts.ts:93; text.ts:154 |
| Ctrl+Z in the textarea | textarea | Native text undo. The editor never sees it. | keyboard.ts:336 |
| Ctrl+S in the textarea | textarea | Still intercepted (flush and save). | keyboard.ts:330 |
| Space in a text field | any field | Types a space. Never arms pan. | modifierScope.ts:42-45 |

Every other key from a text field passes through: letters, digits, Ctrl+A/C/V/X, F-keys, Tab, arrows.

### Regions (9)

| Keys | Context | Action | file:line |
|---|---|---|---|
| O, or Outputs button | any | Open the Outputs tab (region mode). Pressed again with the panel open it returns to Layers and the last tool. | hostSync.ts:219-231 |
| Drag on empty canvas | region mode | Draw a new region in the lowest empty slot. | tools/region.ts:124-126 |
| Shift+drag | region mode | Always draws a new region, even when starting inside one. | region.ts:124 |
| Plain drag inside a region | region mode | Move it. | region.ts:57-68 |
| Drag a handle of the selected region | region mode | Resize. | region.ts:61-64 |
| Click empty canvas | region mode | Select Main. | region.ts:140 |
| Esc | region drag | Cancel. Region tool `pending()` is true during a drag. | region.ts:143-148; stageInput.ts:151 |
| Double-click a card title | Outputs panel | Rename the name only. Enter commits, Esc cancels. | ui/outputCard.ts:105; inlineRename.ts |
| X/Y/W/H label drag | Outputs panel | Scrub (2 px per step, Shift ×10). Esc reverts, Enter or release commits. | ui/outputField.ts:12,15,113-119,124-164 |

Selecting a card or region is not a document edit. Pressing any card also selects it (`outputCard.ts:43-47`). There is no keyboard or arrow control for regions.

### Fullscreen (7)

| Keys | Context | Action | file:line |
|---|---|---|---|
| F | editor | Toggle. | shortcuts.ts:133 |
| Esc | fullscreen | Exits last in the cascade. | shortcuts.ts:71; editorHost.ts:194-198 |
| Exit button, placeholder click | overlay and node | Exit. | ui/fullscreen.ts:93, 167-176 |
| All keys the editor doesn't handle | fullscreen | Swallowed (`preventDefault` and stop). Exceptions below. | ui/fullscreenKeys.ts:53-67; keyboard.ts:352 |
| Pass-through | fullscreen | Bare modifiers; F1..F24; Alt+←/→; Ctrl/Cmd+R/W/T/N/L/Tab/PageUp/PageDown (±Shift); Ctrl+Shift+I/J/C (see B3); Ctrl+S and Ctrl+Enter (±Shift); Ctrl+V (±Shift). | fullscreenKeys.ts:36-64 |
| Backdrop wheel, drag/drop | overlay | Wheel stopped (Ctrl+wheel prevented). Drops are refused so they can't load a workflow into the hidden graph. | fullscreen.ts:181-196 |
| Fullscreen always owns the keyboard | fullscreen | Active without hover. Focus is reclaimed after a backdrop click. | keyboard.ts:192-208 |

**Not bound anywhere:** `?`, F1, Caps Lock (no precise cursor), Tab (no hide-panels), Home/End/PageUp/PageDown, Enter outside float/session (Ctrl+Enter is never handled in the editor outside the text tool), Ctrl+Shift+D (Reselect), Ctrl+J, Ctrl+Alt+Z, Alt+Delete, Shift+drag axis-lock in Move layer.

## B. Conflicts and oddities

1. **Esc in the FG/BG colour picker commits instead of reverting.** After dragging in the SV square or hue slider, focus is on the key sink. Esc goes through `handleShortcut`, which calls `popoverHost.close()` (`editorHost.ts:188-193`). The picker sets `escaped` only when the keydown reaches the popover element, i.e. focus is in the hex field (`colorPicker.ts:244-256`). So Esc commits. The old spec says "Esc reverts" (SPEC.md:259). Likely a bug; verify in the browser.
2. **Arrows nudge a float only with Move layer active.** The only callers are `moveLayer.ts:136` and `transformTool.ts:113`. A float lifted with Ctrl+drag from a marquee, lasso or wand is not nudged by arrows, even though the old spec says "While floating … arrows nudge" (SPEC.md:444). In non-fullscreen the key then falls through to ComfyUI.
3. **DevTools chords are blocked while the editor is active, fullscreen included.**
   - `fullscreenKeys.ts:39` lists Ctrl+Shift+I and Ctrl+Shift+C as browser pass-through.
   - The editor handles them first as invert (`selectionShortcuts.ts:44`) and copy merged (`clipboardShortcuts.ts:52`), so they never reach the pass-through.
   - The code comment "DevTools still opens elsewhere" is only true outside the editor.
   - The same hijacking applies to Ctrl+D (bookmark) and Ctrl+=, Ctrl+-, Ctrl+0 (browser zoom).
4. **Stale text in the old spec.**
   - Transform is "Ctrl+T" at SPEC.md:524, :533 and :671. The code and the later log use Ctrl+Alt+T.
   - SPEC.md:605 says V is "reserved for a future element Move tool". V is Move layer.
   - SPEC.md:541 says the Images panel closes on "Click outside". The panel stays open (`imagesPanel.ts:9-17`).
   - SPEC.md:262 gives the Esc order as "popover / rename, then fullscreen". The real order is Images panel, float/transform, tool drag, popover, fullscreen. Rename Esc is handled inside the field.
   - SPEC.md:224 and :236 are still correct.
5. **Delete and Backspace are swallowed in every context.**
   - They are swallowed with no selection, with Shift, and on key repeat.
   - In region mode with a stray selection they clear selection pixels, and there is no key to delete a region.
   - Alt+Delete is not a fill (Alt+Backspace is).
   - Delete does not delete layers or nodes.
6. **A focused `<select>` or text field keeps native focus.** After picking a Sample or Align option, letter and bracket shortcuts do nothing until you click the stage or another non-text control (`focusPolicy.ts:48-52, 80-82`). Range sliders also keep focus, so arrows adjust the slider.
7. **`[` `]` do nothing for shape tools.** The option key is `width`, not `size` (`shapeTool.ts:60`). Digits (opacity) do work on shapes. Text responds to `[` `]`.
8. **Right-click on the stage is not suppressed.** `contextmenu` is only propagation-stopped at the root (`eventIsolation.ts:62`). Only the group slot and the Paste button call `preventDefault`. A native context menu probably appears; unverified.
9. **Ctrl+Alt+Enter (ComfyUI interrupt) is swallowed in fullscreen** (`fullscreenKeys.ts:59` only allows Ctrl/Cmd without Alt). Ctrl+Shift+Enter passes.
10. **`pageGuards.ts:93` installs an always-on global keydown listener** for F5/Ctrl+R. AGENTS.md says "no always-on global listeners". It is deliberate, but it is not editor-scoped.
11. **Move layer has no Shift axis lock.** Alt+drag outside a selection does nothing. Photoshop Alt+drag duplicates the layer.
12. **Eraser has no Alt behaviour.** This is deliberate ("eraser no, like Photoshop", `paintTool.ts:70`).
13. **Two modifier meanings coexist.**
    - Layer-row Ctrl+click is hard selection. The lmask thumbnail's Ctrl+click is soft. This is documented (SPEC.md:800, :836).
    - Shift+click on the lmask thumbnail toggles it off, but Ctrl+Shift+click adds to the selection. Ctrl has priority (`layerMaskThumb.ts:108-112`).
14. **Documented in code but absent from the old spec sections I read:**
    - Ctrl+Enter/Esc committing text.
    - Right-click opening the group and Paste flyouts.
    - Shift ×10 on scrubs.
    - Wheel over the options bar scrolling sideways.
    - Cobweb click regrow.
    - Shift+Delete and Shift+Backspace.
    - Ctrl+Shift+X being unbound.
    - The F-key / Ctrl+R / Alt+arrow allow-list (only in the M3 decision log, SPEC.md:929).
15. **No old-spec binding is entirely missing from the code.** The mismatches are the stale or wrong text in item 4 and the Esc-revert claim in item 1.

## C. Free keys

ComfyUI ignores plain and Shift-only keys when the focus sink (an `<input>`) is focused. The rule is `isReservedByTextInput` in `ComfyUI_frontend/src/platform/keybindings/keyCombo.ts:75-81`, applied at `keybindingService.ts:31-35`. So an unbound plain key is inert in the node and does not hit the graph. In fullscreen, unhandled keys are swallowed.

- **Single letters bound:** B E G I M L W U T V Q X D F O (15).
- **Single letters free:** A C H J K N P R S Y Z (11). ComfyUI binds r, w, n, m, a, v, h, p, `.` on the graph canvas only, so there is no real clash while the sink has focus.
- **Plain `?` is free and safe.** It is Shift+`/`, which ComfyUI ignores in an INPUT. Today it is only swallowed in fullscreen. F1 is also free: nothing in the code binds it, and the fullscreen policy passes F1..F24 to the browser, so F1 would have to be handled before that policy.
- **Other plain keys free:** `, . / ; ' \`, plain `-` and `+`, Enter (except float/session), Tab, Home, End, PageUp, PageDown, F1–F12 (F7 only with Shift), Caps Lock. Arrows are only bound in Move layer, Move drawing and transform sessions.
- **Shift+letter:** only Shift+M and Shift+U are bound. All others are free. Shift+digit is free.
- **Ctrl+letter bound:** Z Y A D E C X V S, Ctrl+Alt+T, Ctrl+Shift+Z/I/C/V, Ctrl+0/1/=/-, Ctrl+Backspace.
- **Ctrl+letter free:** F J K P Q U and others. B, G, M, O collide with ComfyUI graph commands (bypass, group, mute, open). L, N, R, T, W, H are browser keys. Ctrl+Shift+D (Reselect) is free but the browser binds it.
- **Alt+letter:** the editor binds none (only Alt+Backspace). ComfyUI binds Alt+C, Alt+M, Alt+=, Alt+-.

## D. Suggested help-overlay grouping

The first six sections are the "useful" tier. The rest are exhaustive.

| Section | Tier | Count to show |
|---|---|---|
| Tools | useful | 12 (10 letters, Shift+M/U cycle, Ctrl/Alt temporary tools) |
| Brush and colour | useful | 8 (`[ ]`, Shift+`[ ]`, 1–0, Shift+click line, X, D, Alt picks colour, scrub) |
| View | useful | 6 (wheel, Space-drag, middle-drag, Ctrl+0, Ctrl+1, Ctrl+=/-) |
| Selection | useful | 10 (modifiers, Ctrl+A, Ctrl+D, Ctrl+Shift+I, Delete, Alt/Ctrl+Backspace, Ctrl+drag lift, Ctrl+Alt+drag copy) |
| Layers, lmasks and cmasks | useful | 10 (row Ctrl+click and modes, lmask icon and thumbnail clicks, Ctrl+E, double-click rename, Q) |
| General and clipboard | useful | 10 (Ctrl+Z, Ctrl+Y, Ctrl+S, Esc cascade, F, O, Ctrl+C, X, V, Shift+V) |
| Move and Transform | exhaustive | 10 (V, arrows, Auto-select, Ctrl+Alt+T, Enter/Esc, handle modifiers, Move-drawing wheel) |
| Text | exhaustive | 6 |
| Regions | exhaustive | 5 |
| Fullscreen | exhaustive | 4 (F, Esc, pass-through list, "hold"-style notes) |
| Pointer-only and long-press | exhaustive | 6 (400 ms long-press, right-click flyouts, cobweb click, scrub, drag-reorder) |

That is about 87 entries across 11 sections: 56 in the useful tier and 31 in the exhaustive tier. Some general rows, such as the fullscreen pass-through list and the page-reload guard, are better shown as footnotes.

The static inventory above adds up to about 150 rows over 12 tables. `shortcuts.ts` imports from `clipboardShortcuts.ts`, `floatShortcuts.ts` and `selectionShortcuts.ts`. A single `shortcuts` data file describing the keys, plus a test that fails when the code and the table disagree, would keep the help overlay and the spec in sync. Today the spec and code have already drifted (B4).