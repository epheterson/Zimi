"""The apps through MCP: videos, questions and posts as text an agent
can use, sorted and threaded the way the pages show them.

Run: pytest tests/test_mcp_apps.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import zimi.mcp_server as mcp_server  # noqa: E402
except SystemExit as exc:  # pragma: no cover - depends on the install
    pytest.skip(f"MCP server unavailable: {exc}", allow_module_level=True)

from zimi import exchange, reddot, tube  # noqa: E402


def test_list_videos_reads_like_a_feed(monkeypatch):
    monkeypatch.setattr(tube, "feed", lambda q, limit, offset: {"total": 2, "sources": 1, "items": [
        {"zim": "ted", "zim_title": "TED", "page": "talk-a", "title": "A talk", "speaker": "Ann", "description": "About A.", "duration": "12:00", "date": "2024"},
        {"zim": "ted", "zim_title": "TED", "page": "talk-b", "title": "B talk", "speaker": "", "description": "", "duration": None, "date": ""},
    ], "zims": []})
    text = mcp_server.list_videos("talk")
    assert "2 videos across 1 sources for 'talk'" in text
    assert "**A talk** (Ann · TED) · 12:00 · 2024" in text and "zim: ted  path: talk-a" in text and "About A." in text
    assert "**B talk** (TED)" in text


def test_list_videos_says_when_there_is_nothing(monkeypatch):
    monkeypatch.setattr(tube, "feed", lambda q, limit, offset: {"total": 0, "sources": 0, "items": [], "zims": []})
    assert mcp_server.list_videos() == "No video ZIMs installed."
    assert mcp_server.list_videos("x") == "No videos match."


def test_questions_list_then_read_with_the_accepted_answer_first(monkeypatch):
    monkeypatch.setattr(exchange, "sites", lambda: [{"name": "cooking", "title": "Cooking"}])
    monkeypatch.setattr(exchange, "listing", lambda name, page, tag: {"pages": 3, "rows": [
        {"id": "1", "title": "Onions?", "page": "questions/1/onions", "votes": 265, "answers": 21, "accepted": True, "excerpt": "Crying.", "tags": ["onions"]}]})
    monkeypatch.setattr(exchange, "question", lambda name, page: {"title": "Onions?", "votes": 265, "author": "Mike", "tags": ["onions"], "body": "<p>Why do I <b>cry</b>?</p>",
        "answers": [{"score": 158, "accepted": True, "author": "Ryan", "body": "<p>Chill it.</p><script>x()</script>"}, {"score": 172, "accepted": False, "author": "", "body": "<p>Sharp knife.</p>"}]})
    assert "**Cooking** (`cooking`)" in mcp_server.list_questions()
    listing = mcp_server.list_questions("cooking")
    assert "page 1 of 3" in listing and "**Onions?** — 265 votes, 21 answers ✓ · onions" in listing and "path: questions/1/onions" in listing
    q = mcp_server.read_question("cooking", "questions/1/onions")
    assert q.startswith("# Onions?") and "265 votes · asked by Mike · onions" in q
    assert "Why do I cry?" in q and "<b>" not in q and "x()" not in q
    assert q.index("Answer 1 — 158 points (accepted) · Ryan") < q.index("Answer 2 — 172 points")


def test_posts_list_then_read_with_the_comment_tree_indented(monkeypatch):
    monkeypatch.setattr(reddot, "zims", lambda: [{"name": "reddit_kiwix", "subreddits": ["Kiwix"]}])
    monkeypatch.setattr(reddot, "listing", lambda name, sub, sort, page: {"pages": 52, "rows": [
        {"id": "a1", "subreddit": "Kiwix", "title": "Zimi 1.10", "page": "r/Kiwix/a1/", "score": 42, "flair": "Release", "author": "eric", "date": "2026-09-01", "external": ""}]})
    monkeypatch.setattr(reddot, "post", lambda name, page: {"title": "Zimi 1.10", "subreddit": "Kiwix", "score": 42, "author": "eric", "date": "2026-09-01", "flair": "", "body": "<p>Apps.</p>",
        "comments": [{"author": "alice", "score": 10, "date": "", "body": "<p>Nice.</p>", "children": [{"author": "bob", "score": 3, "date": "", "body": "<p>Agreed.</p>", "children": []}]},
                     {"author": "carol", "score": 1, "date": "", "body": "<p>Top level.</p>", "children": []}]})
    assert "`reddit_kiwix`: r/Kiwix" in mcp_server.list_posts()
    listing = mcp_server.list_posts("reddit_kiwix", "Kiwix")
    assert "r/Kiwix — top, page 1 of 52" in listing and "**Zimi 1.10** — 42 points · Release · by eric · 2026-09-01" in listing
    p = mcp_server.read_post("reddit_kiwix", "r/Kiwix/a1/")
    assert "## 3 comments" in p
    assert "- **alice** (10 points)\n  Nice.\n  - **bob** (3 points)\n    Agreed.\n- **carol** (1 points)" in p


def test_a_missing_question_or_post_says_so(monkeypatch):
    monkeypatch.setattr(exchange, "question", lambda name, page: None)
    monkeypatch.setattr(reddot, "post", lambda name, page: None)
    assert mcp_server.read_question("x", "nope").startswith("Not a question page")
    assert mcp_server.read_post("x", "nope").startswith("Not a post page")
