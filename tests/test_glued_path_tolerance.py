"""An agent's path resolves whether or not it carries the ZIM name.

#54, reported with a fix by TwoRobotsinaTrenchcoat: MCP printed a result as
"Path: wikipedia/A/Whale", an agent passed that back as `path`, and read()
answered "not found" for an article that plainly exists. The display is split
into `zim:` and `path:` lines now, but agents that saw the old shape, or that
build the string themselves, still send the glued form.

Their fix stripped the prefix unconditionally, before touching the archive.
That is a silent wrong answer for a ZIM that genuinely holds an entry whose
path starts with the ZIM's own name: the entry becomes permanently
unreachable. The archive is asked first here, so the stored entry always wins
and the strip is only a fallback.

Their sweep also covered read() and get_chunks() but not
get_article_languages(), which answered "no translations" rather than
rejecting the argument, and so read as an absent feature.

Run: pytest tests/test_glued_path_tolerance.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from zimi.search import unglue_zim_path  # noqa: E402


class _Archive:
    """An archive holding exactly the paths it was given."""

    def __init__(self, *paths):
        self.paths = set(paths)
        self.asked = []

    def get_entry_by_path(self, path):
        self.asked.append(path)
        if path not in self.paths:
            raise KeyError(path)
        return object()


def test_a_glued_path_loses_the_zim_name():
    archive = _Archive("A/Whale")
    assert unglue_zim_path(archive, "wikipedia", "wikipedia/A/Whale") == "A/Whale"


def test_a_plain_path_is_untouched_and_costs_no_lookup():
    """The overwhelming majority of calls. A path with no prefix cannot be
    glued, so there is nothing to check."""
    archive = _Archive("A/Whale")
    assert unglue_zim_path(archive, "wikipedia", "A/Whale") == "A/Whale"
    assert archive.asked == []


def test_a_real_entry_beats_the_strip():
    """The case that makes an unconditional strip wrong. This ZIM really does
    hold an entry at "wikipedia/A/Whale", and it has to stay reachable."""
    archive = _Archive("wikipedia/A/Whale", "A/Whale")
    assert unglue_zim_path(archive, "wikipedia", "wikipedia/A/Whale") == "wikipedia/A/Whale"


def test_a_prefix_that_is_not_a_path_segment_is_not_a_prefix():
    """"wikipedia-fr/..." does not start with "wikipedia/", and a substring
    match would have eaten the wrong characters."""
    archive = _Archive("wikipedia-fr/A/Whale")
    assert (
        unglue_zim_path(archive, "wikipedia", "wikipedia-fr/A/Whale")
        == "wikipedia-fr/A/Whale"
    )


def test_an_archive_that_raises_anything_still_falls_back():
    """libzim raises KeyError for a missing entry, but this runs on paths that
    came from outside and the lookup must not be the thing that fails."""

    class _Hostile:
        def get_entry_by_path(self, path):
            raise RuntimeError("no")

    assert unglue_zim_path(_Hostile(), "wikipedia", "wikipedia/A/Whale") == "A/Whale"


@pytest.mark.parametrize(
    "entry_point", ["read", "get_chunks", "read_with_links", "article_languages"]
)
def test_every_agent_entry_point_that_takes_a_path_tolerates_the_glued_form(
    entry_point,
):
    """Named individually because the first fix covered two of the four, and
    the gap was invisible: the one it missed returns an empty result rather
    than an error."""
    import zimi.interlang as interlang
    import zimi.search as search

    sources = {
        "read": search,
        "get_chunks": search,
        "read_with_links": search,
        "article_languages": interlang,
    }
    module = sources[entry_point]
    text = open(module.__file__, encoding="utf-8").read()
    assert "unglue_zim_path" in text, (
        f"{entry_point} lives in {os.path.basename(module.__file__)}, which "
        "never unglues a path"
    )
