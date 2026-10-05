"""
tests/test_composite.py -- Unit tests for nodes/composite.py.

No ComfyUI imports; composite.py is a pure-torch module.
Run with:  python -m unittest tests.test_composite   (from repo root)

Covers:
  - _place_layer: correct placement, scale=1 integer, partial overlap, no overlap
  - composite_paint_layers: passthrough, single layer, hidden skipped, opacity
  - combine_mask_layers: no masks=zeros, single mask, node invert, subtract
    cmasks (MASK = U * (1 - S), subtract wins over invert_mask)
  - run_composite: red paint layer over grey; frame-mismatch scale+center
  - text layers (with textData) composite exactly like paint layers
"""

import json
import sys
import os
import unittest

import torch

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from nodes.document import Bounds, Document, Frame, Layer, parse_document
from nodes.composite import (
    _place_layer, _scale_factor,
    composite_paint_layers, combine_mask_layers, run_composite,
)


def _frame(w=100, h=100):
    return Frame(width=w, height=h)

def _bounds(x=0, y=0, w=100, h=100):
    return Bounds(x=x, y=y, width=w, height=h)

def _paint_layer(lid="l1", visible=True, opacity=1.0, file="f"):
    return Layer(id=lid, kind="paint", visible=visible, opacity=opacity, file=file)

def _mask_layer(lid="m1", visible=True, subtract=False, file="f"):
    return Layer(id=lid, kind="mask", visible=visible, opacity=1.0, file=file, subtract=subtract)

def _rgba(h, w, r=0.0, g=0.0, b=0.0, a=1.0):
    """Solid-colour RGBA tensor [h, w, 4]."""
    t = torch.zeros(h, w, 4)
    t[:, :, 0] = r
    t[:, :, 1] = g
    t[:, :, 2] = b
    t[:, :, 3] = a
    return t


class TestScaleFactor(unittest.TestCase):
    def test_same_size(self):
        self.assertAlmostEqual(_scale_factor(100, 100, 100, 100), 1.0)

    def test_width_limited(self):
        # W=200, H=200, fw=100, fh=200 -> s = min(2, 1) = 1
        self.assertAlmostEqual(_scale_factor(200, 200, 100, 200), 1.0)

    def test_height_limited(self):
        self.assertAlmostEqual(_scale_factor(200, 100, 100, 200), 0.5)


class TestPlaceLayer(unittest.TestCase):
    def test_exact_fit_no_scale(self):
        """s=1, no offset -> layer fills canvas exactly."""
        rgba = _rgba(50, 100, r=1.0)
        placed = _place_layer(rgba, _bounds(0, 0, 100, 50), W=100, H=50, s=1.0, ox=0.0, oy=0.0)
        self.assertEqual(placed.shape, (50, 100, 4))
        self.assertAlmostEqual(placed[0, 0, 0].item(), 1.0)  # red channel

    def test_positive_offset(self):
        """Layer offset by (10, 5)."""
        rgba = _rgba(10, 20, a=1.0, g=1.0)
        placed = _place_layer(rgba, _bounds(10, 5, 20, 10), W=50, H=30, s=1.0, ox=0.0, oy=0.0)
        # Pixel at (y=5, x=10) should be inside the layer
        self.assertAlmostEqual(placed[5, 10, 3].item(), 1.0, places=3)
        # Pixel at (0, 0) should be outside (alpha=0)
        self.assertAlmostEqual(placed[0, 0, 3].item(), 0.0, places=3)

    def test_partial_overlap_negative_offset(self):
        """Layer starts at negative x; only the visible portion is placed."""
        rgba = _rgba(10, 40, a=1.0, b=1.0)
        # bounds.x=-10 so layer straddles left edge
        placed = _place_layer(rgba, _bounds(-10, 0, 40, 10), W=30, H=10, s=1.0, ox=0.0, oy=0.0)
        # Column 0 (frame) maps to layer col 10 -> should have content
        self.assertAlmostEqual(placed[0, 0, 3].item(), 1.0, places=3)

    def test_no_overlap(self):
        """Layer entirely outside canvas -> all zeros."""
        rgba = _rgba(10, 10, a=1.0)
        placed = _place_layer(rgba, _bounds(200, 200, 10, 10), W=50, H=50, s=1.0, ox=0.0, oy=0.0)
        self.assertAlmostEqual(placed.sum().item(), 0.0)

    def test_scale_2x(self):
        """s=2: a 10x10 layer should expand to 20x20 on a 40x40 canvas."""
        rgba = _rgba(10, 10, a=1.0)
        placed = _place_layer(rgba, _bounds(0, 0, 10, 10), W=40, H=40, s=2.0, ox=0.0, oy=0.0)
        # Rows 0-19, cols 0-19 should be non-zero
        self.assertGreater(placed[0, 0, 3].item(), 0.9)
        self.assertAlmostEqual(placed[25, 25, 3].item(), 0.0, places=3)


