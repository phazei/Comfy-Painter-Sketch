"""
tests/test_layer_masks.py -- M14 layer masks on the Python side (nodes/layer_masks.py,
nodes/layers.py ``load_layer_mask``, node execute + fingerprint).

Needs ComfyUI on ``sys.path`` (``folder_paths``, ``comfy_api``).

Covers:
  - parsing (lenient fields; paint layers only; old documents unchanged)
  - apply (ComfyUI polarity, 1 = hidden): alpha x (1 - mask), invert,
    ``outside`` beyond a smaller stored file, ``file: null`` = all shown,
    disabled = ignored, unreadable = ignored
  - size / offset: the mask sits at the layer's top-left and follows the
    layer's placement (frame map) through the normal composite
  - masked layers never change the MASK output
  - fingerprint_inputs includes the mask file
"""

import json
import os
import sys
import tempfile
import unittest
from unittest import mock

import torch
from PIL import Image

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

import folder_paths  # noqa: E402

from nodes import painter_sketch  # noqa: E402
from nodes.document import parse_document  # noqa: E402
from nodes.layer_masks import LayerMask, apply_layer_masks, mask_plane, parse_layer_mask  # noqa: E402
from nodes.layers import load_layer_mask  # noqa: E402
from nodes.painter_sketch import PainterSketch  # noqa: E402

MASK_FILE = "painter-sketch/ps-m-01.png [input]"


def _manifest(w: int, h: int, layer_mask: dict | None, bounds: tuple[int, int, int, int] | None = None) -> str:
    """One paint layer (file ``ps-test``) + one mask layer; optional ``layerMask``."""
    bx, by, bw, bh = bounds or (0, 0, w, h)
    paint = {
        "id": "p1", "name": "Layer 1", "kind": "paint", "visible": True, "locked": False,
        "opacity": 1.0, "blendMode": "normal", "file": "painter-sketch/ps-test.png [input]",
    }
    if layer_mask is not None:
        paint["layerMask"] = layer_mask
    mask = {"id": "m1", "name": "Mask 1", "kind": "mask", "visible": True, "locked": False,
            "opacity": 0.5, "blendMode": "normal", "file": None}
    return json.dumps({
        "version": 1, "frame": {"width": w, "height": h},
        "bounds": {"x": bx, "y": by, "width": bw, "height": bh},
        "layers": [paint, mask], "activeLayerId": "p1", "regions": [],
    })


def _red(h: int, w: int) -> torch.Tensor:
    """Opaque red ``[h, w, 4]`` layer."""
    t = torch.zeros(h, w, 4)
    t[:, :, 0] = 1.0
    t[:, :, 3] = 1.0
    return t


class TestParse(unittest.TestCase):
    """parse_layer_mask and the document field."""

    def test_lenient_fields(self) -> None:
        self.assertEqual(parse_layer_mask({"file": MASK_FILE, "enabled": False, "invert": True, "outside": "hide"}),
                         LayerMask(MASK_FILE, False, True, "hide"))
        self.assertEqual(parse_layer_mask({"file": " ", "enabled": "yes", "invert": 1, "outside": "x"}),
                         LayerMask(None, True, False, "reveal"))
        self.assertIsNone(parse_layer_mask(None))
        self.assertIsNone(parse_layer_mask([1]))

    def test_paint_layers_only_and_old_documents(self) -> None:
        doc = parse_document(_manifest(4, 4, {"file": MASK_FILE, "enabled": True, "invert": False, "outside": "reveal"}))
        self.assertEqual(doc.layers[0].layer_mask.file, MASK_FILE)
        self.assertIsNone(doc.layers[1].layer_mask)
        old = parse_document(_manifest(4, 4, None))
        self.assertIsNone(old.layers[0].layer_mask)
        raw = json.loads(_manifest(4, 4, None))
        raw["layers"][1]["layerMask"] = {"file": MASK_FILE}
        self.assertIsNone(parse_document(json.dumps(raw)).layers[1].layer_mask)


