"""
tests/test_document.py -- Unit tests for nodes/document.py.

No ComfyUI imports; document.py is a pure-Python module.
Run with:  python -m unittest tests.test_document   (from repo root)
"""

import json
import sys
import os
import unittest

# Make the repo root importable regardless of working directory.
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from nodes.document import (
    Bounds, Document, Frame, Layer,
    _FRAME_MAX, _BOUNDS_MAX,
    parse_document, frame_size,
)


def _make_doc(**overrides) -> str:
    """Return a minimal valid v1 manifest JSON string."""
    base = {
        "version": 1,
        "frame": {"width": 100, "height": 200},
        "bounds": {"x": 0, "y": 0, "width": 100, "height": 200},
        "layers": [],
        "activeLayerId": "",
        "regions": [],
    }
    base.update(overrides)
    return json.dumps(base)


class TestParseDocumentBasic(unittest.TestCase):
    def test_empty_string_returns_none(self):
        self.assertIsNone(parse_document(""))

    def test_whitespace_only_returns_none(self):
        self.assertIsNone(parse_document("   "))

    def test_invalid_json_returns_none(self):
        self.assertIsNone(parse_document("{not json"))

    def test_json_array_returns_none(self):
        self.assertIsNone(parse_document("[1,2,3]"))

    def test_wrong_version_returns_none(self):
        self.assertIsNone(parse_document(_make_doc(version=2)))

    def test_missing_version_returns_none(self):
        d = json.loads(_make_doc())
        del d["version"]
        self.assertIsNone(parse_document(json.dumps(d)))

    def test_valid_minimal(self):
        doc = parse_document(_make_doc())
        self.assertIsInstance(doc, Document)
        self.assertEqual(doc.frame, Frame(100, 200))

    def test_bounds_fallback_to_frame(self):
        d = json.loads(_make_doc())
        del d["bounds"]
        doc = parse_document(json.dumps(d))
        self.assertIsInstance(doc, Document)
        self.assertEqual(doc.bounds, Bounds(0, 0, 100, 200))


class TestFrameValidation(unittest.TestCase):
    def test_frame_max_ok(self):
        doc = parse_document(_make_doc(frame={"width": _FRAME_MAX, "height": _FRAME_MAX}))
        self.assertIsNotNone(doc)

    def test_frame_exceed_max_returns_none(self):
        doc = parse_document(_make_doc(frame={"width": _FRAME_MAX + 1, "height": 100}))
        self.assertIsNone(doc)

    def test_frame_zero_returns_none(self):
        doc = parse_document(_make_doc(frame={"width": 0, "height": 100}))
        self.assertIsNone(doc)

    def test_frame_negative_returns_none(self):
        doc = parse_document(_make_doc(frame={"width": -1, "height": 100}))
        self.assertIsNone(doc)

    def test_frame_float_returns_none(self):
        doc = parse_document(_make_doc(frame={"width": 100.5, "height": 100}))
        self.assertIsNone(doc)


class TestBoundsValidation(unittest.TestCase):
    def test_negative_xy_ok(self):
        doc = parse_document(_make_doc(bounds={"x": -50, "y": -50, "width": 200, "height": 300}))
        self.assertIsNotNone(doc)
        self.assertEqual(doc.bounds.x, -50)

    def test_bounds_exceed_cap_falls_back(self):
        doc = parse_document(_make_doc(
            bounds={"x": 0, "y": 0, "width": _BOUNDS_MAX + 1, "height": 100}
        ))
        # Falls back to frame-sized bounds
        self.assertIsNotNone(doc)
        self.assertEqual(doc.bounds, Bounds(0, 0, 100, 200))

    def test_bounds_zero_width_falls_back(self):
        doc = parse_document(_make_doc(bounds={"x": 0, "y": 0, "width": 0, "height": 100}))
        self.assertIsNotNone(doc)
        self.assertEqual(doc.bounds, Bounds(0, 0, 100, 200))


class TestLayerParsing(unittest.TestCase):
    def _layer(self, **kw) -> dict:
        base = {
            "id": "abc",
            "name": "Layer 1",
            "kind": "paint",
            "visible": True,
            "locked": False,
            "opacity": 1.0,
            "blendMode": "normal",
            "file": None,
        }
        base.update(kw)
        return base

    def test_paint_layer_parsed(self):
        doc = parse_document(_make_doc(layers=[self._layer()]))
        self.assertEqual(len(doc.layers), 1)
        self.assertEqual(doc.layers[0].kind, "paint")

    def test_text_layer_kept(self):
        doc = parse_document(_make_doc(layers=[self._layer(kind="text")]))
        self.assertEqual(doc.layers[0].kind, "text")

    def test_mask_layer_kept(self):
        doc = parse_document(_make_doc(layers=[self._layer(kind="mask")]))
        self.assertEqual(doc.layers[0].kind, "mask")

    def test_unknown_kind_skipped(self):
        doc = parse_document(_make_doc(layers=[self._layer(kind="gradient")]))
        self.assertEqual(len(doc.layers), 0)

    def test_opacity_clamped_high(self):
        doc = parse_document(_make_doc(layers=[self._layer(opacity=2.5)]))
        self.assertAlmostEqual(doc.layers[0].opacity, 1.0)

    def test_opacity_clamped_low(self):
        doc = parse_document(_make_doc(layers=[self._layer(opacity=-0.5)]))
        self.assertAlmostEqual(doc.layers[0].opacity, 0.0)

    def test_hidden_layer_preserved(self):
        doc = parse_document(_make_doc(layers=[self._layer(visible=False)]))
        self.assertFalse(doc.layers[0].visible)

    def test_file_none_ok(self):
        doc = parse_document(_make_doc(layers=[self._layer(file=None)]))
        self.assertIsNone(doc.layers[0].file)

    def test_file_string_ok(self):
        doc = parse_document(_make_doc(layers=[
            self._layer(file="painter-sketch/abc.png [input]")
        ]))
        self.assertEqual(doc.layers[0].file, "painter-sketch/abc.png [input]")

    def test_invert_default_false(self):
        doc = parse_document(_make_doc(layers=[self._layer(kind="mask")]))
        self.assertFalse(doc.layers[0].invert)

    def test_invert_true_preserved(self):
        doc = parse_document(_make_doc(layers=[self._layer(kind="mask", invert=True)]))
        self.assertTrue(doc.layers[0].invert)

    def test_layer_missing_id_skipped(self):
        l = self._layer()
        del l["id"]
        doc = parse_document(_make_doc(layers=[l]))
        self.assertEqual(len(doc.layers), 0)

    def test_multiple_layers_order_preserved(self):
        layers = [self._layer(id=f"l{i}") for i in range(3)]
        doc = parse_document(_make_doc(layers=layers))
        self.assertEqual([l.id for l in doc.layers], ["l0", "l1", "l2"])


class TestFrameSize(unittest.TestCase):
    def test_none_returns_none(self):
        self.assertIsNone(frame_size(None))

    def test_returns_tuple(self):
        doc = parse_document(_make_doc())
        self.assertEqual(frame_size(doc), (100, 200))


if __name__ == "__main__":
    unittest.main()
