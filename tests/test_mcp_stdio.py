"""The MCP server's stdio contract.

stdio MCP puts JSON-RPC on stdout. That makes stdout a PROTOCOL channel, not a
place to talk to a person — and Zimi was talking to a person on it. With an
empty or wrong ZIM_DIR, `load_cache` printed

    No ZIM files found in /path
    Searched: /path. Put .zim files in any of these, ...

straight into the handshake. A lenient client skips the junk; a strict one
rejects the stream. Either way the first thing a new Open WebUI user saw — on
the run where they had not put any ZIMs in place yet, which is most first runs
— was a broken connection instead of an empty library.

Found by walking docs/integrations/openwebui.md end to end for a user who had
said in advance they had been burned by a different offline-knowledge MCP.

These tests speak raw JSON-RPC to a real subprocess, strictly: every line that
arrives on stdout must parse as JSON. Mocking the transport would not have
caught this, because the bug WAS the transport.
"""

import json
import os
import select
import subprocess
import sys
import time

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

pytest.importorskip("mcp", reason="the MCP server needs the mcp package")

HANDSHAKE_TIMEOUT = 40.0


@pytest.fixture
def server(tmp_path):
    """The MCP server on an EMPTY ZIM_DIR — the state that triggered the bug.

    A populated library is the easy case: the chatty branch never runs."""
    env = dict(os.environ, ZIM_DIR=str(tmp_path / "no-zims-here"))
    env.pop("ZIMI_OFFLINE", None)
    proc = subprocess.Popen(
        [sys.executable, "-m", "zimi.mcp_server"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
        bufsize=1,
        cwd=ROOT,
    )
    try:
        yield proc
    finally:
        proc.kill()
        proc.wait(timeout=10)


def _send(proc, obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def _read(proc, timeout=HANDSHAKE_TIMEOUT):
    """One JSON-RPC message. STRICT: a non-JSON line is a failure, not noise.

    That strictness is the whole point — being lenient here would reproduce the
    lenient client that hid this bug from us in the first place."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        ready, _, _ = select.select([proc.stdout], [], [], 0.5)
        if not ready:
            continue
        line = proc.stdout.readline()
        if not line:
            break
        if not line.strip():
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            pytest.fail(
                "non-JSON on the MCP stdout channel, which corrupts the "
                f"protocol for any strict client: {line[:200]!r}"
            )
    pytest.fail(f"no response within {timeout}s")


def _initialize(proc):
    _send(
        proc,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "zimi-tests", "version": "1"},
            },
        },
    )
    reply = _read(proc)
    _send(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"})
    return reply


def test_an_empty_library_does_not_corrupt_the_handshake(server):
    """The regression. Every byte on stdout is JSON-RPC, even when Zimi has
    something it would very much like to tell the user."""
    reply = _initialize(server)
    assert reply["id"] == 1
    assert "result" in reply, reply


def test_the_server_reports_zimis_version_not_the_librarys(server):
    """FastMCP answers with its OWN version when the low-level server's is
    left None, so a client was told "zimi 1.26.0" while Zimi was 1.9.0 — a
    number that would then turn up in somebody's bug report."""
    import zimi.server as _srv

    info = _initialize(server)["result"]["serverInfo"]
    assert info["name"] == "zimi"
    assert info["version"] == _srv.ZIMI_VERSION


def test_every_documented_tool_is_actually_offered(server):
    """docs/integrations/openwebui.md names the tools an agent gets. A doc that
    promises a tool the server does not have sends somebody hunting for their
    own mistake."""
    import pathlib
    import re

    _initialize(server)
    _send(server, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    offered = {t["name"] for t in _read(server)["result"]["tools"]}
    assert offered, "the server offered no tools at all"

    doc = pathlib.Path(ROOT, "docs", "integrations", "openwebui.md").read_text()
    promised = set(re.findall(r"\*\*`(\w+)`\*\*", doc))
    missing = sorted(promised - offered)
    assert (
        not missing
    ), f"the OpenWebUI guide promises tools that do not exist: {missing}"


def test_a_tool_call_answers_on_an_empty_library(server):
    """An empty library is a normal state, not an error. The answer says so in
    words a model can act on rather than failing the call."""
    _initialize(server)
    _send(
        server,
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "list_sources", "arguments": {}},
        },
    )
    result = _read(server)["result"]
    text = (result.get("content") or [{}])[0].get("text", "")
    assert text.strip(), result
    assert "no zim" in text.lower()
