"""
nodes/document.py -- Pure-function helpers for the PainterSketch versioned layer document.

The document manifest is a JSON string stored in the ``document`` widget.  This
module provides lenient parsing and field extraction so the node can read the
canvas frame size even when the manifest is incomplete or malformed.

All functions here are stateless and side-effect-free; M1 will extend them with
layer-file resolution once per-layer PNGs are saved.

Document Model (v1, from SPEC.md):
    {
        "version": 1,
        "frame": {"width": <int>, "height": <int>},
        "bounds": {"x": <int>, "y": <int>, "width": <int>, "height": <int>},
        "regions": [],
        "activeLayerId": "<str>",
        "layers": [...]
    }
"""

import json
import logging

log = logging.getLogger("paintersketch.document")

_FRAME_MAX = 8192
"""Hard cap on frame dimensions, matching the node's input widget max."""


def parse_document(raw: str) -> dict | None:
    """Parse a raw JSON manifest string into a document dict.

    Returns the parsed dict on success, or ``None`` when the string is empty,
    not valid JSON, or not a JSON object.  Logs a warning for invalid JSON so
    the operator can see that a saved document was unreadable.

    Args:
        raw: The ``document`` widget value from a PainterSketch node.

    Returns:
        Parsed document dict, or ``None`` if the input is empty or invalid.
    """
    if not raw or not raw.strip():
        return None
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as exc:
        log.warning("document: invalid JSON in manifest (%s); treating as empty", exc)
        return None
    if not isinstance(doc, dict):
        log.warning("document: manifest is not a JSON object; treating as empty")
        return None
    return doc


def frame_size(doc: dict | None) -> tuple[int, int] | None:
    """Extract the canvas frame size from a parsed document.

    Reads ``doc["frame"]["width"]`` and ``doc["frame"]["height"]``.  Returns
    ``None`` if either field is missing, not an integer, not positive, or
    exceeds :data:`_FRAME_MAX`.  Invalid values are logged as warnings.

    Args:
        doc: A dict previously returned by :func:`parse_document`, or ``None``.

    Returns:
        ``(width, height)`` tuple of positive ints, or ``None``.
    """
    if doc is None:
        return None
    frame = doc.get("frame")
    if not isinstance(frame, dict):
        return None
    w = frame.get("width")
    h = frame.get("height")
    if not isinstance(w, int) or not isinstance(h, int):
        log.warning("document: frame width/height are not integers (%r, %r)", w, h)
        return None
    if w <= 0 or h <= 0:
        log.warning("document: frame dimensions must be positive (%d x %d)", w, h)
        return None
    if w > _FRAME_MAX or h > _FRAME_MAX:
        log.warning(
            "document: frame dimensions exceed max (%d x %d > %d); ignoring",
            w, h, _FRAME_MAX,
        )
        return None
    return (w, h)
