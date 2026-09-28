"""ZimiTube beyond video ZIMs: the videos and audiobooks in Kiwix's document
libraries (nautiluszim's database.js), and a folder of videos or audio that
Zimi packaged. Fixtures keep each family's real listing and paths
(tube_sources_fixture.py).

Run: pytest tests/test_tube_sources.py -v
"""

import json
import os
import sys

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import tube_sources_fixture as F  # noqa: E402
from books_sources_fixture import WATER_DATABASE, build_zim  # noqa: E402

import zimi.server as srv  # noqa: E402
from zimi import nautilus, tube  # noqa: E402

HOME = ("text/html", "<html><body><h1>Home</h1></body></html>", "Home")


def _library_of(database, files, **extra):
    """A nautilus library's entries: its listing, its home page, ``files``
    under ``files/`` with the mimetype of each."""
    entries = {
        "home.html": HOME,
        "database.js": ("application/javascript", database, ""),
    }
    for item in nautilus.parse(database):
        for path in nautilus.files_of(item):
            mime = {"video": "video/mp4", "audio": "audio/ogg"}.get(
                nautilus.ext_kind(path), "application/pdf"
            )
            if path.endswith(".webm"):
                mime = "video/webm"
            body = {"video/mp4": F.MP4, "video/webm": F.WEBM, "audio/ogg": F.OGG}.get(
                mime, F.PDF
            )
            entries[path] = (mime, body, "")
    for path in files.get("drop", ()):
        entries.pop(path, None)
    entries.update(extra)
    return entries


LUCAS = (
    "maitre_lucas_compter_jusque_10_fr_2023-05.zim",
    F.LUCAS_META,
    lambda: _library_of(F.LUCAS_DATABASE, {}),
)
AUDIOBOOKS = (
    "youscribe_fr_audiobooks_2023-03.zim",
    F.AUDIOBOOKS_META,
    lambda: _library_of(F.AUDIOBOOKS_DATABASE, {}),
)


def _load(tmp_path, monkeypatch, zims):
    zdir = tmp_path / "zims"
    zdir.mkdir(exist_ok=True)
    for filename, meta, entries in zims:
        build_zim(
            str(zdir / filename),
            meta,
            entries() if callable(entries) else entries,
            main_path="home.html",
        )
    _serve(tmp_path, monkeypatch, zdir)
    return zdir


def _serve(tmp_path, monkeypatch, zdir):
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    tube._reset_for_tests()
    # The pools are keyed by name, and every test's library reuses one.
    for pool in (srv._archive_pool, srv._suggest_pool, srv._fts_pool):
        pool.clear()
    srv.load_cache(force=True)


def _entry(name):
    return next(z for z in srv._zim_list_cache if z["name"] == name)


def _cards(**kw):
    return tube.feed(limit=500, **kw)["items"]


# ── Kiwix's document libraries ──────────────────────────────────────────────


def test_a_document_librarys_video_is_a_card_and_its_worksheets_are_not(
    tmp_path, monkeypatch
):
    """maitre_lucas: twelve PDF worksheets for the Bookshelf, one video for
    ZimiTube, one card, named and described as the listing names it."""
    _load(tmp_path, monkeypatch, [LUCAS])
    name = "maitre_lucas_compter_jusque_10_fr"
    assert (
        _entry(name).get("kind") in (None, "")
        and _entry(name)["feeds"]["tube"] == "nautilus"
    )
    cards = _cards()
    assert len(cards) == 1
    v = cards[0]
    assert v["title"] == "Nombres en lettres jusqu'à 10 CP - CE1 - Cycle 2"
    assert v["speaker"] == "Maître Lucas" and v["zim"] == name
    assert v["page"] == F.LUCAS_VIDEO and v["description"].startswith("Cette vidéo")
    assert not v["audio"] and "tracks" not in v


def test_a_video_from_a_document_library_plays_its_file(tmp_path, monkeypatch):
    """No page per item: the file is the page, played as itself, its type
    the ZIM's own, never read whole to look for a <video> in it."""
    _load(tmp_path, monkeypatch, [LUCAS])
    got = tube.playback("maitre_lucas_compter_jusque_10_fr", F.LUCAS_VIDEO)
    assert got["media"] == [{"path": F.LUCAS_VIDEO, "type": "video/mp4"}]
    assert got["missing"] is False and "audio" not in got and "tracks" not in got
    assert got["description"].startswith("Cette vidéo")


