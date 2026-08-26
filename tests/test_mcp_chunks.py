#!/usr/bin/env python3
"""MCP get_chunks tool — same JSON contract as GET /chunks.

No MCP test harness existed before this; FastMCP's @mcp.tool() returns the
underlying function unchanged, so we call it directly with a mocked archive
(the preview-test pattern) and assert it round-trips chunk_article's JSON.
"""

import json
import os
import sys
import unittest
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# zimi.mcp_server raises SystemExit at import when FastMCP is absent, which is
# right for a CLI and hostile to an importer: SystemExit during collection is an
# INTERNALERROR that aborts the ENTIRE run. On the first CI job to run the whole
# suite, this one line took all 2473 tests down to "no tests ran in 1.69s" —
# and the report was a dependency message, not a failing test, so it read like
# infrastructure noise rather than the real packaging bug underneath it.
#
# Skip this file instead. A missing optional dependency is a reason not to run
# these tests, never a reason to stop running the others.
try:
    import zimi.mcp_server as mcp_server  # noqa: E402
except SystemExit as exc:  # pragma: no cover - depends on the install
    pytest.skip(f"MCP server unavailable: {exc}", allow_module_level=True)

import zimi.server as server  # noqa: E402


def _fake_zim(html, zim_name="testzim"):
    archive = MagicMock()
    entry = MagicMock()
    entry.title = "Fixture Article"
    item = entry.get_item.return_value
    item.content = bytearray(html.encode("utf-8"))
    item.mimetype = "text/html"
    archive.get_entry_by_path.return_value = entry

    saved = {}
    for name, fn in {
        "get_zim_files": lambda: {zim_name: "/fake/path.zim"},
        "get_archive": lambda n=None: archive,
        "open_archive": lambda p=None: archive,
    }.items():
        saved[name] = getattr(server, name)
        setattr(server, name, fn)

    def cleanup():
        for name, orig in saved.items():
            setattr(server, name, orig)

    return cleanup


class TestMcpServerImport(unittest.TestCase):
    """Issue #52: mcp 2.0 dropped the vendored FastMCP and the server crashed on
    import via OpenWebUI. The module must import and stand up its FastMCP under
    the mcp version requirements resolves — a guard that catches the day someone
    unpins mcp."""

    def test_the_server_stands_up_a_fastmcp(self):
        self.assertEqual(type(mcp_server.mcp).__name__, "FastMCP")


class TestGetChunksTool(unittest.TestCase):
    ZIM = "testzim"
    PATH = "A/Fixture"

    def test_returns_same_json_as_core(self):
        html = "<p>" + " ".join(f"word{i}" for i in range(300)) + "</p>"
        cleanup = _fake_zim(html, self.ZIM)
        try:
            out = mcp_server.get_chunks(self.ZIM, self.PATH, size=400, overlap=40)
            core = server.chunk_article(self.ZIM, self.PATH, size=400, overlap=40)
        finally:
            cleanup()
        parsed = json.loads(out)
        self.assertEqual(parsed, core)
        self.assertEqual(parsed["size"], 400)
        self.assertGreater(parsed["total_chunks"], 1)
        for c in parsed["chunks"]:
            self.assertIn("id", c)
            self.assertIn("text", c)

    def test_clamps_passed_through(self):
        cleanup = _fake_zim("<p>hi there</p>", self.ZIM)
        try:
            parsed = json.loads(
                mcp_server.get_chunks(self.ZIM, self.PATH, size=10, overlap=99999)
            )
        finally:
            cleanup()
        self.assertEqual(parsed["size"], server.CHUNK_SIZE_MIN)
        self.assertEqual(parsed["overlap"], server.CHUNK_SIZE_MIN // 2)

    def test_unknown_zim_returns_error_string(self):
        cleanup = _fake_zim("<p>x</p>", "realzim")
        try:
            out = mcp_server.get_chunks("ghost", self.PATH)
        finally:
            cleanup()
        self.assertTrue(out.startswith("Error:"))


if __name__ == "__main__":
    unittest.main()
