"""The data files under /static carry their content hash into the page (so a file that changed under its old name is fetched afresh).

/static is sent immutable for a year; the page's _almAsset adds ?v=<hash> from __ZIMI_CONFIG.assets. Here: the page carries a hash for
every data file under static/earth (and the other data folders) that matches the file's bytes, every data address the Almanac scripts
name is in it, and the build the service worker keys on changes with the data.
"""

import hashlib
import json
import os
import re

import zimi.http as http

STATIC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "zimi", "static"
)


def _page_assets():
    m = re.search(r"assets:(\{.*?\})\}", http.SEARCH_UI_HTML)
    assert m, "the page carries no assets table"
    return json.loads(m.group(1))


def test_the_page_carries_each_data_files_content_hash():
    assets = _page_assets()
    assert len(assets) >= 40
    for rel in (
        "earth/iss-v1.bin",
        "earth/earth-day-v1.webp",
        "earth/stars-v1.bin",
        "world-map.svg",
    ):
        with open(os.path.join(STATIC, rel), "rb") as fh:
            assert assets[rel] == hashlib.md5(fh.read()).hexdigest()[:8], rel


def test_every_data_file_under_earth_is_listed():
    assets = _page_assets()
    missing = []
    for f in os.listdir(os.path.join(STATIC, "earth")):
        if (
            f.rsplit(".", 1)[-1] in ("bin", "json", "webp", "jpg", "png", "glb")
            and "earth/" + f not in assets
        ):
            missing.append(f)
    assert not missing, missing


def test_the_data_files_the_almanac_names_are_listed():
    assets = _page_assets()
    named = set()
    for f in os.listdir(STATIC):
        if f.startswith("almanac") and f.endswith(".js"):
            with open(os.path.join(STATIC, f), encoding="utf-8") as fh:
                for m in re.finditer(
                    r"_almAsset\('/static/((?:earth|golden-record)/[\w./-]+\.(?:bin|json|webp|jpg))'\)",
                    fh.read(),
                ):
                    named.add(m.group(1))
    assert named, "no addresses found"
    assert [n for n in named if n not in assets] == []


def test_the_page_build_follows_the_data():
    src = open(http.__file__, encoding="utf-8").read()
    assert (
        "json.dumps(STATIC_DATA_HASHES, sort_keys=True)" in src
    ), "the asset bundle hash must include the data hashes"
    assert http._asset_version().startswith("zimi-v")
