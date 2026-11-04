"""Pages saved from a browser, packaged by Create → Folder.

The fixtures are real saves (tests/fixtures/saved_pages.zip): Firefox 147's own
"Web Page, complete" and "HTML only" (driven through nsIWebBrowserPersist),
Chrome 155's MHTML (Page.captureSnapshot), and reproductions of Chrome's
"complete" layout and Safari's .webarchive written from the same parts. The
pages are a local test page with every way a browser names and references a
part: a title with %, parentheses, & and quotes; query-string and extension-
less pictures; clashing names; srcset and <picture>; CSS backgrounds; iframes;
a base tag; and a lazy-loading script that swaps in a live-web address.
"""

import os
import re
import sys
import urllib.parse
import zipfile
from html.parser import HTMLParser

import pytest

pytest.importorskip("libzim.writer")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from libzim.reader import Archive  # noqa: E402

from zimi.libzimcompat import entry_by_id
from zimi import creator, folderfiles, savedpages  # noqa: E402

FIXTURES = os.path.join(REPO_ROOT, "tests", "fixtures", "saved_pages.zip")
# The weird-title page's folder holds " ? and ", which Windows cannot name.
needs_posix_names = pytest.mark.skipif(
    sys.platform == "win32", reason='a title with ? and " is not a Windows file name'
)

PNG = b"\x89PNG\r\n\x1a\n"


def _unpack(tmp_path, style, name):
    root = tmp_path / "src"
    with zipfile.ZipFile(FIXTURES) as z:
        for member in z.namelist():
            if member.startswith(f"{style}/{name}/"):
                z.extract(member, root)
    return str(root / style / name)


def _build(tmp_path, style, name, **kw):
    folder = _unpack(tmp_path, style, name)
    out = str(tmp_path / f"{style}-{name}.zim")
    log = []
    summary = creator.create_folder_zim(folder, out_path=out, progress=log.append, **kw)
    return Archive(out), summary, log


def _text(arc, path):
    return bytes(arc.get_entry_by_path(path).get_item().content).decode("utf-8")


def _entries(arc):
    return [
        entry_by_id(arc, i).path
        for i in range(arc.all_entry_count)
        if not entry_by_id(arc, i).path.startswith(
            ("X/", "M/", "fulltext/", "title/", "listing/")
        )
    ]


def _mime(arc, path):
    return arc.get_entry_by_path(path).get_item().mimetype


class _Refs(HTMLParser):
    """The files a page loads, as the reader's server would look them up."""

    def __init__(self):
        super().__init__()
        self.refs = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for k in ("src", "poster", "data"):
            if a.get(k):
                self.refs.append(a[k])
        if tag == "link" and a.get("href"):
            self.refs.append(a["href"])
        if a.get("srcset"):
            self.refs.extend(c.split()[0] for c in a["srcset"].split(",") if c.strip())


def _unresolved(arc, page_path):
    """Relative references of a page that name no entry (as the server reads
    them: the path decoded once)."""
    p = _Refs()
    p.feed(_text(arc, page_path))
    missing = []
    here = os.path.dirname(page_path)
    for ref in p.refs:
        if re.match(r"^(?:[a-z][a-z0-9+.-]*:|//|/|#)", ref, re.I):
            continue
        path = urllib.parse.unquote(urllib.parse.urlsplit(ref).path)
        target = os.path.normpath(os.path.join(here, path)).replace(os.sep, "/")
        if not arc.has_entry_by_path(target):
            missing.append(ref)
    return missing


def _the_page(arc):
    return next(
        p
        for p in _entries(arc)
        if p.endswith(".html") and "_files/" not in p and p not in ("index",)
    )


# ── Firefox "Web Page, complete" ────────────────────────────────────────────


@needs_posix_names
def test_a_firefox_save_loads_every_part_it_names(tmp_path):
    arc, summary, _ = _build(tmp_path, "firefox-complete", "odd")
    page = _the_page(arc)
    assert _unresolved(arc, page) == []
    assert summary["pages"] == 1


@needs_posix_names
def test_the_parts_of_a_saved_page_are_not_a_gallery_or_an_index_entry(tmp_path):
    arc, summary, _ = _build(tmp_path, "firefox-complete", "odd")
    assert not arc.has_entry_by_path("gallery")
    index = _text(arc, "index")
    assert "_files" not in index
    assert "Café (50% off)" in index
    # the link is a real link: % ? # and & in a name would break a bare href
    assert "%2550%25%20off" in index or "50%25%20off" in index
    assert "%3F" in index


