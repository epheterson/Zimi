"""Zimi Tube: every video in the library, as one feed.

Run: pytest tests/test_tube.py -v
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as srv  # noqa: E402
from zimi import tube  # noqa: E402

TED_FILES = {
    "assets/data.js": (
        "json_data = "
        + json.dumps(
            [
                {"id": "117845", "slug": "the-world-s-rarest-diseases", "speaker": "  Greka",
                 "title": [{"lang": "default", "text": "The world's rarest diseases"}],
                 "description": [{"lang": "default", "text": "Anna Greka on rare disease."}], "languages": ["en"]},
                {"id": "13316", "slug": "why-tech-needs-the-humanities", "speaker": "Eric Berridge",
                 "title": [{"lang": "en", "text": "Why tech needs the humanities"}],
                 "description": [{"lang": "en", "text": "Berridge on hiring."}], "languages": ["en"]},
            ]
        )
        + ";"
    ).encode(),
    "videos/117845/thumbnail.webp": b"RIFF....WEBP",
    "videos/13316/thumbnail.webp": b"RIFF....WEBP",
}

ZIMI_INDEX = (
    b"<html><body><ol class='zimi-index'>"
    b"<li class='zimi-vid'><a href='videos/abc'><img src='thumbs/abc.jpg' alt=''></a><div><a href='videos/abc'>First &amp; best</a>"
    b"<br><span class='zimi-vid-meta'>Some Channel \xc2\xb7 12:34 \xc2\xb7 2026-01-02</span></div></li>"
    b"<li class='zimi-vid'><div><a href='videos/def'>Second</a></div></li>"
    b"</ol></body></html>"
)

YT_FILES = {
    "videos.json": json.dumps(
        [{"id": "x1", "slug": "hello-world", "title": "Hello world", "thumbnailPath": "videos/x1/video.webp",
          "duration": 61, "publicationDate": "2025-05-05T00:00:00", "author": {"channelTitle": "Chan"}}]
    ).encode(),
}


def _library(tmp_path, monkeypatch, zims):
    from conftest_zim import build_fixture_zim

    zdir = tmp_path / "zims"
    zdir.mkdir()
    for filename, metadata, files in zims:
        build_fixture_zim(str(zdir / filename), metadata, files=files)
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    tube._reset_for_tests()
    srv.load_cache(force=True)


# ── what is a video ZIM ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "scraper,tags,expected",
    [
        ("ted2zim 2.0.13", "_category:ted;ted;_videos:yes", "video"),
        ("youtube2zim 2.3.0", "_videos:yes", "video"),
        ("Zimi 1.10.0 + yt-dlp 2026.07.04", "_videos:yes", "video"),
        ("mwoffliner 1.13", "wikipedia;_videos:yes", None),  # Wikipedia has videos; it is not a video ZIM
        ("maps2zim v0.2.1", "", "map"),
        ("Zimi 1.10.0", "", None),
    ],
)
def test_a_video_zim_is_known_by_its_scraper_not_its_tag(scraper, tags, expected):
    assert srv._zim_kind(scraper, tags, "") == expected


def test_a_record_decided_before_video_existed_is_read_once_more(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, [("ted_en_x_2023-09.zim", {"Scraper": "ted2zim 2.0.13"}, TED_FILES)])
    cache_path = srv._cache_file_path()
    with open(cache_path, encoding="utf-8") as f:
        payload = json.load(f)
    rec = payload["files"]["ted_en_x_2023-09.zim"]
    assert rec["kind"] == "video" and rec["kind_v"] == srv.KIND_VERSION
    rec["kind"] = ""  # what 1.10's first builds wrote for a TED ZIM
    del rec["kind_v"]
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    srv.load_cache(force=False)
    z = next(z for z in srv._zim_list_cache if z["file"] == "ted_en_x_2023-09.zim")
    assert z.get("kind") == "video"


# ── the readers ────────────────────────────────────────────────────────────


def test_ted_talks_come_from_the_data_file(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, [("ted_en_x_2023-09.zim", {"Scraper": "ted2zim 2.0.13"}, TED_FILES)])
    rows = tube.videos_for("ted_en_x")
    assert [r["title"] for r in rows] == ["The world's rarest diseases", "Why tech needs the humanities"]
    assert rows[0]["page"] == "the-world-s-rarest-diseases" and rows[0]["thumb"] == "videos/117845/thumbnail.webp"
    assert rows[0]["speaker"] == "Greka" and rows[0]["description"].startswith("Anna Greka")


def test_zimis_own_rows_come_from_videos_json_or_the_index_page(tmp_path, monkeypatch):
    own = [{"id": "abc", "title": "From JSON", "description": "", "speaker": "Ch", "thumb": "thumbs/abc.jpg", "page": "videos/abc", "duration": 61, "date": "2026-01-02"}]
    _library(
        tmp_path, monkeypatch,
        [
            ("with-json.zim", {"Scraper": "Zimi 1.10.0 + yt-dlp 2026.07.04", "Name": "withjson"}, {"videos.json": json.dumps(own).encode()}),
        ],
    )
    assert [r["title"] for r in tube.videos_for("with-json")] == ["From JSON"]


def test_the_index_page_reader_parses_the_rows():
    class _It:
        def __init__(self, b): self.content = b
    class _E:
        is_redirect = False
        def get_item(self): return _It(ZIMI_INDEX)
    class _A:
        main_entry = _E()
        def get_entry_by_path(self, p): raise KeyError(p)
    rows = tube._zimi(_A())
    assert [(r["title"], r["page"], r["thumb"], r["speaker"], r["duration"], r["date"]) for r in rows] == [
        ("First & best", "videos/abc", "thumbs/abc.jpg", "Some Channel", "12:34", "2026-01-02"),
        ("Second", "videos/def", "", "", None, ""),
    ]


def test_youtube2zim_rows_come_from_videos_json(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, [("yt.zim", {"Scraper": "youtube2zim 2.3.0", "Name": "yt_chan"}, YT_FILES)])
    rows = tube.videos_for("yt")
    assert rows == [{"id": "x1", "title": "Hello world", "description": "", "speaker": "Chan", "thumb": "videos/x1/video.webp", "page": "hello-world", "duration": 61, "date": "2025-05-05"}]


def test_not_a_video_zim_has_no_videos(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, [("survival_en_2026-06.zim", None, {})])
    assert tube.videos_for("survival") == []
    assert tube.feed() == {"items": [], "total": 0, "sources": 0, "zims": []}


# ── the feed ───────────────────────────────────────────────────────────────


def test_the_feed_interleaves_sources_and_a_query_keeps_every_word(tmp_path, monkeypatch):
    own = [{"id": str(i), "title": f"Own {i}", "description": "", "speaker": "Me", "thumb": "", "page": f"videos/{i}", "duration": None, "date": ""} for i in range(3)]
    _library(
        tmp_path, monkeypatch,
        [
            ("ted_en_x_2023-09.zim", {"Scraper": "ted2zim 2.0.13"}, TED_FILES),
            ("own.zim", {"Scraper": "Zimi 1.10.0 + yt-dlp 2026.07.04", "Name": "own"}, {"videos.json": json.dumps(own).encode()}),
        ],
    )
    f = tube.feed()
    assert f["total"] == 5 and f["sources"] == 2
    assert [(z["name"], z["count"], z["icon"]) for z in f["zims"]] == [("own", 3, False), ("ted_en_x", 2, False)]
    assert all("zim_icon" in v for v in f["items"])
    assert [v["zim"] for v in f["items"]] == ["own", "ted_en_x", "own", "ted_en_x", "own"]
    assert f["items"][1]["zim_title"] == "Test Survival"  # the fixture's Title
    q = tube.feed("greka rare")
    assert [v["title"] for v in q["items"]] == ["The world's rarest diseases"]
    assert tube.feed("nothing-here")["total"] == 0
    page = tube.feed(limit=2, offset=2)
    assert [v["title"] for v in page["items"]] == ["Own 1", "Why tech needs the humanities"] and page["total"] == 5


def test_the_route_is_rate_limited_as_an_api_path():
    from zimi import http

    assert "/tube" in http._RATE_LIMITED_API_PATHS


# ── the player: media behind a page ────────────────────────────────────────

TED_PAGE = (
    b"<html><body><p id='speaker'>  Berridge</p><video class='video-js' controls poster='videos/13316/thumbnail.webp'>"
    b"<source src='videos/13316/video.webm' type='video/webm' />"
    b"<track kind='subtitles' src='videos/13316/subs/subs_en.vtt' srclang='en' label='English' />"
    b"<track kind='subtitles' src='videos/13316/subs/subs_fr.vtt' srclang='fr' label='French' /></video></body></html>"
)


def test_playback_reads_the_media_and_tracks_behind_the_page(tmp_path, monkeypatch):
    files = dict(TED_FILES)
    files["why-tech-needs-the-humanities"] = TED_PAGE
    # Its own ZIM name: the archive pool keeps an archive per name for the
    # life of the process, and an earlier test's ted_en_x has no such page.
    _library(tmp_path, monkeypatch, [("ted_en_play_2023-09.zim", {"Scraper": "ted2zim 2.0.13", "Name": "ted_en_play"}, files)])
    got = tube.playback("ted_en_play", "why-tech-needs-the-humanities")
    assert got == {
        "media": [{"path": "videos/13316/video.webm", "type": "video/webm"}],
        "subs": [
            {"path": "videos/13316/subs/subs_en.vtt", "lang": "en", "label": "English"},
            {"path": "videos/13316/subs/subs_fr.vtt", "lang": "fr", "label": "French"},
        ],
        "poster": "videos/13316/thumbnail.webp",
        "page": "why-tech-needs-the-humanities",
        "ogv": "",
    }


def test_playback_names_the_zims_own_decoder_when_it_ships_one(tmp_path, monkeypatch):
    """TED's videos are WebM, which iPhones cannot decode; a ted2zim ZIM
    ships ogv.js for its own pages, and ZimiTube's player uses it too."""
    files = dict(TED_FILES)
    files["why-tech-needs-the-humanities"] = b"<html><body><video><source src='videos/13316/video.webm' type='video/webm'></video></body></html>"
    files["-/assets/ogvjs/ogv.js"] = b"/* ogv */"
    _library(tmp_path, monkeypatch, [("ted_en_ogv_2023-09.zim", {"Scraper": "ted2zim 2.0.13", "Name": "ted_en_ogv"}, files)])
    assert tube.playback("ted_en_ogv", "why-tech-needs-the-humanities")["ogv"] == "-/assets/ogvjs"


