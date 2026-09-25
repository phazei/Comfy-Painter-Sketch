"""
nodes/layers.py -- Resolve and load per-layer PNG files for PainterSketch.

Each layer in the manifest carries a ``file`` field like
``"painter-sketch/<name>.png [input]"``.  This module:
  1. Validates that the annotated path stays inside the ``painter-sketch/``
     subfolder (path-traversal guard).
  2. Checks the file exists via ``folder_paths.exists_annotated_filepath``.
  3. Loads it with ``node_helpers.pillow(Image.open, ...)`` (retries truncated
     images) and converts to RGBA float32 [H, W, 4] torch tensor in [0, 1].

The returned tensor dimensions are exactly ``bounds.width x bounds.height`` as
recorded in the layer's document bounds.  If the loaded image differs in size
we warn and resize with PIL LANCZOS before returning (the frontend is supposed
to upload a correctly-sized PNG, so size mismatch means the document is stale).

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

from .document import Layer, Bounds

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
    """Load a layer's PNG file and return an RGBA float32 tensor.

    Returns ``None`` when the layer has no file (``file is None``), the file
    is unsafe, or the file is missing; logs a warning in each case.

    The returned tensor is ``[bounds.height, bounds.width, 4]`` float32 in
    ``[0, 1]`` (straight alpha, matching the frontend's saved PNGs).

    Args:
        layer: Validated :class:`~document.Layer` from the manifest.
        bounds: Document bounds used to verify / fix the loaded image size.

    Returns:
        ``[H, W, 4]`` float32 tensor, or ``None``.
    """
    if layer.file is None:
        return None

    bare = _strip_annotation(layer.file)
    if not _is_safe_name(bare):
        log.warning("layers: layer %r has unsafe file path %r; skipping", layer.id, layer.file)
        return None

    if not folder_paths.exists_annotated_filepath(layer.file):
        log.warning("layers: layer %r file %r not found; treating as empty", layer.id, layer.file)
        return None

    path = folder_paths.get_annotated_filepath(layer.file)

    pil_img = node_helpers.pillow(Image.open, path)
    pil_img = pil_img.convert("RGBA")

    expected_w, expected_h = bounds.width, bounds.height
    if pil_img.size != (expected_w, expected_h):
        log.warning(
            "layers: layer %r PNG size %s != bounds %dx%d; resizing",
            layer.id, pil_img.size, expected_w, expected_h,
        )
        pil_img = pil_img.resize((expected_w, expected_h), Image.LANCZOS)

    arr = np.array(pil_img, dtype=np.float32) / 255.0  # [H, W, 4]
    return torch.from_numpy(arr)
