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
    "subreddits/": SUBS.encode(),
    "r/kiwix/top_page_1/": LISTING.encode(),
    "r/kiwix/top_page_2": LISTING.replace("abc12", "zzz99").encode(),
    "r/kiwix/new_page_1/": LISTING.replace("42", "1").encode(),
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
    assert tree[0]["body"].strip() == "<p>Nice.", "a body carries no closing tag of its own container"
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

    def fake_run(cmd, sink, watch=None):
        assert cmd[1].endswith(reddot._LAUNCHER_NAME) and os.path.exists(cmd[1]), "ArcticZim runs through Zimi's launcher"
        ran.append(cmd[2] if cmd[2] != "-v" else cmd[3])
        if cmd[2] == "-v":
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
    monkeypatch.setattr(reddot, "_run_stream", lambda cmd, sink, watch=None: 1)
    with pytest.raises(CreateError) as e:
        reddot.create_reddit_zim("kiwix", out_dir=str(tmp_path))
    assert "fetching posts" in str(e.value)
    assert not [f for f in os.listdir(str(tmp_path)) if f.endswith(".zim") or f.endswith(".part")]


def test_the_routes_are_rate_limited_as_api_paths():
    from zimi import http

    assert "/reddot" in http._RATE_LIMITED_API_PATHS


# ── one subreddit once ─────────────────────────────────────────────────────


def test_a_subreddit_in_two_zims_is_one_shelf_from_the_newest_build(tmp_path, monkeypatch):
    """Eric, 2026-09-19: "handle deduplication if we're merging multiple
    Zims." A Zimi build of r/kiwix beside an ArcticZim bundle that also
    carries it: one shelf, one chip, from the newest build."""
    _library(tmp_path, monkeypatch, [
        ("reddit_kiwix_2026-09-01.zim", {"Scraper": "ArcticZim", "Name": "reddit_kiwix", "Date": "2026-09-01"}, FILES),
        ("reddit_bundle_2026-09-10.zim", {"Scraper": "ArcticZim", "Name": "reddit_bundle", "Date": "2026-09-10"}, FILES),
    ])
    home = reddot.home()
    bundle, single = srv._zim_short_name("reddit_bundle_2026-09-10.zim"), srv._zim_short_name("reddit_kiwix_2026-09-01.zim")
    carried = {z["name"]: z["subreddits"] for z in home["zims"]}
    assert carried == {bundle: ["kiwix", "selfhosted"], single: []}
    shelves = [(z["name"], s["subreddit"]) for z in home["zims"] for s in z["shelves"]]
    assert shelves == [(bundle, "kiwix"), (bundle, "selfhosted")]


# ── the address says what it is ────────────────────────────────────────────


def test_a_subreddit_address_under_web_page_is_a_subreddit():
    """Eric: "let's be coy. You put in the url Reddit.com/r/whatever and we
    know what to do." No tile; the address under Web page or Site becomes the
    subreddit build, and a list of pages stays a list."""
    import zimi.manage as manage

    for mode in ("page", "site"):
        got, source, _t, _o = manage._create_validate({"mode": mode, "source": "https://www.reddit.com/r/kiwix/"})
        assert (got, source) == ("reddit", "kiwix")
    got, source, _t, _o = manage._create_validate({"mode": "page", "source": "https://www.reddit.com/r/kiwix/\nhttps://example.org/"})
    assert got == "page"


def test_the_probe_answers_a_subreddit_address_as_a_subreddit(monkeypatch):
    import zimi.manage as manage

    monkeypatch.setattr(manage, "_create_job", None)
    monkeypatch.setattr(reddot, "sidecar_status", lambda: {"installed": False, "dir": ""})
    payload, status = manage._create_probe({"mode": "page", "source": "reddit.com/r/Kiwix"})
    assert status == 200
    assert (payload["mode"], payload["subreddit"], payload["title"], payload["reddot_ready"]) == ("reddit", "Kiwix", "r/Kiwix", False)


