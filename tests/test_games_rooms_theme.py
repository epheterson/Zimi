"""Every room's light, held to WCAG AA from the token values themselves.

A room is one definition in zimi/builtin/games/shell.js (id, name, filter, favourites, and a light and a dark token set). The tokens that
carry text or a control are measured here, so a palette cannot ship that fails: text on the ground and both surfaces (4.5:1), the accent as
text and as a fill under its ink (4.5:1), the white text of a card table on its cloth (4.5:1, both ends of its gradient), and the strong line
that outlines a control (3:1). Run with -s to see the table.

Run: pytest tests/test_games_rooms_theme.py -v -s
"""

import json
import os
import subprocess

import pytest

GAMES = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "zimi",
    "builtin",
    "games",
)


def _rooms():
    out = subprocess.run(
        [
            "node",
            "-e",
            "console.log(JSON.stringify(require(%r).rooms))"
            % os.path.join(GAMES, "shell.js"),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return json.loads(out)


def _lum(hex_):
    def lin(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4

    r, g, b = (int(hex_[i : i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def contrast(a, b):
    la, lb = sorted((_lum(a), _lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


TEXT, UI = 4.5, 3.0
PAIRS = [
    (fg, bg, TEXT)
    for fg in ("ink", "ink2", "ink3", "accent")
    for bg in ("ground", "surface", "surface2")
] + [
    ("accentInk", "accent", TEXT),
    ("#ffffff", "table", TEXT),
    ("#ffffff", "tableDeep", TEXT),
    ("strong", "ground", UI),
]
ROOMS = [r for r in _rooms() if r["tokens"]]


def test_the_rooms_are_the_ones_the_shelf_lists():
    assert [r["id"] for r in _rooms()] == ["all", "kids", "arcade", "night", "solo"]
    assert (
        _rooms()[0]["tokens"] is None and _rooms()[0]["filter"] is None
    ), "All is the neutral lobby: no tokens of its own"


@pytest.mark.parametrize("room", ROOMS, ids=lambda r: r["id"])
@pytest.mark.parametrize("scheme", ["light", "dark"])
def test_every_pair_of_a_room_is_aa(room, scheme):
    t = room["tokens"][scheme]
    worst = None
    for fg, bg, need in PAIRS:
        a, b = (t.get(fg, fg), t.get(bg, bg))
        ratio = contrast(a, b)
        if need == TEXT:
            worst = min(worst, ratio) if worst else ratio
        assert ratio >= need, "%s %s: %s %s on %s %s is %.2f, needs %.1f" % (
            room["id"],
            scheme,
            fg,
            a,
            bg,
            b,
            ratio,
            need,
        )
    print("%-7s %-5s lowest text pair %.2f, outline %.2f" % (room["id"], scheme, worst, contrast(t["strong"], t["ground"])))


@pytest.mark.parametrize("room", ROOMS, ids=lambda r: r["id"])
def test_a_room_keeps_its_light_and_dark_apart(room):
    light, dark = room["tokens"]["light"], room["tokens"]["dark"]
    assert (
        _lum(light["ground"]) > 0.5 > 0.15 > _lum(dark["ground"])
    ), "light is light and dark is dark"
    assert set(light) == set(dark), "both schemes define the same tokens"


@pytest.mark.parametrize("room", ROOMS, ids=lambda r: r["id"])
def test_a_room_lists_its_best_known_games_and_they_belong_to_it(room):
    rows = {}
    with open(os.path.join(GAMES, "games.json"), encoding="utf-8") as f:
        for r in json.load(f):
            if r["path"] not in rows or r.get("players"):
                rows[r["path"]] = r
    out = subprocess.run(
        [
            "node",
            "-e",
            "const S=require(%r);const rows=%s;console.log(JSON.stringify(%s.map(p=>S.inRoom(%r,rows[p],p))))"
            % (
                os.path.join(GAMES, "shelf.js"),
                json.dumps(rows),
                json.dumps(room["favorites"]),
                room["id"],
            ),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert len(room["favorites"]) >= 6
    assert all(json.loads(out)), "a favourite of %s is not in the room: %s" % (
        room["id"],
        [p for p, ok in zip(room["favorites"], json.loads(out)) if not ok],
    )
