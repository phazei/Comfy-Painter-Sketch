"""
nodes/painter_sketch.py -- PainterSketch V3 ComfyUI node.

Accepts an optional base IMAGE plus the JSON layer-document widget; returns
IMAGE (composited) and MASK tensors.  All paint editing lives in the frontend;
Python resolves saved layer images (WebP/PNG), composites them, and handles fingerprinting.

Execution flow:
    1. Determine frame size: input image dims, or document frame, or width/height.
    2. Build a ``[B, H, W, 3]`` base-image tensor (input image or background fill).
    3. Parse the document manifest -> :class:`~document.Document`.
    4. Load each layer file -> RGBA tensor (via :mod:`layers`).
    5. Composite paint/text layers over the base -> IMAGE (via :mod:`composite`).
    6. Combine mask layers -> MASK (via :mod:`composite`).
    7. Return NodeOutput with UI preview of the first input frame.

UI preview (SPEC.md Node Contract & AGENTS.md "Getting the Input Image"):
    We preview the *first input frame* (or plain background when no image is
    connected), not the composited result.  The editor draws the paint layers
    itself using the frontend compositor; showing the composited server-side
    result as the preview would lag one queue run behind.

Reference: comfy_extras/nodes_painter.py (core Painter V3 pattern).
"""

import hashlib
import logging
import os

import torch
from typing_extensions import override

from comfy_api.latest import io, UI
import folder_paths

from .composite import run_composite
from .document import frame_size, parse_document
from .layers import load_layer_rgba

log = logging.getLogger("paintersketch.painter_sketch")


# ── Colour helpers ────────────────────────────────────────────────────────────

def _hex_to_rgb(hex_color: str) -> tuple[float, float, float]:
    """Convert a CSS hex colour to normalised (r, g, b) floats; falls back to white.

    Accepts ``#rgb``, ``#rgba``, ``#rrggbb`` and ``#rrggbbaa`` (the Nodes 2.0
    colour picker can produce alpha). Alpha is ignored: ``IMAGE`` has no alpha
    channel, and the editor also draws the background opaque, so preview and
    output agree.

    Args:
        hex_color: CSS hex colour string.

    Returns:
        ``(r, g, b)`` floats in [0, 1].
    """
    s = hex_color.strip().lstrip("#")
    if len(s) in (3, 4):
        s = "".join(c + c for c in s[:3])
    elif len(s) == 8:
        s = s[:6]
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


def _make_background(w: int, h: int, hex_color: str) -> torch.Tensor:
    """Return a ``[1, h, w, 3]`` float32 tensor filled with the given colour.

    Args:
        w, h:      Canvas dimensions.
        hex_color: CSS hex colour string.

    Returns:
        ``[1, H, W, 3]`` float32 tensor.
    """
    r, g, b = _hex_to_rgb(hex_color)
    t = torch.zeros((1, h, w, 3), dtype=torch.float32)
    t[0, :, :, 0] = r
    t[0, :, :, 1] = g
    t[0, :, :, 2] = b
    return t


# ── Node ─────────────────────────────────────────────────────────────────────

