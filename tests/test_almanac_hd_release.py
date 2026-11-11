"""The release carries Almanac HD in both sizes: HD (one file), Maximum (chunks under 2 GiB), and the manifest naming
each file with its size and sha256, under names no release shipped; built in CI from a chunked tile source that is
published by hand (scripts/publish_almanac_tiles.py). A release without them is said, not offered.

Run: pytest tests/test_almanac_hd_release.py -v
"""

import hashlib
import io
import json
import os
import re
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [ROOT, os.path.join(ROOT, "scripts"), HERE]

import build_almanac_maxi as maxi  # noqa: E402
import publish_almanac_tiles as publish  # noqa: E402
from test_almanac_hd_browser import _build_hd  # noqa: E402

from zimi import almanachd  # noqa: E402

WF = os.path.join(ROOT, ".github", "workflows", "desktop-release.yml")


def _job(wf, name):
    m = re.search(r"\n  %s:\n(.*?)(?=\n  [a-z][\w-]*:\n|\Z)" % re.escape(name), wf, re.S)
    assert m, name
    return m.group(1)


def test_the_release_workflow_builds_both_sizes_and_attaches_maximums_chunks():
    wf = open(WF, encoding="utf-8").read()
    job = _job(wf, "almanac-maxi")
    assert int(re.search(r"timeout-minutes:\s*(\d+)", job).group(1)) >= 60   # 7 GB moves through it
    run = re.search(r"build_almanac_maxi\.py[^\n]*", job).group(0)
    assert "--tag" in run and "/mnt/" in run                                  # the runner's big disk
    assert "GH_TOKEN" in job                                                  # to read which names releases shipped
    assert "zimi_almanac_ultra" in job and "if-no-files-found: error" in job  # Maximum's chunks are uploaded
    release = _job(wf, "release")
    assert re.search(r"cp [^\n]*zimi_almanac_ultra_\*\.zim\[a-z\]\[a-z\]", release) or "zimi_almanac_ultra_*.zim[a-z][a-z]" in release
    assert "zimi_almanac_maxi.json" in release


