"""A document library kept on the phone reads with no server: its list of
documents, and a long PDF in the reader, on a phone that never opened either
while it had a connection.

Run: pytest tests/test_keep_pdf_live.py
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import books_sources_fixture as fx  # noqa: E402
from pdf_fixture import multipage_pdf  # noqa: E402
from test_keep_flow_live import phone  # noqa: E402
from test_keep_phone_live import pw, wait_shell_kept  # noqa: E402,F401
from test_offline_truth_live import Server, _free_port, poll  # noqa: E402
import wiki_fixture as wf  # noqa: E402

NAME = "zimgit-water"
DOC = "files/Water (1).pdf"
# Long enough that pdf.js would read it in ranges from a server.
PAGES = 300


@pytest.fixture
def world(tmp_path):
    zims, data = tmp_path / "zims", tmp_path / "data"
    zims.mkdir()
    data.mkdir()
    wf.build_library(str(zims))
    fx.build_zim(
        str(zims / "zimgit-water_en_2024-08.zim"),
        {"Scraper": "nautiluszim 1.1.1", "Name": "zimgit-water_en", "Title": "Water Treatment Library"},
        {
            "home": ("text/html", "<html><body>Water</body></html>", "Home"),
            "database.js": ("text/javascript", fx.WATER_DATABASE, "database.js"),
            DOC: ("application/pdf", multipage_pdf(PAGES), ""),
        },
        "home",
    )
    srv = Server(str(zims), str(data), _free_port())
    srv.start()
    yield srv
    srv.stop()


def test_a_kept_document_library_reads_offline(pw, world):
    br, ctx = phone(pw)
    pg = ctx.new_page()
    pg.goto(world.base + "/", wait_until="load")
    wait_shell_kept(pg)
    pg.wait_for_function("() => typeof _keepStart === 'function'")
    pg.evaluate("() => _keepLoad()")
    pg.evaluate("() => { KeepStore.estimateIsFuzzy = () => true; }")
    pg.evaluate("(z) => _keepStart(z)", NAME)
    pg.wait_for_function("(z) => _keepNames.has(z)", arg=NAME, timeout=60000)
    # The viewer comes with the ZIM, not with a PDF read while online.
    poll(
        pg,
        "async () => { for (const u of _KEEP_OFFLINE_FILES) if (!(await caches.match(u, {ignoreSearch: true}))) return false; return true; }",
        timeout_s=30,
    )
    # And the library's list as the server draws it, though it was never opened.
    poll(pg, "async (z) => !!(await caches.match('/catalog?zim=' + encodeURIComponent(z)))", timeout_s=30, arg=NAME)
    world.stop()
    pg.goto(world.base + "/", wait_until="load")
    # enterSource reads the library list the boot fetches (here from the worker); asked before it lands, the ZIM is
    # unknown and opens at its front page instead of its list of documents.
    pg.wait_for_function("(z) => typeof enterSource === 'function' && !!_zimInfo(z)", arg=NAME, timeout=30000)
    pg.evaluate("(z) => enterSource(z)", NAME)
    pg.wait_for_selector("a.zg-doc", timeout=15000)
    titles = pg.eval_on_selector_all("a.zg-doc .title", "els => els.map(e => e.innerText)")
    assert titles[0] == "Distillation For Home Water Treatment" and len(titles) == 7, titles
    # The same list the app shows online, with the sizes the server knows
    # (the one read off the phone's copy has none).
    metas = pg.eval_on_selector_all("a.zg-doc", "els => els.map(e => e.innerText)")
    assert any(" KB" in m or " MB" in m for m in metas), metas
    pg.click("a.zg-doc[data-path='%s']" % DOC)
    pg.wait_for_function(
        """() => { const f = document.getElementById('reader-frame');
                   try { const app = f.contentWindow.PDFViewerApplication;
                         return app && app.pagesCount === %d && f.contentDocument.querySelector('.page canvas'); }
                   catch (e) { return false; } }""" % PAGES,
        timeout=30000,
    )
    ctx.close()
    br.close()
