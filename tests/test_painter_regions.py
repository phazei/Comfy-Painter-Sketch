"""Tests for the node contract: PainterSketch outputs and the PainterSketch Regions helper."""

import json
import unittest
from types import SimpleNamespace
from unittest import mock

import torch

from comfy_execution.graph_utils import ExecutionBlocker
from nodes import ALL_NODES, painter_sketch, previews
from nodes.output_processing import PainterRegions, RegionOutput
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


class _PreviewPatch(unittest.TestCase):
    """Base: avoid writing preview files; keep the preview tensor for inspection."""

    def setUp(self) -> None:
        """Patch UI.PreviewImage for the duration of each test."""
        patcher = mock.patch.object(previews.UI, "PreviewImage", return_value={"images": []})
        self.preview = patcher.start()
        self.addCleanup(patcher.stop)


class TestMainNode(_PreviewPatch):
    """PainterSketch: IMAGE, MASK, regions (PS_REGIONS)."""

    def test_schema_outputs(self) -> None:
        """Exactly three outputs; the third is the custom PS_REGIONS type; 16384 caps."""
        schema = PainterSketch.define_schema()
        self.assertEqual([o.id for o in schema.outputs], ["IMAGE", "MASK", "regions"])
        self.assertEqual([o.get_io_type() for o in schema.outputs], ["IMAGE", "MASK", "PS_REGIONS"])
        widths = {i.id: i for i in schema.inputs}
        self.assertEqual((widths["width"].max, widths["height"].max), (16384, 16384))

    def test_registered_nodes(self) -> None:
        """Both nodes are in ALL_NODES."""
        self.assertEqual(ALL_NODES, [PainterSketch, PainterSketchRegions])

    def test_fallback_documents_have_empty_regions(self) -> None:
        """Empty / malformed documents: image passthrough, flat mask, all slots empty."""
        for document in ("", "{bad", "[]", '{"version":2}', _manifest(frame={})):
            for invert in (False, True):
                with self.subTest(document=document, invert=invert):
                    image = torch.rand(2, 3, 5, 3)
                    out = PainterSketch.execute(document, 8, 6, "#804020", invert, image)
                    self.assertEqual(len(out.result), 3)
                    torch.testing.assert_close(out.result[0], image)
                    self.assertTrue(torch.all(out.result[1] == int(invert)))
                    self.assertIsInstance(out.result[2], PainterRegions)
                    self.assertTrue(all(slot is None for slot in out.result[2].slots))

    def test_main_options_do_not_affect_regions(self) -> None:
        """Main fill changes IMAGE only; the region slices the unfilled composite."""
        image = torch.stack((torch.zeros(6, 8, 3), torch.ones(6, 8, 3)))
        mask_rgba = torch.ones(6, 8, 4)
        document = _manifest(layers=[{"id": "m", "kind": "mask", "invert": True}],
                             mainOutput={"applyMask": "fill", "fillColor": "#ff0000"},
                             regions=[_region(4)])
        mask_rgba[..., 3] = 0.0  # inverted -> full mask
        with mock.patch.object(painter_sketch, "load_layer_rgba", return_value=mask_rgba), \
                mock.patch.object(painter_sketch, "run_composite", wraps=painter_sketch.run_composite) as compose:
            out = PainterSketch.execute(document, 100, 100, image=image)
        compose.assert_called_once()  # region lies inside: no extra viewport composite
        self.assertTrue(torch.all(out.result[0] == torch.tensor([1.0, 0.0, 0.0])))
        region = out.result[2].get(4)
        torch.testing.assert_close(region.image, image[:, 1:5, 2:6])
        self.assertTrue(torch.all(region.mask == 1))
        torch.testing.assert_close(self.preview.call_args.args[0], image[:1])

    def test_off_image_region_uses_background_widget(self) -> None:
        """With an input image connected, off-image region px use the background colour."""
        image = torch.zeros(1, 6, 8, 3)
        document = _manifest(regions=[_region(2, rect={"x": -2, "y": 4, "width": 4, "height": 4})])
        out = PainterSketch.execute(document, 8, 6, "#0000ff", False, image)
        region = out.result[2].get(2)
        self.assertEqual(tuple(region.image.shape), (1, 4, 4, 3))
        torch.testing.assert_close(region.image[0, 0, 0], torch.tensor([0.0, 0.0, 1.0]))
        torch.testing.assert_close(region.image[0, 1, 3], torch.tensor([0.0, 0.0, 0.0]))
        torch.testing.assert_close(region.image[0, 2, 3], torch.tensor([0.0, 0.0, 1.0]))

    def test_bad_region_skipped_individually(self) -> None:
        """A malformed region leaves paint and other regions intact."""
        rgba = torch.ones(6, 8, 4)
        rgba[..., 1:3] = 0
        document = _manifest(layers=[{"id": "paint", "kind": "paint"}],
                             regions=[{"id": "broken", "slot": 1}, _region(5)])
        with mock.patch.object(painter_sketch, "load_layer_rgba", return_value=rgba):
            out = PainterSketch.execute(document, 8, 6, "#000000")
        torch.testing.assert_close(out.result[0][0, 0, 0], torch.tensor([1., 0., 0.]))
        self.assertIsNone(out.result[2].get(1))
        torch.testing.assert_close(out.result[2].get(5).image[0, 0, 0], torch.tensor([1., 0., 0.]))


