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
    "videos/117845/video.webm": b"\x1a\x45\xdf\xa3webm",
    "videos/13316/video.webm": b"\x1a\x45\xdf\xa3webm",
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
    "videos/x1/video.webm": b"\x1a\x45\xdf\xa3webm",
}
ZIMI_MEDIA = {"media/abc.mp4": b"\x00\x00\x00\x18ftypmp42", "media/def.mp4": b"\x00\x00\x00\x18ftypmp42"}


def _library(tmp_path, monkeypatch, zims):
    from conftest_zim import build_fixture_zim

    zdir = tmp_path / "zims"
    zdir.mkdir()
    for filename, metadata, files, *main in zims:
        build_fixture_zim(str(zdir / filename), metadata, files=files, **({"main_path": main[0]} if main else {}))
    monkeypatch.setattr(srv, "ZIM_DIR", str(zdir))
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    tube._reset_for_tests()
    srv.load_cache(force=True)


def _public(rows):
    return [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]


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
    rows = _public(tube.videos_for("yt"))
    assert rows == [{"id": "x1", "title": "Hello world", "description": "", "speaker": "Chan", "thumb": "videos/x1/video.webp", "page": "hello-world", "duration": 61, "date": "2025-05-05"}]


def test_not_a_video_zim_has_no_videos(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, [("survival_en_2026-06.zim", None, {})])
    assert tube.videos_for("survival") == []
    assert tube.feed() == {"items": [], "total": 0, "sources": 0, "zims": []}


# ── the feed ───────────────────────────────────────────────────────────────


def test_a_video_zimi_made_is_in_the_feed(tmp_path, monkeypatch):
    """videos.json as `zimi create <video URL>` writes it: media is one path,
    a string. The feed checked each entry of a list, so it looked up the
    string's characters, found none, and dropped every video Zimi made."""
    own = [
        {"id": "abc", "title": "Kept", "description": "", "speaker": "Ch", "thumb": "", "page": "videos/abc",
         "duration": 61, "date": "", "media": "media/abc.mp4"},
        {"id": "gone", "title": "No file", "description": "", "speaker": "Ch", "thumb": "", "page": "videos/gone",
         "duration": 61, "date": "", "media": "media/gone.mp4"},
    ]
    _library(
        tmp_path, monkeypatch,
        [
            ("made.zim", {"Scraper": "Zimi 1.10.0 + yt-dlp 2026.07.04", "Name": "made"},
             {"videos.json": json.dumps(own).encode(), "media/abc.mp4": b"\x00" * 64}),
        ],
    )
    assert [v["title"] for v in tube.feed()["items"]] == ["Kept"]


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
        "missing": False,
        "description": "Berridge on hiring.",
    }


def test_a_talk_without_its_file_is_not_in_the_feed_and_its_page_says_so(tmp_path, monkeypatch):
    """ted2zim writes a talk's page even when its download failed (the CRISPR
    talk in ted_en_technology_2023-09). The feed leaves that talk out; asked
    for by address anyway, its page says the video is not in the ZIM rather
    than blaming the browser."""
    files = dict(TED_FILES)
    del files["videos/13316/video.webm"]
    files["why-tech-needs-the-humanities"] = TED_PAGE
    whole = dict(TED_FILES)
    whole["why-tech-needs-the-humanities"] = TED_PAGE
    _library(
        tmp_path, monkeypatch,
        [
            ("ted_en_gone_2023-09.zim", {"Scraper": "ted2zim 2.0.13", "Name": "ted_en_gone"}, files),
            ("ted_en_x_2023-09.zim", {"Scraper": "ted2zim 2.0.13", "Name": "ted_en_x"}, whole),
        ],
    )
    assert [v["page"] for v in tube.videos_for("ted_en_gone")] == ["the-world-s-rarest-diseases"]
    assert "media" not in tube.videos_for("ted_en_gone")[0]
    got = tube.playback("ted_en_gone", "why-tech-needs-the-humanities")
    assert got["missing"] is True
    assert got["media"] == [{"path": "videos/13316/video.webm", "type": "video/webm"}]
    # And the talk's own page in the reader: its <video> is marked, and the
    # page says the file is not there instead of showing a dead player.
    page_html = TED_PAGE.decode()
    mended = tube.mend_sources(page_html, "ted_en_gone", "why-tech-needs-the-humanities")
    assert 'data-zimi-missing="1"' in mended
    present = tube.mend_sources(page_html, "ted_en_x", "why-tech-needs-the-humanities")
    assert "data-zimi-missing" not in present


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


