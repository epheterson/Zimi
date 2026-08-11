"""Save to ZIM v1 — export bookmarks to a real .zim and read it back.

Uses libzim.writer (present on the dev Mac and in Docker); guarded with
importorskip so the suite still collects where the writer is absent.
"""

import os
import pathlib
import re
import struct
import sys

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from libzim.reader import Archive  # noqa: E402

import zimi.server as _srv  # noqa: E402
import zimi.zimwriter as zw  # noqa: E402


def _archive(path):
    """Open a written ZIM. Everything here carries str paths; Archive is typed
    for Path, so the conversion happens once instead of at every call site."""
    return Archive(pathlib.Path(path))


def build_wiki_source_zim(path):
    """A real wikipedia-shaped source ZIM: Source metadata that puts it on
    en.wikipedia.org, and an article that links to three siblings."""
    from libzim.writer import Creator

    from conftest_zim import _Article

    articles = [
        (
            "A/Water_purification",
            "Water purification",
            b"<html><head><title>Water purification</title></head><body>"
            b"<h1>Water purification</h1><p>See <a href='Fire'>Fire</a>, "
            b"<a href='../A/Boiling'>Boiling</a> and "
            b"<a href='Chlorine_(disinfectant)'>Chlorine</a>.</p></body></html>",
        ),
        ("A/Fire", "Fire", b"<html><body><h1>Fire</h1></body></html>"),
        ("A/Boiling", "Boiling", b"<html><body><h1>Boiling</h1></body></html>"),
        (
            "A/Chlorine_(disinfectant)",
            "Chlorine (disinfectant)",
            b"<html><body><h1>Chlorine</h1></body></html>",
        ),
    ]
    with Creator(path).config_indexing(True, "eng") as creator:
        creator.set_mainpath("A/Water_purification")
        for p, t, h in articles:
            creator.add_item(_Article(p, t, h))
        creator.add_metadata("Title", "Test Wikipedia")
        creator.add_metadata("Language", "eng")
        creator.add_metadata("Description", "tiny wiki fixture")
        creator.add_metadata("Source", "https://en.wikipedia.org/")
    return path


def _fake_reader(zim, path):
    return (
        f"<html><head><title>{path}</title><script>bad()</script></head>"
        f"<body><h1>{path}</h1><p>Body of {zim}/{path}.</p>"
        "<a href='A/Other'>link</a></body></html>"
    )


def _bookmarks():
    return [
        {"zim": "survival", "path": "A/Water", "title": "Water purification"},
        {"zim": "survival", "path": "A/Fire", "title": "Fire"},
    ]


def test_empty_bookmarks_raises(tmp_path):
    with pytest.raises(ValueError):
        zw.build_bookmarks_zim([], str(tmp_path))


def test_export_creates_readable_zim(tmp_path):
    out = zw.build_bookmarks_zim(_bookmarks(), str(tmp_path), reader=_fake_reader)
    assert os.path.exists(out)
    assert os.path.basename(out).startswith("zimi-bookmarks_")

    arc = _archive(out)
    # index (main) + 2 articles all present and reachable
    assert arc.main_entry.get_item().path == "index"
    idx = bytes(arc.get_entry_by_path("index").get_item().content).decode("utf-8")
    assert "Water purification" in idx
    assert "Fire" in idx

    art = bytes(
        arc.get_entry_by_path("A/0_Water_purification").get_item().content
    ).decode("utf-8")
    assert "Body of survival/A/Water" in art
    assert "From <strong>survival</strong>" in art
    # scripts stripped from embedded body
    assert "bad()" not in art


def test_unreadable_source_becomes_placeholder(tmp_path):
    out = zw.build_bookmarks_zim(
        [{"zim": "gone", "path": "A/X", "title": "Missing"}],
        str(tmp_path),
        reader=lambda z, p: None,
    )
    arc = _archive(out)
    art = bytes(arc.get_entry_by_path("A/0_Missing").get_item().content).decode("utf-8")
    assert "could not be read" in art


