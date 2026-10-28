"""A copy of one of Zimi's own ZIMs that someone put in their library (a
zimi_games_2026-10.zim from a release page, say) is an ordinary ZIM: only the
package's file (zimi/builtin) is Zimi's own. The package's file serves the
name unless the copy is a strictly newer edition; Delete on a served copy
deletes the file for good; removing the package's file lets the copy show.

Run: pytest tests/test_own_zim_copy.py -v
"""

import os
import shutil
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as srv  # noqa: E402
from zimi import manage, ownzims  # noqa: E402
from test_own_zim_remove import _call, served  # noqa: E402,F401  (the fixture)

pytestmark = pytest.mark.skipif(
    not all(ownzims.zim_path(o) for o in ownzims.OWN), reason="the own ZIMs are not built"
)


def _games_file():
    return ownzims.zim_path(ownzims.OWN[0])


def _copy_in(name):
    dest = os.path.join(srv.ZIM_DIR, name)
    shutil.copyfile(_games_file(), dest)
    srv.load_cache(force=True)
    return dest


def _path():
    return srv.get_zim_files().get("zimi_games")


def test_the_package_file_holds_the_name_against_a_same_month_copy_and_an_older_one(served):
    for name in (os.path.basename(_games_file()), "zimi_games_2020-01.zim"):
        copy = _copy_in(name)
        assert ownzims.is_own_path(_path()), name
        os.remove(copy)


def test_a_strictly_newer_copy_is_served_as_an_ordinary_zim(served):
    copy = _copy_in("zimi_games_2099-01.zim")
    assert _path() == copy and not ownzims.is_own_path(_path())
    assert ownzims.category_of(_path()) is None, "not Home's Zimi section: an ordinary ZIM"
    os.remove(copy)
    srv.load_cache(force=True)
    assert ownzims.is_own_path(_path()), "gone, the package's file serves again"


def test_delete_of_a_served_copy_deletes_it_and_it_stays_gone(served):
    copy = _copy_in("zimi_games_2099-01.zim")
    code, d = _call(served, "/manage/delete", {"filename": "zimi_games_2099-01.zim"})
    assert code == 200 and "own" not in d
    assert not os.path.exists(copy)
    srv.load_cache(force=True)
    assert ownzims.is_own_path(_path()), "no copy returned on the rescan"
    assert ownzims.removed() == frozenset(), "the package's file was not marked removed"


def test_the_copy_beside_the_package_file_is_deleted_after_the_package_file_is_removed(served):
    name = os.path.basename(_games_file())
    copy = _copy_in(name)
    code, d = _call(served, "/manage/delete", {"filename": name})
    assert code == 200 and d["own"] == "zimi_games", "the served file is the package's"
    assert os.path.exists(copy) and os.path.exists(_games_file())
    assert _path() == copy, "removed, the copy is an ordinary ZIM under the name"
    code, d = _call(served, "/manage/delete", {"filename": name})
    assert code == 200 and "own" not in d and not os.path.exists(copy)
    srv.load_cache(force=True)
    assert "zimi_games" not in srv.get_zim_files()
    assert os.path.exists(_games_file()), "the package's file is never deleted"


def test_removing_the_package_file_by_name_leaves_the_copy_in_the_library(served):
    copy = _copy_in(os.path.basename(_games_file()))
    assert _call(served, "/manage/own-zims", {"name": "zimi_games", "removed": True})[0] == 200
    assert _path() == copy


def test_two_changes_at_once_are_both_kept(served, monkeypatch):
    real = manage._write_app_update_prefs

    def slow(**kw):
        time.sleep(0.1)  # between one change's read and its write
        return real(**kw)

    monkeypatch.setattr(manage, "_write_app_update_prefs", slow)
    names = [o.name for o in ownzims.OWN]
    threads = [threading.Thread(target=ownzims.set_removed, args=(n, True)) for n in names]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert ownzims.removed() == set(names)


def test_the_catalog_opens_each_file_once(served, monkeypatch):
    import libzim.reader

    opened = []

    real = libzim.reader.Archive

    def Counting(path, *a, **k):
        opened.append(path)
        return real(path, *a, **k)

    monkeypatch.setattr(libzim.reader, "Archive", Counting)
    ownzims._rows_cache.clear()
    first = ownzims.catalog()
    for _ in range(5):
        assert ownzims.catalog() == first
    assert len(opened) == len(ownzims.OWN) and first[0]["title"] and first[0]["icon"]
    ownzims.set_removed("zimi_games", True)
    assert {r["name"]: r["installed"] for r in ownzims.catalog()}["zimi_games"] is False
    assert len(opened) == len(ownzims.OWN), "installed is read live, the file once"
