"""
__init__.py -- PainterSketch ComfyUI custom node package entry point.

Registers the package with ComfyUI via the V3 extension API
(``comfy_entrypoint`` + ``ComfyExtension``).  The loader reads
``WEB_DIRECTORY`` before the V1/V3 fork, so it is declared at module scope.

ComfyUI Loader Fork note: ``NODE_CLASS_MAPPINGS`` must NOT exist in this file
(not even as an empty dict) -- its presence silently activates the V1 code
path, which never calls ``comfy_entrypoint()``.  See AGENTS.md.

WEB_DIRECTORY: ComfyUI auto-loads every ``*.js`` file found under this
directory as an extension entry point.  The built frontend bundle lives in
``js/`` and is committed so users never need to run a build.
"""

import logging

from comfy_api.latest import ComfyExtension, io
from typing_extensions import override

from .nodes import ALL_NODES

log = logging.getLogger("paintersketch")

WEB_DIRECTORY = "./js"


class PainterSketchExtension(ComfyExtension):
    """ComfyUI V3 extension that registers PainterSketch nodes."""

    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        """Return all node classes provided by this extension.

        Returns:
            List of V3 ComfyNode subclasses (see nodes/__init__.py).
        """
        return ALL_NODES


async def comfy_entrypoint() -> PainterSketchExtension:
    """ComfyUI V3 entry point; called by the loader after WEB_DIRECTORY is read.

    Returns:
        A fresh :class:`PainterSketchExtension` instance.
    """
    log.info("PainterSketch: loading extension")
    return PainterSketchExtension()
