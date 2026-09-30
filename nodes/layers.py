"""
nodes/layers.py -- Resolve and load per-layer image files for PainterSketch.

Each layer in the manifest carries a ``file`` field like
``"painter-sketch/<name>.webp [input]"`` (older documents: ``.png``).  The
extension is not checked: PIL detects the format from the bytes, so any format
it reads (WebP with alpha, PNG) loads the same way.  This module:
  1. Validates that the annotated path stays inside the ``painter-sketch/``
     subfolder (path-traversal guard).
  2. Checks the file exists via ``folder_paths.exists_annotated_filepath``.
  3. Loads it with ``node_helpers.pillow(Image.open, ...)`` (retries truncated
     images) and converts to RGBA float32 [H, W, 4] torch tensor in [0, 1].

The returned tensor dimensions are exactly ``bounds.width x bounds.height`` as
recorded in the layer's document bounds.  If the loaded image differs in size
we warn and place it unscaled at the top-left, cropped or padded with
transparency -- exactly what the editor draws, so output matches the screen
(the frontend always uploads a correctly-sized image, so a mismatch means the
document is stale).

A missing or unreadable file is logged and treated as an empty layer (SPEC
"Saved-file contract"): the node still runs with the remaining layers.

The M13a Image Mask file (same folder and naming) is image-px sized instead
of bounds-sized: :func:`load_image_mask` returns its alpha only when it
matches the run-time image size.

M14 layer mask files (same folder and naming, bounds-sized like their layer)
load as their alpha plane with :func:`load_layer_mask`; ``layer_masks.py``
places and applies them.

Callers (composite.py) never see PIL objects; they only see torch tensors or
None for missing/skipped files.

Security note: ``folder_paths.get_annotated_filepath`` resolves the path safely
(it knows ComfyUI's input folder); we add an explicit subfolder prefix check on
top to guarantee layers can never reference arbitrary input files.
"""

import logging
import os

import torch
import numpy as np
from PIL import Image

import folder_paths
import node_helpers

from .document import Bounds, ImageMask, Layer

log = logging.getLogger("paintersketch.layers")

_ALLOWED_PREFIX = "painter-sketch/"
"""All layer file values must start with this prefix (after stripping the annotation)."""


def _strip_annotation(file_val: str) -> str:
    """Remove the trailing ``[input]`` / ``[output]`` / ``[temp]`` annotation.

    Args:
        file_val: Annotated path string such as ``"painter-sketch/abc.png [input]"``.

    Returns:
        Bare relative path, e.g. ``"painter-sketch/abc.png"``.
    """
    return file_val.rsplit(" [", 1)[0].strip()


def _is_safe_name(bare: str) -> bool:
    """Return True if ``bare`` is inside the painter-sketch subfolder and safe.

    Rejects empty strings, paths starting with ``/``, and any ``..`` component.

    Args:
        bare: Bare (unannotated) relative path.

    Returns:
        True when the path is allowed.
    """
    if not bare:
        return False
    if not bare.startswith(_ALLOWED_PREFIX):
        return False
    # Reject path traversal components
    parts = bare.replace("\\", "/").split("/")
    return ".." not in parts


def load_layer_rgba(
    layer: Layer,
    bounds: Bounds,
) -> torch.Tensor | None:
    """Load a layer's image file (WebP or PNG) and return an RGBA float32 tensor.

    Returns ``None`` when the layer has no file (``file is None``), the file
    is unsafe, missing or unreadable (corrupt, not an image); logs one
    warning in each case (called once per layer per execution). Never raises
    for these recoverable cases.

    The returned tensor is ``[bounds.height, bounds.width, 4]`` float32 in
    ``[0, 1]`` (straight alpha, matching the frontend's saved images).

    Args:
        layer: Validated :class:`~document.Layer` from the manifest.
        bounds: Document bounds used to verify / fix the loaded image size.

    Returns:
        ``[H, W, 4]`` float32 tensor, or ``None``.
    """
    if layer.file is None:
        return None
    pil_img = _open_rgba(layer.file, f"layer {layer.id!r}")
    if pil_img is None:
        return None

    expected_w, expected_h = bounds.width, bounds.height
    if pil_img.size != (expected_w, expected_h):
        log.warning(
            "layers: layer %r file %r is %dx%d, document bounds are %dx%d; placing it "
            "unscaled at the top-left like the editor does (the file predates a canvas "
            "growth, its latest edits were probably never uploaded)",
            layer.id, layer.file, pil_img.size[0], pil_img.size[1], expected_w, expected_h,
        )
        canvas = Image.new("RGBA", (expected_w, expected_h), (0, 0, 0, 0))
        canvas.paste(pil_img, (0, 0))
        pil_img = canvas

    arr = np.array(pil_img, dtype=np.float32) / 255.0  # [H, W, 4]
    return torch.from_numpy(arr)


