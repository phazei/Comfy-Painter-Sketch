"""
nodes/output_processing.py -- Main/region output processing and the PS_REGIONS value.

Per SPEC "Python execution", the main node composites once,
then every output (Main and each of the six region slots) starts from that one
composite + final mask and applies its own output options (None / Fill / Crop / Border,
then the Alpha checkbox: RGBA IMAGE, alpha = 1 - that output's final MASK).
Main's options never affect regions. With the Background eye off the
composite's transparency is part of every output's mask (regions get their crop).

Region geometry:
    - Rects are image px from the top-left and are never rescaled (the input
      image size or width/height widgets may differ from the document frame).
    - Each edge is rounded with ``floor(v + 0.5)`` (the editor's rounding;
      not Python's ties-to-even ``round``), after clamping to the paint area:
      x in ``[-W, 2W]``, y in ``[-H, 2H]`` (one image size beyond each edge).
    - Minimum 1 x 1: ``left <= 2W - 1`` and ``right >= left + 1`` (same for y).
    - A region fully inside the image is a slice of the main composite. A
      region reaching outside is composited on its own canvas: ``background``
      colour, the input image where it overlaps, then paint and mask layers
      exactly as placed for the main output (layers may extend past the image
      via ``bounds``), so the overlapping pixels are identical.
"""

import math
from collections.abc import Callable
from dataclasses import dataclass

import torch

from .composite import run_composite, run_transparent_composite
from .document import Document
from .document_regions import REGION_SLOTS, OutputOptions, Region, RegionRect

Edges = tuple[int, int, int, int]
"""``(left, top, right, bottom)`` in image px; right/bottom exclusive."""


# ── PS_REGIONS value ──────────────────────────────────────────────────────────

@dataclass(frozen=True)
class RegionOutput:
    """Processed tensors of one filled region slot.

    Attributes:
        image: ``[B, h, w, 3]`` float32 IMAGE (after the region's options;
               ``[B, h, w, 4]`` with the region's ``alpha``).
        mask:  ``[B, h, w]`` float32 MASK (after the region's options).
    """
    image: torch.Tensor
    mask: torch.Tensor


@dataclass(frozen=True)
class PainterRegions:
    """Value of the ``PS_REGIONS`` socket (main node -> PainterSketch Regions).

    Attributes:
        slots: Exactly six entries; ``slots[n - 1]`` is slot ``n``, either a
               :class:`RegionOutput` or ``None`` (empty slot).
    """
    slots: tuple[RegionOutput | None, ...]

    def get(self, slot: int) -> RegionOutput | None:
        """Return slot ``1..6``'s output, or ``None`` if empty / out of range.

        Args:
            slot: 1-based slot number.

        Returns:
            The slot's :class:`RegionOutput` or ``None``.
        """
        if 1 <= slot <= len(self.slots):
            return self.slots[slot - 1]
        return None


EMPTY_REGIONS = PainterRegions(slots=(None,) * REGION_SLOTS)
"""All six slots empty (no document / no regions)."""


# ── Geometry ──────────────────────────────────────────────────────────────────

def region_edges(rect: RegionRect, width: int, height: int) -> Edges:
    """Round and clamp a region rect to integer image-px edges.

    Args:
        rect:   Region rect in image px (may be fractional / off-image).
        width:  Run-time image width ``W``.
        height: Run-time image height ``H``.

    Returns:
        ``(left, top, right, bottom)`` within ``[-W, 2W] x [-H, 2H]``, at least 1 x 1.
    """
    def edge(value: float, size: int) -> int:
        # Clamp first (also guards float overflow), then round half up.
        return math.floor(min(2 * size, max(-size, value)) + 0.5)

    left = min(2 * width - 1, edge(rect.x, width))
    top = min(2 * height - 1, edge(rect.y, height))
    right = max(left + 1, edge(rect.x + rect.width, width))
    bottom = max(top + 1, edge(rect.y + rect.height, height))
    return left, top, right, bottom


def inside_image(edges: Edges, width: int, height: int) -> bool:
    """Whether the edges lie entirely within a ``width x height`` image."""
    left, top, right, bottom = edges
    return left >= 0 and top >= 0 and right <= width and bottom <= height


# ── Output options ────────────────────────────────────────────────────────────