@pytest.fixture(scope="module")
def tiles(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("tiles")
    path = str(tmp / "zimi_almanac_tiles_2026-11c.zim")
    _build_hd(str(tmp / "stage"), path)
    return path


def test_hd_is_maximums_tiles_cut_short_and_maximum_ships_as_checked_chunks(tiles, tmp_path, monkeypatch):
    from libzim.reader import Archive

    monkeypatch.setattr(maxi, "HD_CAPS", {"earth/day": 1})   # the fixture's Earth has levels 0-2
    monkeypatch.setattr(maxi, "CHUNK_BYTES", 1 << 14)
    out = str(tmp_path / "out")
    hd, chunks, manifest = maxi.build_release(tiles, out, "v1.16.0", "2026-11c")
    assert os.path.basename(hd) == "zimi_almanac_maxi_2026-11c.zim"
    a = Archive(hd)
    man = json.loads(bytes(a.get_entry_by_path("hd/hd.json").get_item().content))
    assert man["layers"]["earth/day"]["max"] == 1 and not a.has_entry_by_path("hd/earth/day/2/0/0.webp")
    assert a.get_metadata("Flavour").decode() == "maxi"
    assert len(chunks) >= 2
    assert not os.path.exists(os.path.join(out, "zimi_almanac_ultra_2026-11c.zim"))   # the chunks ship, not the book
    b = Archive(chunks[0])
    assert b.get_metadata("Flavour").decode() == "ultra" and b.has_entry_by_path("hd/earth/day/2/0/0.webp") and b.check()
    rel = almanachd.parse_manifest(open(manifest, encoding="utf-8").read(), version="1.16.0")
    assert rel["file"] == os.path.basename(hd) and rel["size"] == os.path.getsize(hd)
    assert rel["sha256"] == hashlib.sha256(open(hd, "rb").read()).hexdigest()
    assert [c["file"] for c in rel["max"]["chunks"]] == [os.path.basename(c) for c in chunks]
    assert all(c["sha256"] == hashlib.sha256(open(p, "rb").read()).hexdigest() for c, p in zip(rel["max"]["chunks"], chunks))


def test_an_hd_only_tile_source_makes_hd_alone(tiles, tmp_path, monkeypatch):
    monkeypatch.setattr(maxi, "HD_CAPS", {})
    monkeypatch.setattr(maxi, "HD_TERRAIN_CAP", 3)
    hd, chunks, manifest = maxi.build_release(tiles, str(tmp_path / "out"), "v1.16.0", "2026-11c")
    assert chunks == [] and "max" not in json.load(open(manifest, encoding="utf-8"))


def test_names_move_past_every_shipped_letter_and_never_under_the_tiles():
    stems = ("zimi_almanac_maxi", "zimi_almanac_ultra")
    shipped = {"zimi_almanac_maxi_2026-11.zim", "zimi_almanac_2026-11c.zim"}   # 1.15.5 shipped the bare month
    assert maxi.unshipped_month(stems, shipped, today="2026-11") == "2026-11a"
    assert maxi.unshipped_month(stems, shipped, floor="2026-11c", today="2026-11") == "2026-11c"
    assert maxi.unshipped_month(stems, shipped | {"zimi_almanac_ultra_2026-11c.zimab"}, floor="2026-11c", today="2026-11") == "2026-11d"
    assert maxi.unshipped_month(stems, shipped, today="2026-12") == "2026-12"


def test_a_chunked_tile_source_is_fetched_chunk_by_chunk_and_checked_whole(tiles, tmp_path, monkeypatch):
    chunks = maxi.split_book(tiles, str(tmp_path / "src"), part=1 << 14)
    served = {os.path.basename(c): open(c, "rb").read() for c in chunks}
    pin = publish.pin_for(tiles, chunks, "almanac-tiles-2026-11c")

    def urlopen(url, timeout=None):
        return io.BytesIO(served[url.rsplit("/", 1)[1]])

    monkeypatch.setattr(maxi.urllib.request, "urlopen", urlopen)
    got = maxi.fetch_tiles(str(tmp_path / "cache"), pin)
    assert got.endswith(".zimaa") and maxi._sha256_files(sorted(str(p) for p in (tmp_path / "cache").iterdir())) == pin["sha256"]
    bad = dict(pin, sha256="00" * 32)
    with pytest.raises(SystemExit):
        maxi.fetch_tiles(str(tmp_path / "cache2"), bad)


def test_the_manual_publish_step_refuses_what_must_not_ship(tiles, tmp_path, monkeypatch):
    chunks = maxi.split_book(tiles, str(tmp_path / "c"), part=1 << 14)
    assert publish.check_chunks(chunks, set()) == []
    assert any("shipped" in p for p in publish.check_chunks(chunks, {os.path.basename(chunks[1])}))
    monkeypatch.setattr(publish, "LIMIT", 1 << 10)
    assert any("2 GiB" in p for p in publish.check_chunks(chunks, set()))
    open(chunks[1], "r+b").write(b"\0" * 64)   # a damaged chunk: the whole book fails libzim's checksum
    monkeypatch.setattr(publish, "LIMIT", 2**31)
    assert any("checksum" in p or "cannot open" in p for p in publish.check_chunks(chunks, set()))


def test_a_release_without_almanac_hd_says_so_and_offers_nothing(monkeypatch):
    from zimi import manage, outbound

    monkeypatch.setattr(manage, "_read_app_update_prefs", lambda: {})
    monkeypatch.setattr(almanachd.POLICY, "_offline", lambda: False)
    monkeypatch.delenv(almanachd.ENV, raising=False)
    monkeypatch.setattr(almanachd, "present", lambda: None)
    monkeypatch.setattr(almanachd, "installed", lambda: False)
    monkeypatch.setattr(almanachd, "_manifest", {"rel": None, "tried": 0.0, "busy": False})
    assert not almanachd.status()["missing"]   # not asked yet: offered from what is known offline
    almanachd._manifest["tried"] = 1.0          # asked, and this version's release names none
    st = almanachd.status()
    assert st["missing"] and st["offers"] == {} and st["offer"] is None and st["mode"] == outbound.ASK
