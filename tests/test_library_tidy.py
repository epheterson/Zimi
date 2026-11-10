"""One Almanac, one Games: the library lists a thing once.

Eric, 2026-11-09: "There's too many copies of the zim when I go to library." Zimi's own content alone was listed as the
built-in Almanac and Games, an old Almanac HD core, an old maxi, the new maxi, four HD parts and two trial copies.

- the same name with an older date is superseded: served by the newer file only, shown as an older copy kept
- a ZIM whose Name metadata is an own ZIM's is that ZIM: listed once, the package's file winning unless the copy is newer
- a ZIM that only looks alike is left alone
- data packs are not library rows; the Almanac HD row holds them and their sizes
- nothing is deleted or moved by any of this

Run: pytest tests/test_library_tidy.py -v
"""

import os
import sys
import threading

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import zimi.server as srv  # noqa: E402
from conftest_zim import build_fixture_zim  # noqa: E402
from zimi import almanachd, ownzims  # noqa: E402

ALMANAC_META = {
    "Name": "zimi_eng_zimi_almanac",
    "Title": "Almanac · Zimi",
    "Publisher": "Zimi",
    "Date": "2026-11-08",
}


@pytest.fixture
def lib(tmp_path, monkeypatch):
    """A library folder and a package folder holding the built-in Almanac; returns the library's path."""
    zdir, pkg = tmp_path / "zims", tmp_path / "pkg"
    zdir.mkdir()
    pkg.mkdir()
    (tmp_path / "data").mkdir()
    build_fixture_zim(str(pkg / "zimi_almanac_2026-11b.zim"), ALMANAC_META)
    monkeypatch.setenv("ZIMI_BUILTIN_ZIMS", "1")
    monkeypatch.setattr(ownzims, "OUT_DIR", str(pkg))
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    return zdir


def _scan():
    srv.load_cache(force=True)
    return srv.get_zim_files()


def _own_path(name="zimi_almanac_2026-11b.zim"):
    return os.path.join(ownzims.OUT_DIR, name)


def test_a_copy_of_an_own_zim_under_another_file_name_is_listed_once(lib):
    copy = lib / "zimi_eng_zimi_almanac_2026-11.zim"
    build_fixture_zim(str(copy), dict(ALMANAC_META, Date="2026-11"))
    zims = _scan()
    assert zims["zimi_almanac"] == _own_path()
    assert "zimi_eng_zimi_almanac" not in zims
    # It is shown as an older copy kept, and still on disk.
    older = srv.older_copies()
    assert [(o["file"], o["replaced_by"]) for o in older] == [
        ("zimi_eng_zimi_almanac_2026-11.zim", "zimi_almanac_2026-11b.zim")
    ]
    assert copy.exists()


def test_a_strictly_newer_copy_takes_the_name(lib):
    copy = lib / "zimi_eng_zimi_almanac_2026-12.zim"
    build_fixture_zim(str(copy), dict(ALMANAC_META, Date="2026-12-01"))
    zims = _scan()
    assert zims["zimi_almanac"] == str(copy)
    assert "zimi_eng_zimi_almanac" not in zims
    # The package's file is never offered for removal.
    assert srv.older_copies() == []


def test_the_same_day_is_not_newer(lib):
    build_fixture_zim(
        str(lib / "zimi_eng_zimi_almanac_2026-11.zim"),
        dict(ALMANAC_META, Date="2026-11-08"),
    )
    assert _scan()["zimi_almanac"] == _own_path()


def test_a_zim_that_only_looks_alike_is_left_alone(lib):
    other = lib / "zimi_almanac_notes_2026-11.zim"
    build_fixture_zim(
        str(other),
        {
            "Name": "zimi_almanac_notes",
            "Title": "My almanac notes",
            "Date": "2026-11-09",
        },
    )
    zims = _scan()
    assert zims["zimi_almanac_notes"] == str(other)
    assert zims["zimi_almanac"] == _own_path()
    assert srv.older_copies() == []


def test_a_file_name_alone_does_not_make_a_copy(lib):
    # Called like the own ZIM, but another Name: not it.
    other = lib / "zimi_eng_zimi_almanac_2026-11.zim"
    build_fixture_zim(
        str(other), {"Name": "somebody_elses", "Title": "Other", "Date": "2026-11"}
    )
    zims = _scan()
    assert zims["zimi_eng_zimi_almanac"] == str(other)


