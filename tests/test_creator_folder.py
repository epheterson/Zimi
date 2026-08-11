"""`zimi create <folder>` — a folder of HTML/Markdown/PDF becomes a ZIM.

Real end-to-end: builds actual .zim files from fixture folders and reads
them back with libzim's Archive. Guarded with importorskip so the suite
still collects where the writer is absent.
"""

import os
import re
import socket
import struct
import subprocess
import sys

import pytest

pytest.importorskip("libzim.writer")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from libzim.reader import Archive  # noqa: E402

import zimi.creator as creator  # noqa: E402
import zimi.server as _srv  # noqa: E402
from zimi.zimwriter import HISTORY_METADATA_KEY, parse_history  # noqa: E402

FAKE_PNG = b"\x89PNG\r\n\x1a\nFAKEPNGDATA"
FAKE_PDF = b"%PDF-1.4\nfake pdf body\n%%EOF"


def _entry_text(arc, path):
    return bytes(arc.get_entry_by_path(path).get_item().content).decode("utf-8")


def _make_fixture(root):
    """A representative folder: markdown + html + pdf + assets + subfolder."""
    (root / "docs").mkdir(parents=True)
    (root / "assets").mkdir()
    (root / "README.md").write_text(
        "# Field Guide\n\n"
        "Intro paragraph with **bold**, *italic*, and `code`.\n\n"
        "See [the notes](docs/notes.md) and ![a photo](assets/pic.png).\n\n"
        "```sh\necho 'hello' < input\n```\n\n"
        "- alpha\n- beta\n  1. nested\n\n"
        "> Stay calm.\n\n"
        "| Col A | Col B |\n|---|---|\n| 1 | 2 |\n"
    )
    (root / "docs" / "notes.md").write_text("# Notes\n\nJust notes.\n")
    (root / "page.html").write_text(
        "<html><head><title>Plain Page</title></head>"
        "<body><h1>Plain</h1><img src='assets/pic.png'></body></html>"
    )
    (root / "assets" / "pic.png").write_bytes(FAKE_PNG)
    (root / "assets" / "style.css").write_text("body{color:red}")
    (root / "manual.pdf").write_bytes(FAKE_PDF)


# ── markdown converter ──────────────────────────────────────────────────────


def test_markdown_core_constructs():
    body, title = creator.markdown_to_html(
        "# Title\n\nPara with **b**, *i*, `c < d`, [l](x.md), ![a](p.png).\n\n"
        "## Sub\n\n- one\n- two\n\n1. first\n2. second\n\n"
        "> quote line\n\n```py\nx = 1 < 2\n```\n\n---\n\n"
        "| H1 | H2 |\n|---|---|\n| a | b |\n"
    )
    assert title == "Title"
    assert "<h1>Title</h1>" in body and "<h2>Sub</h2>" in body
    assert "<strong>b</strong>" in body and "<em>i</em>" in body
    assert "<code>c &lt; d</code>" in body  # code spans escape their content
    assert '<a href="x.md">l</a>' in body
    assert '<img src="p.png" alt="a">' in body
    assert "<ul>" in body and "<ol>" in body and body.count("<li>") == 4
    assert "<blockquote>" in body
    assert '<pre><code class="language-py">x = 1 &lt; 2</code></pre>' in body
    assert "<hr>" in body
    assert "<th>H1</th>" in body and "<td>b</td>" in body


def test_markdown_nested_list_and_raw_html():
    body, _ = creator.markdown_to_html(
        "- outer\n  - inner\n\n<div class='raw'><span>kept</span></div>\n"
    )
    assert body.count("<ul>") == 2  # nesting by indentation
    assert "<div class='raw'><span>kept</span></div>" in body  # raw passthrough


def test_markdown_unknown_constructs_degrade_to_text():
    # Reference links and footnotes aren't supported — they must come out as
    # readable paragraph text, never crash or vanish.
    body, title = creator.markdown_to_html("Some [ref][1] text.\n\n[1]: http://x\n")
    assert title is None
    assert "Some [ref][1] text." in body


# ── folder build, end to end ────────────────────────────────────────────────


