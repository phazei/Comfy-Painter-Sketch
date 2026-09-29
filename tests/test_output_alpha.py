"""Tests for the M13c per-output Alpha option: RGBA IMAGE, alpha = 1 - that output's final MASK."""

import json
import unittest
from unittest import mock

import torch

from nodes import painter_sketch
from nodes.document_regions import OutputOptions, parse_output_options
from nodes.output_processing import apply_output_options, with_alpha
from nodes.painter_sketch import PainterSketch
from nodes.painter_sketch_regions import PainterSketchRegions


def _manifest(**overrides) -> str:
    """Minimal valid 8x6 v1 manifest JSON."""
    data = {"version": 1, "frame": {"width": 8, "height": 6}, "layers": []}
    data.update(overrides)
    return json.dumps(data)


def _region(slot: int, **overrides) -> dict:
    """A 4x4 region at (2, 1) in the given slot."""
    data = {"id": f"r{slot}", "slot": slot, "rect": {"x": 2, "y": 1, "width": 4, "height": 4}}
    data.update(overrides)
    return data


def _blob_mask(batch: int = 1) -> torch.Tensor:
    """``[B, 6, 8]`` mask with a soft 2x3 blob (rows 2-3, cols 3-5), different per frame."""
    mask = torch.zeros(batch, 6, 8)
    for index in range(batch):
        mask[index, 2:4, 3:6] = 0.5 + 0.25 * index
    return mask


class TestParse(unittest.TestCase):
    """``alpha`` is additive: only a literal ``true`` turns it on."""

    def test_only_true_counts(self) -> None:
        """Missing / non-boolean / false = off; old records keep their other fields."""
        self.assertTrue(parse_output_options({"alpha": True}).alpha)
        for value in (False, 1, "true", None):
            with self.subTest(value=value):
                self.assertFalse(parse_output_options({"alpha": value}).alpha)
        old = parse_output_options({"applyMask": "border", "borderSize": 8})
        self.assertEqual(old, OutputOptions(apply_mask="border", border_size=8))


class TestApplyAlpha(unittest.TestCase):
    """apply_output_options with ``alpha``: after Modify, from the returned MASK."""

    def setUp(self) -> None:
        """A random 1-frame image and a blob mask."""
        self.image = torch.rand(1, 6, 8, 3)
        self.mask = _blob_mask()

    def test_off_keeps_three_channels(self) -> None:
        """Alpha off: unchanged RGB for every mode."""
        for mode in ("none", "fill", "crop", "border"):
            with self.subTest(mode=mode):
                image, _ = apply_output_options(self.image, self.mask, OutputOptions(apply_mask=mode))
                self.assertEqual(image.shape[-1], 3)

    def test_none_alpha(self) -> None:
        """RGB unchanged, alpha = 1 - mask, MASK unchanged."""
        image, mask = apply_output_options(self.image, self.mask, OutputOptions(alpha=True))
        self.assertEqual(tuple(image.shape), (1, 6, 8, 4))
        torch.testing.assert_close(image[..., :3], self.image)
        torch.testing.assert_close(image[..., 3], 1 - self.mask)
        torch.testing.assert_close(mask, self.mask)

    def test_crop_alpha_shape(self) -> None:
        """Crop first (padding 1), then alpha from the cropped MASK."""
        image, mask = apply_output_options(
            self.image, self.mask, OutputOptions(apply_mask="crop", crop_padding=1, alpha=True))
        self.assertEqual(tuple(image.shape), (1, 4, 5, 4))
        self.assertEqual(tuple(mask.shape), (1, 4, 5))
        torch.testing.assert_close(image[..., :3], self.image[:, 1:5, 2:7])
        torch.testing.assert_close(image[..., 3], 1 - mask)

    def test_border_follows_border_mask(self) -> None:
        """Mask border on: border transparent; off: border opaque; inside = 1 - mask."""
        for border_mask, border_alpha in ((True, 0.0), (False, 1.0)):
            with self.subTest(border_mask=border_mask):
                options = OutputOptions(apply_mask="border", border_size=2, border_mask=border_mask, alpha=True)
                image, mask = apply_output_options(self.image, self.mask, options)
                self.assertEqual(tuple(image.shape), (1, 10, 12, 4))
                alpha = image[..., 3]
                torch.testing.assert_close(alpha, 1 - mask)
                self.assertTrue(torch.all(alpha[:, :2] == border_alpha))
                self.assertTrue(torch.all(alpha[:, :, -2:] == border_alpha))
                torch.testing.assert_close(alpha[:, 2:8, 2:10], 1 - self.mask)
                self.assertTrue(torch.all(image[:, 0, 0, :3] == 1.0))  # white border colour

    def test_fill_ignores_alpha(self) -> None:
        """Fill + alpha (a saved doc): same 3-channel result as Fill alone."""
        filled, _ = apply_output_options(self.image, self.mask, OutputOptions(apply_mask="fill"))
        both, mask = apply_output_options(self.image, self.mask, OutputOptions(apply_mask="fill", alpha=True))
        self.assertEqual(both.shape[-1], 3)
        torch.testing.assert_close(both, filled)
        torch.testing.assert_close(mask, self.mask)

    def test_batch(self) -> None:
        """Per-frame masks give per-frame alpha; a 1-frame mask broadcasts."""
        image = torch.rand(3, 6, 8, 3)
        mask = _blob_mask(3)
        for mode in ("none", "crop", "border"):
            with self.subTest(mode=mode):
                out, out_mask = apply_output_options(image, mask, OutputOptions(apply_mask=mode, alpha=True))
                self.assertEqual(out.shape[0], 3)
                self.assertEqual(out.shape[-1], 4)
                torch.testing.assert_close(out[..., 3], 1 - out_mask)
                self.assertFalse(torch.equal(out[0, ..., 3], out[1, ..., 3]))
        broadcast = with_alpha(image, _blob_mask(1))
        self.assertEqual(tuple(broadcast.shape), (3, 6, 8, 4))
        for index in range(3):
            torch.testing.assert_close(broadcast[index, ..., 3], 1 - _blob_mask(1)[0])


