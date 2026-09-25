"""
tests/test_layers.py -- Unit tests for nodes/layers.py file loading.

Needs ComfyUI on ``sys.path`` (``folder_paths``, ``node_helpers``). Points
ComfyUI's input directory at a temp folder for the duration of each test.

Covers:
  - lossless WebP with alpha and legacy PNG load to identical straight RGBA
  - unsafe paths (outside ``painter-sketch/``, ``..``) are rejected
"""

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

from nodes.document import Bounds, Layer  # noqa: E402
from nodes.layers import load_layer_rgba  # noqa: E402


def _layer(file: str) -> Layer:
    """Paint layer referencing ``file``."""
    return Layer(id="l1", kind="paint", visible=True, opacity=1.0, file=file, invert=False)


class TestLoadLayerRgba(unittest.TestCase):
    """load_layer_rgba with real files in a temporary input folder."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._old_input = folder_paths.get_input_directory()
        folder_paths.set_input_directory(self._tmp.name)
        os.makedirs(os.path.join(self._tmp.name, "painter-sketch"))
        img = Image.new("RGBA", (4, 3), (0, 0, 0, 0))
        img.putpixel((1, 1), (200, 100, 50, 128))
        img.putpixel((3, 2), (1, 2, 3, 255))
        self._img = img
        folder = os.path.join(self._tmp.name, "painter-sketch")
        img.save(os.path.join(folder, "ps-a.webp"), "WEBP", lossless=True)
        img.save(os.path.join(folder, "ps-a.png"), "PNG")
        self._bounds = Bounds(x=0, y=0, width=4, height=3)

    def tearDown(self) -> None:
        folder_paths.set_input_directory(self._old_input)
        self._tmp.cleanup()

    def test_webp_and_png_load_identically(self) -> None:
        webp = load_layer_rgba(_layer("painter-sketch/ps-a.webp [input]"), self._bounds)
        png = load_layer_rgba(_layer("painter-sketch/ps-a.png [input]"), self._bounds)
        self.assertIsNotNone(webp)
        self.assertIsNotNone(png)
        self.assertEqual(tuple(webp.shape), (3, 4, 4))
        self.assertTrue(torch.equal(webp, png))
        self.assertAlmostEqual(float(webp[1, 1, 3]), 128 / 255, places=6)
        self.assertAlmostEqual(float(webp[1, 1, 0]), 200 / 255, places=6)

    def test_unsafe_paths_rejected(self) -> None:
        self.assertIsNone(load_layer_rgba(_layer("ps-a.webp [input]"), self._bounds))
        self.assertIsNone(load_layer_rgba(_layer("painter-sketch/../ps-a.webp [input]"), self._bounds))

    def test_missing_file_is_empty(self) -> None:
        self.assertIsNone(load_layer_rgba(_layer("painter-sketch/nope.webp [input]"), self._bounds))


if __name__ == "__main__":
    unittest.main()