def test_one_card_when_two_builds_spell_the_speaker_differently(tmp_path, monkeypatch):
    """Found on the NAS: TED talk 56901 showed twice, because the two builds
    carrying it spell the speaker differently and the card was keyed on title
    and speaker. The talk's id is the same in both. Different videos that share
    a plain title stay apart."""
    def own(speaker, vid, title="The power of vulnerability"):
        return {"id": vid, "title": title, "description": "", "speaker": speaker, "thumb": "", "page": "videos/" + vid,
                "duration": None, "date": ""}

    a = [own("Brene Brown", "56901"), own("Chan A", "x1", "Introduction")]
    b = [own("Brené Brown", "56901"), own("Chan B", "x2", "Introduction")]
    _library(
        tmp_path, monkeypatch,
        [
            ("a.zim", {"Scraper": "Zimi 1.10.0 + yt-dlp 2026.07.04", "Name": "a"}, {"videos.json": json.dumps(a).encode()}),
            ("b.zim", {"Scraper": "Zimi 1.10.0 + yt-dlp 2026.07.04", "Name": "b"}, {"videos.json": json.dumps(b).encode()}),
        ],
    )
    titles = sorted(v["title"] for v in tube.feed()["items"])
    assert titles == ["Introduction", "Introduction", "The power of vulnerability"]

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


def test_a_sibling_file_the_page_never_named_is_played(tmp_path, monkeypatch):
    """ted_en_technology_2023-09 names videos/N/video.webm for every talk and
    carries video.mp4 for some (the climate talk, whose webm is absent). The
    player gets the mp4; the page served through Zimi names it too; only a
    talk with neither file is missing. MP4 comes first when both are there:
    Safari plays a WebM's picture and not its Vorbis sound."""
    files = dict(TED_FILES)
    del files["videos/13316/video.webm"]
    files["videos/13316/video.mp4"] = b"\x00\x00\x00\x18ftypmp42"
    files["why-tech-needs-the-humanities"] = TED_PAGE
    files["videos/117845/video.mp4"] = b"\x00\x00\x00\x18ftypmp42"
    _library(tmp_path, monkeypatch, [("ted_en_sib_2023-09.zim", {"Scraper": "ted2zim 2.0.13", "Name": "ted_en_sib"}, files)])
    got = tube.playback("ted_en_sib", "why-tech-needs-the-humanities")
    assert got["missing"] is False
    assert got["media"] == [{"path": "videos/13316/video.mp4", "type": "video/mp4"}]
    assert [v["page"] for v in tube.videos_for("ted_en_sib")] == ["the-world-s-rarest-diseases", "why-tech-needs-the-humanities"]
    page = TED_PAGE.decode()
    mended = tube.mend_sources(page, "ted_en_sib", "why-tech-needs-the-humanities")
    assert "<source src='videos/13316/video.mp4' type='video/mp4' />" in mended.replace('"', "'")
    assert mended.count("<source") == 1
    # a page whose file is there is served as written
    assert tube.mend_sources(page, "ted_en_sib", "the-world-s-rarest-diseases") == page or "videos/13316" in page
    assert tube.siblings_of("videos/1/video.webm") == ["videos/1/video.mp4", "videos/1/video.m4v", "videos/1/video.webm", "videos/1/video.ogv"]
    assert tube.siblings_of("subs/x.vtt") == ["subs/x.vtt"]