class PainterSketch(io.ComfyNode):
    """PainterSketch: in-node paint editor that outputs IMAGE + MASK.

    Paint and mask layers are stored in the frontend and uploaded as WebP (or PNG) to
    ``input/painter-sketch/``.  The manifest JSON in the ``document`` widget
    references those files; Python resolves and composites them at queue time.
    """

    @classmethod
    @override
    def define_schema(cls) -> io.Schema:
        """Return the V3 schema for PainterSketch.

        Input order is contract-stable; the frontend widget type ``PAINTERSKETCH``
        depends on the exact field names.
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
        """Composite layers and return IMAGE + MASK.

        Args:
            document:     JSON manifest string from the editor widget.
            width:        Fallback canvas width (no image connected).
            height:       Fallback canvas height (no image connected).
            background:   Hex colour for background tile when no image connected.
            invert_mask:  When True, invert the final MASK.
            image:        Optional ``[B, H, W, C]`` float32 input batch.

        Returns:
            NodeOutput with ``(IMAGE [B,H,W,3], MASK [B,H,W])`` and a UI preview
            of the first *input* frame (pre-composite), so the editor can use it
            as its locked background layer.
        """
        # ── 1. Base image ─────────────────────────────────────────────────────
        if image is not None:
            base_rgb = image[:, :, :, :3].contiguous()  # drop alpha if RGBA
        else:
            doc = parse_document(document)
            sz = frame_size(doc)
            w, h = sz if sz is not None else (width, height)
            base_rgb = _make_background(w, h, background)

        B, H, W = base_rgb.shape[:3]
        # Keep the raw input for the UI preview (before compositing).
        preview_frame = base_rgb[:1]

        # ── 2. Parse manifest ─────────────────────────────────────────────────
        doc = parse_document(document)
        if doc is None:
            # No valid document: pass image through, emit zero mask.
            fill = 1.0 if invert_mask else 0.0
            mask = torch.full((B, H, W), fill, dtype=torch.float32)
            return io.NodeOutput(base_rgb, mask, ui=UI.PreviewImage(preview_frame, cls=cls))

        # ── 3. Load layer files ───────────────────────────────────────────────
        layer_tensors: dict = {}
        for layer in doc.layers:
            layer_tensors[layer.id] = load_layer_rgba(layer, doc.bounds)

        # ── 4. Composite ──────────────────────────────────────────────────────
        out_image, out_mask = run_composite(base_rgb, doc, layer_tensors, invert_mask)

        return io.NodeOutput(out_image, out_mask, ui=UI.PreviewImage(preview_frame, cls=cls))

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
        """Hash all inputs that affect the output beyond the input image tensor.

        Hashes:
        - ``document`` manifest string (captures structural changes)
        - ``invert_mask``, ``width``, ``height``, ``background``
        - For each layer file that resolves on disk: ``(size, mtime)`` pair.
          Size + mtime is cheap (single ``os.stat`` call) and catches any edit
          even when the frontend reuses a filename.  A missing file contributes
          a fixed marker so it still invalidates the cache relative to a present
          file.  SHA-256 of file contents would be more collision-resistant but
          unnecessary: layer files include a content hash in their name
          (SPEC.md "File names"), so a changed file always has a new name and
          thus a new document string; stat is sufficient for same-name files.

        The input IMAGE tensor is handled by ComfyUI's normal tensor-identity
        caching and must NOT be included here.

        Args:
            document:    JSON manifest string.
            invert_mask: invert_mask widget value.
            width:       width widget value.
            height:      height widget value.
            background:  background colour hex string.
            **kwargs:    Ignored (ComfyUI may pass unknown fields).

        Returns:
            Hex-encoded SHA-256 digest string.
        """
        m = hashlib.sha256()
        m.update(document.encode("utf-8"))
        m.update(str(invert_mask).encode("utf-8"))
        m.update(str(width).encode("utf-8"))
        m.update(str(height).encode("utf-8"))
        m.update(background.encode("utf-8"))

        # Hash file metadata for each referenced layer file.
        doc = parse_document(document)
        if doc is not None:
            for layer in doc.layers:
                if layer.file is None:
                    continue
                if not folder_paths.exists_annotated_filepath(layer.file):
                    m.update(b"\x00MISSING\x00")
                    m.update(layer.file.encode("utf-8"))
                    continue
                path = folder_paths.get_annotated_filepath(layer.file)
                try:
                    st = os.stat(path)
                    m.update(layer.file.encode("utf-8"))
                    m.update(str(st.st_size).encode("utf-8"))
                    m.update(str(st.st_mtime).encode("utf-8"))
                except OSError:
                    m.update(b"\x00MISSING\x00")
                    m.update(layer.file.encode("utf-8"))

        return m.hexdigest()
