"""
nodes/painter_sketch.py -- PainterSketch V3 ComfyUI node.

Accepts an optional base IMAGE plus the JSON layer-document widget; returns
IMAGE, MASK and `regions` (`PS_REGIONS`, split by PainterSketch Regions). All paint editing lives in the frontend;
Python resolves saved layer images (WebP/PNG), composites them, and handles fingerprinting.

Execution flow:
    1. Determine the image size: input image dims, else width/height (the
       document frame is mapped onto it, never used as the output size).
    2. Build a ``[B, H, W, 3]`` base-image tensor (input image or background fill).
    3. Parse the document manifest -> :class:`~document.Document`.
    4. Load each layer file -> RGBA tensor (masked by its layer mask,
       :mod:`layer_masks`), and a visible Image Mask
       matching the input image size -> coverage (via :mod:`layers`); a
       connected ``mask`` (:mod:`input_mask`) replaces that coverage.
    5. Composite paint/text layers over the base -> IMAGE (via :mod:`composite`);
       with the Background eye off over a transparent base, flattened onto
       the ``background`` colour.
    6. Combine cmasks -> MASK (via :mod:`composite`): normal rows unioned,
       ``invert_mask``, then subtract rows removed; with the Background eye
       off, plus the composite's transparency, after all of that.
    7. Apply Main's output options; build the region slots from the same
       composite (:mod:output_processing); preview the first input frame.

UI preview (SPEC "Node I/O" & AGENTS.md "Getting the Input Image"):
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

from comfy_api.latest import io
import folder_paths

from .composite import IMAGE_MASK_KEY, run_composite, run_transparent_composite
from .document import FRAME_MAX, parse_document
from .input_mask import mask_without_document, prepare_input_mask, row_settings
from .layer_masks import apply_layer_masks
from .layers import is_safe_file_value, load_image_mask, load_layer_mask, load_layer_rgba
from .output_processing import (
    EMPTY_REGIONS, apply_output_options, build_regions, viewport_renderer,
)
from .painter_sketch_regions import PSRegions
from .previews import LAYER_SOURCE_UI_KEY, ui_previews  # noqa: F401 (LAYER_SOURCE_UI_KEY re-exported)

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
                io.Mask.Input(
                    "mask",
                    optional=True,
                    tooltip="Optional mask; replaces the image's transparency as the Input Mask row (resized to the image; per image when the batch sizes match).",
                ),
                io.Image.Input(
                    "layer_source",
                    optional=True,
                    tooltip="Optional image offered in the editor's Images panel (insert as a new layer). Does not affect the outputs.",
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
                    max=FRAME_MAX,
                    step=8,
                    tooltip="Canvas width when no image is connected.",
                ),
                io.Int.Input(
                    "height",
                    default=1024,
                    min=64,
                    max=FRAME_MAX,
                    step=8,
                    tooltip="Canvas height when no image is connected.",
                ),
                io.Color.Input(
                    "background",
                    default="#ffffff",
                    tooltip="Background colour when no image is connected or the Background eye is off; also fills output regions outside the image.",
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
                PSRegions.Output(
                    "regions",
                    tooltip="Output regions; connect to PainterSketch Regions.",
                ),
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
        mask: torch.Tensor | None = None,
        layer_source: torch.Tensor | None = None,
    ) -> io.NodeOutput:
        """Composite once, then build Main and the region slots from that composite.

        Args:
            document:     JSON manifest string from the editor widget.
            width:        Fallback canvas width (no image connected).
            height:       Fallback canvas height (no image connected).
            background:   Hex colour for background tile when no image connected.
            invert_mask:  When True, invert the final MASK.
            image:        Optional ``[B, H, W, C]`` float32 input batch (a 4th
                          channel is dropped; an output's RGBA comes only from
                          its ``alpha`` option, via its final MASK).
            mask:         Optional MASK (``[H, W]`` / ``[B, H, W]``); the Input
                          Mask row's coverage (:mod:`input_mask`), previewed.
            layer_source: Optional image batch for the editor's Images panel;
                          only its first frame is previewed (outputs unaffected).

        Returns:
            `(IMAGE, MASK, regions)`; `regions` is a
            :class:~output_processing.PainterRegions. UI previews the first
            *input* frame, regardless of any output's fill/crop settings.
        """
        # ── 1. Base image ─────────────────────────────────────────────────────
        # No image: the width/height widgets ARE the current image; the
        # document's own frame maps onto it like onto any upstream image
        # (a frame mismatch is handled by run_composite).
        if image is not None:
            base_rgb = image[:, :, :, :3].contiguous()  # drop alpha if RGBA
        else:
            base_rgb = _make_background(width, height, background)

        B, H, W = base_rgb.shape[:3]
        # Keep the raw input for the UI preview (before compositing).
        preview_frame = base_rgb[:1]
        # A connected ``mask`` replaces the image alpha (only with an image, like
        # the Image Mask); ``None`` coverage = LoadImage's "no mask" placeholder.
        use_mask = image is not None and mask is not None
        coverage = prepare_input_mask(mask, (W, H), B) if use_mask else None

        # ── 2. Parse manifest ─────────────────────────────────────────────────
        doc = parse_document(document)
        if doc is None:
            # No valid document: pass image through, emit zero mask (or the Input Mask).
            fill = 1.0 if invert_mask else 0.0
            out_image = base_rgb
            out_mask = torch.full((B, H, W), fill, dtype=torch.float32, device=base_rgb.device)
            if coverage is not None:
                out_mask = mask_without_document(coverage, B, invert_mask)
            main_image, main_mask, regions = out_image, out_mask, EMPTY_REGIONS
        else:
            # ── 3. Load layer files and composite once ────────────────────────
            layer_tensors = {
                layer.id: load_layer_rgba(layer, doc.bounds) for layer in doc.layers
            }
            # Layer masks apply to their paint layer before any compositing
            # (Main, regions); they never touch the MASK outputs.
            layer_tensors = apply_layer_masks(doc.layers, layer_tensors, load_layer_mask)
            # The Image Mask is the input image's alpha; without an
            # image (widgets fill) there is nothing it belongs to. A connected
            # ``mask`` (the Input Mask) takes its place (the record's file is
            # ignored).
            if use_mask:
                doc = row_settings(doc, (W, H))
            record = doc.image_mask
            if use_mask and record.visible:
                layer_tensors[IMAGE_MASK_KEY] = coverage
            elif image is not None and record is not None and record.visible:
                layer_tensors[IMAGE_MASK_KEY] = load_image_mask(record, (W, H))
            # Background eye off: layers over a transparent base; IMAGE is
            # flattened onto the ``background`` colour, the transparency joins
            # every output's MASK (the preview is unchanged). Eye on: opaque.
            bg_rgb = _hex_to_rgb(background)
            transparent = not doc.background_visible
            if transparent:
                out_image, out_mask, straight = run_transparent_composite(
                    bg_rgb, B, W, H, doc, layer_tensors, invert_mask)
            else:
                out_image, out_mask = run_composite(base_rgb, doc, layer_tensors, invert_mask)
                straight = None
            main_image, main_mask = apply_output_options(out_image, out_mask, doc.main_output, straight)
            render = viewport_renderer(base_rgb, doc, layer_tensors, invert_mask, bg_rgb, transparent)
            regions = build_regions(out_image, out_mask, doc, render, straight)

        return io.NodeOutput(
            main_image, main_mask, regions,
            ui=ui_previews(preview_frame, layer_source, cls, use_mask, coverage),
        )

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
        - ``invert_mask``, ``background``
        - ``width``, ``height`` only while ``image`` is not linked (with an
          image they cannot affect the output; the editor keeps them at the
          image size). ComfyUI passes a linked input as ``None`` here (only
          constants are resolved), so "linked" means the key is present.
        - A marker while ``mask`` is linked.
        - For each layer file (and layer mask file, and the Image
          Mask file unless ``mask`` is linked) that resolves on disk:
          ``(size, mtime)`` pair.
          Size + mtime is cheap (single ``os.stat`` call) and catches any edit
          even when the frontend reuses a filename.  A missing file contributes
          a fixed marker so it still invalidates the cache relative to a present
          file; so does an unsafe name (no ``painter-sketch/`` prefix, ``..``),
          without any filesystem access.  SHA-256 of file contents would be more collision-resistant but
          unnecessary: layer files include a content hash in their name
          (SPEC "Document and saved files"), so a changed file always has a new name and
          thus a new document string; stat is sufficient for same-name files.

        The input IMAGE tensor is handled by ComfyUI's normal tensor-identity
        caching and must NOT be included here.

        Args:
            document:    JSON manifest string.
            invert_mask: invert_mask widget value.
            width:       width widget value.
            height:      height widget value.
            background:  background colour hex string.
            **kwargs:    ``image`` / ``mask`` when linked; others ignored.

        Returns:
            Hex-encoded SHA-256 digest string.
        """
        m = hashlib.sha256()
        m.update(document.encode("utf-8"))
        m.update(str(invert_mask).encode("utf-8"))
        if "image" in kwargs:
            m.update(b"\x00IMAGE\x00")
        else:
            m.update(str(width).encode("utf-8"))
            m.update(str(height).encode("utf-8"))
        m.update(background.encode("utf-8"))
        # A linked ``mask`` replaces the Image Mask file (its tensor is
        # cached like ``image``, through the upstream node).
        mask_linked = "mask" in kwargs
        if mask_linked:
            m.update(b"\x00MASK\x00")

        # Hash file metadata for each referenced layer file.
        doc = parse_document(document)
        if doc is not None:
            files = [layer.file for layer in doc.layers]
            # Layer mask files count like layer files.
            files += [layer.layer_mask.file for layer in doc.layers if layer.layer_mask is not None]
            if doc.image_mask is not None and not mask_linked:
                files.append(doc.image_mask.file)
            for file in files:
                if file is None:
                    continue
                # Same path check as execution; unsafe names never reach the filesystem.
                if not is_safe_file_value(file) or not folder_paths.exists_annotated_filepath(file):
                    m.update(b"\x00MISSING\x00")
                    m.update(file.encode("utf-8"))
                    continue
                path = folder_paths.get_annotated_filepath(file)
                try:
                    st = os.stat(path)
                    m.update(file.encode("utf-8"))
                    m.update(str(st.st_size).encode("utf-8"))
                    m.update(str(st.st_mtime).encode("utf-8"))
                except OSError:
                    m.update(b"\x00MISSING\x00")
                    m.update(file.encode("utf-8"))

        return m.hexdigest()
