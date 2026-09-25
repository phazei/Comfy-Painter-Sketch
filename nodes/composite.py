"""
nodes/composite.py -- Pure torch compositing functions for PainterSketch.

All functions take plain tensors and return plain tensors; no PIL, no file I/O,
no ComfyUI imports.  This keeps them unit-testable in isolation and lets the
compositor be called from tests without a ComfyUI environment.

Coordinate system (SPEC.md "Saved-file contract"):
    - Frame: the final output rectangle, W x H pixels.
    - Bounds: the layer's paint area in frame coords; may extend outside the
      frame (negative x/y, or width/height exceeding the frame).
    - Layer PNG: exactly bounds.width x bounds.height pixels; pixel (px, py)
      sits at frame coordinate (bounds.x + px, bounds.y + py).

Frame-mismatch scaling (decision 4, SPEC.md "Saved-file contract"):
    When the run-time image is W x H but the document recorded fw x fh:
        s = min(W/fw, H/fh)
        offset_x = (W - fw*s) / 2
        offset_y = (H - fh*s) / 2
    The layer is scaled by s (bilinear) and placed at
        (offset_x + bounds.x * s, offset_y + bounds.y * s)
    then the whole result is cropped to W x H.

Compositing (SPEC.md "Paint layers"):
    Normal blend, straight-alpha "over":
        out_rgb = layer_rgb * (layer_alpha * opacity) + bg_rgb * (1 - layer_alpha * opacity)
    Applied bottom -> top; broadcast over the batch dimension.

Mask combination (SPEC.md "Mask layers", decision 5):
    Each visible mask layer's alpha channel -> optional per-layer invert ->
    max union over all visible mask layers -> node-level invert_mask.
    Areas outside the placed layer (not covered by the PNG) count as 0.0
    *before* the per-layer invert, so a fully-inverted mask layer with no
    paint covers the whole frame.
"""

import logging

import torch
import torch.nn.functional as F

from .document import Bounds, Document, Frame, Layer

log = logging.getLogger("paintersketch.composite")


# ── Placement helpers ─────────────────────────────────────────────────────────

def _scale_factor(W: int, H: int, fw: int, fh: int) -> float:
    """Compute the uniform scale factor for frame-mismatch layout.

    Args:
        W, H:   run-time image dimensions.
        fw, fh: document frame dimensions.

    Returns:
        Scale factor ``s = min(W/fw, H/fh)``.
    """
    return min(W / fw, H / fh)


def _place_layer(
    rgba: torch.Tensor,
    bounds: Bounds,
    W: int,
    H: int,
    s: float,
    ox: float,
    oy: float,
) -> torch.Tensor:
    """Scale and place one RGBA layer tensor onto a W x H canvas.

    The layer is scaled by ``s`` (bilinear when s != 1, otherwise kept as-is
    when s is 1.0 *and* offsets are integer-aligned).  The result is a
    ``[H, W, 4]`` float32 tensor with the layer's pixels at the correct
    position and zeros everywhere else.

    Args:
        rgba:   Source ``[lh, lw, 4]`` float32 tensor (straight alpha).
        bounds: Layer bounds in frame coordinates.
        W, H:   Output canvas size in pixels.
        s:      Uniform scale factor.
        ox, oy: Fractional pixel offset from (origin to frame top-left).

    Returns:
        ``[H, W, 4]`` placed layer tensor.
    """
    lh, lw = rgba.shape[:2]

    # Destination rect in output pixels (float)
    dst_x = ox + bounds.x * s
    dst_y = oy + bounds.y * s
    dst_w = lw * s
    dst_h = lh * s

    # Scale the layer if needed
    if s != 1.0 or (dst_x != round(dst_x)) or (dst_y != round(dst_y)):
        new_w = max(1, round(dst_w))
        new_h = max(1, round(dst_h))
        # interpolate expects [N, C, H, W]
        t = rgba.permute(2, 0, 1).unsqueeze(0)  # [1, 4, lh, lw]
        t = F.interpolate(t, size=(new_h, new_w), mode="bilinear", align_corners=False)
        rgba = t.squeeze(0).permute(1, 2, 0)    # [new_h, new_w, 4]
        dst_w, dst_h = new_w, new_h
    else:
        dst_w, dst_h = lw, lh

    # Integer destination rect
    x0 = round(dst_x)
    y0 = round(dst_y)
    x1 = x0 + int(dst_w)
    y1 = y0 + int(dst_h)

    # Canvas
    canvas = torch.zeros((H, W, 4), dtype=torch.float32)

    # Clip to canvas bounds and compute source slice
    sx0 = max(0, -x0)
    sy0 = max(0, -y0)
    cx0 = max(0, x0)
    cy0 = max(0, y0)
    cx1 = min(W, x1)
    cy1 = min(H, y1)

    if cx1 > cx0 and cy1 > cy0:
        src_h = cy1 - cy0
        src_w = cx1 - cx0
        canvas[cy0:cy1, cx0:cx1, :] = rgba[sy0:sy0 + src_h, sx0:sx0 + src_w, :]

    return canvas


# ── Paint composite ───────────────────────────────────────────────────────────

