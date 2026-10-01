"""Folder mode on the web (2026-09-30): the lazy tree under the create root,
the containment every path from the page goes through, the sidecar format,
and a mixed folder built into one ZIM whose apps each find their part.

Eric: "offer folder ... show the whole tree and allow selecting any subset
... a large variety of compatible formats ... include metadata as a text
file beside." The security half is the one that matters most: the tree reads
the server's disk, so every escape below must be refused, and a naive
``os.path.join(root, rel)`` lets most of them through.
"""

import io
import json
import os
import sys
from urllib.parse import urlparse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.manage as manage  # noqa: E402
import zimi.server as server  # noqa: E402
from zimi import folderfiles  # noqa: E402


class _Handler:
    def __init__(self):
        self.status = None
        self.body: dict = {}
        self.headers = {}

    def _json(self, status, body):
        self.status = status
        self.body = body

    def _is_private_client(self):
        return True


def _get(path, params=None):
    h = _Handler()
    query = {k: [v] for k, v in (params or {}).items()}
    manage.handle_manage_get(h, urlparse(path), query)
    return h


def _post(path, data):
    h = _Handler()
    manage.handle_manage_post(h, urlparse(path), data)
    return h


@pytest.fixture
def root(tmp_path, monkeypatch):
    """A create root holding a folder, a secret NEXT to the root, and every
    kind of link out of it."""
    r = tmp_path / "root"
    (r / "box" / "deep").mkdir(parents=True)
    (r / ".hidden").mkdir()
    (r / ".hidden" / "x.md").write_text("# hidden")
    (r / "box" / "a.md").write_text("# A")
    (r / "box" / "deep" / "b.md").write_text("# B")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.md").write_text("# secret")
    os.symlink(str(outside), str(r / "outlink"))
    os.symlink(str(outside / "secret.md"), str(r / "box" / "secret.md"))
    os.symlink(str(r / "box"), str(r / "inlink"))  # inside, but a link all the same
    data = r / "zimidata"
    data.mkdir()
    (data / "cache.json").write_text("{}")
    monkeypatch.setenv(manage.CREATE_ROOT_ENV, str(r))
    monkeypatch.setattr(server, "ZIMI_DATA_DIR", str(data))
    monkeypatch.setattr(manage, "_primary_admin_authorized", lambda h: True)
    manage._create_job = None
    yield r
    manage._create_job = None


ESCAPES = (
    "..",
    "../outside",
    "../outside/secret.md",
    "box/../../outside",
    "/etc",
    "//etc",
    "C:/Windows",
    "box\\..\\..",
    "outlink",
    "outlink/secret.md",
    "box/secret.md",
    "inlink",
    ".hidden",
    "box/./a.md",
    "zimidata",
    "box\x00",
)


# ── containment ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("rel", ESCAPES)
def test_resolve_refuses_every_way_out(root, rel):
    with pytest.raises(folderfiles.OutsideRoot):
        folderfiles.resolve(
            str(root), rel, folderfiles.real_paths([str(root / "zimidata")])
        )


@pytest.mark.parametrize("rel", ESCAPES)
def test_the_tree_route_refuses_every_way_out(root, rel):
    h = _get("/manage/create/tree", {"path": rel})
    assert h.status == 400, (rel, h.body)
    assert "secret" not in json.dumps(h.body)


@pytest.mark.parametrize("rel", ESCAPES)
def test_a_folder_job_refuses_every_way_out_as_source_and_subset(root, rel):
    assert _post("/manage/create", {"mode": "folder", "source": rel}).status == 400, rel
    h = _post("/manage/create", {"mode": "folder", "source": ".", "only": [rel]})
    assert h.status == 400, rel


def test_the_tree_is_for_the_primary_admin(root, monkeypatch):
    monkeypatch.setattr(manage, "_primary_admin_authorized", lambda h: False)
    assert _get("/manage/create/tree", {"path": ""}).status == 403
    assert _post("/manage/create", {"mode": "folder", "source": "box"}).status == 403
    assert (
        _post("/manage/create/probe", {"mode": "folder", "source": "box"}).status == 403
    )


