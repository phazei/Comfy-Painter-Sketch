"""
nodes/layer_masks.py -- M14 layer masks: parse the per-layer ``layerMask`` record and
apply a mask to its paint layer before compositing, exactly like the editor
(``ui/src/document/layerMask.ts``, ``ui/src/engine/layerMask.ts``).

Manifest (additive, paint layers only; older documents have none, no version bump)::

    layerMask?: { file, enabled, invert, outside }

Pixels use the ComfyUI MASK convention, like our mask layers: **1 (white) =
hidden, 0 (black) = shown**.

- ``file``: PNG like mask layers (hidden amount in ALPHA), sized like the layer's
  own file (the document ``bounds``) and placed at its top-left; ``None`` =
  every stored pixel 0, i.e. the whole layer shown (the editor stores nothing
  for a fully transparent canvas).
- ``enabled``: ``False`` = ignored (the layer composites unmasked).
- ``invert``: the mask value is ``1 - m`` (outside included).
- ``outside``: value beyond the stored image (a smaller / stale file):
  ``"reveal"`` = 0 (shown), ``"hide"`` = 1 (hidden).

Applying multiplies the layer's straight alpha by ``1 - mask``, so the
masked layer then composites (visibility, opacity, Normal blend, placement)
like any other paint layer; masks never reach the MASK output (they only
change paint layers, and ``combine_mask_layers`` reads mask layers only).

Pure torch here; the safe file loading lives in ``layers.py``
(:func:`~layers.load_layer_mask`).
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass

import torch

log = logging.getLogger("paintersketch.layer_masks")


@dataclass(frozen=True)
class LayerMask:
    """A validated ``layerMask`` record."""
    file: str | None
    enabled: bool
    invert: bool
    outside: str        # "reveal" | "hide"


def parse_layer_mask(raw: object) -> LayerMask | None:
    """Leniently validate a layer's optional ``layerMask`` object (never fails).

    Missing / not an object -> ``None``. ``file`` non-string / blank -> ``None``;
    ``enabled`` non-boolean -> ``True``; ``invert`` non-boolean -> ``False``;
    ``outside`` other than ``"hide"`` -> ``"reveal"`` (same as the editor).

    Args:
        raw: The layer's ``layerMask`` value (any JSON value or None).

    Returns:
        Validated :class:`LayerMask`, or ``None``.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        log.warning("document: 'layerMask' is not an object; ignoring it")
        return None
    file_val = raw.get("file")
    if not isinstance(file_val, str) or not file_val.strip():
        file_val = None
    enabled = raw.get("enabled", True)
    invert = raw.get("invert", False)
    return LayerMask(
        file=file_val,
        enabled=enabled if isinstance(enabled, bool) else True,
        invert=invert if isinstance(invert, bool) else False,
        outside="hide" if raw.get("outside") == "hide" else "reveal",
    )


def mask_plane(stored: torch.Tensor | None, width: int, height: int, outside: str) -> torch.Tensor:
    """The mask value (1 = hidden) over a layer's ``[height, width]`` image.

    The stored alpha plane sits unscaled at the top-left (cropped when larger);
    the rest is the ``outside`` value. ``stored=None`` means the record has no
    file: every stored pixel is 0 (shown), which covers the whole layer image.

    Args:
        stored: ``[sh, sw]`` float32 alpha in [0, 1], or ``None`` (no file).
        width, height: Layer image size (the document bounds).
        outside: ``"reveal"`` (0) or ``"hide"`` (1).

    Returns:
        ``[height, width]`` float32 plane in [0, 1], 1 = hidden.
    """
    if stored is None:
        return torch.zeros((height, width), dtype=torch.float32)
    plane = torch.full((height, width), 1.0 if outside == "hide" else 0.0, dtype=torch.float32)
    sh, sw = stored.shape[:2]
    h, w = min(sh, height), min(sw, width)
    plane[:h, :w] = stored[:h, :w]
    return plane


def apply_layer_mask(rgba: torch.Tensor, plane: torch.Tensor, invert: bool) -> torch.Tensor:
    """Multiply a layer's straight alpha by how much its mask shows (``1 - mask``).

    Args:
        rgba: ``[H, W, 4]`` float32 layer tensor.
        plane: ``[H, W]`` mask value, 1 = hidden (:func:`mask_plane`).
        invert: Use ``1 - plane`` as the mask value.

    Returns:
        New ``[H, W, 4]`` tensor (RGB unchanged).
    """
    value = plane if invert else 1.0 - plane
    out = rgba.clone()
    out[:, :, 3] = rgba[:, :, 3] * value
    return out


def apply_layer_masks(
    layers: list,
    layer_tensors: dict[str, torch.Tensor | None],
    load: Callable[[str], torch.Tensor | None],
) -> dict[str, torch.Tensor | None]:
    """Mask every paint layer that has an enabled layer mask (before compositing).

    Args:
        layers: Document layers (``document.Layer``; ``layer_mask`` may be set).
        layer_tensors: Loaded ``[H, W, 4]`` layer tensors by id (``None`` = empty).
        load: Loads a mask file's alpha plane (``layers.load_layer_mask``);
            ``None`` = unreadable, the mask is then ignored (logged there).

    Returns:
        A new dict with masked tensors (other entries unchanged).
    """
    out = dict(layer_tensors)
    for layer in layers:
        mask = getattr(layer, "layer_mask", None)
        rgba = out.get(layer.id)
        if mask is None or not mask.enabled or rgba is None or layer.kind != "paint":
            continue
        stored = None
        if mask.file is not None:
            stored = load(mask.file)
            if stored is None:
                continue
        plane = mask_plane(stored, rgba.shape[1], rgba.shape[0], mask.outside)
        out[layer.id] = apply_layer_mask(rgba, plane, mask.invert)
    return out