class TestApply(unittest.TestCase):
    """mask_plane / apply_layer_masks (pure)."""

    def _apply(self, mask: LayerMask, stored: torch.Tensor | None, rgba: torch.Tensor) -> torch.Tensor:
        doc = parse_document(_manifest(rgba.shape[1], rgba.shape[0], {"file": mask.file, "enabled": mask.enabled,
                                                                        "invert": mask.invert, "outside": mask.outside}))
        out = apply_layer_masks(doc.layers, {"p1": rgba, "m1": None}, lambda _file: stored)
        return out["p1"]

    def test_white_hides_black_shows_and_invert(self) -> None:
        stored = torch.tensor([[1.0, 0.5], [0.0, 0.25]])
        out = self._apply(LayerMask(MASK_FILE, True, False, "reveal"), stored, _red(2, 2))
        self.assertTrue(torch.allclose(out[:, :, 3], 1.0 - stored))  # white (1) = hidden
        self.assertEqual(float(out[1, 0, 3]), 1.0)  # black (0) = shown
        self.assertTrue(torch.equal(out[:, :, 0], torch.ones(2, 2)))  # RGB untouched
        inv = self._apply(LayerMask(MASK_FILE, True, True, "reveal"), stored, _red(2, 2))
        self.assertTrue(torch.allclose(inv[:, :, 3], stored))

    def test_outside_beyond_a_smaller_stored_file(self) -> None:
        reveal = self._apply(LayerMask(MASK_FILE, True, False, "reveal"), torch.ones(1, 1), _red(2, 3))
        self.assertEqual(float(reveal[0, 0, 3]), 0.0)
        self.assertEqual(float(reveal[1, 2, 3]), 1.0)  # outside reveal = shown
        hide = self._apply(LayerMask(MASK_FILE, True, False, "hide"), torch.zeros(1, 1), _red(2, 3))
        self.assertEqual(float(hide[0, 0, 3]), 1.0)
        self.assertEqual(float(hide[1, 2, 3]), 0.0)  # outside hide = hidden
        # Invert applies to the outside value too.
        inv = self._apply(LayerMask(MASK_FILE, True, True, "hide"), torch.zeros(1, 1), _red(2, 3))
        self.assertEqual(float(inv[1, 2, 3]), 1.0)

    def test_no_file_shows_all_disabled_and_unreadable_are_ignored(self) -> None:
        for outside in ("reveal", "hide"):
            none = self._apply(LayerMask(None, True, False, outside), None, _red(2, 2))
            self.assertEqual(float(none[:, :, 3].min()), 1.0)
        off = self._apply(LayerMask(MASK_FILE, False, False, "reveal"), torch.ones(2, 2), _red(2, 2))
        self.assertEqual(float(off[:, :, 3].min()), 1.0)
        unreadable = self._apply(LayerMask(MASK_FILE, True, False, "hide"), None, _red(2, 2))
        self.assertEqual(float(unreadable[:, :, 3].min()), 1.0)

    def test_plane_crops_a_larger_file(self) -> None:
        plane = mask_plane(torch.full((5, 5), 0.5), 3, 2, "reveal")
        self.assertEqual(tuple(plane.shape), (2, 3))
        self.assertTrue(torch.allclose(plane, torch.full((2, 3), 0.5)))


