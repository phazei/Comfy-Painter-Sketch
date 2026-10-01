"""
nodes/painter_sketch_regions.py -- "PainterSketch Regions" helper node.

Takes the ``regions`` (``PS_REGIONS``) output of a PainterSketch node and
exposes its six region slots as twelve fixed sockets ``IMAGE 1``/``MASK 1`` ...
``IMAGE 6``/``MASK 6``. Sockets never appear or disappear; the frontend relabels
them after the region names. An empty slot returns a silent
``ExecutionBlocker(None)`` for that pair only, so its downstream branch just
doesn't run (SPEC "Node I/O" > "PainterSketch Regions").

``ExecutionBlocker`` is imported from ``comfy_execution.graph_utils``: importing
``comfy_execution.graph`` pulls in ComfyUI's own ``nodes`` module, which clashes
with this package's name when it is imported as ``nodes`` (tests).
"""

from typing_extensions import override

from comfy_api.latest import io
from comfy_execution.graph_utils import ExecutionBlocker

from .document_regions import REGION_SLOTS
from .output_processing import PainterRegions

PSRegions = io.Custom("PS_REGIONS")
"""Custom socket type carrying a :class:`~output_processing.PainterRegions`."""


class PainterSketchRegions(io.ComfyNode):
    """Split a PainterSketch ``regions`` value into six IMAGE/MASK pairs."""

    @classmethod
    @override
    def define_schema(cls) -> io.Schema:
        """Return the V3 schema: one ``regions`` input, twelve fixed outputs."""
        outputs = []
        for slot in range(1, REGION_SLOTS + 1):
            outputs.append(io.Image.Output(f"IMAGE {slot}", display_name=f"image {slot}"))
            outputs.append(io.Mask.Output(f"MASK {slot}", display_name=f"mask {slot}"))
        return io.Schema(
            node_id="PainterSketchRegions",
            display_name="PainterSketch Regions",
            category="image",
            description=(
                "Outputs the six output regions of a PainterSketch node as IMAGE/MASK "
                "pairs. An empty region slot silently stops its branch: nodes connected "
                "only to that pair don't run, without an error."
            ),
            inputs=[PSRegions.Input("regions", tooltip="The regions output of a PainterSketch node.")],
            outputs=outputs,
        )

    @classmethod
    @override
    def execute(cls, regions: PainterRegions) -> io.NodeOutput:
        """Return twelve positional values; empty slots become silent blockers.

        Args:
            regions: The PainterSketch ``regions`` value.

        Returns:
            ``IMAGE 1, MASK 1, ..., IMAGE 6, MASK 6``.
        """
        values: list = []
        for slot in range(1, REGION_SLOTS + 1):
            output = regions.get(slot) if isinstance(regions, PainterRegions) else None
            if output is None:
                values.extend((ExecutionBlocker(None), ExecutionBlocker(None)))
            else:
                values.extend((output.image, output.mask))
        return io.NodeOutput(*values)
