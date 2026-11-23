"""Community catalog entries: no source filter, solid mark in the actions row (the subtitle: test_community_copy.py)."""
import pathlib
import re

STATIC = pathlib.Path(__file__).resolve().parent.parent / "zimi" / "static"


def _read(name):
    return (STATIC / name).read_text(encoding="utf-8")


def test_no_catalog_source_filter():
    manage, app = _read("manage.js"), _read("app.js")
    for gone in ("_catalogSourceHtml", "_bySource", "setCatalogSource", "CATALOG_SOURCE"):
        assert gone not in manage and gone not in app, gone
    for f in (STATIC / "i18n").glob("*.json"):
        assert "catalog_source_" not in f.read_text(encoding="utf-8"), f.name


def test_badge_is_solid_and_sits_in_the_actions_row():
    manage = _read("manage.js")
    assert "'<div class=\"ci-icon\">' + iconHtml + '</div>'" in manage
    assert "'<div class=\"ci-actions\">' + communityBadge" in manage
    body = re.search(r"function communityIcon\(size\) \{.*?\n\}", _read("app.js"), re.S).group(0)
    assert 'fill="currentColor"' in body and 'fill="none"' not in body
    css = _read("app.css")
    assert "position: absolute" not in re.search(r"\.community-corner \{[^}]*\}", css).group(0)
