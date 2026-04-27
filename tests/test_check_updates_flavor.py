"""Test that _check_updates only proposes same-flavor updates.

Issue #16: Wikipedia maxi (with images) installed at 2026-02. Catalog has
both maxi 2026-02 (current) and mini 2026-03 (newer but text-only). The
old prefix-only matcher would suggest the mini as an update, which would
silently downgrade the user's maxi to a much smaller text-only ZIM.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import zimi.library as library  # noqa: E402
import zimi.server as server  # noqa: E402


def test_detect_flavor_basics():
    assert library._detect_flavor("wikipedia_en_all_maxi_2026-02") == "maxi"
    assert library._detect_flavor("wikipedia_en_all_nopic_2026-02") == "nopic"
    assert library._detect_flavor("wikipedia_en_all_mini_2026-02") == "mini"
    assert library._detect_flavor("appropedia_en_all_2026-02") is None
    assert library._detect_flavor("") is None
    assert library._detect_flavor(None) is None


def test_detect_flavor_case_insensitive():
    assert library._detect_flavor("Wikipedia_en_all_MAXI_2026-02") == "maxi"


def test_detect_flavor_at_end_of_name():
    assert library._detect_flavor("foo_bar_maxi") == "maxi"


@pytest.fixture
def _stub_catalog(monkeypatch, tmp_path):
    """Stub _fetch_kiwix_catalog + the on-disk ZIM list to drive _check_updates."""
    monkeypatch.setattr(server, "ZIM_DIR", str(tmp_path))

    # User has wikipedia maxi at 2026-02 installed.
    installed = "wikipedia_en_all_maxi_2026-02.zim"
    (tmp_path / installed).write_bytes(b"")
    monkeypatch.setattr(
        server,
        "get_zim_files",
        lambda: {"wikipedia": str(tmp_path / installed)},
    )
    monkeypatch.setattr(
        server,
        "_extract_zim_date",
        lambda fn: ("wikipedia_en_all_maxi", "2026-02"),
    )

    # Catalog has same-flavor at 2026-02 (current) and a NEWER mini at 2026-03.
    catalog_items = [
        {
            "name": "wikipedia_en_all",
            "title": "Wikipedia",
            "date": "2026-02-15",
            "download_url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_maxi_2026-02.zim.meta4",
            "size_bytes": 100_000_000_000,
        },
        {
            "name": "wikipedia_en_all",
            "title": "Wikipedia",
            "date": "2026-03-15",
            "download_url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_mini_2026-03.zim.meta4",
            "size_bytes": 5_000_000_000,
        },
    ]
    monkeypatch.setattr(
        library,
        "_fetch_kiwix_catalog",
        lambda **kw: (len(catalog_items), list(catalog_items), None),
    )
    return tmp_path


def test_check_updates_skips_cross_flavor(_stub_catalog):
    """Maxi installed → mini-newer should NOT be offered as an update."""
    updates = library._check_updates()
    # No same-flavor update is newer (only the mini is newer), so result is empty.
    assert updates == [], (
        "Should not propose mini as an update for a maxi install — that would "
        "silently downgrade the user's library."
    )


def test_check_updates_accepts_same_flavor(monkeypatch, tmp_path):
    """When a same-flavor newer entry exists, it IS proposed."""
    installed = "wikipedia_en_all_maxi_2026-02.zim"
    (tmp_path / installed).write_bytes(b"")
    monkeypatch.setattr(server, "ZIM_DIR", str(tmp_path))
    monkeypatch.setattr(
        server, "get_zim_files", lambda: {"wikipedia": str(tmp_path / installed)}
    )
    monkeypatch.setattr(
        server, "_extract_zim_date", lambda fn: ("wikipedia_en_all_maxi", "2026-02")
    )
    monkeypatch.setattr(
        library,
        "_fetch_kiwix_catalog",
        lambda **kw: (
            2,
            [
                {
                    "name": "wikipedia_en_all",
                    "title": "Wikipedia",
                    "date": "2026-03-15",
                    "download_url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_maxi_2026-03.zim.meta4",
                    "size_bytes": 110_000_000_000,
                },
                {
                    "name": "wikipedia_en_all",
                    "title": "Wikipedia",
                    "date": "2026-04-15",
                    "download_url": "https://download.kiwix.org/zim/wikipedia/wikipedia_en_all_mini_2026-04.zim.meta4",
                    "size_bytes": 5_500_000_000,
                },
            ],
            None,
        ),
    )
    updates = library._check_updates()
    assert len(updates) == 1
    assert "_maxi_" in updates[0]["download_url"]
    assert updates[0]["latest_date"] == "2026-03"


def test_check_updates_unflavored_zim_still_works(monkeypatch, tmp_path):
    """ZIMs without a flavor marker (e.g. zimgit-*) update correctly."""
    installed = "appropedia_en_all_2026-02.zim"
    (tmp_path / installed).write_bytes(b"")
    monkeypatch.setattr(server, "ZIM_DIR", str(tmp_path))
    monkeypatch.setattr(
        server, "get_zim_files", lambda: {"appropedia": str(tmp_path / installed)}
    )
    monkeypatch.setattr(
        server, "_extract_zim_date", lambda fn: ("appropedia_en_all", "2026-02")
    )
    monkeypatch.setattr(
        library,
        "_fetch_kiwix_catalog",
        lambda **kw: (
            1,
            [
                {
                    "name": "appropedia_en_all",
                    "title": "Appropedia",
                    "date": "2026-04-15",
                    "download_url": "https://download.kiwix.org/zim/other/appropedia_en_all_2026-04.zim.meta4",
                    "size_bytes": 1_000_000_000,
                },
            ],
            None,
        ),
    )
    updates = library._check_updates()
    assert len(updates) == 1
    assert updates[0]["latest_date"] == "2026-04"
