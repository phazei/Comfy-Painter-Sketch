"""
nodes/cleanup_route.py -- ``POST /painter-sketch/cleanup``, the project''s one server route.

Used by the ``PainterSketch.Cleanup`` settings button (SPEC "Settings").

Request body (two modes):

``{"mode": "stats"}``
    Returns ``{"all": {"count", "bytes"}, "old": {"count", "bytes"}}`` for all
    candidate files in ``input/painter-sketch/`` (same name pattern, regular
    files, not symlinks).  "old" means mtime older than 24 h.  No workflow
    scanning; cheap read-only call made when the settings row renders.

``{"dryRun": bool, "referenced": string[]}``
    Dry run: ``{"count", "bytes", "all", "old", "errors"?}`` -- what would be
    deleted plus the same stats so the UI can refresh.  Real run: same plus
    ``"deleted"`` (file names).

All decisions live in ``cleanup.py`` (pure, unit-tested); this module only does
HTTP parsing and runs the scan off the event loop with ``asyncio.to_thread``.
Registration follows the usual custom-node pattern
(``PromptServer.instance.routes``, collected by ``server.add_routes()`` after
custom nodes load, also exposed under ``/api``).  :func:`register_routes` is a
no-op when no server instance exists (package imported outside a running
ComfyUI) and when called twice.
"""

import asyncio
import logging
import os
import time

from aiohttp import web

import folder_paths
from server import PromptServer

from .cleanup import SUBFOLDER, file_stats, parse_referenced, run_cleanup

log = logging.getLogger("paintersketch.cleanup")

ROUTE = "/painter-sketch/cleanup"

_registered = False
_lock = asyncio.Lock()
"""Serializes cleanups so two clicks never race on the same files."""


async def _handle_cleanup(request: web.Request) -> web.Response:
    """Handle ``POST /painter-sketch/cleanup`` (see module docstring for the contract)."""
    try:
        body = await request.json()
    except ValueError:
        return web.json_response({"error": "body must be JSON"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"error": "body must be a JSON object"}, status=400)

    folder = os.path.join(folder_paths.get_input_directory(), SUBFOLDER)

    # ── Stats mode ────────────────────────────────────────────────────────────
    if body.get("mode") == "stats":
        result = await asyncio.to_thread(file_stats, folder, time.time())
        return web.json_response(result)

    # ── Cleanup mode ──────────────────────────────────────────────────────────
    if not isinstance(body.get("dryRun"), bool):
        return web.json_response({"error": "'dryRun' must be a boolean"}, status=400)
    referenced = parse_referenced(body.get("referenced", []))
    if referenced is None:
        return web.json_response({"error": "'referenced' must be a list of strings (max 100000, 4096 chars each)"}, status=400)

    async with _lock:
        result = await asyncio.to_thread(
            run_cleanup, folder, folder_paths.get_user_directory(), referenced, body["dryRun"]
        )
    return web.json_response(result)


def register_routes() -> None:
    """Add the cleanup route to the running ComfyUI server (idempotent)."""
    global _registered
    server = getattr(PromptServer, "instance", None)
    if _registered or server is None:
        return
    server.routes.post(ROUTE)(_handle_cleanup)
    _registered = True