def test_a_zero_byte_file_is_as_absent_as_none(tmp_path, monkeypatch):
    """The climate talk in ted_en_technology_2023-09: no webm, and a
    video.mp4 entry of zero bytes. Neither is a video; the talk is left out
    of the feed and its page says the video is not in the ZIM."""
    files = dict(TED_FILES)
    del files["videos/13316/video.webm"]
    files["videos/13316/video.mp4"] = b""
    files["why-tech-needs-the-humanities"] = TED_PAGE
    _library(tmp_path, monkeypatch, [("ted_en_zero_2023-09.zim", {"Scraper": "ted2zim 2.0.13", "Name": "ted_en_zero"}, files)])
    assert [v["page"] for v in tube.videos_for("ted_en_zero")] == ["the-world-s-rarest-diseases"]
    got = tube.playback("ted_en_zero", "why-tech-needs-the-humanities")
    assert got["missing"] is True
    mended = tube.mend_sources(TED_PAGE.decode(), "ted_en_zero", "why-tech-needs-the-humanities")
    # The player is gone and a note says why; the rest of the page stays.
    assert "<video" not in mended and "This video isn't in this ZIM." in mended
    assert mended.startswith(TED_PAGE.decode().split("<video")[0])
# ── the 3.x scrapers (issue #89) ───────────────────────────────────────────
# Layouts measured in Kiwix's own builds: ted_mul_street-art_2026-09
# (ted2zim 3.2.1), studio.blender.org_en_open-movies_2026-06 and
# crashcourse_en_all_2026-05 (youtube2zim 3.5.0).

WEBM = b"\x1a\x45\xdf\xa3webm"


def _ted_data(rows):
    return ("window.json_data = " + json.dumps(rows)).encode()


TED3_FILES = {
    # ted2zim 3.x: no assets/data.js; one list per subtitle language, the
    # languages named in the home page's picker.
    "index": b"<html><body><select id='language-select'>"
    b'<option value="ar">Arabic</option><option value="en">English</option></select></body></html>',
    "assets/data_en.js": _ted_data(
        [
            {
                "id": "2437",
                "slug": "how-yarn-bombing-grew",
                "title": "How yarn bombing grew",
                "speaker": "Magda  Sayeg",
            }
        ]
    ),
    "assets/data_ar.js": _ted_data(
        [
            {
                "id": "2437",
                "slug": "how-yarn-bombing-grew",
                "title": "Arabic title",
                "speaker": "Magda  Sayeg",
            },
            {
                "id": "2157",
                "slug": "trash-cart-superheroes",
                "title": "Arabic only",
                "speaker": "  Mundano",
            },
        ]
    ),
    "how-yarn-bombing-grew": b"<html><body><video id='ted-video' poster=\"videos/2437/thumbnail.webp\">"
    b'<source src="videos/2437/video.webm" type="video/webm" />'
    b'<track kind="subtitles" src="videos/2437/subs/subs_en.vtt" srclang="en" label="English" /></video></body></html>',
    "videos/2437/thumbnail.webp": b"RIFF....WEBP",
    "videos/2437/video.webm": WEBM,
    "videos/2157/video.webm": WEBM,
    "assets/ogvjs/ogv.js": b"/* ogv */",
}