def load_image_mask(mask: ImageMask, image_size: tuple[int, int]) -> torch.Tensor | None:
    """Load the Image Mask file (M13a) as a ``[H, W]`` float32 coverage tensor (its alpha).

    The file is in image px, so it is only used when it is exactly the
    run-time image size; otherwise it belongs to another image (the editor
    uploads a new one when the source changes) and is skipped with one log
    line. A missing / unsafe / unreadable file is skipped like a layer file.

    Args:
        mask:       Validated :class:`~document.ImageMask`.
        image_size: ``(W, H)`` of the run-time image.

    Returns:
        ``[H, W]`` tensor in ``[0, 1]``, or ``None``.
    """
    if mask.file is None:
        return None
    pil_img = _open_rgba(mask.file, "Image Mask")
    if pil_img is None:
        return None
    if pil_img.size != image_size:
        log.info(
            "layers: Image Mask %r is %dx%d but the image is %dx%d; skipping it (stale)",
            mask.file, pil_img.size[0], pil_img.size[1], image_size[0], image_size[1],
        )
        return None
    alpha = np.array(pil_img.getchannel("A"), dtype=np.float32) / 255.0  # [H, W]
    return torch.from_numpy(alpha)


def load_layer_mask(file_val: str) -> torch.Tensor | None:
    """Load an M14 layer mask file as its ``[h, w]`` float32 alpha plane (unscaled).

    Same safety checks as layer files (``painter-sketch/`` only, exists,
    readable). Placement and the ``outside`` value are applied by
    :func:`~layer_masks.mask_plane`.

    Args:
        file_val: The record's annotated ``file``.

    Returns:
        ``[h, w]`` tensor in ``[0, 1]``, or ``None`` when unsafe / missing /
        unreadable (the mask is then ignored, logged once).
    """
    pil_img = _open_rgba(file_val, "layer mask")
    if pil_img is None:
        return None
    alpha = np.array(pil_img.getchannel("A"), dtype=np.float32) / 255.0
    return torch.from_numpy(alpha)


def _open_rgba(file_val: str, label: str) -> Image.Image | None:
    """Resolve an annotated ``painter-sketch/`` file safely and open it as RGBA.

    Logs one warning and returns ``None`` when the path is unsafe, the file is
    missing, or it can't be read (corrupt, truncated beyond repair, not an
    image, permissions, removed between the exists check and the read): a
    recoverable per-file problem, never a node failure.

    Args:
        file_val: Annotated path, e.g. ``"painter-sketch/ps-x.png [input]"``.
        label:    What the file belongs to, for log messages.

    Returns:
        RGBA PIL image, or ``None``.
    """
    bare = _strip_annotation(file_val)
    if not _is_safe_name(bare):
        log.warning("layers: %s has unsafe file path %r; skipping", label, file_val)
        return None

    if not folder_paths.exists_annotated_filepath(file_val):
        log.warning("layers: %s file %r not found; treating as empty", label, file_val)
        return None

    path = folder_paths.get_annotated_filepath(file_val)
    try:
        return node_helpers.pillow(Image.open, path).convert("RGBA")
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        log.warning("layers: %s file %r is unreadable (%s); treating as empty", label, file_val, exc)
        return None
