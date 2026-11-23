"""Offline Readiness: Zimi's own pieces, in order, read from stubbed pieces (no network, no server)."""

from zimi import offline


def _stub(monkeypatch, **extra):
    monkeypatch.setattr(
        offline, "_satellites_row", lambda: offline._row("satellites", "almanac", True)
    )
    monkeypatch.setattr(
        offline,
        "_almanac_hd_row",
        lambda: offline._row("almanac_hd", "almanac", False, 5),
    )
    monkeypatch.setattr(
        offline,
        "_maps_row",
        lambda: offline._row("maps", "almanac", False, choose=True),
    )
    monkeypatch.setattr(
        offline, "_voices_row", lambda lang: offline._row("voices", "voices", False, 5)
    )
    monkeypatch.setattr(
        offline,
        "_addon_rows",
        lambda: [
            offline._row("addon:browser", "addon", False, 9),
            offline._row("addon:video", "addon", True),
        ],
    )
    for name, fn in extra.items():
        monkeypatch.setattr(offline, name, fn)


def test_zimis_own_pieces_then_the_create_extras(monkeypatch):
    _stub(monkeypatch)
    ids = [r["id"] for r in offline.readiness("en")["items"]]
    assert ids == [
        "almanac_hd",
        "maps",
        "voices",
        "satellites",
        "addon:browser",
        "addon:video",
    ]


def test_the_list_holds_no_library_content(monkeypatch):
    """Wikipedia, the dictionary and the rest are the library's, not Zimi's: the list never said they were
    missing when they were installed, because it no longer asks ("Zim readiness is different from
    Zimi readiness")."""
    assert not hasattr(offline, "_essential_rows")
    assert not hasattr(offline, "ESSENTIALS")
    _stub(monkeypatch)
    assert {r["group"] for r in offline.readiness("en")["items"]} == {
        "almanac",
        "voices",
        "addon",
    }


def test_a_map_under_any_name_counts_as_here(monkeypatch):
    from zimi import server

    monkeypatch.setattr(
        server, "get_zim_files", lambda: {"alps_hiking_tiles": "/z/a.zim", "x": "/z/x"}
    )
    monkeypatch.setattr(
        server, "_zim_kind_of", lambda n: "map" if n == "alps_hiking_tiles" else ""
    )
    row = offline._maps_row()
    assert row["here"] and row["zim"] == "alps_hiking_tiles" and row["choose"]
    monkeypatch.setattr(server, "get_zim_files", lambda: {"x": "/z/x"})
    row = offline._maps_row()
    assert not row["here"] and row["choose"] and row["get"] is None
