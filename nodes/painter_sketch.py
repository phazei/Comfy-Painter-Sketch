"""
nodes/painter_sketch.py -- PainterSketch V3 ComfyUI node.

Implements the ``PainterSketch`` node: accepts an optional input image plus a
JSON layer-document widget, and returns an ``IMAGE`` tensor and a ``MASK``
tensor.  All painting logic lives in the frontend (TypeScript); this file
handles only tensor construction, fingerprinting, and UI preview forwarding.

M0 behavior (compositing is M1):
- With ``image`` connected: pass the RGB portion of the batch through unchanged.
- Without ``image``: synthesize a 1×H×W×3 tensor filled with ``background``
  (hex colour, graceful fallback to white on bad input), using the frame size
  from the document manifest when available, otherwise ``width``/``height``.
- ``MASK``: zeros (or ones if ``invert_mask``) matching the image batch and size.
- Returns ``ui=UI.PreviewImage(image[:1], cls=cls)`` so the frontend can use the
  first frame as the editor's background after the node executes.

Reference: comfy_extras/nodes_painter.py (core Painter, same pattern).
"""

import hashlib
import json
import logging

import torch
from typing_extensions import override

from comfy_api.latest import ComfyExtension, io, UI

from .document import frame_size, parse_document

log = logging.getLogger("paintersketch.painter_sketch")


# ── Colour helpers ────────────────────────────────────────────────────────────

def _hex_to_rgb(hex_color: str) -> tuple[float, float, float]:
    """Convert a CSS hex colour string to a normalised (r, g, b) float triple.

    Accepts ``#RRGGBB``; silently falls back to white on any parse error.

    Args:
        hex_color: Hex colour string such as ``"#ffffff"``.

    Returns:
        ``(r, g, b)`` floats in [0, 1].
    """
    s = hex_color.lstrip("#")
    if len(s) != 6:
        log.warning("background: unrecognised hex colour %r; using white", hex_color)
        return (1.0, 1.0, 1.0)
    try:
        r = int(s[0:2], 16) / 255.0
        g = int(s[2:4], 16) / 255.0
        b = int(s[4:6], 16) / 255.0
    except ValueError:
        log.warning("background: could not parse hex colour %r; using white", hex_color)
        return (1.0, 1.0, 1.0)
    return (r, g, b)


# ── Node ─────────────────────────────────────────────────────────────────────

