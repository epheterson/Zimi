"""Tests for the pure URL helpers that decide whether a download has a
plausible torrent companion.

Pure-function tests — no network, no subprocess, no library state.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi.library import _resolve_torrent_url  # noqa: E402


def test_zim_url_appends_torrent():
    src = "https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_maxi_2026-02.zim"
    assert _resolve_torrent_url(src) == src + ".torrent"


def test_meta4_url_strips_meta4_then_appends_torrent():
    src = "https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_maxi_2026-02.zim.meta4"
    assert (
        _resolve_torrent_url(src)
        == "https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_maxi_2026-02.zim.torrent"
    )


def test_already_torrent_url_returned_as_is():
    src = "https://download.kiwix.org/zim/foo.zim.torrent"
    assert _resolve_torrent_url(src) == src


def test_non_kiwix_url_returns_none():
    """We only trust Kiwix's torrent companion convention. A random HTTPS
    URL might 404 or, worse, serve attacker-controlled metadata."""
    assert _resolve_torrent_url("https://random.example.com/foo.zim") is None


def test_non_zim_url_returns_none():
    assert _resolve_torrent_url("https://download.kiwix.org/foo.txt") is None


def test_empty_or_none_returns_none():
    assert _resolve_torrent_url("") is None
    assert _resolve_torrent_url(None) is None
