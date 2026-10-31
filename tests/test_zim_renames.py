"""A ZIM renamed upstream is still offered its update."""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as library  # noqa: E402
import zimi.renames as renames  # noqa: E402
import zimi.server as server  # noqa: E402

URL = "https://download.kiwix.org/zim/other/{}.zim.meta4"


def _item(name, title, lang, author, date, size=1_000, file=None):
    return {
        "name": name,
        "title": title,
        "language": lang,
        "author": author,
        "date": date,
        "size_bytes": size,
        "download_url": URL.format(file or f"{name}_{date[:7]}"),
    }


def _index(*items):
    return [([i["name"]], i["date"][:7], None, i) for i in items]


def _inst(prefix="oldname_en_all", **kw):
    return {
        "prefix": prefix,
        "date": "2026-01",
        "flavor": None,
        "title": "Scout Wiki",
        "language": "en",
        "size_bytes": 1_000,
        **kw,
    }


def test_table_hit():
    inst = _inst("www.ready.gov_en_all")
    new = _item("ready.gov_en_all", "Ready", "en", "FEMA", "2026-10-01")
    got = renames.find_successor(inst, _index(new))
    assert got[0] == "ready.gov_en_all" and got[1] == "2026-10"


def test_table_seeded_with_the_known_renames():
    assert renames.successor_name("scoutwiki_en_all") == "scoutwiki.org_en_all"
    assert renames.successor_name("nothing_en_all") == "nothing_en_all"


def test_fuzzy_hit():
    new = _item("newname_en_all", "Scout Wiki", "en", "Scouts", "2026-10-01")
    got = renames.find_successor(_inst(), _index(new), lambda: "Scouts")
    assert got[0] == "newname_en_all"


def test_not_renamed_when_old_name_still_in_catalog():
    cur = _item("oldname_en_all", "Scout Wiki", "en", "Scouts", "2026-10-01")
    assert renames.find_successor(_inst(), _index(cur), lambda: "Scouts") is None


@pytest.mark.parametrize(
    "item",
    [
        _item("newname_fr_all", "Scout Wiki", "fr", "Scouts", "2026-10-01"),
        _item("newname_en_all", "Scout Wiki", "en", "Someone Else", "2026-10-01"),
        _item("newname_en_all", "Other Title", "en", "Scouts", "2026-10-01"),
        _item("newname_en_all", "Scout Wiki", "en", "Scouts", "2026-10-01", 900_000),
    ],
)
def test_no_false_match(item):
    assert renames.find_successor(_inst(), _index(item), lambda: "Scouts") is None


def test_ambiguous_candidates_give_no_match():
    a = _item("a_en_all", "Scout Wiki", "en", "Scouts", "2026-10-01")
    b = _item("b_en_all", "Scout Wiki", "en", "Scouts", "2026-10-01")
    assert renames.find_successor(_inst(), _index(a, b), lambda: "Scouts") is None


def test_no_creator_no_match():
    new = _item("newname_en_all", "Scout Wiki", "en", "Scouts", "2026-10-01")
    assert renames.find_successor(_inst(), _index(new), lambda: "") is None


def test_check_updates_offers_the_renamed_zim(monkeypatch, tmp_path):
    old = "www.ready.gov_en_all_2026-05.zim"
    (tmp_path / old).write_bytes(b"")
    monkeypatch.setattr(server, "ZIM_DIR", str(tmp_path))
    monkeypatch.setattr(server, "get_zim_files", lambda: {"www.ready.gov": str(tmp_path / old)})
    monkeypatch.setattr(
        server,
        "_zim_list_cache",
        [{"name": "www.ready.gov", "title": "Ready", "language": "en", "size_bytes": 1_000}],
    )
    catalog = [_item("ready.gov_en_all", "Ready", "en", "FEMA", "2026-10-01")]
    monkeypatch.setattr(
        library, "_fetch_kiwix_catalog", lambda **kw: (len(catalog), list(catalog), None)
    )
    updates = library._check_updates()
    assert len(updates) == 1
    assert updates[0]["installed_file"] == old
    assert updates[0]["renamed_to"] == "ready.gov_en_all"
    assert updates[0]["latest_date"] == "2026-10"
    assert renames.replaced_by("ready.gov_en_all") == str(tmp_path / old)


def test_download_replaces_old_file_and_carries_settings(monkeypatch, tmp_path):
    old = tmp_path / "www.ready.gov_en_all_2026-05.zim"
    new = tmp_path / "ready.gov_en_all_2026-10.zim"
    old.write_bytes(b"x")
    new.write_bytes(b"y")
    moved = []
    monkeypatch.setattr(server, "ZIM_DIR", str(tmp_path))
    monkeypatch.setattr(server, "release_zim_handles", lambda names: None)
    monkeypatch.setattr(library, "_carry_zim_state", lambda a, b: moved.append((a, b)))
    monkeypatch.setattr(server, "register_zim_file", lambda *a, **k: True)
    for fn in ("_search_cache_clear", "_suggest_cache_clear", "_clean_stale_title_indexes"):
        monkeypatch.setattr(server, fn, lambda: None)
    monkeypatch.setattr(server, "_build_all_qid_indexes", lambda: None)
    monkeypatch.setattr(server, "_append_history", lambda e: None)
    monkeypatch.setattr(library, "_record_download_activity", lambda *a, **k: None)
    library._post_download_finalize(
        {"filename": new.name, "dest": str(new), "replaces": str(old), "is_update": True}
    )
    assert not old.exists() and new.exists()
    assert moved and moved[0][0] == "www.ready.gov"


def test_fieldguide_finds_the_renamed_zim():
    from zimi import fieldguide

    rx = fieldguide._piece_re("ready")
    assert fieldguide._is_piece(rx, "ready.gov")
    assert not fieldguide._is_piece(rx, "other")
