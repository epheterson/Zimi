"""zimi-mcp: the MCP server and search, packaged without the rest of Zimi.

packaging/zimi-mcp/build.py copies a fixed list of modules out of zimi/ and
builds a second distribution from them. These tests hold that list honest
without building anything: every module on it must import with only the
others beside it, and a staged copy must answer every tool, lean and full,
loading nothing outside the list and none of the heavy optional packages.
CI's zimi-mcp job then builds the real wheel and drives it over stdio.
"""

import ast
import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
sys.path.insert(0, str(ROOT / "packaging" / "zimi-mcp"))

import build as zimi_mcp_build  # noqa: E402


def _module_level_zimi_imports(name):
    """The zimi modules ``name`` imports when it is imported, leaving out the
    ones behind ``if bundled(...)``: those are the decisions to do without."""
    tree = ast.parse((ROOT / "zimi" / f"{name}.py").read_text(encoding="utf-8"))
    found = set()

    def visit(nodes):
        for node in nodes:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            if isinstance(node, ast.If) and "bundled(" in ast.unparse(node.test):
                visit(node.orelse)
                continue
            if isinstance(node, ast.ImportFrom) and node.module:
                if node.module == "zimi":
                    found.update(a.name for a in node.names)
                elif node.module.startswith("zimi."):
                    found.add(node.module.split(".")[1])
            elif isinstance(node, ast.Import):
                found.update(
                    a.name.split(".")[1]
                    for a in node.names
                    if a.name.startswith("zimi.")
                )
            for field in ("body", "orelse", "handlers", "finalbody"):
                visit(getattr(node, field, None) or [])

    visit(tree.body)
    return {m for m in found if (ROOT / "zimi" / f"{m}.py").exists()}


def test_every_shipped_module_imports_only_shipped_modules():
    shipped = set(zimi_mcp_build.MODULES)
    missing = {
        name: sorted(_module_level_zimi_imports(name) - shipped)
        for name in sorted(shipped)
    }
    missing = {k: v for k, v in missing.items() if v}
    assert not missing, (
        "a zimi-mcp module imports one zimi-mcp does not ship; import it "
        f"lazily, gate it on server.bundled(), or add it to MODULES: {missing}"
    )


def test_zimi_mcp_shares_the_main_version():
    from zimi import server

    assert zimi_mcp_build.version() == server.ZIMI_VERSION


def test_both_packages_offer_the_zimi_mcp_command():
    main = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    mcp = (ROOT / "packaging" / "zimi-mcp" / "pyproject.toml").read_text(
        encoding="utf-8"
    )
    entry = 'zimi-mcp = "zimi.server:mcp_main"'
    assert entry in main and entry in mcp


def test_zimi_mcp_version_flag():
    out = subprocess.run(
        [
            sys.executable,
            "-c",
            "from zimi.server import mcp_main; mcp_main(['--version'])",
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
        timeout=120,
    )
    from zimi import server

    assert out.stdout.strip() == f"zimi-mcp {server.ZIMI_VERSION}", out.stderr


# Runs in a child whose only zimi is the staged one. PyMuPDF is made
# unimportable, as it is in a zimi-mcp install without the pdf extra.
_PROBE = textwrap.dedent("""
    import json, os, sys
    sys.modules["pymupdf"] = None
    sys.modules["fitz"] = None
    sys.path.insert(0, sys.argv[2])
    import mcp_lean_fixture as fx
    lib = fx.build(os.path.join(sys.argv[3], "zims"))
    os.environ["ZIM_DIR"] = lib
    from zimi import server
    assert server.__file__.startswith(sys.argv[1]), server.__file__
    server.apply_data_paths(lib, os.path.join(sys.argv[3], "data"))
    import zimi.mcp_server as m
    m.build("lean"); m.build("full")
    server.load_cache()
    out = {
        "lean_search": m.lean_search("chop onions"),
        "lean_read": m.lean_read("wikipedia", "Water"),
        "read_section": m.read_section("wikipedia", "Water", "History"),
        "search": m.search("water"),
        "read": m.read("wikipedia_en_test", "Water"),
        "suggest": m.suggest("wat"),
        "get_chunks": m.get_chunks("wikipedia_en_test", "Water"),
        "list_sources": m.list_sources(),
        "read_with_links": m.read_with_links("wikipedia_en_test", "Water"),
        "deep_search": m.deep_search("water"),
        "list_questions": m.list_questions(),
        "read_question": m.read_question("cooking.stackexchange", fx.QUESTION_PATH),
        "list_videos": m.list_videos(),
        "list_posts": m.list_posts(),
    }
    out["_modules"] = sorted(k for k in sys.modules if k == "zimi" or k.startswith("zimi."))
    out["_heavy"] = [k for k in ("libtorrent", "zeroconf", "webview", "playwright")
                     if k in sys.modules]
    print("RESULT " + json.dumps(out))
    """)


def test_a_staged_zimi_mcp_answers_every_tool_alone(tmp_path):
    pytest.importorskip("mcp", reason="the MCP server needs the mcp package")
    stage = zimi_mcp_build.stage(tmp_path / "stage")
    work = tmp_path / "work"
    work.mkdir()
    env = dict(os.environ, PYTHONPATH=str(stage), ZIMI_TORRENT="0", ZIMI_OFFLINE="1")
    env.pop("ZIM_DIR", None)
    proc = subprocess.run(
        [sys.executable, "-c", _PROBE, str(stage), str(TESTS), str(work)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=work,  # not the repo, whose zimi/ would answer instead
        env=env,
        timeout=300,
    )
    lines = [ln for ln in proc.stdout.splitlines() if ln.startswith("RESULT ")]
    assert proc.returncode == 0 and lines, proc.stderr[-3000:]
    got = json.loads(lines[-1][len("RESULT ") :])
    shipped = {"zimi"} | {f"zimi.{m}" for m in zimi_mcp_build.MODULES}
    assert set(got.pop("_modules")) <= shipped
    assert got.pop("_heavy") == []
    assert "cooking.stackexchange" in got["lean_search"]
    assert got["lean_read"].startswith("# Water")
    assert "## History" in got["read_section"]
    assert "**Water**" in got["search"]
    assert "inorganic compound" in got["read"]
    assert "Water" in got["suggest"]
    assert json.loads(got["get_chunks"])["total_chunks"] >= 1
    assert "3 sources" in got["list_sources"]
    assert "Cooking" in got["list_questions"]
    assert got["read_question"].startswith("# How can I chop onions")
    for name, text in got.items():
        assert not text.startswith("Error"), (name, text)
