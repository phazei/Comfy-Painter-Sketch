"""
nodes/document_regions.py -- Output region and output-option records (M9).

Additive v1 manifest fields (SPEC.md "Output regions (M9) -- agreed design"):

    regions:    [{id, slot 1..6, rect {x, y, width, height}, name?, visible?, output?}]
    mainOutput: {applyMask: "none"|"fill"|"crop"|"border", fillColor: "#rrggbb", cropPadding,
                 borderSize 1..4096, borderColor: "#rrggbb", borderMask: bool}

Region rects are in current-image pixels from the top-left and are never
rescaled. Legacy records ``{id, index, rect}`` map to ``slot = index + 1``.
Validation is per record: a bad region is skipped on its own and never
discards paint or the other regions. Mirrors ``ui/src/document/regions.ts`` and
``ui/src/document/outputOptions.ts``.
"""

import logging
import math
import re
from dataclasses import dataclass

log = logging.getLogger("paintersketch.document_regions")

REGION_SLOTS = 6
"""Number of fixed region slots (helper node pairs)."""

_MAX_SAFE_INTEGER = 2**53 - 1  # JavaScript Number.MAX_SAFE_INTEGER

MAX_BORDER_SIZE = 4096
"""Largest ``borderSize`` (px per side); mirrors ``ui/src/document/outputOptions.ts``."""

_COLOR = re.compile(r"#[0-9a-fA-F]{6}")


@dataclass(frozen=True)
class OutputOptions:
    """Post-processing for one output (Main or one region).

    Attributes:
        apply_mask:   ``"none"`` | ``"fill"`` | ``"crop"`` | ``"border"``.
        fill_color:   ``#rrggbb`` (lower case) used by ``fill``.
        crop_padding: Non-negative integer px added around the ``crop`` bbox.
        border_size:  ``1..MAX_BORDER_SIZE`` px added on every side by ``border``.
        border_color: ``#rrggbb`` (lower case) of the ``border`` area.
        border_mask:  ``border`` area in the MASK: True = 1.0, False = 0.0.
    """
    apply_mask: str = "none"
    fill_color: str = "#000000"
    crop_padding: int = 0
    border_size: int = 64
    border_color: str = "#ffffff"
    border_mask: bool = True


@dataclass(frozen=True)
class RegionRect:
    """Region rectangle in image px (finite; may be fractional or off-image)."""
    x: float
    y: float
    width: float
    height: float


@dataclass(frozen=True)
class Region:
    """One output region; ``visible`` only affects the editor overlay."""
    id: str
    slot: int
    rect: RegionRect
    name: str = ""
    visible: bool = True
    output: OutputOptions = OutputOptions()


def _number(value: object) -> float | None:
    """Return a finite JSON number as float; bools and huge ints -> None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except OverflowError:
        return None
    return number if math.isfinite(number) else None


def parse_output_options(raw: object) -> OutputOptions:
    """Validate an output-options record; each bad field defaults on its own.

    Padding is floored and clamped to ``[0, MAX_SAFE_INTEGER]`` and the border
    size to ``[1, MAX_BORDER_SIZE]`` like the editor; missing fields = defaults.

    Args:
        raw: ``mainOutput`` or a region's ``output`` value (any JSON value).

    Returns:
        Validated :class:`OutputOptions`.
    """
    if not isinstance(raw, dict):
        return OutputOptions()
    mode = raw.get("applyMask")
    if mode not in ("none", "fill", "crop", "border"):
        mode = "none"
    padding = _number(raw.get("cropPadding"))
    crop_padding = 0 if padding is None else min(_MAX_SAFE_INTEGER, max(0, math.floor(padding)))
    size = _number(raw.get("borderSize"))
    border_size = 64 if size is None else min(MAX_BORDER_SIZE, max(1, math.floor(size)))
    border_mask = raw.get("borderMask")
    return OutputOptions(
        apply_mask=mode,
        fill_color=_color(raw.get("fillColor"), "#000000"),
        crop_padding=crop_padding,
        border_size=border_size,
        border_color=_color(raw.get("borderColor"), "#ffffff"),
        border_mask=border_mask if isinstance(border_mask, bool) else True,
    )


def _color(value: object, fallback: str) -> str:
    """Return a lower-case ``#rrggbb`` colour, or ``fallback`` when invalid."""
    if not isinstance(value, str) or _COLOR.fullmatch(value) is None:
        return fallback
    return value.lower()


def _parse_slot(raw: dict) -> int | None:
    """Return the 1-based slot (``slot``, else legacy ``index + 1``), or None.

    A present but invalid ``slot`` never falls back to ``index``.
    """
    legacy = "slot" not in raw
    value = _number(raw.get("index") if legacy else raw.get("slot"))
    if value is None or not value.is_integer():
        return None
    slot = int(value) + (1 if legacy else 0)
    return slot if 1 <= slot <= REGION_SLOTS else None


def _parse_rect(raw: object) -> RegionRect | None:
    """Return a finite positive-size :class:`RegionRect`, or None."""
    if not isinstance(raw, dict):
        return None
    x, y, w, h = (_number(raw.get(key)) for key in ("x", "y", "width", "height"))
    if x is None or y is None or w is None or h is None or w <= 0 or h <= 0:
        return None
    if not math.isfinite(x + w) or not math.isfinite(y + h):
        return None
    return RegionRect(x, y, w, h)


def _parse_region(raw: object) -> Region | None:
    """Validate one region record; None when it must be skipped."""
    if not isinstance(raw, dict):
        return None
    region_id = raw.get("id")
    if not isinstance(region_id, str) or not region_id.strip():
        return None
    slot = _parse_slot(raw)
    rect = _parse_rect(raw.get("rect"))
    if slot is None or rect is None:
        return None
    name = raw.get("name", "")
    visible = raw.get("visible", True)
    return Region(
        id=region_id,
        slot=slot,
        rect=rect,
        name=name if isinstance(name, str) else "",
        visible=visible if isinstance(visible, bool) else True,
        output=parse_output_options(raw.get("output")),
    )


def parse_regions(raw: object) -> list[Region]:
    """Parse the ``regions`` array; invalid or duplicate records are skipped.

    The first valid record wins a given id or slot.

    Args:
        raw: The manifest's ``regions`` value (any JSON value).

    Returns:
        Valid regions in manifest order.
    """
    if not isinstance(raw, list):
        return []
    regions: list[Region] = []
    ids: set[str] = set()
    slots: set[int] = set()
    for index, record in enumerate(raw):
        region = _parse_region(record)
        if region is None or region.id in ids or region.slot in slots:
            log.warning("document: region[%d] invalid or duplicate; skipping", index)
            continue
        regions.append(region)
        ids.add(region.id)
        slots.add(region.slot)
    return regions
