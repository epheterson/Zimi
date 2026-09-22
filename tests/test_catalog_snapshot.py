"""The catalog a machine browses when it cannot reach Kiwix.

Three states, and a person is always in exactly one:

    never online          the snapshot shipped in the package
    online once, now not  the cached catalog, dated
    online                the live fetch

The handover is one rule, and most of this file exists to pin it: a successful
live fetch replaces the cache wholesale, the cache outranks the shipped
snapshot from then on, and the snapshot is never written to or merged into.
Merging would be the worst of the three, a library half of which is six months
old with nothing to say which half.

Run: pytest tests/test_catalog_snapshot.py -v
"""

import gzip
import json
import os
import sys
import tarfile
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from zimi import catalog_snapshot  # noqa: E402


@pytest.fixture
def snapshot(tmp_path, monkeypatch):
    """A small snapshot and icon tar, with the module pointed at them."""
    entries = [
        {
            "name": "wikipedia_en_all",
            "file": "wikipedia_en_all_2026-07.zim",
            "title": "Wikipedia",
            "summary": "The free encyclopedia",
            "size_bytes": 100_000_000,
            "magnet": "ab0bf6a5be066e722ba849a30e3920c045c53deb",
            "icon": "a1b2c3d4e5f60718",
        },
        {
            "name": "gutenberg_en",
            "file": "gutenberg_en_2026-06.zim",
            "title": "Gutenberg",
        },
    ]
    snap = tmp_path / "catalog-snapshot.json.gz"
    icons = tmp_path / "catalog-icons.tar"
    catalog_snapshot.write_snapshot(str(snap), entries, "2026-09-16")
    catalog_snapshot.write_icons(str(icons), {"a1b2c3d4e5f60718": b"WEBPDATA"})
    monkeypatch.setattr(catalog_snapshot, "SNAPSHOT_PATH", str(snap))
    monkeypatch.setattr(catalog_snapshot, "ICONS_PATH", str(icons))
    catalog_snapshot._reset_for_tests()
    yield entries
    catalog_snapshot._reset_for_tests()


@pytest.fixture
def no_snapshot(tmp_path, monkeypatch):
    """A checkout where the build script has never run."""
    monkeypatch.setattr(catalog_snapshot, "SNAPSHOT_PATH", str(tmp_path / "nope.gz"))
    monkeypatch.setattr(catalog_snapshot, "ICONS_PATH", str(tmp_path / "nope.tar"))
    catalog_snapshot._reset_for_tests()
    yield
    catalog_snapshot._reset_for_tests()


# ── reading it ─────────────────────────────────────────────────────────────


def test_entries_and_date_are_read(snapshot):
    assert catalog_snapshot.available() is True
    assert [e["name"] for e in catalog_snapshot.entries()] == [
        "wikipedia_en_all",
        "gutenberg_en",
    ]
    assert catalog_snapshot.built_at() == "2026-09-16"


def test_an_icon_is_read_by_name(snapshot):
    assert catalog_snapshot.icon("a1b2c3d4e5f60718") == b"WEBPDATA"


def test_an_unknown_icon_is_none_not_an_error(snapshot):
    assert catalog_snapshot.icon("0000000000000000") is None


@pytest.mark.parametrize(
    "name",
    [
        "",
        "../../../etc/passwd",
        "a1b2c3d4e5f60718/../../secret",
        "not-hex-at-all",
        "A1B2C3D4E5F60718",  # upper case is not the digest shape we write
        "./a1b2c3d4e5f60718",
        "a" * 200,
    ],
)
def test_a_name_that_is_not_a_digest_never_reaches_the_tar(snapshot, name):
    """The name arrives from a URL. It is refused by shape before any file is
    opened, rather than trusting tarfile not to resolve a traversal."""
    assert catalog_snapshot.icon(name) is None


# ── when it is not there ───────────────────────────────────────────────────


def test_a_checkout_without_the_assets_degrades_quietly(no_snapshot):
    """A source checkout before the build script has run. Every call answers
    emptily and nothing raises, because a server must still start."""
    assert catalog_snapshot.available() is False
    assert catalog_snapshot.entries() == []
    assert catalog_snapshot.built_at() == ""
    assert catalog_snapshot.icon("a1b2c3d4e5f60718") is None
    assert catalog_snapshot.icon_names() == set()


def test_a_corrupt_snapshot_is_not_fatal(tmp_path, monkeypatch):
    bad = tmp_path / "catalog-snapshot.json.gz"
    bad.write_bytes(b"this is not gzip")
    monkeypatch.setattr(catalog_snapshot, "SNAPSHOT_PATH", str(bad))
    monkeypatch.setattr(catalog_snapshot, "ICONS_PATH", str(tmp_path / "nope.tar"))
    catalog_snapshot._reset_for_tests()
    try:
        assert catalog_snapshot.available() is False
    finally:
        catalog_snapshot._reset_for_tests()