def test_the_listing_hides_links_hidden_folders_and_zimis_data(root):
    h = _get("/manage/create/tree", {"path": ""})
    assert h.status == 200
    names = [e["name"] for e in h.body["entries"]]
    assert names == ["box"]
    box = _get("/manage/create/tree", {"path": "box"}).body
    assert [(e["name"], e["kind"]) for e in box["entries"]] == [
        ("deep", "dir"),
        ("a.md", "file"),
    ]


# ── lazy ────────────────────────────────────────────────────────────────────


def test_listing_reads_one_directory_and_never_walks(root, monkeypatch):
    """On a NAS share a recursive walk is the expensive thing. The listing
    may open exactly one directory per request."""
    opened = []
    real_scandir = os.scandir

    def counting(path):
        opened.append(path)
        return real_scandir(path)

    def no_walk(*_a, **_k):
        raise AssertionError("the tree listing walked the disk")

    monkeypatch.setattr(folderfiles.os, "scandir", counting)
    monkeypatch.setattr(folderfiles.os, "walk", no_walk)
    assert _get("/manage/create/tree", {"path": ""}).status == 200
    assert len(opened) == 1


def test_a_big_folder_pages(root):
    big = root / "big"
    big.mkdir()
    for i in range(folderfiles.LIST_PAGE + 50):
        (big / f"f{i:04d}.md").write_text("x")
    first = _get("/manage/create/tree", {"path": "big"}).body
    assert len(first["entries"]) == folderfiles.LIST_PAGE
    assert first["more"] == 50 and first["total"] == folderfiles.LIST_PAGE + 50
    rest = _get(
        "/manage/create/tree", {"path": "big", "offset": str(folderfiles.LIST_PAGE)}
    ).body
    assert len(rest["entries"]) == 50 and rest["more"] == 0
    assert rest["entries"][0]["name"] == f"f{folderfiles.LIST_PAGE:04d}.md"


def test_each_file_says_what_it_becomes(root):
    box = root / "box"
    for name in (
        "p.html",
        "n.txt",
        "d.pdf",
        "e.epub",
        "i.webp",
        "v.mp4",
        "m.mkv",
        "s.flac",
        "c.css",
        "z.zim",
        "w.docx",
        "o.avi",
    ):
        (box / name).write_bytes(b"x")
    (box / "v.txt").write_text("Title: A video\n")
    rows = {
        e["name"]: e
        for e in _get("/manage/create/tree", {"path": "box"}).body["entries"]
    }
    assert rows["p.html"]["family"] == "page" and rows["n.txt"]["family"] == "page"
    assert (
        rows["d.pdf"]["family"] == "document" and rows["e.epub"]["family"] == "document"
    )
    assert rows["i.webp"]["family"] == "image"
    assert rows["v.mp4"]["family"] == "video" and "plays" not in rows["v.mp4"]
    assert rows["m.mkv"]["plays"] == "some"
    assert rows["s.flac"]["family"] == "audio"
    assert rows["c.css"]["family"] == "asset"
    assert (rows["z.zim"]["family"], rows["z.zim"]["reason"]) == ("unsupported", "zim")
    assert (
        rows["w.docx"]["reason"] == "office"
        and rows["o.avi"]["reason"] == "video_format"
    )
    assert (rows["v.txt"]["family"], rows["v.txt"]["sidecar"]) == ("sidecar", "v.mp4")


# ── sidecars ────────────────────────────────────────────────────────────────


def test_sidecar_lines_are_case_insensitive_and_only_known_keys_count():
    got = folderfiles.parse_sidecar(
        "TITLE: The Walk\nauthor:  Ann Lee \nColor: blue\nnot a key line\nTitle: second\n",
        folderfiles.ITEM_KEYS,
    )
    assert got == {"title": "The Walk", "author": "Ann Lee"}
    assert (
        folderfiles.parse_sidecar("Just prose: with a colon", folderfiles.ITEM_KEYS)
        == {}
    )


