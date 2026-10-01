"""Lean MCP: three tools, Markdown out, `zimi mcp` on stdio with nothing else.

A Reddit thread (szmcp) put it plainly: small local models (Gemma 12B,
Granite 8B, even 3B) do well with a few tools done well (search one or many
ZIMs, read a page, read one section, all as Markdown) and badly with a
kitchen sink. Zimi offered seventeen tools and plain text with the page's
structure flattened out of it.

These tests hold the lean set to that: its schemas stay small, a page reads
as Markdown with its headings, infobox, tables and math, a long page arrives
as an outline instead of 60k chars, and `zimi mcp` answers a search over a
real stdio pipe without opening a port. The full set stays exactly what it
was, for every config written against it.

Run: pytest tests/test_mcp_lean.py -v
"""

import json
import os
import select
import shutil
import subprocess
import sys
import time

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import mcp_lean_fixture as fx  # noqa: E402
from zimi import htmlmd  # noqa: E402
import zimi.server as server  # noqa: E402

# The Markdown tests need no MCP package; the tool tests do. The server
# module exits when FastMCP is missing, which must skip, not abort, a run.
try:
    import zimi.mcp_server as mcp_server  # noqa: E402
except (ImportError, SystemExit):  # pragma: no cover - depends on the install
    mcp_server = None
needs_mcp = pytest.mark.skipif(mcp_server is None, reason="needs the mcp package")

# Startup is a second or two on a quiet machine; the bound is for a loaded
# CI runner, and still fails a server that hangs or builds indexes first.
STARTUP_BOUND = 60.0
# The lean schemas, serialized: about 330 tokens. The full set is ~3,300.
LEAN_SCHEMA_CHARS_MAX = 2000
FULL_TOOL_NAMES = [
    "search",
    "read",
    "get_chunks",
    "suggest",
    "list_sources",
    "random",
    "list_collections",
    "manage_collection",
    "manage_favorites",
    "article_languages",
    "read_with_links",
    "deep_search",
    "list_videos",
    "list_questions",
    "read_question",
    "list_posts",
    "read_post",
]


def _wiki():
    return htmlmd.to_markdown(fx.WIKI, "Water")


# ── the Markdown ─────────────────────────────────────────────────────────


def test_a_wiki_page_reads_as_markdown_with_its_structure():
    text = _wiki().text()
    # The infobox as key: value lines, a <br> inside a value kept apart.
    assert "**Water**\nFormula: H2O\nBoiling point: 100 °C; 212 °F" in text
    # Bold and italics survive; links are their words; footnote marks go.
    assert (
        "**Water** is an inorganic compound with the chemical formula H2O. "
        "It is *transparent* and nearly colorless." in text
    )
    # Math as its TeX, inline and display, the \displaystyle wrapper off.
    assert "Its density follows $\\rho =m/V$ at room temperature." in text
    assert "$$2H_{2}+O_{2}\\to 2H_{2}O$$" in text
    # A data table as a pipe table, its caption over it, a | in a cell escaped.
    assert (
        "**Phases**\n| Phase | Range |\n|---|---|\n| Ice | below 0 °C |\n"
        "| Liquid \\| water | 0–100 °C |" in text
    )
    assert "- Irrigation\n  - Canals\n- Drinking" in text
    assert '```python\nprint("H2O")\nprint("done")\n```' in text
    assert "[Image: A water drop hitting a surface]" in text
    assert "## History" in text and "### Ancient uses" in text


def test_the_chrome_is_not_the_page():
    text = _wiki().text()
    for chrome in (
        "chrome",  # the <script>
        "font-style",  # the <style>
        "Contents:",  # the nav
        "edit",  # the section edit link
        "Navbox",
        "issued from Wikipedia",  # the footer
        "[1]",  # a footnote mark
        "A glass",  # an image's alt text
        "# Water\n",  # the page's own title, which the reader prints itself
    ):
        assert chrome not in text, chrome


def test_references_are_dropped_unless_asked_for():
    assert "Greenwood" not in _wiki().text()
    assert "References" not in _wiki().outline()
    kept = htmlmd.to_markdown(fx.WIKI, "Water", references=True).text()
    assert "## References\n\n1. Greenwood, *Chemistry of the Elements*, 1997." in kept


