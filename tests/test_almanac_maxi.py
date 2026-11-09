"""The Almanac's HD flavour: the whole Almanac plus the tile pyramids, one self-contained ZIM, built on every release
from a pinned tile source (scripts/build_almanac_maxi.py).

Built here from a tiny tile source (a few solid tiles), the same code the release job runs on the real one.

Run: pytest tests/test_almanac_maxi.py -v
"""

import datetime
import hashlib
import json
import os
import re
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build_almanac_maxi as maxi  # noqa: E402
from test_almanac_hd_browser import _build_hd  # noqa: E402

from libzim.reader import Archive  # noqa: E402

from zimi import ownzims  # noqa: E402

ALMANAC = next(o for o in ownzims.OWN if o.name == "zimi_almanac")


def _read(archive, path):
    return bytes(archive.get_entry_by_path(path).get_item().content)


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("maxi")
    tiles = str(tmp / "tiles.zim")
    _build_hd(str(tmp / "stage"), tiles)
    standard = ownzims.write_zim(ALMANAC, str(tmp / "standard.zim"))
    flavour = maxi.build(tiles, str(tmp / "out"), month="2026-11")
    return {
        "tiles": tiles,
        "standard": standard,
        "flavour": flavour,
        "out": str(tmp / "out"),
    }


def test_it_is_named_the_way_kiwix_names_a_flavour(built):
    assert os.path.basename(built["flavour"]) == "zimi_almanac_maxi_2026-11.zim"


def test_same_name_different_flavour(built):
    std, hd = Archive(built["standard"]), Archive(built["flavour"])
    name = std.get_metadata("Name")
    assert name and name == hd.get_metadata("Name")
    assert "Flavour" not in std.metadata_keys
    assert hd.get_metadata("Flavour") == b"maxi"
    assert hd.get_metadata("Title") == std.get_metadata("Title")


def test_the_name_is_stable_between_builds_not_a_temp_folders(built):
    name = Archive(built["standard"]).get_metadata("Name").decode()
    assert name == "zimi_eng_zimi_almanac", name


def test_it_opens_on_the_almanac_and_holds_all_of_it(built):
    std, hd = Archive(built["standard"]), Archive(built["flavour"])
    assert (
        hd.main_entry.get_item().path == std.main_entry.get_item().path == "index.html"
    )
    # The tile source's own credits page is not the Almanac's index.
    assert _read(hd, "index.html") == _read(std, "index.html")
    assert b"Almanac" in _read(hd, "index.html")
    for path in (
        "almanac.js",
        "almanac-earth.js",
        "local.js",
        "shell.js",
        "i18n/en.json",
    ):
        assert _read(hd, path) == _read(std, path), path


def test_the_tiles_are_inside_under_hd(built):
    hd = Archive(built["flavour"])
    man = json.loads(_read(hd, "hd/hd.json"))
    assert man["layers"]["earth/day"]["max"] == 2
    tile = hd.get_entry_by_path("hd/earth/day/2/7/3.webp").get_item()
    assert tile.mimetype == "image/webp" and bytes(tile.content)[:4] == b"RIFF"
    assert hd.get_entry_by_path("hd/moon/albedo/2/4/0.webp")  # an insert
    # Not at the root, where they would sit among the Almanac's own earth/ maps, and not as articles.
    with pytest.raises(KeyError):
        hd.get_entry_by_path("earth/day/2/7/3.webp")
    assert hd.article_count < 400


def test_the_standard_flavour_has_no_tiles(built):
    std = Archive(built["standard"])
    with pytest.raises(KeyError):
        std.get_entry_by_path("hd/hd.json")


def test_a_source_without_a_layer_list_fails_the_build(tmp_path):
    from PIL import Image

    from zimi import creator

    folder = tmp_path / "f"
    (folder / "earth/day/0/0").mkdir(parents=True)
    Image.new("RGB", (8, 8)).save(folder / "earth/day/0/0/0.webp", "WEBP")
    (folder / "index.html").write_text("<title>x</title>", encoding="utf-8")
    creator.create_folder_zim(
        str(folder), out_path=str(tmp_path / "bad.zim"), register=False
    )
    with pytest.raises(SystemExit):
        maxi.build(str(tmp_path / "bad.zim"), str(tmp_path / "o"))


def test_the_release_step_writes_the_manifest_zimi_reads(built, tmp_path, monkeypatch):
    from zimi import almanachd

    maxi.main(["--tiles", built["tiles"], "--out", str(tmp_path), "--tag", "v1.15.4"])
    path = tmp_path / (maxi.FILE_FMT % datetime.date.today().strftime("%Y-%m"))
    raw = (tmp_path / "zimi_almanac_maxi.json").read_text(encoding="utf-8")
    man = json.loads(raw)
    assert set(man) == {"file", "size", "sha256", "tag"}
    assert (
        man["file"] == path.name
        and man["size"] == path.stat().st_size
        and man["tag"] == "v1.15.4"
    )
    assert man["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    # Zimi on that version accepts it, and offers exactly that file.
    assert almanachd.parse_manifest(raw, version="1.15.4") == man
    assert almanachd.parse_manifest(raw, version="1.15.3") is None


def test_the_tile_source_pin_names_the_immutable_input():
    pin = maxi.read_pin()
    assert set(pin) == {"file", "size", "sha256", "tag"}
    assert (
        re.fullmatch(r"[0-9a-f]{64}", pin["sha256"])
        and pin["file"].endswith(".zim")
        and pin["tag"].startswith("v")
    )


def test_a_cached_tile_source_that_matches_the_pin_is_used_without_the_network(tmp_path):
    f = tmp_path / "tiles.zim"
    f.write_bytes(b"tiles")
    pin = {"file": "tiles.zim", "size": 5, "sha256": hashlib.sha256(b"tiles").hexdigest(), "tag": "v0.0.0"}
    assert maxi.fetch_tiles(str(tmp_path), pin) == str(f)


def _release_workflow():
    with open(
        os.path.join(ROOT, ".github", "workflows", "desktop-release.yml"),
        encoding="utf-8",
    ) as f:
        return f.read()


def test_the_release_builds_and_attaches_the_flavour_and_its_manifest():
    wf = _release_workflow()
    assert "scripts/build_almanac_maxi.py" in wf and "--tag" in wf
    assert "zimi_almanac_maxi" in wf  # copied onto the release with the other files
    assert re.search(
        r"needs:\s*\[[^\]]*almanac-maxi", wf
    ), "the release waits for the flavour"