def test_ted2zim_3_talks_come_from_every_language_list(tmp_path, monkeypatch):
    _library(
        tmp_path,
        monkeypatch,
        [
            (
                "ted_mul_art_2026-09.zim",
                {"Scraper": "ted2zim 3.2.1", "Name": "ted_mul_art"},
                TED3_FILES,
                "index",
            )
        ],
    )
    rows = tube.videos_for("ted_mul_art")
    assert [(r["id"], r["title"], r["speaker"], r["page"]) for r in rows] == [
        ("2437", "How yarn bombing grew", "Magda Sayeg", "how-yarn-bombing-grew"),
        ("2157", "Arabic only", "Mundano", "trash-cart-superheroes"),
    ]
    assert rows[0]["thumb"] == "videos/2437/thumbnail.webp"
    got = tube.playback("ted_mul_art", "how-yarn-bombing-grew")
    assert (
        got["media"] == [{"path": "videos/2437/video.webm", "type": "video/webm"}]
        and not got["missing"]
    )
    assert got["subs"] == [
        {"path": "videos/2437/subs/subs_en.vtt", "lang": "en", "label": "English"}
    ]
    assert got["poster"] == "videos/2437/thumbnail.webp"
    # 3.x keeps the decoder at assets/ogvjs; libzim finds it by the old path too.
    assert got["ogv"] == "-/assets/ogvjs"


def _yt3_video(vid, title, **extra):
    v = {
        "id": vid,
        "title": title,
        "description": f"About {title}.",
        "author": {"channelId": "UC1", "channelTitle": "Blender Studio"},
        "publicationDate": "2010-09-30T13:28:21Z",
        "videoPath": f"videos/{vid}/video.webm",
        "thumbnailPath": f"videos/{vid}/video.webp",
        "subtitlePath": f"videos/{vid}",
        "subtitleList": [],
        "chaptersPath": None,
        "chapterList": [],
        "duration": "PT14M48S",
    }
    v.update(extra)
    return json.dumps(v).encode()


def _yt3_playlist(slug, videos):
    return json.dumps(
        {
            "id": "PL" + slug,
            "slug": slug,
            "author": {"channelTitle": "Blender Studio"},
            "title": slug,
            "videos": [
                {
                    "slug": s,
                    "id": i,
                    "title": t,
                    "thumbnailPath": f"videos/{i}/video.webp",
                    "duration": d,
                }
                for s, i, t, d in videos
            ],
        }
    ).encode()


YT3_FILES = {
    "index.html": b"<!doctype html><html><body><div id='app'></div></body></html>",
    "channel.json": json.dumps(
        {"id": "UC1", "title": "Blender Studio films", "channelName": "Blender Studio"}
    ).encode(),
    "playlists.json": json.dumps(
        {"playlists": [{"slug": "open_movies-tNCz"}, {"slug": "shorts-aB12"}]}
    ).encode(),
    "playlists/open_movies-tNCz.json": _yt3_playlist(
        "open_movies-tNCz",
        [
            ("sintel-eRsG", "eRsGyueVLvQ", "Sintel", "PT14M48S"),
            ("spring-WhWc", "WhWc3b3KhnY", "Spring", "PT7M45S"),
        ],
    ),
    # A second playlist repeats a video: one row, not two.
    "playlists/shorts-aB12.json": _yt3_playlist(
        "shorts-aB12",
        [
            ("spring-WhWc", "WhWc3b3KhnY", "Spring", "PT7M45S"),
            ("gone-XXXX", "XXXXgone", "Gone", "PT1M"),
        ],
    ),
    "videos/sintel-eRsG.json": _yt3_video(
        "eRsGyueVLvQ",
        "Sintel",
        subtitleList=[
            {"code": "en", "name": "English - en"},
            {"code": "nl-3qLcwtbWM-Y", "name": "Dutch - nl"},
        ],
    ),
    "videos/spring-WhWc.json": _yt3_video(
        "WhWc3b3KhnY",
        "Spring",
        duration="PT7M45S",
        publicationDate="2019-04-04T00:00:00Z",
    ),
    "videos/gone-XXXX.json": _yt3_video("XXXXgone", "Gone"),
    "index/sintel-eRsG": b'<html><head><meta http-equiv="refresh" content="0;URL=\'../index.html#/watch/sintel-eRsG\'" /></head><body></body></html>',
    "videos/eRsGyueVLvQ/video.webm": WEBM,
    "videos/eRsGyueVLvQ/video.webp": b"RIFF....WEBP",
    "videos/eRsGyueVLvQ/video.en.vtt": b"WEBVTT\n",
    "videos/eRsGyueVLvQ/video.nl-3qLcwtbWM-Y.vtt": b"WEBVTT\n",
    "videos/WhWc3b3KhnY/video.webm": WEBM,
    "assets/ogvjs/ogv.js": b"/* ogv */",
}