def test_devdocs_reads_as_markdown():
    text = htmlmd.to_markdown(fx.DEVDOCS, "What is Lit?").text()
    assert text == (
        "Lit is a simple library for building fast, lightweight **web components**."
        "\n\n## Install\n\nUse `npm i lit` to add it.\n\n"
        "```javascript\nimport {LitElement} from 'lit';\n"
        "class MyEl extends LitElement {}\n```"
    )


def test_a_long_page_is_its_intro_and_an_outline():
    doc = _wiki()
    shown = htmlmd.view(doc)
    assert len(doc.text()) > htmlmd.PAGE_CHARS
    assert shown.startswith("**Water**\nFormula: H2O")
    assert "History paragraph" not in shown
    assert "Call read_section with a number or heading below." in shown
    assert "\n1. History (" in shown and "\n  2. Ancient uses (" in shown
    assert "\n3. Chemistry (" in shown


def test_a_section_is_found_by_number_heading_or_anchor():
    doc = _wiki()
    assert doc.find("3").heading == "Chemistry"
    assert doc.find("chemistry").heading == "Chemistry"
    assert doc.find("Ancient_uses").heading == "Ancient uses"
    assert doc.find("intro").index == 0
    assert doc.find("Nope") is None
    hist = htmlmd.view(doc, doc.find("History"))
    assert hist.startswith("## History\n\nHistory paragraph 0")
    assert "### Ancient uses\n\n- Irrigation" in hist
    assert "Chemistry paragraph" not in hist


def test_a_page_with_no_headings_is_cut_into_parts_and_nothing_is_lost():
    paras = [f"Paragraph {i} " + "word " * 60 for i in range(120)]
    doc = htmlmd.to_markdown("".join(f"<p>{p}</p>" for p in paras), "Book")
    assert len(doc.sections) > 3
    assert all(len(s.body()) <= htmlmd.PART_CHARS for s in doc.sections)
    assert doc.sections[2].heading.startswith("Start (part 3 of ")
    joined = "\n\n".join(s.body() for s in doc.sections)
    assert joined == "\n\n".join(p.strip() for p in paras)


# ── the pages, out of real ZIMs ──────────────────────────────────────────


@pytest.fixture(scope="module")
def library(tmp_path_factory):
    return fx.build(str(tmp_path_factory.mktemp("lean-zims")))


@pytest.fixture
def installed(library, monkeypatch):
    from libzim.reader import Archive

    files = {
        server._zim_short_name(name): os.path.join(library, name)
        for name in os.listdir(library)
        if name.endswith(".zim")
    }
    opened = {}

    def get_archive(name):
        if name not in files:
            return None
        if name not in opened:
            opened[name] = Archive(files[name])
        return opened[name]

    monkeypatch.setattr(server, "get_zim_files", lambda: files)
    monkeypatch.setattr(server, "get_archive", get_archive)
    return files


def test_a_question_reads_with_its_answers_accepted_first(installed):
    from zimi.search import article_markdown

    got = article_markdown("cooking.stackexchange", fx.QUESTION_PATH)
    doc = got["doc"]
    assert got["title"] == "How can I chop onions without crying?"
    assert (
        doc.sections[0]
        .body()
        .startswith("265 votes · asked by Michael · tags: onions, knife-skills")
    )
    assert "Onions make me **cry**. See potatoes and" in doc.sections[0].body()
    assert [s.heading for s in doc.sections[1:]] == [
        "Answer 1: 158 points, accepted, by Ryan Elkins",
        "Answer 2: 172 points, by Aaronut",
    ]
    assert doc.sections[1].body() == "Use a `sharp` knife."
    assert "alert" not in doc.text()


@needs_mcp
def test_a_pointer_page_lands_on_its_section(installed):
    """mwoffliner writes "Uses of water" as a meta refresh into Water's
    "Ancient uses": reading it reads that section of Water."""
    got = mcp_server.lean_read("wikipedia", "Uses_of_water")
    assert got.startswith(
        "# Water § Ancient uses\nzim: wikipedia_en_test | path: Water\n\n"
        "### Ancient uses\n\n- Irrigation\n  - Canals\n- Drinking"
    )


