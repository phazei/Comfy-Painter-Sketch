# PainterSketch

A paint node for ComfyUI. Connect an image, paint on it and draw masks right
inside the node, and get `IMAGE` + `MASK` out. A fullscreen button opens the
same editor bigger when you need room.

> **Status: pre-release.** All v1 features are implemented; final polish is in
> progress. See [SPEC.md](SPEC.md) for details and progress.

## Features

- Paint directly in the node; fullscreen when you want it
- Input image is a live background: re-roll upstream and your paint stays
- Brush and eraser with size, hardness, opacity, flow, spacing and pen pressure
- Paint bucket, eyedropper, line / arrow, rectangle, ellipse, text
- Selections: marquee, lasso, magic wand; painting is clipped to the selection
- Layers: add, reorder, hide, lock, opacity; Move layer tool (Ctrl = pick layer under cursor)
- Move drawing: realign all paint to a similar but offset image, non-destructively
- Mask layer with Quick Mask-style editing (`Q`), red overlay, invert option
- Batch in, batch out: the same paint and mask apply to every image
- Undo / redo (buttons and shortcuts)
- Photoshop-style shortcuts
- Works in the classic LiteGraph UI and in Nodes 2.0

## Node

**PainterSketch** (category `image`)

| Inputs | |
|---|---|
| `image` (optional) | Image(s) to paint on |
| `width`, `height`, `background` | Canvas size and color when no image is connected |
| `invert_mask` | Invert the mask output |

| Outputs | |
|---|---|
| `IMAGE` | Input image(s) with your paint on top |
| `MASK` | Your mask (white = masked) |

## Installation

Clone into your ComfyUI `custom_nodes` folder and restart ComfyUI:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/phazei/Comfy-Painter-Sketch.git
```

No build step or extra Python packages are needed; the built frontend is
committed to the repo.

## Development

The frontend is TypeScript, built with Vite into `js/`:

```bash
cd ui
npm install
npm run build
```

Commit the built output in `js/` along with the source. See
[AGENTS.md](AGENTS.md) for architecture and conventions.

## Credits

Built from scratch, drawing on ideas from:

- [ComfySketch](https://github.com/Mexes1978/comfyui-comfysketch) by Vitor Silva (MIT)
- [Comfy Canvas](https://github.com/Zlata-Salyukova/Comfy-Canvas) by Zlata Salyukova (MIT)

## License

[MIT](LICENSE)
