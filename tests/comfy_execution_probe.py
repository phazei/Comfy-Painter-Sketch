"""
tests/comfy_execution_probe.py -- Real ComfyUI V3 execution check, run in a subprocess.

Invoked by test_comfy_execution.py with ComfyUI on PYTHONPATH and ComfyUI's
directory as cwd. Loads this repo's ``nodes`` package under an alias so
ComfyUI's own ``nodes`` module and execution imports stay real. Only preview
disk I/O is replaced; V3 mapping and ExecutionBlocker handling are unmodified.

Exit status 0 + "passed" = success. If the ComfyUI internals this probe relies
on are missing or changed shape, it prints ``SKIP: <reason>`` and exits 0 so
the unittest can skip instead of failing.
"""

import asyncio
import importlib.util
import inspect
import json
import pathlib
import sys
from unittest import mock

import torch

try:
    import execution
    from comfy_api.latest import io, UI
    from comfy_execution.graph_utils import ExecutionBlocker
except ImportError as exc:  # ComfyUI layout changed
    print(f"SKIP: cannot import ComfyUI internals ({exc})")
    sys.exit(0)

_GET_OUTPUT_DATA_PARAMS = ["prompt_id", "unique_id", "obj", "input_data_all"]


class Consumer(io.ComfyNode):
    """A real V3 downstream node that records whether it executed."""

    calls = 0

    @classmethod
    def define_schema(cls) -> io.Schema:
        """Accept and return one image."""
        return io.Schema(node_id="PainterSketchM9TestConsumer", inputs=[io.Image.Input("image")],
                         outputs=[io.Image.Output("image")])

    @classmethod
    def execute(cls, image: torch.Tensor) -> io.NodeOutput:
        """Count the call and pass the tensor through."""
        Consumer.calls += 1
        return io.NodeOutput(image)


def _internals_changed() -> str | None:
    """Return a reason if ``execution.get_output_data`` isn't the expected API."""
    func = getattr(execution, "get_output_data", None)
    if func is None or not inspect.iscoroutinefunction(func):
        return "execution.get_output_data missing or not async"
    params = list(inspect.signature(func).parameters)[:4]
    if params != _GET_OUTPUT_DATA_PARAMS:
        return f"execution.get_output_data signature changed: {params}"
    return None


def _load_package() -> object:
    """Import this repo's ``nodes`` package under a non-clashing alias."""
    repo = pathlib.Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("painter_sketch_probe", repo / "nodes" / "__init__.py")
    package = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = package
    spec.loader.exec_module(package)
    return package


async def main() -> None:
    """Run PainterSketch -> PainterSketch Regions -> consumers through real execution."""
    reason = _internals_changed()
    if reason:
        print(f"SKIP: {reason}")
        return
    package = _load_package()
    painter, helper = package.PainterSketch, package.PainterSketchRegions
    painter.VALIDATE_CLASS()
    helper.VALIDATE_CLASS()
    assert tuple(painter.RETURN_TYPES) == ("IMAGE", "MASK", "PS_REGIONS"), painter.RETURN_TYPES
    assert tuple(helper.RETURN_TYPES) == ("IMAGE", "MASK") * 6, helper.RETURN_TYPES

    document = json.dumps({"version": 1, "frame": {"width": 8, "height": 6}, "regions": [
        {"id": "active", "slot": 4, "rect": {"x": 2, "y": 1, "width": 4, "height": 3}},
    ]})
    image = torch.ones(2, 6, 8, 3)
    with mock.patch.object(UI, "PreviewImage", return_value={"images": ["input-preview"]}):
        result, ui, subgraph, pending = await execution.get_output_data(
            "m9-test", "painter", painter,
            {"document": [document], "width": [8], "height": [6], "image": [image]},
        )
    assert len(result) == 3 and not subgraph and not pending
    assert ui == {"images": ["input-preview"]}
    assert result[0][0].shape == (2, 6, 8, 3)

    split, _, _, _ = await execution.get_output_data("m9-test", "regions", helper, {"regions": result[2]})
    assert len(split) == 12
    active = {6, 7}  # IMAGE 4 / MASK 4
    for index, values in enumerate(split):
        assert len(values) == 1
        if index in active:
            assert isinstance(values[0], torch.Tensor)
        else:
            assert isinstance(values[0], ExecutionBlocker) and values[0].message is None
    assert split[6][0].shape == (2, 3, 4, 3)

    for index in range(0, 12, 2):
        output, _, _, _ = await execution.get_output_data(
            "m9-test", f"consumer-{index}", Consumer, {"image": split[index]},
        )
        if index in active:
            assert output[0][0] is split[index][0]
    assert Consumer.calls == 1, Consumer.calls  # only the filled slot 4 ran
    print("Real ComfyUI V3 execution: regions helper and per-pair blockers passed")


if __name__ == "__main__":
    asyncio.run(main())
