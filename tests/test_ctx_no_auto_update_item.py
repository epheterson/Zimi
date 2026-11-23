"""The card right-click menu carries no per-ZIM auto-update opt-out."""
import pathlib

STATIC = pathlib.Path(__file__).resolve().parent.parent / "zimi" / "static"


def test_card_menu_has_no_auto_update_item():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "au-skip" not in js
    assert "au_skip_on" not in js
    for f in (STATIC / "i18n").glob("*.json"):
        assert "au_skip_on" not in f.read_text(encoding="utf-8"), f.name
