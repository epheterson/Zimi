"""The games speak the language picked in Zimi, not the phone's.

Zimi's shell hands the games its language and direction in the address they open at (#lang=de&dir=ltr);
without it they fall back to navigator.language.

Run: ZIMI_TORRENT=0 ZIMI_OFFLINE=1 pytest tests/test_games_follow_language.py -v
"""

import json
import os
import socket
import subprocess
import sys
import urllib.request

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from games_wait import wait_for_server  # noqa: E402


@pytest.fixture(scope="module")
def zimi(tmp_path_factory):
    base = tmp_path_factory.mktemp("gameslang")
    (base / "zims").mkdir()
    (base / "data").mkdir()
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = dict(os.environ, ZIMI_TORRENT="0", ZIMI_OFFLINE="1", ZIMI_RATE_LIMIT="1000000", ZIM_DIR=str(base / "zims"), ZIMI_DATA_DIR=str(base / "data"))
    env.pop("ZIMI_BUILTIN_ZIMS", None)
    proc = subprocess.Popen([sys.executable, "-m", "zimi", "serve", "--port", str(port)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not wait_for_server(port):
            pytest.skip("zimi did not start")
        # A fresh install asks who may manage it: this one is open, as a test machine's is.
        urllib.request.urlopen(
            urllib.request.Request(
                "http://127.0.0.1:%d/manage/access" % port,
                data=json.dumps({"require_password": False, "remember": True, "open_confirm": True}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
        ).read()
        yield "http://127.0.0.1:%d/" % port
    finally:
        proc.terminate()


@pytest.mark.parametrize("lang,dir_", [("de", "ltr"), ("ar", "rtl")])
def test_the_games_open_in_the_language_zimi_shows(zimi, lang, dir_):
    with sync_playwright() as pw:
        br = pw.chromium.launch()
        try:
            ctx = br.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, locale="en-US")
            ctx.add_init_script("try{localStorage.setItem('zimi_ui_lang','%s')}catch(e){}" % lang)
            pg = ctx.new_page()
            pg.goto(zimi + "?a=zimi_games%2Findex.html")
            pg.wait_for_function(
                "(l) => { var d = document.getElementById('reader-frame').contentDocument; return !!(d && d.documentElement && d.documentElement.lang === l); }",
                arg=lang,
                timeout=30000,
            )
            got = pg.evaluate(
                "() => { var w = document.getElementById('reader-frame').contentWindow; return { hash: w.location.hash, lang: w.document.documentElement.lang, dir: w.document.documentElement.dir }; }"
            )
            assert "lang=" + lang in got["hash"] and "dir=" + dir_ in got["hash"], got
            assert got["lang"].startswith(lang) and got["dir"] == dir_, got
        finally:
            br.close()