class TestRegionsHelper(unittest.TestCase):
    """PainterSketch Regions: twelve fixed outputs; empty slots block their pair only."""

    def test_schema(self) -> None:
        """One PS_REGIONS input, IMAGE n / MASK n outputs, description mentions blocking."""
        schema = PainterSketchRegions.define_schema()
        self.assertEqual(schema.node_id, "PainterSketchRegions")
        self.assertEqual(schema.display_name, "PainterSketch Regions")
        self.assertEqual(schema.category, "image")
        self.assertEqual([i.get_io_type() for i in schema.inputs], ["PS_REGIONS"])
        self.assertEqual([o.id for o in schema.outputs],
                         [f"{k} {n}" for n in range(1, 7) for k in ("IMAGE", "MASK")])
        self.assertEqual([o.display_name for o in schema.outputs],
                         [f"{k} {n}" for n in range(1, 7) for k in ("image", "mask")])
        self.assertEqual([o.get_io_type() for o in schema.outputs], ["IMAGE", "MASK"] * 6)
        self.assertIn("silently stops its branch", schema.description)

    def test_blocks_only_empty_pairs(self) -> None:
        """Slots 2 and 5 filled: their tensors pass through, every other pair is blocked."""
        filled = {2: RegionOutput(torch.zeros(1, 2, 2, 3), torch.zeros(1, 2, 2)),
                  5: RegionOutput(torch.ones(1, 3, 3, 3), torch.ones(1, 3, 3))}
        regions = PainterRegions(tuple(filled.get(n) for n in range(1, 7)))
        out = PainterSketchRegions.execute(regions)
        self.assertEqual(len(out.result), 12)
        self.assertIsNone(out.block_execution)
        for slot in range(1, 7):
            image, mask = out.result[2 * slot - 2], out.result[2 * slot - 1]
            if slot in filled:
                self.assertIs(image, filled[slot].image)
                self.assertIs(mask, filled[slot].mask)
            else:
                for value in (image, mask):
                    self.assertIsInstance(value, ExecutionBlocker)
                    self.assertIsNone(value.message)

    def test_end_to_end_from_main_node(self) -> None:
        """Main node regions value feeds the helper."""
        with mock.patch.object(previews.UI, "PreviewImage", return_value={"images": []}):
            main = PainterSketch.execute(_manifest(regions=[_region(3)]), 8, 6, "#ffffff")
        out = PainterSketchRegions.execute(main.result[2])
        self.assertEqual(tuple(out.result[4].shape), (1, 4, 4, 3))
        self.assertIsInstance(out.result[0], ExecutionBlocker)


class TestRegionFingerprints(unittest.TestCase):
    """Manifest-only edits and file stat edits both invalidate output caches."""

    def test_metadata_changes_are_honored(self) -> None:
        """Every region / option change yields a new fingerprint."""
        def fingerprint(document: str) -> str:
            return PainterSketch.fingerprint_inputs(document, False, 8, 6)

        original = _manifest(regions=[_region(1)])
        hashes = {fingerprint(original)}
        changes = [
            {"mainOutput": {"applyMask": "crop", "cropPadding": 1}},
            {"mainOutput": {"applyMask": "fill", "fillColor": "#abcdef"}},
            {"regions": [_region(2)]},
            {"regions": [_region(1, rect={"x": 1, "y": 1, "width": 4, "height": 4})]},
            {"regions": [_region(1, output={"applyMask": "crop", "cropPadding": 2})]},
        ]
        for change in changes:
            data = json.loads(original)
            data.update(change)
            hashes.add(fingerprint(json.dumps(data)))
        self.assertEqual(len(hashes), len(changes) + 1)

    def test_background_changes_fingerprint(self) -> None:
        """background now also colours off-image regions, so it is hashed."""
        document = _manifest(regions=[_region(1)])
        self.assertNotEqual(PainterSketch.fingerprint_inputs(document, False, 8, 6, "#000000"),
                            PainterSketch.fingerprint_inputs(document, False, 8, 6, "#ffffff"))

    def test_file_stat_hashing_survives_new_metadata(self) -> None:
        """A changed layer file mtime changes the fingerprint."""
        document = _manifest(regions=[_region(6)], layers=[
            {"id": "paint", "kind": "paint", "file": "painter-sketch/paint.png [input]"},
        ])
        with mock.patch.object(painter_sketch.folder_paths, "exists_annotated_filepath", return_value=True), \
                mock.patch.object(painter_sketch.folder_paths, "get_annotated_filepath", return_value="paint.png"), \
                mock.patch.object(painter_sketch.os, "stat") as stat:
            stat.return_value = SimpleNamespace(st_size=10, st_mtime=1)
            first = PainterSketch.fingerprint_inputs(document, False, 8, 6)
            stat.return_value = SimpleNamespace(st_size=10, st_mtime=2)
            second = PainterSketch.fingerprint_inputs(document, False, 8, 6)
            self.assertNotEqual(first, second)


if __name__ == "__main__":
    unittest.main()
