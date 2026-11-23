"""Storage's "Older copies": Delete removes exactly the file listed, never another file of the same name.

Run: pytest tests/test_older_copies_delete.py -v
"""

import json
import os
import sys
import threading
import urllib.error
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as srv  # noqa: E402
from conftest_zim import build_fixture_zim, split_fixture_zim  # noqa: E402


@pytest.fixture
def lib(tmp_path, monkeypatch):
    from http.server import ThreadingHTTPServer

    from zimi.http import ZimHandler

    zdir = tmp_path / "zims"
    zdir.mkdir()
    (tmp_path / "data").mkdir()
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield zdir, "http://127.0.0.1:%d" % httpd.server_address[1]
    httpd.shutdown()


def _zim(path, name, date):
    path.parent.mkdir(exist_ok=True)
    build_fixture_zim(str(path), {"Name": name, "Date": date})


def _post(base, filename):
    req = urllib.request.Request(
        base + "/manage/delete",
        data=json.dumps({"filename": filename}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _older(base):
    with urllib.request.urlopen(base + "/manage/tidy") as r:
        return {o["file"]: o for o in json.load(r)["older"]}


def test_an_older_copy_that_shares_its_name_with_the_served_file_is_deleted_alone(lib):
    zdir, base = lib
    _zim(zdir / "alpha_en_all_2026-01.zim", "alpha_en_all", "2026-01")
    _zim(zdir / "backup" / "alpha_en_all_2026-01.zim", "alpha_en_all", "2026-01")
    srv.load_cache(force=True)
    older = _older(base)
    assert list(older) == ["backup/alpha_en_all_2026-01.zim"]
    code, _ = _post(base, "backup/alpha_en_all_2026-01.zim")
    assert code == 200
    assert not (zdir / "backup" / "alpha_en_all_2026-01.zim").exists()
    assert (zdir / "alpha_en_all_2026-01.zim").exists(), "the file being served is still there"


def test_an_older_edition_one_folder_down_is_found_and_deleted(lib):
    zdir, base = lib
    _zim(zdir / "beta_en_all_2026-01.zim", "beta_en_all", "2026-01")
    _zim(zdir / "backup" / "beta_en_all_2025-01.zim", "beta_en_all", "2025-01")
    srv.load_cache(force=True)
    assert list(_older(base)) == ["backup/beta_en_all_2025-01.zim"]
    code, _ = _post(base, "backup/beta_en_all_2025-01.zim")
    assert code == 200
    assert not (zdir / "backup" / "beta_en_all_2025-01.zim").exists()
    assert (zdir / "beta_en_all_2026-01.zim").exists()


def test_a_superseded_split_book_is_listed_whole_and_deleted_chunk_by_chunk(lib):
    zdir, base = lib
    _zim(zdir / "gamma_en_all_2026-01.zim", "gamma_en_all", "2026-01")
    old = zdir / "gamma_en_all_2025-01.zim"
    _zim(old, "gamma_en_all", "2025-01")
    total = os.path.getsize(old)
    chunks = split_fixture_zim(str(old), max(total // 4, 1024))
    assert len(chunks) > 1
    srv.load_cache(force=True)
    older = _older(base)
    assert list(older) == ["gamma_en_all_2025-01.zim"]
    assert older["gamma_en_all_2025-01.zim"]["size_bytes"] == total
    code, _ = _post(base, "gamma_en_all_2025-01.zim")
    assert code == 200
    assert not any(os.path.exists(c) for c in chunks)
    assert (zdir / "gamma_en_all_2026-01.zim").exists()


def test_a_path_never_falls_back_to_another_file_and_never_deletes_what_is_served(lib):
    zdir, base = lib
    _zim(zdir / "delta_en_all_2026-01.zim", "delta_en_all", "2026-01")
    srv.load_cache(force=True)
    assert _post(base, "backup/delta_en_all_2026-01.zim")[0] == 404
    assert _post(base, "../delta_en_all_2026-01.zim")[0] == 400
    assert (zdir / "delta_en_all_2026-01.zim").exists()
