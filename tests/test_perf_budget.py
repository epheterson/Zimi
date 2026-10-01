"""What the home page costs before it paints, held to a budget, and the
static files it needs served without compressing them again per request.

The budget is the bytes a phone downloads for a cold home page from the
shell's own files (index.html's stylesheets and script, and the moon
texture app.js fetches as it starts), gzipped as the server sends them.
1.12 measured 569 KB; the budget leaves room for a release's growth and
fails on the kind of jump a second copy of a library or a 470 KB picture is.
"""

import gzip
import inspect
import os
import re

from zimi import http as H

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi")
STATIC = os.path.join(ROOT, "static")
HOME_FIRST_PAINT_BUDGET = 650 * 1000
MOON_TEXTURE_BUDGET = 120 * 1000


def _read(rel):
    with open(os.path.join(ROOT, rel), "rb") as f:
        return f.read()


def _first_paint_files():
    shell = _read("templates/index.html").decode()
    files = re.findall(r'(?:href|src)="/static/([\w.-]+\.(?:css|js))[?"]', shell)
    app = _read("static/app.js").decode()
    files += re.findall(r"_MOON_MAP_URL = '/static/([\w./-]+)'", app)
    return files


def _sent_bytes(name):
    body = _read("static/" + name)
    if H._compressible(H._srv.MIME_FALLBACK.get(os.path.splitext(name)[1], "")):
        return len(gzip.compress(body, compresslevel=H.GZIP_LEVEL))
    return len(body)


def test_the_home_page_first_paint_fits_its_budget():
    files = _first_paint_files()
    assert {"app.js", "app.css"} <= set(files), files
    sizes = {f: _sent_bytes(f) for f in files}
    assert sum(sizes.values()) <= HOME_FIRST_PAINT_BUDGET, sizes


def test_the_moon_texture_is_a_small_picture():
    moon = [f for f in _first_paint_files() if "moon" in f]
    assert moon == ["earth/moon-v1.webp"], moon
    assert _sent_bytes(moon[0]) <= MOON_TEXTURE_BUDGET


def test_a_static_body_is_compressed_once(monkeypatch):
    calls = []
    real = gzip.compress

    def counting(data, compresslevel=9):
        calls.append(len(data))
        return real(data, compresslevel=compresslevel)

    monkeypatch.setattr(H.gzip, "compress", counting)
    monkeypatch.setattr(H, "_gzip_memo_kept", {})
    body = b"var x = 1;\n" * 1000
    first = H._gzip_memo("app.js", body)
    again = H._gzip_memo("app.js", body)
    assert again is first and len(calls) == 1
    # A changed file is a new body: compressed afresh, never the old bytes.
    edited = b"var y = 2;\n" * 1000
    assert gzip.decompress(H._gzip_memo("app.js", edited)) == edited
    assert len(calls) == 2


def test_static_files_are_served_through_the_memo():
    src = inspect.getsource(H.ZimHandler._serve_static)
    assert "memo=rel_path" in src
    # app.js is one bytes object for the life of the server, so its memo holds.
    if H.APP_JS_REWRITTEN is not None:
        assert H._app_js_bytes() is H._app_js_bytes()