def test_youtube2zim_3_videos_come_from_the_playlists(tmp_path, monkeypatch):
    """CrashCourse and Blender Studio (youtube2zim 3.5.0) have no
    videos.json and no data.js: ZimiTube said no video ZIMs were installed."""
    _library(
        tmp_path,
        monkeypatch,
        [
            (
                "studio.blender.org_en_open-movies_2026-06.zim",
                {"Scraper": "youtube2zim 3.5.0"},
                YT3_FILES,
                "index.html",
            )
        ],
    )
    tube.build_all_details()
    rows = _public(tube.videos_for("studio.blender.org_en_open-movies"))
    # The video whose file is not in the ZIM is left out, as for every reader.
    assert rows == [
        {
            "id": "eRsGyueVLvQ",
            "title": "Sintel",
            "description": "About Sintel.",
            "speaker": "Blender Studio",
            "thumb": "videos/eRsGyueVLvQ/video.webp",
            "page": "index/sintel-eRsG",
            "duration": 888,
            "date": "2010-09-30",
        },
        {
            "id": "WhWc3b3KhnY",
            "title": "Spring",
            "description": "About Spring.",
            "speaker": "Blender Studio",
            "thumb": "videos/WhWc3b3KhnY/video.webp",
            "page": "index/spring-WhWc",
            "duration": 465,
            "date": "2019-04-04",
        },
    ]
    assert [v["title"] for v in tube.feed("sintel")["items"]] == ["Sintel"]


def test_youtube2zim_3_plays_from_the_videos_json(tmp_path, monkeypatch):
    _library(
        tmp_path,
        monkeypatch,
        [
            (
                "yt3play.zim",
                {"Scraper": "youtube2zim 3.5.0", "Name": "yt3play"},
                YT3_FILES,
                "index.html",
            )
        ],
    )
    tube.build_all_details()
    got = tube.playback("yt3play", "index/sintel-eRsG")
    assert got == {
        "media": [{"path": "videos/eRsGyueVLvQ/video.webm", "type": "video/webm"}],
        "missing": False,
        "subs": [
            {
                "path": "videos/eRsGyueVLvQ/video.en.vtt",
                "lang": "en",
                "label": "English",
            },
            {
                "path": "videos/eRsGyueVLvQ/video.nl-3qLcwtbWM-Y.vtt",
                "lang": "nl",
                "label": "Dutch",
            },
        ],
        "poster": "videos/eRsGyueVLvQ/video.webp",
        "page": "index/sintel-eRsG",
        "ogv": "-/assets/ogvjs",
        "description": "About Sintel.",
    }
    # Not a video page, and a video page whose JSON is not there.
    assert tube.playback("yt3play", "index.html") is None
    assert tube.playback("yt3play", "index/nothing-here") is None


@pytest.mark.parametrize(
    "value,expected",
    [
        ("PT6M31S", 391),
        ("PT1H2M3S", 3723),
        ("PT45S", 45),
        ("P1DT1S", 86401),
        (61, 61),
        (None, None),
        ("", None),
        ("12:34", None),
        ("P", None),
    ],
)
def test_an_iso_duration_is_seconds(value, expected):
    assert tube._iso_seconds(value) == expected


# ── descriptions, read once in the background ──────────────────────────────
# Eric, 2026-09-23: "For zimitube we need to be able to search by video name
# and description so they need to be there." ted2zim 3.x and youtube2zim 3.x
# keep a video's description in a file of its own; the feed answers from the
# lists and a background build reads those files once into the data dir.


@pytest.fixture(autouse=True)
def _no_build_outlives_its_test():
    """A build a test started must not run on after it, into another test's
    (or the real) data dir."""
    yield
    tube._reset_for_tests()