def test_a_renamed_copy_is_caught_by_its_metadata_not_its_file_name(lib):
    copy = lib / "my_almanac_backup_2026-11.zim"
    build_fixture_zim(str(copy), dict(ALMANAC_META, Date="2026-11"))
    zims = _scan()
    assert zims["zimi_almanac"] == _own_path()
    assert "my_almanac_backup" not in zims
    assert [o["file"] for o in srv.older_copies()] == ["my_almanac_backup_2026-11.zim"]


def test_the_name_comes_from_the_metadata_cache_once_it_is_there(lib, monkeypatch):
    copy = lib / "my_almanac_backup_2026-11.zim"
    build_fixture_zim(str(copy), dict(ALMANAC_META, Date="2026-11"))
    _scan()  # reads it, and the cache keeps its Name
    ownzims._ident_cache.clear()
    assert srv.cached_identity(str(copy), os.stat(copy)) == ("zimi_eng_zimi_almanac", "2026-11")
    # A scan now opens no archive for it: the cache answers.
    import libzim.reader

    def refuse(*_a, **_k):
        raise AssertionError("opened an archive the cache already described")

    monkeypatch.setattr(libzim.reader, "Archive", refuse)
    assert ownzims.identity(str(copy)) == ("zimi_eng_zimi_almanac", "2026-11")
    # A changed file is not described by the old record.
    os.utime(copy, (1, 1))
    assert srv.cached_identity(str(copy), os.stat(copy)) is None


def test_the_same_name_with_an_older_date_is_superseded_and_kept_on_disk(lib):
    old, new = (
        lib / "zimi_almanac_maxi_2026-11.zim",
        lib / "zimi_almanac_maxi_2026-11b.zim",
    )
    build_fixture_zim(str(old), {"Name": "zimi_almanac_maxi", "Date": "2026-11"})
    build_fixture_zim(str(new), {"Name": "zimi_almanac_maxi", "Date": "2026-11"})
    zims = _scan()
    assert zims["zimi_almanac_maxi"] == str(new)
    assert str(old) not in zims.values()
    assert [(o["file"], o["replaced_by"]) for o in srv.older_copies()] == [
        ("zimi_almanac_maxi_2026-11.zim", "zimi_almanac_maxi_2026-11b.zim")
    ]
    assert old.exists() and new.exists()


def test_data_packs_are_one_almanac_hd_row_with_their_parts(lib):
    for fname, name in (
        ("zimi_almanac_maxi_2026-11b.zim", "zimi_almanac_maxi"),
        ("zimi_almanac_hd_moon_2026-11b.zim", "zimi_almanac_hd_moon"),
        ("zimi_almanac_hd_mars_2026-11b.zim", "zimi_almanac_hd_mars"),
    ):
        build_fixture_zim(str(lib / fname), {"Name": name})
    build_fixture_zim(str(lib / "wikipedia_en_all_2026-10.zim"), {"Name": "wikipedia"})
    _scan()
    row = almanachd.library_row()
    assert [p["name"] for p in row["packs"]] == [
        "zimi_almanac_maxi",
        "zimi_almanac_hd_moon",
        "zimi_almanac_hd_mars",
    ]
    assert row["size_bytes"] == sum(p["size_bytes"] for p in row["packs"]) and all(
        p["size_bytes"] > 0 for p in row["packs"]
    )
    assert [p["part"] for p in row["packs"]] == ["", "moon", "mars"]
    # Not rows of the library: what search and the listing walk leaves them out.
    assert set(srv.content_zims()) == {"wikipedia", "zimi_almanac"}
    assert not (set(srv.DATA_PACKS) & set(srv.content_zims()))


def test_the_counts_agree_with_what_is_listed(lib):
    from zimi import http

    build_fixture_zim(
        str(lib / "zimi_eng_zimi_almanac_2026-11.zim"),
        dict(ALMANAC_META, Date="2026-11"),
    )
    build_fixture_zim(
        str(lib / "zimi_almanac_hd_moon_2026-11b.zim"), {"Name": "zimi_almanac_hd_moon"}
    )
    build_fixture_zim(str(lib / "wikipedia_en_all_2026-10.zim"), {"Name": "wikipedia"})
    _scan()
    listed = [z["name"] for z in srv.list_zims() if z["name"] not in srv.DATA_PACKS]
    assert sorted(listed) == ["wikipedia", "zimi_almanac"]
    assert sorted(srv.content_zims()) == sorted(listed)
    assert http is not None


