"""
nodes/composite.py -- Pure torch compositing functions for PainterSketch.

All functions take plain tensors and return plain tensors; no PIL, no file I/O,
no ComfyUI imports.  This keeps them unit-testable in isolation and lets the
compositor be called from tests without a ComfyUI environment.

Coordinate system (SPEC "Document and saved files"):
    - Frame: the final output rectangle, W x H pixels.
    - Bounds: the layer's paint area in frame coords; may extend outside the
      frame (negative x/y, or width/height exceeding the frame).
    - Layer PNG: exactly bounds.width x bounds.height pixels; pixel (px, py)
      sits at frame coordinate (bounds.x + px, bounds.y + py).

Frame-mismatch scaling (SPEC "Python execution"):
    When the run-time image is W x H but the document recorded fw x fh:
        s = min(W/fw, H/fh)
        offset_x = (W - fw*s) / 2
        offset_y = (H - fh*s) / 2
    The layer is scaled by s (bilinear) and placed at
        (offset_x + bounds.x * s, offset_y + bounds.y * s)
    then the whole result is cropped to W x H.

Placement (Move tool, SPEC "Python execution"):
    Document placement {x, y, scale} is composed into the map above, scaling
    about the frame centre c = (fw/2, fh/2):
        eff_s  = s * scale
        eff_ox = offset_x + s * (c.x * (1 - scale) + x)   (same for y)
    and the layer is placed with (eff_s, eff_ox, eff_oy) using the same
    rounding. Identity placement yields exactly (s, offset_x, offset_y).
    The frontend (`ui/src/engine/frameMap.ts`) evaluates the same expressions
    in the same order, so both round to the same integer rect.

Compositing (SPEC "Python execution"):
    Normal blend, straight-alpha "over":
        out_rgb = layer_rgb * (layer_alpha * opacity) + bg_rgb * (1 - layer_alpha * opacity)
    Applied bottom -> top; broadcast over the batch dimension.

Mask combination (SPEC "Python execution"):
    Each visible cmask is either normal or ``subtract``; its alpha channel is
    placed through the frame map (0.0 outside the placed rect).
        U = max over visible normal cmasks       (node ``invert_mask``: 1 - U;
                                                  all ones with no normal row)
        S = max over visible subtract cmasks
        MASK = U * (1 - S)                        (subtract wins over invert_mask)
    A subtract row is 0 outside its placed rect (the Image / Input Mask row:
    outside the image), so it only removes what it covers.

Image Mask:
    The loaded Image Mask coverage (``layer_tensors[IMAGE_MASK_KEY]``, image
    px, exactly the run-time image size) joins U or S (its row's ``subtract``)
    like a visible cmask, placed at the image origin (0 outside the image).
    Only when visible and not stale (the ``mask`` input's coverage, from
    ``input_mask.py``, takes its place).

Transparency in outputs (SPEC "Python execution"): with the Background eye
off the layers composite over a transparent base (:func:`run_transparent_composite`);
``T = 1 - alpha`` joins the MASK after subtraction (max, never inverted).
With the eye on the composite is opaque and none of this runs.
"""

import logging
from collections.abc import Iterator

import torch
import torch.nn.functional as F

from .document import IDENTITY_PLACEMENT, Bounds, Document, Frame, Layer, Placement

log = logging.getLogger("paintersketch.composite")

IMAGE_MASK_KEY = "\x00image-mask"
"""``layer_tensors`` key of the loaded Image Mask coverage ``[ih, iw]`` (never a layer id)."""


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


def _layout(W: int, H: int, frame: Frame, placement: Placement) -> tuple[float, float, float]:
    """Effective document -> image map: frame-mismatch fit composed with placement.

    Args:
        W, H:      run-time image dimensions.
        frame:     document frame.
        placement: Move-tool placement (identity = plain frame map).

    Returns:
        ``(eff_s, eff_ox, eff_oy)`` for :func:`_place_layer`.
    """
    s = _scale_factor(W, H, frame.width, frame.height)
    ox = (W - frame.width * s) / 2.0
    oy = (H - frame.height * s) / 2.0
    k = placement.scale
    eff_ox = ox + s * ((frame.width / 2) * (1 - k) + placement.x)
    eff_oy = oy + s * ((frame.height / 2) * (1 - k) + placement.y)
    return s * k, eff_ox, eff_oy