# ── the tools ────────────────────────────────────────────────────────────



def _tools(tools):
    import asyncio

    listed = asyncio.run(mcp_server.build(tools).list_tools())
    return [t.model_dump(exclude_none=True, by_alias=True) for t in listed]


@needs_mcp
def test_lean_is_three_small_tools():
    tools = _tools("lean")
    assert [t["name"] for t in tools] == ["search", "read", "read_section"]
    for t in tools:
        assert len(t["description"]) <= 80, t["description"]
        assert "outputSchema" not in t, "an output schema is tokens for nothing"
    size = len(json.dumps(tools, separators=(",", ":")))
    assert size <= LEAN_SCHEMA_CHARS_MAX, size
    params = {t["name"]: sorted(t["inputSchema"]["properties"]) for t in tools}
    assert params == {
        "search": ["limit", "query", "zim"],
        "read": ["path", "references", "zim"],
        "read_section": ["path", "section", "zim"],
    }


@needs_mcp
def test_full_is_every_tool_unchanged():
    tools = _tools("full")
    assert [t["name"] for t in tools] == FULL_TOOL_NAMES
    read = next(t for t in tools if t["name"] == "read")
    assert read["description"].startswith(
        "Read an article from a ZIM source as plain text."
    )
    assert sorted(read["inputSchema"]["properties"]) == ["max_length", "path", "zim"]
    # The module's own server, which `python -m zimi.mcp_server` runs.
    assert type(mcp_server.mcp).__name__ == "FastMCP"


@needs_mcp
def test_an_unknown_tool_set_is_refused():
    with pytest.raises(ValueError):
        mcp_server.build("medium")
    with pytest.raises(SystemExit):
        mcp_server.tools_setting("medium", "lean")
    assert mcp_server.tools_setting("", "lean") == "lean"
    assert mcp_server.tools_setting(" FULL ", "lean") == "full"


@needs_mcp
def test_read_names_a_source_by_part_and_reads_markdown(installed):
    got = mcp_server.lean_read("devdocs", "index")
    lit = next(n for n in installed if n.startswith("devdocs"))
    assert got.startswith(f"# What is Lit?\nzim: {lit} | path: index\n\n")
    assert "Use `npm i lit` to add it." in got


@needs_mcp
def test_read_section_and_references_through_the_tools(installed):
    sec = mcp_server.read_section("wikipedia_en_test", "Water", "Chemistry")
    assert sec.startswith(
        "# Water § Chemistry\nzim: wikipedia_en_test | path: Water\n\n## Chemistry"
    )
    assert "| Ice | below 0 °C |" in sec
    whole = mcp_server.lean_read("wikipedia_en_test", "Water", references=True)
    assert "1. History (" in whole  # still long: intro and outline
    refs = mcp_server.read_section("wikipedia_en_test", "Water", "References")
    assert "Greenwood" not in refs  # read_section reads the page without them
    assert "No section 'References'" in refs


@needs_mcp
def test_the_wrong_source_or_page_says_what_to_do(installed):
    assert mcp_server.lean_read("nosuch", "x").startswith(
        "No source named 'nosuch'. Sources: "
    )
    lit = next(n for n in installed if n.startswith("devdocs"))
    assert mcp_server.lean_read("devdocs", "missing") == (
        f"No page 'missing' in {lit}. Use search to find one."
    )
    miss = mcp_server.read_section("wikipedia_en_test", "Water", "Geology")
    assert miss.startswith("No section 'Geology'. Sections:\n1. History (")


# ── `zimi mcp` on a real pipe ────────────────────────────────────────────


def _read_json(proc, deadline):
    """One JSON-RPC message. Every line on stdout must be JSON: it is a
    protocol channel, and a strict client drops a stream with anything else."""
    while time.time() < deadline:
        ready, _, _ = select.select([proc.stdout], [], [], 0.5)
        if not ready:
            continue
        line = proc.stdout.readline()
        if not line:
            break
        if line.strip():
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                pytest.fail(f"non-JSON on the MCP stdout: {line[:200]!r}")
    died = proc.poll() is not None
    pytest.fail("no answer in time" + (":\n" + proc.stderr.read()[-2000:] if died else ""))


