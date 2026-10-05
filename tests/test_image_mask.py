"""
tests/test_image_mask.py -- Image Mask: manifest parse, file load, MASK combine.

Needs ComfyUI on ``sys.path`` (``folder_paths``, ``node_helpers``, ``comfy_api``).
Points ComfyUI's input directory at a temp folder for the file tests.

Covers:
  - ``imageMask`` is optional (old manifests unchanged) and parsed leniently
  - the file's alpha loads as coverage; a file sized differently from the
    input image is skipped with a log line (stale)
  - combine: union with mask layers, subtract row, node invert, regions
    (off-image viewport), hidden -> ignored, no image connected -> ignored
  - fingerprint_inputs changes with the Image Mask file
"""

import json
import os
import sys
import tempfile
import unittest

import torch
from PIL import Image

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

import folder_paths  # noqa: E402

from nodes.composite import IMAGE_MASK_KEY, combine_mask_layers  # noqa: E402
from nodes.document import Bounds, Frame, ImageMask, parse_document, parse_image_mask  # noqa: E402
from nodes.layers import load_image_mask  # noqa: E402
from nodes.painter_sketch import PainterSketch  # noqa: E402

FILE = "painter-sketch/ps-test-00aa.png [input]"


def _manifest(image_mask: dict | None = None, mask_subtract: bool = False) -> dict:
    """8x4 document with one empty paint layer and one empty mask layer."""
    doc = {
        "version": 1, "docId": "abcd1234",
        "frame": {"width": 8, "height": 4},
        "bounds": {"x": 0, "y": 0, "width": 8, "height": 4},
        "regions": [], "activeLayerId": "p1",
        "layers": [
            {"id": "p1", "name": "Layer 1", "kind": "paint", "visible": True, "locked": False,
             "opacity": 1, "blendMode": "normal", "file": None},
            {"id": "m1", "name": "Mask 1", "kind": "mask", "visible": True, "locked": False,
             "opacity": 0.5, "blendMode": "normal", "file": None, "subtract": mask_subtract},
        ],
    }
    if image_mask is not None:
        doc["imageMask"] = image_mask
    return doc


def _image_mask(**overrides) -> dict:
    """A saved ``imageMask`` record for an 8x4 image."""
    record = {"file": FILE, "visible": True, "color": "#00ff00", "opacity": 0.5, "subtract": False,
              "sourceKey": "filename=a.png&subfolder=&type=input", "width": 8, "height": 4}
    record.update(overrides)
    return record


class TestParse(unittest.TestCase):
    """``imageMask`` manifest field."""

    def test_old_manifest_has_none(self) -> None:
        doc = parse_document(json.dumps(_manifest()))
        self.assertIsNotNone(doc)
        self.assertIsNone(doc.image_mask)

    def test_round_trip_fields(self) -> None:
        doc = parse_document(json.dumps(_manifest(_image_mask(subtract=True, visible=False))))
        self.assertEqual(doc.image_mask, ImageMask(file=FILE, visible=False, subtract=True, width=8, height=4))

    def test_lenient_fields(self) -> None:
        mask = parse_image_mask(_image_mask(file="  ", visible="no", subtract=1))
        self.assertEqual(mask, ImageMask(file=None, visible=True, subtract=False, width=8, height=4))

    def test_malformed_dropped_without_losing_the_document(self) -> None:
        for bad in ("x", _image_mask(width=0), _image_mask(height=True), _image_mask(sourceKey=None)):
            with self.subTest(bad=bad), self.assertLogs("paintersketch.document", level="WARNING"):
                doc = parse_document(json.dumps(_manifest(bad)))
                self.assertIsNotNone(doc)
                self.assertIsNone(doc.image_mask)
                self.assertEqual(len(doc.layers), 2)


