# AGENTS.md

Guidelines for working on this project. Read this before making changes.

This file holds the **stable** rules: philosophy, architecture, conventions, and
hard-won gotchas. The **goals, feature scope, milestones, decisions, and progress**
live in [`SPEC.md`](SPEC.md). Read both. Update `SPEC.md` as work lands; only
change this file when an architectural rule or convention changes.

## Project Goals

A single, well-built ComfyUI paint node: take an `IMAGE` in, paint on it (and
optionally draw a mask) directly inside the node, output `IMAGE` and `MASK`.

- **In-node first** -- 90% of use happens inside the node body on the graph. A
  fullscreen button opens the same editor larger; it is the same editor, not a
  separate app.
- **Simple, not a kitchen sink** -- a focused tool set done well beats a large
  tool set done poorly. If a feature isn't in `SPEC.md`, don't add it without
  asking.
- **Well-organized, well-documented code** -- small modules with one job each.
  Every module, class, and exported function gets a docstring / JSDoc / TSDoc.
- **Modern ComfyUI patterns** -- V3 Python schema, DOM widget frontend that works
  on both the LiteGraph renderer and the Nodes 2.0 (Vue) renderer.
- **Robust** -- malformed saved documents, missing input images, and failed
  uploads degrade gracefully; they never crash the node or lose the user's work
  silently.

### Explicitly out of scope

No sessions, no custom server routes (single exception: `POST
/painter-sketch/cleanup` for the settings cleanup button, see SPEC), no iframe, no separate application, no AI
prompt box / "describe the next generation" dock, no output comparison pane, no
run button inside the editor. Use ComfyUI's own endpoints (`/upload/image`,
`/view`) and its own queue.

## Source Projects

We are writing from scratch. These are **references**, not code to copy wholesale.
Both are months old; ComfyUI has changed a lot since. Verify any integration
detail against the local frontend/backend source listed under Local References.

| Project | Location | Take | Avoid |
|---|---|---|---|
| **ComfySketch** (skeleton) | `D:\AITools\comfyui-comfysketch` (`js/comfysketch.js`, one 4,900-line file) | Integration shape: one `nodeCreated` hook, a DOM widget, no LiteGraph drawing or prototype patching. Canvas 2D with one offscreen canvas per layer. Per-stroke buffer composited at `opacity` on pointer-up (stops overlapping stamps stacking alpha). Pointer-event pressure. Multi-source input-image URL lookup (`getInputImageUrl`). Swallowing keydown while the editor is active. SVG overlays for handles/selection | Monolith file. Editing only in fullscreen (we edit in-node). Floating draggable panels. Full JPEG data URI stored in the widget/workflow. Undo that stores data URLs per layer per step and reloads them async (slow, racy). `'lighter'` soft brush (blows out to white). String-keyed flood-fill visited set. No coalesced events. `setTimeout(100)` init. Inline-style theme patching. V1 Python schema, `IS_CHANGED = nan` |
| Comfy Canvas (editor/UI ideas) | `D:\AITools\Comfy-Canvas` | Layer model (id/name/opacity/blend/visible/locked), versioned layer document, text tool (re-editable `textData`, `<textarea>` overlay, commit to raster), brush settings (size/hardness/opacity/flow/spacing, shape), left tool rail + top options bar + layers panel look | iframe app, sessions/routes, AI prompt dock, output pane, 6k-line `editor.js` with `if (tool === ...)` chains, whole-document snapshot undo, PIXI dependency, no pressure |
| Core ComfyUI `Painter` node | `comfy_extras/nodes_painter.py`, frontend `src/composables/painter/usePainter.ts`, `src/components/painter/WidgetPainter.vue` | Current, official pattern for persistence (upload PNG on `serializeValue`, store `"name [input]"` in a widget) and for showing the upstream image (`nodeOutputStore.getNodeImageUrls(node.getInputNode(0))`) | It is brush + eraser only; don't depend on its internals (they're not a public API) |
| Core frontend Layer Editor | `ComfyUI_frontend/src/renderer/extensions/layerEditor/` | Reference for document/history/fill/compositor module split and tests | Not an extension API; don't import from it |
| "PaintPro" (screenshot) | -- | Visual target: vertical tool rail on the left inside the node, canvas filling the node, `image` in / `IMAGE` + `MASK` out | Its overbuilt settings panel (texture, dual brush, scattering, etc.) |

