"""ZimiGames follow the person, not the browser (Eric, 2026-11-04: "at least each
person should have their own view, right?"; "Yes to storing per account across
browsers").

  • whose games a request has (users.games_data_owner, /whoami's ``games``): a
    signed-in person's own; nobody's for an anonymous visitor, and nobody's
    where the password is switched off, where every browser is the admin's but
    a household's players are not one person;
  • the account's games (/userdata/games): the settings' shape, the server
    ordering changes, only ZimiGames' own keys, a cap on the whole; and
  • the name a person goes by in games: theirs to set, one per server.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_settings_sync import (
    ADMIN_PW,
    _cookie,
    _Handler,
    _whoami,
    data,
)  # noqa: E402,F401

from zimi import manage, users  # noqa: E402


def _post(handler_kwargs, path, body, method="_handle_games_post"):
    h = _Handler(**handler_kwargs)
    h.path = path
    getattr(h, method)(body)
    return h


def _get(headers):
    h = _Handler(headers, path="/userdata/games")
    h._handle_games_get()
    return h


# ── whose games ──


def test_a_signed_in_person_keeps_their_games_in_their_account(data):
    users.create_user("Kid", "pw123")
    tok = users.create_session("Kid")
    assert _whoami(_cookie(tok))["games"] == "Kid"
    p = _post(
        {"headers": _cookie(tok)},
        "/userdata/games",
        {"changes": {"zimi.games.stats": {"v": '{"v":1}'}}},
    )
    assert p.status == 200
    assert _get(_cookie(tok)).body["settings"]["zimi.games.stats"]["v"] == '{"v":1}'


def test_two_people_each_have_their_own(data):
    users.create_user("Kid", "pw123")
    users.create_user("Mum", "pw123")
    kid, mum = users.create_session("Kid"), users.create_session("Mum")
    _post(
        {"headers": _cookie(kid)},
        "/userdata/games",
        {"changes": {"zimi.games.sudoku.best": {"v": "100"}}},
    )
    assert _get(_cookie(kid)).body["settings"]["zimi.games.sudoku.best"]["v"] == "100"
    assert _get(_cookie(mum)).body["settings"] == {}, "nothing of Kid's in Mum's"


def test_password_off_keeps_each_browsers_games_its_own(data, monkeypatch):
    manage._set_manage_password(ADMIN_PW)
    monkeypatch.setenv("ZIMI_MANAGE_OPEN", "1")
    me = _whoami()
    assert me["account"] == users.PRIMARY_ADMIN_DATA, "settings still sync there"
    assert me["games"] is None, "but games are not every household member's in one"
    assert _get({}).status == 401
    # a person who signs in there has their own
    users.create_user("Kid", "pw123")
    assert _whoami(_cookie(users.create_session("Kid")))["games"] == "Kid"


def test_the_signed_in_primary_admin_keeps_theirs(data):
    manage._set_manage_password(ADMIN_PW)
    tok = users.create_admin_session()
    assert _whoami(_cookie(tok))["games"] == users.PRIMARY_ADMIN_DATA


def test_anonymous_has_none(data):
    manage._set_manage_password(ADMIN_PW)
    assert _whoami()["games"] is None
    assert _get({}).status == 401


def test_a_tab_on_another_account_is_refused_not_written(data):
    users.create_user("Kid", "pw123")
    tok = users.create_session("Kid")
    p = _post(
        {"headers": _cookie(tok)},
        "/userdata/games",
        {"account": "Other", "changes": {"zimi.games.x": {"v": "1"}}},
    )
    assert p.status == 409


# ── the account's games ──


def test_only_zimigames_keys_and_the_same_value_is_no_change(data):
    users.create_user("Kid", "pw123")
    ok, _, doc = users.GAMES.change(
        "Kid",
        {
            "zimi.games.save.sudoku": {"v": "a"},
            "zimi.zimcity.kept": {"v": "[]"},
            "zimi_reader_theme": {"v": "dark"},  # a setting, not a game
            "evil/../../x": {"v": "1"},
        },
    )
    assert ok and set(doc["settings"]) == {
        "zimi.games.save.sudoku",
        "zimi.zimcity.kept",
    }
    rev = doc["rev"]
    ok, _, doc = users.GAMES.change("Kid", {"zimi.games.save.sudoku": {"v": "a"}})
    assert doc["rev"] == rev


def test_six_cities_fit_and_the_account_has_a_ceiling(data):
    users.create_user("Kid", "pw123")
    city = "x" * 400_000  # a big city save, as ZimCity packs one
    kept = "[" + ",".join(['"%s"' % ("y" * 400_000)] * 5) + "]"
    ok, _, doc = users.GAMES.change("Kid", {"zimi.games.save.zimcity": {"v": city}})
    assert ok and "zimi.games.save.zimcity" in doc["settings"]
    ok, _, doc = users.GAMES.change(
        "Kid", {"zimi.zimcity.kept": {"v": kept[:1_000_000]}}
    )
    assert ok and "zimi.zimcity.kept" in doc["settings"]
    # past the account's whole cap a new key is refused, the kept ones stay
    for i in range(6):
        users.GAMES.change("Kid", {"zimi.games.save.big%d" % i: {"v": "z" * 1_000_000}})
    doc = users.GAMES.load("Kid")
    assert (
        sum(len(e["v"] or "") for e in doc["settings"].values())
        <= users.GAMES.total_max
    )
    assert "zimi.games.save.zimcity" in doc["settings"]


def test_a_full_backup_carries_each_persons_games(data):
    users.create_user("Kid", "pw123")
    users.GAMES.change("Kid", {"zimi.games.stats": {"v": "s"}})
    blobs = users.all_user_data()
    assert blobs["kid"]["games"]["settings"]["zimi.games.stats"]["v"] == "s"
    users.GAMES.delete("kid")
    users.restore_user_data(blobs)
    assert users.GAMES.load("Kid")["settings"]["zimi.games.stats"]["v"] == "s"


def test_deleting_a_person_takes_their_games(data):
    users.create_user("Kid", "pw123")
    users.GAMES.change("Kid", {"zimi.games.stats": {"v": "s"}})
    users.delete_user("Kid")
    assert not os.path.exists(users.GAMES.path("Kid"))


# ── the name a person goes by ──


def test_a_person_is_called_their_account_name_until_they_choose(data):
    users.create_user("Kid", "pw123")
    tok = users.create_session("Kid")
    assert _whoami(_cookie(tok))["display"] == "Kid"
    p = _post(
        {"headers": _cookie(tok)},
        "/account/display",
        {"display": "Captain K"},
        "_handle_display_post",
    )
    assert p.status == 200 and p.body["display"] == "Captain K"
    assert _whoami(_cookie(tok))["display"] == "Captain K"
    assert users.get_user("Kid")["name"] == "Kid", "the sign-in name is untouched"
    p = _post(
        {"headers": _cookie(tok)},
        "/account/display",
        {"display": ""},
        "_handle_display_post",
    )
    assert p.body["display"] == "Kid", "empty goes back to the account's name"


def test_one_name_per_server(data):
    users.create_user("Kid", "pw123")
    users.create_user("Mum", "pw123")
    ok, err, _ = users.set_display_name("Kid", "mum")
    assert not ok and err == "name taken"
    assert users.set_display_name("Kid", "Captain")[0]
    ok, err, _ = users.set_display_name("Mum", "CAPTAIN")
    assert not ok and err == "name taken"
    for bad in ("x" * 33, "<b>", "a/b"):
        assert users.set_display_name("Kid", bad)[1] == "invalid name"


def test_the_primary_admin_is_not_called_admin(data):
    manage._set_manage_password(ADMIN_PW)
    assert users.display_name(users.PRIMARY_ADMIN_DATA) is None
    assert users.set_display_name(users.PRIMARY_ADMIN_DATA, "Eric")[0]
    assert users.display_name(users.PRIMARY_ADMIN_DATA) == "Eric"


# ── an admin names someone ──


def test_an_admin_sets_someones_name_by_the_same_rules(data):
    manage._set_manage_password(ADMIN_PW)
    users.create_user("Kid", "pw123")
    users.create_user("Mum", "pw123")
    h = _Handler({"Authorization": "Bearer " + ADMIN_PW}, path="/manage/users")
    manage._handle_users_post(h, {"action": "set-display", "name": "Kid", "display": "Captain K"})
    assert h.status == 200 and next(u for u in h.body["users"] if u["name"] == "Kid")["display"] == "Captain K"
    h = _Handler({"Authorization": "Bearer " + ADMIN_PW}, path="/manage/users")
    manage._handle_users_post(h, {"action": "set-display", "name": "Mum", "display": "captain k"})
    assert h.status == 409, "one name per server, for an admin too"


# ── leaderboards ──

import json  # noqa: E402

DAY = "2026-11-04"


def _play(who, page, run=None, best=None, shown=None, board=None):
    users.create_user(who, "pw123")
    if shown:
        users.set_display_name(who, shown)
    ch = {}
    if run:
        ch["zimi.games.day." + DAY] = {"v": json.dumps({page: run})}
    if best is not None:
        ch["zimi.games.best." + page] = {"v": json.dumps({"score": best, "better": "high", "at": 1})}
    if board:
        ch["zimi.games.board"] = {"v": board}
    users.GAMES.change(who, ch)


def test_a_daily_board_puts_the_fastest_solve_first(data):
    _play("Ann", "sudoku.html", run={"r": "win", "ms": 300000})
    _play("Bo", "sudoku.html", run={"r": "win", "ms": 200000})
    _play("Cy", "sudoku.html", run={"r": "lose", "ms": 50000})
    b = users.leaderboard("sudoku.html", DAY, "Bo")
    assert [(r["name"], r["you"]) for r in b["runs"]] == [("Bo", True), ("Ann", False), ("Cy", False)]


def test_best_scores_highest_first_by_the_name_people_go_by(data):
    _play("Ann", "rocks.html", best=900, shown="Annie")
    _play("Bo", "rocks.html", best=2500)
    b = users.leaderboard("rocks.html", None, "Ann")
    assert [(r["name"], r["score"]) for r in b["best"]] == [("Bo", 2500), ("Annie", 900)]
    assert b["better"] == "high"


def test_off_means_you_see_the_board_but_are_not_on_it(data):
    _play("Ann", "rocks.html", best=900, board="off")
    _play("Bo", "rocks.html", best=2500)
    assert [r["name"] for r in users.leaderboard("rocks.html", None, "Ann")["best"]] == ["Bo"]


def test_the_server_wide_board_names_each_dailys_leader(data):
    _play("Ann", "sudoku.html", run={"r": "win", "ms": 300000})
    _play("Bo", "sudoku.html", run={"r": "win", "ms": 200000})
    t = users.leaderboards_today(DAY, "Ann")
    assert t["games"]["sudoku.html"]["n"] == 2 and t["games"]["sudoku.html"]["lead"]["name"] == "Bo"


def test_the_board_is_for_people_signed_in_only(data):
    manage._set_manage_password(ADMIN_PW)
    h = _Handler(path="/games/board?page=rocks.html")
    h._handle_board_get()
    assert h.status == 401
    users.create_user("Kid", "pw123")
    h = _Handler(_cookie(users.create_session("Kid")), path="/games/board?page=rocks.html")
    h._handle_board_get()
    assert h.status == 200 and h.body["you"] == {"name": "Kid", "on": True}
    h = _Handler(_cookie(users.create_session("Kid")), path="/games/board?page=../etc.html")
    h._handle_board_get()
    assert h.status == 400