def test_playback_resolves_zimis_own_relative_paths(tmp_path, monkeypatch):
    page = b"<html><body><video controls preload='metadata'><source src='../media/abc.webm' type='video/webm'><track kind='subtitles' src='../subs/abc.en.vtt' srclang='en' label='en'></video></body></html>"
    _library(tmp_path, monkeypatch, [("own-play.zim", {"Scraper": "Zimi 1.10.0 + yt-dlp 2026.07.04", "Name": "own-play"}, {"videos/abc": page})])
    got = tube.playback("own-play", "videos/abc")
    assert got["media"] == [{"path": "media/abc.webm", "type": "video/webm"}]
    assert got["subs"] == [{"path": "subs/abc.en.vtt", "lang": "en", "label": "en"}]


def test_a_page_without_media_is_none(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, [("own-none.zim", {"Scraper": "Zimi 1.10.0 + yt-dlp 2026.07.04", "Name": "own-none"}, {"videos/abc": b"<html><body>no player</body></html>"})])
    assert tube.playback("own-none", "videos/abc") is None
    assert tube.playback("own-none", "videos/missing") is None


def test_the_play_route_is_rate_limited_as_an_api_path():
    from zimi import http

    assert "/tube/play" in http._RATE_LIMITED_API_PATHS


def test_one_card_per_talk_across_sources(tmp_path, monkeypatch):
    """Two TED ZIMs (a playlist, a topic) carry the same talks; the feed
    shows each once, naming the other ZIM it is in."""
    _library(
        tmp_path, monkeypatch,
        [
            ("ted_en_a_2023-09.zim", {"Scraper": "ted2zim 2.0.13", "Name": "ted_en_a"}, TED_FILES),
            ("ted_en_b_2023-09.zim", {"Scraper": "ted2zim 2.0.13", "Name": "ted_en_b"}, TED_FILES),
        ],
    )
    f = tube.feed()
    assert f["total"] == 2 and f["sources"] == 2
    assert [v["zim"] for v in f["items"]] == ["ted_en_a", "ted_en_a"]
    assert f["items"][0]["also"] == [{"zim": "ted_en_b", "zim_title": "Test Survival", "page": f["items"][0]["page"]}]