class TestCompositePaintLayers(unittest.TestCase):
    def test_no_layers_passthrough(self):
        base = torch.full((2, 10, 10, 3), 0.5)
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[])
        result, _ = run_composite(base, doc, {}, invert_mask=False)
        self.assertTrue(torch.allclose(result, base))

    def test_hidden_layer_skipped(self):
        base = torch.full((1, 10, 10, 3), 0.5)
        layer = _paint_layer(visible=False)
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[layer])
        rgba = _rgba(10, 10, r=1.0, a=1.0)
        result, _ = run_composite(base, doc, {"l1": rgba}, invert_mask=False)
        # Output should still be grey (layer was skipped)
        self.assertAlmostEqual(result[0, 5, 5, 0].item(), 0.5, places=4)

    def test_red_half_alpha_over_grey(self):
        """Red layer at 50% alpha over 50% grey -> 75% red channel."""
        base = torch.full((1, 10, 10, 3), 0.5)
        layer = _paint_layer(opacity=1.0)
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[layer])
        rgba = _rgba(10, 10, r=1.0, a=0.5)
        result, _ = run_composite(base, doc, {"l1": rgba}, invert_mask=False)
        # out = 1.0 * 0.5 + 0.5 * 0.5 = 0.75
        self.assertAlmostEqual(result[0, 5, 5, 0].item(), 0.75, places=4)
        # green unchanged: 0.0 * 0.5 + 0.5 * 0.5 = 0.25
        self.assertAlmostEqual(result[0, 5, 5, 1].item(), 0.25, places=4)

    def test_opacity_scales_alpha(self):
        """Full-alpha layer at opacity=0.5 over grey=0.5."""
        base = torch.full((1, 10, 10, 3), 0.5)
        layer = _paint_layer(opacity=0.5)
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[layer])
        rgba = _rgba(10, 10, r=1.0, a=1.0)
        result, _ = run_composite(base, doc, {"l1": rgba}, invert_mask=False)
        # eff_a = 1.0 * 0.5 = 0.5; out = 1.0*0.5 + 0.5*0.5 = 0.75
        self.assertAlmostEqual(result[0, 5, 5, 0].item(), 0.75, places=4)

    def test_none_tensor_treated_as_empty(self):
        base = torch.full((1, 10, 10, 3), 0.5)
        layer = _paint_layer()
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[layer])
        result, _ = run_composite(base, doc, {"l1": None}, invert_mask=False)
        self.assertAlmostEqual(result[0, 5, 5, 0].item(), 0.5, places=4)

    def test_batch_broadcast(self):
        """Paint applies identically to every image in the batch."""
        base = torch.full((3, 10, 10, 3), 0.5)
        layer = _paint_layer()
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[layer])
        rgba = _rgba(10, 10, r=1.0, a=1.0)
        result, mask = run_composite(base, doc, {"l1": rgba}, invert_mask=False)
        self.assertEqual(result.shape, (3, 10, 10, 3))
        self.assertEqual(mask.shape, (3, 10, 10))
        # All batch items identical
        self.assertTrue(torch.allclose(result[0], result[1]))
        self.assertTrue(torch.allclose(result[0], result[2]))


class TestTextLayer(unittest.TestCase):
    """Text layers (SPEC "Tools" > "Text (T)") are rasterized by the frontend: Python composites them like paint."""

    def _manifest(self, kind):
        return json.dumps({
            "version": 1, "docId": "abcd1234",
            "frame": {"width": 10, "height": 10},
            "bounds": {"x": 0, "y": 0, "width": 10, "height": 10},
            "regions": [], "activeLayerId": "t1",
            "layers": [{
                "id": "t1", "name": "Hello", "kind": kind, "visible": True, "locked": False,
                "opacity": 0.5, "blendMode": "normal", "file": "painter-sketch/ps-abcd1234-1.webp [input]",
                "textData": {"text": "Hello", "x": 1, "y": 8, "font": "Arial", "size": 8,
                             "color": "#ff0000", "bold": False, "italic": False, "align": "left"},
            }],
        })

    def test_text_layer_composites_like_paint(self):
        base = torch.full((1, 10, 10, 3), 0.5)
        rgba = _rgba(10, 10, r=1.0, a=1.0)
        results = []
        for kind in ("text", "paint"):
            doc = parse_document(self._manifest(kind))
            self.assertIsNotNone(doc)
            self.assertEqual(doc.layers[0].kind, kind)
            image, mask = run_composite(base, doc, {"t1": rgba}, invert_mask=False)
            results.append(image)
            self.assertAlmostEqual(mask.sum().item(), 0.0)  # never part of MASK
        self.assertTrue(torch.allclose(results[0], results[1]))
        # opacity 0.5: 1.0 * 0.5 + 0.5 * 0.5
        self.assertAlmostEqual(results[0][0, 5, 5, 0].item(), 0.75, places=4)