def _place_layer(
    rgba: torch.Tensor,
    bounds: Bounds,
    W: int,
    H: int,
    s: float,
    ox: float,
    oy: float,
    origin: tuple[int, int] = (0, 0),
) -> torch.Tensor:
    """Scale and place one RGBA layer tensor onto a W x H canvas.

    The canvas normally is the image itself; ``origin`` moves it to cover image
    px ``[origin, origin + (W, H))`` instead (output regions that extend past
    the image). The layer rect is rounded in image coordinates first, then
    shifted, so a viewport shows exactly the same pixels as the full image.

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
        origin: Image px of the canvas top-left (integer).

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
    x0 = round(dst_x) - origin[0]
    y0 = round(dst_y) - origin[1]
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
    placement: Placement = IDENTITY_PLACEMENT,
    image_size: tuple[int, int] | None = None,
    origin: tuple[int, int] = (0, 0),
) -> torch.Tensor:
    """Composite visible paint/text layers over a base image batch.

    Normal blend, straight-alpha "over", bottom -> top.  Each layer is
    broadcast over the full batch without a Python loop.

    Args:
        base_rgb:      ``[B, H, W, 3]`` float32 base canvas.
        layers:        All layers from the document (in bottom-to-top order).
        layer_tensors: Map from layer id to ``[lh, lw, 4]`` RGBA tensor or None.
        bounds:        Document bounds (used for placement calculation).
        frame:         Document frame size.
        placement:     Move-tool placement (default identity).
        image_size:    ``(W, H)`` of the run-time image the frame maps onto;
                       default = the canvas size (canvas is the image).
        origin:        Image px of the canvas top-left (viewport canvases).

    Returns:
        ``[B, H, W, 3]`` float32 composited canvas.
    """
    B, H, W = base_rgb.shape[:3]
    out = base_rgb.clone()
    for layer_rgb, eff_a in _placed_paint(layers, layer_tensors, bounds, frame, placement, W, H,
                                          image_size, origin):
        # Broadcast: [H, W, 3] -> [1, H, W, 3] over [B, H, W, 3]
        out = layer_rgb.unsqueeze(0) * eff_a.unsqueeze(0) + out * (1.0 - eff_a.unsqueeze(0))
    return out


def _placed_paint(
    layers: list[Layer],
    layer_tensors: dict[str, torch.Tensor | None],
    bounds: Bounds,
    frame: Frame,
    placement: Placement,
    W: int,
    H: int,
    image_size: tuple[int, int] | None,
    origin: tuple[int, int],
) -> Iterator[tuple[torch.Tensor, torch.Tensor]]:
    """Yield ``(rgb [H, W, 3], effective alpha [H, W, 1])`` of each visible paint/text layer, bottom -> top.

    Effective alpha = the placed straight alpha (already multiplied by any
    layer mask) times the layer opacity. Arguments as in :func:`composite_paint_layers`.
    """
    iw, ih = image_size or (W, H)
    s, ox, oy = _layout(iw, ih, frame, placement)
    for layer in layers:
        if layer.kind not in ("paint", "text") or not layer.visible:
            continue
        rgba = layer_tensors.get(layer.id)
        if rgba is None:
            continue
        placed = _place_layer(rgba, bounds, W, H, s, ox, oy, origin)  # [H, W, 4]
        yield placed[:, :, :3], placed[:, :, 3:4] * layer.opacity


def composite_premultiplied(
    doc: Document,
    layer_tensors: dict[str, torch.Tensor | None],
    W: int,
    H: int,
    image_size: tuple[int, int] | None = None,
    origin: tuple[int, int] = (0, 0),
) -> tuple[torch.Tensor, torch.Tensor]:
    """Composite the visible paint/text layers over a transparent base.

    Same "over" as :func:`composite_paint_layers`, on premultiplied colour:
    ``P = rgb * a + P * (1 - a)``, ``A = a + A * (1 - a)``. Over a solid colour
    ``bg`` this flattens to ``P + bg * (1 - A)``, identical to compositing over it.
    Computed once (layers are the same for every batch image).

    Args:
        doc:           Parsed document.
        layer_tensors: Loaded layer RGBA tensors by layer id.
        W, H:          Canvas size.
        image_size:    ``(W, H)`` of the run-time image; default = canvas size.
        origin:        Image px of the canvas top-left (viewport canvases).

    Returns:
        ``(premultiplied rgb [H, W, 3], alpha [H, W, 1])``.
    """
    premult = torch.zeros((H, W, 3), dtype=torch.float32)
    alpha = torch.zeros((H, W, 1), dtype=torch.float32)
    for layer_rgb, eff_a in _placed_paint(doc.layers, layer_tensors, doc.bounds, doc.frame,
                                          doc.placement, W, H, image_size, origin):
        premult = layer_rgb * eff_a + premult * (1.0 - eff_a)
        alpha = eff_a + alpha * (1.0 - eff_a)
    return premult, alpha


# ── Mask combine ──────────────────────────────────────────────────────────────

def combine_mask_layers(
    layers: list[Layer],
    layer_tensors: dict[str, torch.Tensor | None],
    bounds: Bounds,
    frame: Frame,
    W: int,
    H: int,
    invert_mask: bool,
    placement: Placement = IDENTITY_PLACEMENT,
    image_size: tuple[int, int] | None = None,
    origin: tuple[int, int] = (0, 0),
    image_mask: tuple[torch.Tensor, bool] | None = None,
) -> torch.Tensor:
    """Build the final MASK tensor from visible cmasks (mask layers + Image / Input Mask row).

    Per SPEC "Python execution":
      1. ``U`` = union (max) of the visible normal cmasks, each placed onto
         the W x H canvas (zeros outside the placed area).
      2. Node-level ``invert_mask``: ``U = 1 - U``; all ones when no normal
         cmask row is visible (visible subtract rows don't count).
      3. ``S`` = union (max) of the visible ``subtract`` cmasks (zeros outside
         the placed area: the Image / Input Mask row never subtracts outside
         the image; a mask layer only where its own placed pixels reach).
      4. ``MASK = U * (1 - S)``: subtract always wins over ``invert_mask``.
    The Image Mask (``image_mask``) counts as one more visible cmask, placed
    at the image origin instead of through the frame map. An empty normal
    cmask still counts as a mask row (zeros); an empty subtract one is a no-op.

    Opacity and display color are intentionally ignored for masks (SPEC "Python execution":
    cmask opacity/color are display only).

    Args:
        layers:        All document layers (bottom -> top).
        layer_tensors: Map from layer id to ``[lh, lw, 4]`` RGBA tensor or None.
        bounds:        Document bounds.
        frame:         Document frame.
        W, H:          Output canvas size.
        invert_mask:   Node-level invert flag.
        placement:     Move-tool placement (default identity).
        image_size:    ``(W, H)`` of the run-time image; default = canvas size.
        origin:        Image px of the canvas top-left (viewport canvases).
        image_mask:    ``(coverage [ih, iw] or [Bm, ih, iw] in image px, subtract)``
                       of a visible Image / Input Mask, or ``None``.

    Returns:
        ``[H, W]`` (``[Bm, H, W]`` with a batch coverage) float32 mask in [0, 1].
    """
    iw, ih = image_size or (W, H)
    s, ox, oy = _layout(iw, ih, frame, placement)

    union = torch.zeros((H, W), dtype=torch.float32)
    subtracted = torch.zeros((H, W), dtype=torch.float32)
    has_mask = False

    for layer in layers:
        if layer.kind != "mask" or not layer.visible:
            continue
        if not layer.subtract:
            has_mask = True
        rgba = layer_tensors.get(layer.id)
        if rgba is None:
            continue  # empty row: zeros in U (still a mask row), a no-op in S
        placed_a = _place_layer(rgba, bounds, W, H, s, ox, oy, origin)[:, :, 3]
        if layer.subtract:
            subtracted = torch.max(subtracted, placed_a)
        else:
            union = torch.max(union, placed_a)

    if image_mask is not None:
        coverage, subtract = image_mask
        placed_a = _place_image_px(coverage, W, H, origin)
        if subtract:
            subtracted = torch.max(subtracted, placed_a)
        else:
            has_mask = True
            union = torch.max(union, placed_a)

    if invert_mask:
        # No normal row + invert = full mask
        union = 1.0 - union if has_mask else torch.ones((H, W), dtype=torch.float32)

    return union * (1.0 - subtracted)


def _place_image_px(coverage: torch.Tensor, W: int, H: int, origin: tuple[int, int]) -> torch.Tensor:
    """Copy an image-px ``[..., ih, iw]`` plane (or a ``[Bm, ih, iw]`` batch) onto a W x H canvas at image px ``origin``.

    Args:
        coverage: ``[..., ih, iw]`` float32 plane(s) at image px ``(0, 0)``.
        W, H:     Canvas size.
        origin:   Image px of the canvas top-left.

    Returns:
        ``[..., H, W]`` plane(s), zeros where the canvas lies outside the image.
    """
    canvas = torch.zeros((*coverage.shape[:-2], H, W), dtype=torch.float32)
    ih, iw = coverage.shape[-2:]
    x0, y0 = -origin[0], -origin[1]
    cx0, cy0 = max(0, x0), max(0, y0)
    cx1, cy1 = min(W, x0 + iw), min(H, y0 + ih)
    if cx1 > cx0 and cy1 > cy0:
        canvas[..., cy0:cy1, cx0:cx1] = coverage[..., cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0]
    return canvas


def _image_mask_input(
    doc: Document, layer_tensors: dict[str, torch.Tensor | None],
) -> tuple[torch.Tensor, bool] | None:
    """The ``image_mask`` argument of :func:`combine_mask_layers` for a document, or ``None``."""
    coverage = layer_tensors.get(IMAGE_MASK_KEY)
    mask = doc.image_mask
    if coverage is None or mask is None or not mask.visible:
        return None
    return coverage, mask.subtract


# ── Top-level entry point ─────────────────────────────────────────────────────

def run_composite(
    base_rgb: torch.Tensor,
    doc: Document,
    layer_tensors: dict[str, torch.Tensor | None],
    invert_mask: bool,
    image_size: tuple[int, int] | None = None,
    origin: tuple[int, int] = (0, 0),
) -> tuple[torch.Tensor, torch.Tensor]:
    """Composite all layers and produce (IMAGE, MASK) for the given base canvas.

    With the defaults the canvas is the run-time image. Output regions that
    extend past the image pass a viewport instead: ``base_rgb`` covers image px
    ``[origin, origin + canvas size)`` and ``image_size`` is the real image size
    that the document frame maps onto.

    Args:
        base_rgb:      ``[B, H, W, 3]`` float32 base canvas (0-1).
        doc:           Validated :class:`~document.Document`.
        layer_tensors: Map from layer id to ``[lh, lw, 4]`` RGBA tensor or None,
                       as returned by :func:`~layers.load_layer_rgba`, plus the
                       Image Mask coverage under :data:`IMAGE_MASK_KEY`.
        invert_mask:   Node-level invert_mask widget value.
        image_size:    ``(W, H)`` of the run-time image; default = canvas size.
        origin:        Image px of the canvas top-left.

    Returns:
        ``(IMAGE [B,H,W,3], MASK [B,H,W])`` float32 tensors.
    """
    B, H, W = base_rgb.shape[:3]

    image = composite_paint_layers(
        base_rgb, doc.layers, layer_tensors, doc.bounds, doc.frame, doc.placement,
        image_size, origin,
    )

    mask_hw = combine_mask_layers(
        doc.layers, layer_tensors, doc.bounds, doc.frame, W, H, invert_mask, doc.placement,
        image_size, origin, _image_mask_input(doc, layer_tensors),
    )
    # Broadcast mask to batch ([H, W], or a per-image [B, H, W] with an Input Mask batch)
    mask = mask_hw.expand(B, -1, -1)

    return image, mask


def run_transparent_composite(
    background: tuple[float, float, float],
    batch: int,
    W: int,
    H: int,
    doc: Document,
    layer_tensors: dict[str, torch.Tensor | None],
    invert_mask: bool,
    image_size: tuple[int, int] | None = None,
    origin: tuple[int, int] = (0, 0),
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """:func:`run_composite` with the Background eye off: the composite's own transparency.

    The base is transparent instead of the input image. IMAGE = the layers
    flattened onto ``background``; MASK = ``max(cmasks incl. invert_mask and
    subtract, T)`` with ``T = 1 - A`` added after both (never inverted or subtracted), the
    same max union as the mask layers. ``straight`` is the un-premultiplied
    layer colour (``P / A``; ``background`` where ``A = 0``) for outputs that
    blend by their mask (Fill, Alpha), so soft edges carry no background fringe.

    Args:
        background:    ``background`` widget colour (RGB floats).
        batch:         Batch size ``B`` (the result is the same for every image).
        W, H:          Canvas size.
        doc, layer_tensors, invert_mask, image_size, origin: as :func:`run_composite`.

    Returns:
        ``(IMAGE [B, H, W, 3], MASK [B, H, W], straight [1, H, W, 3])``.
    """
    premult, alpha = composite_premultiplied(doc, layer_tensors, W, H, image_size, origin)
    bg = premult.new_tensor(background)
    image = (premult + bg * (1.0 - alpha)).unsqueeze(0).expand(batch, -1, -1, -1).contiguous()
    colour = premult / alpha.clamp_min(1e-12)
    straight = torch.where(alpha > 0, colour.clamp(0.0, 1.0), bg).unsqueeze(0)

    mask_hw = combine_mask_layers(
        doc.layers, layer_tensors, doc.bounds, doc.frame, W, H, invert_mask, doc.placement,
        image_size, origin, _image_mask_input(doc, layer_tensors),
    )
    mask = torch.max(mask_hw, 1.0 - alpha[:, :, 0]).expand(batch, -1, -1)
    return image, mask, straight
