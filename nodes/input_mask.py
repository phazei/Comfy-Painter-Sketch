"""
nodes/input_mask.py -- The optional ``mask`` input (SPEC "Python execution").

While ``mask`` is connected it replaces the input image's alpha (the Image
Mask file) as the coverage of the fixed mask row; the row's settings
(eye, invert; colour / opacity are display-only) still come from the
manifest's ``imageMask`` record, whose ``file`` is then ignored. Without a
record the row has its defaults (visible, not inverted), like the editor.

Tensor rules (pure torch, no files):
    - ``[H, W]`` masks are one-frame batches.
    - LoadImage's placeholder for an image without alpha (all zeros, 64x64)
      means "no mask": :func:`prepare_input_mask` returns ``None``.
    - Batch: mask n for image n when the counts match, else the first mask
      for every image.
    - Size: resized to the image with ComfyUI's mask convention
      (``comfy_extras/nodes_compositing.py`` ``resize_mask``, used by
      JoinImageWithAlpha: bilinear ``interpolate`` over ``[-1, 1, H, W]``).

The prepared coverage is ``[1 | B, H, W]`` and joins the MASK union exactly
like the Image Mask coverage (``composite.py``, key ``IMAGE_MASK_KEY``).
"""

import dataclasses

import torch

from .document import Document, ImageMask

PLACEHOLDER_SIZE = (64, 64)
"""``(H, W)`` of LoadImage's all-zero MASK for images without alpha."""


def resize_mask(mask: torch.Tensor, shape: tuple[int, int]) -> torch.Tensor:
    """Resize a ``[B, h, w]`` mask to ``shape`` = ``(H, W)`` (ComfyUI's ``resize_mask``).

    Args:
        mask:  ``[B, h, w]`` float mask.
        shape: Target ``(H, W)``.

    Returns:
        ``[B, H, W]`` mask.
    """
    return torch.nn.functional.interpolate(
        mask.reshape((-1, 1, mask.shape[-2], mask.shape[-1])), size=(shape[0], shape[1]), mode="bilinear",
    ).squeeze(1)


def is_placeholder(mask: torch.Tensor) -> bool:
    """Whether ``mask`` is LoadImage's "no alpha" placeholder (64x64, all zero).

    Args:
        mask: ``[B, H, W]`` mask.

    Returns:
        ``True`` for the placeholder.
    """
    return tuple(mask.shape[-2:]) == PLACEHOLDER_SIZE and not bool(mask.any())


def as_batch(mask: torch.Tensor) -> torch.Tensor:
    """A MASK as ``[B, H, W]`` (a ``[H, W]`` mask becomes one frame).

    Args:
        mask: ``[H, W]`` or ``[B, H, W]`` mask.

    Returns:
        ``[B, H, W]`` view.
    """
    return mask.unsqueeze(0) if mask.dim() == 2 else mask


def prepare_input_mask(mask: torch.Tensor, size: tuple[int, int], batch: int) -> torch.Tensor | None:
    """The coverage the Input Mask row contributes, or ``None`` for no mask.

    Args:
        mask:  The ``mask`` input (``[H, W]`` or ``[B, H, W]``).
        size:  ``(W, H)`` of the input image.
        batch: Image batch size.

    Returns:
        ``[1, H, W]`` (first mask for all) or ``[batch, H, W]`` (per image)
        float32 CPU tensor in ``[0, 1]``; ``None`` for an empty batch or the
        placeholder.
    """
    mask = as_batch(mask)
    if mask.shape[0] == 0 or is_placeholder(mask):
        return None
    if mask.shape[0] != batch:
        mask = mask[:1]
    mask = mask.to(device="cpu", dtype=torch.float32)
    width, height = size
    if tuple(mask.shape[-2:]) != (height, width):
        mask = resize_mask(mask, (height, width))
    return mask.clamp(0.0, 1.0).contiguous()


def row_settings(doc: Document, size: tuple[int, int]) -> Document:
    """``doc`` with an ``image_mask`` record for the Input Mask row.

    The saved record's settings apply (its file is ignored while ``mask`` is
    connected); without one the defaults do (visible, not inverted).

    Args:
        doc:  Parsed document.
        size: ``(W, H)`` of the input image.

    Returns:
        ``doc`` itself when it has a record, else a copy with the default one.
    """
    if doc.image_mask is not None:
        return doc
    record = ImageMask(file=None, visible=True, invert=False, width=size[0], height=size[1])
    return dataclasses.replace(doc, image_mask=record)


def mask_without_document(coverage: torch.Tensor, batch: int, invert_mask: bool) -> torch.Tensor:
    """MASK output when the manifest is empty / unreadable: the Input Mask alone (default settings).

    Args:
        coverage:    Prepared coverage (:func:`prepare_input_mask`).
        batch:       Image batch size.
        invert_mask: Node-level invert.

    Returns:
        ``[batch, H, W]`` float32 mask.
    """
    out = coverage.expand(batch, -1, -1)
    return 1.0 - out if invert_mask else out