def test_a_ted_page_puts_the_decoder_first_on_iphones_only():
    """ted2zim's player asks the browser first; an iPhone says it can play
    WebM and then cannot. Served through Zimi the page gets one line, before
    video.js, that swaps the order on Apple's handhelds. Other pages, and
    pages without the browser-first order, are untouched."""
    page = (
        '<html><head><script src="assets/videojs/video.min.js"></script><script src="assets/ogvjs/ogv.js"></script></head>'
        '<body><video class="video-js" data-setup=\'{"techOrder": ["html5", "ogvjs"], "ogvjs": {"base": "assets/ogvjs"}}\'>'
        '<source src="videos/1/video.webm" type="video/webm" /></video></body></html>'
    )
    out = tube.decoder_first_on_ios(page)
    assert out.count("<script>") == 1
    assert out.index("<script>") < out.index('src="assets/videojs/video.min.js"')
    assert json.dumps(tube._TECH_ORDER_IOS) in out
    assert "iPhone|iPad|iPod" in out
    assert out.replace(tube._IOS_DECODER_FIRST, "", 1) == page
    assert tube.decoder_first_on_ios("<html><video data-setup='{\"techOrder\": [\"html5\"]}'></video></html>") == "<html><video data-setup='{\"techOrder\": [\"html5\"]}'></video></html>"
    assert tube.decoder_first_on_ios(page.replace("assets/videojs/video.min.js", "player.js")) == page.replace("assets/videojs/video.min.js", "player.js")


def test_a_talk_is_filed_where_the_archive_really_keeps_it():
    """A 2021 ted2zim ZIM keeps talks under A/ and assets under -/; libzim
    finds the slug either way, but the page's own ../-/assets links only
    resolve from A/. The reader gets the real path; a new-scheme ZIM and a
    missing page get the slug back."""

    class Entry:
        def __init__(self, path):
            self.path = path

    class Old:
        def get_entry_by_path(self, path):
            return Entry("A/" + path)

    class New:
        def get_entry_by_path(self, path):
            return Entry(path)

    class Gone:
        def get_entry_by_path(self, path):
            raise KeyError(path)

    assert tube._page_path(Old(), "why-tech-needs-the-humanities") == "A/why-tech-needs-the-humanities"
    assert tube._page_path(New(), "why-tech-needs-the-humanities") == "why-tech-needs-the-humanities"
    assert tube._page_path(Gone(), "why-tech-needs-the-humanities") == "why-tech-needs-the-humanities"