def _wait_built(name, timeout=30):
    import time

    end = time.time() + timeout
    while time.time() < end:
        with tube._queue_lock:
            if name not in tube._queued:
                return
        time.sleep(0.02)
    raise AssertionError(f"details build for {name} still running after {timeout}s")


YARN = "Magda Sayeg wraps lampposts in knitting: yarnbombing began as a quiet act in Houston."
CART = 'In Brazil, "catadores" collect junk and recyclables; Mundano paints their carts.'


def _ted_talk_file(tid, slug, description):
    return (
        "window.json_data = "
        + json.dumps(
            {
                "id": tid,
                "slug": slug,
                "title": [{"lang": "default", "text": slug}],
                "description": [{"lang": "default", "text": description}, {"lang": "fr", "text": "En francais."}],
                "speaker": "x",
                "languages": ["en"],
            }
        )
    ).encode()


TED3_DESC_FILES = dict(TED3_FILES)
TED3_DESC_FILES["assets/data_en_how-yarn-bombing-grew.js"] = _ted_talk_file("2437", "how-yarn-bombing-grew", YARN)
# The Arabic-only talk: its own file is in the language list it was found in.
TED3_DESC_FILES["assets/data_ar_trash-cart-superheroes.js"] = _ted_talk_file("2157", "trash-cart-superheroes", CART)


def _ted3_library(tmp_path, monkeypatch, name="ted_mul_desc"):
    _library(tmp_path, monkeypatch, [(f"{name}_2026-09.zim", {"Scraper": "ted2zim 3.2.1", "Name": name}, TED3_DESC_FILES, "index")])
    return name


def _yt3_library(tmp_path, monkeypatch, name="yt3desc"):
    _library(tmp_path, monkeypatch, [(f"{name}.zim", {"Scraper": "youtube2zim 3.5.0", "Name": name}, YT3_FILES, "index.html")])
    return name


def test_ted2zim_3_descriptions_arrive_from_each_talks_own_file(tmp_path, monkeypatch):
    name = _ted3_library(tmp_path, monkeypatch)
    tube.videos_for(name)  # the feed's first answer starts the build
    _wait_built(name)
    rows = {r["id"]: r for r in tube.videos_for(name)}
    assert rows["2437"]["description"] == YARN
    assert rows["2157"]["description"] == CART
    assert rows["2437"]["title"] == "How yarn bombing grew"  # the list's title, English first
    assert os.path.exists(os.path.join(srv.ZIMI_DATA_DIR, "tube", name + ".db"))
    # A word only the description has finds the talk, across every source.
    assert [v["title"] for v in tube.feed("catadores")["items"]] == ["Arabic only"]
    assert [v["title"] for v in tube.feed("houston yarnbombing")["items"]] == ["How yarn bombing grew"]


def test_youtube2zim_3_descriptions_arrive_from_each_videos_own_file(tmp_path, monkeypatch):
    name = _yt3_library(tmp_path, monkeypatch)
    first = {r["id"]: r for r in tube.videos_for(name)}
    # What the playlists give, at once: title, length, thumbnail, channel.
    assert first["eRsGyueVLvQ"]["title"] == "Sintel" and first["eRsGyueVLvQ"]["duration"] == 888
    assert first["eRsGyueVLvQ"]["speaker"] == "Blender Studio"
    _wait_built(name)
    rows = {r["id"]: r for r in tube.videos_for(name)}
    assert rows["eRsGyueVLvQ"]["description"] == "About Sintel."
    assert rows["WhWc3b3KhnY"]["date"] == "2019-04-04"
    assert [v["title"] for v in tube.feed("about spring")["items"]] == ["Spring"]


