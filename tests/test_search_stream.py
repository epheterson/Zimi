"""One search, one request (Eric, 2026-10-01: "Can we have searches hammer
the server less and not get to the point where we have to limit so much").

A typed search used to cost two /search requests (the title pass, then the
full text) and a /snippet per card on screen: 22 requests for one search on
a six-source library. /search?stream=1 answers with both passes and the
first screen's snippets in one response, a line of JSON each as it is ready.
These tests hold it to: the same results as the two passes asked apart, the
same snippets /snippet gives, one run of a search however many ask for it at
once, and a cache keyed by what a query asks rather than how it was typed.
"""

import gzip
import json
import os
import sys
import threading
import time
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SOURCES = ["alpha", "bravo", "charlie"]


def _build(path, name):
    from libzim.writer import Creator

    from conftest_zim import _Article

    with Creator(path).config_indexing(True, "eng") as c:
        c.set_mainpath("A/Water_0")
        for i in range(30):
            html = (
                "<html><head><meta name='description' content='About water %s %d.'>"
                "</head><body><h1>Water topic %d</h1><p>Water and rivers from %s,"
                " part %d.</p></body></html>" % (name, i, i, name, i)
            )
            c.add_item(
                _Article(
                    "A/Water_%d" % i, "Water topic %d %s" % (i, name), html.encode()
                )
            )
        c.add_metadata("Title", "Source " + name.capitalize())
        c.add_metadata("Language", "eng")
        c.add_metadata("Description", "fixture " + name)


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    from http.server import ThreadingHTTPServer

    import zimi.server as srv
    from zimi.http import ZimHandler

    tmp = tmp_path_factory.mktemp("stream")
    zdir = tmp / "zims"
    zdir.mkdir()
    for name in SOURCES:
        _build(str(zdir / ("%s_en_test.zim" % name)), name)
    old = (srv.ZIM_DIR, srv.ZIMI_DATA_DIR, os.environ.get("ZIMI_OFFLINE"))
    os.environ["ZIMI_OFFLINE"] = "1"
    srv.ZIM_DIR = str(zdir)
    srv.ZIMI_DATA_DIR = str(tmp / "data")
    os.makedirs(srv.ZIMI_DATA_DIR, exist_ok=True)
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()
    srv._search_cache_clear()
    srv.ZIM_DIR, srv.ZIMI_DATA_DIR = old[0], old[1]
    if old[2] is None:
        os.environ.pop("ZIMI_OFFLINE", None)
    else:
        os.environ["ZIMI_OFFLINE"] = old[2]


def _get(url, gz=False):
    req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip"} if gz else {})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            body = gzip.decompress(body)
        return r.headers, body


def _lines(served, q, gz=False, extra=""):
    headers, body = _get(
        served + "/search?q=%s&limit=10&stream=1%s" % (urllib.request.quote(q), extra),
        gz,
    )
    assert "ndjson" in headers.get("Content-Type", "")
    return [json.loads(line) for line in body.decode().splitlines() if line.strip()]


@pytest.mark.parametrize("gz", [False, True])
def test_one_request_carries_both_passes_and_the_first_screens_snippets(served, gz):
    import zimi.server as srv

    srv._search_cache_clear()
    lines = _lines(served, "water topic", gz)
    assert [ln["phase"] for ln in lines] == ["fast", "snippets", "full", "snippets"]
    fast, full = lines[0]["result"], lines[2]["result"]
    assert fast["partial"] is True and full["partial"] is False

    # The same results the two passes give asked apart.
    _, apart_fast = _get(served + "/search?q=water+topic&limit=10&fast=1")
    _, apart_full = _get(served + "/search?q=water+topic&limit=10")
    for got, apart in ((fast, json.loads(apart_fast)), (full, json.loads(apart_full))):
        assert [(r["zim"], r["path"], r["score"]) for r in got["results"]] == [
            (r["zim"], r["path"], r["score"]) for r in apart["results"]
        ]
        assert got["by_source"] == apart["by_source"]

    # Every card a first screen draws has its snippet, the one /snippet gives,
    # and none is sent twice.
    snippets = {**lines[1]["snippets"], **lines[3]["snippets"]}
    assert len(snippets) == len(lines[1]["snippets"]) + len(lines[3]["snippets"])
    for zim, path in srv.first_screen(full["results"]):
        got = snippets[zim + "\n" + path]
        assert got["snippet"].startswith("About water")
        _, one = _get(served + "/snippet?zim=%s&path=%s" % (zim, path))
        assert json.loads(one) == got