def test_an_audiobook_is_one_card_and_plays_its_tracks_in_turn(tmp_path, monkeypatch):
    """youscribe's audiobooks: one item per book, its chapters a list of
    .ogg files. One card each, marked as sound, the tracks named from the
    files with what they all share taken off."""
    _load(tmp_path, monkeypatch, [AUDIOBOOKS])
    name = "youscribe_fr_audiobooks"
    cards = {v["title"]: v for v in _cards()}
    assert set(cards) == {"Le Chien des Baskerville", "Le Chat Botté"}
    hound, cat = cards["Le Chien des Baskerville"], cards["Le Chat Botté"]
    assert (
        hound["audio"] is True
        and hound["tracks"] == 8
        and hound["speaker"] == "Arthur Conan Doyle"
    )
    assert cat["audio"] is True and "tracks" not in cat
    got = tube.playback(name, hound["page"])
    assert got["audio"] is True and got["media"] == [
        {"path": hound["page"], "type": "audio/ogg"}
    ]
    assert [t["title"] for t in got["tracks"]][:3] == [
        "01 a 03",
        "04 et 05",
        "06 et 07",
    ]
    assert got["tracks"][-1] == {
        "path": "files/2909454_Doyle___Le_chien_des_Baskerville_15.ogg",
        "title": "15",
    }
    one = tube.playback(name, cat["page"])
    assert one["audio"] is True and "tracks" not in one


def test_a_track_the_zim_lacks_is_left_out(tmp_path, monkeypatch):
    lacking = "files/2909454_Doyle___Le_chien_des_Baskerville_12.ogg"
    _load(
        tmp_path,
        monkeypatch,
        [
            (
                AUDIOBOOKS[0],
                AUDIOBOOKS[1],
                _library_of(F.AUDIOBOOKS_DATABASE, {"drop": [lacking]}),
            )
        ],
    )
    hound = next(v for v in _cards() if v["title"] == "Le Chien des Baskerville")
    assert hound["tracks"] == 7, "the card counts the tracks there are"
    tracks = tube.playback("youscribe_fr_audiobooks", hound["page"])["tracks"]
    assert len(tracks) == 7 and lacking not in [t["path"] for t in tracks]


def test_webm_from_a_document_library_names_the_zims_own_decoder(tmp_path, monkeypatch):
    """zaya and diksha carry WebM, which an iPhone cannot decode; nautilus
    ships ogv.js under vendors/, and the player is told where."""
    zaya = _library_of(
        F.ZAYA_DATABASE,
        {},
        **{"vendors/ogvjs/ogv.js": ("application/javascript", "var OGVPlayer;", "")},
    )
    _load(
        tmp_path,
        monkeypatch,
        [("zaya-english-duniya-marathi_mr_2020-11.zim", F.ZAYA_META, zaya)],
    )
    cards = _cards()
    assert [v["title"] for v in cards] == [
        "Grammar concept - Common noun Vs Proper noun",
        "Grammar concept - Countable Vs Uncountable nouns",
    ]
    got = tube.playback("zaya-english-duniya-marathi_mr", cards[0]["page"])
    assert got["ogv"] == "vendors/ogvjs" and got["media"][0]["type"] == "video/webm"


def test_two_libraries_numbering_items_alike_are_two_cards(tmp_path, monkeypatch):
    """Every nautilus library numbers its items from 00000; the feed keeps
    one card per id, so an id is the library's own."""
    renumbered = F.LUCAS_DATABASE.replace("'00010'", "'00002'")
    _load(
        tmp_path,
        monkeypatch,
        [AUDIOBOOKS, (LUCAS[0], LUCAS[1], _library_of(renumbered, {}))],
    )
    titles = {v["title"] for v in _cards()}
    assert {
        "Le Chien des Baskerville",
        "Nombres en lettres jusqu'à 10 CP - CE1 - Cycle 2",
    } <= titles
    ids = [v["id"] for v in _cards()]
    assert len(ids) == len(set(ids)) == 3


def test_a_library_of_documents_only_is_not_in_zimitube(tmp_path, monkeypatch):
    water = {
        "home.html": HOME,
        "database.js": ("application/javascript", WATER_DATABASE, ""),
    }
    water.update(
        {f"files/Water ({i}).pdf": ("application/pdf", F.PDF, "") for i in range(1, 8)}
    )
    _load(
        tmp_path,
        monkeypatch,
        [
            (
                "zimgit-water_en_2024-08.zim",
                {"Name": "zimgit-water_en", "Scraper": "nautiluszim 1.1.1"},
                water,
            )
        ],
    )
    assert "tube" not in (_entry("zimgit-water").get("feeds") or {})
    assert _cards() == [] and tube.videos_for("zimgit-water") == []


# ── Zimi's own folder of videos or audio ────────────────────────────────────


def _media_folder(root):
    (root / "talks").mkdir(parents=True)
    (root / "season2").mkdir()
    (root / "songs").mkdir()
    (root / "talks" / "intro.mp4").write_bytes(F.MP4)
    (root / "talks" / "intro.jpg").write_bytes(b"\xff\xd8\xff\xe0JFIF")
    (root / "season2" / "intro.mp4").write_bytes(F.MP4)
    (root / "songs" / "Le_chant_des_partisans.mp3").write_bytes(b"ID3\x04\x00")
    (root / "README.md").write_text("# Family videos\n", encoding="utf-8")
    return root