## Architecture

### Python (node backend)

- **V3 schema** (`comfy_api.latest`) -- `io.ComfyNode`, `define_schema()`,
  `io.NodeOutput`, `ComfyExtension`, `comfy_entrypoint()`.
- Do NOT use V1 (`NODE_CLASS_MAPPINGS`, `INPUT_TYPES`). `NODE_CLASS_MAPPINGS` must
  NOT exist in `__init__.py`, even empty -- see "ComfyUI Loader Fork" below.
- `__init__.py` exports `WEB_DIRECTORY = "./js"` and `comfy_entrypoint`.
- Node code in `nodes/`; each node imported in `nodes/__init__.py` and listed in
  `ALL_NODES`.
- Category: an existing ComfyUI category (`image`), not a custom top-level one.
- Logging: `logging.getLogger("paintersketch.<module>")`. Short, actionable messages.
- The Python side is deliberately thin: resolve the saved layer/mask images from the
  `input` folder, composite over the input image, return `IMAGE`/`MASK` and a
  UI preview of the input image. All editing logic lives in the frontend.
- Treat widget values that name files as untrusted: resolve through
  `folder_paths.get_annotated_filepath()` and verify with
  `folder_paths.exists_annotated_filepath()`; never join raw strings into paths.
- Use `node_helpers.pillow(Image.open, path)` for loading (retries truncated images).
- `fingerprint_inputs` hashes the saved layer files (stat) so edits re-execute the node and
  unchanged edits hit the cache.

### JavaScript / TypeScript (frontend)

- **TypeScript + Vite**, source in `ui/`, built output in `js/`, **built output
  committed** so users never run a build.
- Build: `cd ui && npm run build`. `ui/node_modules/` is gitignored.
- Do NOT hand-edit anything in `js/` that the build produces.
- **Single-file bundle.** ComfyUI loads every `**/*.js` under `WEB_DIRECTORY` as an
  extension entry point, so code-split chunks would be loaded as extra
  entry points. Configure Vite library mode with one ES entry and
  `inlineDynamicImports: true`. Keep hand-written files out of `js/` unless they
  are intended entry points.
- **CSS**: ComfyUI only auto-loads `.js`. Import CSS as a string (`?inline`) and
  inject a single `<style>` element once, or inject a `<link>`. Scope every class
  under a project prefix (`.cps-`) so we never collide with the frontend.
- **Imports from ComfyUI**: only `app` and `api`, externalized by Vite and
  resolved at runtime: `import { app } from "../../scripts/app.js"` /
  `"../../scripts/api.js"`. In source, import them as `@comfy/scripts/app.js` /
  `@comfy/scripts/api.js`; tsconfig `paths` maps these to our local types
  (`ui/src/types/`) and Vite rewrites them to the literal runtime paths. The
  official `@comfyorg/comfyui-frontend-types` package ships no `.d.ts` (checked
  1.50-1.56), so we keep minimal local types for what we use. The frontend deliberately keeps `scripts/app` and
  `scripts/api` shims warning-free; other `scripts/*` / `extensions/core/*` shims
  are deprecated and print warnings. Never import frontend internals (`@/...`).
- **No UI framework by default.** Editor UI is plain TypeScript DOM components.
  If we ever bundle Vue, remember the dual-runtime problem (below): our Vue
  instance is invisible to the frontend's reactivity. Decision tracked in `SPEC.md`.
- Register one extension: `app.registerExtension({ name: "phazei.PainterSketch", ... })`.
  `phazei` is the publisher ID / GitHub owner; user-visible names are just
  `PainterSketch` (node ID and display name).
- Hooking our own node type: `beforeRegisterNodeDef(nodeType, nodeData)` with a
  `nodeData.name === "PainterSketch"` guard, chaining our node's prototype callbacks
  (`onNodeCreated`, `onExecuted`, `onRemoved`, `onResize`) by calling the original
  first. This is the maintainer's usual pattern and is fine for our own node
  class. Never patch `LGraphNode.prototype`, `LGraphCanvas.prototype`, or other
  nodes' types.
