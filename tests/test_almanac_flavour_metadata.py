"""The Almanac's flavours share a Title and tell themselves apart by Description, Flavour and LongDescription.

The standard edition has no Flavour (the file name has no suffix); HD is ``maxi`` and Maximum ``ultra``. A reader
listing the files side by side must be able to tell which is the one with the high-resolution maps.

Run: pytest tests/test_almanac_flavour_metadata.py -v
"""

import os
import re
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from zimi import ownzims  # noqa: E402
from zimi.zimwriter import MAX_DESCRIPTION_LENGTH  # noqa: E402


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    pytest.importorskip("libzim")
    from libzim.reader import Archive

    own = next(o for o in ownzims.OWN if o.name == "zimi_almanac")
    out = tmp_path_factory.mktemp("flavours")
    meta = {}
    for flavour in (None, "maxi", "ultra"):
        path = str(out / ("%s.zim" % (flavour or "standard")))
        ownzims.write_zim(own, path, flavour=flavour)
        a = Archive(path)
        meta[flavour] = {k: a.get_metadata(k).decode("utf-8") for k in a.metadata_keys if not k.startswith("Illustration")}
    return meta


def test_title_is_shared_and_name_is_one(built):
    assert {m["Title"] for m in built.values()} == {"Zimi Almanac"}
    assert {m["Name"] for m in built.values()} == {"zimi_eng_zimi_almanac"}


def test_flavour_metadata(built):
    assert "Flavour" not in built[None]
    assert built["maxi"]["Flavour"] == "maxi"
    assert built["ultra"]["Flavour"] == "ultra"


def test_descriptions_tell_the_files_apart_within_the_limit(built):
    descriptions = {f: m["Description"] for f, m in built.items()}
    assert len(set(descriptions.values())) == 3
    assert "high-resolution maps" in descriptions["maxi"]
    assert "high-resolution" not in descriptions[None]
    for d in descriptions.values():
        assert 1 <= len(d) <= MAX_DESCRIPTION_LENGTH and "—" not in d


def test_only_the_standard_edition_says_it_is_standard(built):
    assert ownzims.STANDARD_EDITION in built[None]["LongDescription"]
    for flavour in ("maxi", "ultra"):
        long = built[flavour]["LongDescription"]
        assert "standard edition" not in long and ownzims.FLAVOUR_TEXT[("zimi_almanac", flavour)][1] in long
    # nothing else of the text changed
    rest = built[None]["LongDescription"].replace(ownzims.STANDARD_EDITION, "")
    assert built["maxi"]["LongDescription"].replace(ownzims.FLAVOUR_TEXT[("zimi_almanac", "maxi")][1], "") == rest


def test_maxi_says_plainly_it_has_the_hd_maps_and_how_big_it_is(built):
    long = built["maxi"]["LongDescription"]
    assert "high-resolution maps of the Earth, Moon and planets" in long
    assert re.search(r"about \d+(\.\d)? GB", long) and re.search(r"about \d+(\.\d)? GB", built["maxi"]["Description"])
    assert "maximum-resolution" in built["ultra"]["Description"]
    assert re.search(r"about \d+(\.\d)? GB", built["ultra"]["LongDescription"])


def test_a_pin_without_sizes_leaves_the_size_out(tmp_path, monkeypatch):
    pin = tmp_path / "pin.json"
    pin.write_text('{"file": "x.zim"}')
    monkeypatch.setattr(ownzims, "TILES_PIN", str(pin))
    assert ownzims._flavour_size(", about %s", "hd_size") == ""
    pin.write_text('{"hd_size": 1983068162, "max_size": 4814876312}')
    assert ownzims._flavour_size(", about %s", "hd_size") == ", about 2 GB"
    assert ownzims._flavour_size(", about %s", "max_size") == ", about 4.8 GB"
