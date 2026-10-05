"""Tests for nodes/output_processing.py: region geometry, off-image content, output options."""

import unittest

import torch

from nodes.document import Bounds, Document, Frame, Layer
from nodes.document_regions import OutputOptions, Region, RegionRect
from nodes.composite import run_composite
from nodes.output_processing import (
    EMPTY_REGIONS, PainterRegions, RegionOutput, apply_output_options,
    build_regions, region_edges, viewport_renderer,
)

RED = (1.0, 0.0, 0.0)


def _no_viewport(edges: tuple[int, int, int, int]) -> tuple[torch.Tensor, torch.Tensor]:
    """Renderer that must not be called (region lies inside the image)."""
    raise AssertionError(f"unexpected viewport render for {edges}")


class TestRegionGeometry(unittest.TestCase):
    """Edges: floor(v + 0.5), clamped to one image size beyond each edge, >= 1x1."""

    def test_rounding_clamping_and_minimum_size_fixtures(self) -> None:
        """Fixed rect -> edge fixtures (image 10 x 10 unless noted)."""
        fixtures = [
            ((0.5, 2.5, 2, 2), (10, 10), (1, 3, 3, 5)),
            ((2.5, 0, 1, 1), (10, 10), (3, 0, 4, 1)),         # half rounds up, not to even
            ((0.4, 0.4, 1.2, 1.2), (10, 10), (0, 0, 2, 2)),
            ((2.49, 1.49, 0.02, 0.02), (10, 10), (2, 1, 3, 2)),  # min 1x1
            ((-0.5, -1.5, 3, 4), (10, 10), (0, -1, 3, 3)),
            ((-5, -5, 30, 30), (10, 10), (-5, -5, 20, 20)),
            ((-30, -30, 100, 100), (10, 10), (-10, -10, 20, 20)),
            ((-100, -100, 1, 1), (10, 10), (-10, -10, -9, -9)),
            ((100, 100, 1, 1), (10, 10), (19, 19, 20, 20)),
            ((1e308, 1e308, 1, 1), (20, 20), (39, 39, 40, 40)),
            ((5, 5, 300, 2), (20, 8), (5, 5, 40, 7)),
        ]
        for rect, image, expected in fixtures:
            with self.subTest(rect=rect, image=image):
                self.assertEqual(region_edges(RegionRect(*rect), *image), expected)

    def test_no_rescale_when_image_differs_from_frame(self) -> None:
        """Regions stay in image px even if the frame (100x200) differs from the image."""
        image = torch.arange(12 * 20 * 3).reshape(1, 12, 20, 3).float()
        mask = torch.zeros(1, 12, 20)
        doc = Document(Frame(100, 200), Bounds(0, 0, 100, 200),
                       regions=[Region("r", 5, RegionRect(2, 1, 3, 2))])
        regions = build_regions(image, mask, doc, _no_viewport)
        torch.testing.assert_close(regions.get(5).image, image[:, 1:3, 2:5])
        self.assertEqual(tuple(regions.get(5).mask.shape), (1, 2, 3))


class TestRegionsValue(unittest.TestCase):
    """The PS_REGIONS value: six slots, None for empty ones."""

    def test_slots_and_get(self) -> None:
        """Filled slots carry tensors; empty and out-of-range slots return None."""
        image, mask = torch.ones(2, 6, 8, 3), torch.zeros(2, 6, 8)
        doc = Document(Frame(8, 6), Bounds(0, 0, 8, 6), regions=[
            Region("a", 2, RegionRect(0, 0, 4, 4)), Region("b", 6, RegionRect(4, 2, 4, 4)),
        ])
        regions = build_regions(image, mask, doc, _no_viewport)
        self.assertIsInstance(regions, PainterRegions)
        self.assertEqual(len(regions.slots), 6)
        self.assertEqual([regions.get(n) is None for n in range(1, 7)],
                         [True, False, True, True, True, False])
        self.assertIsInstance(regions.get(2), RegionOutput)
        self.assertEqual(tuple(regions.get(6).image.shape), (2, 4, 4, 3))
        self.assertIsNone(regions.get(0))
        self.assertIsNone(regions.get(7))
        self.assertIs(build_regions(image, mask, None, _no_viewport), EMPTY_REGIONS)