- Settings are declared in `ui/src/settings.ts` (the extension `settings` array),
  IDs prefixed `PainterSketch.`, and read through `readSetting` / `ui/src/defaults/`
  (`app.extensionManager.setting.get`, guarded: missing API or a throw -> code
  default). `color` settings are stored without the `#`. Default settings apply
  to new documents / new sessions only, never to live state.
- Console prefix: `[PainterSketch]`.
- **User messages** go through `notify` (`ui/src/widget/toast.ts` +
  `toastLimiter.ts`): each message has a key and is shown at most once per window
  (10 s default, 60 s for upload problems); the console still logs every
  occurrence with details. Toast title is "PainterSketch" -- don't repeat the name
  in the text. Severity: error = user work at risk, warn = degraded, info = rare
  (recovery, cleanup results). Classify failures in `widget/failures.ts`.
  Background image load failures stay console-only (upstreams change constantly).

### Frontend module layout (target)

Keep modules small and single-purpose. No file should approach the 1,000-line mark;
if it does, split it.

```
ui/src/
  main.ts                 -- registerExtension + node hook wiring only
  widget/                 -- ComfyUI integration: addDOMWidget, sizing,
                             serializeValue/upload, restore, input-image lookup
  document/               -- versioned layer document: types, (de)serialize,
                             migrations, validation
  engine/                 -- rendering + editing, no DOM UI
    compositor.ts         -- layers -> display canvas, export composite/mask
    history.ts            -- undo/redo (dirty-rect patches, not full snapshots)
    viewport.ts           -- pan/zoom, screen<->image coords, pan clamp
    frameMap.ts           -- document frame <-> current image mapping (matches Python)
    floodFill.ts          -- scanline fill on typed arrays (pure; `clip` seam for selection)
    docComposite.ts       -- "what the user sees" in doc coords (for sampling)
    shapes.ts             -- shape geometry (pure)
    brush.ts              -- stamp generation, spacing, pressure curve
    selection.ts          -- selection as a Uint8 coverage mask + cached outline
  tools/                  -- one file per tool implementing a common Tool interface
    brush.ts eraser.ts fill.ts line.ts shape.ts eyedropper.ts text.ts
    marquee.ts lasso.ts magicWand.ts ...
  ui/                     -- toolbar rail, options bar, layers panel,
                             color picker, fullscreen host
  geometry/               -- shared rect/size helpers (pure)
  styles/                 -- CSS (injected by main.ts)
```

- Tools produce brush dabs / operations; the engine owns the stroke buffer,
  layer canvases and history.
- Tools sharing a rail slot/key (shapes on `U`, marquees on `M`) are a tool
  group (`tools/toolGroups.ts`); Shift+key cycles. `altEyedropper = true` on a
  tool makes Alt-at-pointer-down a temporary eyedropper. Rail tools also get
  Ctrl = temporary Move layer with auto-select (`ctrlMove`, default on; off for
  Move layer, Text, hidden tools). Precedence: Ctrl > Alt > active tool; resolved
  at pointer-down, locked for the drag. Modifier tracking is observe-only.
- Optional Tool hooks: `onWheel` (Move scale-while-dragging), `onKey` (arrow
  nudges), `pending()` / `onHover()` (lasso polygon in progress). Descriptor kinds
  include `button`.
- All doc <-> image conversion goes through `documentMap(doc, imageSize)` /
  `editor.frameMap` (includes Move placement). Never call `frameMap(doc.frame, ...)`
  directly or re-derive the formula.
- `engine/rasterize.ts` `preparePixelEdit` is the **single gate** before any
  pixel edit (lock / hidden-mask notes, text-layer rasterize confirm). New
  pixel-editing paths must call it.
- Layer moves go through per-kind handlers in `engine/layerMovers.ts` (paint/mask
  translate pixels; text updates `textData`). Move preview = draw the layer
  offset; pixels move once, on commit.
- Descriptor kinds: slider/number/toggle/select/button/text. An open text edit is
  a `Tool.pending` interaction.
- Selection coverage is rasterized without a canvas (`engine/selectionRaster.ts`)
  so it's unit-testable (the test environment has no canvas).