def test_sidecar_json_takes_lists_and_ignores_the_rest():
    got = folderfiles.parse_sidecar(
        json.dumps({"Title": "Box", "Tags": ["a", "b"], "Icon": "i.png", "x": 1}),
        folderfiles.FOLDER_KEYS,
        as_json=True,
    )
    assert got == {"title": "Box", "tags": "a, b", "icon": "i.png"}
    assert (
        folderfiles.parse_sidecar("[1, 2]", folderfiles.FOLDER_KEYS, as_json=True) == {}
    )
    assert (
        folderfiles.parse_sidecar("{broken", folderfiles.FOLDER_KEYS, as_json=True)
        == {}
    )


def test_prose_beside_a_file_stays_a_page_and_a_description_is_folded_in(tmp_path):
    (tmp_path / "notes.pdf").write_bytes(b"%PDF")
    (tmp_path / "notes.txt").write_text("These are my notes about the PDF.")
    (tmp_path / "talk.mp4").write_bytes(b"x")
    (tmp_path / "talk.mp4.json").write_text('{"title": "The talk"}')
    plan = folderfiles.plan(str(tmp_path))
    assert ("notes.txt", "page") in [(rel, fam) for _f, rel, fam in plan["items"]]
    assert plan["sidecars"] == {"talk.mp4": {"title": "The talk"}}
    assert "talk.mp4.json" not in [rel for _f, rel, _fam in plan["items"]]


def test_a_cover_that_leaves_the_folder_is_ignored(tmp_path):
    (tmp_path / "in").mkdir()
    (tmp_path / "secret.png").write_bytes(b"x")
    (tmp_path / "in" / "b.pdf").write_bytes(b"%PDF")
    (tmp_path / "in" / "b.txt").write_text("Cover: ../secret.png\n")
    plan = folderfiles.plan(str(tmp_path / "in"))
    assert plan["covers"] == []


def test_a_picked_file_brings_its_sidecar_and_cover_but_nothing_else(tmp_path):
    (tmp_path / "other").mkdir()
    (tmp_path / "other" / "x.md").write_text("# x")
    (tmp_path / "b.pdf").write_bytes(b"%PDF")
    (tmp_path / "b.txt").write_text("Title: Book\nCover: b.jpg\n")
    (tmp_path / "b.jpg").write_bytes(b"x")
    plan = folderfiles.plan(str(tmp_path), ["b.pdf"])
    assert [rel for _f, rel, _fam in plan["items"]] == ["b.pdf"]
    assert plan["sidecars"] == {"b.pdf": {"title": "Book", "cover": "b.jpg"}}
    assert [rel for _f, rel in plan["covers"]] == ["b.jpg"]


# ── the build ───────────────────────────────────────────────────────────────


def _png(color):
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (64, 64), color).save(out, "PNG")
    return out.getvalue()


def _mixed_folder(at):
    at.mkdir(parents=True)
    (at / "zimi.txt").write_text(
        "Title: Family Archive\nDescription: Everything from the attic\nLanguage: fra\n"
        "Creator: The Lees\nPublisher: Lee Press\nTags: family; photos\nIcon: icon.png\n"
    )
    (at / "icon.png").write_bytes(_png("red"))
    (at / "letter.txt").write_text("Dear all,\n\n  the attic is full.")
    (at / "notes.md").write_text("# Notes\n\nSome notes.")
    (at / "book.pdf").write_bytes(b"%PDF-1.4\n%%EOF")
    (at / "book.txt").write_text(
        "Title: The Attic Book\nAuthor: Ann Lee\nDate: 1950\nCover: covers/book.png\n"
    )
    (at / "covers").mkdir()
    (at / "covers" / "book.png").write_bytes(_png("blue"))
    (at / "photos").mkdir()
    (at / "photos" / "beach.png").write_bytes(_png("yellow"))
    (at / "photos" / "beach.json").write_text('{"title": "At the beach"}')
    (at / "home.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42")
    (at / "home.txt").write_text(
        "Title: Home movie\nAuthor: Grandpa\nDescription: 1962\n"
    )
    (at / "song.mp3").write_bytes(b"ID3")
    (at / "old.zim").write_bytes(b"ZIM")
    (at / "budget.xlsx").write_bytes(b"PK")
    return at