def test_output_path_does_not_clobber(tmp_path):
    a = zw.build_bookmarks_zim(_bookmarks(), str(tmp_path), reader=_fake_reader)
    b = zw.build_bookmarks_zim(_bookmarks(), str(tmp_path), reader=_fake_reader)
    assert a != b
    assert os.path.exists(a) and os.path.exists(b)


# ── v2: real asset carrying, sections, multi-ZIM jobs ──


def _img_reader(zim, path):
    return (
        "<html><head>"
        "<link rel='stylesheet' href='../-/style.css'>"
        f"<title>{path}</title></head><body>"
        f"<h1>{path}</h1><img src='../I/pic.png'><p>text</p></body></html>"
    )


def _asset_reader(zim, path):
    if path == "I/pic.png":
        return (b"\x89PNG\r\n\x1a\nFAKEPNGDATA", "image/png")
    if path == "-/style.css":
        return (b"body{color:red} h1{background:url('../I/bg.png')}", "text/css")
    if path == "I/bg.png":
        return (b"BGIMAGEBYTES", "image/png")
    return None


def test_carries_images_and_styles(tmp_path):
    out = zw.build_bookmarks_zim(
        [{"zim": "wiki", "path": "A/Water", "title": "Water"}],
        str(tmp_path),
        reader=_img_reader,
        asset_reader=_asset_reader,
    )
    arc = _archive(out)
    # The image entry was carried into the export, namespaced by source ZIM.
    assert arc.has_entry_by_path("_assets/wiki/I/pic.png")
    png = bytes(arc.get_entry_by_path("_assets/wiki/I/pic.png").get_item().content)
    assert png == b"\x89PNG\r\n\x1a\nFAKEPNGDATA"
    # The article's <img> now points at the carried asset (rewritten ../ ref).
    art = bytes(arc.get_entry_by_path("A/0_Water").get_item().content).decode("utf-8")
    assert "../_assets/wiki/I/pic.png" in art
    # Stylesheet was inlined into the head, not left as an external <link>.
    assert "color:red" in art
    assert "<link" not in art
    # The CSS's own url() font/image was carried one level deep too.
    assert arc.has_entry_by_path("_assets/wiki/I/bg.png")


def test_sections_group_the_index(tmp_path):
    bms = [
        {"zim": "w", "path": "A/H", "title": "Heart", "section": "Cardiology"},
        {"zim": "w", "path": "A/A", "title": "Aspirin", "section": ""},
    ]
    out = zw.build_bookmarks_zim(bms, str(tmp_path), reader=_fake_reader)
    idx = bytes(_archive(out).get_entry_by_path("index").get_item().content).decode(
        "utf-8"
    )
    assert "zimi-section" in idx  # section headers rendered
    assert "Cardiology" in idx


def test_build_export_jobs_writes_one_zim_each(tmp_path):
    jobs = [
        {
            "name": "medical",
            "title": "Medical",
            "bookmarks": [{"zim": "w", "path": "A/H", "title": "Heart"}],
        },
        {
            "name": "research",
            "title": "Research",
            "bookmarks": [{"zim": "w", "path": "A/P", "title": "Paper"}],
        },
    ]
    outs = zw.build_export_jobs(jobs, str(tmp_path), reader=_fake_reader)
    assert len(outs) == 2
    names = sorted(os.path.basename(p) for p in outs)
    assert names == ["medical.zim", "research.zim"]
    assert all(os.path.exists(p) for p in outs)


def test_normalize_jobs_accepts_flat_or_jobs():
    flat = zw._normalize_jobs([{"zim": "a", "path": "b"}])
    assert len(flat) == 1 and len(flat[0]["bookmarks"]) == 1
    jobs = zw._normalize_jobs([{"name": "x", "bookmarks": [{"zim": "a", "path": "b"}]}])
    assert len(jobs) == 1 and jobs[0]["name"] == "x"
    assert zw._normalize_jobs([]) == []


def test_normalize_jobs_keeps_sections():
    jobs = zw._normalize_jobs(
        [
            {
                "name": "x",
                "sections": ["Kept", 7, "Also kept"],
                "bookmarks": [{"zim": "a", "path": "b"}],
            }
        ]
    )
    assert jobs[0]["sections"] == ["Kept", "Also kept"]  # non-strings dropped


