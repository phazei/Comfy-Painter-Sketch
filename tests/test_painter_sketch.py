"""
tests/test_painter_sketch.py -- Unit tests for the PainterSketch node's execute().

Needs ComfyUI on ``sys.path`` (``comfy_api``, ``folder_paths``). Layer file
loading is replaced with an in-memory tensor so no files are involved.

Covers:
  - no image connected: the output is always ``width`` x ``height`` (the
    widgets are the current image) and the document frame is mapped onto it
    with the decision-4 frame-mismatch transform
  - no image, no document: plain background of ``width`` x ``height``
  - fingerprint_inputs ignores ``width``/``height`` while ``image`` is linked
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

from nodes import painter_sketch, previews  # noqa: E402
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



class TestBackgroundHidden(unittest.TestCase):
    """``backgroundVisible: false`` swaps the input image for the fill colour."""

    def test_outputs_use_fill_colour_and_keep_batch(self) -> None:
        manifest = json.loads(_manifest(8, 4))
        manifest["backgroundVisible"] = False
        manifest["regions"] = [{
            "id": "r1", "slot": 1, "name": "", "visible": True,
            "rect": {"x": 0, "y": 0, "width": 4, "height": 4},
        }]
        layer = torch.zeros(4, 8, 4)
        layer[:, :2, 0] = 1.0
        layer[:, :2, 3] = 1.0
        image = torch.full((2, 4, 8, 3), 0.5)
        with mock.patch.object(painter_sketch, "load_layer_rgba", return_value=layer):
            out = PainterSketch.execute(
                image=image, document=json.dumps(manifest), width=8, height=4, background="#000000",
            )
        main = out.result[0]
        self.assertEqual(tuple(main.shape), (2, 4, 8, 3))
        self.assertTrue(torch.allclose(main[1, 0, 0], torch.tensor([1.0, 0.0, 0.0])))
        self.assertEqual(float(main[:, :, 2:].max()), 0.0)
        region = out.result[2].get(1)
        self.assertIsNotNone(region)
        self.assertEqual(float(region.image[:, :, 2:].max()), 0.0)

    def test_main_and_off_image_region_never_show_input(self) -> None:
        manifest = json.loads(_manifest(8, 4))
        manifest["backgroundVisible"] = False
        manifest["regions"] = [{
            "id": "r1", "slot": 1, "name": "", "visible": True,
            "rect": {"x": 6, "y": -1, "width": 4, "height": 6},
        }]
        layer = torch.zeros(4, 8, 4)
        with mock.patch.object(painter_sketch, "load_layer_rgba", return_value=layer):
            out = PainterSketch.execute(
                image=torch.full((1, 4, 8, 3), 0.5), document=json.dumps(manifest),
                width=8, height=4, background="#336699",
            )
        fill = torch.tensor([0x33, 0x66, 0x99]) / 255
        self.assertTrue(torch.allclose(out.result[0], fill.expand(1, 4, 8, 3)))
        region = out.result[2].get(1)
        self.assertIsNotNone(region)
        self.assertEqual(tuple(region.image.shape), (1, 6, 4, 3))
        self.assertTrue(torch.allclose(region.image, fill.expand(1, 6, 4, 3)))

    def test_visible_background_keeps_image(self) -> None:
        layer = torch.zeros(4, 8, 4)
        with mock.patch.object(painter_sketch, "load_layer_rgba", return_value=layer):
            out = PainterSketch.execute(
                image=torch.full((1, 4, 8, 3), 0.5), document=_manifest(8, 4),
                width=8, height=4, background="#000000",
            )
        self.assertTrue(torch.allclose(out.result[0], torch.full((1, 4, 8, 3), 0.5)))


class _FakePreview:
    """Stand-in for ``UI.PreviewImage``: records the saved tensor shape, no files."""

    def __init__(self, image: torch.Tensor, cls: type | None = None) -> None:
        self.shape = tuple(image.shape)

    def as_dict(self) -> dict:
        return {"images": [{"shape": self.shape}], "animated": (False,)}


class TestLayerSourcePreview(unittest.TestCase):
    """``layer_source`` adds a separate UI preview and never touches outputs."""

    def _run(self, layer_source: torch.Tensor | None):
        image = torch.full((1, 4, 8, 3), 0.5)
        with mock.patch.object(previews.UI, "PreviewImage", _FakePreview):
            return PainterSketch.execute(
                image=image, document="", width=8, height=4, layer_source=layer_source,
            )

    def test_absent_has_no_key(self) -> None:
        ui = self._run(None).ui.as_dict()
        self.assertNotIn(painter_sketch.LAYER_SOURCE_UI_KEY, ui)
        self.assertEqual(ui["images"], [{"shape": (1, 4, 8, 3)}])

    def test_first_frame_under_own_key(self) -> None:
        source = torch.rand(3, 16, 32, 4)
        out = self._run(source)
        self.assertEqual(out.ui["images"], [{"shape": (1, 4, 8, 3)}])
        items = out.ui[painter_sketch.LAYER_SOURCE_UI_KEY]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["shape"], (1, 16, 32, 4))
        self.assertIsInstance(items[0]["source_id"], str)

    def test_source_id_is_content_based(self) -> None:
        a = torch.rand(1, 300, 200, 3)
        id_a = self._run(a).ui[painter_sketch.LAYER_SOURCE_UI_KEY][0]["source_id"]
        again = self._run(a.clone()).ui[painter_sketch.LAYER_SOURCE_UI_KEY][0]["source_id"]
        other = self._run(torch.rand(1, 300, 200, 3)).ui[painter_sketch.LAYER_SOURCE_UI_KEY][0]["source_id"]
        self.assertEqual(id_a, again)
        self.assertNotEqual(id_a, other)

    def test_outputs_unaffected(self) -> None:
        plain = self._run(None)
        with_source = self._run(torch.rand(1, 16, 32, 3))
        self.assertTrue(torch.equal(plain.result[0], with_source.result[0]))
        self.assertTrue(torch.equal(plain.result[1], with_source.result[1]))

    def test_fingerprint_ignores_source(self) -> None:
        a = PainterSketch.fingerprint_inputs(document="", invert_mask=False, width=8, height=4)
        b = PainterSketch.fingerprint_inputs(
            document="", invert_mask=False, width=8, height=4, layer_source=torch.rand(1, 2, 2, 3))
        self.assertEqual(a, b)

    def test_schema_input_after_image(self) -> None:
        names = [i.id for i in PainterSketch.define_schema().inputs]
        self.assertEqual(names[:3], ["image", "mask", "layer_source"])


class TestFingerprintSize(unittest.TestCase):
    """width/height count only while ``image`` is not linked (ComfyUI passes a linked input as None)."""

    @staticmethod
    def _fp(width: int, height: int, **kwargs) -> str:
        return PainterSketch.fingerprint_inputs(
            document="", invert_mask=False, width=width, height=height, **kwargs)

    def test_ignored_with_image(self) -> None:
        self.assertEqual(self._fp(512, 512, image=None), self._fp(1920, 1080, image=None))

    def test_used_without_image(self) -> None:
        self.assertNotEqual(self._fp(512, 512), self._fp(1920, 1080))

    def test_linking_image_changes_fingerprint(self) -> None:
        self.assertNotEqual(self._fp(512, 512), self._fp(512, 512, image=None))


class TestFingerprintUnsafeFiles(unittest.TestCase):
    """Unsafe file values hash as missing and never touch the filesystem."""

    @staticmethod
    def _doc(file_val: str) -> str:
        doc = json.loads(_manifest(8, 4))
        doc["layers"][0]["file"] = file_val
        return json.dumps(doc)

    def test_unsafe_names_skip_filesystem(self) -> None:
        fs = painter_sketch.folder_paths
        for bad in ("../secret.png [input]", "other/x.png [input]",
                    "painter-sketch/../../x.png [input]", "painter-sketch\\..\\x.png [input]",
                    "painter-sketch/a [b/../../x.png", "painter-sketch/x.png [output]",
                    "painter-sketch/x.png [temp]"):
            with self.subTest(file=bad), \
                    mock.patch.object(fs, "exists_annotated_filepath") as exists, \
                    mock.patch.object(fs, "get_annotated_filepath") as get, \
                    mock.patch.object(painter_sketch.os, "stat") as stat:
                PainterSketch.fingerprint_inputs(
                    document=self._doc(bad), invert_mask=False, width=8, height=4)
                exists.assert_not_called()
                get.assert_not_called()
                stat.assert_not_called()

    def test_safe_name_is_checked(self) -> None:
        fs = painter_sketch.folder_paths
        with mock.patch.object(fs, "exists_annotated_filepath", return_value=False) as exists:
            PainterSketch.fingerprint_inputs(
                document=_manifest(8, 4), invert_mask=False, width=8, height=4)
            exists.assert_called_once_with("painter-sketch/ps-test.png [input]")


if __name__ == "__main__":
    unittest.main()
