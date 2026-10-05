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
    FRAME_MAX,
    parse_document,
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


class TestBackgroundVisible(unittest.TestCase):
    """``backgroundVisible``: only JSON false hides; everything else is visible."""

    def test_missing_is_visible(self):
        self.assertTrue(parse_document(_make_doc()).background_visible)

    def test_booleans_are_read(self):
        self.assertFalse(parse_document(_make_doc(backgroundVisible=False)).background_visible)
        self.assertTrue(parse_document(_make_doc(backgroundVisible=True)).background_visible)

    def test_non_boolean_is_visible(self):
        for bad in ("false", 0, None, {}, []):
            with self.subTest(bad=bad):
                self.assertTrue(parse_document(_make_doc(backgroundVisible=bad)).background_visible)


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
    def test_frame_max_matches_editor(self):
        """The editor's MAX_DOCUMENT_SIDE is 16384; Python accepts the same frames."""
        self.assertEqual(FRAME_MAX, 16384)
        doc = parse_document(_make_doc(frame={"width": 16384, "height": 12000},
                                       bounds={"x": 0, "y": 0, "width": 16384, "height": 12000}))
        self.assertEqual(doc.frame, Frame(16384, 12000))

    def test_frame_exceed_max_returns_none(self):
        doc = parse_document(_make_doc(frame={"width": FRAME_MAX + 1, "height": 100}))
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
            bounds={"x": 0, "y": 0, "width": FRAME_MAX + 1, "height": 100}
        ))
        # Falls back to frame-sized bounds
        self.assertIsNotNone(doc)
        self.assertEqual(doc.bounds, Bounds(0, 0, 100, 200))

    def test_bounds_offset_cap_matches_editor(self):
        """|x|, |y| beyond 4 * 16384 are malformed and fall back (editor isInt).

        In range, the frame-containment rule (bounds side <= 16384) is the real limit.
        """
        ok = parse_document(_make_doc(bounds={"x": -16000, "y": 0, "width": 16100, "height": 200}))
        self.assertEqual(ok.bounds.x, -16000)
        bad = parse_document(_make_doc(bounds={"x": -65537, "y": 0, "width": 200, "height": 300}))
        self.assertEqual(bad.bounds, Bounds(0, 0, 100, 200))

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

    def test_subtract_default_false(self):
        doc = parse_document(_make_doc(layers=[self._layer(kind="mask")]))
        self.assertFalse(doc.layers[0].subtract)

    def test_subtract_true_preserved(self):
        doc = parse_document(_make_doc(layers=[self._layer(kind="mask", subtract=True)]))
        self.assertTrue(doc.layers[0].subtract)

    def test_subtract_ignored_on_paint_and_text(self):
        for kind in ("paint", "text"):
            with self.subTest(kind=kind):
                doc = parse_document(_make_doc(layers=[self._layer(kind=kind, subtract=True)]))
                self.assertFalse(doc.layers[0].subtract)

    def test_non_boolean_subtract_ignored(self):
        """Like the editor (parse.ts readLayer), only a real boolean subtracts."""
        for value in (1, "true", "yes", [1], {"a": 1}, None):
            with self.subTest(value=value):
                doc = parse_document(_make_doc(layers=[self._layer(kind="mask", subtract=value)]))
                self.assertFalse(doc.layers[0].subtract)

    def test_non_numeric_opacity_defaults_to_one(self):
        """Like the editor's clamp01: bool, string, null, NaN, inf -> 1."""
        for value in (True, False, "0.5", None, [0.5], float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=value):
                doc = parse_document(_make_doc(layers=[self._layer(opacity=value)]))
                self.assertEqual(doc.layers[0].opacity, 1.0)
        doc = parse_document(_make_doc(layers=[self._layer(opacity=0)]))
        self.assertEqual(doc.layers[0].opacity, 0.0)

    def test_layer_missing_id_skipped(self):
        l = self._layer()
        del l["id"]
        doc = parse_document(_make_doc(layers=[l]))
        self.assertEqual(len(doc.layers), 0)

    def test_multiple_layers_order_preserved(self):
        layers = [self._layer(id=f"l{i}") for i in range(3)]
        doc = parse_document(_make_doc(layers=layers))
        self.assertEqual([l.id for l in doc.layers], ["l0", "l1", "l2"])


class TestEditorParity(unittest.TestCase):
    """Manifests the editor rejects (parse.ts) are "no document" here too."""

    def test_bounds_not_containing_frame_returns_none(self):
        for bounds in (
            {"x": 2, "y": 0, "width": 100, "height": 200},    # starts right of 0
            {"x": 0, "y": 1, "width": 100, "height": 200},    # starts below 0
            {"x": 0, "y": 0, "width": 99, "height": 200},     # too narrow
            {"x": -10, "y": 0, "width": 100, "height": 200},  # ends left of frame edge
        ):
            with self.subTest(bounds=bounds):
                self.assertIsNone(parse_document(_make_doc(bounds=bounds)))

    def test_bounds_equal_or_larger_than_frame_ok(self):
        self.assertIsNotNone(parse_document(_make_doc(bounds={"x": 0, "y": 0, "width": 100, "height": 200})))
        self.assertIsNotNone(parse_document(_make_doc(bounds={"x": -10, "y": -5, "width": 110, "height": 205})))

    def test_malformed_bounds_still_repairs(self):
        for bounds in ("x", {"x": 0}, {"x": 0, "y": 0, "width": 1.5, "height": 200}):
            with self.subTest(bounds=bounds):
                self.assertEqual(parse_document(_make_doc(bounds=bounds)).bounds, Bounds(0, 0, 100, 200))

    def test_layers_not_a_list_returns_none(self):
        for layers in ("x", {}, None, 3):
            with self.subTest(layers=layers):
                self.assertIsNone(parse_document(_make_doc(layers=layers)))

    def test_missing_layers_is_empty(self):
        d = json.loads(_make_doc())
        del d["layers"]
        self.assertEqual(parse_document(json.dumps(d)).layers, [])


if __name__ == "__main__":
    unittest.main()
