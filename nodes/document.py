"""
nodes/document.py -- Parsing and validation of the PainterSketch v1 layer-document manifest.

The document widget stores a JSON string (or "" for an empty doc).  This module
turns that string into validated dataclass structures the compositor and
fingerprinting code can use safely, without ever crashing on bad data.

All functions are pure (no I/O, no side-effects) and therefore unit-testable
without ComfyUI.  Layer-file *resolution* (disk access) lives in layers.py.

Document model (v1, SPEC.md "Document Model" section):
    version: 1
    frame:  {width, height}               -- integer pixel dims of the image frame
    bounds: {x, y, width, height}         -- paint area in frame coords (may extend outside)
    regions: []                            -- reserved
    activeLayerId: str
    layers: Layer[]                        -- bottom -> top; background NOT included

Layer model:
    id, name       -- strings
    kind           -- "paint" | "text" | "mask"   ("text" treated as paint by Python)
    visible        -- bool
    locked         -- bool (read-only by Python; doesn't affect compositing)
    opacity        -- 0-1 float (clamped on parse)
    blendMode      -- "normal" only in v1
    file           -- "painter-sketch/<name>.png [input]" or null
    invert         -- bool, mask layers only (default False)
"""

import json
import logging
from dataclasses import dataclass, field

log = logging.getLogger("paintersketch.document")

# ── Size caps ─────────────────────────────────────────────────────────────────

_FRAME_MAX = 8192
"""Maximum frame dimension (matches node widget max)."""

# bounds may extend up to 3x the frame max in each direction so off-frame paint
# that was created at a larger document size is tolerated without crashing.
_BOUNDS_MAX = _FRAME_MAX * 3


# ── Dataclasses ───────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Frame:
    """Validated image-frame size."""
    width: int
    height: int


@dataclass(frozen=True)
class Bounds:
    """Validated paint-area bounds (frame coordinates; may be negative or wider than frame)."""
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class Layer:
    """One validated layer entry from the manifest."""
    id: str
    kind: str           # "paint" | "text" | "mask"
    visible: bool
    opacity: float      # clamped to [0, 1]
    file: str | None    # annotated path or None
    invert: bool        # mask layers: invert alpha before union


@dataclass
class Document:
    """Fully validated v1 PainterDocument."""
    frame: Frame
    bounds: Bounds
    layers: list[Layer] = field(default_factory=list)


# ── Internal helpers ──────────────────────────────────────────────────────────

def _int_field(d: dict, key: str, label: str) -> int | None:
    """Return d[key] as int, or None (with warning) if missing/wrong type."""
    v = d.get(key)
    if not isinstance(v, int):
        log.warning("document: %s.%s is not an int (%r)", label, key, v)
        return None
    return v


def _parse_frame(raw: dict) -> Frame | None:
    """Validate the 'frame' sub-object; return Frame or None."""
    if not isinstance(raw, dict):
        log.warning("document: 'frame' is not an object")
        return None
    w = _int_field(raw, "width", "frame")
    h = _int_field(raw, "height", "frame")
    if w is None or h is None:
        return None
    if w <= 0 or h <= 0:
        log.warning("document: frame dimensions must be positive (%d x %d)", w, h)
        return None
    if w > _FRAME_MAX or h > _FRAME_MAX:
        log.warning("document: frame %d x %d exceeds max %d", w, h, _FRAME_MAX)
        return None
    return Frame(width=w, height=h)


def _parse_bounds(raw: dict) -> Bounds | None:
    """Validate the 'bounds' sub-object; return Bounds or None."""
    if not isinstance(raw, dict):
        log.warning("document: 'bounds' is not an object")
        return None
    x = _int_field(raw, "x", "bounds")
    y = _int_field(raw, "y", "bounds")
    w = _int_field(raw, "width", "bounds")
    h = _int_field(raw, "height", "bounds")
    if any(v is None for v in (x, y, w, h)):
        return None
    if w <= 0 or h <= 0:
        log.warning("document: bounds dimensions must be positive (%d x %d)", w, h)
        return None
    if abs(x) > _BOUNDS_MAX or abs(y) > _BOUNDS_MAX or w > _BOUNDS_MAX or h > _BOUNDS_MAX:
        log.warning("document: bounds (%d,%d,%d,%d) exceed sane cap %d", x, y, w, h, _BOUNDS_MAX)
        return None
    return Bounds(x=x, y=y, width=w, height=h)


