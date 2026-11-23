"""Offline Readiness lists what a person needs with no internet first and Create's extras (the add-ons) last."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from zimi import offline  # noqa: E402


def test_the_useful_rows_lead_and_the_create_extras_come_last(monkeypatch):
    def row(rid, group="offline"):
        return {"id": rid, "group": group, "here": True}

    monkeypatch.setattr(
        offline,
        "_addon_rows",
        lambda: [row("addon:browser", "addon"), row("addon:video", "addon")],
    )
    monkeypatch.setattr(offline, "_almanac_hd_row", lambda: row("almanac_hd"))
    monkeypatch.setattr(offline, "_satellites_row", lambda: row("satellites"))
    monkeypatch.setattr(offline, "_voices_row", lambda lang: row("voices"))
    monkeypatch.setattr(offline, "_maps_row", lambda: row("maps"))
    ids = [r["id"] for r in offline.readiness("en")["items"]]
    assert ids == [
        "almanac_hd",
        "maps",
        "voices",
        "satellites",
        "addon:browser",
        "addon:video",
    ]


def test_the_title_is_offline_readiness_in_every_language():
    import glob
    import json

    for f in glob.glob(
        os.path.join(os.path.dirname(offline.__file__), "static", "i18n", "*.json")
    ):
        d = json.load(open(f, encoding="utf-8"))
        assert d["offline_ready_title"] != "Ready for offline"
    en = json.load(
        open(
            os.path.join(
                os.path.dirname(offline.__file__), "static", "i18n", "en.json"
            ),
            encoding="utf-8",
        )
    )
    assert en["offline_ready_title"] == "Offline Readiness"