def test_folder_zim_end_to_end(tmp_path):
    src = tmp_path / "guide"
    _make_fixture(src)
    info = creator.create_folder_zim(str(src), out_dir=str(tmp_path / "out"))
    assert os.path.exists(info["path"])
    assert info["pages"] == 3 and info["assets"] == 3

    arc = Archive(info["path"])
    # README.md wins the main slot (no index.html present) and is rendered.
    assert arc.main_entry.get_item().path == "README.md"
    assert info["main"] == "README.md"
    readme = _entry_text(arc, "README.md")
    assert "<h1>Field Guide</h1>" in readme
    assert "<strong>bold</strong>" in readme
    assert '<a href="docs/notes.md">the notes</a>' in readme  # relative link kept
    assert "<table>" in readme
    # Hierarchy → ZIM paths; markdown entries keep their .md path but serve
    # rendered HTML, so links between files keep working unmodified.
    notes_item = arc.get_entry_by_path("docs/notes.md").get_item()
    assert "text/html" in notes_item.mimetype
    assert "<h1>Notes</h1>" in bytes(notes_item.content).decode("utf-8")
    # HTML passes through untouched.
    page = _entry_text(arc, "page.html")
    assert "<img src='assets/pic.png'>" in page
    # Assets and PDFs are byte-identical with honest mimetypes.
    pic = arc.get_entry_by_path("assets/pic.png").get_item()
    assert bytes(pic.content) == FAKE_PNG and pic.mimetype == "image/png"
    pdf = arc.get_entry_by_path("manual.pdf").get_item()
    assert bytes(pdf.content) == FAKE_PDF and pdf.mimetype == "application/pdf"
    # Standard metadata block.
    assert bytes(arc.get_metadata("Title")).decode() == "guide"
    assert bytes(arc.get_metadata("Creator")).decode() == "Zimi"
    assert bytes(arc.get_metadata("Language")).decode() == "eng"
    assert bytes(arc.get_metadata("Scraper")).decode() == f"Zimi {_srv.ZIMI_VERSION}"


def test_folder_zim_records_its_birth(tmp_path):
    src = tmp_path / "guide"
    src.mkdir()
    _make_fixture(src)
    info = creator.create_folder_zim(str(src), out_dir=str(tmp_path / "out"))
    arc = Archive(info["path"])

    # The source is the folder's NAME. A ZIM gets shared; the path it was
    # built from is nobody else's business.
    assert bytes(arc.get_metadata("X-Zimi-Source")).decode() == "guide"

    records = parse_history(arc.get_metadata(HISTORY_METADATA_KEY))
    assert len(records) == 1, "creation writes exactly one record"
    rec = records[0]
    assert rec["op"] == "created" and rec["mode"] == "folder"
    assert rec["zimi"] == _srv.ZIMI_VERSION
    assert isinstance(rec["ts"], int) and rec["ts"] > 1_700_000_000
    assert '"guide"' in rec["detail"]
    assert rec["counts"]["pages"] == info["pages"]
    assert rec["counts"]["assets"] == info["assets"]
    assert rec["counts"]["bytes"] > 0


def test_folder_zim_conforms_to_the_openzim_metadata_spec(tmp_path):
    """Every MANDATORY key, in the format zim-tools' own table enforces."""
    src = tmp_path / "guide"
    src.mkdir()
    _make_fixture(src)
    info = creator.create_folder_zim(str(src), out_dir=str(tmp_path / "out"))
    arc = Archive(info["path"])
    meta = {k: bytes(arc.get_metadata(k)) for k in arc.metadata_keys}

    for key in (
        "Name",
        "Title",
        "Language",
        "Creator",
        "Publisher",
        "Date",
        "Description",
        "Illustration_48x48@1",
    ):
        assert key in meta, f"mandatory metadata missing: {key}"
        assert meta[key], f"mandatory metadata empty: {key}"

    assert 1 <= len(meta["Title"].decode()) <= 30
    assert 1 <= len(meta["Description"].decode()) <= 80
    assert re.fullmatch(r"\w{3}(,\w{3})*", meta["Language"].decode())
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", meta["Date"].decode())
    assert (
        re.fullmatch(r"[^;]+(;[^;]+)*", meta["Tags"].decode())
        and "_category:other" in meta["Tags"].decode()
    )
    # The illustration is a real 48x48 PNG, not a placeholder byte string.
    png = meta["Illustration_48x48@1"]
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert struct.unpack(">II", png[16:24]) == (48, 48)
    # Counter is libzim's to write, and its spec regex admits no ";" or "="
    # inside a mimetype — which is why entries carry a BARE text/html.
    assert re.fullmatch(
        r"([a-zA-Z]+/[a-zA-Z0-9.\-+]+=\d+)(;[a-zA-Z0-9]+/[a-zA-Z0-9.\-+]+=\d+)*;?",
        meta["Counter"].decode(),
    ), meta["Counter"]