class TestCombineMaskLayers(unittest.TestCase):
    def test_no_mask_layers_zeros(self):
        base = torch.full((1, 10, 10, 3), 0.5)
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[])
        _, mask = run_composite(base, doc, {}, invert_mask=False)
        self.assertAlmostEqual(mask.sum().item(), 0.0)

    def test_no_mask_layers_invert_node_gives_ones(self):
        base = torch.full((1, 10, 10, 3), 0.5)
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[])
        _, mask = run_composite(base, doc, {}, invert_mask=True)
        self.assertAlmostEqual(mask.sum().item(), 100.0)  # 10*10*1.0

    def test_mask_alpha_used(self):
        """Full-alpha mask layer -> mask is 1.0 everywhere."""
        base = torch.full((1, 10, 10, 3), 0.5)
        layer = _mask_layer()
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[layer])
        rgba = _rgba(10, 10, a=1.0)
        _, mask = run_composite(base, doc, {"m1": rgba}, invert_mask=False)
        self.assertAlmostEqual(mask[0, 5, 5].item(), 1.0, places=4)

    def test_mask_opacity_ignored(self):
        """Mask layer opacity is display-only; does NOT affect MASK output."""
        base = torch.full((1, 10, 10, 3), 0.5)
        layer = Layer(id="m1", kind="mask", visible=True, opacity=0.3, file="f")
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[layer])
        rgba = _rgba(10, 10, a=1.0)
        _, mask = run_composite(base, doc, {"m1": rgba}, invert_mask=False)
        # Must be 1.0, not 0.3
        self.assertAlmostEqual(mask[0, 5, 5].item(), 1.0, places=4)

    def test_subtract_only_is_empty(self):
        """Only subtract cmasks, invert_mask off -> nothing to subtract from: zeros."""
        base = torch.full((1, 10, 10, 3), 0.5)
        layer = _mask_layer(subtract=True)
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[layer])
        rgba = _rgba(10, 10, a=0.0)
        rgba[:, :5, 3] = 1.0
        _, mask = run_composite(base, doc, {"m1": rgba}, invert_mask=False)
        self.assertEqual(mask.sum().item(), 0.0)

    def test_hidden_mask_skipped(self):
        base = torch.full((1, 10, 10, 3), 0.5)
        layer = _mask_layer(visible=False)
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[layer])
        rgba = _rgba(10, 10, a=1.0)
        _, mask = run_composite(base, doc, {"m1": rgba}, invert_mask=False)
        self.assertAlmostEqual(mask.sum().item(), 0.0)

    def test_node_invert_mask(self):
        """Node invert_mask flips the final combined mask."""
        base = torch.full((1, 10, 10, 3), 0.5)
        layer = _mask_layer()
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[layer])
        rgba = _rgba(10, 10, a=1.0)
        _, mask = run_composite(base, doc, {"m1": rgba}, invert_mask=True)
        self.assertAlmostEqual(mask[0, 5, 5].item(), 0.0, places=4)

    def test_max_union_two_masks(self):
        """Two half-alpha masks: union = max(0.5, 0.5) = 0.5."""
        base = torch.full((1, 10, 10, 3), 0.5)
        l1 = _mask_layer(lid="m1")
        l2 = _mask_layer(lid="m2")
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[l1, l2])
        rgba = _rgba(10, 10, a=0.5)
        _, mask = run_composite(base, doc, {"m1": rgba, "m2": rgba}, invert_mask=False)
        self.assertAlmostEqual(mask[0, 5, 5].item(), 0.5, places=4)

    def test_two_subtract_one_normal(self):
        """Normal cmask minus two disjoint subtract cmasks."""
        base = torch.full((1, 10, 10, 3), 0.5)
        layers = [_mask_layer("n"), _mask_layer("s1", subtract=True), _mask_layer("s2", subtract=True)]
        normal = _rgba(10, 10, a=0.0)
        normal[:, :8, 3] = 1.0          # cols 0-7
        s1 = _rgba(10, 10, a=0.0)
        s1[:, 1:3, 3] = 1.0             # cols 1-2
        s2 = _rgba(10, 10, a=0.0)
        s2[:, 5:7, 3] = 0.5             # cols 5-6, half
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=layers)
        _, mask = run_composite(base, doc, {"n": normal, "s1": s1, "s2": s2}, invert_mask=False)
        expected = [1.0, 0.0, 0.0, 1.0, 1.0, 0.5, 0.5, 1.0, 0.0, 0.0]
        for col, value in enumerate(expected):
            self.assertAlmostEqual(mask[0, 4, col].item(), value, places=4, msg=f"col {col}")

    def test_invert_mask_with_subtract(self):
        """invert_mask + a subtract cmask: everything masked except the subtract area."""
        base = torch.full((1, 10, 10, 3), 0.5)
        layer = _mask_layer(subtract=True)
        rgba = _rgba(10, 10, a=0.0)
        rgba[2:4, 2:4, 3] = 1.0
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[layer])
        _, mask = run_composite(base, doc, {"m1": rgba}, invert_mask=True)
        expected = torch.ones(10, 10)
        expected[2:4, 2:4] = 0.0
        self.assertTrue(torch.equal(mask[0], expected))

    def test_empty_subtract_is_noop(self):
        """A visible subtract cmask without a file changes nothing (and is no mask row)."""
        base = torch.full((1, 10, 10, 3), 0.5)
        layers = [_mask_layer("n"), _mask_layer("s", subtract=True, file=None)]
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=layers)
        _, mask = run_composite(base, doc, {"n": _rgba(10, 10, a=0.5), "s": None}, invert_mask=False)
        self.assertTrue(torch.allclose(mask, torch.full_like(mask, 0.5)))
        doc.layers = [layers[1]]
        _, mask = run_composite(base, doc, {"s": None}, invert_mask=True)
        self.assertTrue(torch.equal(mask, torch.ones_like(mask)))

    def test_seven_masks_union_subtract_hidden(self):
        """7 masks, each covering its own row; hidden masks skipped, a subtract
        mask removes its row after node invert."""
        base = torch.full((1, 10, 10, 3), 0.5)
        layers, tensors = [], {}
        for i in range(7):
            lid = f"m{i}"
            layers.append(_mask_layer(lid=lid, visible=(i != 3)))
            rgba = _rgba(10, 10, a=0.0)
            rgba[i, :, 3] = 1.0
            tensors[lid] = rgba
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=layers)
        _, mask = run_composite(base, doc, tensors, invert_mask=False)
        for row in range(10):
            expected = 1.0 if row < 7 and row != 3 else 0.0
            self.assertAlmostEqual(mask[0, row, 0].item(), expected, places=4)
        # Subtract m6 removes row 6 (nobody else covers it) and leaves the rest.
        layers[6] = _mask_layer(lid="m6", subtract=True)
        _, mask = run_composite(base, doc, tensors, invert_mask=False)
        self.assertAlmostEqual(mask[0, 6, 0].item(), 0.0, places=4)
        self.assertAlmostEqual(mask[0, 5, 0].item(), 1.0, places=4)
        self.assertAlmostEqual(mask[0, 9, 0].item(), 0.0, places=4)
        # invert_mask flips the union (rows 0-5 except 3 -> 0); row 6 stays subtracted.
        _, mask = run_composite(base, doc, tensors, invert_mask=True)
        self.assertAlmostEqual(mask[0, 6, 0].item(), 0.0, places=4)
        self.assertAlmostEqual(mask[0, 5, 0].item(), 0.0, places=4)
        self.assertAlmostEqual(mask[0, 3, 0].item(), 1.0, places=4)
        self.assertAlmostEqual(mask[0, 9, 0].item(), 1.0, places=4)