class TestLoad(unittest.TestCase):
    """load_layer_mask with a real PNG (alpha plane, safety checks)."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._old = folder_paths.get_input_directory()
        folder_paths.set_input_directory(self._tmp.name)
        folder = os.path.join(self._tmp.name, "painter-sketch")
        os.makedirs(folder)
        img = Image.new("RGBA", (3, 2), (255, 255, 255, 0))
        img.putpixel((1, 0), (255, 255, 255, 128))
        img.save(os.path.join(folder, "ps-m-01.png"), "PNG")

    def tearDown(self) -> None:
        folder_paths.set_input_directory(self._old)
        self._tmp.cleanup()

    def test_alpha_plane_and_unsafe_paths(self) -> None:
        plane = load_layer_mask(MASK_FILE)
        self.assertEqual(tuple(plane.shape), (2, 3))
        self.assertAlmostEqual(float(plane[0, 1]), 128 / 255, places=6)
        self.assertIsNone(load_layer_mask("ps-m-01.png [input]"))
        with self.assertLogs("paintersketch.layers", level="WARNING"):
            self.assertIsNone(load_layer_mask("painter-sketch/missing.png [input]"))


class TestNode(unittest.TestCase):
    """execute() and fingerprint_inputs with a layer mask."""

    def _run(self, layer_mask: dict, stored: torch.Tensor, size: tuple[int, int], out: tuple[int, int],
             bounds: tuple[int, int, int, int] | None = None):
        bw, bh = (bounds[2], bounds[3]) if bounds else size
        def load(layer, _bounds):
            return _red(bh, bw) if layer.kind == "paint" else None

        with mock.patch.object(painter_sketch, "load_layer_rgba", side_effect=load), \
                mock.patch.object(painter_sketch, "load_layer_mask", return_value=stored):
            return PainterSketch.execute(document=_manifest(size[0], size[1], layer_mask, bounds),
                                         width=out[0], height=out[1], background="#ffffff")

    def test_masked_layer_follows_the_layer_placement_and_never_touches_mask(self) -> None:
        # Frame 4x2 mapped onto 8x4 (s = 2); the left half of the mask is white (hides).
        stored = torch.tensor([[1.0, 1.0, 0.0, 0.0], [1.0, 1.0, 0.0, 0.0]])
        rec = {"file": MASK_FILE, "enabled": True, "invert": False, "outside": "reveal"}
        result = self._run(rec, stored, (4, 2), (8, 4))
        image, mask = result.result[0], result.result[1]
        self.assertTrue(torch.allclose(image[0, 1, 1], torch.tensor([1.0, 1.0, 1.0])))  # hidden -> background
        self.assertTrue(torch.allclose(image[0, 1, 6], torch.tensor([1.0, 0.0, 0.0])))  # shown -> red
        self.assertEqual(float(mask.max()), 0.0)  # the empty mask layer stays empty

    def test_mask_offset_matches_negative_bounds(self) -> None:
        # Bounds start at x = -2 (the layer grew left): mask column 2 is frame x = 0.
        stored = torch.tensor([[1.0, 1.0, 0.0, 1.0, 1.0, 1.0]])
        rec = {"file": MASK_FILE, "enabled": True, "invert": False, "outside": "hide"}
        result = self._run(rec, stored, (4, 1), (4, 1), bounds=(-2, 0, 6, 1))
        image = result.result[0]
        self.assertTrue(torch.allclose(image[0, 0, 0], torch.tensor([1.0, 0.0, 0.0])))
        self.assertTrue(torch.allclose(image[0, 0, 1], torch.tensor([1.0, 1.0, 1.0])))

    def test_fingerprint_includes_the_mask_file(self) -> None:
        doc = _manifest(4, 4, {"file": MASK_FILE, "enabled": True, "invert": False, "outside": "reveal"})
        seen: list[str] = []

        def exists(file: str) -> bool:
            seen.append(file)
            return False

        with mock.patch.object(painter_sketch.folder_paths, "exists_annotated_filepath", side_effect=exists):
            a = PainterSketch.fingerprint_inputs(document=doc, invert_mask=False, width=4, height=4)
        self.assertIn(MASK_FILE, seen)
        other = doc.replace("ps-m-01", "ps-m-02")
        with mock.patch.object(painter_sketch.folder_paths, "exists_annotated_filepath", return_value=False):
            b = PainterSketch.fingerprint_inputs(document=other, invert_mask=False, width=4, height=4)
        self.assertNotEqual(a, b)


if __name__ == "__main__":
    unittest.main()
