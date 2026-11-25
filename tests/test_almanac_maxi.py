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
    assert os.path.basename(built["flavour"]) == "zimi_almanac_hd_2026-11.zim"


def test_same_name_different_flavour(built):
    std, hd = Archive(built["standard"]), Archive(built["flavour"])
    name = std.get_metadata("Name")
    assert name and name == hd.get_metadata("Name")
    assert "Flavour" not in std.metadata_keys
    assert "Flavour" not in hd.metadata_keys   # HD is the catalog's unflavoured edition
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


def test_the_layer_list_says_whether_the_hd_craft_are_inside(built, tmp_path):
    # Without them hd.json says nothing of craft, so the 3D view never asks for craft/index.json (a 404 on every open).
    assert "craft" not in json.loads(_read(Archive(built["flavour"]), "hd/hd.json"))
    craft = tmp_path / "craft"
    craft.mkdir()
    (craft / "index.json").write_text('{"models":{"voyager":{"file":"voyager.zcr2"}}}', encoding="utf-8")
    (craft / "voyager.zcr2").write_bytes(b"ZCR2")
    hd = Archive(
        maxi.build(
            built["tiles"], str(tmp_path / "out"), month="2026-11", craft_dir=str(craft)
        )
    )
    man = json.loads(_read(hd, "hd/hd.json"))
    assert man["craft"] is True and man["layers"]["earth/day"]["max"] == 2
    assert (
        json.loads(_read(hd, "hd/craft/index.json"))["models"]["voyager"]["file"]
        == "voyager.zcr2"
    )


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

    # --month: the name the release job works out from what releases shipped (gh); given here, so no network.
    maxi.main(["--tiles", built["tiles"], "--out", str(tmp_path), "--tag", "v1.15.4", "--month", "2026-11c", "--no-craft"])
    path = tmp_path / (maxi.FILE_FMT % "2026-11c")
    raw = (tmp_path / "zimi_almanac_hd.json").read_text(encoding="utf-8")
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
    assert {"file", "size", "sha256", "tag"} <= set(pin) <= {"file", "size", "sha256", "tag", "chunks", "hd_size", "max_size"}
    assert (
        re.fullmatch(r"[0-9a-f]{64}", pin["sha256"])
        and pin["file"].endswith(".zim")
        and pin["tag"].startswith("v")
    )


def test_a_cached_tile_source_that_matches_the_pin_is_used_without_the_network(
    tmp_path,
):
    f = tmp_path / "tiles.zim"
    f.write_bytes(b"tiles")
    pin = {
        "file": "tiles.zim",
        "size": 5,
        "sha256": hashlib.sha256(b"tiles").hexdigest(),
        "tag": "v0.0.0",
    }
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
    assert "zimi_almanac_hd" in wf  # copied onto the release with the other files
    assert re.search(
        r"needs:\s*\[[^\]]*almanac-maxi", wf
    ), "the release waits for the flavour"


def _craft_asset(tmp_path, members=None):
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
    import pack_almanac_craft as pack

    folder = tmp_path / "folder"
    folder.mkdir(exist_ok=True)
    for name, data in (members or {"index.json": b'{"models": {}}', "psyche.zcr2": b"ZCR2"}).items():
        (folder / name).write_bytes(data)
    archive = tmp_path / "almanac_craft_2026-11.tar.gz"
    return pack.pack(str(folder), str(archive)), archive


def test_the_pinned_craft_asset_is_downloaded_checked_and_unpacked(tmp_path, monkeypatch):
    sha, archive = _craft_asset(tmp_path)
    pin = tmp_path / "almanac-craft.json"
    pin.write_text(json.dumps({"file": archive.name, "size": archive.stat().st_size, "sha256": sha, "tag": "v1.16.0"}), encoding="utf-8")
    seen = []
    monkeypatch.setattr(maxi, "_download", lambda url, path, want: (seen.append((url, want)), str(archive))[1])
    folder = maxi.fetch_craft(str(tmp_path / "cache"), str(pin))
    assert sorted(os.listdir(folder)) == ["index.json", "psyche.zcr2"]
    assert seen == [("https://github.com/epheterson/Zimi/releases/download/v1.16.0/" + archive.name, sha)]