def test_the_feed_answers_before_the_details_build_finishes(tmp_path, monkeypatch):
    import threading
    import time

    name = _yt3_library(tmp_path, monkeypatch, "yt3slow")
    release = threading.Event()
    real = tube.build_details

    def slow(zim_name, zim_path):
        release.wait(30)
        return real(zim_name, zim_path)

    monkeypatch.setattr(tube, "build_details", slow)
    t0 = time.time()
    f = tube.feed()
    assert time.time() - t0 < 5
    assert sorted(v["title"] for v in f["items"]) == ["Sintel", "Spring"]
    assert all(v["description"] == "" for v in f["items"])
    assert tube.feed("about")["total"] == 0  # not read yet
    release.set()
    _wait_built(name)
    assert tube.feed("about")["total"] == 2


def test_a_details_file_from_another_build_of_the_zim_is_read_again(tmp_path, monkeypatch):
    import sqlite3

    name = _yt3_library(tmp_path, monkeypatch, "yt3stale")
    tube.build_all_details()
    db = os.path.join(srv.ZIMI_DATA_DIR, "tube", name + ".db")
    conn = sqlite3.connect(db)
    conn.execute("UPDATE meta SET value='0' WHERE key='zim_mtime'")
    conn.execute("UPDATE meta SET value='another-uuid' WHERE key='zim_uuid'")
    conn.execute("UPDATE videos SET description='stale words'")
    conn.commit()
    conn.close()
    path = srv.get_zim_files()[name]
    assert not tube.details_current(name, path)
    tube._reset_for_tests()
    tube.build_all_details()
    assert tube.details_current(name, path)
    rows = {r["id"]: r for r in tube.videos_for(name)}
    assert rows["eRsGyueVLvQ"]["description"] == "About Sintel."
    assert tube.feed("stale")["total"] == 0


def test_a_big_zims_details_are_read_in_a_process_of_its_own(tmp_path, monkeypatch):
    """The build over a big ZIM goes through search._build_index_isolated as
    `python -m zimi.search --build-index tube ...`: libzim holds the GIL while
    it reads, and a read on a server thread stalls every search."""
    from zimi import search

    name = _ted3_library(tmp_path, monkeypatch, "ted_mul_child")
    monkeypatch.setattr(tube, "_DETAILS_ISOLATE_MIN_ENTRIES", 0)
    started = []
    real_popen = __import__("zimi.subproc", fromlist=["popen"]).popen

    def popen(cmd, **kw):
        started.append(cmd)
        return real_popen(cmd, **kw)

    monkeypatch.setattr("zimi.subproc.popen", popen)
    in_process = []
    monkeypatch.setattr(tube, "build_details", lambda *a: in_process.append(a))
    tube.build_all_details()
    assert not in_process
    assert [c[1:5] for c in started] == [["-m", "zimi.search", "--build-index", "tube"]]
    assert search._ISOLATE_BUILD_MIN_ENTRIES == 100_000  # the title index's threshold is its own
    rows = {r["id"]: r for r in tube.videos_for(name)}
    assert rows["2157"]["description"] == CART


def test_the_player_gets_the_whole_description_and_the_feed_its_start(tmp_path, monkeypatch):
    long = "Opening words. " + "More about the film. " * 60 + "Closingword."
    files = dict(YT3_FILES)
    files["videos/sintel-eRsG.json"] = _yt3_video("eRsGyueVLvQ", "Sintel", description=long)
    _library(tmp_path, monkeypatch, [("yt3long.zim", {"Scraper": "youtube2zim 3.5.0", "Name": "yt3long"}, files, "index.html")])
    tube.build_all_details()
    card = next(v for v in tube.feed()["items"] if v["title"] == "Sintel")
    assert len(card["description"]) <= tube._FEED_DESCRIPTION_CHARS + 1 and card["description"].endswith("…")
    assert not any(k.startswith("_") for k in card)
    # The last word is past what the card carries, and still found.
    assert [v["title"] for v in tube.feed("closingword")["items"]] == ["Sintel"]
    assert tube.playback("yt3long", "index/sintel-eRsG")["description"] == long