def apply_output_options(
    image: torch.Tensor, mask: torch.Tensor, options: OutputOptions,
    straight: torch.Tensor | None = None,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Apply None / Fill / Crop / Border, then the alpha, keeping the batch dimension.

    Fill blends ``image * (1 - mask) + color * mask`` (MASK unchanged). Crop
    keeps ``mask > 0`` (union over the batch) plus padding, clamped to this
    output; an empty mask leaves the output uncropped. Border pads every side
    by ``border_size``: IMAGE with ``border_color``, MASK with 1.0
    (``border_mask``) or 0.0. With ``alpha`` (ignored for Fill) the IMAGE
    gets a 4th channel ``1 - mask`` of the returned MASK, so a masked border
    is transparent and an unmasked one opaque.

    With the Background eye off, ``mask`` already holds the composite's
    transparency and ``straight`` is the un-premultiplied layer colour; outputs
    that blend by their mask (Fill, Alpha) start from ``straight`` so soft
    edges are not tinted by the background colour. Others keep ``image``
    (holes flattened onto the background colour).

    Args:
        image:    ``[B, H, W, 3]`` IMAGE.
        mask:     ``[B, H, W]`` final MASK (incl. ``invert_mask``, the
                  Image / Input Mask and the Background-off transparency).
        options:  This output's options.
        straight: ``[1 | B, H, W, 3]`` un-premultiplied colour, or ``None``
                  (Background visible: no transparency).

    Returns:
        ``(image [B, h, w, 3 | 4], mask [B, h, w])`` after the options.
    """
    if straight is not None and (options.alpha or options.apply_mask == "fill"):
        image = straight.expand(image.shape)
    image, mask = _modify(image, mask, options)
    if options.alpha and options.apply_mask != "fill":
        image = with_alpha(image, mask)
    return image, mask


def with_alpha(image: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """RGBA IMAGE with alpha = ``1 - mask`` (masked = transparent).

    Args:
        image: ``[B, h, w, 3]`` IMAGE.
        mask:  ``[B | 1, h, w]`` MASK of the same output (broadcast over the batch).

    Returns:
        ``[B, h, w, 4]`` IMAGE.
    """
    alpha = (1.0 - mask).to(image.dtype).unsqueeze(-1).expand(*image.shape[:3], 1)
    return torch.cat((image, alpha), dim=-1)


def _modify(
    image: torch.Tensor, mask: torch.Tensor, options: OutputOptions,
) -> tuple[torch.Tensor, torch.Tensor]:
    """The Modify step (None / Fill / Crop / Border) of :func:`apply_output_options`."""
    if options.apply_mask == "border":
        return _add_border(image, mask, options)
    if options.apply_mask == "fill":
        color = _rgb(image, options.fill_color)
        alpha = mask.unsqueeze(-1)
        return image * (1 - alpha) + color * alpha, mask
    if options.apply_mask == "crop":
        covered = (mask > 0).any(dim=0)
        rows = torch.where(covered.any(dim=1))[0]
        cols = torch.where(covered.any(dim=0))[0]
        if rows.numel() and cols.numel():
            height, width = mask.shape[1:]
            padding = options.crop_padding
            top = max(0, int(rows[0]) - padding)
            bottom = min(height, int(rows[-1]) + 1 + padding)
            left = max(0, int(cols[0]) - padding)
            right = min(width, int(cols[-1]) + 1 + padding)
            return image[:, top:bottom, left:right, :], mask[:, top:bottom, left:right]
    return image, mask


def _rgb(like: torch.Tensor, hex_color: str) -> torch.Tensor:
    """``#rrggbb`` -> ``[3]`` float tensor in 0..1 (dtype/device of ``like``)."""
    return like.new_tensor([int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)])


