"""
nodes/previews.py -- The PainterSketch node's ``ui`` result.

- ``images``: the first input frame (the editor's background; SPEC "Node I/O").
- :data:`LAYER_SOURCE_UI_KEY`: the first ``layer_source`` frame, with a
  content id (``source_id``) the editor's source history dedupes by.
- :data:`INPUT_MASK_UI_KEY`: the first Input Mask coverage as used for
  the first image (resized to it), a grayscale PNG with a content id
  (``mask_id``). LoadImage's placeholder ("no mask") is one item
  ``{"mask_id": "none", "empty": True}`` without a file.

Preview files get random temp names on every run, so the editor identifies
them by the content ids (as for ``layer_source``).
"""

import hashlib

import torch

from comfy_api.latest import io, UI

LAYER_SOURCE_UI_KEY = "layer_source"
"""UI result key for the ``layer_source`` preview (the frontend reads it apart from ``images``)."""

INPUT_MASK_UI_KEY = "input_mask"
"""UI result key for the Input Mask preview (``ui/src/widget/inputMaskRule.ts``)."""

EMPTY_MASK_ITEM = {"mask_id": "none", "empty": True}
"""Input Mask preview item for "connected, but no mask" (LoadImage's placeholder)."""


def content_id(frame: torch.Tensor) -> str:
    """Short content id of a ``[H, W]`` / ``[H, W, C]`` frame (shape + a strided ~128x128 sample).

    Cheap even for large frames; equal content gives an equal id across runs.
    """
    h, w = frame.shape[:2]
    sample = frame[:: max(1, h // 128), :: max(1, w // 128)].float().cpu().contiguous()
    m = hashlib.sha256(str(tuple(frame.shape)).encode("utf-8"))
    m.update(sample.numpy().tobytes())
    return m.hexdigest()[:16]


def ui_previews(
    preview_frame: torch.Tensor,
    layer_source: torch.Tensor | None,
    cls: type[io.ComfyNode],
    mask_connected: bool = False,
    input_mask: torch.Tensor | None = None,
) -> UI.PreviewImage | dict:
    """UI result: the background preview plus the optional source / mask previews.

    Args:
        preview_frame:  ``[1, H, W, 3]`` background preview.
        layer_source:   Optional ``[B, H, W, C]`` source batch (RGBA kept).
        cls:            Node class (for the temp-file save helper).
        mask_connected: The ``mask`` input is used (an image is connected too).
        input_mask:     ``[Bm, H, W]`` prepared coverage; ``None`` = no mask
                        (placeholder) while connected.

    Returns:
        The ``ui`` value for :class:`io.NodeOutput` (a plain preview without extras).
    """
    preview = UI.PreviewImage(preview_frame, cls=cls)
    has_source = layer_source is not None and layer_source.shape[0] > 0
    if not has_source and not mask_connected:
        return preview
    ui = dict(preview.as_dict())
    if has_source:
        source_id = content_id(layer_source[0])
        items = UI.PreviewImage(layer_source[:1], cls=cls).as_dict()["images"]
        ui[LAYER_SOURCE_UI_KEY] = [{**item, "source_id": source_id} for item in items]
    if mask_connected and input_mask is None:
        ui[INPUT_MASK_UI_KEY] = [dict(EMPTY_MASK_ITEM)]
    elif mask_connected:
        mask_id = content_id(input_mask[0])
        items = UI.PreviewMask(input_mask[:1], cls=cls).as_dict()["images"]
        ui[INPUT_MASK_UI_KEY] = [{**item, "mask_id": mask_id} for item in items]
    return ui