class TestNodeAlpha(unittest.TestCase):
    """Main and region outputs through PainterSketch and PainterSketch Regions."""

    def setUp(self) -> None:
        """Avoid writing preview files (image and Input Mask previews)."""
        patcher = mock.patch.object(painter_sketch, "ui_previews", return_value={})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _run(self, document: str, invert: bool = False, batch: int = 1) -> tuple:
        """Execute with an image batch and a per-frame Input Mask."""
        image = torch.rand(batch, 6, 8, 3)
        return PainterSketch.execute(document, 8, 6, "#ffffff", invert, image, _blob_mask(batch)).result, image

    def test_main_alpha_uses_final_mask(self) -> None:
        """Main: alpha = 1 - returned MASK, incl. invert_mask and the Input Mask; batch kept."""
        document = _manifest(mainOutput={"alpha": True})
        for invert in (False, True):
            with self.subTest(invert=invert):
                (image, mask, _), source = self._run(document, invert, batch=2)
                self.assertEqual(tuple(image.shape), (2, 6, 8, 4))
                torch.testing.assert_close(image[..., :3], source)
                blob = _blob_mask(2)
                torch.testing.assert_close(mask, 1 - blob if invert else blob)
                torch.testing.assert_close(image[..., 3], 1 - mask)

    def test_regions_independent_and_helper_follows(self) -> None:
        """Main off (RGB); region 2 alpha + crop; region 3 off; helper passes them through."""
        document = _manifest(regions=[
            _region(2, output={"applyMask": "crop", "alpha": True}),
            _region(3),
        ])
        (image, _, regions), _ = self._run(document)
        self.assertEqual(image.shape[-1], 3)
        second, third = regions.get(2), regions.get(3)
        self.assertEqual(tuple(second.image.shape), (1, 2, 3, 4))
        torch.testing.assert_close(second.image[..., 3], 1 - second.mask)
        self.assertEqual(tuple(third.image.shape), (1, 4, 4, 3))
        out = PainterSketchRegions.execute(regions).result
        self.assertIs(out[2], second.image)
        self.assertIs(out[4], third.image)

    def test_region_border_alpha(self) -> None:
        """A region's border alpha follows its Mask border setting."""
        document = _manifest(regions=[
            _region(1, output={"applyMask": "border", "borderSize": 1, "alpha": True}),
            _region(4, output={"applyMask": "border", "borderSize": 1, "borderMask": False, "alpha": True}),
        ])
        (_, _, regions), _ = self._run(document)
        self.assertEqual(tuple(regions.get(1).image.shape), (1, 6, 6, 4))
        self.assertEqual(float(regions.get(1).image[0, 0, 0, 3]), 0.0)
        self.assertEqual(float(regions.get(4).image[0, 0, 0, 3]), 1.0)

    def test_saved_fill_with_alpha_is_rgb(self) -> None:
        """Main and region Fill + alpha: alpha ignored."""
        document = _manifest(mainOutput={"applyMask": "fill", "alpha": True},
                             regions=[_region(1, output={"applyMask": "fill", "alpha": True})])
        (image, _, regions), _ = self._run(document)
        self.assertEqual(image.shape[-1], 3)
        self.assertEqual(regions.get(1).image.shape[-1], 3)

    def test_fallback_document_stays_rgb(self) -> None:
        """No readable document: no options, plain RGB passthrough."""
        with mock.patch.object(painter_sketch, "parse_document", return_value=None):
            (image, _, _), _ = self._run(_manifest(mainOutput={"alpha": True}))
        self.assertEqual(image.shape[-1], 3)


if __name__ == "__main__":
    unittest.main()
