"""Reddot: subreddits as ZIMs, made and read by Zimi.

Run: pytest tests/test_reddot.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import zimi.server as srv  # noqa: E402
from arcticzim_fixture import LISTING, POST, SUBS  # noqa: E402
from zimi import reddot  # noqa: E402
from zimi.creator import CreateError  # noqa: E402

FILES = {
    "subreddits": SUBS.encode(),
    "r/kiwix/top_page_1": LISTING.encode(),
    "r/kiwix/top_page_2": LISTING.replace("abc12", "zzz99").encode(),
    "r/kiwix/new_page_1": LISTING.replace("42", "1").encode(),
    "r/kiwix/abc12/": POST.encode(),
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
    reddot._reset_for_tests()
    srv.load_cache(force=True)


# ── names ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text,expected",
    [("kiwix", "kiwix"), ("r/kiwix", "kiwix"), ("/r/Kiwix/", "Kiwix"), ("https://www.reddit.com/r/kiwix", "kiwix"), ("https://old.reddit.com/r/kiwix/", "kiwix"),
     ("r/a", None), ("not a sub!", None), ("https://example.org/r/kiwix", None), ("", None)],
)
def test_a_subreddit_by_name_or_address(text, expected):
    assert reddot.normalize_subreddit(text) == expected


def test_the_cli_recognises_a_subreddit_and_leaves_urls_alone():
    assert reddot.looks_like_subreddit("r/kiwix") and reddot.looks_like_subreddit("https://www.reddit.com/r/kiwix/")
    assert not reddot.looks_like_subreddit("https://example.org/") and not reddot.looks_like_subreddit("kiwix")


def test_an_arcticzim_zim_is_a_reddit_kind():
    assert srv._zim_kind("arcticzim", "_category:reddit", "") == "reddit"


# ── the reader ─────────────────────────────────────────────────────────────


def test_the_listing_gives_score_title_flair_author_and_link_posts():
    rows = reddot.rows_from_listing(LISTING)
    assert [(r["id"], r["title"], r["score"], r["flair"], r["author"], r["external"]) for r in rows] == [
        ("abc12", "Zimi 1.9 is out & it is good", 42, "Release", "eric", ""),
        ("def34", "A link post", 7, "", "someone", "https://example.org/article"),
    ]
    assert rows[0]["page"] == "r/kiwix/abc12/" and rows[0]["date"] == "2026-09-01 12:00"
    assert reddot.pages_in(LISTING) == 7


def test_the_subreddit_list_is_read_once_each():
    assert reddot.subreddits_from_page(SUBS) == ["kiwix", "selfhosted"]


def test_a_post_is_owned_with_its_comment_tree():
    p = reddot.post_from_page(POST, "r/kiwix/abc12/", "reddit_kiwix")
    assert p["title"] == "Zimi 1.9 is out & it is good" and p["score"] == 42 and p["author"] == "eric" and p["flair"] == "Release"
    assert 'href="/w/reddit_kiwix/r/kiwix/def34/"' in p["body"] and 'src="/w/reddit_kiwix/images/x.png"' in p["body"]
    tree = p["comments"]
    assert [(c["id"], c["author"], c["score"], len(c["children"])) for c in tree] == [("c1", "alice", 10, 1), ("c3", "carol", 1, 0)]
    child = tree[0]["children"][0]
    assert (child["id"], child["author"], child["score"]) == ("c2", "bob", 3)
    assert "<script" not in child["body"] and "Agreed" in child["body"]
    assert tree[0]["body"].strip() == "<p>Nice.</p>", "a body carries no closing tag of its own container"
    assert "</DIV>" not in child["body"].upper()


def test_the_whole_thing_through_a_zim(tmp_path, monkeypatch):
    _library(tmp_path, monkeypatch, [("reddit_kiwix.zim", {"Scraper": "arcticzim", "Name": "reddit_kiwix", "Tags": "_category:reddit"}, FILES), ("survival_en_2026-06.zim", None, {})])
    name = srv._zim_short_name("reddit_kiwix.zim")
    assert [z["name"] for z in reddot.zims()] == [name]
    assert reddot.subreddits(name) == ["kiwix", "selfhosted"]
    home = reddot.home()
    assert home["zims"][0]["shelves"][0]["subreddit"] == "kiwix" and home["zims"][0]["shelves"][0]["rows"][0]["id"] == "abc12"
    assert home["zims"][0]["shelves"][1]["rows"] == []  # selfhosted has no pages in this fixture
    assert reddot.listing(name, "kiwix", "top", 2)["rows"][0]["id"] == "zzz99"
    assert reddot.listing(name, "kiwix", "new", 1)["rows"][0]["score"] == 1
    assert reddot.listing(name, "kiwix", "hot", 1)["rows"][0]["id"] == "abc12"  # an unknown sort is top
    assert reddot.post(name, "r/kiwix/abc12/")["comments"][0]["author"] == "alice"
    assert reddot.post(name, "r/kiwix/nope/") is None
    assert reddot.post("survival", "r/kiwix/abc12/") is None


# ── the maker ──────────────────────────────────────────────────────────────


def test_a_bad_name_never_reaches_the_maker(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    with pytest.raises(CreateError):
        reddot.create_reddit_zim("not a sub!", out_dir=str(tmp_path))


def test_offline_without_the_maker_says_how_to_get_it(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(reddot, "_is_offline", lambda: True)
    with pytest.raises(CreateError) as e:
        reddot.ensure_sidecar()
    assert "--setup-reddit" in str(e.value)
    assert reddot.sidecar_status() == {"installed": False, "dir": os.path.join(str(tmp_path), "tools", "arcticzim")}


def test_the_pipeline_runs_the_four_steps_and_registers(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(reddot, "ensure_sidecar", lambda sink=None: "/fake/arcticzim")
    ran = []

    def fake_run(cmd, sink):
        ran.append(cmd[1] if cmd[1] != "-v" else cmd[2])
        if cmd[1] == "-v":
            with open(cmd[-1], "wb") as f:
                f.write(b"ZIM")
        return 0

    monkeypatch.setattr(reddot, "_run_stream", fake_run)
    monkeypatch.setattr(reddot, "_try_register", lambda path: True)
    said = []
    info = reddot.create_reddit_zim("r/Kiwix", out_dir=str(tmp_path), register=True, progress=said.append)
    assert ran == ["retrieve", "retrieve", "import", "build"]
    assert info["name"] == "reddit_kiwix" and info["registered"] is True and info["title"] == "r/Kiwix"
    assert os.path.exists(info["path"]) and not os.path.exists(info["path"] + ".part")
    assert not os.path.isdir(os.path.join(str(tmp_path), "staging")) or not os.listdir(os.path.join(str(tmp_path), "staging"))
    assert any("Arctic Shift" in s for s in said)


def test_a_failed_step_leaves_nothing_behind(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(reddot, "ensure_sidecar", lambda sink=None: "/fake/arcticzim")
    monkeypatch.setattr(reddot, "_run_stream", lambda cmd, sink: 1)
    with pytest.raises(CreateError) as e:
        reddot.create_reddit_zim("kiwix", out_dir=str(tmp_path))
    assert "fetching posts" in str(e.value)
    assert not [f for f in os.listdir(str(tmp_path)) if f.endswith(".zim") or f.endswith(".part")]


def test_the_routes_are_rate_limited_as_api_paths():
    from zimi import http

    assert "/reddot" in http._RATE_LIMITED_API_PATHS