- Tool options are **declarative** (descriptors: slider/number/toggle/select),
  rendered generically by the options bar. No per-tool UI code.
- `ui/shell.ts` owns the regions (rail, options bar, stage, side panel) and the
  popover host, which lives **inside** the editor root so popovers follow it into
  fullscreen. Wheel isolation covers the whole root: the stage zooms, the options
  bar scrolls sideways, other regions scroll natively, nothing reaches the graph.
- The element passed to `addDOMWidget` is a stable wrapper (`.cps-widget`) that
  never moves; only the editor root inside it moves (fullscreen). Both renderers
  only check that the wrapper is their child.
- Clicking non-text controls in the editor must not take DOM focus (keyboard
  scope prevents it on pointerdown and redirects stray focus to the hidden
  key-sink input); otherwise ChangeTracker's graph undo also fires on Ctrl+Z.
- Python mirrors this split: `nodes/document.py` (manifest parse), `nodes/layers.py`
  (safe file resolve + load), `nodes/composite.py` (pure torch). Python tests:
  `python -m unittest discover tests` with ComfyUI on `sys.path` (ComfyUI venv).

- **Tools are objects implementing one interface** (e.g. `onPointerDown/Move/Up`,
  `onKey`, `drawOverlay`, `cursor`, `options`). No `if (tool === "brush")` chains
  in the editor core.
- **Engine has no DOM UI dependencies**; UI talks to the engine through a small
  editor API + events. This is what lets the same editor mount in the node and in
  fullscreen.
- Rendering: Canvas 2D with one offscreen canvas per layer (no PIXI). Revisit only
  with a measured performance problem.
- Pointer input: Pointer Events with `pointerType`, `pressure`,
  `getCoalescedEvents()`; `setPointerCapture` during strokes; `touch-action: none`
  on the canvas.

### Persistence model

- The saved state is a **versioned layer document** (JSON manifest with
  `version`, canvas size, layers, text data, mask) plus one image per layer
  (masks PNG; paint lossy WebP per setting -- see SPEC "Saved-file contract").
- Pixel data is uploaded to ComfyUI's `input` folder via `POST /upload/image`
  (subfolder `painter-sketch/`), only when dirty. Upload timing is in SPEC
  (focus loss, 5 s idle, queue via `serializeValue`, intercepted Ctrl+S).
- The cleanup route (`nodes/cleanup_route.py`) is registered at import time via
  `PromptServer.instance.routes` and is a no-op when no server exists (tests).
  Its filename regex is shared with `ui/src/cleanup/references.ts`; a test fails
  if the two copies differ.
- The widget value stores the manifest (file references, not base64). Never put
  base64 image data in the workflow JSON.
- Every load path runs through `document/` migration + validation. Unknown or
  broken documents load as an empty paint layer with a toast, never a crash.
- Bump `version` for any breaking manifest change and add a migration.

### Git
The maintainer makes all commits. Agents update `SPEC.md` checkboxes/log as work
lands but never run `git commit`.

## Code Style

### Python

- Module-level docstring explaining what the file does and where ideas originated.
- Docstrings on all classes and public functions.
- Type hints on function signatures.
- `from __future__ import annotations` is not used.
- Imports: stdlib, third-party, then ComfyUI/local. Module scope only.
- `@classmethod` for V3 node methods (`execute`, `define_schema`,
  `fingerprint_inputs`, `validate_inputs`).
- No speculative `try/except`; only where there's a real failure mode and a
  useful fallback.

### TypeScript

- TSDoc on all exported functions/classes with `@param` / `@returns`.
- Section headers: `// ── Section Name ──────────`; major sections `// ═══════════`.
- `const` by default, `let` only when reassigned, never `var`.
- No `any`, no `@ts-ignore`. Narrow unknown data (saved documents, API responses)
  with type guards.
- Arrow functions for callbacks and short lambdas.
- Defensive checks at real boundaries: `node.inputs ?? []`, `out.links?.length`.
- Pure functions where possible (geometry, flood fill, document migrations) so
  they're unit-testable without a browser.

## Key Gotchas