def test_nothing_on_disk_is_touched(lib):
    files = [
        "zimi_eng_zimi_almanac_2026-11.zim",
        "zimi_almanac_maxi_2026-11.zim",
        "zimi_almanac_maxi_2026-11b.zim",
    ]
    for f in files:
        build_fixture_zim(
            str(lib / f),
            (
                dict(ALMANAC_META, Date="2026-11")
                if "eng" in f
                else {"Name": "zimi_almanac_maxi"}
            ),
        )
    before = {f: (lib / f).stat() for f in files}
    _scan()
    srv.older_copies()
    for f in files:
        st = (lib / f).stat()
        assert (st.st_size, st.st_mtime_ns) == (
            before[f].st_size,
            before[f].st_mtime_ns,
        )
    assert sorted(os.listdir(lib)) == sorted(files)


# ── the Library at 390 px ────────────────────────────────────────────────


def _skip_without_browser():
    import zimi.renderer as renderer

    if not renderer.browser_available():
        pytest.skip("playwright + chromium are not usable here")


def test_the_library_at_390_lists_one_almanac_and_one_almanac_hd_row(lib):
    _skip_without_browser()
    from http.server import ThreadingHTTPServer

    from playwright.sync_api import sync_playwright

    from zimi.http import ZimHandler

    build_fixture_zim(
        str(lib / "zimi_eng_zimi_almanac_2026-11.zim"),
        dict(ALMANAC_META, Date="2026-11"),
    )
    build_fixture_zim(
        str(lib / "zimi_almanac_maxi_2026-11.zim"),
        {"Name": "zimi_almanac_maxi", "Date": "2026-11"},
    )
    build_fixture_zim(
        str(lib / "zimi_almanac_maxi_2026-11b.zim"),
        {"Name": "zimi_almanac_maxi", "Date": "2026-11"},
    )
    build_fixture_zim(
        str(lib / "zimi_almanac_hd_moon_2026-11b.zim"), {"Name": "zimi_almanac_hd_moon"}
    )
    build_fixture_zim(
        str(lib / "wikipedia_en_all_2026-10.zim"),
        {"Name": "wikipedia", "Title": "Wikipedia"},
    )
    srv.load_cache(force=True)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), ZimHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % httpd.server_address[1]
    try:
        with sync_playwright() as pw:
            br = pw.chromium.launch()
            ctx = br.new_context(
                viewport={"width": 390, "height": 844},
                has_touch=True,
                is_mobile=True,
                service_workers="block",
            )
            pg = ctx.new_page()
            pg.goto(base + "/")
            pg.wait_for_selector("#q")
            pg.evaluate("() => enterManage(null, 'library')")
            pg.get_by_text("Library", exact=True).first.click()
            pg.wait_for_selector(".ci-hd-group", timeout=30000)
            titles = pg.evaluate(
                "() => [...document.querySelectorAll('#manage-installed .ci-title')].map(e => e.innerText)"
            )
            assert len([t for t in titles if t.startswith("Almanac") and t != "Almanac HD"]) == 1, titles
            assert titles.count("Almanac HD") == 1, titles
            assert not [t for t in titles if "zimi_" in t], titles
            parts = pg.evaluate(
                "() => [...document.querySelectorAll('.ci-hd-part')].map(e => e.innerText)"
            )
            assert len(parts) == 2 and any("moon" in p for p in parts), parts
            # Older copies, with a remove, are in Settings > Server (Storage).
            pg.evaluate("() => enterManage(null, 'server')")
            pg.wait_for_selector("#ms-older .catalog-item", timeout=30000)
            older = pg.inner_text("#ms-older")
            assert (
                "zimi_almanac_maxi_2026-11.zim" in older
                and "zimi_eng_zimi_almanac_2026-11.zim" in older
            ), older
            assert pg.locator("#ms-older .ci-delete-btn").count() == 2
            br.close()
    finally:
        httpd.shutdown()
        srv.release_zim_handles(list(srv.get_zim_files()))