@needs_posix_names
def test_the_index_says_where_a_saved_page_came_from(tmp_path):
    arc, _, _ = _build(tmp_path, "chrome-complete", "odd")
    assert "localhost:8765" in _text(arc, "index")


@needs_posix_names
def test_a_bare_percent_in_a_reference_is_made_valid(tmp_path):
    arc, _, _ = _build(tmp_path, "firefox-complete", "odd")
    html = _text(arc, _the_page(arc))
    assert "(50%%20off)" not in html
    assert "(50%25%20off)" in html


def test_a_picture_the_pages_script_would_swap_for_the_web_keeps_its_saved_copy(
    tmp_path,
):
    arc, _, _ = _build(tmp_path, "firefox-complete", "lazy")
    html = _text(arc, _the_page(arc))
    assert "localhost:8765" not in html
    assert re.search(r'data-src="Lazy%20page_files/lazy1\.png"', html)
    assert re.search(r'data-srcset="Lazy%20page_files/lazy2\.png"', html)


def test_a_frame_saved_with_the_page_is_part_of_it_not_an_article(tmp_path):
    arc, summary, _ = _build(tmp_path, "firefox-complete", "frames")
    assert summary["pages"] == 1
    assert "frame-inner" not in _text(arc, "index")
    # the frame's own picture and stylesheet still resolve
    assert _unresolved(arc, "Frames page_files/frame-inner.html") == []


def test_a_base_tag_page_keeps_its_parts(tmp_path):
    arc, _, _ = _build(tmp_path, "firefox-complete", "base")
    assert _unresolved(arc, _the_page(arc)) == []


@needs_posix_names
def test_html_only_is_a_page_and_nothing_else(tmp_path):
    arc, summary, _ = _build(tmp_path, "firefox-html", "odd")
    assert (summary["pages"], summary["assets"]) == (1, 0)


def test_a_page_picked_on_its_own_takes_its_parts_with_it(tmp_path):
    folder = _unpack(tmp_path, "firefox-complete", "lazy")
    out = str(tmp_path / "picked.zim")
    summary = creator.create_folder_zim(folder, out_path=out, only=["Lazy page.html"])
    arc = Archive(out)
    assert summary["assets"] == 3
    assert arc.has_entry_by_path("Lazy page_files/lazy1.png")


def test_a_folder_named_in_another_language_belongs_to_its_page(tmp_path):
    root = tmp_path / "de"
    (root / "Seite_Dateien").mkdir(parents=True)
    (root / "Seite.html").write_text(
        "<html><head><title>Seite</title></head><body>"
        "<img src='Seite_Dateien/bild.png'></body></html>",
        encoding="utf-8",
    )
    (root / "Seite_Dateien" / "bild.png").write_bytes(PNG + b"x")
    (root / "Seite_Notes").mkdir()
    (root / "Seite_Notes" / "other.png").write_bytes(PNG + b"y")
    out = str(tmp_path / "de.zim")
    creator.create_folder_zim(str(root), out_path=out, only=["Seite.html"])
    arc = Archive(out)
    assert arc.has_entry_by_path("Seite_Dateien/bild.png")
    assert not arc.has_entry_by_path("Seite_Notes/other.png")
    assert not arc.has_entry_by_path("gallery")


def test_a_part_saved_without_an_extension_is_served_as_what_the_page_says_it_is(
    tmp_path,
):
    root = tmp_path / "x"
    (root / "Page_files").mkdir(parents=True)
    (root / "Page.html").write_text(
        "<!DOCTYPE html><html><head><title>Page</title>"
        '<link rel="stylesheet" href="Page_files/css">'
        '<script src="Page_files/js"></script></head>'
        '<body><img src="Page_files/saved_resource"></body></html>',
        encoding="utf-8",
    )
    (root / "Page_files" / "css").write_text("body{color:red}", encoding="utf-8")
    (root / "Page_files" / "js").write_text("var a=1;", encoding="utf-8")
    (root / "Page_files" / "saved_resource").write_bytes(PNG + b"\0" * 16)
    out = str(tmp_path / "x.zim")
    creator.create_folder_zim(str(root), out_path=out)
    arc = Archive(out)
    assert _mime(arc, "Page_files/css") == "text/css"
    assert _mime(arc, "Page_files/js") == "text/javascript"
    assert _mime(arc, "Page_files/saved_resource") == "image/png"