class TestOffImageRegions(unittest.TestCase):
    """Outside the image: background colour + off-frame paint + off-frame mask."""

    def setUp(self) -> None:
        """4x4 black image; paint and mask layers extending 4 px past every edge."""
        self.base = torch.zeros(2, 4, 4, 3)
        bounds = Bounds(-4, -4, 12, 12)
        paint = torch.zeros(12, 12, 4)
        paint[5, 2] = torch.tensor([0.0, 1.0, 0.0, 1.0])   # frame (-2, 1): left of image
        paint[5, 5] = torch.tensor([0.0, 0.0, 1.0, 1.0])   # frame (1, 1): inside
        mask = torch.zeros(12, 12, 4)
        mask[5, 9, 3] = 1.0                                 # frame (5, 1): right of image
        self.tensors = {"p": paint, "m": mask}
        self.doc = Document(Frame(4, 4), bounds, layers=[
            Layer("p", "paint", True, 1.0, "p.png"),
            Layer("m", "mask", True, 1.0, "m.png"),
        ], regions=[Region("wide", 1, RegionRect(-3, 0, 10, 3))])

    def _render(self, invert: bool) -> tuple[torch.Tensor, torch.Tensor, RegionOutput]:
        image, mask = run_composite(self.base, self.doc, self.tensors, invert)
        render = viewport_renderer(self.base, self.doc, self.tensors, invert, RED)
        return image, mask, build_regions(image, mask, self.doc, render).get(1)

    def test_background_paint_and_mask_outside_image(self) -> None:
        """Edges (-3, 0, 7, 3): columns 0-2 and 7-9 lie outside the 4 px image."""
        image, mask, region = self._render(False)
        self.assertEqual(tuple(region.image.shape), (2, 3, 10, 3))
        torch.testing.assert_close(region.image[:, 1, 1], torch.tensor([[0., 1., 0.]] * 2))
        torch.testing.assert_close(region.image[:, 0, 0], torch.tensor([[1., 0., 0.]] * 2))
        torch.testing.assert_close(region.image[:, 2, 9], torch.tensor([[1., 0., 0.]] * 2))
        torch.testing.assert_close(region.image[:, :, 3:7], image[:, 0:3, 0:4])
        expected_mask = torch.zeros(2, 3, 10)
        expected_mask[:, 1, 8] = 1.0
        torch.testing.assert_close(region.mask, expected_mask)

    def test_inverted_mask_outside_image(self) -> None:
        """invert_mask applies to the off-image part too."""
        _, mask, region = self._render(True)
        self.assertEqual(float(region.mask[0, 1, 8]), 0.0)
        self.assertEqual(float(region.mask[0, 0, 0]), 1.0)
        torch.testing.assert_close(region.mask[:, :, 3:7], mask[:, 0:3, 0:4])

    def test_subtract_mask_off_image(self) -> None:
        """A subtract cmask is 0 outside its paint: under invert_mask the off-image
        area stays masked except where the subtract layer itself has paint."""
        sub = torch.zeros(12, 12, 4)
        sub[4, 1, 3] = 1.0                                  # frame (-3, 0): left of image
        sub[5, 5, 3] = 1.0                                  # frame (1, 1): inside
        self.tensors["s"] = sub
        self.doc.layers.append(Layer("s", "mask", True, 1.0, "s.png", subtract=True))
        _, mask, region = self._render(True)
        expected = torch.ones(2, 3, 10)
        expected[:, 1, 8] = 0.0                             # normal cmask, inverted
        expected[:, 0, 0] = 0.0                             # subtracted off-image
        expected[:, 1, 4] = 0.0                             # subtracted inside
        torch.testing.assert_close(region.mask, expected)
        torch.testing.assert_close(region.mask[:, :, 3:7], mask[:, 0:3, 0:4])

    def test_region_fully_outside_image(self) -> None:
        """A region right of the image is pure background plus the mask there."""
        doc = Document(self.doc.frame, self.doc.bounds, self.doc.layers,
                       regions=[Region("out", 3, RegionRect(5, 0, 2, 2))])
        image, mask = run_composite(self.base, doc, self.tensors, False)
        render = viewport_renderer(self.base, doc, self.tensors, False, RED)
        region = build_regions(image, mask, doc, render).get(3)
        self.assertTrue(torch.all(region.image == torch.tensor(RED)))
        self.assertEqual(region.mask[0].tolist(), [[0.0, 0.0], [1.0, 0.0]])

    def test_viewport_matches_main_with_frame_mismatch(self) -> None:
        """Scaled layers (image 6x6 vs frame 4x4) land on the same pixels in a viewport."""
        base = torch.rand(1, 6, 6, 3)
        paint = torch.rand(12, 12, 4)
        doc = Document(Frame(4, 4), Bounds(-4, -4, 12, 12),
                       layers=[Layer("p", "paint", True, 0.7, "p.png")])
        image, _ = run_composite(base, doc, {"p": paint}, False)
        render = viewport_renderer(base, doc, {"p": paint}, False, RED)
        view, _, straight = render((-2, -1, 5, 4))
        self.assertIsNone(straight)
        torch.testing.assert_close(view[:, 1:, 2:], image[:, 0:4, 0:5])


