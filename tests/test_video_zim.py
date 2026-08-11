"""`zimi create <video URL>` — playlists/channels → ZIM over a mocked yt-dlp.

The fake yt_dlp module implements exactly the API surface video.py uses:
``YoutubeDL.extract_info`` (flat probe + per-entry download writing real
files into the outtmpl dir) and ``extractor.gen_extractor_classes`` for URL
claiming. The ZIM side is real — every build is read back with libzim's
Archive. NEVER touches the network.
"""

import argparse
import os
import sys
import types

import pytest

pytest.importorskip("libzim.writer")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from libzim.reader import Archive  # noqa: E402

import zimi.video as video  # noqa: E402

PLAYLIST_URL = "https://faketube.test/playlist?list=PL1"


def _watch_url(vid):
    return f"https://faketube.test/watch?v={vid}"


class FakeVideo:
    def __init__(
        self,
        vid,
        title,
        media_ext,
        media_bytes,
        duration,
        uploader="Chan",
        subs=(),
        thumb=False,
        description="",
        report_filepath=True,
    ):
        self.vid = vid
        self.title = title
        self.media_ext = media_ext
        self.media_bytes = media_bytes
        self.duration = duration
        self.uploader = uploader
        self.subs = subs
        self.thumb = thumb
        self.description = description
        self.report_filepath = report_filepath

    def full_info(self, filepath):
        info = {
            "id": self.vid,
            "title": self.title,
            "duration": self.duration,
            "uploader": self.uploader,
            "description": self.description,
            "upload_date": "20260401",
            "webpage_url": _watch_url(self.vid),
        }
        if filepath and self.report_filepath:
            info["requested_downloads"] = [{"filepath": filepath}]
        return info


def _videos():
    return [
        FakeVideo(
            "v1",
            "Video One",
            "mp4",
            b"MP41" * 250,  # 1000 bytes
            200,
            subs=("en", "es"),
            thumb=True,
            description="First video.\n\nTwo paragraphs.",
        ),
        FakeVideo(
            "v2",
            "Video Two",
            "webm",
            b"WEBM" * 500,  # 2000 bytes
            3700,
            report_filepath=False,  # exercises the directory-scan fallback
        ),
        FakeVideo("v3", "Video Three", "mp4", b"MP43" * 125, 65, thumb=True),
    ]


def _install_fake_ytdlp(monkeypatch, videos, playlist_title="Fake Playlist"):
    fake = types.ModuleType("yt_dlp")
    fake_ex = types.ModuleType("yt_dlp.extractor")
    by_url = {_watch_url(v.vid): v for v in videos}
    download_log = []

    class _FakeTubeIE:
        IE_NAME = "faketube"

        @classmethod
        def suitable(cls, url):
            return url.startswith("https://faketube.test/")

    class _GenericIE:
        IE_NAME = "generic"

        @classmethod
        def suitable(cls, url):
            return True

    fake_ex.gen_extractor_classes = lambda: [_FakeTubeIE, _GenericIE]

    class YoutubeDL:
        def __init__(self, opts=None):
            self.opts = opts or {}

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def extract_info(self, url, download=False):
            if not download:
                if url in by_url:  # a single-video URL: no playlist wrapper
                    return by_url[url].full_info(None)
                entries = [
                    {
                        "_type": "url",
                        "id": v.vid,
                        "title": v.title,
                        "duration": v.duration,
                        "uploader": v.uploader,
                        "url": _watch_url(v.vid),
                    }
                    for v in videos
                ]
                end = self.opts.get("playlistend")
                if end:
                    entries = entries[:end]
                return {
                    "_type": "playlist",
                    "id": "PL1",
                    "title": playlist_title,
                    "uploader": "Chan",
                    "entries": entries,
                }
            v = by_url[url]
            download_log.append(v.vid)
            workdir = os.path.dirname(self.opts["outtmpl"])
            audio = str(self.opts.get("format", "")).startswith("bestaudio")
            ext = "m4a" if audio else v.media_ext
            media = os.path.join(workdir, f"{v.vid}.{ext}")
            with open(media, "wb") as f:
                f.write(v.media_bytes)
            if self.opts.get("writesubtitles"):
                for lang in v.subs:
                    with open(os.path.join(workdir, f"{v.vid}.{lang}.vtt"), "w") as f:
                        f.write(
                            "WEBVTT\n\n00:00.000 --> 00:02.000\nhello " + lang + "\n"
                        )
            if self.opts.get("writethumbnail") and v.thumb:
                with open(os.path.join(workdir, f"{v.vid}.jpg"), "wb") as f:
                    f.write(b"\xff\xd8FAKEJPG")
            # yt-dlp scratch that must never be mistaken for media:
            open(os.path.join(workdir, f"{v.vid}.{ext}.part"), "wb").close()
            return v.full_info(media)

    fake.YoutubeDL = YoutubeDL
    fake.extractor = fake_ex
    fake.download_log = download_log
    monkeypatch.setitem(sys.modules, "yt_dlp", fake)
    monkeypatch.setitem(sys.modules, "yt_dlp.extractor", fake_ex)
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    return fake