def test_a_file_a_browser_named_with_percent_escapes_is_still_found(tmp_path):
    root = tmp_path / "x"
    (root / "Page_files").mkdir(parents=True)
    (root / "Page.html").write_text(
        "<html><head><title>Page</title></head><body>"
        '<img src="Page_files/%C4%90_a.jpg"><img src="Page_files/%C4%90_b.jpg">'
        "</body></html>",
        encoding="utf-8",
    )
    # one saved under its decoded name, one under the URL's own escapes
    (root / "Page_files" / "\u0110_a.jpg").write_bytes(b"\xff\xd8\xff\xe0a")
    (root / "Page_files" / "%C4%90_b.jpg").write_bytes(b"\xff\xd8\xff\xe0b")
    out = str(tmp_path / "x.zim")
    creator.create_folder_zim(str(root), out_path=out)
    arc = Archive(out)
    assert _unresolved(arc, "Page.html") == []


def test_a_picture_keeps_a_source_that_is_its_own_data_and_drops_one_on_the_web(tmp_path):
    root = tmp_path / "x"
    (root / "Page_files").mkdir(parents=True)
    (root / "Page.html").write_text(
        "<html><head><title>Page</title></head><body><picture>"
        '<source type="image/avif" srcset="data:image/avif;base64,AAAA 1x">'
        '<source type="image/webp" srcset="https://cdn.example.com/a.webp 1x, https://cdn.example.com/a2.webp 2x">'
        '<img src="Page_files/a.png"></picture></body></html>',
        encoding="utf-8",
    )
    (root / "Page_files" / "a.png").write_bytes(PNG + b"x")
    out = str(tmp_path / "x.zim")
    creator.create_folder_zim(str(root), out_path=out)
    html = _text(Archive(out), "Page.html")
    assert "data:image/avif;base64,AAAA" in html
    assert "cdn.example.com" not in html


def test_a_canonical_link_far_down_a_big_head_still_names_the_site(tmp_path):
    root = tmp_path / "x"
    root.mkdir()
    # Wikipedia's comes after 160 KB of inline script and style
    (root / "Tea.html").write_text(
        "<html><head><title>Tea</title><script>var a='" + "x" * 200_000 + "'</script>"
        '<link rel="canonical" href="https://en.wikipedia.org/wiki/Tea"></head><body>t</body></html>',
        encoding="utf-8",
    )
    out = str(tmp_path / "x.zim")
    creator.create_folder_zim(str(root), out_path=out)
    assert "en.wikipedia.org" in _text(Archive(out), "index")


def test_pictures_that_were_not_saved_are_reported(tmp_path):
    root = tmp_path / "x"
    root.mkdir()
    (root / "Page.html").write_text(
        "<html><head><title>P</title></head><body>"
        '<img src="https://cdn.example.com/a.jpg"></body></html>',
        encoding="utf-8",
    )
    log = []
    creator.create_folder_zim(
        str(root), out_path=str(tmp_path / "x.zim"), progress=log.append
    )
    assert any("1 picture not saved" in line for line in log)


# ── SingleFile ──────────────────────────────────────────────────────────────


@needs_posix_names
def test_a_singlefile_page_is_one_page_that_says_where_it_came_from(tmp_path):
    arc, summary, _ = _build(tmp_path, "singlefile", "odd")
    assert (summary["pages"], summary["assets"]) == (1, 0)
    assert "localhost:8765" in _text(arc, "index")
    assert "data:image/png;base64" in _text(arc, "odd.html")


# ── Chrome ──────────────────────────────────────────────────────────────────


@needs_posix_names
def test_a_chrome_complete_save_loads_every_part_it_names(tmp_path):
    arc, _, _ = _build(tmp_path, "chrome-complete", "odd")
    page = _the_page(arc)
    assert _unresolved(arc, page) == []
    # a clash is "logo (1).png"
    assert any(p.endswith("logo (1).png") for p in _entries(arc))


@pytest.mark.parametrize("name", ["odd", "lazy", "frames", "base"])
def test_a_chrome_single_file_page_is_unpacked_with_its_parts(tmp_path, name):
    if name == "odd" and sys.platform == "win32":
        pytest.skip("a title with ? is not a Windows file name")
    arc, summary, log = _build(tmp_path, "chrome-mhtml", name)
    assert summary["pages"] == 1
    page = _the_page(arc)
    assert _unresolved(arc, page) == []
    assert not any(p.endswith(".mhtml") for p in _entries(arc))
    assert any(line.startswith("unpacked ") for line in log)


@needs_posix_names
def test_single_file_css_and_inline_backgrounds_point_at_their_files(tmp_path):
    arc, _, _ = _build(tmp_path, "chrome-mhtml", "odd")
    page = _the_page(arc)
    html = _text(arc, page)
    # the inline style's picture is a saved file, not the address it came from
    assert "localhost:8765/img/inline" not in html
    assert "inline%20bg.png" in html
    css = next(p for p in _entries(arc) if p.endswith("main.css"))
    body = _text(arc, css)
    assert "bg%20image.png" in body and "localhost" not in body
    assert _mime(arc, css) == "text/css"
    # the @import is a file too, relative to the stylesheet
    assert 'url("' in body or "@import" in body