def test_a_folder_of_videos_writes_the_list_zimitube_reads(tmp_path, monkeypatch):
    """`zimi create <folder>` of videos and audio: a videos.json in the
    shape Zimi's video ZIMs keep, one row per file, a picture with the
    file's name as its poster, and the ZIM in ZimiTube."""
    from libzim.reader import Archive

    from zimi.creator import create_folder_zim

    zdir = tmp_path / "zims"
    zdir.mkdir()
    out = create_folder_zim(
        str(_media_folder(tmp_path / "Family videos")), out_dir=str(zdir)
    )
    rows = json.loads(
        bytes(Archive(out["path"]).get_entry_by_path("videos.json").get_item().content)
    )
    by_page = {r["page"]: r for r in rows}
    assert set(by_page) == {
        "talks/intro.mp4",
        "season2/intro.mp4",
        "songs/Le_chant_des_partisans.mp3",
    }
    assert (
        by_page["talks/intro.mp4"]["thumb"] == "talks/intro.jpg"
        and by_page["season2/intro.mp4"]["thumb"] == ""
    )
    assert (
        by_page["songs/Le_chant_des_partisans.mp3"]["title"] == "Le chant des partisans"
    )
    assert by_page["songs/Le_chant_des_partisans.mp3"]["audio"] is True

    _serve(tmp_path, monkeypatch, zdir)
    name = next(z["name"] for z in srv._zim_list_cache)
    assert _entry(name)["feeds"]["tube"] == "folder"
    cards = {(v["title"], v["speaker"]): v for v in _cards()}
    # Two files called intro, in two folders: two cards.
    assert set(cards) == {
        ("intro", "talks"),
        ("intro", "season2"),
        ("Le chant des partisans", "songs"),
    }
    song = cards[("Le chant des partisans", "songs")]
    got = tube.playback(name, song["page"])
    assert got["audio"] is True and got["media"] == [
        {"path": song["page"], "type": "audio/mpeg"}
    ]
    assert tube.playback(name, "talks/intro.mp4")["poster"] == "talks/intro.jpg"


def test_a_folder_with_a_videos_json_of_its_own_keeps_it(tmp_path):
    from libzim.reader import Archive

    from zimi.creator import create_folder_zim

    folder = _media_folder(tmp_path / "mine")
    (folder / "videos.json").write_text('{"mine": true}', encoding="utf-8")
    out = create_folder_zim(str(folder), out_dir=str(tmp_path))
    assert json.loads(
        bytes(Archive(out["path"]).get_entry_by_path("videos.json").get_item().content)
    ) == {"mine": True}


def test_a_folder_of_videos_packaged_before_the_list_is_read_by_its_files(
    tmp_path, monkeypatch
):
    """A folder ZIM from 1.11 or earlier has no videos.json: its files are
    found by mimetype, the same rows the list would hold."""
    from zimi.zimwriter import history_record

    record = history_record(
        "created",
        "folder",
        'packaged the folder "clips"',
        counts={"pages": 1, "assets": 3},
    )
    old = {
        "index": ("text/html", "<html><body><h1>clips</h1></body></html>", "clips"),
        "clips/a.mp4": ("video/mp4", F.MP4, "a.mp4"),
        "clips/a.png": ("image/png", b"\x89PNG", "a.png"),
        "clips/b.ogg": ("audio/ogg", F.OGG, "b.ogg"),
    }
    zdir = tmp_path / "zims"
    zdir.mkdir()
    build_zim(
        str(zdir / "clips_2026-01.zim"),
        {
            "Name": "clips",
            "Scraper": "Zimi 1.11.0",
            "X-Zimi-History": json.dumps([record]),
        },
        old,
        main_path="index",
    )
    _serve(tmp_path, monkeypatch, zdir)
    cards = {v["page"]: v for v in _cards()}
    assert set(cards) == {"clips/a.mp4", "clips/b.ogg"}
    assert (
        cards["clips/a.mp4"]["thumb"] == "clips/a.png"
        and cards["clips/b.ogg"]["audio"] is True
    )


def test_a_zimi_video_zims_rows_say_whether_they_are_sound(tmp_path, monkeypatch):
    """`zimi create <video URL> --audio-only` keeps .m4a: its cards are
    audio cards too."""
    rows = [
        {
            "id": "a1",
            "title": "Talk",
            "page": "videos/a1",
            "media": "media/a1.m4a",
            "thumb": "thumbs/a1.jpg",
        },
        {
            "id": "v1",
            "title": "Film",
            "page": "videos/v1",
            "media": "media/v1.mp4",
            "thumb": "",
        },
    ]
    files = {
        "videos.json": ("application/json", json.dumps(rows), ""),
        "media/a1.m4a": ("audio/mp4", b"\x00\x00\x00\x18ftypM4A ", ""),
        "media/v1.mp4": ("video/mp4", F.MP4, ""),
        "index": HOME,
    }
    _load(
        tmp_path,
        monkeypatch,
        [
            (
                "chan.zim",
                {"Name": "chan", "Scraper": "Zimi 1.10.0 + yt-dlp 2026.07.04"},
                dict(files, **{"home.html": HOME}),
            )
        ],
    )
    cards = {v["id"]: v for v in _cards()}
    assert cards["a1"]["audio"] is True and cards["v1"]["audio"] is False