def test_no_craft_pin_means_a_flavour_without_the_hd_craft(tmp_path):
    assert maxi.fetch_craft(str(tmp_path / "cache"), str(tmp_path / "none.json")) is None


def test_a_release_without_a_craft_pin_stops(tmp_path):
    with pytest.raises(SystemExit):
        maxi.fetch_craft(str(tmp_path / "cache"), str(tmp_path / "none.json"), required=True)


def test_the_craft_archive_is_reproducible_and_refuses_paths(tmp_path, monkeypatch):
    sha1, archive = _craft_asset(tmp_path)
    sha2, _ = _craft_asset(tmp_path)
    assert sha1 == sha2
    import io
    import tarfile

    bad = tmp_path / "bad.tar.gz"
    with tarfile.open(bad, "w:gz") as t:
        info = tarfile.TarInfo("../evil.zcr2")
        info.size = 1
        t.addfile(info, io.BytesIO(b"x"))
    pin = tmp_path / "pin.json"
    pin.write_text(json.dumps({"file": "bad.tar.gz", "size": 1, "sha256": "x", "tag": "v1"}), encoding="utf-8")
    monkeypatch.setattr(maxi, "_download", lambda url, path, want: str(bad))
    with pytest.raises(SystemExit):
        maxi.fetch_craft(str(tmp_path / "cache"), str(pin))


def _metadata(path):
    a = Archive(path)
    return a, {k: bytes(a.get_metadata(k)).decode("utf-8") for k in a.metadata_keys if not k.startswith("Illustration")}


def test_the_catalog_hd_is_the_base_title_in_ten_languages_with_no_flavour(built, tmp_path):
    import build_almanac_kiwix as kiwix

    assert maxi.main(["--tiles", built["tiles"], "--out", str(tmp_path), "--month", "2026-11", "--no-craft", "--catalog"]) == 0
    (made,) = os.listdir(tmp_path)
    assert made == "%s_2026-11.zim" % kiwix.DEFAULT_NAME
    a, meta = _metadata(str(tmp_path / made))
    assert meta["Name"] == kiwix.DEFAULT_NAME == "zimi_mul_almanac"
    assert meta["Title"] == kiwix.DEFAULT_TITLE
    assert meta["Language"] == kiwix.LANGUAGES
    assert "Flavour" not in meta
    assert "high-resolution maps" in meta["Description"] and len(meta["Description"]) <= 80
    assert "high-resolution maps of the Earth, Moon and planets" in meta["LongDescription"]
    assert "standard edition" not in meta["LongDescription"] and "mini edition" in meta["LongDescription"]
    # the community edition (the Almanac for openZIM) with the tiles inside
    assert json.loads(_read(a, "hd/hd.json"))["layers"]
    assert b"_almPickLang" in _read(a, "index.html")


def test_the_catalog_small_maps_are_the_mini_flavour(tmp_path):
    import build_almanac_kiwix as kiwix

    path = kiwix.build(str(tmp_path), month="2026-11")
    assert os.path.basename(path) == "zimi_mul_almanac_mini_2026-11.zim"
    _, meta = _metadata(path)
    assert meta["Flavour"] == "mini" and meta["Name"] == "zimi_mul_almanac" and meta["Language"] == kiwix.LANGUAGES
    assert "high-resolution" not in meta["Description"] and len(meta["Description"]) <= 80
    assert "mini edition" in meta["LongDescription"] and ownzims.STANDARD_EDITION not in meta["LongDescription"]


def test_the_catalog_maximum_is_one_file_with_the_maxi_flavour_and_every_level(built, tmp_path):
    import build_almanac_kiwix as kiwix

    assert maxi.main(["--tiles", built["tiles"], "--out", str(tmp_path), "--month", "2026-11", "--no-craft", "--catalog", "maximum"]) == 0
    (made,) = os.listdir(tmp_path)
    assert made == "zimi_mul_almanac_maxi_2026-11.zim"
    a, meta = _metadata(str(tmp_path / made))
    assert meta["Flavour"] == "maxi" and meta["Name"] == "zimi_mul_almanac" and meta["Language"] == kiwix.LANGUAGES
    assert "full resolution" in meta["Description"] and len(meta["Description"]) <= 80
    assert "every tile at its source's full resolution" in meta["LongDescription"]
    assert json.loads(_read(a, "hd/hd.json"))["layers"]