def test_empty_selected_folder_renders_as_empty_section(tmp_path):
    # The Eric bug: an exported empty folder must appear in the index (with an
    # honest "no bookmarks" note), never be silently dropped.
    bms = [{"zim": "w", "path": "A/H", "title": "Heart", "section": "Medical"}]
    out = zw.build_bookmarks_zim(
        bms, str(tmp_path), reader=_fake_reader, sections=["Medical", "Research"]
    )
    idx = bytes(_archive(out).get_entry_by_path("index").get_item().content).decode(
        "utf-8"
    )
    assert "Research" in idx  # empty section header rendered
    assert "No bookmarks in this folder." in idx
    assert idx.index("Medical") < idx.index("Research")  # caller order kept


def test_index_and_description_use_proper_plurals(tmp_path):
    one = zw.build_bookmarks_zim(
        [{"zim": "w", "path": "A/H", "title": "Heart"}],
        str(tmp_path),
        reader=_fake_reader,
        name="one",
    )
    many = zw.build_bookmarks_zim(_bookmarks(), str(tmp_path), reader=_fake_reader)
    arc_one, arc_many = _archive(one), _archive(many)
    idx_one = bytes(arc_one.get_entry_by_path("index").get_item().content).decode(
        "utf-8"
    )
    idx_many = bytes(arc_many.get_entry_by_path("index").get_item().content).decode(
        "utf-8"
    )
    assert "1 article" in idx_one and "article(s)" not in idx_one
    assert "2 articles" in idx_many
    desc_one = bytes(arc_one.get_metadata("Description")).decode("utf-8")
    desc_many = bytes(arc_many.get_metadata("Description")).decode("utf-8")
    assert desc_one == "1 bookmarked article exported by Zimi"
    assert desc_many == "2 bookmarked articles exported by Zimi"


# ── provenance ──────────────────────────────────────────────────────────────


def test_bookmark_export_records_its_birth(tmp_path):
    out = zw.build_bookmarks_zim(_bookmarks(), str(tmp_path), reader=_fake_reader)
    arc = _archive(out)
    assert bytes(arc.get_metadata("Scraper")).decode() == f"Zimi {_srv.ZIMI_VERSION}"
    # An export has no outside source, so the source fields stay off entirely
    # rather than claiming something untrue.
    assert "Source" not in arc.metadata_keys
    assert zw.SOURCE_METADATA_KEY not in arc.metadata_keys

    records = zw.parse_history(arc.get_metadata(zw.HISTORY_METADATA_KEY))
    assert len(records) == 1, "creation writes exactly one record"
    rec = records[0]
    assert rec["op"] == "created" and rec["mode"] == "bookmarks"
    assert rec["zimi"] == _srv.ZIMI_VERSION
    assert rec["counts"] == {"pages": 2}
    assert "2 bookmarked articles" in rec["detail"]


def test_source_label_keeps_urls_and_strips_every_path():
    assert zw.source_label("https://sive.rs/blog") == "https://sive.rs/blog"
    assert zw.source_label("/Users/somebody/Field Notes") == "Field Notes"
    assert zw.source_label("/var/data/zims/trip.warc.gz") == "trip.warc.gz"
    assert zw.source_label(r"C:\Users\somebody\Docs\guide") == "guide"
    assert zw.source_label("/Users/somebody/guide/") == "guide"
    assert zw.source_label(None) == ""


def test_scraper_string_names_the_engine_when_one_ran():
    assert zw.scraper_string() == f"Zimi {_srv.ZIMI_VERSION}"
    assert zw.scraper_string("yt-dlp", "2026.07.04") == (
        f"Zimi {_srv.ZIMI_VERSION} + yt-dlp 2026.07.04"
    )
    assert zw.scraper_string("warc2zim") == f"Zimi {_srv.ZIMI_VERSION} + warc2zim"


