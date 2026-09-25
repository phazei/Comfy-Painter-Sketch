"""
tests/test_placement.py -- Move-tool placement (SPEC.md "Saved-file contract",
Placement): lenient parsing in nodes/document.py and its composition into the
layer placement in nodes/composite.py.

Run with:  python -m unittest tests.test_placement   (from repo root)
"""

import json
import os
import sys
import unittest

import torch

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from nodes.document import (
    IDENTITY_PLACEMENT, Bounds, Document, Frame, Layer, Placement,
    parse_document, parse_placement,
)
from nodes.composite import _layout, run_composite


def _doc_json(**extra) -> str:
    base = {
        "version": 1,
        "frame": {"width": 100, "height": 100},
        "bounds": {"x": 0, "y": 0, "width": 100, "height": 100},
        "regions": [],
        "activeLayerId": "",
        "layers": [],
    }
    base.update(extra)
    return json.dumps(base)


def _paint(lid="l1"):
    return Layer(id=lid, kind="paint", visible=True, opacity=1.0, file="f", invert=False)


def _mask(lid="m1"):
    return Layer(id=lid, kind="mask", visible=True, opacity=1.0, file="f", invert=False)


def _square(size=100, x0=0, y0=0, x1=10, y1=10):
    """Transparent size x size RGBA with an opaque red square [y0:y1, x0:x1]."""
    t = torch.zeros(size, size, 4)
    t[y0:y1, x0:x1, 0] = 1.0
    t[y0:y1, x0:x1, 3] = 1.0
    return t


def _run(doc: Document, rgba: torch.Tensor, W: int, H: int):
    base = torch.zeros((1, H, W, 3))
    tensors = {layer.id: rgba for layer in doc.layers}
    return run_composite(base, doc, tensors, invert_mask=False)


class TestParsePlacement(unittest.TestCase):
    def test_missing_is_identity(self):
        self.assertEqual(parse_document(_doc_json()).placement, IDENTITY_PLACEMENT)

    def test_values_kept(self):
        doc = parse_document(_doc_json(placement={"x": 10.5, "y": -5, "scale": 1.5}))
        self.assertEqual(doc.placement, Placement(10.5, -5.0, 1.5))

    def test_scale_clamped(self):
        self.assertEqual(parse_placement({"scale": 100}).scale, 20.0)
        self.assertEqual(parse_placement({"scale": 0}).scale, 0.05)
        self.assertEqual(parse_placement({"scale": -3}).scale, 0.05)

    def test_bad_fields_fall_back(self):
        p = parse_placement({"x": "10", "y": True, "scale": None})
        self.assertEqual(p, IDENTITY_PLACEMENT)
        self.assertEqual(parse_placement({"x": float("nan"), "scale": float("inf")}), IDENTITY_PLACEMENT)

    def test_not_object_is_identity(self):
        self.assertEqual(parse_placement([1, 2]), IDENTITY_PLACEMENT)
        self.assertEqual(parse_document(_doc_json(placement="x")).placement, IDENTITY_PLACEMENT)


class TestLayout(unittest.TestCase):
    def test_identity_matches_frame_map(self):
        frame = Frame(512, 512)
        s, ox, oy = _layout(1024, 768, frame, IDENTITY_PLACEMENT)
        self.assertEqual((s, ox, oy), (1.5, 128.0, 0.0))

    def test_hand_computed(self):
        # s = 0.5, offset (0, 0); scale 2 about c = (50, 50), move (10, 4):
        # eff_s = 1, eff_ox = 0.5 * (50 * -1 + 10) = -20, eff_oy = 0.5 * (-50 + 4) = -23
        self.assertEqual(_layout(50, 50, Frame(100, 100), Placement(10, 4, 2)), (1.0, -20.0, -23.0))


class TestCompositePlacement(unittest.TestCase):
    def test_identity_unchanged(self):
        rgba = _square(x0=20, y0=30, x1=40, y1=50)
        plain = Document(frame=Frame(100, 100), bounds=Bounds(0, 0, 100, 100), layers=[_paint()])
        placed = Document(frame=Frame(100, 100), bounds=Bounds(0, 0, 100, 100), layers=[_paint()],
                          placement=Placement(0.0, 0.0, 1.0))
        a, _ = _run(plain, rgba, 100, 100)
        b, _ = _run(placed, rgba, 100, 100)
        self.assertTrue(torch.equal(a, b))

    def test_translate_shifts_pixels(self):
        rgba = _square(x0=0, y0=0, x1=10, y1=10)
        doc = Document(frame=Frame(100, 100), bounds=Bounds(0, 0, 100, 100),
                       layers=[_paint(), _mask()], placement=Placement(10, 5, 1))
        image, mask = _run(doc, rgba, 100, 100)
        # Square now covers x 10..19, y 5..14 exactly (integer shift, no resample).
        self.assertEqual(image[0, 5, 10, 0].item(), 1.0)
        self.assertEqual(image[0, 14, 19, 0].item(), 1.0)
        self.assertEqual(image[0, 4, 10, 0].item(), 0.0)
        self.assertEqual(image[0, 5, 9, 0].item(), 0.0)
        self.assertEqual(image[0, 15, 20, 0].item(), 0.0)
        self.assertEqual(image[0, :, :, 0].sum().item(), 100.0)
        # Masks move with the paint.
        self.assertTrue(torch.equal(mask[0], image[0, :, :, 0]))

    def test_scale_two_about_centre(self):
        rgba = _square(x0=45, y0=45, x1=55, y1=55)
        doc = Document(frame=Frame(100, 100), bounds=Bounds(0, 0, 100, 100),
                       layers=[_paint()], placement=Placement(0, 0, 2))
        image, _ = _run(doc, rgba, 100, 100)
        # 45..55 about 50 at 2x -> 40..60.
        self.assertGreater(image[0, 42, 42, 0].item(), 0.99)
        self.assertGreater(image[0, 57, 57, 0].item(), 0.99)
        self.assertLess(image[0, 37, 50, 0].item(), 0.01)
        self.assertLess(image[0, 50, 62, 0].item(), 0.01)

    def test_combined_with_frame_mismatch(self):
        # doc 100x100 into 200x100: s = 1, offset (50, 0); placement +10 x.
        rgba = _square(x0=0, y0=0, x1=10, y1=10)
        doc = Document(frame=Frame(100, 100), bounds=Bounds(0, 0, 100, 100),
                       layers=[_paint()], placement=Placement(10, 0, 1))
        image, _ = _run(doc, rgba, 200, 100)
        self.assertEqual(image[0, 0, 60, 0].item(), 1.0)
        self.assertEqual(image[0, 0, 69, 0].item(), 1.0)
        self.assertEqual(image[0, 0, 59, 0].item(), 0.0)
        self.assertEqual(image[0, 0, 70, 0].item(), 0.0)

    def test_combined_downscale(self):
        # doc 100x100 into 50x50: s = 0.5; placement (20, 0) doc px = 10 image px.
        rgba = _square(x0=0, y0=0, x1=20, y1=20)
        doc = Document(frame=Frame(100, 100), bounds=Bounds(0, 0, 100, 100),
                       layers=[_paint()], placement=Placement(20, 0, 1))
        image, _ = _run(doc, rgba, 50, 50)
        self.assertGreater(image[0, 4, 12, 0].item(), 0.99)
        self.assertLess(image[0, 4, 8, 0].item(), 0.01)
        self.assertLess(image[0, 4, 22, 0].item(), 0.01)


if __name__ == "__main__":
    unittest.main()
