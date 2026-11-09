"""Which map a place opens or is offered: the smallest region that holds it, the newest, the planet last.

Run: pytest tests/test_mapchoice.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import mapchoice  # noqa: E402

HONOLULU = (21.3, -157.8)
PARIS = (48.857, 2.352)
SUVA_ACROSS_180 = (-17.7, 179.9)
WORLD = [-180, -90, 180, 90]


def _zim(name, box, size=1, file="x_2026-06.zim", kind="map"):
    return {
        "name": name,
        "title": name,
        "kind": kind,
        "main_path": "index.html",
        "map_bounds": box,
        "size_bytes": size,
        "file": file,
    }


def _offer(name, box, size, date="2026-06-01"):
    return {
        "name": name,
        "title": name,
        "bounds": box,
        "size_bytes": size,
        "date": date,
        "download_url": "https://x/" + name,
    }


def test_the_smallest_installed_region_that_holds_the_place_comes_first():
    zims = [
        _zim("north-america", [-170, 5, -50, 83]),
        _zim("hawaii", [-161, 18, -154, 23]),
        _zim("europe", [-25, 34, 45, 72]),
        _zim("unknown-ground", None),
        _zim("not-a-map", [-161, 18, -154, 23], kind="wikipedia"),
    ]
    assert [m["name"] for m in mapchoice.installed_maps(zims, *HONOLULU)] == [
        "hawaii",
        "north-america",
    ]
    assert [m["name"] for m in mapchoice.installed_maps(zims, *PARIS)] == ["europe"]


def test_of_regions_about_the_same_size_the_newest_wins():
    zims = [
        _zim("texas-old", [-106.7, 25.8, -93.5, 36.5], file="texas_2025-01.zim"),
        _zim("texas-new", [-106.6, 25.9, -93.6, 36.4], file="texas_2026-09.zim"),
    ]
    assert [m["name"] for m in mapchoice.installed_maps(zims, 31.0, -100.0)][
        0
    ] == "texas-new"


def test_a_box_across_the_antimeridian_holds_both_sides():
    fiji = _zim("fiji", [176.8, -20.7, -178.2, -12.4])
    assert mapchoice.installed_maps([fiji], *SUVA_ACROSS_180)
    assert mapchoice.installed_maps([fiji], -17.7, -179.9)
    assert not mapchoice.installed_maps([fiji], -17.7, 0.0)


def test_offers_are_the_regions_that_hold_the_place_smallest_first_with_the_planet_apart():
    catalog = [
        _offer("maps_en_all", WORLD, 90),
        _offer("maps_en_europe", [-25, 34, 45, 72], 26),
        _offer("maps_en_france", [-5.2, 41.3, 9.6, 51.1], 4),
        _offer("osm-france", [-5.2, 41.3, 9.6, 51.1], 8),
        _offer("maps_en_asia", [60, -10, 150, 55], 20),
        {"name": "no-link", "bounds": [-5.2, 41.3, 9.6, 51.1], "size_bytes": 1},
    ]
    here, world = mapchoice.offered_maps(catalog, set(), *PARIS)
    assert [o["name"] for o in here] == [
        "maps_en_france",
        "osm-france",
        "maps_en_europe",
    ]
    assert [o["name"] for o in world] == ["maps_en_all"]
    assert [o["source"] for o in here] == ["kiwix", "streetzim", "kiwix"]


def test_an_installed_map_is_not_offered_again():
    catalog = [_offer("maps_en_france", [-5.2, 41.3, 9.6, 51.1], 4)]
    assert mapchoice.offered_maps(catalog, {"maps_en_france"}, *PARIS) == ([], [])


def test_nothing_is_offered_where_a_regional_map_is_installed_and_the_planet_alone_does_not_count():
    catalog = [
        _offer("maps_en_france", [-5.2, 41.3, 9.6, 51.1], 4),
        _offer("maps_en_all", WORLD, 90),
    ]
    regional = [_zim("europe", [-25, 34, 45, 72])]
    assert mapchoice.answer(regional, *PARIS, catalog=catalog)["offers"] == []
    planet = [_zim("world", WORLD)]
    got = mapchoice.answer(planet, *PARIS, catalog=catalog)
    assert [m["name"] for m in got["installed"]] == ["world"]
    assert [o["name"] for o in got["offers"]] == ["maps_en_france"]
    assert got["world"] == []


def test_the_shipped_catalogs_place_a_known_spot():
    here, world = mapchoice.offered_maps(mapchoice.catalog_maps(), set(), *HONOLULU)
    assert here and here[0]["name"] == "osm-hawaii"
    assert all(mapchoice.covers(o["bounds"], *HONOLULU) for o in here)
    assert world


def test_countries_across_the_antimeridian_hold_their_own_ground_and_not_the_far_side_of_the_planet():
    catalog = mapchoice.catalog_maps()
    tokyo = {
        o["name"] for o in mapchoice.offered_maps(catalog, set(), 35.68, 139.69)[0]
    }
    assert not tokyo & {
        "maps_en_united-states-of-america",
        "maps_en_russia",
        "maps_en_fiji",
    }
    usa = "maps_en_united-states-of-america"
    assert usa in {
        o["name"]
        for o in mapchoice.offered_maps(catalog, set(), *HONOLULU, limit=20)[0]
    }
    assert usa in {
        o["name"]
        for o in mapchoice.offered_maps(catalog, set(), 61.2, -149.9, limit=20)[0]
    }


def _names(lat, lng):
    return [
        o["name"]
        for o in mapchoice.offered_maps(mapchoice.catalog_maps(), set(), lat, lng)[0]
    ]


def test_no_wrong_country_is_offered_near_a_border_or_across_the_sea():
    # Rectangles take in sea and neighbours: Japan's holds Vladivostok and Seoul, New Zealand's holds Fiji, China's Primorye.
    vladivostok = _names(43.12, 131.89)
    assert not {"osm-japan", "maps_en_china", "osm-china"} & set(vladivostok)
    assert {"osm-russia", "maps_en_russia"} & set(vladivostok)
    assert "osm-japan" not in _names(37.57, 126.98)  # Seoul
    suva = _names(-18.14, 178.44)
    assert suva[0] == "maps_en_fiji"
    assert not {"maps_en_new-zealand", "osm-australia-nz"} & set(suva)
    assert _names(35.68, 139.69)[0] == "osm-japan"  # Tokyo keeps its own
    assert _names(-36.85, 174.76)[0] == "maps_en_new-zealand"  # Auckland
    assert _names(61.22, -149.9)[0] == "osm-alaska"  # Anchorage


def test_an_offer_says_which_installed_maps_it_overlaps():
    belgium = _zim("belgium", [2.5, 49.5, 6.4, 51.5])
    belgium["title"] = "Belgium"
    catalog = [
        _offer("maps_en_europe", [-25, 34, 45, 72], 5),
        _offer("maps_en_netherlands", [3.3, 50.7, 7.3, 53.6], 1),
        _offer("maps_en_japan", [122, 24, 146, 45.8], 1),
    ]
    got = mapchoice.answer([belgium], 52.37, 4.9, catalog=catalog)  # Amsterdam
    rows = {o["name"]: o["overlaps"] for o in got["offers"]}
    assert rows["maps_en_europe"] == ["Belgium"]  # holds the whole installed map
    assert rows["maps_en_netherlands"] == []  # beside it, not over it
    assert "maps_en_japan" not in rows
    assert (
        mapchoice.overlap_fraction([170, -20, -170, -10], [175, -18, 180, -12]) == 1.0
    )