def test_history_record_omits_what_it_does_not_know():
    rec = zw.history_record("created", "folder", "packaged a folder", ts=1786000000)
    assert rec == {
        "ts": 1786000000,
        "zimi": _srv.ZIMI_VERSION,
        "op": "created",
        "mode": "folder",
        "detail": "packaged a folder",
    }
    full = zw.history_record(
        "created",
        "video",
        "one video",
        tools={"yt-dlp": "2026.07.04", "ffmpeg": None},
        counts={"videos": 1, "bytes": 0, "pages": None},
    )
    # Empty tool slots and unknown counts are left out; a real zero is kept.
    assert full["tools"] == {"yt-dlp": "2026.07.04"}
    assert full["counts"] == {"videos": 1, "bytes": 0}


def test_history_is_bounded_and_says_what_it_dropped():
    records = []
    for i in range(zw.MAX_HISTORY_RECORDS + 25):
        records = zw.append_history(
            records, zw.history_record("edited", "entries", f"edit {i}")
        )
    assert len(records) == zw.MAX_HISTORY_RECORDS
    marker = records[0]
    assert marker["op"] == zw.TRUNCATED_OP
    assert marker["counts"]["records"] == 26  # everything before the kept 99
    assert "26 earlier records" in marker["detail"]
    # One marker, ever — the collapse folds into the existing one.
    assert sum(1 for r in records if r["op"] == zw.TRUNCATED_OP) == 1
    assert records[-1]["detail"] == f"edit {zw.MAX_HISTORY_RECORDS + 24}"


def test_history_of_a_zim_made_elsewhere_reads_as_none():
    assert zw.parse_history(None) == []
    assert zw.parse_history(b"not json at all") == []
    assert zw.parse_history('{"op": "created"}') == []  # an object, not a list
    assert zw.parse_history(b'[{"op":"created"},7]') == [{"op": "created"}]


# ── openZIM conformance ─────────────────────────────────────────────────────


def _png_size(data):
    """(width, height) straight out of a PNG's IHDR — no image library."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    return struct.unpack(">II", data[16:24])


def test_fit_text_cuts_on_a_word_boundary_and_says_so():
    assert zw.fit_text("short enough", 30) == "short enough"
    assert zw.fit_text("  collapses   whitespace ", 30) == "collapses whitespace"
    long_title = "A Really Rather Long Title That Will Not Fit The Cap"
    fitted = zw.fit_text(long_title, zw.MAX_TITLE_LENGTH)
    assert len(fitted) <= zw.MAX_TITLE_LENGTH
    assert fitted.endswith("…") and not fitted.endswith(" …")
    assert long_title.startswith(fitted[:-1])
    # A single unbroken word still has to fit.
    assert len(zw.fit_text("x" * 200, 30)) == 30


def test_language_is_forced_to_iso_639_3():
    assert zw.normalize_language("eng") == "eng"
    assert zw.normalize_language("EN") == "eng"  # the code people actually type
    assert zw.normalize_language("fr") == "fra"
    assert zw.normalize_language("eng,fra") == "eng,fra"
    assert zw.normalize_language("eng, eng") == "eng"  # deduped, spaces dropped
    assert zw.normalize_language(None) == "eng"
    for bad in ("english", "e", "xx"):
        with pytest.raises(ValueError, match="639-3"):
            zw.normalize_language(bad)


def test_zim_name_is_stable_per_source_and_distinct_between_sources():
    # Same source, twice: one identity, so a library sees a new EDITION.
    assert zw.zim_name("https://sive.rs/blog") == zw.zim_name("https://sive.rs/blog")
    # Path and query are part of that identity — this is the collision an
    # earlier basename-only version of this function actually produced.
    assert zw.zim_name("https://a.example/blog/post.html") != zw.zim_name(
        "https://b.example/blog/post.html"
    )
    assert zw.zim_name("https://t.example/p?list=A") != zw.zim_name(
        "https://t.example/p?list=B"
    )
    assert zw.zim_name("https://sive.rs/blog") == "zimi_eng_sive_rs_blog"
    assert zw.zim_name("Field Guide") == "zimi_eng_Field_Guide"
    assert zw.zim_name("guide", "fr") == "zimi_fra_guide"
    # A local path is still reduced to its basename — the privacy rule holds
    # here too, because Name travels with the file like everything else.
    assert zw.zim_name("/Users/somebody/Secret/guide") == "zimi_eng_guide"


def test_generated_illustration_is_a_real_48x48_png_and_is_deterministic():
    one = zw.default_illustration("zimi_eng_guide")
    assert _png_size(one) == (zw.ILLUSTRATION_SIZE, zw.ILLUSTRATION_SIZE)
    assert one == zw.default_illustration("zimi_eng_guide")
    assert one != zw.default_illustration("zimi_eng_other")


def test_tags_follow_the_semicolon_convention():
    assert zw.tags_string() == "_category:other;_ftindex:yes"
    assert zw.tags_string(["_videos:yes", "_category:other"]) == (
        "_category:other;_ftindex:yes;_videos:yes"
    )
    assert zw.media_tags(["image/png", "text/css"]) == ["_pictures:yes", "_videos:no"]
    assert zw.media_tags([]) == ["_pictures:no", "_videos:no"]
    assert zw.media_tags(["video/mp4"]) == ["_pictures:no", "_videos:yes"]


# ── link rewriting: no exported link may dangle ─────────────────────────────


def _linking_reader(zim, path):
    """A source article whose body links every way a real ZIM's does."""
    return (
        f"<html><head><title>{path}</title></head><body><h1>{path}</h1>"
        "<p><a href='Fire'>Fire</a> · "
        "<a href='../A/Boiling'>Boiling</a> · "
        "<a class='mw' title='old' href='Chlorine_(disinfectant)#uses'>Chlorine</a> · "
        "<a href='https://example.org/outside'>outside</a> · "
        "<a href='mailto:someone@example.org'>mail</a> · "
        "<a href='#top'>top</a></p></body></html>"
    )