def test_single_file_frames_are_part_of_the_page(tmp_path):
    arc, summary, _ = _build(tmp_path, "chrome-mhtml", "frames")
    assert summary["pages"] == 1
    inner = next(p for p in _entries(arc) if "frame-inner" in p)
    assert _unresolved(arc, inner) == []


def test_single_file_page_keeps_where_it_came_from(tmp_path):
    arc, _, _ = _build(tmp_path, "chrome-mhtml", "base")
    assert "localhost:8765" in _text(arc, "index")


# ── Safari ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", ["odd", "lazy", "frames", "base"])
def test_a_safari_web_archive_is_unpacked_with_its_parts(tmp_path, name):
    if name == "odd" and sys.platform == "win32":
        pytest.skip("a title with ? is not a Windows file name")
    arc, summary, _ = _build(tmp_path, "safari-webarchive", name)
    assert summary["pages"] == 1
    assert _unresolved(arc, _the_page(arc)) == []
    assert not any(p.endswith(".webarchive") for p in _entries(arc))


def test_an_unreadable_archive_is_left_out_and_the_rest_is_packaged(tmp_path):
    root = tmp_path / "x"
    root.mkdir()
    (root / "broken.mhtml").write_text("not a page", encoding="utf-8")
    (root / "fine.html").write_text("<title>Fine</title><p>ok</p>", encoding="utf-8")
    log = []
    summary = creator.create_folder_zim(
        str(root), out_path=str(tmp_path / "x.zim"), progress=log.append
    )
    assert summary["pages"] == 1
    assert any(line.startswith("left out broken.mhtml") for line in log)


# ── the pieces ──────────────────────────────────────────────────────────────


def test_sniff_knows_what_a_picture_is_without_its_name():
    assert savedpages.sniff_mime(PNG + b"x") == "image/png"
    assert savedpages.sniff_mime(b"\xff\xd8\xff\xe0") == "image/jpeg"
    assert savedpages.sniff_mime(b"RIFF\0\0\0\0WEBPVP8 ") == "image/webp"
    assert savedpages.sniff_mime(b"<?xml?><svg xmlns='x'>") == "image/svg+xml"
    assert savedpages.sniff_mime(b"nothing known") is None


def test_companion_dirs_names_the_folder_a_page_owns():
    assert folderfiles.companion_dirs("A b.html", ["A b_files", "A b_other", "z"]) == [
        "A b_files"
    ]
    said = lambda: "<img src='A%20b_Dateien/x.png'>"  # noqa: E731
    assert folderfiles.companion_dirs(
        "A b.html", ["A b_Dateien", "A b_other"], said
    ) == ["A b_Dateien"]


def test_saved_pages_unpack_beside_the_output_not_in_temp(tmp_path, monkeypatch):
    # A saved page can hold 256 MiB and /tmp is RAM on some hosts.
    from zimi import creator

    seen = {}
    monkeypatch.setattr(creator, "_create_folder_zim", lambda folder, stage, **kw: seen.setdefault("stage", stage))
    out = tmp_path / "out"
    creator.create_folder_zim(str(tmp_path), out_dir=str(out))
    assert os.path.dirname(seen["stage"]) == str(out)


def test_a_picked_page_never_takes_a_linked_or_excluded_parts_folder(tmp_path):
    # Page_files as a link to somewhere else, or Zimi's own data folder,
    # must not be walked into the ZIM.
    root, outside = tmp_path / "share", tmp_path / "private"
    root.mkdir()
    outside.mkdir()
    (outside / "secret.txt").write_text("no", encoding="utf-8")
    (root / "a.html").write_text("<img src='a_files/x.png'>", encoding="utf-8")
    os.symlink(outside, root / "a_files")
    (root / "b.html").write_text("<img src='b_files/y.png'>", encoding="utf-8")
    (root / "b_files").mkdir()
    (root / "b_files" / "y.png").write_bytes(b"png")
    rels = [r for _, r in folderfiles.walk(str(root), only=["a.html", "b.html"])]
    assert rels == ["a.html", "b.html", "b_files/y.png"]
    real = os.path.realpath(root)
    rels = [r for _, r in folderfiles.walk(str(root), only=["b.html"], exclude={os.path.join(real, "b_files")})]
    assert rels == ["b.html"]
