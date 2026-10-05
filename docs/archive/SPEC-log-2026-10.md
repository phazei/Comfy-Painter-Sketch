# SPEC log, October 2026

Decision and tuning record moved out of `docs/SPEC.md` section 25 on 2026-10-03 when the spec was condensed. The full pre-condensing spec is `SPEC-2026-10-03-full.md`.

### M7b -- release polish (agreed 2026-09-30)

Order: 1 -> 2 -> 3 -> 4 -> 5 -> 6.

1. [x] **Spec rewrite** -- this file; old spec archived; mismatches ruled on and
   fixed (2026-09-30).
2. [x] **Icons and cursors, Lucide style** (mapping approved 2026-10-01; visual
   review page `docs/temp/icon-preview.html`). No npm dependency: the Lucide
   1.49.0 markup we use is copied into a source module with the ISC licence
   note; only those icons are bundled. Icons become multi-element inner markup
   (Lucide uses path/circle/rect/line/ellipse), stroke 2 for now (final
   size/stroke are CSS variables chosen in the UI refresh).
   **Done 2026-10-01** (checked in-app by the user):
   `ui/lucideIcons.ts` (generated copy, ISC + Feather MIT notes), `ui/icons.ts`
   (names -> Lucide / custom), `ui/cursorArt.ts` (composer), `ui/cursors.ts`,
   `ui/moveCursors.ts`, `ui/ringCursor.ts`; current behaviour is in section 24
   "Cursors". Tune during testing: badge positions / sizes, halo widths, the
   accent colour, the 6 px ring-to-cross and 300 px centre-dot thresholds. `ui/vendor/` is only the
   source of the copy (not used by the build).
   - [x] **Rename** Move drawing -> **Align drawing** (user-visible text and
     docs; code ids such as `move.ts` / tool id `move` unchanged).
   - **Icon mapping** (current key -> Lucide name, or custom):
     brush `brush`; eraser `eraser`; bucket `paint-bucket`; eyedropper
     `pipette`; line `slash`; arrow `move-up-right`; rectangle
     `rectangle-horizontal`; ellipse `ellipse`; text and the text-layer badge
     `type`; move `move`; marqueeRect `square-dashed`; marqueeEllipse
     `circle-dashed`; lasso `lasso`; magicWand custom (user's); region `vector-square`;
     transform `scaling`; copy `copy`; cut `scissors`; paste custom (user's clipboard with two lines);
     undo/redo `undo-2`/`redo-2`; fit `fullscreen`; clear `brush-cleaning`;
     fullscreen/exit `maximize-2`/`minimize-2`; images `images`; panel
     `panel-right`; stylus `pen`; flipH `triangles-centerline-dashed-vertical`;
     flipV `triangles-centerline-dashed-horizontal`; check `check`; close and
     the disabled-lmask X `x`; trash `trash`; invert (selection, cmask row)
     `contrast`; text Bold/Italic toggles `bold`/`italic`; New layer
     custom (user's open-corner sheet + plus); duplicate `copy`; mergeDown `layers-arrow-down`;
     eye/eyeOff `eye`/`eye-off`; lock/unlock `lock`/`lock-open`; solo
     `circle-dot`; "+ Region N" `plus`. **Kept**: FG/BG swap (current icon),
     reset squares. **Custom** (24 grid, stroke 2): alignDrawing (user's
     markup: bottom sheet `M4 11.5 1.5 13 12 19l10.5-6-2.5-1.5` + an
     isometric move arrow drawn 0.5 thinner than `--cps-icon-stroke`,
     `M7 6.2l10 6.4M7 12.6l10-6.4M10.5 6 7 6.2v2.1M13.5 6l3.5.2v2.1M10.5 12.8 7 12.6v-2.1M13.5 12.8l3.5-.2v-2.1`);
     quickMask (rect + outline circle); pasteClipspace (`clipboard` + the user's filled slanted "C");
     mask glyph (rounded square + filled circle)
     and its inverted form; maskAdd (the New layer sheet + filled circle; New mask and add lmask);
     selectionToMask (square-dashed + filled circle); `square-dashed-minus`.
   - **Precise cross** (user's; no circle): arms `M12 2v3M12 22v-3M2 12h3M22 12h-3`,
     plus filled inward wedges `M11 5H13L12 10.5ZM11 19H13L12 13.5ZM5 11V13L10.5 12ZM19 11V13L13.5 12Z`;
     centre open. Hotspot (12, 12).
   - **Cursors**: SVG data URLs up to 64 x 64, glyph ~24 px drawn as a dark halo
     under a light stroke; badges ~16 px, spread outside the glyph: mode
     bottom-right (`ban` replaces it); no edit-target badge. Colours are shared CSS
     variables (`--cps-cursor-fg`, `-halo`, `-ban`, `-accent`) read when the
     cursors are built (data URLs can't use CSS variables) and rebuilt on change.
     The OS cursor set never shows over the stage.
     - Brush / Eraser: CSS cursor = a tiny dot; the overlay draws the ring and
        its indicator just outside the ring on the bottom-right 45-degree diagonal
        (eraser glyph or `ban`), with a minimum offset
       from the centre; badges grow slightly with large rings. When the ring is
       too small on screen, the CSS cursor becomes the precise cross.
     - Photoshop-style pointer tools: a tiny arrow tip (`mouse-pointer-2`) at
       the top-left is the hotspot, the tool glyph sits larger to the lower
       right: Bucket, Lasso, Polygonal lasso, Move (with `move`), cut-move (with
       `scissors`), copy-move (with `copy-plus`), outline drag / Ctrl over a layer
       row (with `square-dashed`).
     - Eyedropper `pipette`, hotspot at the tip; Alt-from-background adds the
       BG-slot badge (user's markup `M14 20a2 2 0 002 2h4a2 2 0 002-2v-4a2 2 0 00-2-2v6z`,
       `M14 20a6 6 0 006-6`, rect 8,8 8x8 rx 2). Magic wand `wand`, hotspot at
       the tip. Text `text-cursor`. Shapes, marquees, region tool and transform
       outside the box: precise cross. Transform handles `move-horizontal`,
       `move-vertical`, `move-diagonal`, `move-diagonal-2`; rotate zone
       `refresh-cw`. Align drawing `move`. Pan `hand` / `hand-grab`; loading
       `hourglass`.
     - Selection mode badges `square-dashed-plus` / `square-dashed-minus` /
       `square-dashed-x` (fall back to plain `+ - x` if they read badly).
       Region tool Shift (new region inside another): `square-dashed-plus`.
     - Not-allowed: `ban` replaces the mode badge when the tool can't edit the
       target, computed before the click (the reason still shows as a note on
       click).
   - **Modifier indicators**: lmask thumbnail Alt = `scan-eye`, Shift = red `x`,
     Ctrl = the selection pointer; add-mask button with Alt = inverted mask
     glyph. Drag-only constraints (Shift square, Alt from centre) get none.
3. [x] **UI refresh**. Procreate-like styling and spacing, not
   minimalism; keep following ComfyUI theme colours; floating menus and fly-outs
   allowed; a shorter long-press for fly-outs;
   more room while keeping every feature reachable in-node. Includes the **help
   overlay**: `?` key and a `?` button, sections of useful shortcuts; a single
   source file for the shortcut list if a sensible display for all of them
   exists.
   **Done 2026-10-02** (design handoff: floating bars over the stage): history
   pill, tool dock (Select / Shapes groups, eyedropper reveal, swatches),
   options strip, sliders pill, images / clipboard pill (sticky Copy / Copy
   merged), bottom bar (edit chip, Quick Mask, lmask options, Align, resolution),
   amber resolution notice, floating Layers / Outputs panel (sections, slot
   grid, segmented output modes), white region overlay, one 380 ms long-press,
   help overlay from `ui/shortcutList.ts`, new Esc chain (section 7). Confirms
   stay `window.confirm`. First browser round (2026-10-03): chrome hides while
   the node is idle (750 ms hover show / 250 ms hide grace), keyboard line on
   the dock, 1100 px bar cap, two bottom pills, fullscreen panel below the
   top row, Images button hidden without sources, notice returns with Align.
   Later rounds: Layers panel header Delete, selectable read-only Background
   row, help overlay (Essentials band, flowing columns, key chips), light-theme
   colours (`--cps-fg-strong`). Closed 2026-10-03.
   - [x] **Float on visibility change**: eyes, solo and lmask on/off no longer
     commit a float; hiding the float's own layer does. Closed 2026-10-03.
4. [x] **Simple mode**: done as described in section 7 "Simple mode" (per
   node in `node.properties`, default setting, Tab, header toggle; no Layers
   panel -- the edit chip and Quick Mask manage one layer, its lmask and the
   cmasks). Closed 2026-10-03.
5. [ ] **README** (after the UI, with the user's screenshots; no install
   section): pitch, quick start, feature overview, I/O, condensed shortcuts,
   storage and cleanup, limitations, licence. Example workflow(s) = the node with
   its inputs attached. Use-case ideas for videos are brainstormed outside the
   repo from this spec.
6. [ ] **Manual checklist** (AGENTS.md "Testing") with Nodes 2.0 off and on, then
   release.


### cmask Invert replaced by Subtract (2026-10-04)

Per-cmask `invert` (mask layers and the `imageMask` record) is gone; the
field is `subtract`. No migration and no manifest version bump: the node is
unreleased, and old `invert` values are simply ignored on load (a cmask reads
as normal). Don't add a migration for `invert` later. Reason: the union of two
inverted cmasks is the inverse of their intersection, so almost everything was
masked; Subtract (`MASK = U * (1 - S)`) composes. Side effect removed: an
inverted Image/Input Mask row was 1 outside the image in Python and 0 in the
editor; with Subtract outside is 0 everywhere. The "To mask" target fix
(`lastCmaskId`) landed the same day.
