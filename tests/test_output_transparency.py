"""
tests/test_output_transparency.py -- The composite's transparency joins the output masks.

Transparency in outputs (SPEC "Python execution"): with the
Background eye off, ``T = 1 - composite alpha`` joins the mask-layer union
AFTER ``invert_mask`` (max, never inverted), for Main and every region. Fill
fills holes, Crop includes them, Alpha makes them transparent with the
un-premultiplied layer colour (no background fringe). Plain IMAGE keeps the
background colour under holes. Background visible: nothing changes.

Needs ComfyUI on ``sys.path`` (``comfy_api``, ``folder_paths``); layer files
are replaced with in-memory tensors.
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
from nodes.composite import run_composite, run_transparent_composite  # noqa: E402
from nodes.document import parse_document  # noqa: E402
from nodes.painter_sketch import PainterSketch  # noqa: E402

BLUE = torch.tensor([0.0, 0.0, 1.0])     # background widget colour
RED = torch.tensor([1.0, 0.0, 0.0])
GREEN = torch.tensor([0.0, 1.0, 0.0])
YELLOW = torch.tensor([1.0, 1.0, 0.0])
# Expected T per column of the default paint layer: opaque red cols 0-3,
# half-transparent green col 4, nothing in cols 5-7.
T_COLS = torch.tensor([0.0, 0.0, 0.0, 0.0, 0.5, 1.0, 1.0, 1.0])


def _layer(kind: str, lid: str, **extra) -> dict:
    """A manifest layer record."""
    data = {"id": lid, "name": lid, "kind": kind, "visible": True, "locked": False,
            "opacity": 1.0, "blendMode": "normal", "file": f"painter-sketch/ps-{lid}.png [input]"}
    data.update(extra)
    return data


def _manifest(layers: list[dict] | None = None, background_visible: bool = False, **extra) -> str:
    """8x6 manifest (paint layer ``p`` + mask layer ``m`` by default), Background eye off."""
    data = {"version": 1, "frame": {"width": 8, "height": 6},
            "bounds": {"x": 0, "y": 0, "width": 8, "height": 6},
            "layers": layers if layers is not None else [_layer("paint", "p"), _layer("mask", "m")],
            "regions": []}
    if not background_visible:
        data["backgroundVisible"] = False
    data.update(extra)
    return json.dumps(data)


def _paint() -> torch.Tensor:
    """``[6, 8, 4]``: opaque red cols 0-3, green at alpha 0.5 in col 4, transparent cols 5-7."""
    t = torch.zeros(6, 8, 4)
    t[:, :4] = torch.tensor([1.0, 0.0, 0.0, 1.0])
    t[:, 4] = torch.tensor([0.0, 1.0, 0.0, 0.5])
    return t


def _mask_cols(cols: slice) -> torch.Tensor:
    """``[6, 8, 4]`` mask layer covering the given columns fully."""
    t = torch.zeros(6, 8, 4)
    t[:, cols, 3] = 1.0
    return t


class _NodeCase(unittest.TestCase):
    """Runs PainterSketch.execute with in-memory layer tensors (no preview files)."""

    def setUp(self) -> None:
        patcher = mock.patch.object(painter_sketch, "ui_previews", return_value={})
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_node(self, document: str, tensors: dict[str, torch.Tensor | None], invert: bool = False,
                 batch: int = 1, mask: torch.Tensor | None = None, stored_lmask: torch.Tensor | None = None):
        """Execute with a random input batch; returns ``(image, mask, regions, input)``."""
        image = torch.rand(batch, 6, 8, 3)
        with mock.patch.object(painter_sketch, "load_layer_rgba",
                               side_effect=lambda layer, _bounds: tensors.get(layer.id)), \
                mock.patch.object(painter_sketch, "load_layer_mask", return_value=stored_lmask):
            out = PainterSketch.execute(document, 8, 6, "#0000ff", invert, image, mask).result
        return (*out, image)


class TestMask(_NodeCase):
    """T joins MASK after invert_mask; Background visible is unchanged."""

    def test_holes_join_mask(self) -> None:
        """No mask paint: MASK = T (soft edge 0.5, holes 1)."""
        _, mask, _, _ = self.run_node(_manifest(), {"p": _paint(), "m": None})
        torch.testing.assert_close(mask, T_COLS.expand(1, 6, 8))

    def test_union_is_max_with_mask_layers(self) -> None:
        """A mask pixel over opaque paint stays 1; elsewhere T."""
        _, mask, _, _ = self.run_node(_manifest(), {"p": _paint(), "m": _mask_cols(slice(0, 1))})
        expected = T_COLS.clone()
        expected[0] = 1.0
        torch.testing.assert_close(mask, expected.expand(1, 6, 8))

    def test_invert_mask_does_not_flip_holes(self) -> None:
        """Mask cols 0-5 inverted -> 0 there; T still marks col 4 (0.5) and col 5 (1)."""
        _, mask, _, _ = self.run_node(_manifest(), {"p": _paint(), "m": _mask_cols(slice(0, 6))}, invert=True)
        expected = torch.tensor([0.0, 0.0, 0.0, 0.0, 0.5, 1.0, 1.0, 1.0])
        torch.testing.assert_close(mask, expected.expand(1, 6, 8))

    def test_background_visible_unchanged(self) -> None:
        """Eye on: MASK = mask layers only, IMAGE over the input, Alpha fully opaque."""
        document = _manifest(background_visible=True, mainOutput={"alpha": True})
        image, mask, _, source = self.run_node(document, {"p": _paint(), "m": None})
        self.assertEqual(float(mask.max()), 0.0)
        torch.testing.assert_close(image[..., 3], torch.ones(1, 6, 8))
        torch.testing.assert_close(image[..., 5:, :3], source[..., 5:, :])
        torch.testing.assert_close(image[0, :, 4, :3], (0.5 * GREEN + 0.5 * source[0, :, 4]))

    def test_plain_image_flattened_on_background(self) -> None:
        """Modify None, Alpha off: holes = background colour, soft edge blended with it."""
        image, _, _, _ = self.run_node(_manifest(), {"p": _paint(), "m": None})
        self.assertEqual(image.shape[-1], 3)
        torch.testing.assert_close(image[0, :, 6], BLUE.expand(6, 3))
        torch.testing.assert_close(image[0, :, 4], (0.5 * GREEN + 0.5 * BLUE).expand(6, 3))
        torch.testing.assert_close(image[0, :, 0], RED.expand(6, 3))

    def test_layer_mask_hidden_area_is_a_hole(self) -> None:
        """An opaque layer whose lmask hides cols 0-3: those become holes (eye off)."""
        full = torch.zeros(6, 8, 4)
        full[:] = torch.tensor([1.0, 0.0, 0.0, 1.0])
        stored = torch.zeros(6, 8)
        stored[:, :4] = 1.0
        lmask = {"file": "painter-sketch/ps-lm.png [input]", "enabled": True, "invert": False, "outside": "reveal"}
        document = _manifest([_layer("paint", "p", layerMask=lmask), _layer("mask", "m")])
        _, mask, _, _ = self.run_node(document, {"p": full, "m": None}, stored_lmask=stored)
        torch.testing.assert_close(mask[0, :, :4], torch.ones(6, 4))
        torch.testing.assert_close(mask[0, :, 4:], torch.zeros(6, 4))

    def test_batch_broadcast_with_per_frame_input_mask(self) -> None:
        """T is the same for every image; a per-frame Input Mask still unions per frame."""
        input_mask = torch.zeros(3, 6, 8)
        for index in range(3):
            input_mask[index, index, 0] = 1.0
        image, mask, _, _ = self.run_node(_manifest(), {"p": _paint(), "m": None}, batch=3, mask=input_mask)
        self.assertEqual(tuple(image.shape), (3, 6, 8, 3))
        self.assertEqual(tuple(mask.shape), (3, 6, 8))
        for index in range(3):
            expected = T_COLS.expand(6, 8).clone()
            expected[index, 0] = 1.0
            torch.testing.assert_close(mask[index], expected)
        torch.testing.assert_close(image[0], image[2])


class TestModify(_NodeCase):
    """The combined mask drives Fill / Crop / Alpha like any mask."""

    def test_fill_fills_holes_without_fringe(self) -> None:
        """Holes = fill colour; soft edge = layer colour over the fill colour (no blue)."""
        document = _manifest(mainOutput={"applyMask": "fill", "fillColor": "#ffff00"})
        image, mask, _, _ = self.run_node(document, {"p": _paint(), "m": None})
        torch.testing.assert_close(mask, T_COLS.expand(1, 6, 8))
        torch.testing.assert_close(image[0, :, 6], YELLOW.expand(6, 3))
        torch.testing.assert_close(image[0, :, 4], (0.5 * GREEN + 0.5 * YELLOW).expand(6, 3))
        torch.testing.assert_close(image[0, :, 0], RED.expand(6, 3))

    def test_crop_grows_to_include_a_hole(self) -> None:
        """Opaque layer with one transparent pixel at (4, 6); mask at (1, 1): crop spans both."""
        full = torch.zeros(6, 8, 4)
        full[:] = torch.tensor([1.0, 0.0, 0.0, 1.0])
        full[4, 6, 3] = 0.0
        mask_layer = torch.zeros(6, 8, 4)
        mask_layer[1, 1, 3] = 1.0
        document = _manifest(mainOutput={"applyMask": "crop"})
        image, mask, _, _ = self.run_node(document, {"p": full, "m": mask_layer})
        self.assertEqual(tuple(image.shape), (1, 4, 6, 3))
        self.assertEqual(float(mask[0, 0, 0]), 1.0)
        self.assertEqual(float(mask[0, 3, 5]), 1.0)
        torch.testing.assert_close(image[0, 3, 5], BLUE)  # plain RGB: hole on the background colour
        visible = _manifest(background_visible=True, mainOutput={"applyMask": "crop"})
        image, _, _, _ = self.run_node(visible, {"p": full, "m": mask_layer})
        self.assertEqual(tuple(image.shape), (1, 1, 1, 3))

    def test_alpha_transparent_holes_unpremultiplied(self) -> None:
        """Alpha: holes transparent (RGB = background); soft edge RGB = the layer colour."""
        document = _manifest(mainOutput={"alpha": True})
        image, mask, _, _ = self.run_node(document, {"p": _paint(), "m": None})
        self.assertEqual(tuple(image.shape), (1, 6, 8, 4))
        torch.testing.assert_close(image[..., 3], 1.0 - T_COLS.expand(1, 6, 8))
        torch.testing.assert_close(image[..., 3], 1.0 - mask)
        torch.testing.assert_close(image[0, :, 4, :3], GREEN.expand(6, 3))  # no fringe
        torch.testing.assert_close(image[0, :, 6, :3], BLUE.expand(6, 3))
        torch.testing.assert_close(image[0, :, 0, :3], RED.expand(6, 3))

    def test_alpha_unpremultiplies_stacked_layers_with_opacity(self) -> None:
        """Two half-covering layers: RGB = (sum of premultiplied colour) / A."""
        red = torch.zeros(6, 8, 4)
        red[:] = torch.tensor([1.0, 0.0, 0.0, 1.0])
        green = torch.zeros(6, 8, 4)
        green[:] = torch.tensor([0.0, 1.0, 0.0, 0.5])
        document = _manifest([_layer("paint", "a", opacity=0.5), _layer("paint", "b"), _layer("mask", "m")],
                             mainOutput={"alpha": True})
        image, _, _, _ = self.run_node(document, {"a": red, "b": green, "m": None})
        # A = 0.5 + 0.5 * 0.5 = 0.75; P = green 0.5 + red 0.5 * 0.5 = (0.25, 0.5, 0)
        torch.testing.assert_close(image[0, 0, 0], torch.tensor([1 / 3, 2 / 3, 0.0, 0.75]))

    def test_border_and_crop_with_alpha(self) -> None:
        """Crop + Alpha keeps the straight colour; Border + Alpha pads around the transparency."""
        document = _manifest(mainOutput={"applyMask": "crop", "alpha": True})
        image, _, _, _ = self.run_node(document, {"p": _paint(), "m": None})
        self.assertEqual(tuple(image.shape), (1, 6, 4, 4))  # cols 4-7
        torch.testing.assert_close(image[0, :, 0], torch.cat((GREEN, torch.tensor([0.5]))).expand(6, 4))
        document = _manifest(mainOutput={"applyMask": "border", "borderSize": 1, "borderMask": False, "alpha": True})
        image, _, _, _ = self.run_node(document, {"p": _paint(), "m": None})
        self.assertEqual(tuple(image.shape), (1, 8, 10, 4))
        self.assertEqual(float(image[0, 0, 0, 3]), 1.0)
        torch.testing.assert_close(image[0, 1:7, 1:9, 3], 1.0 - T_COLS.expand(6, 8))


class TestRegions(_NodeCase):
    """Every region gets its crop of T, inside and outside the image."""

    def test_region_crops_of_t(self) -> None:
        """Inside region = slice of the main MASK; Alpha region = straight colour."""
        regions = [
            {"id": "a", "slot": 1, "rect": {"x": 3, "y": 1, "width": 4, "height": 4}},
            {"id": "b", "slot": 2, "rect": {"x": 3, "y": 1, "width": 4, "height": 4}, "output": {"alpha": True}},
        ]
        _, mask, out, _ = self.run_node(_manifest(regions=regions), {"p": _paint(), "m": None})
        first, second = out.get(1), out.get(2)
        torch.testing.assert_close(first.mask, mask[:, 1:5, 3:7])
        torch.testing.assert_close(first.image[0, :, 1], (0.5 * GREEN + 0.5 * BLUE).expand(4, 3))
        torch.testing.assert_close(second.image[0, :, 1], torch.cat((GREEN, torch.tensor([0.5]))).expand(4, 4))

    def test_off_image_region(self) -> None:
        """A region reaching past the image: off-image area is a hole too; Alpha stays straight."""
        regions = [{"id": "a", "slot": 3, "rect": {"x": 4, "y": 0, "width": 6, "height": 2},
                    "output": {"alpha": True}}]
        _, mask, out, _ = self.run_node(_manifest(regions=regions), {"p": _paint(), "m": None})
        region = out.get(3)
        self.assertEqual(tuple(region.image.shape), (1, 2, 6, 4))
        torch.testing.assert_close(region.mask[:, :, :4], mask[:, 0:2, 4:8])
        torch.testing.assert_close(region.mask[:, :, 4:], torch.ones(1, 2, 2))
        torch.testing.assert_close(region.image[0, :, 0], torch.cat((GREEN, torch.tensor([0.5]))).expand(2, 4))
        torch.testing.assert_close(region.image[0, :, 5], torch.cat((BLUE, torch.tensor([0.0]))).expand(2, 4))


class TestPure(unittest.TestCase):
    """run_transparent_composite matches the opaque composite over the background colour."""

    def test_flatten_equals_composite_over_background(self) -> None:
        doc = parse_document(_manifest([_layer("paint", "a", opacity=0.7), _layer("paint", "b"),
                                        _layer("mask", "m")]))
        tensors = {"a": torch.rand(6, 8, 4), "b": torch.rand(6, 8, 4), "m": _mask_cols(slice(2, 3))}
        bg = (0.2, 0.4, 0.6)
        image, mask, straight = run_transparent_composite(bg, 2, 8, 6, doc, tensors, False)
        base = torch.tensor(bg).expand(2, 6, 8, 3).clone()
        expected, cmask = run_composite(base, doc, tensors, False)
        torch.testing.assert_close(image, expected)
        self.assertTrue(torch.all(mask >= cmask))
        self.assertEqual(tuple(straight.shape), (1, 6, 8, 3))
        self.assertTrue(torch.all((straight >= 0) & (straight <= 1)))


if __name__ == "__main__":
    unittest.main()