def _wiki_url_for(zim, path):
    """Stands in for an installed en.wikipedia ZIM's canonical URL."""
    rest = path[2:] if path.startswith("A/") else path
    return "https://en.wikipedia.org/wiki/" + rest


def _hrefs(html):
    return re.findall(r"""<a\b[^>]*\bhref\s*=\s*["'](.*?)["']""", html)


def _read(arc, path):
    return bytes(arc.get_entry_by_path(path).get_item().content).decode("utf-8")


def test_link_to_an_exported_article_stays_internal(tmp_path):
    # Water links to Fire, and Fire IS in the export — that link must point at
    # the export's own copy, not off to the web.
    bms = [
        {"zim": "wikipedia_en", "path": "A/Water", "title": "Water"},
        {"zim": "wikipedia_en", "path": "A/Fire", "title": "Fire"},
    ]
    out = zw.build_bookmarks_zim(
        bms, str(tmp_path), reader=_linking_reader, url_for=_wiki_url_for
    )
    arc = _archive(out)
    art = _read(arc, "A/0_Water")
    assert "1_Fire" in _hrefs(art)
    assert arc.has_entry_by_path("A/1_Fire")


def test_link_outside_the_export_becomes_a_canonical_web_url(tmp_path):
    out = zw.build_bookmarks_zim(
        [{"zim": "wikipedia_en", "path": "A/Water", "title": "Water"}],
        str(tmp_path),
        reader=_linking_reader,
        url_for=_wiki_url_for,
    )
    art = _read(_archive(out), "A/0_Water")
    hrefs = _hrefs(art)
    assert "https://en.wikipedia.org/wiki/Fire" in hrefs
    assert "https://en.wikipedia.org/wiki/Boiling" in hrefs
    # The fragment rides along with the rewritten URL.
    assert "https://en.wikipedia.org/wiki/Chlorine_(disinfectant)#uses" in hrefs
    # Links that were already fine are untouched — no rewriting for its own sake.
    assert "https://example.org/outside" in hrefs
    assert "mailto:someone@example.org" in hrefs
    assert "#top" in hrefs
    # And the provenance header now points at the source article on the web.
    assert "https://en.wikipedia.org/wiki/Water" in hrefs