def _parse_layer(raw: dict, idx: int) -> Layer | None:
    """Validate one layer dict; return Layer or None (skipping unknown kinds)."""
    if not isinstance(raw, dict):
        log.warning("document: layer[%d] is not an object; skipping", idx)
        return None

    layer_id = raw.get("id")
    if not isinstance(layer_id, str) or not layer_id:
        log.warning("document: layer[%d] has no valid id; skipping", idx)
        return None

    kind = raw.get("kind")
    if kind not in ("paint", "text", "mask"):
        log.warning("document: layer %r has unknown kind %r; skipping", layer_id, kind)
        return None

    visible = raw.get("visible")
    if not isinstance(visible, bool):
        visible = True  # default visible

    opacity = raw.get("opacity", 1.0)
    if not isinstance(opacity, (int, float)):
        opacity = 1.0
    opacity = float(max(0.0, min(1.0, opacity)))

    file_val = raw.get("file")
    if file_val is not None and not isinstance(file_val, str):
        log.warning("document: layer %r 'file' is not a string; treating as null", layer_id)
        file_val = None
    if isinstance(file_val, str) and not file_val.strip():
        file_val = None

    invert = raw.get("invert", False)
    if not isinstance(invert, bool):
        invert = bool(invert)

    return Layer(
        id=layer_id,
        kind=kind,
        visible=visible,
        opacity=opacity,
        file=file_val,
        invert=invert,
    )


# ── Public API ────────────────────────────────────────────────────────────────

def parse_document(raw: str) -> Document | None:
    """Parse and validate a PainterDocument JSON string.

    Returns a :class:`Document` on success, ``None`` on empty/invalid input.
    Warnings are logged for every ignored field; the caller should treat
    ``None`` as "no document" and output the image unchanged with a zero mask.

    Validation rules:
    - Must be valid JSON, a top-level object, and ``version == 1``.
    - ``frame`` must have positive int dimensions <= 8192.
    - ``bounds`` must have positive int size; x/y/size must stay within ±24576.
    - Unknown layer kinds are skipped with a warning.  ``"text"`` is kept
      (rasterised by the frontend before saving, so Python sees it as paint).
    - Missing ``bounds``: fall back to frame-sized bounds at (0, 0).

    Args:
        raw: The ``document`` widget value.

    Returns:
        Validated :class:`Document`, or ``None``.
    """
    if not raw or not raw.strip():
        return None

    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as exc:
        log.warning("document: invalid JSON (%s); treating as empty", exc)
        return None

    if not isinstance(doc, dict):
        log.warning("document: manifest root is not an object; treating as empty")
        return None

    version = doc.get("version")
    if version != 1:
        log.warning("document: unsupported version %r; treating as empty", version)
        return None

    frame = _parse_frame(doc.get("frame", {}))
    if frame is None:
        log.warning("document: invalid frame; treating as empty")
        return None

    # bounds is optional: default to the full frame at origin.
    raw_bounds = doc.get("bounds")
    if raw_bounds is not None:
        bounds = _parse_bounds(raw_bounds)
        if bounds is None:
            log.warning("document: invalid bounds; falling back to frame bounds")
            bounds = Bounds(x=0, y=0, width=frame.width, height=frame.height)
    else:
        bounds = Bounds(x=0, y=0, width=frame.width, height=frame.height)

    raw_layers = doc.get("layers", [])
    if not isinstance(raw_layers, list):
        log.warning("document: 'layers' is not an array; treating as empty")
        raw_layers = []

    layers: list[Layer] = []
    for idx, raw_layer in enumerate(raw_layers):
        layer = _parse_layer(raw_layer, idx)
        if layer is not None:
            layers.append(layer)

    return Document(frame=frame, bounds=bounds, layers=layers)


def frame_size(doc: Document | None) -> tuple[int, int] | None:
    """Return ``(width, height)`` of the document frame, or ``None``.

    Convenience wrapper kept for compatibility with M0 callers.

    Args:
        doc: Parsed document, or ``None``.

    Returns:
        ``(width, height)`` or ``None``.
    """
    if doc is None:
        return None
    return (doc.frame.width, doc.frame.height)