class TestLoad(unittest.TestCase):
    """load_image_mask with a real file."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._old_input = folder_paths.get_input_directory()
        folder_paths.set_input_directory(self._tmp.name)
        os.makedirs(os.path.join(self._tmp.name, "painter-sketch"))
        img = Image.new("RGBA", (8, 4), (255, 255, 255, 0))
        img.putpixel((1, 1), (255, 255, 255, 255))
        img.putpixel((2, 1), (255, 255, 255, 51))
        img.save(os.path.join(self._tmp.name, "painter-sketch", "ps-test-00aa.png"))

    def tearDown(self) -> None:
        folder_paths.set_input_directory(self._old_input)
        self._tmp.cleanup()

    def _mask(self, **kw) -> ImageMask:
        return ImageMask(**{"file": FILE, "visible": True, "subtract": False, "width": 8, "height": 4, **kw})

    def test_alpha_is_coverage(self) -> None:
        coverage = load_image_mask(self._mask(), (8, 4))
        self.assertEqual(tuple(coverage.shape), (4, 8))
        self.assertEqual(float(coverage[1, 1]), 1.0)
        self.assertAlmostEqual(float(coverage[1, 2]), 0.2, places=5)
        self.assertEqual(float(coverage[0, 0]), 0.0)

    def test_stale_size_skipped_with_log(self) -> None:
        with self.assertLogs("paintersketch.layers", level="INFO") as logs:
            self.assertIsNone(load_image_mask(self._mask(), (16, 8)))
        self.assertIn("stale", logs.output[0])

    def test_unsafe_and_missing(self) -> None:
        with self.assertLogs("paintersketch.layers", level="WARNING"):
            self.assertIsNone(load_image_mask(self._mask(file="../x.png [input]"), (8, 4)))
        with self.assertLogs("paintersketch.layers", level="WARNING"):
            self.assertIsNone(load_image_mask(self._mask(file="painter-sketch/ps-nope-1.png [input]"), (8, 4)))
        self.assertIsNone(load_image_mask(self._mask(file=None), (8, 4)))

    def test_fingerprint_follows_the_file(self) -> None:
        document = json.dumps(_manifest(_image_mask()))
        before = PainterSketch.fingerprint_inputs(document=document, invert_mask=False, width=8, height=4)
        path = os.path.join(self._tmp.name, "painter-sketch", "ps-test-00aa.png")
        os.remove(path)
        after = PainterSketch.fingerprint_inputs(document=document, invert_mask=False, width=8, height=4)
        self.assertNotEqual(before, after)

    def test_execute_combines_and_ignores_without_image(self) -> None:
        document = json.dumps(_manifest(_image_mask()))
        out = PainterSketch.execute(document=document, width=8, height=4, image=torch.zeros(2, 4, 8, 3))
        mask = out.result[1]
        self.assertEqual(tuple(mask.shape), (2, 4, 8))
        self.assertEqual(float(mask[1, 1, 1]), 1.0)
        self.assertEqual(float(mask[0, 0, 0]), 0.0)
        # No image: the widgets fill has no alpha, the Image Mask is not used.
        out = PainterSketch.execute(document=document, width=8, height=4)
        self.assertEqual(float(out.result[1].max()), 0.0)

    def test_execute_hidden_is_ignored(self) -> None:
        document = json.dumps(_manifest(_image_mask(visible=False)))
        out = PainterSketch.execute(document=document, width=8, height=4, image=torch.zeros(1, 4, 8, 3))
        self.assertEqual(float(out.result[1].max()), 0.0)

    def test_execute_region_off_image_uses_it(self) -> None:
        manifest = _manifest(_image_mask())
        manifest["regions"] = [{"id": "r1", "slot": 1, "name": "", "visible": True,
                                "rect": {"x": -2, "y": 0, "width": 6, "height": 4}}]
        out = PainterSketch.execute(document=json.dumps(manifest), width=8, height=4,
                                    image=torch.zeros(1, 4, 8, 3))
        region = out.result[2].get(1)
        self.assertEqual(tuple(region.mask.shape), (1, 4, 6))
        self.assertEqual(float(region.mask[0, 1, 3]), 1.0)  # image px (1, 1)
        self.assertEqual(float(region.mask[0, 1, 0]), 0.0)  # off-image


class TestCombine(unittest.TestCase):
    """combine_mask_layers with an Image Mask coverage plane."""

    def setUp(self) -> None:
        self.doc = parse_document(json.dumps(_manifest(_image_mask())))
        self.coverage = torch.zeros(4, 8)
        self.coverage[0, 0] = 1.0

    def _combine(self, subtract: bool, invert_mask: bool = False, **kw) -> torch.Tensor:
        return combine_mask_layers(
            self.doc.layers, {}, Bounds(0, 0, 8, 4), Frame(8, 4), 8, 4, invert_mask,
            image_mask=(self.coverage, subtract), **kw,
        )

    def test_union_with_mask_layers(self) -> None:
        layer = torch.zeros(4, 8, 4)
        layer[3, 7, 3] = 1.0
        out = combine_mask_layers(
            self.doc.layers, {"m1": layer}, Bounds(0, 0, 8, 4), Frame(8, 4), 8, 4, False,
            image_mask=(self.coverage, False),
        )
        self.assertEqual(float(out[0, 0]), 1.0)
        self.assertEqual(float(out[3, 7]), 1.0)
        self.assertEqual(float(out[2, 2]), 0.0)

    def test_node_invert(self) -> None:
        node = self._combine(False, invert_mask=True)
        self.assertEqual(float(node[0, 0]), 0.0)
        self.assertEqual(float(node[2, 2]), 1.0)

    def test_subtract_row_subtracts(self) -> None:
        """The row in subtract mode removes its coverage from the other cmasks."""
        full = torch.ones(4, 8, 4)
        out = combine_mask_layers(
            self.doc.layers, {"m1": full}, Bounds(0, 0, 8, 4), Frame(8, 4), 8, 4, False,
            image_mask=(self.coverage, True),
        )
        self.assertEqual(float(out[0, 0]), 0.0)
        self.assertEqual(float(out[2, 2]), 1.0)
        # Only the (empty) normal mask layer: nothing to subtract from.
        self.assertEqual(float(self._combine(True).max()), 0.0)
        # invert_mask: everything masked except the subtracted coverage.
        node = self._combine(True, invert_mask=True)
        self.assertEqual(float(node[0, 0]), 0.0)
        self.assertEqual(float(node[2, 2]), 1.0)

    def test_viewport_outside_image_is_zero(self) -> None:
        out = self._combine(False, image_size=(8, 4), origin=(-1, 0))
        self.assertEqual(float(out[0, 1]), 1.0)
        self.assertEqual(float(out[0, 0]), 0.0)

    def test_viewport_subtract_has_no_effect_outside_image(self) -> None:
        """A subtract row is 0 off the image: invert_mask keeps the off-image px masked."""
        out = self._combine(True, invert_mask=True, image_size=(8, 4), origin=(-1, 0))
        self.assertEqual(float(out[0, 0]), 1.0)  # off-image
        self.assertEqual(float(out[0, 1]), 0.0)  # image px (0, 0), subtracted
        self.assertEqual(float(out[1, 1]), 1.0)

    def test_key_is_not_a_layer_id(self) -> None:
        self.assertNotIn(IMAGE_MASK_KEY, {layer.id for layer in self.doc.layers})


if __name__ == "__main__":
    unittest.main()
