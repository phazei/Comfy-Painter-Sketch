"""
tests/test_composite.py -- Unit tests for nodes/composite.py.

No ComfyUI imports; composite.py is a pure-torch module.
Run with:  python -m unittest tests.test_composite   (from repo root)

Covers:
  - _place_layer: correct placement, scale=1 integer, partial overlap, no overlap
  - composite_paint_layers: passthrough, single layer, hidden skipped, opacity
  - combine_mask_layers: no masks=zeros, single mask, per-layer invert, node invert
  - run_composite: red paint layer over grey; frame-mismatch scale+center
"""

import sys
import os
import unittest

import torch

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from nodes.document import Bounds, Document, Frame, Layer
from nodes.composite import (
    _place_layer, _scale_factor,
    composite_paint_layers, combine_mask_layers, run_composite,
)


def _frame(w=100, h=100):
    return Frame(width=w, height=h)

def _bounds(x=0, y=0, w=100, h=100):
    return Bounds(x=x, y=y, width=w, height=h)

def _paint_layer(lid="l1", visible=True, opacity=1.0, file="f"):
    return Layer(id=lid, kind="paint", visible=visible, opacity=opacity, file=file, invert=False)

def _mask_layer(lid="m1", visible=True, invert=False, file="f"):
    return Layer(id=lid, kind="mask", visible=visible, opacity=1.0, file=file, invert=invert)

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
        layer = Layer(id="m1", kind="mask", visible=True, opacity=0.3, file="f", invert=False)
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[layer])
        rgba = _rgba(10, 10, a=1.0)
        _, mask = run_composite(base, doc, {"m1": rgba}, invert_mask=False)
        # Must be 1.0, not 0.3
        self.assertAlmostEqual(mask[0, 5, 5].item(), 1.0, places=4)

    def test_per_layer_invert(self):
        """Per-layer invert: full-alpha layer inverted -> mask = 0.0."""
        base = torch.full((1, 10, 10, 3), 0.5)
        layer = _mask_layer(invert=True)
        doc = Document(frame=_frame(10, 10), bounds=_bounds(0, 0, 10, 10), layers=[layer])
        rgba = _rgba(10, 10, a=1.0)
        _, mask = run_composite(base, doc, {"m1": rgba}, invert_mask=False)
        self.assertAlmostEqual(mask[0, 5, 5].item(), 0.0, places=4)

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