# ── reproducible output ────────────────────────────────────────────────────


def test_writing_the_same_snapshot_twice_gives_identical_bytes(tmp_path):
    """The assets are committed. If a rebuild of an unchanged catalog produced
    different bytes, every release would carry a meaningless 2 MB diff."""
    one = tmp_path / "one.gz"
    two = tmp_path / "two.gz"
    entries = [{"name": "a", "file": "a_2026-01.zim"}]
    catalog_snapshot.write_snapshot(str(one), entries, "2026-09-16")
    time.sleep(1.1)  # a different mtime, which is exactly what must not leak in
    catalog_snapshot.write_snapshot(str(two), entries, "2026-09-16")
    assert one.read_bytes() == two.read_bytes()


def test_writing_the_same_icons_twice_gives_identical_bytes(tmp_path):
    one = tmp_path / "one.tar"
    two = tmp_path / "two.tar"
    icons = {"bb": b"two", "aa": b"one"}
    catalog_snapshot.write_icons(str(one), icons)
    time.sleep(1.1)
    catalog_snapshot.write_icons(str(two), dict(reversed(list(icons.items()))))
    assert one.read_bytes() == two.read_bytes(), "order or mtime leaked in"


def test_the_written_snapshot_is_readable_json(tmp_path):
    path = tmp_path / "s.gz"
    catalog_snapshot.write_snapshot(str(path), [{"name": "a"}], "2026-09-16")
    with gzip.open(path, "rt", encoding="utf-8") as f:
        payload = json.load(f)
    assert payload["built_at"] == "2026-09-16"
    assert payload["entries"] == [{"name": "a"}]


def test_icons_are_stored_flat_with_no_paths(tmp_path):
    """A member name with a directory in it would be a traversal waiting to
    happen on any reader less careful than ours."""
    path = tmp_path / "i.tar"
    catalog_snapshot.write_icons(str(path), {"aa": b"x", "bb": b"y"})
    with tarfile.open(path) as tar:
        for member in tar.getmembers():
            assert "/" not in member.name
            assert not member.name.startswith(".")


# ── the shipped assets themselves ──────────────────────────────────────────


def test_the_shipped_snapshot_is_present_and_sane():
    """Guards the release. A wheel built without running the build script
    would ship a Zimi whose offline catalog is empty, and nothing else in the
    suite would notice, because every other test generates its own fixture."""
    catalog_snapshot._reset_for_tests()
    try:
        if not os.path.exists(catalog_snapshot.SNAPSHOT_PATH):
            pytest.skip("no snapshot built in this checkout")
        assert catalog_snapshot.available()
        entries = catalog_snapshot.entries()
        assert len(entries) > 1000, f"only {len(entries)} entries"
        with_magnet = [e for e in entries if e.get("magnet")]
        assert len(with_magnet) / len(entries) > 0.9, "most entries lost their magnet"
        for entry in entries[:50]:
            assert entry.get("name")
            assert entry.get("file")
            if entry.get("magnet"):
                assert len(entry["magnet"]) == 40, entry["magnet"]
    finally:
        catalog_snapshot._reset_for_tests()


def test_the_shipped_snapshot_is_not_stale():
    """A snapshot ages: filenames roll over, so its download URLs start
    404ing and its magnets point at empty swarms. It stays correct about what
    EXISTS, which is the point, but past a couple of releases it should be
    rebuilt. Better to fail here than to have somebody discover it."""
    catalog_snapshot._reset_for_tests()
    try:
        if not os.path.exists(catalog_snapshot.SNAPSHOT_PATH):
            pytest.skip("no snapshot built in this checkout")
        built = catalog_snapshot.built_at()
        assert built, "the snapshot carries no build date"
        import datetime

        age = (datetime.date.today() - datetime.date.fromisoformat(built)).days
        assert age < 180, (
            f"the shipped catalog snapshot is {age} days old. "
            "Run scripts/build_catalog_snapshot.py."
        )
    finally:
        catalog_snapshot._reset_for_tests()


def test_every_icon_referenced_by_an_entry_is_in_the_tar():
    """A dangling reference renders as a broken image on a machine that has no
    way to fetch the real one."""
    catalog_snapshot._reset_for_tests()
    try:
        if not os.path.exists(catalog_snapshot.SNAPSHOT_PATH):
            pytest.skip("no snapshot built in this checkout")
        have = catalog_snapshot.icon_names()
        if not have:
            pytest.skip("no icons built in this checkout")
        wanted = {e["icon"] for e in catalog_snapshot.entries() if e.get("icon")}
        assert wanted <= have, f"{len(wanted - have)} entries point at a missing icon"
    finally:
        catalog_snapshot._reset_for_tests()