def test_a_mixed_folder_becomes_one_zim_each_app_reads(tmp_path):
    pytest.importorskip("libzim.writer")
    pytest.importorskip("PIL")
    from libzim.reader import Archive

    from zimi import creator, nautilus

    src = _mixed_folder(tmp_path / "attic")
    lines = []
    info = creator.create_folder_zim(
        str(src), out_path=str(tmp_path / "out.zim"), progress=lines.append
    )
    arc = Archive(info["path"])

    def meta(k):
        return bytes(arc.get_metadata(k)).decode()

    assert meta("Title") == "Family Archive"
    assert meta("Description") == "Everything from the attic"
    assert meta("Language") == "fra" and meta("Creator") == "The Lees"
    assert meta("Publisher") == "Lee Press"
    assert "family" in meta("Tags").split(";") and "photos" in meta("Tags").split(";")
    assert info["unsupported"] == [
        {"path": "budget.xlsx", "reason": "office"},
        {"path": "old.zim", "reason": "zim"},
    ]
    assert any("left out old.zim" in str(line) for line in lines)

    def text(path):
        return bytes(arc.get_entry_by_path(path).get_item().content).decode()

    # Bookshelf: the listing, with the sidecar's words and its cover.
    rows = nautilus.parse(text(nautilus.ZIMI_DATABASE_PATH))
    assert rows == [
        {
            "_id": "00000",
            "ti": "The Attic Book",
            "dsc": "",
            "aut": "Ann Lee",
            "fp": ["book.pdf"],
            "dt": "1950",
            "cv": "covers/book.png",
        }
    ]
    # ZimiTube: the video and the song, the video described by its sidecar.
    videos = {v["id"]: v for v in json.loads(text("videos.json"))}
    assert (
        videos["home.mp4"]["title"] == "Home movie"
        and videos["home.mp4"]["speaker"] == "Grandpa"
    )
    assert videos["song.mp3"]["audio"] is True
    # Reader: a text page, a gallery of the pictures that are not covers or the icon.
    assert "the attic is full." in text("letter.txt") and "<pre" in text("letter.txt")
    gallery = text("gallery")
    assert "photos/beach.png" in gallery and "At the beach" in gallery
    assert "covers/book.png" not in gallery and "icon.png" not in gallery
    assert "gallery" in text(arc.main_entry.get_item().path)
    for sidecar in ("zimi.txt", "book.txt", "home.txt", "photos/beach.json"):
        assert not arc.has_entry_by_path(sidecar), sidecar


def test_only_a_subset_is_read(tmp_path):
    pytest.importorskip("libzim.writer")
    from libzim.reader import Archive

    from zimi import creator

    src = _mixed_folder(tmp_path / "attic")
    info = creator.create_folder_zim(
        str(src), out_path=str(tmp_path / "o.zim"), only=["photos", "notes.md"]
    )
    arc = Archive(info["path"])
    assert arc.has_entry_by_path("photos/beach.png") and arc.has_entry_by_path(
        "notes.md"
    )
    assert not arc.has_entry_by_path("book.pdf") and not arc.has_entry_by_path(
        "home.mp4"
    )
    with pytest.raises(creator.CreateError):
        creator.create_folder_zim(
            str(src), out_path=str(tmp_path / "x.zim"), only=["../attic"]
        )


def test_cli_only_flag(tmp_path):
    pytest.importorskip("libzim.writer")
    import subprocess

    from libzim.reader import Archive

    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = _mixed_folder(tmp_path / "attic")
    out = tmp_path / "c.zim"
    env = dict(os.environ, PYTHONPATH=repo, ZIM_DIR=str(tmp_path / "zims"), ZIMI_TORRENT="0")
    r = subprocess.run(
        [sys.executable, "-m", "zimi", "create", str(src), "--only", "notes.md", "letter.txt", "--out", str(out)],
        capture_output=True, text=True, env=env, cwd=repo, timeout=120,
    )
    assert r.returncode == 0, r.stderr
    arc = Archive(str(out))
    assert arc.has_entry_by_path("notes.md") and arc.has_entry_by_path("letter.txt")
    assert not arc.has_entry_by_path("book.pdf")
    assert bytes(arc.get_metadata("Title")).decode() == "Family Archive"