# ── the retrieve's tail ────────────────────────────────────────────────────


def test_the_stall_watch_ends_a_retrieve_stuck_at_one_cursor():
    watch = reddot._stall_watch()
    assert not watch("Retrieving posts: 1000posts [00:14, Time=2026-09-18T11:20:07, requests=5]")
    for n in range(6, 6 + reddot.STALL_REQUESTS - 1):
        assert not watch(f"Retrieving posts: {n}posts [00:20, Time=2026-09-18T11:20:07, requests={n}]")
    assert watch(f"Retrieving posts: 99posts [00:30, Time=2026-09-18T11:20:07, requests={5 + reddot.STALL_REQUESTS}]")
    assert not watch("Retrieving posts: 100posts [00:31, Time=2026-09-19T00:00:00, requests=20]"), "a moving cursor is progress"
    assert not watch("some other line")


def test_run_stream_reads_carriage_returns_and_a_watcher_ends_the_run(tmp_path):
    """tqdm redraws with \\r and never writes a newline: a reader that
    splits on newlines alone sees an hour of progress as one line, at the
    end. And the watcher may end the command early, as a success."""
    from zimi.importer import _run_stream
    import sys

    script = tmp_path / "bar.py"
    script.write_text(encoding="utf-8", data=
        "import sys, time\n"
        "for i in range(1, 60):\n"
        "    sys.stdout.write('Retrieving posts: %dposts [Time=T1, requests=%d]\\r' % (i, i)); sys.stdout.flush(); time.sleep(0.02)\n"
        "print('never')\n"
    )
    seen = []
    rc = _run_stream([sys.executable, "-u", str(script)], seen.append, watch=reddot._stall_watch())
    assert rc == 0
    assert seen and seen[0].startswith("Retrieving posts: 1posts")
    assert not any("never" in s for s in seen)
    assert len(seen) == reddot.STALL_REQUESTS + 1


def test_duplicate_lines_from_the_tail_are_dropped_before_import(tmp_path):
    p = tmp_path / "posts.jsonl"
    p.write_text('{"id": "a"}\n{"id": "b"}\nnot json\n{"id": "b"}\n{"id": "b"}\n', encoding="utf-8")
    assert reddot._dedupe_jsonl(str(p)) == 2
    assert p.read_text(encoding="utf-8") == '{"id": "a"}\n{"id": "b"}\n'


