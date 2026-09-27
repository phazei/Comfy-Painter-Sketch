"""Tests for nodes/document_regions.py: M9 manifest fields, legacy slots, bad-record isolation."""

import json
import unittest

from nodes.document import parse_document
from nodes.document_regions import MAX_BORDER_SIZE, OutputOptions, RegionRect, parse_output_options


def _region(region_id: str = "r", slot: int = 1, **overrides) -> dict:
    record = {"id": region_id, "slot": slot,
              "rect": {"x": 0.5, "y": -2, "width": 20.25, "height": 30}}
    record.update(overrides)
    return record


def _document(**overrides) -> object:
    data = {"version": 1, "frame": {"width": 100, "height": 200},
            "layers": [{"id": "paint", "kind": "paint", "file": "paint.png [input]"}]}
    data.update(overrides)
    return parse_document(json.dumps(data))


class TestRegionParsing(unittest.TestCase):
    """New metadata is tolerant, while occupied output identities stay stable."""

    def test_old_document_defaults(self) -> None:
        doc = _document()
        self.assertEqual(doc.regions, [])
        self.assertEqual(doc.main_output, OutputOptions())
        self.assertEqual(doc.layers[0].file, "paint.png [input]")

    def test_all_reserved_indices_become_one_based_slots(self) -> None:
        records = []
        for index in range(6):
            record = _region(str(index), index=index)
            del record["slot"]
            records.append(record)
        doc = _document(regions=records)
        self.assertEqual([r.slot for r in doc.regions], list(range(1, 7)))
        self.assertTrue(all(r.output == OutputOptions() and r.visible for r in doc.regions))

    def test_canonical_slot_takes_precedence_over_index(self) -> None:
        doc = _document(regions=[_region(slot=6, index=0), _region("bad", slot=None, index=1)])
        self.assertEqual([r.slot for r in doc.regions], [6])

    def test_first_valid_id_and_slot_win_without_reserving_invalid_records(self) -> None:
        doc = _document(regions=[
            _region("first", 2, rect={}), _region("first", 2, name="winner"),
            _region("duplicate-slot", 2), _region("first", 3),
            _region("third", 3), _region("duplicate-slot", 5),
        ])
        self.assertEqual([(r.id, r.slot) for r in doc.regions],
                         [("first", 2), ("third", 3), ("duplicate-slot", 5)])
        self.assertEqual(doc.regions[0].name, "winner")

    def test_invalid_records_never_discard_paint_or_valid_regions(self) -> None:
        invalid = [None, [], "bad", {}, _region(id=""), _region(id="  "),
                   _region(slot=True), _region(slot="1"), _region(slot=1.5),
                   _region(slot=0), _region(slot=7), _region(rect=[])]
        for field in ("x", "y", "width", "height"):
            for value in (True, "1", None, float("nan"), float("inf"), 10**400):
                rect = {"x": 0, "y": 0, "width": 1, "height": 1, field: value}
                invalid.append(_region(rect=rect))
        invalid.extend([_region(rect={"x": 1e308, "y": 0, "width": 1e308, "height": 1}),
                        _region(rect={"x": 0, "y": 0, "width": 0, "height": 1}),
                        _region(rect={"x": 0, "y": 0, "width": 1, "height": -1})])
        for record in invalid:
            with self.subTest(record=record):
                doc = _document(regions=[record, _region("valid", 4)])
                self.assertEqual([r.id for r in doc.regions], ["valid"])
                self.assertEqual(doc.layers[0].id, "paint")

    def test_bad_array_and_options_are_local(self) -> None:
        for value in (None, {}, 1, "bad"):
            with self.subTest(value=value):
                doc = _document(regions=value, mainOutput=value)
                self.assertEqual(doc.regions, [])
                self.assertEqual(doc.main_output, OutputOptions())
                self.assertEqual(len(doc.layers), 1)

    def test_reference_size_is_ignored_and_rect_kept_verbatim(self) -> None:
        """regionsReferenceSize was dropped: rects stay exact image px, never rescaled."""
        doc = _document(regions=[_region()], regionsReferenceSize={"width": 10, "height": 20})
        self.assertEqual(doc.regions[0].rect, RegionRect(0.5, -2, 20.25, 30))
        self.assertFalse(hasattr(doc, "regions_reference_size"))

    def test_off_image_and_large_rects_are_accepted(self) -> None:
        """Rects outside the frame are valid; clamping happens at render time."""
        rect = {"x": -5000, "y": 90000, "width": 1e6, "height": 3}
        doc = _document(regions=[_region(rect=rect)])
        self.assertEqual(doc.regions[0].rect, RegionRect(-5000, 90000, 1e6, 3))
    def test_valid_fields_and_unknown_fields(self) -> None:
        doc = _document(mainOutput={"applyMask": "crop", "cropPadding": 5}, regions=[
            _region(slot=3.0, name="face", visible=False, unknown="ignored",
                    output={"applyMask": "fill", "fillColor": "#Aa33BB"}),
        ])
        region = doc.regions[0]
        self.assertEqual((region.slot, region.name, region.visible), (3, "face", False))
        self.assertEqual(region.rect.width, 20.25)
        self.assertEqual(region.output, OutputOptions("fill", "#aa33bb", 0))
        self.assertEqual(doc.main_output, OutputOptions("crop", "#000000", 5))


class TestOutputOptionParsing(unittest.TestCase):
    """Option normalization agrees with frontend defaults and integer padding."""

    def test_each_invalid_field_defaults_independently(self) -> None:
        self.assertEqual(parse_output_options({"applyMask": [], "fillColor": "#123456",
                                               "cropPadding": 3}),
                         OutputOptions("none", "#123456", 3))
        for color in ("#fff", "#000000ff", "white", "123456", None, 123):
            with self.subTest(color=color):
                self.assertEqual(parse_output_options({"applyMask": "fill", "fillColor": color}),
                                 OutputOptions("fill", "#000000", 0))

    def test_border_fields_defaults_and_validation(self) -> None:
        """Missing border fields = 64 / #ffffff / True; bad fields default on their own."""
        self.assertEqual(parse_output_options({"applyMask": "border"}),
                         OutputOptions("border", border_size=64, border_color="#ffffff", border_mask=True))
        parsed = parse_output_options({"applyMask": "border", "borderSize": 12.7,
                                       "borderColor": "#00FF80", "borderMask": False})
        self.assertEqual((parsed.border_size, parsed.border_color, parsed.border_mask), (12, "#00ff80", False))
        for value, expected in [(0, 1), (-5, 1), (1e9, MAX_BORDER_SIZE), (True, 64), ("8", 64),
                                (float("nan"), 64), (10**400, 64)]:
            with self.subTest(size=value):
                self.assertEqual(parse_output_options({"borderSize": value}).border_size, expected)
        bad = parse_output_options({"borderColor": "white", "borderMask": 1})
        self.assertEqual((bad.border_color, bad.border_mask), ("#ffffff", True))
        self.assertEqual(MAX_BORDER_SIZE, 4096)

    def test_padding_floor_nonnegative_and_safe_cap(self) -> None:
        for value, expected in [(2.9, 2), (-2, 0), (True, 0), ("2", 0),
                                (float("nan"), 0), (float("inf"), 0),
                                (1e30, 2**53 - 1), (10**400, 0)]:
            with self.subTest(value=value):
                self.assertEqual(parse_output_options({"cropPadding": value}).crop_padding, expected)