def _entry_text(arc, path):
    return bytes(arc.get_entry_by_path(path).get_item().content).decode("utf-8")


# ── URL claiming (yt-dlp's own extractor matching) ──────────────────────────


def test_claims_url_uses_extractor_matching(monkeypatch):
    _install_fake_ytdlp(monkeypatch, _videos())
    assert video.claims_url(PLAYLIST_URL) is True
    # example.com matches only the catch-all generic extractor → not a
    # video source; it falls through to single-page capture.
    assert video.claims_url("https://example.com/article") is False


def test_claims_url_false_without_ytdlp(monkeypatch):
    monkeypatch.setitem(sys.modules, "yt_dlp", None)
    assert video.claims_url(PLAYLIST_URL) is False


def test_video_flags_force_the_video_path(monkeypatch):
    monkeypatch.setitem(sys.modules, "yt_dlp", None)
    flags = dict(format=None, audio_only=False, limit=None, max_bytes=None)
    assert (
        video.wants_url("https://example.com/x", argparse.Namespace(**flags)) is False
    )
    flags["audio_only"] = True
    assert video.wants_url("https://example.com/x", argparse.Namespace(**flags)) is True


def test_missing_ytdlp_gives_install_hint(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "yt_dlp", None)
    monkeypatch.delenv("ZIMI_OFFLINE", raising=False)
    with pytest.raises(video.CreateError, match="pip install yt-dlp"):
        video.create_video_zim(PLAYLIST_URL, out_dir=str(tmp_path))


# ── the build, end to end against a real ZIM ────────────────────────────────


def test_playlist_zim_end_to_end(monkeypatch, tmp_path):
    _install_fake_ytdlp(monkeypatch, _videos())
    info = video.create_video_zim(
        PLAYLIST_URL, out_dir=str(tmp_path / "out"), work_dir=str(tmp_path)
    )
    assert info["videos"] == 3 and info["skipped"] == 0
    assert os.path.exists(info["path"])

    arc = Archive(info["path"])
    assert arc.main_entry.get_item().path == "index"
    idx = _entry_text(arc, "index")
    assert "Fake Playlist" in idx
    assert "href='videos/v1'" in idx and "href='videos/v3'" in idx
    assert "<img src='thumbs/v1.jpg'" in idx  # thumbnail inline
    assert "3:20" in idx  # duration 200s
    assert "1:01:40" in idx  # duration 3700s
    assert "Chan" in idx  # uploader

    # Media entries: exact bytes, honest mimetypes.
    m1 = arc.get_entry_by_path("media/v1.mp4").get_item()
    assert bytes(m1.content) == b"MP41" * 250
    assert m1.mimetype == "video/mp4"
    m2 = arc.get_entry_by_path("media/v2.webm").get_item()
    assert bytes(m2.content) == b"WEBM" * 500
    assert m2.mimetype == "video/webm"

    # Per-video page: player, right source type, selectable subtitle tracks.
    p1 = _entry_text(arc, "videos/v1")
    assert "<video controls" in p1
    assert "type='video/mp4'" in p1
    assert "srclang='en'" in p1 and "srclang='es'" in p1
    assert "First video." in p1  # description carried
    p2 = _entry_text(arc, "videos/v2")
    assert "<track" not in p2  # no subs on v2

    sub = arc.get_entry_by_path("subs/v1.en.vtt").get_item()
    assert sub.mimetype == "text/vtt"
    assert b"WEBVTT" in bytes(sub.content)

    assert bytes(arc.get_metadata("Title")).decode() == "Fake Playlist"
    assert bytes(arc.get_metadata("Source")).decode() == PLAYLIST_URL


def test_budget_stops_cleanly_and_index_names_skipped(monkeypatch, tmp_path):
    fake = _install_fake_ytdlp(monkeypatch, _videos())
    # v1 (~1KB incl. subs+thumb) fits a 1200-byte budget; v2 (2KB) blows it.
    info = video.create_video_zim(
        PLAYLIST_URL,
        out_dir=str(tmp_path / "out"),
        work_dir=str(tmp_path),
        max_bytes=1200,
    )
    assert info["videos"] == 1 and info["skipped"] == 2
    # Clean stop: v3 was never even downloaded once the budget was hit —
    # even though its 500 bytes would have fit.
    assert fake.download_log == ["v1", "v2"]

    arc = Archive(info["path"])
    assert arc.has_entry_by_path("media/v1.mp4")
    assert not arc.has_entry_by_path("media/v2.webm")
    assert not arc.has_entry_by_path("videos/v3")
    idx = _entry_text(arc, "index")
    assert "Not included" in idx
    assert "Video Two" in idx and "Video Three" in idx
    assert "--max-bytes" in idx


