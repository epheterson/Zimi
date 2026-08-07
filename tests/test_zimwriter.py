"""Save to ZIM v1 — export bookmarks to a real .zim and read it back.

Uses libzim.writer (present on the dev Mac and in Docker); guarded with
importorskip so the suite still collects where the writer is absent.
"""

import os
import sys

import pytest

pytest.importorskip("libzim.writer")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from libzim.reader import Archive  # noqa: E402

import zimi.zimwriter as zw  # noqa: E402


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

    arc = Archive(out)
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
    arc = Archive(out)
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
    arc = Archive(out)
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
    idx = bytes(Archive(out).get_entry_by_path("index").get_item().content).decode(
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
    idx = bytes(Archive(out).get_entry_by_path("index").get_item().content).decode(
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
    arc_one, arc_many = Archive(one), Archive(many)
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