def test_the_title_pass_arrives_before_the_full_text_pass_ends(served, monkeypatch):
    """Streamed, not buffered: the first line is readable while the full-text
    pass is still running."""
    import zimi.server as srv

    srv._search_cache_clear()
    release = threading.Event()
    real = srv.search_all

    def held(q, limit=5, filter_zim=None, fast=False):
        if not fast:
            release.wait(10)
        return real(q, limit=limit, filter_zim=filter_zim, fast=fast)

    monkeypatch.setattr(srv, "search_all", held)
    r = urllib.request.urlopen(
        served + "/search?q=rivers&limit=10&stream=1", timeout=30
    )
    first = json.loads(r.readline())
    assert first["phase"] == "fast" and not release.is_set()
    release.set()
    rest = [json.loads(line) for line in r.read().decode().splitlines() if line]
    assert [ln["phase"] for ln in rest] == ["snippets", "full", "snippets"]


def test_identical_searches_at_once_run_once(served, monkeypatch):
    import zimi.server as srv

    srv._search_cache_clear()
    runs = []
    real = srv.search_all

    def slow(q, limit=5, filter_zim=None, fast=False):
        runs.append(fast)
        time.sleep(0.4)
        return real(q, limit=limit, filter_zim=filter_zim, fast=fast)

    monkeypatch.setattr(srv, "search_all", slow)
    out = []
    threads = [
        threading.Thread(target=lambda: out.append(_lines(served, "part water")))
        for _ in range(4)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(out) == 4
    assert sorted(runs) == [False, True], "each pass ran once for four asks: %r" % runs
    assert len({json.dumps(o[2]["result"]["results"]) for o in out}) == 1


def test_the_cache_knows_a_query_by_what_it_asks():
    import zimi.server as srv

    key = srv._search_cache_key
    assert key("Water   Topic", "", 10, False) == key("water topic", "", 10, False)
    assert key("“water topic”", "", 10, False) == key('"water topic"', "", 10, False)
    # "or" is a word; "OR" is a choice between two.
    assert key("cats OR dogs", "", 10, False) != key("cats or dogs", "", 10, False)
    assert key("water", "", 10, False) != key("water", "", 10, True)


def test_a_library_change_clears_what_was_kept_and_what_was_on_its_way():
    import zimi.server as srv
    from zimi import search

    srv._search_cache_clear()
    key = ("q", "", 5, False, 0, None)
    srv._search_cache_put(key, {"results": []})
    search._snippet_cache[("z", "p")] = {"snippet": "x"}
    srv._search_cache_clear()
    assert srv._search_cache_get(key) is None and not search._snippet_cache

    # A search that began before the change does not keep its answer after.
    def computed_across_a_change():
        srv._search_cache_clear()
        return {"results": ["old library"]}

    result, hit = srv.search_cached(key, computed_across_a_change)
    assert result == {"results": ["old library"]} and not hit
    assert srv._search_cache_get(key) is None

    # The library loaded again is in every key.
    gen = srv._cache_generation
    k1 = srv._search_cache_key("q", "", 5, False)
    srv._cache_generation = gen + 1
    try:
        assert srv._search_cache_key("q", "", 5, False) != k1
    finally:
        srv._cache_generation = gen


def test_a_plain_answer_still_comes_for_a_zim_that_is_not_here(served):
    try:
        _get(served + "/search?q=water&stream=1&zim=nope")
        raise AssertionError("expected a 404")
    except urllib.error.HTTPError as e:
        assert e.code == 404
        assert "not found" in json.loads(e.read())["error"]