def test_name_is_the_same_for_two_builds_of_one_folder(tmp_path):
    src = tmp_path / "guide"
    src.mkdir()
    _make_fixture(src)
    first = creator.create_folder_zim(str(src), out_dir=str(tmp_path / "a"))
    second = creator.create_folder_zim(str(src), out_dir=str(tmp_path / "b"))
    name_of = lambda p: bytes(Archive(p).get_metadata("Name")).decode()  # noqa: E731
    # Same source, so a library sees the second file as a newer EDITION of the
    # first rather than an unrelated ZIM. The filenames still differ.
    assert name_of(first["path"]) == name_of(second["path"]) == "zimi_eng_guide"
    assert first["path"] != second["path"]


def test_overlong_title_and_description_are_cut_to_spec(tmp_path):
    src = tmp_path / "guide"
    src.mkdir()
    _make_fixture(src)
    long_title = "A Field Guide To Absolutely Every Mushroom In The Region"
    long_desc = (
        "A description that runs on well past the eighty character limit the "
        "openZIM specification imposes on this particular metadata field"
    )
    info = creator.create_folder_zim(
        str(src),
        out_dir=str(tmp_path / "out"),
        title=long_title,
        description=long_desc,
    )
    arc = Archive(info["path"])
    title = bytes(arc.get_metadata("Title")).decode()
    short = bytes(arc.get_metadata("Description")).decode()
    full = bytes(arc.get_metadata("LongDescription")).decode()
    assert len(title) <= 30 and title.endswith("…")
    assert len(short) <= 80 and short.endswith("…")
    # Nothing is lost: the full description becomes the LongDescription, which
    # the spec requires to be no shorter than the short one.
    assert full == long_desc and len(full) >= len(short)
    # A ZIM whose index page Zimi generates still carries the WHOLE title —
    # the cap costs a metadata field its tail, not the content its name.
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / "manual.pdf").write_bytes(FAKE_PDF)
    generated = creator.create_folder_zim(
        str(plain), out_dir=str(tmp_path / "out2"), title=long_title
    )
    index = _entry_text(Archive(generated["path"]), generated["main"])
    assert long_title in index


def test_provenance_never_leaks_the_machine_that_built_it(tmp_path):
    """Hard rule: no local path, no username, no hostname reaches the file."""
    src = tmp_path / "guide"
    src.mkdir()
    _make_fixture(src)
    info = creator.create_folder_zim(str(src), out_dir=str(tmp_path / "out"))
    arc = Archive(info["path"])

    leaks = [str(tmp_path), os.path.expanduser("~"), socket.gethostname()]
    blob = "\n".join(
        f"{key}={bytes(arc.get_metadata(key)).decode('utf-8', 'replace')}"
        for key in arc.metadata_keys
    )
    for secret in leaks:
        assert secret and secret not in blob, f"metadata leaked {secret!r}"


def test_index_html_wins_over_readme(tmp_path):
    src = tmp_path / "site"
    src.mkdir()
    (src / "index.html").write_text(
        "<html><head><title>Home</title></head><body>home</body></html>"
    )
    (src / "README.md").write_text("# Not the main page\n")
    info = creator.create_folder_zim(str(src), out_dir=str(tmp_path / "out"))
    assert info["main"] == "index.html"
    arc = Archive(info["path"])
    assert arc.main_entry.get_item().path == "index.html"
    # The page's real <title> feeds the title index.
    assert arc.get_entry_by_path("index.html").title == "Home"


def test_generated_index_when_no_entry_point(tmp_path):
    src = tmp_path / "papers"
    (src / "2024").mkdir(parents=True)
    (src / "2024" / "one.pdf").write_bytes(FAKE_PDF)
    (src / "intro.md").write_text("# Intro\n\nhello\n")
    info = creator.create_folder_zim(
        str(src), out_dir=str(tmp_path / "out"), title="Papers"
    )
    assert info["main"] == "index"
    arc = Archive(info["path"])
    idx = _entry_text(arc, "index")
    assert "<h1>Papers</h1>" in idx
    assert "href='intro.md'" in idx
    assert "href='2024/one.pdf'" in idx
    assert "1 page" in idx and "1 file" in idx


def test_hidden_junk_and_symlinks_skipped(tmp_path):
    src = tmp_path / "src"
    (src / ".git").mkdir(parents=True)
    (src / ".git" / "config").write_text("secret")
    (src / ".DS_Store").write_bytes(b"junk")
    (src / "real.md").write_text("# Real\n")
    outside = tmp_path / "outside.txt"
    outside.write_text("beyond the folder")
    os.symlink(outside, src / "escape.txt")
    info = creator.create_folder_zim(str(src), out_dir=str(tmp_path / "out"))
    arc = Archive(info["path"])
    assert arc.has_entry_by_path("real.md")
    assert not arc.has_entry_by_path(".DS_Store")
    assert not arc.has_entry_by_path(".git/config")
    assert not arc.has_entry_by_path("escape.txt")


