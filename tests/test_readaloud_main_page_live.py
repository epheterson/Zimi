"""Read aloud on a wiki's main page: its boxes are laid out in a table of headings and
lists (no <p>), which was skipped as a data table, so only the banner was read and the
voice then had nothing more to say (1.15.6: "just the header").

Real server on a fixture ZIM, the reader at 390 px; the plan is what Read aloud sends.
"""

import os
import socket
import subprocess
import sys

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from games_wait import wait_for_server  # noqa: E402
from conftest_zim import _Article  # noqa: E402
from libzim.writer import Creator  # noqa: E402

PHONE = dict(
    viewport={"width": 390, "height": 844},
    device_scale_factor=2,
    is_mobile=True,
    has_touch=True,
    service_workers="block",
)
MAIN = (
    '<html lang="pt"><body><h1>Wikipédia</h1><div><h2>Bem-vindo à Wikipédia</h2><p>A enciclopédia livre</p></div>'
    '<table role="presentation"><tr><td><div><h2>Artigo em destaque</h2><div>Lisboa é a capital de Portugal.</div></div></td>'
    "<td><div><h2>Você sabia</h2><ul><li>Que o Tejo é longo?</li></ul></div></td></tr></table>"
    '<table class="infobox"><tr><th>Area</th><td><ul><li>Dados de caixa</li></ul></td></tr></table></body></html>'
)


@pytest.fixture(scope="module")
def zimi(tmp_path_factory):
    base = tmp_path_factory.mktemp("mainpage")
    zims, data = base / "zims", base / "data"
    zims.mkdir()
    data.mkdir()
    path = str(zims / "wikipedia_pt_test.zim")
    with Creator(path).config_indexing(True, "por") as creator:
        creator.set_mainpath("A/Principal")
        creator.add_item(_Article("A/Principal", "Principal", MAIN.encode()))
        for key, value in {"Title": "Wikip\u00e9dia", "Language": "por", "Description": "pt fixture", "Name": "wikipedia_pt_test"}.items():
            creator.add_metadata(key, value)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = dict(
        os.environ,
        ZIMI_TORRENT="0",
        ZIMI_OFFLINE="1",
        ZIMI_RATE_LIMIT="1000000",
        ZIM_DIR=str(zims),
        ZIMI_DATA_DIR=str(data),
        ZIMI_MANAGE="1",
        ZIMI_MANAGE_OPEN="1",
    )
    env.pop("ZIMI_BUILTIN_ZIMS", None)
    proc = subprocess.Popen(
        [sys.executable, "-m", "zimi", "serve", "--port", str(port)],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        if not wait_for_server(port):
            pytest.skip("zimi did not start")
        yield "http://127.0.0.1:%d" % port
    finally:
        proc.terminate()
        proc.wait(timeout=20)


def test_a_main_pages_table_of_boxes_is_read_and_a_data_table_is_not(zimi):
    with sync_playwright() as p:
        b = p.chromium.launch()
        try:
            pg = b.new_context(**PHONE).new_page()
            pg.goto(zimi + "/?a=wikipedia_pt_test%2FA%2FPrincipal", wait_until="load")
            pg.wait_for_function(
                "() => typeof readerOpen !== 'undefined' && readerOpen", timeout=30000
            )
            pg.wait_for_timeout(1500)
            assert pg.evaluate("() => _ttsLoad()"), "readaloud.js did not load"
            chunks = pg.evaluate(
                "() => _ttsMakePlan(_ttsFrameDoc()).chunks.map(c => c.text)"
            )
            text = " ".join(chunks)
            assert (
                "Artigo em destaque" in text and "Lisboa" in text and "Tejo" in text
            ), chunks
            assert "Dados de caixa" not in text, chunks
        finally:
            b.close()
