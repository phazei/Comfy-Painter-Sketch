"""
tests/test_painter_sketch.py -- Unit tests for the PainterSketch node's execute().

Needs ComfyUI on ``sys.path`` (``comfy_api``, ``folder_paths``). Layer file
loading is replaced with an in-memory tensor so no files are involved.

Covers:
  - no image connected: the output is always ``width`` x ``height`` (the
    widgets are the current image) and the document frame is mapped onto it
    with the decision-4 frame-mismatch transform
  - no image, no document: plain background of ``width`` x ``height``
"""

import json
import os
import sys
import unittest
from unittest import mock

import torch

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from nodes import painter_sketch  # noqa: E402
from nodes.painter_sketch import PainterSketch  # noqa: E402


def _manifest(fw: int, fh: int) -> str:
    """One paint layer with a file reference, frame/bounds ``fw`` x ``fh``."""
    return json.dumps({
        "version": 1,
        "frame": {"width": fw, "height": fh},
        "bounds": {"x": 0, "y": 0, "width": fw, "height": fh},
        "layers": [{
            "id": "p1", "name": "Layer 1", "kind": "paint", "visible": True,
            "locked": False, "opacity": 1.0, "blendMode": "normal",
            "file": "painter-sketch/ps-test.png [input]",
        }],
        "activeLayerId": "p1",
        "regions": [],
    })


class TestExecuteWithoutImage(unittest.TestCase):
    """execute() with ``image=None``."""

    def test_widgets_are_the_image_and_frame_maps_onto_them(self) -> None:
        # Frame 200x100; opaque red in the top-left 50x25 block.
        layer = torch.zeros(100, 200, 4)
        layer[:25, :50, 0] = 1.0
        layer[:25, :50, 3] = 1.0
        with mock.patch.object(painter_sketch, "load_layer_rgba", return_value=layer):
            out = PainterSketch.execute(
                document=_manifest(200, 100), width=400, height=200, background="#ffffff",
            )
        image = out.result[0]
        self.assertEqual(tuple(image.shape), (1, 200, 400, 3))
        # s = min(400/200, 200/100) = 2: the red block now covers 100x50.
        self.assertTrue(torch.allclose(image[0, 40, 90], torch.tensor([1.0, 0.0, 0.0])))
        self.assertTrue(torch.allclose(image[0, 60, 110], torch.tensor([1.0, 1.0, 1.0])))
        self.assertEqual(tuple(out.result[1].shape), (1, 200, 400))

    def test_no_document_is_plain_background(self) -> None:
        out = PainterSketch.execute(document="", width=64, height=128, background="#000000")
        image = out.result[0]
        self.assertEqual(tuple(image.shape), (1, 128, 64, 3))
        self.assertEqual(float(image.max()), 0.0)


if __name__ == "__main__":
    unittest.main()
