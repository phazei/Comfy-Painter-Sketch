"""
tests/test_input_mask.py -- The ``mask`` input: prepare, combine, preview, fingerprint.

Needs ComfyUI on ``sys.path`` (``comfy_api``, ``folder_paths``). Preview
saving is replaced by fakes (no files); the Image Mask file load is patched.

Covers:
  - resize to the image size (ComfyUI's bilinear ``resize_mask``), 2D masks
  - batch mapping: mask n for image n when the counts match, else the first
  - LoadImage's 64x64 all-zero placeholder = no mask
  - combine: the row's subtract / eye from the manifest, defaults without a
    record, the record's file ignored while connected, no image -> unused
  - preview under its own ui key (first mask, content id; placeholder item)
  - a 4-channel IMAGE is used as RGB (3-channel outputs)
  - fingerprint: the linked mask marker, the Image Mask file no longer counts
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
from nodes.input_mask import is_placeholder, prepare_input_mask  # noqa: E402
from nodes.painter_sketch import PainterSketch  # noqa: E402
from nodes.previews import INPUT_MASK_UI_KEY  # noqa: E402

FILE = "painter-sketch/ps-test-00aa.png [input]"


def _manifest(image_mask: dict | None = None) -> str:
    """8x4 document with one empty paint layer, optionally an ``imageMask`` record."""
    doc = {
        "version": 1, "docId": "abcd1234",
        "frame": {"width": 8, "height": 4},
        "bounds": {"x": 0, "y": 0, "width": 8, "height": 4},
        "regions": [], "activeLayerId": "p1",
        "layers": [{"id": "p1", "name": "Layer 1", "kind": "paint", "visible": True, "locked": False,
                    "opacity": 1, "blendMode": "normal", "file": None}],
    }
    if image_mask is not None:
        doc["imageMask"] = {"file": FILE, "visible": True, "color": "#00ff00", "opacity": 0.5, "subtract": False,
                            "sourceKey": "mask:x", "width": 8, "height": 4, **image_mask}
    return json.dumps(doc)


class _FakePreview:
    """Stand-in for ``UI.PreviewImage`` / ``UI.PreviewMask``: records the tensor, no files."""

    last: torch.Tensor | None = None

    def __init__(self, image: torch.Tensor, cls: type | None = None) -> None:
        _FakePreview.last = image
        self.shape = tuple(image.shape)

    def as_dict(self) -> dict:
        return {"images": [{"filename": "t.png", "subfolder": "", "type": "temp", "shape": self.shape}]}


class _FakeMaskPreview(_FakePreview):
    """Separate class so the mask tensor is recorded apart from the image preview."""

    last: torch.Tensor | None = None

    def __init__(self, mask: torch.Tensor, cls: type | None = None) -> None:
        _FakeMaskPreview.last = mask
        self.shape = tuple(mask.shape)


def _run(mask: torch.Tensor | None, image: torch.Tensor | None = None, document: str = "", **kw):
    """Execute with fake previews; image defaults to one 8x4 black frame."""
    if image is None:
        image = torch.zeros(1, 4, 8, 3)
    with mock.patch.object(previews.UI, "PreviewImage", _FakePreview), \
            mock.patch.object(previews.UI, "PreviewMask", _FakeMaskPreview):
        return PainterSketch.execute(document=document, width=8, height=4, image=image, mask=mask, **kw)


class TestPrepare(unittest.TestCase):
    """prepare_input_mask: shape, size, batch, placeholder."""

    def test_2d_mask_is_one_frame(self) -> None:
        out = prepare_input_mask(torch.ones(4, 8), (8, 4), 3)
        self.assertEqual(tuple(out.shape), (1, 4, 8))

    def test_resized_to_the_image(self) -> None:
        mask = torch.zeros(1, 2, 4)
        mask[0, :, :2] = 1.0  # left half
        out = prepare_input_mask(mask, (8, 4), 1)
        self.assertEqual(tuple(out.shape), (1, 4, 8))
        self.assertEqual(float(out[0, 2, 0]), 1.0)
        self.assertEqual(float(out[0, 2, 7]), 0.0)
        # Bilinear, align_corners=False (ComfyUI's resize_mask).
        self.assertAlmostEqual(float(out[0, 2, 3]), 0.75, places=5)
        self.assertAlmostEqual(float(out[0, 2, 4]), 0.25, places=5)

    def test_batch_mapping(self) -> None:
        mask = torch.stack([torch.full((4, 8), v) for v in (0.25, 0.5, 0.75)])
        per_image = prepare_input_mask(mask, (8, 4), 3)
        self.assertEqual(tuple(per_image.shape), (3, 4, 8))
        self.assertEqual(float(per_image[2, 0, 0]), 0.75)
        first = prepare_input_mask(mask, (8, 4), 2)
        self.assertEqual(tuple(first.shape), (1, 4, 8))
        self.assertEqual(float(first[0, 0, 0]), 0.25)

    def test_placeholder_is_no_mask(self) -> None:
        self.assertTrue(is_placeholder(torch.zeros(1, 64, 64)))
        self.assertIsNone(prepare_input_mask(torch.zeros(1, 64, 64), (8, 4), 1))
        self.assertIsNone(prepare_input_mask(torch.zeros(64, 64), (8, 4), 1))
        # A 64x64 mask with content, or an all-zero mask of another size, is used.
        self.assertIsNotNone(prepare_input_mask(torch.ones(1, 64, 64), (8, 4), 1))
        self.assertIsNotNone(prepare_input_mask(torch.zeros(1, 4, 8), (8, 4), 1))


class TestExecute(unittest.TestCase):
    """The mask input in execute()."""

    def setUp(self) -> None:
        self.mask = torch.zeros(1, 4, 8)
        self.mask[0, 1, 1] = 1.0

    def test_defaults_without_a_record(self) -> None:
        out = _run(self.mask, document=_manifest())
        self.assertEqual(float(out.result[1][0, 1, 1]), 1.0)
        self.assertEqual(float(out.result[1][0, 0, 0]), 0.0)
        # No (valid) document at all: the Input Mask alone, node invert applied.
        out = _run(self.mask, invert_mask=True)
        self.assertEqual(float(out.result[1][0, 1, 1]), 0.0)
        self.assertEqual(float(out.result[1][0, 0, 0]), 1.0)

    def test_row_subtract_and_eye_apply(self) -> None:
        # Subtract row, no normal cmask: nothing to subtract from.
        out = _run(self.mask, document=_manifest({"subtract": True}))
        self.assertEqual(float(out.result[1].max()), 0.0)
        # With invert_mask: everything masked except the Input Mask's coverage.
        out = _run(self.mask, document=_manifest({"subtract": True}), invert_mask=True)
        self.assertEqual(float(out.result[1][0, 1, 1]), 0.0)
        self.assertEqual(float(out.result[1][0, 0, 0]), 1.0)
        out = _run(self.mask, document=_manifest({"visible": False}))
        self.assertEqual(float(out.result[1].max()), 0.0)

    def test_file_ignored_while_connected(self) -> None:
        with mock.patch.object(painter_sketch, "load_image_mask") as load:
            out = _run(self.mask, document=_manifest({}))
        load.assert_not_called()
        self.assertEqual(float(out.result[1][0, 1, 1]), 1.0)
        # Disconnected: the file is used again.
        with mock.patch.object(painter_sketch, "load_image_mask", return_value=torch.ones(4, 8)) as load:
            out = _run(None, document=_manifest({}))
        load.assert_called_once()
        self.assertEqual(float(out.result[1].min()), 1.0)

    def test_batch_per_image_and_first_for_all(self) -> None:
        masks = torch.zeros(2, 4, 8)
        masks[0, 0, 0] = 1.0
        masks[1, 3, 7] = 1.0
        out = _run(masks, image=torch.zeros(2, 4, 8, 3), document=_manifest())
        mask = out.result[1]
        self.assertEqual(tuple(mask.shape), (2, 4, 8))
        self.assertEqual([float(mask[0, 0, 0]), float(mask[0, 3, 7])], [1.0, 0.0])
        self.assertEqual([float(mask[1, 0, 0]), float(mask[1, 3, 7])], [0.0, 1.0])
        out = _run(masks, image=torch.zeros(3, 4, 8, 3), document=_manifest())
        mask = out.result[1]
        self.assertEqual(tuple(mask.shape), (3, 4, 8))
        self.assertEqual(float(mask[2, 0, 0]), 1.0)
        self.assertEqual(float(mask[2, 3, 7]), 0.0)

    def test_region_gets_the_per_image_mask(self) -> None:
        manifest = json.loads(_manifest())
        manifest["regions"] = [{"id": "r1", "slot": 1, "name": "", "visible": True,
                                "rect": {"x": -2, "y": 0, "width": 6, "height": 4}}]
        masks = torch.zeros(2, 4, 8)
        masks[1, 1, 1] = 1.0
        out = _run(masks, image=torch.zeros(2, 4, 8, 3), document=json.dumps(manifest))
        region = out.result[2].get(1)
        self.assertEqual(tuple(region.mask.shape), (2, 4, 6))
        self.assertEqual(float(region.mask[1, 1, 3]), 1.0)
        self.assertEqual(float(region.mask[0, 1, 3]), 0.0)

    def test_resized_mask_in_output(self) -> None:
        out = _run(torch.ones(2, 4), document=_manifest())
        self.assertEqual(tuple(out.result[1].shape), (1, 4, 8))
        self.assertEqual(float(out.result[1].min()), 1.0)

    def test_placeholder_and_no_image(self) -> None:
        out = _run(torch.zeros(1, 64, 64), document=_manifest({"subtract": True}))
        self.assertEqual(float(out.result[1].max()), 0.0)
        with mock.patch.object(previews.UI, "PreviewImage", _FakePreview):
            out = PainterSketch.execute(document=_manifest(), width=8, height=4, mask=self.mask)
        self.assertEqual(float(out.result[1].max()), 0.0)
        self.assertNotIn(INPUT_MASK_UI_KEY, out.ui.as_dict())

    def test_four_channel_image_is_rgb(self) -> None:
        image = torch.rand(2, 4, 8, 4)
        out = _run(None, image=image, document=_manifest())
        self.assertEqual(tuple(out.result[0].shape), (2, 4, 8, 3))
        self.assertTrue(torch.equal(out.result[0], image[..., :3]))
        self.assertEqual(tuple(_FakePreview.last.shape), (1, 4, 8, 3))
        plain = _run(None, image=image, document="")
        self.assertEqual(tuple(plain.result[0].shape), (2, 4, 8, 3))


class TestPreview(unittest.TestCase):
    """The mask preview under INPUT_MASK_UI_KEY."""

    def test_first_mask_resized_with_content_id(self) -> None:
        masks = torch.rand(3, 2, 4)
        out = _run(masks, image=torch.zeros(3, 4, 8, 3), document=_manifest())
        items = out.ui[INPUT_MASK_UI_KEY]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["shape"], (1, 4, 8))
        self.assertIsInstance(items[0]["mask_id"], str)
        self.assertEqual(out.ui["images"][0]["shape"], (1, 4, 8, 3))
        again = _run(masks.clone(), image=torch.zeros(3, 4, 8, 3), document=_manifest()).ui[INPUT_MASK_UI_KEY]
        self.assertEqual(again[0]["mask_id"], items[0]["mask_id"])
        other = _run(torch.rand(3, 2, 4), image=torch.zeros(3, 4, 8, 3), document=_manifest()).ui[INPUT_MASK_UI_KEY]
        self.assertNotEqual(other[0]["mask_id"], items[0]["mask_id"])

    def test_hidden_row_still_previews(self) -> None:
        out = _run(torch.ones(1, 4, 8), document=_manifest({"visible": False}))
        self.assertIn(INPUT_MASK_UI_KEY, out.ui)

    def test_placeholder_item_and_absent_key(self) -> None:
        out = _run(torch.zeros(1, 64, 64), document=_manifest())
        self.assertEqual(out.ui[INPUT_MASK_UI_KEY], [{"mask_id": "none", "empty": True}])
        self.assertNotIn(INPUT_MASK_UI_KEY, _run(None).ui.as_dict())


class TestSchemaAndFingerprint(unittest.TestCase):
    """Input order and caching."""

    def test_mask_is_second(self) -> None:
        inputs = PainterSketch.define_schema().inputs
        self.assertEqual([i.id for i in inputs[:3]], ["image", "mask", "layer_source"])
        self.assertEqual(inputs[1].get_io_type(), "MASK")

    def test_fingerprint(self) -> None:
        document = _manifest({})

        def fp(**kw) -> str:
            return PainterSketch.fingerprint_inputs(document=document, invert_mask=False, width=8, height=4, image=None, **kw)

        self.assertEqual(fp(mask=None), fp(mask=None))
        self.assertNotEqual(fp(mask=None), fp())
        with mock.patch.object(painter_sketch.folder_paths, "exists_annotated_filepath", return_value=False) as exists:
            fp(mask=None)
        exists.assert_not_called()


if __name__ == "__main__":
    unittest.main()