def _start(args, env_extra=None):
    env = dict(os.environ, ZIMI_TORRENT="0", ZIMI_OFFLINE="1")
    env.pop("ZIM_DIR", None)
    env.pop("ZIMI_MCP_TOOLS", None)
    env.update(env_extra or {})
    return subprocess.Popen(
        [sys.executable, "-m", "zimi", *args],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env=env,
        bufsize=1,
        cwd=ROOT,
    )


def _rpc(proc, deadline, id_, method, params=None):
    msg = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        msg["params"] = params
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    return _read_json(proc, deadline)


def _handshake(proc, deadline):
    reply = _rpc(
        proc,
        deadline,
        1,
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "zimi-tests", "version": "1"},
        },
    )
    proc.stdin.write(
        json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"
    )
    proc.stdin.flush()
    return reply


def _listening(pid):
    """TCP ports ``pid`` listens on, or None when lsof is not there to ask."""
    if not shutil.which("lsof"):
        return None
    out = subprocess.run(
        ["lsof", "-nP", "-a", "-p", str(pid), "-iTCP", "-sTCP:LISTEN"],
        capture_output=True,
        text=True,
    ).stdout
    return [line for line in out.splitlines()[1:] if line.strip()]


@needs_mcp
def test_zimi_mcp_answers_a_search_on_stdio_with_no_port(library):
    proc = _start(["mcp", library])
    try:
        started = time.time()
        deadline = started + STARTUP_BOUND
        init = _handshake(proc, deadline)
        assert init["result"]["serverInfo"] == {
            "name": "zimi",
            "version": server.ZIMI_VERSION,
        }
        assert "wikipedia_en_test" in init["result"]["instructions"]
        tools = _rpc(proc, deadline, 2, "tools/list")["result"]["tools"]
        assert [t["name"] for t in tools] == ["search", "read", "read_section"]
        found = _rpc(
            proc,
            deadline,
            3,
            "tools/call",
            {"name": "search", "arguments": {"query": "chop onions", "limit": 3}},
        )["result"]["content"][0]["text"]
        elapsed = time.time() - started
        assert (
            "- How can I chop onions without crying? | zim: "
            "cooking.stackexchange | path: " + fx.QUESTION_PATH in found
        ), found
        assert elapsed < STARTUP_BOUND
        ports = _listening(proc.pid)
        if ports is not None:
            assert ports == [], f"zimi mcp opened a port: {ports}"
    finally:
        proc.kill()
        proc.wait(timeout=10)


@needs_mcp
def test_zimi_mcp_serves_the_full_set_when_asked(library):
    for args, env in (
        (["mcp", library, "--tools", "full"], None),
        (["mcp", library], {"ZIMI_MCP_TOOLS": "full"}),
    ):
        proc = _start(args, env)
        try:
            deadline = time.time() + STARTUP_BOUND
            _handshake(proc, deadline)
            tools = _rpc(proc, deadline, 2, "tools/list")["result"]["tools"]
            assert [t["name"] for t in tools] == FULL_TOOL_NAMES, args
        finally:
            proc.kill()
            proc.wait(timeout=10)


@needs_mcp
def test_zimi_mcp_on_an_empty_library_keeps_stdout_clean(tmp_path):
    """The first run is usually before any ZIM is in place. Every line on
    stdout is still JSON-RPC, and a search says there is nothing yet."""
    proc = _start(["mcp", str(tmp_path / "no-zims-yet")])
    try:
        deadline = time.time() + STARTUP_BOUND
        assert "result" in _handshake(proc, deadline)
        found = _rpc(
            proc,
            deadline,
            2,
            "tools/call",
            {"name": "search", "arguments": {"query": "water"}},
        )["result"]["content"][0]["text"]
        assert found == "No results for 'water'."
    finally:
        proc.kill()
        proc.wait(timeout=10)
