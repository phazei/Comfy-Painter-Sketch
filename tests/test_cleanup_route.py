"""
tests/test_cleanup_route.py -- Error answers of ``POST /painter-sketch/cleanup``.

Needs ComfyUI on ``sys.path`` (``server``, ``folder_paths``); skipped when
``server`` cannot be imported. Calls the handler directly with a stub request.

Covers:
  - a non-JSON body answers 400 with a JSON ``error``
  - an unexpected exception in the scan answers 500 with a JSON ``error``
    (not aiohttp's plain-text page) and is logged
"""

import asyncio
import json
import os
import sys
import unittest
from unittest import mock

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

try:
    from nodes import cleanup_route  # noqa: E402
except ImportError as exc:  # ComfyUI's server module is not importable here
    cleanup_route = None
    _IMPORT_ERROR = str(exc)


class _Request:
    """Minimal stand-in for ``aiohttp.web.Request`` (only ``json()``)."""

    def __init__(self, body: object = None, invalid: bool = False) -> None:
        self._body = body
        self._invalid = invalid

    async def json(self) -> object:
        """Return the body, or raise like aiohttp does for a non-JSON body."""
        if self._invalid:
            raise json.JSONDecodeError("Expecting value", "", 0)
        return self._body


@unittest.skipIf(cleanup_route is None, "ComfyUI server module not importable")
class TestCleanupRouteErrors(unittest.TestCase):
    """Every failure answers JSON."""

    def _call(self, request: _Request) -> tuple[int, dict]:
        response = asyncio.run(cleanup_route._handle_cleanup(request))
        return response.status, json.loads(response.text)

    def test_non_json_body_is_400_json(self) -> None:
        status, body = self._call(_Request(invalid=True))
        self.assertEqual(status, 400)
        self.assertIn("error", body)

    def test_scan_exception_is_500_json(self) -> None:
        with mock.patch.object(cleanup_route, "file_stats", side_effect=PermissionError("access denied")):
            with self.assertLogs("paintersketch.cleanup", level="ERROR"):
                status, body = self._call(_Request({"mode": "stats"}))
        self.assertEqual(status, 500)
        self.assertIn("access denied", body["error"])


if __name__ == "__main__":
    unittest.main()