def test_first_video_always_ships_even_over_budget(monkeypatch, tmp_path):
    _install_fake_ytdlp(monkeypatch, _videos())
    info = video.create_video_zim(
        PLAYLIST_URL,
        out_dir=str(tmp_path / "out"),
        work_dir=str(tmp_path),
        max_bytes=10,  # smaller than any single video
    )
    assert info["videos"] == 1 and info["skipped"] == 2


def test_audio_only_mode(monkeypatch, tmp_path):
    _install_fake_ytdlp(monkeypatch, _videos())
    info = video.create_video_zim(
        PLAYLIST_URL,
        out_dir=str(tmp_path / "out"),
        work_dir=str(tmp_path),
        audio_only=True,
        limit=1,
    )
    arc = Archive(info["path"])
    m = arc.get_entry_by_path("media/v1.m4a").get_item()
    assert m.mimetype.startswith("audio/")
    p = _entry_text(arc, "videos/v1")
    assert "<audio controls" in p
    assert "<video" not in p
    assert "Transcript" in p  # captions still reachable as text


def test_limit_bounds_the_entry_count(monkeypatch, tmp_path):
    fake = _install_fake_ytdlp(monkeypatch, _videos())
    info = video.create_video_zim(
        PLAYLIST_URL,
        out_dir=str(tmp_path / "out"),
        work_dir=str(tmp_path),
        limit=2,
    )
    assert info["videos"] == 2 and info["skipped"] == 0
    assert fake.download_log == ["v1", "v2"]
    arc = Archive(info["path"])
    assert not arc.has_entry_by_path("videos/v3")


def test_single_video_url_makes_one_entry_zim(monkeypatch, tmp_path):
    _install_fake_ytdlp(monkeypatch, _videos())
    info = video.create_video_zim(
        _watch_url("v1"), out_dir=str(tmp_path / "out"), work_dir=str(tmp_path)
    )
    assert info["videos"] == 1
    arc = Archive(info["path"])
    assert arc.main_entry.get_item().path == "index"
    assert arc.has_entry_by_path("videos/v1")


def test_offline_refused(monkeypatch, tmp_path):
    _install_fake_ytdlp(monkeypatch, _videos())
    monkeypatch.setenv("ZIMI_OFFLINE", "1")
    with pytest.raises(video.CreateError, match="ZIMI_OFFLINE"):
        video.create_video_zim(PLAYLIST_URL, out_dir=str(tmp_path))


# ── `zimi create` dispatch hook ─────────────────────────────────────────────


def test_create_cli_routes_video_urls_to_video_path(monkeypatch, tmp_path, capsys):
    """creator.cli_create hands a claimed URL to the video arm — the one
    dispatch line living in the shared create CLI."""
    _install_fake_ytdlp(monkeypatch, _videos())
    import zimi.creator as creator

    args = argparse.Namespace(
        source=PLAYLIST_URL,
        title=None,
        description=None,
        language="eng",
        creator="Zimi",
        out=str(tmp_path / "pl.zim"),
        format=None,
        audio_only=False,
        limit=None,
        max_bytes=None,
    )
    creator.cli_create(args)
    out = capsys.readouterr().out
    assert "ZIM written" in out
    assert (tmp_path / "pl.zim").exists()
    arc = Archive(str(tmp_path / "pl.zim"))
    assert arc.main_entry.get_item().path == "index"


# ── size parsing ────────────────────────────────────────────────────────────


def test_parse_size():
    assert video.parse_size("4G") == 4 * 1024**3
    assert video.parse_size("500M") == 500 * 1024**2
    assert video.parse_size("1024") == 1024
    assert video.parse_size("1.5g") == int(1.5 * 1024**3)
    assert video.parse_size("2GiB") == 2 * 1024**3
    with pytest.raises(video.CreateError, match="cannot parse"):
        video.parse_size("lots")


def test_crawl_intent_beats_video_route(monkeypatch):
    """--site or --engine zimit outranks extractor matching, and --max-bytes
    (shared with the site crawl) signals nothing by itself."""
    _install_fake_ytdlp(monkeypatch, _videos())
    from zimi import video

    claimed = "https://faketube.test/playlist"
    assert video.claims_url(claimed) is True
    base = dict(
        format=None,
        audio_only=False,
        limit=None,
        max_bytes=None,
        site=False,
        engine="builtin",
    )
    assert (
        video.wants_url(claimed, argparse.Namespace(**{**base, "site": True})) is False
    )
    assert (
        video.wants_url(claimed, argparse.Namespace(**{**base, "engine": "zimit"}))
        is False
    )
    assert (
        video.wants_url(
            "https://plain.example/docs",
            argparse.Namespace(**{**base, "max_bytes": "4G"}),
        )
        is False
    )
