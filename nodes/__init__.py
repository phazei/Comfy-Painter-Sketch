"""
nodes/__init__.py -- Node registry for the PainterSketch custom node package.

Exports ``ALL_NODES``, the list of V3 node classes that
``PainterSketchExtension.get_node_list`` returns to ComfyUI.

Adding a new node: import it here and append it to ``ALL_NODES``.
"""

from .painter_sketch import PainterSketch

ALL_NODES: list = [PainterSketch]

__all__ = ["ALL_NODES", "PainterSketch"]