### ComfyUI Loader Fork
`NODE_CLASS_MAPPINGS` and `comfy_entrypoint` are mutually exclusive in ComfyUI's
loader. If `NODE_CLASS_MAPPINGS` exists (even `{}`), the V1 path runs and
`comfy_entrypoint()` is never called. Only `WEB_DIRECTORY` is read before the fork.

### Two Renderers
ComfyUI has the legacy LiteGraph canvas renderer and the Nodes 2.0 Vue renderer.
**LiteGraph is the primary target** -- it's what the maintainer uses day to day,
so it gets tested first and must feel best. Nodes 2.0 must also work (no broken
layout, no lost data), but polish there is secondary. Don't write code that only
works in one renderer when a renderer-neutral approach exists.
- DOM widgets (`node.addDOMWidget(name, type, element, options)`) work in both:
  Nodes 2.0 mounts the element via `WidgetDOM`. Canvas-drawn custom widgets fall
  back to `WidgetLegacy` and are fragile -- don't write any.
- Widget routing in Nodes 2.0: `getComponent(widget.type) || (widget.isDOMWidget ? WidgetDOM : WidgetLegacy)`.
  Do NOT reuse the registered `painter`/`PAINTER` widget type name, or the core
  Vue painter component will be mounted instead of ours.
- Useful `addDOMWidget` options (see frontend `src/scripts/domWidget.ts`):
  `getValue`, `setValue`, `getMinHeight`, `getMaxHeight`, `getHeight`,
  `hideOnZoom`, `selectOn`, `margin`, `beforeResize`, `afterResize`, `onDraw`.
- `setDirtyCanvas()` / `graph.change()` do nothing for the Vue renderer. Drive
  our own UI from our own state; never rely on a graph repaint to refresh it.
- Pointer events inside the DOM widget must not leak to the graph (stop
  propagation on the canvas during strokes, and don't let wheel-zoom on our
  canvas pan the graph). Verify in both renderers.
- Our widget is created via the extension's `getCustomWidgets()` for the
  `PAINTERSKETCH` `widgetType` (set in the Python `extra_dict`); the DOM widget
  type string is `paintersketch`.
- `node.hideOutputImages = true` is only honored by Nodes 2.0. In LiteGraph the
  output preview is drawn by an `onDrawBackground` the frontend installs on
  node classes; we override it on our prototype only, without calling the
  original (the one exception to "call original first").
- Nodes 2.0 forwards `wheel` and `pointerdown` (incl. middle-drag) to the graph in the capture phase,
  before our element sees them. We add a capture-phase `window` listener only
  while the pointer is over our canvas and stop the event there; also set
  `data-capture-wheel="true"`. Nodes 2.0 ignores `getMinHeight` for DOM widgets,
  so a CSS `min-height` backs it up.
- Upstream images reachable through `app`: `app.nodePreviewImages[locatorId]`,
  `app.nodeOutputs[locatorId].images`, `node.imgs`, and a `LoadImage` widget
  value converted to a `/view` URL.
- The in-node canvas is drawn at the graph's zoom level. Convert pointer
  coordinates through the element's `getBoundingClientRect()` every event;
  never cache a scale factor.