def test_per_file_cap_names_the_offender(tmp_path, monkeypatch):
    monkeypatch.setattr(creator, "MAX_SOURCE_FILE_BYTES", 10)
    src = tmp_path / "src"
    src.mkdir()
    (src / "big.bin").write_bytes(b"x" * 11)
    with pytest.raises(creator.CreateError, match=r"big\.bin.*per-file cap"):
        creator.create_folder_zim(str(src), out_dir=str(tmp_path / "out"))


def test_total_cap_enforced(tmp_path, monkeypatch):
    monkeypatch.setattr(creator, "MAX_TOTAL_SOURCE_BYTES", 15)
    src = tmp_path / "src"
    src.mkdir()
    (src / "a.bin").write_bytes(b"x" * 10)
    (src / "b.bin").write_bytes(b"y" * 10)
    with pytest.raises(creator.CreateError, match="total cap"):
        creator.create_folder_zim(str(src), out_dir=str(tmp_path / "out"))


def test_missing_and_empty_folder_errors(tmp_path):
    with pytest.raises(creator.CreateError, match="not found"):
        creator.create_folder_zim(str(tmp_path / "nope"))
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(creator.CreateError, match="nothing to package"):
        creator.create_folder_zim(str(empty))


def test_explicit_out_path_no_clobber(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "a.md").write_text("# A\n")
    out = tmp_path / "custom.zim"
    info = creator.create_folder_zim(str(src), out_path=str(out))
    assert info["path"] == str(out) and out.exists()
    with pytest.raises(creator.CreateError, match="already exists"):
        creator.create_folder_zim(str(src), out_path=str(out))


def test_register_called_only_for_library_output(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(creator, "_register_exports", lambda paths: calls.extend(paths))
    src = tmp_path / "src"
    src.mkdir()
    (src / "a.md").write_text("# A\n")
    info = creator.create_folder_zim(
        str(src), out_dir=str(tmp_path / "zims"), register=True
    )
    assert info["registered"] is True and calls == [info["path"]]
    calls.clear()
    info2 = creator.create_folder_zim(str(src), out_path=str(tmp_path / "x.zim"))
    assert info2["registered"] is False and calls == []


def test_registration_failure_does_not_fail_create(tmp_path, monkeypatch):
    def _boom(paths):
        raise RuntimeError("library offline")

    monkeypatch.setattr(creator, "_register_exports", _boom)
    src = tmp_path / "src"
    src.mkdir()
    (src / "a.md").write_text("# A\n")
    info = creator.create_folder_zim(
        str(src), out_dir=str(tmp_path / "zims"), register=True
    )
    assert info["registered"] is False and os.path.exists(info["path"])


# ── CLI wiring, real subprocess ─────────────────────────────────────────────


def _cli_env(tmp_path):
    env = dict(os.environ)
    env["PYTHONPATH"] = REPO_ROOT
    env["ZIM_DIR"] = str(tmp_path / "zims")
    env.pop("ZIMI_OFFLINE", None)
    return env


def test_cli_create_folder_subprocess(tmp_path):
    src = tmp_path / "guide"
    _make_fixture(src)
    out = tmp_path / "cli-out.zim"
    r = subprocess.run(
        [
            sys.executable,
            "-m",
            "zimi",
            "create",
            str(src),
            "--out",
            str(out),
            "--title",
            "CLI Guide",
        ],
        capture_output=True,
        text=True,
        env=_cli_env(tmp_path),
        cwd=REPO_ROOT,
        timeout=120,
    )
    assert r.returncode == 0, r.stderr
    assert "ZIM written" in r.stdout
    arc = Archive(out)
    assert bytes(arc.get_metadata("Title")).decode() == "CLI Guide"


def test_cli_create_missing_folder_exits_2(tmp_path):
    r = subprocess.run(
        [sys.executable, "-m", "zimi", "create", str(tmp_path / "gone")],
        capture_output=True,
        text=True,
        env=_cli_env(tmp_path),
        cwd=REPO_ROOT,
        timeout=120,
    )
    assert r.returncode == 2
    assert "folder not found" in r.stderr


def test_cli_create_url_offline_exits_2(tmp_path):
    env = _cli_env(tmp_path)
    env["ZIMI_OFFLINE"] = "1"
    r = subprocess.run(
        [sys.executable, "-m", "zimi", "create", "https://example.com/x"],
        capture_output=True,
        text=True,
        env=env,
        cwd=REPO_ROOT,
        timeout=120,
    )
    assert r.returncode == 2
    assert "ZIMI_OFFLINE" in r.stderr