def composite_paint_layers(
    base_rgb: torch.Tensor,
    layers: list[Layer],
    layer_tensors: dict[str, torch.Tensor | None],
    bounds: Bounds,
    frame: Frame,
) -> torch.Tensor:
    """Composite visible paint/text layers over a base image batch.

    Normal blend, straight-alpha "over", bottom -> top.  Each layer is
    broadcast over the full batch without a Python loop.

    Args:
        base_rgb:      ``[B, H, W, 3]`` float32 base image.
        layers:        All layers from the document (in bottom-to-top order).
        layer_tensors: Map from layer id to ``[lh, lw, 4]`` RGBA tensor or None.
        bounds:        Document bounds (used for placement calculation).
        frame:         Document frame size.

    Returns:
        ``[B, H, W, 3]`` float32 composited image.
    """
    B, H, W = base_rgb.shape[:3]
    s = _scale_factor(W, H, frame.width, frame.height)
    ox = (W - frame.width * s) / 2.0
    oy = (H - frame.height * s) / 2.0

    out = base_rgb.clone()

    for layer in layers:
        if layer.kind not in ("paint", "text"):
            continue
        if not layer.visible:
            continue
        rgba = layer_tensors.get(layer.id)
        if rgba is None:
            continue

        placed = _place_layer(rgba, bounds, W, H, s, ox, oy)  # [H, W, 4]

        layer_rgb = placed[:, :, :3]   # [H, W, 3]
        layer_a   = placed[:, :, 3:4]  # [H, W, 1]  -- straight alpha
        eff_a = layer_a * layer.opacity  # effective alpha

        # Broadcast: [H, W, 3] -> [1, H, W, 3] over [B, H, W, 3]
        out = layer_rgb.unsqueeze(0) * eff_a.unsqueeze(0) + out * (1.0 - eff_a.unsqueeze(0))

    return out


# ── Mask combine ──────────────────────────────────────────────────────────────

def combine_mask_layers(
    layers: list[Layer],
    layer_tensors: dict[str, torch.Tensor | None],
    bounds: Bounds,
    frame: Frame,
    W: int,
    H: int,
    invert_mask: bool,
) -> torch.Tensor:
    """Build the final MASK tensor from visible mask layers.

    Per SPEC decision 5:
      1. Place each visible mask layer's alpha channel onto the W x H canvas
         (zeros outside the placed area, *before* per-layer invert).
      2. Apply per-layer ``invert`` (``1 - alpha``).
      3. Union (max) across all mask layers.
      4. Apply node-level ``invert_mask``.

    Opacity and display color are intentionally ignored for masks (SPEC.md:
    "opacity and color are display-only and do NOT affect MASK").

    Args:
        layers:        All document layers (bottom -> top).
        layer_tensors: Map from layer id to ``[lh, lw, 4]`` RGBA tensor or None.
        bounds:        Document bounds.
        frame:         Document frame.
        W, H:          Output canvas size.
        invert_mask:   Node-level invert flag.

    Returns:
        ``[H, W]`` float32 mask in [0, 1].
    """
    s = _scale_factor(W, H, frame.width, frame.height)
    ox = (W - frame.width * s) / 2.0
    oy = (H - frame.height * s) / 2.0

    combined = torch.zeros((H, W), dtype=torch.float32)
    has_mask = False

    for layer in layers:
        if layer.kind != "mask":
            continue
        if not layer.visible:
            continue
        has_mask = True

        rgba = layer_tensors.get(layer.id)
        if rgba is None:
            # Empty mask layer; a per-layer invert of zeros = ones (full mask)
            placed_a = torch.zeros((H, W), dtype=torch.float32)
        else:
            placed = _place_layer(rgba, bounds, W, H, s, ox, oy)  # [H, W, 4]
            placed_a = placed[:, :, 3]  # alpha channel

        if layer.invert:
            placed_a = 1.0 - placed_a

        combined = torch.max(combined, placed_a)

    if invert_mask:
        if not has_mask:
            # No mask layers + invert = full mask
            combined = torch.ones((H, W), dtype=torch.float32)
        else:
            combined = 1.0 - combined

    return combined


# ── Top-level entry point ─────────────────────────────────────────────────────

def run_composite(
    base_rgb: torch.Tensor,
    doc: Document,
    layer_tensors: dict[str, torch.Tensor | None],
    invert_mask: bool,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Composite all layers and produce (IMAGE, MASK) for the given base image.

    Args:
        base_rgb:      ``[B, H, W, 3]`` float32 base image (0-1).
        doc:           Validated :class:`~document.Document`.
        layer_tensors: Map from layer id to ``[lh, lw, 4]`` RGBA tensor or None,
                       as returned by :func:`~layers.load_layer_rgba`.
        invert_mask:   Node-level invert_mask widget value.

    Returns:
        ``(IMAGE [B,H,W,3], MASK [B,H,W])`` float32 tensors.
    """
    B, H, W = base_rgb.shape[:3]

    image = composite_paint_layers(
        base_rgb, doc.layers, layer_tensors, doc.bounds, doc.frame
    )

    mask_hw = combine_mask_layers(
        doc.layers, layer_tensors, doc.bounds, doc.frame, W, H, invert_mask
    )
    # Broadcast mask to batch
    mask = mask_hw.unsqueeze(0).expand(B, -1, -1)

    return image, mask
