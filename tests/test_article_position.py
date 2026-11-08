"""Where an article says it stands (zimi.previews.article_position), which /snippet gives as ``position``.

Go to by name in the Almanac's 3D view picks, among the pages of a place's name, the one that stands near it (Paris,
France's, not Paris, Texas's): so a page's lead has to give its coordinates in each way a Wikipedia ZIM writes them.

Run: pytest tests/test_article_position.py -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi.previews import article_position  # noqa: E402


def test_the_map_link_a_page_carries():
    html = '<a class="mw-kartographer-maplink" data-mw="interface" data-lat="48.8566" data-lon="2.3522" href="#">48°51′N</a>'
    assert article_position(html) == (48.8566, 2.3522)


def test_the_map_link_with_its_attributes_the_other_way_round():
    html = '<a data-lon="-95.5555" class="maplink" data-lat="33.6609">map</a>'
    assert article_position(html) == (33.6609, -95.5555)


def test_the_coordinates_as_written_in_the_infobox():
    html = '<span class="geo-inline"><span class="geo-dec">48.8567°N 2.3508°E</span><span class="geo">48.8567; 2.3508</span></span>'
    assert article_position(html) == (48.8567, 2.3508)
    assert article_position('<span class="geo">-33.87; 151.21</span>') == (
        -33.87,
        151.21,
    )


def test_south_and_west_are_negative():
    assert article_position('<span class="geo-dec">33.87°S 70.67°W</span>') == (
        -33.87,
        -70.67,
    )


def test_a_page_about_no_place_or_one_out_of_range_has_none():
    assert article_position("<p>Energy is the ability to do work.</p>") is None
    assert article_position('<span class="geo">95; 10</span>') is None
    assert article_position("") is None