def test_link_with_no_derivable_url_is_unwrapped(tmp_path):
    # A source ZIM whose origin Zimi never learned: no honest URL exists, so
    # the anchor loses its href and keeps its text plus a pointer to the ZIM.
    out = zw.build_bookmarks_zim(
        [{"zim": "handbook", "path": "A/Water", "title": "Water"}],
        str(tmp_path),
        reader=_linking_reader,
        url_for=lambda zim, path: None,
    )
    art = _read(_archive(out), "A/0_Water")
    assert 'title="Not in this export — this article is in the handbook ZIM"' in art
    assert ">Fire</a>" in art  # the words survive
    assert "Fire" not in _hrefs(art)
    # The class the source ZIM put on the anchor is kept; its href and its old
    # title (now a lie) are not.
    assert "class='mw'" in art and "title='old'" not in art
    # Genuinely external links are still left alone.
    assert "https://example.org/outside" in _hrefs(art)


def test_link_to_a_carried_asset_points_at_the_carried_copy(tmp_path):
    # The thumbnail-to-full-size link every wiki article carries: the file came
    # along with the export, so the link belongs to the export's own copy.
    def reader(zim, path):
        return (
            "<html><body><a href='../I/pic.png'><img src='../I/pic.png'></a>"
            "</body></html>"
        )

    out = zw.build_bookmarks_zim(
        [{"zim": "wiki", "path": "A/Water", "title": "Water"}],
        str(tmp_path),
        reader=reader,
        asset_reader=_asset_reader,
        url_for=_wiki_url_for,
    )
    arc = _archive(out)
    assert arc.has_entry_by_path("_assets/wiki/I/pic.png")
    assert "../_assets/wiki/I/pic.png" in _hrefs(_read(arc, "A/0_Water"))
    assert _dangling_links(out) == []


def _dangling_links(zim_path):
    """Every internal href in a ZIM that resolves to no entry — the check
    `zimcheck -U` performs, run over ALL of them rather than the first."""
    arc = _archive(zim_path)
    dangling = []
    for i in range(arc.all_entry_count):
        entry = arc._get_entry_by_id(i)
        if entry.is_redirect:
            continue
        item = entry.get_item()
        if item.mimetype != "text/html":
            continue
        html = bytes(item.content).decode("utf-8", "replace")
        for href in _hrefs(html):
            target = zw._resolve_ref(entry.path, href)
            if target and not arc.has_entry_by_path(target):
                dangling.append((entry.path, href))
    return dangling


def test_no_exported_link_dangles(tmp_path):
    bms = [
        {"zim": "wikipedia_en", "path": "A/Water", "title": "Water"},
        {"zim": "wikipedia_en", "path": "A/Fire", "title": "Fire"},
        {"zim": "handbook", "path": "A/Rope", "title": "Rope"},
    ]
    out = zw.build_bookmarks_zim(
        bms,
        str(tmp_path),
        reader=_linking_reader,
        # Only the wikipedia ZIM has a derivable home, so this export exercises
        # all three cases at once.
        url_for=lambda z, p: _wiki_url_for(z, p) if z == "wikipedia_en" else None,
    )
    assert _dangling_links(out) == []


def test_the_dangling_link_check_can_actually_fail(tmp_path, monkeypatch):
    # The guard on the guard: with the rewrite disabled the same export is the
    # broken one this fix replaced, so a passing _dangling_links means something.
    monkeypatch.setattr(zw, "_rewrite_links", lambda html, *a, **kw: html)
    out = zw.build_bookmarks_zim(
        [{"zim": "wikipedia_en", "path": "A/Water", "title": "Water"}],
        str(tmp_path),
        reader=_linking_reader,
        url_for=_wiki_url_for,
        name="unrewritten",
    )
    assert _dangling_links(out) == [
        ("A/0_Water", "Fire"),
        ("A/0_Water", "../A/Boiling"),
        ("A/0_Water", "Chlorine_(disinfectant)#uses"),
    ]