class TestOutputProcessing(unittest.TestCase):
    """Fill/crop use final soft coverage and never modify their source tensors."""

    def test_soft_fill_and_batch_preservation(self) -> None:
        """Fill blends by soft mask, keeps the batch and returns MASK unchanged."""
        image = torch.tensor([[[[0.2, 0.4, 0.6]]], [[[0.8, 0.6, 0.4]]]]).expand(-1, 1, 3, -1)
        mask = torch.tensor([[[0.0, 0.25, 1.0]]]).expand(2, -1, -1)
        original = image.clone()
        filled, result_mask = apply_output_options(image, mask, OutputOptions("fill", "#ff8000"))
        color = torch.tensor([1, 128 / 255, 0])
        torch.testing.assert_close(filled[:, :, 0], image[:, :, 0])
        torch.testing.assert_close(filled[:, :, 1], image[:, :, 1] * 0.75 + color * 0.25)
        torch.testing.assert_close(filled[:, :, 2], color.expand(2, 1, 3))
        torch.testing.assert_close(image, original)
        self.assertIs(result_mask, mask)
        self.assertEqual(tuple(filled.shape), (2, 1, 3, 3))

    def test_crop_padding_edges_empty_and_tiny_positive_values(self) -> None:
        """Crop = mask > 0 bbox + padding, clamped; empty mask = uncropped."""
        image = torch.arange(2 * 6 * 8 * 3).reshape(2, 6, 8, 3).float()
        fixtures = [
            ((2, 3), 0, (2, 3, 3, 4)), ((2, 3), 1, (1, 2, 4, 5)),
            ((0, 0), 2, (0, 0, 3, 3)), ((5, 7), 2, (3, 5, 6, 8)),
            ((2, 3), 100, (0, 0, 6, 8)),
        ]
        for (y, x), padding, (top, left, bottom, right) in fixtures:
            with self.subTest(y=y, x=x, padding=padding):
                mask = torch.zeros(2, 6, 8)
                mask[:, y, x] = 1e-9
                cropped, cropped_mask = apply_output_options(
                    image, mask, OutputOptions("crop", crop_padding=padding))
                torch.testing.assert_close(cropped, image[:, top:bottom, left:right])
                torch.testing.assert_close(cropped_mask, mask[:, top:bottom, left:right])
        empty = torch.zeros(2, 6, 8)
        cropped, cropped_mask = apply_output_options(image, empty, OutputOptions("crop"))
        self.assertIs(cropped, image)
        self.assertIs(cropped_mask, empty)

    def test_crop_retains_bbox_across_batch(self) -> None:
        """Crop uses the union bbox over the batch so the result stays rectangular."""
        image, mask = torch.zeros(2, 6, 8, 3), torch.zeros(2, 6, 8)
        mask[0, 1, 2], mask[1, 4, 6] = 0.1, 1
        cropped, cropped_mask = apply_output_options(image, mask, OutputOptions("crop"))
        self.assertEqual(tuple(cropped.shape), (2, 4, 5, 3))
        self.assertEqual(tuple(cropped_mask.shape), (2, 4, 5))

    def test_region_options_are_independent(self) -> None:
        """Each region applies its own options to the un-processed composite."""
        image, mask = torch.ones(2, 6, 8, 3), torch.zeros(2, 6, 8)
        mask[:, 2:4, 3:5] = 0.5
        rect = RegionRect(2, 1, 4, 4)
        doc = Document(Frame(8, 6), Bounds(0, 0, 8, 6),
                       main_output=OutputOptions("fill", "#ff0000"), regions=[
                           Region("none", 1, rect),
                           Region("fill", 3, rect, visible=False, output=OutputOptions("fill", "#0000ff")),
                           Region("crop", 6, rect, output=OutputOptions("crop")),
                       ])
        regions = build_regions(image, mask, doc, _no_viewport)
        torch.testing.assert_close(regions.get(1).image, image[:, 1:5, 2:6])
        torch.testing.assert_close(regions.get(3).image[:, 1, 1], torch.tensor([0.5, 0.5, 1]).expand(2, -1))
        torch.testing.assert_close(regions.get(6).image, image[:, 2:4, 3:5])
        torch.testing.assert_close(regions.get(6).mask, mask[:, 2:4, 3:5])
        self.assertTrue(torch.all(image == 1))