### Keyboard Shortcuts
ComfyUI binds many keys (Ctrl+Z/Y, Ctrl+C/V, Delete, letters) to graph actions.
- Editor shortcuts are active only while the editor owns keyboard focus (its
  hidden key-sink input or a text field inside the editor root). Rule
  (`ui/focusPolicy.ts`):
  - Hover focuses the editor only if no text field elsewhere has focus, and
    releases it on leave.
  - Any click inside the editor "engages" it: the sink takes focus (even from
    another node's text field) and keeps it after the pointer leaves, until the
    next click / focus move outside the editor. Text fields, `<select>` and range
    sliders inside the editor keep native focus/drag behaviour.
  - Fullscreen always owns the keyboard.
  - The rail's white left edge shows real focus state (focusin/focusout), never
    hover guesses.
  - Never `preventDefault()` `pointerdown` on `<input type=range>`: it kills
    native slider dragging.
- While active, handle the key, then `preventDefault()` + `stopPropagation()` so
  Ctrl+Z undoes a stroke, not a graph edit. Let keys through when an `<input>` /
  `<textarea>` (text tool, hex field) is the target.
- Register listeners in the capture phase on `window` while active and remove them
  when inactive / on node removal. No always-on global listeners.
- The frontend keybinding service listens on `window` (bubble) and LiteGraph on its
  canvas, so our capture listeners beat both. ComfyUI's graph-undo listener
  (ChangeTracker) is also window-capture but registers before extensions, so
  propagation can't stop it; it ignores keys when focus is in an `INPUT`. While
  hovered, the editor focuses a hidden read-only `<input>` (unless another text
  field has focus) and hands focus back on leave.

### Node Lifecycle
- `nodeCreated` fires inside the constructor, **before** `node.graph` is set.
  Don't compute execution IDs or touch `node.graph` there; defer to
  `afterConfigureGraph` / `onAdded` or a `requestAnimationFrame`.
- **Tab switching destroys and recreates every node instance**, and subgraph
  navigation unmounts/remounts Vue node components. Anything not in the widget
  value (or a module-level store keyed by a stable id) is lost. Unsaved in-memory
  edits must be flushed to the widget value before teardown, or kept in a
  module-level `Map` keyed by a stable document id, not on the node object.
- **Graph undo/redo** (ChangeTracker) calls `app.loadGraphData`, which in one
  synchronous task removes every node (`onRemoved`) and re-creates it with the
  **same id**. Nodes 2.0 reuses the Vue widget component (same key) and never
  re-inserts `widget.element`, so a disposed element leaves a blank node. We
  hand off the old wrapper element + session + cached background to the new
  node (`widget/handoff.ts`, offer expires after a microtask so tab switches /
  deletions never match). Attach/fork/restore rules are a pure function in
  `widget/attachDecision.ts`.
- ChangeTracker snapshots our `document` widget value as part of the graph, so a
  graph undo can restore an older manifest. A handed-off live session is always
  kept: **graph undo never rolls back paint**; paint undo is ours alone.
- **Drafts only persist on ChangeTracker captures.** ComfyUI writes workflow
  drafts (what a page reload restores) on `graphChanged`, which only fires when
  `captureCanvasState()` sees a change -- triggered by mouseup/keyup/keydown/
  queue, never by an async widget value change. After our value changes on its
  own (upload finished, debounced edits, re-attach) we call the active
  workflow's `changeTracker.captureCanvasState()` (`widget/graphSync.ts`), only
  when our node is in `app.graph`, and never during graph undo/redo.
- Keep widget values small. ComfyUI fails to save workflow drafts when a widget
  value is very large ("Failed to save workflow draft"). Our manifest holds only
  file references (~250 bytes per layer); never inline pixel data or history.
- `node.id` is a **string** (frontend >= 1.46). Always compare with `String(node.id)`.
- Store per-node document state in the widget value, not in custom `node.*`
  properties (the frontend's ECS direction discourages new instance properties).

### Getting the Input Image into the Editor
The frontend never receives the input tensor. Two sources, in order:
1. The upstream node's preview images: `node.getInputNode(0)` then that node's
   output image URLs (works immediately for `LoadImage` and anything that shows a
   preview). This is what core `Painter` does.
2. After our node executes, it returns `ui=UI.PreviewImage(input_image)` and the
   frontend receives it via the node's executed output (`onExecuted` /
   `api` `executed` event). Hide the default preview image rendering for our node
   (`node.hideOutputImages = true`) and draw it as our base layer instead.
Canvas size follows the input image. With no image connected, fall back to
width/height/background widgets.

### Nodes 2.0 Reactivity
- **Dual Vue runtime**: a bundled Vue has its own reactivity; the frontend's
  `computed`s never see our `ref`s.
- `node.pos = [x, y]` (full assignment) triggers the layout store; mutating
  `node.pos[0]` does not. Same caution for `node.size`: use `node.setSize([w, h])`.
- `node.badges` is not reactive; use DOM overlays if we ever need live badges.
- `node.outputs` / `node.inputs` are `shallowReactive`: changing a slot's `type`,
  `name` or `label` in place is not seen. After such edits, re-splice the array
  in place (`node.outputs.splice(0, node.outputs.length, ...node.outputs)`), as
  rgthree's Power Puter does (`src_web/comfyui/power_puter.ts`, `stabilize()`).

### Subgraphs
- `app.graph` is always the root graph; `app.canvas.graph` is what's being viewed.
- Node identifiers: `node.id` (local), execution ID (`"1:2:3"`, what the backend
  sees as `UNIQUE_ID`), locator ID (`"<uuid>:<localId>"`).

### Silent ExecutionBlocker in V3 Nodes
If we ever need to block downstream silently: `io.NodeOutput(ExecutionBlocker(None))`
as a positional result. `io.NodeOutput(block_execution=...)` treats `None` as
"no block".

### Image Loading
- `node_helpers.pillow()` retries PIL ops with `LOAD_TRUNCATED_IMAGES = True`.
- `folder_paths.get_annotated_filepath("sub/name.png [input]")` handles subfolders
  and the `[input]` annotation.
- IMAGE tensors are `[B, H, W, C]` float 0-1; MASK tensors are `[B, H, W]`.
  Batch in, batch out: the same paint/mask is applied to every image in the batch
  (broadcast, don't loop in Python). The editor previews the first image.

### Photoshop Conventions
The maintainer has used Photoshop since PS6. When a behavior or shortcut has a
well-known Photoshop equivalent, match it rather than inventing one. `SPEC.md`
lists the chosen shortcuts; keep that table the single source of truth.

## Testing

- Unit tests (Vitest) for pure logic: document migrations/validation, flood fill,
  geometry (lines/arrows/shapes), brush spacing/pressure math, history.
- Manual checklist before calling a milestone done:
  1. LiteGraph (Nodes 2.0 OFF): widget renders, paints, sizes correctly at
     several graph zoom levels, fullscreen works, shortcuts don't hit the graph
  2. Nodes 2.0 ON: same, no broken layout or lost data
  3. Save workflow, reload page, edits restore
  4. Switch workflow tabs and back; edits survive
  5. Put the node in a subgraph; enter/exit; edits survive
  6. Change the upstream image; canvas adapts per `SPEC.md` rules
  7. Queue: `IMAGE` and `MASK` outputs are correct; unchanged edits are cached
  8. Pen tablet: pressure affects size/opacity as configured
  9. Remove the node: listeners and DOM cleaned up

## Local References

Frontend source (authoritative for current behavior): `D:\AITools\ComfyUI_frontend\`
(1.55.x at time of writing)
- `src/scripts/domWidget.ts` -- `addDOMWidget` implementation and options
- `src/renderer/extensions/vueNodes/components/NodeWidgets.vue` -- widget routing
- `src/renderer/extensions/vueNodes/widgets/registry/widgetRegistry.ts` -- reserved widget type names
- `src/renderer/extensions/vueNodes/widgets/components/WidgetDOM.vue` -- how DOM widgets mount in Nodes 2.0
- `src/types/comfy.ts` -- `ComfyExtension` hooks
- `src/extensions/core/painter.ts`, `src/composables/painter/usePainter.ts` -- core Painter
- `src/extensions/core/maskeditor*`, `imageCrop.ts` -- other image-editing widgets
- `src/renderer/extensions/layerEditor/engine/` -- reference engine split (history, fill, compositor)
- `build/plugins/comfyAPIPlugin.ts` -- which `scripts/*` shims are deprecated
- `AGENTS.md`, `docs/adr/` -- frontend conventions and direction

Backend source: `D:\AITools\StabilityMatrixData\Packages\ComfyUI\`
- `comfy_api/latest/_io.py`, `_ui.py` -- V3 schema types, `UI.PreviewImage`
- `comfy_extras/nodes_painter.py` -- core Painter node (V3 reference)
- `folder_paths.py`, `node_helpers.py`

Docs:
- V3 migration: https://docs.comfy.org/custom-nodes/v3_migration
- JS extensions: https://docs.comfy.org/custom-nodes/js/javascript_overview
- Hooks: https://docs.comfy.org/custom-nodes/js/javascript_hooks
- Settings API: https://docs.comfy.org/custom-nodes/js/javascript_settings
- Toast API: https://docs.comfy.org/custom-nodes/js/javascript_toast
- Nodes 2.0: https://docs.comfy.org/interface/nodes-2