def test_round_trip_into_an_installed_source_zim(tmp_path, monkeypatch):
    """The whole point, end to end: export out of a real ZIM, then feed the
    rewritten URLs back to the resolver the reader calls. Every one must land
    on the exact source entry it came from."""
    import zimi.interlang as il

    src = str(tmp_path / "wikipedia_en_test.zim")
    build_wiki_source_zim(src)
    monkeypatch.setattr(_srv, "_zim_files_cache", {"wikipedia_en_test": src})
    monkeypatch.setattr(_srv, "_archive_pool", {})
    monkeypatch.setattr(il, "_domain_zim_map", {})
    il._build_domain_zim_map()
    assert il.zim_domain("wikipedia_en_test") == "en.wikipedia.org"

    out = zw.build_bookmarks_zim(
        [
            {
                "zim": "wikipedia_en_test",
                "path": "A/Water_purification",
                "title": "Water purification",
            }
        ],
        str(tmp_path),
        name="round-trip",
    )
    assert _dangling_links(out) == []

    art = _read(_archive(out), "A/0_Water_purification")
    web = [h for h in _hrefs(art) if h.startswith("https://en.wikipedia.org/")]
    assert len(web) == 4  # three body links + the provenance header
    for url in web:
        resolved = il._resolve_url_to_zim(url)
        assert resolved, f"reader could not resolve {url} back to a ZIM"
        assert resolved["zim"] == "wikipedia_en_test"
        assert _archive(src).has_entry_by_path(resolved["path"])
    assert il._resolve_url_to_zim(
        "https://en.wikipedia.org/wiki/Chlorine_(disinfectant)"
    ) == {"zim": "wikipedia_en_test", "path": "A/Chlorine_(disinfectant)"}


def test_zim_domain_refuses_to_invent_a_website(monkeypatch):
    import zimi.interlang as il

    # The map's third discovery method GUESSES four TLDs for a ZIM it could not
    # place. A guess may serve as a lookup key, but never as a canonical home.
    monkeypatch.setattr(
        il,
        "_domain_zim_map",
        {
            "handbook.com": "handbook",
            "handbook.org": "handbook",
            "handbook.io": "handbook",
            "handbook.net": "handbook",
            "www.appropedia.org": "appropedia",
            "appropedia.org": "appropedia",
            "en.wikipedia.org": "wiki",
            "www.en.wikipedia.org": "wiki",
            "en.m.wikipedia.org": "wiki",
        },
    )
    assert il.zim_domain("handbook") is None
    assert il.canonical_url("handbook", "A/Rope") is None
    # A real domain wins over its www./mobile aliases.
    assert il.zim_domain("appropedia") == "appropedia.org"
    assert il.zim_domain("wiki") == "en.wikipedia.org"
    assert il.zim_domain("not-installed") is None


def test_canonical_url_follows_each_families_path_shape(monkeypatch):
    import zimi.interlang as il

    monkeypatch.setattr(
        il,
        "_domain_zim_map",
        {
            "en.wikipedia.org": "wp",
            "appropedia.org": "ap",
            "stackoverflow.com": "so",
            "explainxkcd.com": "xkcd",
            "apod.nasa.gov": "apod",
        },
    )
    assert il.canonical_url("wp", "A/Water") == "https://en.wikipedia.org/wiki/Water"
    assert il.canonical_url("ap", "Water") == "https://appropedia.org/wiki/Water"
    assert (
        il.canonical_url("so", "A/questions/12/why")
        == "https://stackoverflow.com/questions/12/why"
    )
    assert (
        il.canonical_url("xkcd", "A/1234:_Title")
        == "https://explainxkcd.com/wiki/index.php/1234:_Title"
    )
    # A host-prefixed entry path (the shape the resolver's general branch also
    # accepts) must not produce the domain twice.
    assert (
        il.canonical_url("apod", "apod.nasa.gov/apod/ap01.html")
        == "https://apod.nasa.gov/apod/ap01.html"
    )
    # Nothing to say, nothing said.
    assert il.canonical_url("wp", "") is None
    assert il.canonical_url("wp", "A/") is None


def test_short_description_ships_alone(tmp_path):
    out = zw.build_bookmarks_zim(_bookmarks(), str(tmp_path), reader=_fake_reader)
    arc = _archive(out)
    # Nothing was cut, so there is no longer description to tell — and the
    # spec's optional field stays off rather than repeating the short one.
    assert "LongDescription" not in arc.metadata_keys