class TestFrameMismatch(unittest.TestCase):
    def test_scale_center_paint(self):
        """doc 100x100, image 200x100 -> s=1, ox=50, oy=0.
        A layer at bounds(0,0,100,100) appears at x=[50,150], y=[0,100].
        """
        base = torch.zeros((1, 100, 200, 3))
        layer = _paint_layer()
        doc = Document(frame=_frame(100, 100), bounds=_bounds(0, 0, 100, 100), layers=[layer])
        rgba = _rgba(100, 100, r=1.0, a=1.0)
        result, _ = run_composite(base, doc, {"l1": rgba}, invert_mask=False)
        # Centre pixel (y=50, x=100) should be red
        self.assertAlmostEqual(result[0, 50, 100, 0].item(), 1.0, places=3)
        # Pixel at left edge x=10 (outside the placed layer) should be zero
        self.assertAlmostEqual(result[0, 50, 10, 0].item(), 0.0, places=3)

    def test_scale_half_paint(self):
        """doc 200x200, image 100x100 -> s=0.5.
        Layer bounds(0,0,200,200) placed at (0,0,100,100).
        """
        base = torch.zeros((1, 100, 100, 3))
        layer = _paint_layer()
        doc = Document(frame=_frame(200, 200), bounds=_bounds(0, 0, 200, 200), layers=[layer])
        rgba = _rgba(200, 200, r=1.0, a=1.0)
        result, _ = run_composite(base, doc, {"l1": rgba}, invert_mask=False)
        self.assertAlmostEqual(result[0, 50, 50, 0].item(), 1.0, places=2)


if __name__ == "__main__":
    unittest.main()