class PainterSketch(io.ComfyNode):
    """PainterSketch node: paint on an image inside the node and output IMAGE + MASK.

    The node is deliberately thin on the Python side.  M0 passes the input
    image through (or synthesises a background) and emits zero masks.  M1 will
    resolve the layer PNGs from the manifest and composite them over the batch.
    """

    @classmethod
    @override
    def define_schema(cls) -> io.Schema:
        """Return the V3 schema for PainterSketch.

        Input order is fixed; the frontend widget (PAINTERSKETCH type) depends
        on the exact field names ``document``, ``width``, ``height``,
        ``background``, and ``invert_mask``.
        """
        return io.Schema(
            node_id="PainterSketch",
            display_name="PainterSketch",
            category="image",
            has_intermediate_output=True,
            inputs=[
                io.Image.Input(
                    "image",
                    optional=True,
                    tooltip="Optional base image to paint over. Batch in, batch out.",
                ),
                io.String.Input(
                    "document",
                    default="",
                    socketless=True,
                    extra_dict={"widgetType": "PAINTERSKETCH"},
                    tooltip=(
                        "Versioned layer-document manifest (JSON). "
                        "Managed by the in-node editor; do not edit by hand."
                    ),
                ),
                io.Int.Input(
                    "width",
                    default=1024,
                    min=64,
                    max=8192,
                    step=8,
                    tooltip="Canvas width when no image is connected.",
                ),
                io.Int.Input(
                    "height",
                    default=1024,
                    min=64,
                    max=8192,
                    step=8,
                    tooltip="Canvas height when no image is connected.",
                ),
                io.Color.Input(
                    "background",
                    default="#ffffff",
                    tooltip="Background fill colour used when no image is connected.",
                ),
                io.Boolean.Input(
                    "invert_mask",
                    default=False,
                    tooltip="Invert the MASK output (white = unmasked instead of masked).",
                ),
            ],
            outputs=[
                io.Image.Output("IMAGE"),
                io.Mask.Output("MASK"),
            ],
        )

    @classmethod
    @override
    def execute(
        cls,
        document: str,
        width: int,
        height: int,
        background: str = "#ffffff",
        invert_mask: bool = False,
        image: torch.Tensor | None = None,
    ) -> io.NodeOutput:
        """Produce IMAGE and MASK tensors from the node inputs.

        M0: passes the image batch through (RGB only) or synthesises a
        background tile.  MASK is all-zeros (or all-ones if invert_mask).
        Returns a UI preview of the first frame so the frontend can use it
        as the editor's background.

        Args:
            document: JSON manifest string from the editor widget.
            width: Fallback canvas width (used when image is not connected).
            height: Fallback canvas height (used when image is not connected).
            background: Hex colour for the synthesised background tile.
            invert_mask: When True, MASK is 1.0 everywhere instead of 0.0.
            image: Optional input image batch ``[B, H, W, C]`` float32 0-1.

        Returns:
            NodeOutput with (IMAGE [B,H,W,3], MASK [B,H,W]) and a UI preview.
        """
        if image is not None:
            # Ensure RGB: drop alpha channel if present.
            out_image = image[:, :, :, :3].contiguous()
            batch, h, w = out_image.shape[:3]
        else:
            # Determine frame size: document manifest takes priority over widgets
            # when the document records a frame (SPEC.md Behaviour Notes).
            doc = parse_document(document)
            doc_frame = frame_size(doc)
            if doc_frame is not None:
                w, h = doc_frame
            else:
                w, h = width, height

            r, g, b = _hex_to_rgb(background)
            out_image = torch.zeros((1, h, w, 3), dtype=torch.float32)
            out_image[0, :, :, 0] = r
            out_image[0, :, :, 1] = g
            out_image[0, :, :, 2] = b
            batch = 1

        fill = 1.0 if invert_mask else 0.0
        mask = torch.full((batch, h, w), fill, dtype=torch.float32)

        # Preview the first frame; the frontend hides the default preview area
        # and draws it as the locked background layer in the editor.
        return io.NodeOutput(out_image, mask, ui=UI.PreviewImage(out_image[:1], cls=cls))

    @classmethod
    @override
    def fingerprint_inputs(
        cls,
        document: str,
        invert_mask: bool,
        width: int,
        height: int,
        background: str = "#ffffff",
        **kwargs,
    ) -> str:
        """Hash node inputs that affect the output independently of ComfyUI caching.

        Hashes ``document`` (the layer manifest), ``invert_mask``, ``width``,
        ``height``, and ``background``.  The input IMAGE tensor is handled by
        ComfyUI's normal tensor-identity caching, so it is excluded here.

        Note: Once M1 saves per-layer PNGs, this method should also hash each
        layer file referenced in the manifest via SHA-256, so that paint edits
        trigger re-execution even when the widget value string is unchanged
        (e.g. the user saves a new version of a file with the same name).

        Args:
            document: JSON manifest string from the editor widget.
            invert_mask: Current invert_mask widget value.
            width: Canvas width widget value.
            height: Canvas height widget value.
            background: Background colour hex string.
            **kwargs: Ignored; present because ComfyUI may pass unknown fields.

        Returns:
            Hex-encoded SHA-256 digest string.
        """
        m = hashlib.sha256()
        m.update(document.encode("utf-8"))
        m.update(str(invert_mask).encode("utf-8"))
        m.update(str(width).encode("utf-8"))
        m.update(str(height).encode("utf-8"))
        m.update(background.encode("utf-8"))
        return m.hexdigest()
