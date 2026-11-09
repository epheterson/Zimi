"""`zimi check`: a ZIM Zimi wrote is clean, and each defect is named."""

import os
import subprocess
import sys

import pytest

pytest.importorskip("libzim.writer")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

import zimi.creator as creator  # noqa: E402
from libzim.writer import Creator  # noqa: E402

from tests.conftest_zim import _Article, build_fixture_zim  # noqa: E402
from zimi import zimcheck  # noqa: E402


def _folder_zim(tmp_path):
    src = tmp_path / "guide"
    src.mkdir()
    (src / "README.md").write_text(
        "# Guide\n\nSee [notes](notes.md).\n", encoding="utf-8"
    )
    (src / "notes.md").write_text("# Notes\n\nJust notes.\n", encoding="utf-8")
    return creator.create_folder_zim(str(src), out_dir=str(tmp_path / "out"))["path"]


def _checks(findings):
    return {(f["level"], f["check"]) for f in findings}


def test_a_zim_zimi_wrote_is_clean(tmp_path):
    assert zimcheck.check(_folder_zim(tmp_path)) == []


def _linking_zim(tmp_path):
    path = str(tmp_path / "linking.zim")
    with Creator(path).config_indexing(False, "eng") as c:
        c.set_mainpath("home.html")
        c.add_item(
            _Article(
                "home.html",
                "Home",
                b"<html><body><a href='here.html'>ok</a> <a href='gone.html#x'>broken</a> "
                b"<a href='https://example.org/a'>out</a>"
                b"<script>a.href = 'in-code/'</script></body></html>",
            )
        )
        c.add_item(_Article("here.html", "Here", b"<html><body>hi</body></html>"))
        c.add_redirection("old.html", "Old", "nowhere.html", {})
    return path


def test_missing_metadata_and_a_dangling_link_are_named(tmp_path):
    findings = zimcheck.check(_linking_zim(tmp_path))
    messages = " | ".join(f["message"] for f in findings)
    for key in ("Name", "Creator", "Publisher", "Date", "Illustration_48x48@1"):
        assert f"{key} is missing" in messages, messages
    assert "home.html links to gone.html#x" in messages
    assert "here.html" not in messages.replace("home.html", "")
    assert "https://example.org" not in messages
    assert "in-code" not in messages  # a script's string is not a link


def test_quick_skips_the_link_scan(tmp_path):
    path = _linking_zim(tmp_path)
    assert ("error", "links") not in _checks(zimcheck.check(path, quick=True))
    assert ("error", "metadata") in _checks(zimcheck.check(path, quick=True))


def test_overlong_title_and_bad_date_and_language(tmp_path):
    path = build_fixture_zim(
        str(tmp_path / "bad.zim"),
        metadata={"Title": "T" * 31, "Date": "11/09/2026", "Language": "en"},
    )
    messages = " | ".join(f["message"] for f in zimcheck.check(path, quick=True))
    assert "Title is 31 characters" in messages
    assert "not YYYY-MM-DD" in messages
    assert "not ISO 639-3" in messages


def test_not_a_zim_is_one_error(tmp_path):
    bad = tmp_path / "x.zim"
    bad.write_bytes(b"not a zim")
    findings = zimcheck.check(str(bad))
    assert [f["check"] for f in findings] == ["open"]


def test_cli_exit_code_and_report(tmp_path):
    good = _folder_zim(tmp_path)
    bad = build_fixture_zim(str(tmp_path / "bare.zim"))
    run = lambda *files: subprocess.run(  # noqa: E731
        [sys.executable, "-m", "zimi", "check", *files],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    ok = run(good)
    assert ok.returncode == 0 and ": ok" in ok.stdout, ok.stdout + ok.stderr
    fail = run(bad)
    assert fail.returncode == 1 and "Creator is missing" in fail.stdout


def test_the_games_about_page_links_only_to_pages_that_exist():
    """zimi check found `puzzles/doc/` (a folder, in no ZIM) as the manual link's
    default; it is a real page now, so a reader without scripts has no dead link."""
    games = os.path.join(REPO_ROOT, "zimi", "builtin", "games")
    with open(os.path.join(games, "about.html"), encoding="utf-8") as f:
        html = f.read()
    html = zimcheck.NON_MARKUP_RE.sub("", html)
    for ref in dict.fromkeys(zimcheck.HREF_RE.findall(html)):
        target = zimcheck._resolve("about.html", ref)
        if target and not target.startswith(("about.html", "{")):
            assert os.path.isfile(os.path.join(games, target)), ref