def _add_border(
    image: torch.Tensor, mask: torch.Tensor, options: OutputOptions,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Pad IMAGE with the border colour and MASK with 1.0/0.0 on all sides.

    Args:
        image:   ``[B, H, W, 3]`` IMAGE.
        mask:    ``[B, H, W]`` MASK.
        options: Options with ``border_size`` / ``border_color`` / ``border_mask``.

    Returns:
        ``(image [B, H+2s, W+2s, 3], mask [B, H+2s, W+2s])``.
    """
    size = options.border_size
    batch, height, width = image.shape[:3]
    padded = _rgb(image, options.border_color).expand(batch, height + 2 * size, width + 2 * size, 3).clone()
    padded[:, size:size + height, size:size + width] = image
    fill = 1.0 if options.border_mask else 0.0
    mask_batch = mask.shape[0]
    padded_mask = mask.new_full((mask_batch, height + 2 * size, width + 2 * size), fill)
    padded_mask[:, size:size + height, size:size + width] = mask
    return padded, padded_mask


# ── Region rendering ──────────────────────────────────────────────────────────

ViewportRenderer = Callable[[Edges], tuple[torch.Tensor, torch.Tensor, torch.Tensor | None]]
"""Renders ``(image, mask, straight | None)`` for image-px edges that reach outside the image."""


def viewport_renderer(
    base_rgb: torch.Tensor,
    doc: Document,
    layer_tensors: dict[str, torch.Tensor | None],
    invert_mask: bool,
    background: tuple[float, float, float],
    transparent: bool = False,
) -> ViewportRenderer:
    """Build a renderer that composites an arbitrary image-px area.

    Args:
        base_rgb:      ``[B, H, W, 3]`` input image (before paint).
        doc:           Parsed document.
        layer_tensors: Loaded layer RGBA tensors by layer id.
        invert_mask:   Node ``invert_mask``.
        background:    ``background`` widget colour as RGB floats.
        transparent:   Background eye off: composite over a transparent
                       base (``base_rgb`` only gives the batch size); the
                       transparency joins the mask and ``straight`` is returned.

    Returns:
        A function mapping edges to ``(image [B,h,w,3], mask [B,h,w],
        straight [1,h,w,3] | None)``.
    """
    batch, height, width = base_rgb.shape[:3]

    def render(edges: Edges) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor | None]:
        left, top, right, bottom = edges
        if transparent:
            return run_transparent_composite(
                background, batch, right - left, bottom - top, doc, layer_tensors, invert_mask,
                image_size=(width, height), origin=(left, top))
        canvas = base_rgb.new_tensor(background).expand(batch, bottom - top, right - left, 3).clone()
        x0, y0 = max(0, left), max(0, top)
        x1, y1 = min(width, right), min(height, bottom)
        if x1 > x0 and y1 > y0:
            canvas[:, y0 - top:y1 - top, x0 - left:x1 - left] = base_rgb[:, y0:y1, x0:x1]
        image, mask = run_composite(canvas, doc, layer_tensors, invert_mask,
                                    image_size=(width, height), origin=(left, top))
        return image, mask, None

    return render


def render_region(
    region: Region, image: torch.Tensor, mask: torch.Tensor, render: ViewportRenderer,
    straight: torch.Tensor | None = None,
) -> RegionOutput:
    """Produce one region's processed output from the one composite.

    Args:
        region:   Parsed region.
        image:    Main composite ``[B, H, W, 3]`` (before Main's options).
        mask:     Final mask ``[B, H, W]`` (incl. transparency).
        render:   Viewport renderer for regions reaching outside the image.
        straight: Un-premultiplied colour ``[1, H, W, 3]`` (Background eye off), or ``None``.

    Returns:
        The region's :class:`RegionOutput`.
    """
    height, width = image.shape[1:3]
    edges = region_edges(region.rect, width, height)
    left, top, right, bottom = edges
    if inside_image(edges, width, height):
        region_image, region_mask = image[:, top:bottom, left:right], mask[:, top:bottom, left:right]
        region_straight = None if straight is None else straight[:, top:bottom, left:right]
    else:
        region_image, region_mask, region_straight = render(edges)
    return RegionOutput(*apply_output_options(region_image, region_mask, region.output, region_straight))


def build_regions(
    image: torch.Tensor, mask: torch.Tensor, doc: Document | None, render: ViewportRenderer,
    straight: torch.Tensor | None = None,
) -> PainterRegions:
    """Build the ``PS_REGIONS`` value for all six slots.

    Args:
        image:    Main composite ``[B, H, W, 3]`` (before Main's options).
        mask:     Final mask ``[B, H, W]`` (incl. transparency).
        doc:      Parsed document, or ``None`` (all slots empty).
        render:   Viewport renderer for regions reaching outside the image.
        straight: Un-premultiplied colour ``[1, H, W, 3]`` (Background eye off), or ``None``.

    Returns:
        :class:`PainterRegions` with ``None`` for empty slots.
    """
    if doc is None or not doc.regions:
        return EMPTY_REGIONS
    by_slot = {region.slot: region for region in doc.regions}
    return PainterRegions(slots=tuple(
        render_region(by_slot[slot], image, mask, render, straight) if slot in by_slot else None
        for slot in range(1, REGION_SLOTS + 1)
    ))