class TestAddBorder(unittest.TestCase):
    """Border pads IMAGE with the colour and MASK with 1/0 on all sides, after slicing."""

    def _check(self, image, mask, out, out_mask, size, color, fill) -> None:
        """Assert shape, untouched interior and border values."""
        batch, height, width = image.shape[:3]
        self.assertEqual(tuple(out.shape), (batch, height + 2 * size, width + 2 * size, 3))
        self.assertEqual(tuple(out_mask.shape), (batch, height + 2 * size, width + 2 * size))
        torch.testing.assert_close(out[:, size:size + height, size:size + width], image)
        torch.testing.assert_close(out_mask[:, size:size + height, size:size + width], mask)
        border = torch.ones(height + 2 * size, width + 2 * size, dtype=torch.bool)
        border[size:size + height, size:size + width] = False
        torch.testing.assert_close(out[:, border], torch.tensor(color).expand(batch, int(border.sum()), 3))
        self.assertTrue(torch.all(out_mask[:, border] == fill))

    def test_sizes_colours_mask_values_and_batch(self) -> None:
        """Several sizes/colours, borderMask on and off, batch of 2 kept."""
        image = torch.rand(2, 3, 5, 3)
        mask = torch.rand(2, 3, 5)
        fixtures = [
            (1, "#ffffff", True, (1.0, 1.0, 1.0), 1.0),
            (4, "#ff8000", False, (1.0, 128 / 255, 0.0), 0.0),
            (64, "#000000", True, (0.0, 0.0, 0.0), 1.0),
        ]
        for size, hex_color, on, rgb, fill in fixtures:
            with self.subTest(size=size, color=hex_color, mask=on):
                options = OutputOptions("border", border_size=size, border_color=hex_color, border_mask=on)
                out, out_mask = apply_output_options(image, mask, options)
                self._check(image, mask, out, out_mask, size, rgb, fill)

    def test_defaults_are_64_white_masked(self) -> None:
        """Default options: 64 px, white, border marked in the mask."""
        image, mask = torch.zeros(1, 2, 2, 3), torch.zeros(1, 2, 2)
        out, out_mask = apply_output_options(image, mask, OutputOptions("border"))
        self._check(image, mask, out, out_mask, 64, (1.0, 1.0, 1.0), 1.0)

    def test_main_and_region_after_slicing(self) -> None:
        """Main pads the full composite; a region pads its own slice independently."""
        image, mask = torch.rand(2, 6, 8, 3), torch.zeros(2, 6, 8)
        mask[:, 2:4, 3:5] = 0.5
        main = OutputOptions("border", border_size=2, border_color="#0000ff", border_mask=False)
        region = OutputOptions("border", border_size=3, border_color="#00ff00")
        doc = Document(Frame(8, 6), Bounds(0, 0, 8, 6), main_output=main,
                       regions=[Region("r", 2, RegionRect(2, 1, 4, 4), output=region)])
        out, out_mask = apply_output_options(image, mask, doc.main_output)
        self._check(image, mask, out, out_mask, 2, (0.0, 0.0, 1.0), 0.0)
        result = build_regions(image, mask, doc, _no_viewport).get(2)
        self._check(image[:, 1:5, 2:6], mask[:, 1:5, 2:6], result.image, result.mask, 3, (0.0, 1.0, 0.0), 1.0)


if __name__ == "__main__":
    unittest.main()