def test_the_throttled_sink_lets_progress_through_every_few_seconds(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(reddot.time, "monotonic", lambda: clock[0])
    said = []
    sink = reddot._throttled(said.append)
    sink("Retrieving posts: 1"); sink("Retrieving posts: 2"); sink("importing")
    clock[0] += reddot._PROGRESS_EVERY_S + 0.1
    sink("Retrieving posts: 3")
    assert said == ["Retrieving posts: 1", "importing", "Retrieving posts: 3"]


def test_run_stream_returns_when_the_command_exits_though_a_child_keeps_the_pipe(tmp_path):
    """ArcticZim's build leaves a multiprocessing forkserver holding the
    output pipe after the build itself has exited; a reader that waits for
    end-of-file waited for it forever (r/kiwix, 2026-09-19)."""
    from zimi.importer import _run_stream
    import sys, time

    if os.name == "nt":
        pytest.skip("pipes are not selectable on Windows")
    script = tmp_path / "leaves_a_child.py"
    script.write_text(encoding="utf-8", data=
        "import subprocess, sys\n"
        "print('working')\n"
        "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
        "print('done')\n"
    )
    seen = []
    t0 = time.monotonic()
    rc = _run_stream([sys.executable, "-u", str(script)], seen.append)
    assert rc == 0 and seen == ["working", "done"]
    assert time.monotonic() - t0 < 10, "the reader waited for the orphan's end-of-file"


def test_a_dead_build_worker_fails_the_job_instead_of_hanging(tmp_path):
    """ArcticZim takes every non-Linux system for Windows and its workers die
    on macOS asking psutil for Windows constants; the creator then waits for
    them forever. The launcher patches that; and if a worker dies anyway, the
    build ends as a failure the log explains, not as a hang."""
    from zimi.importer import _run_stream
    import sys

    script = tmp_path / "dying_worker.py"
    script.write_text(encoding="utf-8", data=
        "import sys, time\n"
        "print('Waiting for workers...')\n"
        "print('Process Content worker 0:')\n"
        "print('Traceback (most recent call last):')\n"
        "print('AttributeError: module psutil has no attribute ABOVE_NORMAL_PRIORITY_CLASS')\n"
        "sys.stdout.flush(); time.sleep(30)\n"
    )
    seen = []
    rc = _run_stream([sys.executable, "-u", str(script)], seen.append, watch=reddot._worker_death_watch)
    assert rc == 1 and any("Traceback" in s for s in seen)


def test_the_launcher_is_written_once_and_patches_only_off_linux(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "ZIMI_DATA_DIR", str(tmp_path))
    os.makedirs(reddot.sidecar_dir())
    cmd = reddot._cmd("retrieve", "posts")
    assert cmd[1:] == [os.path.join(reddot.sidecar_dir(), reddot._LAUNCHER_NAME), "retrieve", "posts"]
    src = open(cmd[1], encoding="utf-8").read()
    assert 'sys.platform != "linux"' in src and "_builder.config_process = _config_process" in src
    assert 'if __name__ == "__main__":' in src, "multiprocessing imports the main module again in every worker"
    before = os.path.getmtime(cmd[1])
    reddot._cmd("import")
    assert os.path.getmtime(cmd[1]) == before


# ── the real shape ─────────────────────────────────────────────────────────


def test_attribute_values_are_quoted_inside_tags_only():
    """ArcticZim writes ``class=postsummary data-post=abc12``; a post's own
    words (``--port=8899``) are not attributes and stay as written."""
    assert reddot._quote_attrs('<div class=postsummary data-post=abc12 style="color: light"><p>run --port=8899 a=b</div>') == \
        '<div class="postsummary" data-post="abc12" style="color: light"><p>run --port=8899 a=b</div>'
    assert reddot._quote_attrs('<a href=https://x.org/?a=b&c=d>x</a>') == '<a href="https://x.org/?a=b&c=d">x</a>'


def test_a_hand_written_page_with_quotes_reads_the_same():
    quoted = LISTING.replace("data-post=abc12", 'data-post="abc12"').replace("class=postscore", 'CLASS="postscore"')
    assert [r["id"] for r in reddot.rows_from_listing(quoted)] == ["abc12", "def34"]


def test_the_date_reads_as_a_person_does():
    assert reddot._when("2025-09-01T08:39:03") == "2025-09-01 08:39"
    assert reddot._when("2026-09-01 12:00") == "2026-09-01 12:00"


def test_a_reddit_zim_titled_after_the_tool_is_named_by_its_subreddits():
    assert srv._subreddit_title("ArcticZim", ["Kiwix"]) == "r/Kiwix"
    assert srv._subreddit_title("ArcticZim", ["a", "b", "c", "d"]) == "r/a · r/b · r/c …"
    assert srv._subreddit_title("", ["Kiwix"]) == "r/Kiwix"
    assert srv._subreddit_title("My Reddit", ["Kiwix"]) == "My Reddit"
    assert srv._subreddit_title("ArcticZim", []) == "ArcticZim"


def test_a_reddit_zim_files_under_reddit_whatever_its_file_is_called():
    assert srv._effective_category("arcticzim_eng", "/zims/arcticzim_eng.zim", "reddit") == "Reddit"
    assert srv._effective_category("reddit_kiwix", "/zims/reddit_kiwix.zim", None) != "Reddit", "only the ZIM's own metadata says it is Reddit"
